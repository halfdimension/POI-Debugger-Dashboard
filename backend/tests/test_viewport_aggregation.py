from __future__ import annotations

import csv
import json
import math
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from backend.app.poi_search import (
    SCHEMA_VERSION,
    SPATIAL_MAX_LEVEL,
    VIEWPORT_MAX_FEATURES,
    VIEWPORT_MAX_PAYLOAD_BYTES,
    PoiSearchIndex,
    PoiSearchNotFoundError,
    PoiSearchNotReadyError,
    PoiSearchPayloadTooLargeError,
    PoiSearchStaleGenerationError,
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
    "extra",
)


def point(
    ordinal: int,
    *,
    lon: object = 77.0,
    lat: object = 28.0,
    external_id: str | None = None,
    extra: str = "",
) -> dict[str, object]:
    return {
        "new_node_id": f"node-{ordinal}",
        "mappls_poi_id": external_id or f"poi-{ordinal}",
        "name": f"POI {ordinal}",
        "landmark_type": "test",
        "priority": ordinal % 25,
        "visible": "yes",
        "lat": lat,
        "lon": lon,
        "extra": extra,
    }


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def represented_count(response: dict[str, object]) -> int:
    aggregates = response["aggregates"]
    individuals = response["individual_pois"]
    assert isinstance(aggregates, list)
    assert isinstance(individuals, list)
    return sum(int(item["source_record_count"]) for item in aggregates) + len(
        individuals
    )


class ViewportAggregationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def make_index(
        self,
        datasets: dict[str, Path],
        *,
        directory: str = "indexes",
        allow_implicit_build: bool = True,
    ) -> PoiSearchIndex:
        return PoiSearchIndex(
            {
                dataset_id: {"id": dataset_id, "poi_csv_path": str(path)}
                for dataset_id, path in datasets.items()
            },
            self.root / directory,
            allow_implicit_build=allow_implicit_build,
        )

    def test_individual_thresholds_and_more_than_500_are_complete(self) -> None:
        for count in (499, 500, 501):
            with self.subTest(count=count):
                source = self.root / f"threshold-{count}.csv"
                write_csv(
                    source,
                    [
                        point(
                            ordinal,
                            lon=77.0 + (ordinal % 20) * 0.00001,
                            lat=28.0 + (ordinal // 20) * 0.00001,
                        )
                        for ordinal in range(count)
                    ],
                )
                index = self.make_index(
                    {"threshold": source}, directory=f"index-{count}"
                )
                response = index.viewport(
                    "threshold",
                    bbox=(76.0, 27.0, 78.0, 29.0),
                    zoom=22,
                    max_features=500,
                )
                self.assertTrue(response["complete"])
                self.assertEqual(response["total_matching_pois"], count)
                self.assertEqual(represented_count(response), count)
                self.assertLessEqual(response["meta"]["feature_count"], 500)
                self.assertEqual(
                    response["mode"], "individual" if count <= 500 else "aggregated"
                )

    def test_dense_duplicates_are_exact_deterministic_and_page_without_skips(self) -> None:
        source = self.root / "dense.csv"
        write_csv(
            source,
            [
                point(ordinal, external_id="duplicate", lon=77.125, lat=28.625)
                for ordinal in range(2_500)
            ],
        )
        index = self.make_index({"dense": source})
        previous = None
        for zoom in (0, 8.5, 14, 22):
            response = index.viewport(
                "dense",
                bbox=(77.0, 28.5, 77.25, 28.75),
                zoom=zoom,
                max_features=25,
            )
            self.assertTrue(response["complete"])
            self.assertEqual(response["total_matching_pois"], 2_500)
            self.assertEqual(represented_count(response), 2_500)
            self.assertEqual(len(response["aggregates"]), 1)
            repeated = index.viewport(
                "dense",
                bbox=(77.0, 28.5, 77.25, 28.75),
                zoom=zoom,
                max_features=25,
            )
            self.assertEqual(response, repeated)
            previous = response

        assert previous is not None
        aggregate = previous["aggregates"][0]
        found: list[int] = []
        cursor = None
        while True:
            page = index.viewport_cluster_members(
                "dense",
                cluster_ref=aggregate["cluster_ref"],
                limit=137,
                cursor=cursor,
            )
            self.assertEqual(page["total_matching_pois"], 2_500)
            found.extend(
                item["source_record_id"] for item in page["individual_pois"]
            )
            cursor = page["next_cursor"]
            if cursor is None:
                break
        self.assertEqual(found, list(range(1, 2_501)))

    def test_grid_and_viewport_boundaries_count_each_record_once(self) -> None:
        source = self.root / "boundaries.csv"
        rows = [
            point(1, lon=0.0, lat=0.0),
            point(2, lon=45.0, lat=0.0),
            point(3, lon=0.0, lat=22.5),
            point(4, lon=45.0, lat=22.5),
            point(5, lon=-0.000001, lat=1.0),
            point(6, lon=45.000001, lat=1.0),
            point(7, lon="invalid", lat=1.0),
            point(8, lon=1.0, lat=91.0),
        ]
        write_csv(source, rows)
        index = self.make_index({"boundary": source})
        for zoom in (0, 5, 15, 22):
            response = index.viewport(
                "boundary",
                bbox=(0.0, 0.0, 45.0, 22.5),
                zoom=zoom,
                max_features=100,
            )
            self.assertEqual(response["total_matching_pois"], 4)
            self.assertEqual(represented_count(response), 4)
        world = index.viewport(
            "boundary", bbox=(-180.0, -90.0, 180.0, 90.0), zoom=0
        )
        self.assertEqual(world["total_matching_pois"], 6)

    def test_different_densities_empty_regions_and_adaptive_coarsening(self) -> None:
        source = self.root / "cities.csv"
        rows = [
            point(i, lon=77 + (i % 50) * 0.01, lat=28 + (i // 50) * 0.01)
            for i in range(1_200)
        ]
        rows.extend(
            point(1_200 + i, lon=88 + i * 0.01, lat=22 + i * 0.01)
            for i in range(20)
        )
        write_csv(source, rows)
        index = self.make_index({"cities": source})
        response = index.viewport(
            "cities",
            bbox=(70.0, 15.0, 95.0, 35.0),
            zoom=14,
            max_features=3,
        )
        self.assertTrue(response["complete"])
        self.assertTrue(response["meta"]["adaptive_coarsening"])
        self.assertLessEqual(response["meta"]["feature_count"], 3)
        self.assertEqual(response["total_matching_pois"], 1_220)
        self.assertEqual(represented_count(response), 1_220)
        empty = index.viewport(
            "cities", bbox=(-20.0, -20.0, -10.0, -10.0), zoom=10
        )
        self.assertTrue(empty["complete"])
        self.assertEqual(empty["total_matching_pois"], 0)
        self.assertEqual(empty["aggregates"], [])

    def test_dataset_isolation_with_overlapping_geography(self) -> None:
        source_a = self.root / "a.csv"
        source_b = self.root / "b.csv"
        write_csv(source_a, [point(i) for i in range(17)])
        write_csv(source_b, [point(i) for i in range(31)])
        index = self.make_index({"a": source_a, "b": source_b})
        responses = {}
        for dataset_id, expected in (("a", 17), ("b", 31)):
            response = index.viewport(
                dataset_id, bbox=(76.0, 27.0, 78.0, 29.0), zoom=8
            )
            responses[dataset_id] = response
            self.assertEqual(response["dataset_id"], dataset_id)
            self.assertEqual(response["total_matching_pois"], expected)
            self.assertEqual(represented_count(response), expected)
        with self.assertRaises(PoiSearchValidationError):
            index.viewport_cluster_members(
                "b", cluster_ref=responses["a"]["aggregates"][0]["cluster_ref"]
            )

    def test_generation_changes_reject_cluster_references_and_cursors(self) -> None:
        source = self.root / "generation.csv"
        write_csv(source, [point(i) for i in range(30)])
        index = self.make_index({"generation": source})
        first = index.viewport(
            "generation",
            bbox=(76.0, 27.0, 78.0, 29.0),
            zoom=10,
            max_features=5,
        )
        old_ref = first["aggregates"][0]["cluster_ref"]
        first_page = index.viewport_cluster_members(
            "generation", cluster_ref=old_ref, limit=5
        )
        old_cursor = first_page["next_cursor"]
        self.assertIsNotNone(old_cursor)

        write_csv(source, [point(i) for i in range(35)])
        index.rebuild("generation")
        with self.assertRaises(PoiSearchStaleGenerationError):
            index.viewport_cluster_members(
                "generation", cluster_ref=old_ref, limit=5
            )

        current = index.viewport(
            "generation",
            bbox=(76.0, 27.0, 78.0, 29.0),
            zoom=10,
            max_features=5,
        )
        with self.assertRaises(PoiSearchStaleGenerationError):
            index.viewport_cluster_members(
                "generation",
                cluster_ref=current["aggregates"][0]["cluster_ref"],
                limit=5,
                cursor=old_cursor,
            )

    def test_open_reader_finishes_on_previous_atomic_generation(self) -> None:
        source = self.root / "atomic.csv"
        write_csv(source, [point(i) for i in range(10)])
        index = self.make_index({"atomic": source})
        db_path = index.prepare("atomic")
        old_reader = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            old_generation = old_reader.execute(
                "SELECT value FROM metadata WHERE key='generation'"
            ).fetchone()[0]
            self.assertEqual(
                old_reader.execute("SELECT COUNT(*) FROM pois").fetchone()[0], 10
            )

            write_csv(source, [point(i) for i in range(11)])
            index.rebuild("atomic")
            current = index.viewport(
                "atomic", bbox=(76.0, 27.0, 78.0, 29.0), zoom=22
            )

            self.assertEqual(
                old_reader.execute("SELECT COUNT(*) FROM pois").fetchone()[0], 10
            )
            self.assertEqual(
                old_reader.execute(
                    "SELECT value FROM metadata WHERE key='generation'"
                ).fetchone()[0],
                old_generation,
            )
            self.assertEqual(current["total_matching_pois"], 11)
            self.assertNotEqual(current["generation"], old_generation)
        finally:
            old_reader.close()

    def test_validation_not_ready_and_index_schema(self) -> None:
        source = self.root / "validation.csv"
        write_csv(source, [point(1)])
        index = self.make_index({"valid": source})
        for zoom in (-1, math.nan, math.inf, 22.01):
            with self.subTest(zoom=zoom), self.assertRaises(
                PoiSearchValidationError
            ):
                index.viewport("valid", bbox=(0, 0, 1, 1), zoom=zoom)
        for feature_limit in (0, VIEWPORT_MAX_FEATURES + 1, True):
            with self.subTest(max_features=feature_limit), self.assertRaises(
                PoiSearchValidationError
            ):
                index.viewport(
                    "valid",
                    bbox=(0, 0, 1, 1),
                    zoom=1,
                    max_features=feature_limit,
                )
        with self.assertRaises(PoiSearchValidationError):
            index.viewport("valid", bbox=None, zoom=1)
        with self.assertRaises(PoiSearchNotFoundError):
            index.viewport("missing", bbox=(0, 0, 1, 1), zoom=1)
        with self.assertRaises(PoiSearchValidationError):
            index.viewport_cluster_members(
                "valid", cluster_ref="not-a-reference"
            )
        for invalid_bbox in (
            "170,-10,-170,10",
            "0,-91,1,1",
            "0,0,181,1",
            "0,2,1,1",
            "0,0,1",
        ):
            with self.subTest(bbox=invalid_bbox), self.assertRaises(
                PoiSearchValidationError
            ):
                parse_bbox(invalid_bbox)

        unprepared = self.make_index(
            {"valid": source},
            directory="unprepared",
            allow_implicit_build=False,
        )
        with patch.object(
            unprepared, "_build", side_effect=AssertionError("must not build")
        ):
            with self.assertRaises(PoiSearchNotReadyError):
                unprepared.viewport("valid", bbox=(0, 0, 1, 1), zoom=1)
            with self.assertRaises(PoiSearchNotReadyError):
                unprepared.viewport_cluster_members(
                    "valid", cluster_ref="not-a-reference"
                )

        index.prepare("valid")
        db_path = index._db_path("valid")
        with closing(sqlite3.connect(db_path)) as connection:
            metadata = dict(connection.execute("SELECT key, value FROM metadata"))
            levels = connection.execute(
                "SELECT MIN(level), MAX(level), SUM(poi_count) "
                "FROM spatial_cells WHERE level = 0"
            ).fetchone()
        self.assertEqual(metadata["schema_version"], SCHEMA_VERSION)
        self.assertEqual(metadata["spatial_max_level"], str(SPATIAL_MAX_LEVEL))
        self.assertEqual(levels, (0, 0, 1))

    def test_large_individual_properties_fall_back_to_bounded_aggregation(self) -> None:
        source = self.root / "large-property.geojson"
        source.write_text(
            json.dumps(
                {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "geometry": {
                                "type": "Point",
                                "coordinates": [77.0, 28.0],
                            },
                            "properties": {
                                "name": "large",
                                "extra": "x" * (VIEWPORT_MAX_PAYLOAD_BYTES + 1),
                            },
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        index = PoiSearchIndex(
            {"large": {"poi_geojson_path": str(source)}}, self.root / "indexes"
        )
        response = index.viewport(
            "large", bbox=(76.0, 27.0, 78.0, 29.0), zoom=22
        )
        self.assertEqual(response["mode"], "aggregated")
        self.assertEqual(response["total_matching_pois"], 1)
        self.assertLessEqual(
            response["meta"]["serialized_bytes"], VIEWPORT_MAX_PAYLOAD_BYTES
        )
        self.assertEqual(
            response["meta"]["serialized_bytes"],
            len(
                json.dumps(
                    response, ensure_ascii=False, separators=(",", ":")
                ).encode("utf-8")
            ),
        )
        with self.assertRaises(PoiSearchPayloadTooLargeError):
            index.viewport_cluster_members(
                "large", cluster_ref=response["aggregates"][0]["cluster_ref"]
            )


if __name__ == "__main__":
    unittest.main()
