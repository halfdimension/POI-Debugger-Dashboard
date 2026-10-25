from __future__ import annotations

import csv
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from backend.app.datasets import DatasetManager
from backend.app.poi_search import (
    MAX_LIMIT,
    PoiSearchError,
    PoiSearchIndex,
    PoiSearchNotFoundError,
    PoiSearchValidationError,
    parse_bbox,
)


FIELDS = (
    "new_node_id",
    "mappls_poi_id",
    "name",
    "landmark_type",
    "priority",
    "visible",
    "lat",
    "lon",
    "osm_source_id",
    "extra",
)


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def row(
    name: str,
    node_id: str,
    *,
    poi_id: str = "",
    osm_id: str = "",
    kind: str = "school",
    priority: object = 50,
    visible: object = "yes",
    lat: object = 28.0,
    lon: object = 77.0,
) -> dict[str, object]:
    return {
        "new_node_id": node_id,
        "mappls_poi_id": poi_id,
        "name": name,
        "landmark_type": kind,
        "priority": priority,
        "visible": visible,
        "lat": lat,
        "lon": lon,
        "osm_source_id": osm_id,
        "extra": f"metadata-{node_id}",
    }


class PoiSearchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.a_csv = self.root / "a.csv"
        self.b_csv = self.root / "b.csv"
        write_csv(
            self.a_csv,
            [
                row("Alpha School", "node-1", poi_id="MMI-ONE", priority=20),
                row("alpha school", "node-2", poi_id="MMI-TWO", priority=80, lon=77.2),
                row("Beta Cafe", "node-3", osm_id="OSM-ABC", kind="cafe", priority="", visible="no", lon=78),
                row("Missing priority", "node-4", poi_id="MMI-ONE", priority="bad", visible="off", lon=79),
                row("Broken", "bad-coordinate", lat=999),
            ],
        )
        write_csv(self.b_csv, [row("Other Dataset", "other-1", poi_id="MMI-OTHER")])
        self.datasets = {
            "a": {"id": "a", "poi_csv_path": str(self.a_csv)},
            "b": {"id": "b", "poi_csv_path": str(self.b_csv)},
        }
        self.index = PoiSearchIndex(self.datasets, self.root / "indexes")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_name_identifier_case_and_duplicate_search_ranking(self) -> None:
        result = self.index.search("a", q="ALPHA")
        self.assertEqual([f["properties"]["new_node_id"] for f in result["features"]], ["node-2", "node-1"])
        self.assertEqual(self.index.search("a", q="mmi-one")["returned"], 2)
        self.assertEqual(self.index.search("a", q="osm-abc")["returned"], 1)
        self.assertEqual(self.index.search("a", q="node-4")["returned"], 1)
        self.assertEqual(self.index.search("a", q="%")["returned"], 0)

    def test_combined_filters_priority_visibility_bbox_and_metadata(self) -> None:
        result = self.index.search(
            "a",
            q="school",
            landmark_type="school",
            min_priority=50,
            visible=True,
            bbox=(77.1, 27.9, 77.3, 28.1),
        )
        self.assertEqual(result["returned"], 1)
        self.assertEqual(result["features"][0]["properties"]["extra"], "metadata-node-2")
        self.assertEqual(self.index.search("a", visible=False)["returned"], 1)
        self.assertEqual(self.index.search("a", visible=True)["returned"], 3)
        self.assertEqual(self.index.search("a", min_priority=0)["returned"], 3)

    def test_pagination_is_stable_complete_and_bound(self) -> None:
        first = self.index.search("a", limit=2)
        second = self.index.search("a", limit=2, cursor=first["next_cursor"])
        ids = [f["properties"]["new_node_id"] for f in first["features"] + second["features"]]
        self.assertEqual(ids, ["node-1", "node-2", "node-3", "node-4"])
        self.assertTrue(first["has_more"])
        self.assertFalse(second["has_more"])
        self.assertIsNone(second["next_cursor"])
        with self.assertRaises(PoiSearchValidationError):
            self.index.search("a", limit=0)
        with self.assertRaises(PoiSearchValidationError):
            self.index.search("a", limit=MAX_LIMIT + 1)

    def test_cursor_query_binding_and_invalidation(self) -> None:
        first = self.index.search("a", limit=1)
        with self.assertRaises(PoiSearchValidationError):
            self.index.search("a", q="alpha", limit=1, cursor=first["next_cursor"])
        self.index.invalidate("a")
        with self.assertRaises(PoiSearchValidationError):
            self.index.search("a", limit=1, cursor=first["next_cursor"])
        with self.assertRaises(PoiSearchValidationError):
            self.index.search("a", cursor="not-json")

    def test_dataset_isolation_and_concurrent_reads(self) -> None:
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(self.index.search, dataset_id) for dataset_id in ("a", "b", "a", "b")]
        names = [[f["properties"]["name"] for f in future.result()["features"]] for future in futures]
        self.assertIn("Alpha School", names[0])
        self.assertEqual(names[1], ["Other Dataset"])
        self.assertEqual(names[3], ["Other Dataset"])

    def test_explicit_search_does_not_change_active_dataset_and_reload_invalidates(self) -> None:
        manager = DatasetManager(
            {
                "active_dataset": "a",
                "backend": {"poi_index_dir": str(self.root / "manager-index")},
                "datasets": self.datasets,
            }
        )
        page = manager.search_index.search("a", limit=1)
        manager.search_index.search("b")
        self.assertEqual(manager.active_id, "a")
        manager.reload("a")
        with self.assertRaises(PoiSearchValidationError):
            manager.search_index.search("a", limit=1, cursor=page["next_cursor"])

    def test_geojson_fallback_missing_metadata_and_invalid_coordinates(self) -> None:
        geojson = self.root / "fallback.geojson"
        geojson.write_text(
            json.dumps(
                {
                    "type": "FeatureCollection",
                    "features": [
                        {"type": "Feature", "id": "kept", "geometry": {"type": "Point", "coordinates": [76, 29]}, "properties": {}},
                        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [999, 29]}, "properties": {"name": "invalid"}},
                    ],
                }
            ),
            encoding="utf-8",
        )
        index = PoiSearchIndex(
            {"fallback": {"poi_csv_path": str(self.root / "missing.csv"), "poi_geojson_path": str(geojson)}},
            self.root / "geo-index",
        )
        result = index.search("fallback", visible=True)
        self.assertEqual(result["returned"], 1)
        self.assertEqual(result["features"][0]["id"], "kept")

    def test_missing_and_corrupt_sources_fail_safely(self) -> None:
        missing = PoiSearchIndex({"x": {"poi_csv_path": str(self.root / "missing.csv")}}, self.root / "x-index")
        with self.assertRaises(PoiSearchError):
            missing.search("x")
        broken = self.root / "broken.geojson"
        broken.write_text("{broken", encoding="utf-8")
        corrupt = PoiSearchIndex({"x": {"poi_geojson_path": str(broken)}}, self.root / "broken-index")
        with self.assertRaises(PoiSearchError):
            corrupt.search("x")
        with self.assertRaises(PoiSearchNotFoundError):
            self.index.search("unknown")

    def test_bbox_validation(self) -> None:
        self.assertEqual(parse_bbox("76,28,77,29"), (76, 28, 77, 29))
        for invalid in ("76,28,77", "x,28,77,29", "-181,28,77,29", "76,91,77,92", "77,28,76,29", "76,30,77,29"):
            with self.subTest(invalid=invalid), self.assertRaises(PoiSearchValidationError):
                parse_bbox(invalid)

    def test_broad_ranked_path_matches_selective_path_and_paginates(self) -> None:
        def collect(threshold: int, **kwargs: object) -> list[str]:
            found: list[str] = []
            cursor = None
            with patch("backend.app.poi_search.BROAD_QUERY_THRESHOLD", threshold):
                while True:
                    page = self.index.search("a", limit=1, cursor=cursor, **kwargs)
                    found.extend(
                        feature["properties"]["new_node_id"]
                        for feature in page["features"]
                    )
                    cursor = page["next_cursor"]
                    if cursor is None:
                        return found

        self.assertEqual(collect(1, q="school"), collect(10_000, q="school"))
        self.assertEqual(
            collect(1, q="school", min_priority=30, visible=True),
            collect(10_000, q="school", min_priority=30, visible=True),
        )

    def test_source_change_rebuilds_index_and_rejects_old_cursor(self) -> None:
        first = self.index.search("a", q="alpha", limit=1)
        old_cursor = first["next_cursor"]
        self.assertIsNotNone(old_cursor)
        write_csv(self.a_csv, [row("Replacement School", "replacement")])
        rebuilt = self.index.search("a", q="replacement")
        self.assertEqual(
            [feature["properties"]["new_node_id"] for feature in rebuilt["features"]],
            ["replacement"],
        )
        with self.assertRaises(PoiSearchValidationError):
            self.index.search("a", q="alpha", limit=1, cursor=old_cursor)

    def test_broad_mixed_prefix_ranking_matches_selective_results(self) -> None:
        ranked_csv = self.root / "ranked.csv"
        write_csv(
            ranked_csv,
            [
                row("Common Same", "start-1", priority=10),
                row("common same", "start-2", priority=10),
                row("Common Null", "start-null", priority="bad"),
                row("Common Low", "start-low", priority=-5),
                row("Alpha Common", "nonstart-high", priority=100),
            ],
        )
        index = PoiSearchIndex(
            {"ranked": {"poi_csv_path": str(ranked_csv)}},
            self.root / "ranked-index",
        )

        def collect(threshold: int) -> list[str]:
            found: list[str] = []
            cursor = None
            with patch("backend.app.poi_search.BROAD_QUERY_THRESHOLD", threshold):
                while True:
                    page = index.search("ranked", q="common", limit=2, cursor=cursor)
                    found.extend(
                        feature["properties"]["new_node_id"]
                        for feature in page["features"]
                    )
                    cursor = page["next_cursor"]
                    if cursor is None:
                        return found

        expected = collect(10_000)
        self.assertEqual(collect(1), expected)
        self.assertEqual(
            expected,
            ["start-1", "start-2", "start-null", "start-low", "nonstart-high"],
        )

    def test_short_terms_and_literal_special_characters(self) -> None:
        special_csv = self.root / "special.csv"
        write_csv(
            special_csv,
            [
                row("A 100% Place", "short-a"),
                row("Under_score", "short-ab"),
                row(r"Back\slash", "short-b"),
            ],
        )
        index = PoiSearchIndex(
            {"special": {"poi_csv_path": str(special_csv)}},
            self.root / "special-index",
        )
        self.assertEqual(index.search("special", q="a")["returned"], 3)
        self.assertEqual(index.search("special", q="ab")["returned"], 1)
        self.assertEqual(index.search("special", q="%")["returned"], 1)
        self.assertEqual(index.search("special", q="_")["returned"], 1)
        self.assertEqual(index.search("special", q="\\")["returned"], 1)


if __name__ == "__main__":
    unittest.main()
