/**
 * Logic tests for the extension. Run with: node --test extension/tests/enum.test.mjs
 *
 * No network: chrome.tabs is stubbed, which is exactly how the extension talks to
 * fab.com (the service worker relays every request through a fab.com tab).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PAGE_SIZE,
  buildFreePartitions,
  buildQuixelPartitions,
  collectPartition,
  flattenTree,
  toListing,
} from "../lib/enum.js";

/** Install a fake chrome.tabs that answers with the given routes. */
function stubTabs(routes) {
  const requested = [];
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 1 }],
      create: async () => ({ id: 1 }),
      sendMessage: async (_tabId, message) => {
        if (message.type === "ping") return { ok: true };
        requested.push(message.url);
        const key = Object.keys(routes).find(
          (candidate) => message.url.endsWith(candidate) || message.url.includes(candidate)
        );
        const payload = key ? routes[key] : { results: [], next: null };
        return { status: 200, text: JSON.stringify(payload) };
      },
    },
  };
  return requested;
}

function freeItem(uid, title = "asset") {
  return { uid, title, startingPrice: { offerId: `offer-${uid}`, price: 0 } };
}

function paidItem(uid) {
  return { uid, title: "paid", startingPrice: { offerId: `offer-${uid}`, price: 12 } };
}

test("flattenTree walks nested children", () => {
  const tree = [{ uid: "a", slug: "a", children: [{ uid: "b", slug: "b", children: [] }] }];
  assert.deepEqual(Object.keys(flattenTree(tree)).sort(), ["a", "b"]);
});

test("buildFreePartitions skips bundle and uses category slugs", () => {
  const buckets = {
    "3d-model": { docCount: 2, category: { buckets: { "cat-1": { docCount: 2 } } } },
    bundle: { docCount: 9, category: { buckets: {} } },
  };
  const parts = buildFreePartitions(buckets, { "cat-1": { slug: "nature--forest" } });
  assert.equal(parts.length, 1);
  assert.match(parts[0].params, /categories=nature--forest/);
  assert.match(parts[0].params, /is_free=1/);
});

test("buildFreePartitions falls back when a category has no slug", () => {
  const buckets = { material: { docCount: 1, category: { buckets: { "cat-x": { docCount: 1 } } } } };
  const parts = buildFreePartitions(buckets, {});
  assert.equal(parts.length, 1);
  assert.match(parts[0].params, /listing_types=material/);
});

test("buildQuixelPartitions covers both sellers", () => {
  const parts = buildQuixelPartitions({ "cat-1": { docCount: 1 } }, { "cat-1": { slug: "rocks" } });
  assert.equal(parts.length, 1);
  assert.match(parts[0].params, /o-cbf5bbfdb340d6a839b5520cb31328/);
  assert.match(parts[0].params, /o-ka9q9jay7xxv6ats7x2j89t7gskfk9/);
});

test("toListing keeps free listings and drops paid ones", () => {
  assert.equal(toListing(paidItem("p")), null);
  assert.equal(toListing({ uid: "x", title: "t", startingPrice: {} }), null);
  const listing = toListing({ ...freeItem("f"), user: { sellerName: "Quixel" } });
  assert.equal(listing.offer, "offer-f");
  assert.equal(listing.seller, "Quixel");
});

test("collectPartition follows cursors and stops on known pages", async () => {
  const known = new Set(Array.from({ length: PAGE_SIZE }, (_, i) => `old-${i}`));
  const requested = stubTabs({
    "categories=x&is_free=1": {
      results: [freeItem("new-1"), freeItem("new-2"), paidItem("paid")],
      next: "https://www.fab.com/i/listings/search?cursor=2",
    },
    "cursor=2": {
      results: Array.from({ length: PAGE_SIZE }, (_, i) => freeItem(`old-${i}`)),
      next: "https://www.fab.com/i/listings/search?cursor=3",
    },
    "cursor=3": { results: [freeItem("unreachable")], next: null },
  });

  const { found, pages } = await collectPartition("categories=x&is_free=1", known, 1);

  assert.deepEqual(found.map((row) => row.uid), ["new-1", "new-2"]);
  assert.equal(pages, 2, "stops after one page without new items");
  assert.equal(requested.length, 2, "third page is never requested");
});

test("collectPartition without knownPages walks to the end", async () => {
  let page = 0;
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 1 }],
      create: async () => ({ id: 1 }),
      sendMessage: async (_tabId, message) => {
        if (message.type === "ping") return { ok: true };
        page += 1;
        const payload = {
          results: [freeItem(`u-${page}-0`), freeItem(`u-${page}-1`)],
          next: page < 3 ? `https://www.fab.com/i/listings/search?cursor=${page}` : null,
        };
        return { status: 200, text: JSON.stringify(payload) };
      },
    },
  };
  const { found, pages } = await collectPartition("is_free=1", new Set(), 0);
  assert.equal(pages, 3);
  assert.equal(found.length, 6);
});

test("a 403 from the relay is reported as an auth failure", async () => {
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 1 }],
      create: async () => ({ id: 1 }),
      sendMessage: async (_tabId, message) => {
        if (message.type === "ping") return { ok: true };
        return { status: 403, text: "{}" };
      },
    },
  };
  const { AuthError } = await import("../lib/api.js");
  await assert.rejects(() => collectPartition("is_free=1", new Set(), 0), AuthError);
});
