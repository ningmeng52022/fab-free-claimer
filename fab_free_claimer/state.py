"""Checkpoint files: everything is append-only so a killed run can resume."""

from __future__ import annotations

import json
import os
from typing import Dict, Iterable, List, Set


def load_listings(path: str) -> Dict[str, dict]:
    """uid -> listing, de-duplicated."""
    rows: Dict[str, dict] = {}
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("uid"):
                rows[row["uid"]] = row
    return rows


def load_claimed(path: str) -> Set[str]:
    """Accept both one-uid-per-line and ``{"uid": ...}`` records."""
    uids: Set[str] = set()
    if not os.path.exists(path):
        return uids
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            if line.startswith("{"):
                try:
                    uid = json.loads(line).get("uid")
                except json.JSONDecodeError:
                    uid = None
            else:
                uid = line
            if uid:
                uids.add(uid)
    return uids


def append_listings(path: str, rows: Iterable[dict]) -> None:
    with open(path, "a", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def append_lines(path: str, lines: Iterable[str]) -> None:
    with open(path, "a", encoding="utf-8") as fh:
        for line in lines:
            fh.write(line + "\n")


def load_progress(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return {}


def save_progress(path: str, data: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def compact(listings_path: str, claimed_path: str) -> tuple:
    """Rewrite checkpoint files without duplicates. Returns (listings, claimed)."""
    rows = load_listings(listings_path)
    with open(listings_path, "w", encoding="utf-8") as fh:
        for row in rows.values():
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    uids = load_claimed(claimed_path)
    with open(claimed_path, "w", encoding="utf-8") as fh:
        for uid in sorted(uids):
            fh.write(uid + "\n")
    return len(rows), len(uids)
