"""Command line interface for fab-free-claimer."""

from __future__ import annotations

import argparse
import os
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List

from . import __version__
from .client import API, AuthError, FabClient, read_cookie
from .enumerate import build_free_partitions, build_quixel_partitions, collect_items
from .state import (
    append_lines,
    append_listings,
    load_claimed,
    load_listings,
    load_progress,
    save_progress,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fab-free-claimer",
        description="Bulk-claim every free asset on Fab.com into one or more accounts.",
    )
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("--cookie", required=True, help="file containing the logged-in cookie header")
    parser.add_argument("--account", required=True, help="account label; keeps its own state folder")
    parser.add_argument("--state-dir", default="./fab-state", help="where checkpoints are written")
    parser.add_argument("--workers", type=int, default=16, help="claim concurrency (16 is the sweet spot)")
    parser.add_argument("--enum-workers", type=int, default=8, help="parallel enumeration workers")
    parser.add_argument("--mode", choices=["all", "quixel", "free"], default="all")
    parser.add_argument("--check", action="store_true", help="verify the session cookie only")
    parser.add_argument("--verify", action="store_true", help="verify results after claiming")
    parser.add_argument("--sample", type=int, default=50, help="how many listings to spot-check")
    parser.add_argument("--full-verify", action="store_true", help="scan the whole library (slow)")
    parser.add_argument("--dry-run", action="store_true", help="enumerate only, claim nothing")
    parser.add_argument("--force-enum", action="store_true", help="ignore the enumeration checkpoint")
    parser.add_argument("--skip-enum", action="store_true", help="reuse the existing listings file")
    parser.add_argument(
        "--known-pages",
        type=int,
        default=0,
        help="fast incremental mode: stop a partition after N new-less pages (try 3)",
    )
    parser.add_argument(
        "--time-budget",
        type=int,
        default=0,
        help="stop claiming gracefully after N seconds, keeping all progress",
    )
    parser.add_argument(
        "--reconcile",
        action="store_true",
        help="re-check failures against real ownership (network errors are often false alarms)",
    )
    parser.add_argument("--max-partitions", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--max-claims", type=int, default=0, help=argparse.SUPPRESS)
    return parser


def run(args: argparse.Namespace) -> int:
    state_dir = os.path.join(args.state_dir, args.account)
    os.makedirs(state_dir, exist_ok=True)
    listings_path = os.path.join(state_dir, "listings.jsonl")
    claimed_path = os.path.join(state_dir, "claimed.jsonl")
    failed_path = os.path.join(state_dir, "failed.jsonl")
    progress_path = os.path.join(state_dir, "progress.json")

    fab = FabClient(read_cookie(args.cookie), pool_size=args.workers)
    try:
        me = fab.me()
    except AuthError as exc:
        print(f"! cookie rejected: {exc}", file=sys.stderr)
        return 2
    print(f"account: {me.get('displayName')}  epicId={me.get('epicId')}", flush=True)
    if args.check:
        return 0

    known = load_listings(listings_path)
    claimed = load_claimed(claimed_path)
    print(f"local state: listings={len(known)} claimed={len(claimed)}", flush=True)

    nodes = fab.categories_tree()
    partitions = []
    if args.mode in ("all", "free"):
        partitions += build_free_partitions(fab, nodes)
    if args.mode in ("all", "quixel"):
        partitions += build_quixel_partitions(fab, nodes)
    if args.max_partitions:
        partitions = partitions[: args.max_partitions]
    print(f"partitions: {len(partitions)}", flush=True)

    progress = load_progress(progress_path)
    if progress.get("enum_complete") or args.force_enum:
        enum_done = set()
        progress["enum_complete"] = False
    else:
        enum_done = set(progress.get("enum_done", []))

    if args.skip_enum:
        todo_parts = []
        if not known:
            print("! no local listings file, cannot skip enumeration", file=sys.stderr)
            return 2
        print("skipping enumeration", flush=True)
    else:
        todo_parts = [p for p in partitions if p[0] not in enum_done]
        print(
            f"enumeration checkpoint: {len(enum_done)}/{len(partitions)} done, "
            f"{len(todo_parts)} to go",
            flush=True,
        )

    write_lock = threading.Lock()

    def do_partition(partition):
        params, label = partition
        added = collect_items(fab, params, known, known_pages=args.known_pages)
        with write_lock:
            if added:
                append_listings(listings_path, added)
            enum_done.add(params)
            progress["enum_done"] = sorted(enum_done)
            save_progress(progress_path, progress)
        return label, len(added)

    if todo_parts:
        with ThreadPoolExecutor(max_workers=args.enum_workers) as pool:
            futures = [pool.submit(do_partition, part) for part in todo_parts]
            for index, future in enumerate(as_completed(futures), 1):
                label, added = future.result()
                if index % 5 == 0 or index == len(todo_parts):
                    print(
                        f"  enumerate [{index}/{len(todo_parts)}] {label} "
                        f"+{added} total={len(known)}",
                        flush=True,
                    )
    progress["enum_complete"] = True
    progress["enum_total"] = len(known)
    save_progress(progress_path, progress)
    print(f"enumeration done: {len(known)} free listings", flush=True)

    todo = [row for uid, row in known.items() if uid not in claimed]
    if args.max_claims:
        todo = todo[: args.max_claims]
    print(f"to claim: {len(todo)}", flush=True)
    if args.dry_run or not todo:
        return 0

    ok = fail = fatal = 0
    failed_uids: List[str] = []
    started = time.time()
    lock = threading.Lock()
    with open(claimed_path, "a", encoding="utf-8") as claimed_fh, open(
        failed_path, "a", encoding="utf-8"
    ) as failed_fh:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {
                pool.submit(fab.claim, row["uid"], row["offer"]): row for row in todo
            }
            for index, future in enumerate(as_completed(futures), 1):
                status = future.result()
                uid = futures[future]["uid"]
                if status == "ok":
                    ok += 1
                    with lock:
                        claimed.add(uid)
                        claimed_fh.write(uid + "\n")
                        claimed_fh.flush()
                else:
                    fail += 1
                    failed_uids.append(uid)
                    with lock:
                        failed_fh.write(f'{{"uid": "{uid}", "status": "{status}"}}\n')
                        failed_fh.flush()
                    if status.startswith("fatal"):
                        fatal += 1
                if index % 500 == 0:
                    elapsed = time.time() - started
                    print(
                        f"  claim {index}/{len(todo)} ok={ok} fail={fail} "
                        f"{index / elapsed:.1f}/s",
                        flush=True,
                    )
                if (
                    args.time_budget
                    and index % 100 == 0
                    and time.time() - started > args.time_budget
                ):
                    print(f"! time budget reached, stopping cleanly", flush=True)
                    for pending in futures:
                        pending.cancel()
                    break
                if fatal >= 3:
                    print("! repeated 401/403, stopping. Refresh the cookie.", flush=True)
                    break

    elapsed = time.time() - started
    rate = ok / elapsed if elapsed else 0
    print(f"claim done: ok={ok} fail={fail} in {int(elapsed)}s ({rate:.1f}/s)", flush=True)

    if args.reconcile and failed_uids:
        with ThreadPoolExecutor(max_workers=min(8, args.workers)) as pool:
            results = list(pool.map(lambda uid: (uid, fab.owned(uid)), failed_uids))
        recovered = [uid for uid, owned in results if owned]
        if recovered:
            append_lines(claimed_path, recovered)
            claimed.update(recovered)
            print(
                f"reconcile: {len(recovered)}/{len(failed_uids)} were actually owned",
                flush=True,
            )
        print(f"still failing: {len(failed_uids) - len(recovered)}", flush=True)

    if args.verify:
        run_verify(fab, claimed, args)

    progress.update(
        {
            "account": args.account,
            "display_name": me.get("displayName"),
            "listings": len(known),
            "claimed": len(claimed),
            "ok": ok,
            "fail": fail,
        }
    )
    save_progress(progress_path, progress)
    return 0


def run_verify(fab: FabClient, claimed: set, args: argparse.Namespace) -> None:
    if args.full_verify:
        owned: set = set()
        url = f"{API}/library/search?sort_by=-createdAt&count=24"
        pages = 0
        while url and pages < 4000:
            payload = fab.get(url)
            pages += 1
            for row in payload.get("results") or []:
                uid = (row.get("listing") or {}).get("uid")
                if uid:
                    owned.add(uid)
            url = payload.get("next")
        missing = claimed - owned
        print(
            f"full verify: library={len(owned)} claimed={len(claimed)} missing={len(missing)}",
            flush=True,
        )
        return
    if not args.sample or not claimed:
        return
    picks = random.sample(sorted(claimed), min(args.sample, len(claimed)))
    good = sum(1 for uid in picks if fab.owned(uid))
    print(f"spot check: {good}/{len(picks)} owned", flush=True)


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except AuthError as exc:
        print(f"! authentication failed: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\ninterrupted; progress is saved", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
