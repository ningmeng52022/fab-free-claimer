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
  flattenTree,
  walkPartition,
} from "./enum.js";
import { clear, deleteMany, getAll, getAllKeys, getMeta, putMany, reset, setMeta, stats } from "./db.js";

const TICK_BUDGET_MS = 25000; // stay well inside the worker lifetime
const HEARTBEAT_MS = 15000;
const CLAIM_WORKERS = 8; // a single relay tab is the bottleneck; 8 keeps it responsive
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
  const [control, checkpoint, counts, account, run, failed] = await Promise.all([
    getControl(),
    getMeta(CHECKPOINT_KEY, {}),
    stats(),
    getMeta("account", null),
    getMeta(SUMMARY_KEY, { ok: 0, fail: 0 }),
    getAll("failed"),
  ]);

  const breakdown = {};
  for (const row of failed) {
    const status = row.status || "unknown";
    breakdown[status] = (breakdown[status] || 0) + 1;
  }
  const sample = failed.find((row) => row.detail) || null;

  return {
    control,
    checkpoint: {
      phase: checkpoint.phase,
      partitions: (checkpoint.partitions || []).length,
      enumDone: checkpoint.enumDone || [],
      resumeCursors: Object.keys(checkpoint.enumState || {}).length,
    },
    counts,
    account,
    run,
    failures: Object.entries(breakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => ({ status, count })),
    sampleError: sample ? { uid: sample.uid, status: sample.status, detail: sample.detail } : null,
  };
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
  await setMeta(CHECKPOINT_KEY, { phase: "enumerate", enumDone: [], enumState: {} });
  await setMeta(SUMMARY_KEY, { ok: 0, fail: 0, skipped: 0 });
  // Failures from earlier runs get one more chance; without this a listing that
  // keeps failing would be skipped forever.
  await clear("failed");
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
    if (checkpoint.probeError) {
      await setControl({
        ...control,
        state: "error",
        error: `first claim failed: ${checkpoint.probeError}`,
      });
      return { state: "error", remaining: false };
    }
    if (!done) {
      await setMeta(CHECKPOINT_KEY, checkpoint);
      await setMeta(SUMMARY_KEY, summary);
      return { state: "running", remaining: true };
    }

    if (control.reconcile) await reconcile(summary);
    checkpoint.phase = "done";
    await setMeta(CHECKPOINT_KEY, checkpoint);
    await setMeta(SUMMARY_KEY, summary);
    await setControl({ ...control, state: "idle", error: null, errorCount: 0 });
    return { state: "idle", remaining: false };
  } catch (error) {
    if (error instanceof AuthError) {
      await setControl({ ...control, state: "error", error: String(error.message || error) });
      return { state: "error", remaining: false };
    }
    // Surface repeated generic failures (relay down, network gone...) instead of
    // looping forever with a "running" badge and no explanation.
    const errorCount = (control.errorCount || 0) + 1;
    await setControl({
      ...control,
      error: String((error && error.message) || error),
      errorCount,
      ...(errorCount >= 3 ? { state: "error" } : {}),
    });
    await setMeta(CHECKPOINT_KEY, checkpoint);
    await setMeta(SUMMARY_KEY, summary);
    return { state: errorCount >= 3 ? "error" : "running", remaining: errorCount < 3 };
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

    if (!partitions.length) {
      throw new Error(
        "no partitions found - the free catalogue looks empty for this session, are you signed in?"
      );
    }
    checkpoint.partitions = partitions;
    checkpoint.enumState = {};
    await setMeta(CHECKPOINT_KEY, checkpoint);
  }

  const partitions = checkpoint.partitions;
  const done = new Set(checkpoint.enumDone || []);
  const state = checkpoint.enumState || (checkpoint.enumState = {});
  const pending = partitions.filter((part) => !done.has(part.params));
  if (!pending.length) return true;

  const known = new Set(await getAllKeys("listings"));
  let index = 0;

  await withPool(new Array(ENUM_WORKERS).fill(0), ENUM_WORKERS, async () => {
    while (index < pending.length && Date.now() < deadline) {
      const part = pending[index];
      index += 1;
      const resumeFrom = state[part.params] || null;

      const result = await walkPartition({
        params: part.params,
        known,
        knownPages: control.knownPages,
        startUrl: resumeFrom,
        deadline,
        onPage: async ({ found, nextUrl }) => {
          if (found.length) await putMany("listings", found);
          state[part.params] = nextUrl;
          await setMeta(CHECKPOINT_KEY, checkpoint);
        },
      });

      if (result.done) {
        done.add(part.params);
        delete state[part.params];
        checkpoint.enumDone = [...done];
        await setMeta(CHECKPOINT_KEY, checkpoint);
      }
    }
  });

  return partitions.every((part) => done.has(part.params));
}

async function claimSlice(control, checkpoint, summary, deadline) {
  const [claimedKeys, failedKeys, listings] = await Promise.all([
    getAllKeys("claimed"),
    getAllKeys("failed"),
    getAll("listings"),
  ]);
  const claimed = new Set(claimedKeys);
  // Skipping known failures is what lets a run actually finish: persistent
  // failures (paid listings, server-side 500s) would otherwise be retried forever.
  const skip = new Set([...claimed, ...failedKeys]);
  const pending = listings.filter((listing) => !skip.has(listing.uid));
  if (!pending.length) return true;

  // One probe before the batch: if a single claim cannot succeed there is no
  // point hammering thousands of them, and the popup gets the real reason.
  if (!checkpoint.probed) {
    const first = pending[0];
    const result = first.offer
      ? await claim(first.uid, first.offer)
      : { status: "missing_offer", detail: "listing has no offer id" };
    checkpoint.probed = true;
    if (result.status === "ok") {
      summary.ok += 1;
      await putMany("claimed", [{ uid: first.uid }]);
      pending.shift();
    } else if (result.status.startsWith("fatal")) {
      throw new AuthError(`${result.status} ${result.detail || ""}`.trim());
    } else {
      checkpoint.probeError = `${result.status} ${result.detail || ""}`.trim();
      await setMeta(CHECKPOINT_KEY, checkpoint);
      await setMeta(SUMMARY_KEY, summary);
      return false;
    }
    await setMeta(CHECKPOINT_KEY, checkpoint);
    await setMeta(SUMMARY_KEY, summary);
  }

  let index = 0;
  await withPool(new Array(CLAIM_WORKERS).fill(0), CLAIM_WORKERS, async () => {
    while (index < pending.length && Date.now() < deadline) {
      const listing = pending[index];
      index += 1;

      if (!listing.offer) {
        summary.fail += 1;
        await putMany("failed", [
          { uid: listing.uid, status: "missing_offer", detail: "listing has no offer id" },
        ]);
        continue;
      }

      const { status, detail } = await claim(listing.uid, listing.offer);
      if (status === "ok") {
        summary.ok += 1;
        await putMany("claimed", [{ uid: listing.uid }]);
      } else if (status.startsWith("fatal")) {
        throw new AuthError(`${status} ${detail || ""}`.trim());
      } else {
        summary.fail += 1;
        await putMany("failed", [{ uid: listing.uid, status, detail }]);
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
    await deleteMany(
      "failed",
      recovered.map((row) => row.uid)
    );
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
