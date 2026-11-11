import json
import os
import tempfile
import unittest

from fab_free_claimer.state import (
    compact,
    load_claimed,
    load_listings,
    load_progress,
    save_progress,
)


class StateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.listings = os.path.join(self.tmp, "listings.jsonl")
        self.claimed = os.path.join(self.tmp, "claimed.jsonl")
        self.progress = os.path.join(self.tmp, "progress.json")

    def test_listings_are_deduplicated_by_uid(self):
        with open(self.listings, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"uid": "a", "title": "old"}) + "\n")
            fh.write(json.dumps({"uid": "a", "title": "new"}) + "\n")
            fh.write(json.dumps({"uid": "b", "title": "other"}) + "\n")
            fh.write("not json\n")
        rows = load_listings(self.listings)
        self.assertEqual(set(rows), {"a", "b"})
        self.assertEqual(rows["a"]["title"], "new")

    def test_claimed_accepts_both_formats(self):
        with open(self.claimed, "w", encoding="utf-8") as fh:
            fh.write("uid-one\n")
            fh.write(json.dumps({"uid": "uid-two"}) + "\n")
            fh.write("\n")
        self.assertEqual(load_claimed(self.claimed), {"uid-one", "uid-two"})

    def test_missing_files_are_empty(self):
        self.assertEqual(load_listings(self.listings), {})
        self.assertEqual(load_claimed(self.claimed), set())
        self.assertEqual(load_progress(self.progress), {})

    def test_progress_roundtrip_leaves_no_temp_file(self):
        save_progress(self.progress, {"enum_complete": True, "enum_done": ["x"]})
        self.assertEqual(load_progress(self.progress)["enum_done"], ["x"])
        self.assertFalse(os.path.exists(self.progress + ".tmp"))

    def test_compact_rewrites_without_duplicates(self):
        with open(self.listings, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"uid": "a"}) + "\n")
            fh.write(json.dumps({"uid": "a"}) + "\n")
        with open(self.claimed, "w", encoding="utf-8") as fh:
            fh.write("x\nx\ny\n")
        self.assertEqual(compact(self.listings, self.claimed), (1, 2))
        with open(self.listings, encoding="utf-8") as fh:
            self.assertEqual(len(fh.readlines()), 1)


if __name__ == "__main__":
    unittest.main()
