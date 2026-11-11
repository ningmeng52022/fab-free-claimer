"""Enumerate free listings by partitioning the Fab catalogue.

The search endpoint only serves roughly 5,016 rows (209 pages x 24) per query,
so the catalogue has to be split into ``category x listing-type`` partitions
before it can be walked completely.
"""

from __future__ import annotations

import json
from typing import Dict, Iterable, Iterator, List, Optional, Tuple

from .client import API, SEARCH, FabClient

PAGE_SIZE = 24
PAGE_LIMIT = 260  # ~5,016 rows: the observed deep-pagination cap
BIG_BUCKET = 4800  # partition above this may still hit the cap

# Quixel storefronts (Megascans + Megaplants).
QUIXEL_SELLERS = (
    "o-cbf5bbfdb340d6a839b5520cb31328",
    "o-ka9q9jay7xxv6ats7x2j89t7gskfk9",
)

# Listing types that cannot be reached through the search endpoint.
SKIP_TYPES = {"bundle"}

Listing = Dict[str, str]


def iter_search(
    fab: FabClient,
    params: str,
    stop_after_known_pages: int = 0,
) -> Iterator[Listing]:
    """Yield raw search hits, following cursors.

    When ``stop_after_known_pages`` is set the results are requested newest
    first and iteration is left to the caller to break early; the flag only
    controls the sort order.
    """
    if stop_after_known_pages:
        params = f"{params}&sort_by=-publishedAt"
    url = f"{SEARCH}?count={PAGE_SIZE}&{params}"
    pages = 0
    while url and pages < PAGE_LIMIT:
        payload = fab.get(url)
        pages += 1
        for item in payload.get("results") or []:
            yield item
        url = payload.get("next")
    if url:
        print(f"  ! hit the deep-pagination cap: {params[:80]}", flush=True)


def collect_items(
    fab: FabClient,
    params: str,
    known: Dict[str, Listing],
    known_pages: int = 0,
) -> List[Listing]:
    """Collect claimable free listings from one partition.

    ``known_pages`` > 0 enables fast incremental mode: results are ordered by
    publication date and the walk stops once ``known_pages`` consecutive pages
    contain nothing new.
    """
    added: List[Listing] = []
    known_streak = 0
    for item in iter_search(fab, params, stop_after_known_pages=known_pages):
        uid = item["uid"]
        already_known = uid in known
        if not already_known:
            price = item.get("startingPrice") or {}
            if price.get("offerId") and not (price.get("price") or 0):
                row: Listing = {
                    "uid": uid,
                    "title": item["title"],
                    "offer": price["offerId"],
                    "seller": (item.get("user") or {}).get("sellerName", ""),
                }
                known[uid] = row
                added.append(row)
        if known_pages:
            known_streak = known_streak + 1 if already_known else 0
            if known_streak >= known_pages * PAGE_SIZE:
                break
    return added


def _buckets(fab: FabClient, query: str, field: str) -> Dict[str, dict]:
    payload = fab.get(f"{SEARCH}?{query}")
    aggregations = payload.get("aggregations") or {}
    return (aggregations.get(field) or {}).get("buckets") or {}


def build_free_partitions(
    fab: FabClient,
    nodes: Dict[str, Dict],
) -> List[Tuple[str, str]]:
    """Partitions covering every free listing type, as ``(params, label)``."""
    buckets = _buckets(
        fab,
        "aggregate_on=category_per_listing_type&count=0&is_free=1",
        "categoryPerListingType",
    )
    partitions: List[Tuple[str, str]] = []
    for listing_type, bucket in buckets.items():
        if listing_type in SKIP_TYPES:
            continue
        categories = (bucket.get("category") or {}).get("buckets") or {}
        if not categories:
            partitions.append(
                (f"listing_types={listing_type}&is_free=1", listing_type)
            )
            continue
        for uid, stats in categories.items():
            slug = (nodes.get(uid) or {}).get("slug")
            if not slug:
                partitions.append(
                    (f"listing_types={listing_type}&is_free=1", f"{listing_type}(no-slug)")
                )
                continue
            if stats.get("docCount", 0) > BIG_BUCKET:
                print(
                    f"  ! {listing_type}/{slug} has {stats['docCount']} rows; "
                    "the pagination cap may truncate it",
                    flush=True,
                )
            partitions.append(
                (
                    f"categories={slug}&listing_types={listing_type}&is_free=1",
                    f"{listing_type}/{slug}",
                )
            )
    return partitions


def build_quixel_partitions(
    fab: FabClient,
    nodes: Dict[str, Dict],
) -> List[Tuple[str, str]]:
    """Partitions covering the two Quixel sellers."""
    sellers = "&".join(f"sellers={seller}" for seller in QUIXEL_SELLERS)
    buckets = _buckets(fab, f"aggregate_on=category&count=0&{sellers}", "category")
    partitions: List[Tuple[str, str]] = []
    for uid in buckets:
        slug = (nodes.get(uid) or {}).get("slug")
        if slug:
            partitions.append((f"categories={slug}&{sellers}", f"quixel/{slug}"))
    return partitions


def dump_listing(row: Listing) -> str:
    return json.dumps(row, ensure_ascii=False)
