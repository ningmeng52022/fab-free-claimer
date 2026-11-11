/**
 * Logic tests for the extension. Run with: node --test extension/tests
 * No network: chrome.cookies and fetch are stubbed.
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

function stubChrome() {
  globalThis.chrome = {
    cookies: { get: async () => ({ value: "test-token" }) },
  };
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
  stubChrome();
  const pages = {
    "categories=x&is_free=1": {
      results: [freeItem("new-1"), freeItem("new-2"), paidItem("paid")],
      next: "https://www.fab.com/i/listings/search?cursor=2",
    },
    "https://www.fab.com/i/listings/search?cursor=2": {
      results: Array.from({ length: PAGE_SIZE }, (_, i) => freeItem(`old-${i}`)),
      next: "https://www.fab.com/i/listings/search?cursor=3",
    },
    "https://www.fab.com/i/listings/search?cursor=3": {
      results: [freeItem("should-not-be-reached")],
      next: null,
    },
  };
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(url);
    const key = Object.keys(pages).find((candidate) => url.endsWith(candidate) || url.includes(candidate));
    return { status: 200, json: async () => pages[key] || { results: [], next: null } };
  };

  const known = new Set(
    Array.from({ length: PAGE_SIZE }, (_, i) => `old-${i}`)
  );
  const { found, pages: pageCount } = await collectPartition("categories=x&is_free=1", known, 1);

  assert.deepEqual(found.map((row) => row.uid), ["new-1", "new-2"]);
  assert.equal(pageCount, 2, "stops after one page without new items");
  assert.equal(fetched.length, 2, "third page is never requested");
});

test("collectPartition without knownPages walks to the end", async () => {
  stubChrome();
  let page = 0;
  globalThis.fetch = async () => {
    page += 1;
    return {
      status: 200,
      json: async () => ({
        results: [freeItem(`u-${page}-0`), freeItem(`u-${page}-1`)],
        next: page < 3 ? `https://www.fab.com/i/listings/search?cursor=${page}` : null,
      }),
    };
  };
  const { found, pages } = await collectPartition("is_free=1", new Set(), 0);
  assert.equal(pages, 3);
  assert.equal(found.length, 6);
});
