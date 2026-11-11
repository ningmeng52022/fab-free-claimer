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
 * Walk one partition and return newly discovered free listings.
 *
 * knownPages > 0 enables incremental mode: results are requested newest-first
 * and the walk stops once that many consecutive pages contain nothing new.
 */
export async function collectPartition(params, known, knownPages = 0) {
  const query = knownPages ? `${params}&sort_by=-publishedAt` : params;
  const found = [];
  let url = query;
  let pages = 0;
  let streak = 0;

  while (url && pages < PAGE_LIMIT) {
    const page = await search(url);
    pages += 1;
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
    if (knownPages && streak >= knownPages * PAGE_SIZE) break;
    url = page.next || null;
  }

  const capped = Boolean(url) && pages >= PAGE_LIMIT;
  if (capped) console.warn("deep-pagination cap reached:", params);
  return { found, pages, capped };
}
