/**
 * Claim engine.
 *
 * MV3 service workers are killed after ~30s idle, so the engine never assumes it
 * can run to completion. Instead every tick does a bounded slice of work, writes
 * its checkpoint, and schedules the next tick. Killing the worker at any point
 * loses at most one slice.
 */

import { AuthError, categoriesTree, claim, get, me, owned } from "./api.js";
import {
  QUIXEL_SELLERS,
  buildFreePartitions,
  buildQuixelPartitions,
  collectPartition,
  flattenTree,
} from "./enum.js";
import { getAll, getAllKeys, getMeta, putMany, reset, setMeta, stats } from "./db.js";

const TICK_BUDGET_MS = 25000; // stay well inside the worker lifetime
const HEARTBEAT_MS = 15000;
const CLAIM_WORKERS = 16;
const ENUM_WORKERS = 8;

const CONTROL_KEY = "control";
const CHECKPOINT_KEY = "checkpoint";
const SUMMARY_KEY = "summary";

/* ------------------------------------------------------------------ control */

export async function getControl() {
  return getMeta(CONTROL_KEY, { state: "idle" });
}

export async function setControl(value) {
  return setMeta(CONTROL_KEY, value);
}

export async function getSummary() {
  const [control, checkpoint, counts, account, run] = await Promise.all([
    getControl(),
    getMeta(CHECKPOINT_KEY, {}),
    stats(),
    getMeta("account", null),
    getMeta(SUMMARY_KEY, { ok: 0, fail: 0 }),
  ]);
  return { control, checkpoint, counts, account, run };
}

export async function stop() {
  await setControl({ state: "idle" });
}

export async function pause() {
  const control = await getControl();
  if (control.state === "running") await setControl({ ...control, state: "paused" });
}

export async function start(options) {
  await setControl({
    state: "running",
    mode: options.mode || "all",
    knownPages: options.knownPages || 0,
    reconcile: Boolean(options.reconcile),
    startedAt: Date.now(),
  });
  await setMeta(CHECKPOINT_KEY, { phase: "enumerate", enumDone: [], pages: {} });
  await setMeta(SUMMARY_KEY, { ok: 0, fail: 0, skipped: 0 });
}

export async function resume() {
  const control = await getControl();
  if (control.state === "paused") await setControl({ ...control, state: "running" });
}

export async function hardReset() {
  await reset();
}

/* ---------------------------------------------------------------- utilities */

async function withPool(items, limit, worker) {
  const queue = items.slice();
  const runners = new Array(Math.min(limit, queue.length)).fill(null).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (error) {
        if (error instanceof AuthError) throw error;
        console.warn("worker failed", error);
      }
    }
  });
  await Promise.all(runners);
}

