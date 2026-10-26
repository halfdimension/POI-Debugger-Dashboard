from __future__ import annotations

import csv
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.app.datasets import DatasetManager, DatasetTooLargeError
from backend.app.poi_search import PoiSearchError


FIELDS = ("new_node_id", "mappls_poi_id", "name", "landmark_type", "visible", "lat", "lon")


def write_csv(path: Path, count: int = 1) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        for index in range(count):
            writer.writerow({
                "new_node_id": f"node-{index}", "mappls_poi_id": f"poi-{index}",
                "name": f"POI {index}", "landmark_type": "school", "visible": "yes",
                "lat": 28 + index / 1000, "lon": 77 + index / 1000,
            })


def manager(root: Path, *, limit: int = 50_000, missing: bool = False) -> DatasetManager:
    a = root / "a.csv"
    b = root / "b.csv"
    write_csv(a, 3)
    write_csv(b, 1)
    return DatasetManager({
        "active_dataset": "a",
        "backend": {"poi_index_dir": str(root / "indexes"), "legacy_poi_feature_limit": limit},
        "datasets": {
            "a": {"name": "Large A", "poi_csv_path": str(a)},
            "b": {"name": "Small B", "poi_csv_path": str(b)},
            "missing": {"name": "Unavailable", "poi_csv_path": str(root / "missing.csv")},
        } if missing else {
            "a": {"name": "Large A", "poi_csv_path": str(a)},
            "b": {"name": "Small B", "poi_csv_path": str(b)},
        },
    })


def test_selection_and_metadata_do_not_load_or_materialize_pois() -> None:
    with tempfile.TemporaryDirectory() as directory:
        datasets = manager(Path(directory))
        with patch.object(datasets, "_load_csv", side_effect=AssertionError("must not load")):
            selected = datasets.activate("a")
            described = datasets.describe("a")
        assert selected["preparation_state"] == "pending"
        assert described["datasets"][0]["stats"] is None
        assert datasets._cache == {}


def test_other_dataset_metadata_remains_available_during_reload() -> None:
    with tempfile.TemporaryDirectory() as directory:
        datasets = manager(Path(directory))
        started = threading.Event()
        release = threading.Event()
        original = datasets._load_csv

        def controlled(path: Path, cfg: dict):
            started.set()
            assert release.wait(2)
            return original(path, cfg)

        with patch.object(datasets, "_load_csv", side_effect=controlled):
            with ThreadPoolExecutor(max_workers=2) as executor:
                reload_future = executor.submit(datasets.reload, "a")
                assert started.wait(1)
                before = time.monotonic()
                summary = datasets.describe("b")
                elapsed = time.monotonic() - before
                assert elapsed < 0.25
                assert summary["active_dataset"] == "b"
                assert summary["datasets"][0]["preparation_state"] == "preparing"
                release.set()
                assert reload_future.result()["preparation_state"] == "ready"


def test_unavailable_dataset_does_not_block_other_summaries() -> None:
    with tempfile.TemporaryDirectory() as directory:
        datasets = manager(Path(directory), missing=True)
        summary = datasets.describe("b")
        unavailable = next(item for item in summary["datasets"] if item["id"] == "missing")
        assert unavailable["source_exists"] is False
        assert unavailable["preparation_state"] == "pending"
        assert summary["active_dataset"] == "b"


def test_reload_prepares_exact_stats_without_caching_features() -> None:
    with tempfile.TemporaryDirectory() as directory:
        datasets = manager(Path(directory))
        summary = datasets.reload("a")
        assert summary["preparation_state"] == "ready"
        assert summary["stats"]["total_rows"] == 3
        assert summary["stats"]["valid_pois"] == 3
        assert "feature_collection" not in datasets._cache["a"]


def test_small_legacy_response_works_and_large_response_is_bounded() -> None:
    with tempfile.TemporaryDirectory() as directory:
        datasets = manager(Path(directory), limit=2)
        assert len(datasets.get_pois("b")["features"]) == 1
        with pytest.raises(DatasetTooLargeError, match="use /api/pois/search"):
            datasets.get_pois("a")


def test_concurrent_reload_is_coalesced_and_cache_remains_valid() -> None:
    with tempfile.TemporaryDirectory() as directory:
        datasets = manager(Path(directory))
        started = threading.Event()
        release = threading.Event()
        calls = 0
        calls_lock = threading.Lock()
        original = datasets._load_csv

        def controlled(path: Path, cfg: dict):
            nonlocal calls
            with calls_lock:
                calls += 1
            started.set()
            assert release.wait(2)
            return original(path, cfg)

        with patch.object(datasets, "_load_csv", side_effect=controlled):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(datasets.reload, "a")
                assert started.wait(1)
                second = executor.submit(datasets.reload, "a")
                release.set()
                assert first.result()["stats"]["valid_pois"] == 3
                assert second.result()["stats"]["valid_pois"] == 3
        assert calls == 1


def test_failure_releases_dataset_lock_and_preserves_recovery() -> None:
    with tempfile.TemporaryDirectory() as directory:
        datasets = manager(Path(directory))
        with patch.object(datasets, "_load_csv", side_effect=OSError("synthetic failure")):
            assert datasets.reload("a")["preparation_state"] == "error"
        recovered = datasets.reload("a")
        assert recovered["preparation_state"] == "ready"
        assert recovered["stats"]["valid_pois"] == 3


def test_failed_index_rebuild_preserves_previous_database() -> None:
    with tempfile.TemporaryDirectory() as directory:
        datasets = manager(Path(directory))
        datasets.reload("a")
        index_path = datasets.search_index._db_path("a")
        previous = index_path.read_bytes()
        with patch.object(datasets.search_index, "_build", side_effect=PoiSearchError("synthetic index failure")):
            with pytest.raises(PoiSearchError, match="synthetic index failure"):
                datasets.reload("a")
        assert index_path.read_bytes() == previous
        assert datasets.describe("a")["datasets"][0]["preparation_state"] == "error"
