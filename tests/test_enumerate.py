import unittest
from unittest import mock

from fab_free_claimer import enumerate as enum


def free_item(uid, title="asset"):
    return {"uid": uid, "title": title, "startingPrice": {"offerId": f"offer-{uid}", "price": 0.0}}


def paid_item(uid):
    return {
        "uid": uid,
        "title": "paid",
        "startingPrice": {"offerId": f"offer-{uid}", "price": 12.0},
    }


class CollectItemsTest(unittest.TestCase):
    def test_collects_only_free_and_skips_duplicates(self):
        known = {"a": {"uid": "a"}}
        items = [free_item("a"), free_item("b"), paid_item("c"), free_item("d")]
        with mock.patch.object(enum, "iter_search", return_value=iter(items)):
            added = enum.collect_items(mock.Mock(), "params", known)
        self.assertEqual([row["uid"] for row in added], ["b", "d"])
        self.assertEqual(set(known), {"a", "b", "d"})

    def test_incremental_mode_stops_after_known_pages(self):
        known = {uid: {"uid": uid} for uid in ("a", "b", "c")}
        # 3 pages of already-known rows with one new item at the very top.
        rows = [free_item("new")] + [free_item(u) for u in ("a", "b", "c") * enum.PAGE_SIZE]
        consumed = []

        def fake_iter(fab, params, stop_after_known_pages=0):
            for row in rows:
                consumed.append(row["uid"])
                yield row

        with mock.patch.object(enum, "iter_search", side_effect=fake_iter):
            added = enum.collect_items(mock.Mock(), "params", known, known_pages=3)

        self.assertEqual([row["uid"] for row in added], ["new"])
        # One new row, then 3 pages worth of known rows, then it must stop.
        self.assertEqual(len(consumed), 1 + 3 * enum.PAGE_SIZE)

    def test_incremental_mode_sets_newest_first_sort(self):
        captured = {}

        def fake_get(self, url, tries=3):
            captured["url"] = url
            return {"results": [], "next": None}

        with mock.patch.object(enum.FabClient, "get", fake_get):
            list(enum.iter_search(enum.FabClient("fab_csrftoken=x"), "is_free=1", 3))
        self.assertIn("sort_by=-publishedAt", captured["url"])


class PartitionTest(unittest.TestCase):
    def test_bundle_is_skipped_and_slugs_are_used(self):
        fab = mock.Mock()
        fab.get.return_value = {
            "aggregations": {
                "categoryPerListingType": {
                    "buckets": {
                        "3d-model": {
                            "docCount": 2,
                            "category": {"buckets": {"cat-1": {"docCount": 2}}},
                        },
                        "bundle": {"docCount": 5, "category": {"buckets": {}}},
                    }
                }
            }
        }
        nodes = {"cat-1": {"slug": "nature--forest"}}
        parts = enum.build_free_partitions(fab, nodes)
        self.assertEqual(len(parts), 1)
        self.assertIn("categories=nature--forest", parts[0][0])
        self.assertIn("is_free=1", parts[0][0])

    def test_quixel_partitions_use_both_sellers(self):
        fab = mock.Mock()
        fab.get.return_value = {
            "aggregations": {"category": {"buckets": {"cat-1": {"docCount": 1}}}}
        }
        parts = enum.build_quixel_partitions(fab, {"cat-1": {"slug": "rocks"}})
        self.assertEqual(len(parts), 1)
        for seller in enum.QUIXEL_SELLERS:
            self.assertIn(seller, parts[0][0])


if __name__ == "__main__":
    unittest.main()
