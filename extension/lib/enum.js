/**
 * Catalogue partitioning.
 *
 * A single search query only serves ~5,016 rows (209 pages x 24) even though the
 * aggregations report far more, so the free catalogue has to be split into
 * "category x listing-type" partitions before it can be walked completely.
 */

import { search } from "./api.js";

export const PAGE_SIZE = 24;
export const PAGE_LIMIT = 260;
export const BIG_BUCKET = 4800;
export const KNOWN_TYPES = new Set(["bundle"]);

export const QUIXEL_SELLERS = [
  "o-cbf5bbfdb340d6a839b5520cb31328",
  "o-ka9q9jay7xxv6ats7x2j89t7gskfk9",
];

/** Flatten the category tree into uid -> node. */
export function flattenTree(tree) {
  const nodes = {};
  const walk = (items) => {
    for (const node of items) {
      nodes[node.uid] = node;
      walk(node.children || []);
    }
  };
  walk(tree);
  return nodes;
}

export function buildFreePartitions(buckets, nodes) {
  const partitions = [];
  for (const [listingType, bucket] of Object.entries(buckets || {})) {
    if (KNOWN_TYPES.has(listingType)) continue;
    const categories = (bucket.category || {}).buckets || {};
    if (!Object.keys(categories).length) {
      partitions.push({
        params: `listing_types=${listingType}&is_free=1`,
        label: listingType,
      });
      continue;
    }
    for (const uid of Object.keys(categories)) {
      const slug = (nodes[uid] || {}).slug;
      if (!slug) {
        partitions.push({
          params: `listing_types=${listingType}&is_free=1`,
          label: `${listingType}(no-slug)`,
        });
        continue;
      }
      partitions.push({
        params: `categories=${slug}&listing_types=${listingType}&is_free=1`,
        label: `${listingType}/${slug}`,
      });
    }
  }
  return partitions;
}

export function buildQuixelPartitions(buckets, nodes) {
  const sellers = QUIXEL_SELLERS.map((seller) => `sellers=${seller}`).join("&");
  const partitions = [];
  for (const uid of Object.keys(buckets || {})) {
    const slug = (nodes[uid] || {}).slug;
    if (slug) {
      partitions.push({ params: `categories=${slug}&${sellers}`, label: `quixel/${slug}` });
    }
  }
  return partitions;
}

export function toListing(item) {
  const price = item.startingPrice || {};
  if (!price.offerId || (price.price || 0) !== 0) return null;
  return {
    uid: item.uid,
    title: item.title,
    offer: price.offerId,
    seller: (item.user || {}).sellerName || "",
  };
}

/**
 * Walk one partition page by page, checkpointing after every page.
 *
 * A partition can be 200+ pages deep (~8 minutes), far longer than a service
 * worker lives, so the caller must be able to resume from `nextUrl`.
 *
 * @returns {Promise<{done: boolean, nextUrl: string|null}>}
 */
export async function walkPartition({
  params,
  known,
  knownPages = 0,
  startUrl = null,
  deadline = 0,
  onPage = null,
}) {
  const first = knownPages ? `${params}&sort_by=-publishedAt` : params;
  let url = startUrl || first;
  let pages = 0;
  let streak = 0;

  while (url && pages < PAGE_LIMIT) {
    const page = await search(url);
    pages += 1;
    const found = [];
    for (const item of page.results || []) {
      const listing = toListing(item);
      if (listing && !known.has(listing.uid)) {
        known.add(listing.uid);
        found.push(listing);
        streak = 0;
      } else if (knownPages) {
        streak += 1;
      }
    }

    const stopByStreak = knownPages > 0 && streak >= knownPages * PAGE_SIZE;
    const nextUrl = page.next || null;
    const done = !nextUrl || stopByStreak;

    if (onPage) await onPage({ found, nextUrl: done ? null : nextUrl, done });
    if (done) return { done: true, nextUrl: null };
    url = nextUrl;

    if (deadline && Date.now() > deadline) return { done: false, nextUrl: url };
  }

  if (url) console.warn("deep-pagination cap reached:", params);
  return { done: true, nextUrl: null };
}

/**
 * In-memory variant used by the tests: returns everything found in one go.
 */
export async function collectPartition(params, known, knownPages = 0) {
  const found = [];
  let pages = 0;
  const counter = { count: 0 };
  await walkPartition({
    params,
    known,
    knownPages,
    onPage: ({ found: pageFound, done }) => {
      found.push(...pageFound);
      counter.count += 1;
      if (done) pages = counter.count;
    },
  });
  return { found, pages: pages || counter.count, capped: false };
}