function keepAlive() {
  const timer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/* -------------------------------------------------------------------- ticks */

/**
 * Do one bounded slice of work.
 * Returns { state, remaining } where remaining tells the caller whether to
 * schedule another tick.
 */
export async function tick() {
  const control = await getControl();
  if (control.state !== "running") return { state: control.state, remaining: false };

  const release = keepAlive();
  const deadline = Date.now() + TICK_BUDGET_MS;
  const checkpoint = await getMeta(CHECKPOINT_KEY, { phase: "enumerate", enumDone: [] });
  const summary = await getMeta(SUMMARY_KEY, { ok: 0, fail: 0, skipped: 0 });

  try {
    if (!(await getMeta("account", null))) {
      const profile = await me();
      await setMeta("account", {
        name: profile.displayName,
        epicId: profile.epicId,
      });
    }

    if (checkpoint.phase === "enumerate") {
      const done = await enumerateSlice(control, checkpoint, deadline);
      if (!done) {
        await setMeta(CHECKPOINT_KEY, checkpoint);
        return { state: "running", remaining: true };
      }
      checkpoint.phase = "claim";
      checkpoint.claimCursor = 0;
      await setMeta(CHECKPOINT_KEY, checkpoint);
      return { state: "running", remaining: true };
    }

    const done = await claimSlice(control, checkpoint, summary, deadline);
    if (!done) {
      await setMeta(CHECKPOINT_KEY, checkpoint);
      await setMeta(SUMMARY_KEY, summary);
      return { state: "running", remaining: true };
    }

    if (control.reconcile) await reconcile(summary);
    checkpoint.phase = "done";
    await setMeta(CHECKPOINT_KEY, checkpoint);
    await setMeta(SUMMARY_KEY, summary);
    await setControl({ ...control, state: "idle" });
    return { state: "idle", remaining: false };
  } catch (error) {
    if (error instanceof AuthError) {
      await setControl({ ...control, state: "error", error: String(error.message || error) });
      return { state: "error", remaining: false };
    }
    await setMeta(CHECKPOINT_KEY, checkpoint);
    await setMeta(SUMMARY_KEY, summary);
    throw error;
  } finally {
    release();
  }
}

async function enumerateSlice(control, checkpoint, deadline) {
  if (!checkpoint.partitions) {
    const tree = flattenTree(await categoriesTree());
    const sellers = QUIXEL_SELLERS.map((seller) => `sellers=${seller}`).join("&");
    const quixel = buildQuixelPartitions(
      (await get(`/listings/search?aggregate_on=category&count=0&${sellers}`)).aggregations
        .category.buckets,
      tree
    );

    let partitions = [];
    if (control.mode !== "quixel") {
      const free = await get(
        "/listings/search?aggregate_on=category_per_listing_type&count=0&is_free=1"
      );
      partitions = partitions.concat(
        buildFreePartitions(free.aggregations.categoryPerListingType.buckets, tree)
      );
    }
    if (control.mode !== "free") partitions = partitions.concat(quixel);

    checkpoint.partitions = partitions;
    await setMeta(CHECKPOINT_KEY, checkpoint);
  }

  const partitions = checkpoint.partitions;
  const done = new Set(checkpoint.enumDone || []);
  const pending = partitions.filter((part) => !done.has(part.params));
  if (!pending.length) return true;

  const known = new Set(await getAllKeys("listings"));
  let index = 0;

  await withPool(new Array(ENUM_WORKERS).fill(0), ENUM_WORKERS, async () => {
    while (index < pending.length && Date.now() < deadline) {
      const part = pending[index];
      index += 1;
      const { found } = await collectPartition(part.params, known, control.knownPages);
      if (found.length) await putMany("listings", found);
      done.add(part.params);
      checkpoint.enumDone = [...done];
      await setMeta(CHECKPOINT_KEY, checkpoint);
    }
  });

  return index >= pending.length;
}

async function claimSlice(control, checkpoint, summary, deadline) {
  const claimed = new Set(await getAllKeys("claimed"));
  const listings = await getAll("listings");
  const pending = listings.filter((listing) => !claimed.has(listing.uid));
  if (!pending.length) return true;

  let index = 0;
  await withPool(new Array(CLAIM_WORKERS).fill(0), CLAIM_WORKERS, async () => {
    while (index < pending.length && Date.now() < deadline) {
      const listing = pending[index];
      index += 1;
      const status = await claim(listing.uid, listing.offer);
      if (status === "ok") {
        summary.ok += 1;
        await putMany("claimed", [{ uid: listing.uid }]);
      } else if (status.startsWith("fatal")) {
        throw new AuthError(status);
      } else {
        summary.fail += 1;
        await putMany("failed", [{ uid: listing.uid, status }]);
      }
    }
  });

  checkpoint.claimCursor = index;
  await setMeta(CHECKPOINT_KEY, checkpoint);
  await setMeta(SUMMARY_KEY, summary);
  return index >= pending.length;
}

async function reconcile(summary) {
  const failed = await getAll("failed");
  if (!failed.length) return;
  const recovered = [];
  await withPool(failed, 8, async (row) => {
    if (await owned(row.uid)) recovered.push({ uid: row.uid });
  });
  if (recovered.length) {
    await putMany("claimed", recovered);
    summary.recovered = (summary.recovered || 0) + recovered.length;
  }
  await setMeta(SUMMARY_KEY, summary);
}

/** Spot-check N claimed listings really are owned. */
export async function verifySample(sample = 30) {
  const keys = await getAllKeys("claimed");
  if (!keys.length || !sample) return { checked: 0, owned: 0 };
  const picks = [];
  const pool = keys.slice();
  while (picks.length < Math.min(sample, keys.length)) {
    picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  let good = 0;
  await withPool(picks, 8, async (uid) => {
    if (await owned(uid)) good += 1;
  });
  return { checked: picks.length, owned: good };
}

/** Walk the whole library and compare against the claimed set. */
export async function verifyFull() {
  const keys = new Set(await getAllKeys("claimed"));
  const library = new Set();
  let url = "/library/search?sort_by=-createdAt&count=24";
  let pages = 0;
  while (url && pages < 2000) {
    const page = await get(url);
    pages += 1;
    for (const row of page.results || []) {
      const uid = (row.listing || {}).uid;
      if (uid) library.add(uid);
    }
    url = page.next;
  }
  let missing = 0;
  for (const uid of keys) if (!library.has(uid)) missing += 1;
  return { library: library.size, claimed: keys.size, missing };
}
