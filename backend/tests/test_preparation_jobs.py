from __future__ import annotations

import csv
import tempfile
import time
import yaml
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.app.datasets import DatasetManager
from backend.app.poi_search import PoiSearchNotReadyError
from backend.app.preparation_jobs import (
    PreparationCapacityError,
    PreparationJobManager,
)


def settings(root: Path) -> dict:
    source_a = root / "a.csv"
    source_b = root / "b.csv"
    for path in (source_a, source_b):
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=("name", "lat", "lon"))
            writer.writeheader()
            writer.writerow({"name": path.stem, "lat": 28, "lon": 77})
    config = root / "debugger.yaml"
    config.write_text("project: {name: test}\n", encoding="utf-8")
    return {
        "_config_path": str(config),
        "active_dataset": "a",
        "backend": {
            "poi_index_dir": str(root / "indexes"),
            "preparation_job_dir": str(root / "jobs"),
        },
        "datasets": {
            "a": {"poi_csv_path": str(source_a)},
            "b": {"poi_csv_path": str(source_b)},
        },
    }


def test_submission_is_prompt_and_duplicate_requests_are_coalesced() -> None:
    with tempfile.TemporaryDirectory() as directory:
        cfg = settings(Path(directory))
        jobs = PreparationJobManager(cfg, ("a", "b"), launcher=lambda *_: 4242)
        with patch.object(jobs, "_worker_alive", return_value=True):
            before = time.monotonic()
            first, accepted = jobs.submit("a", "super-admin")
            elapsed = time.monotonic() - before
            duplicate, duplicate_accepted = jobs.submit("a", "another-admin")
        assert elapsed < 0.25
        assert accepted is True
        assert duplicate_accepted is False
        assert duplicate["id"] == first["id"]
        assert first["status"] == "pending"


def test_global_capacity_bounds_concurrent_dataset_jobs() -> None:
    with tempfile.TemporaryDirectory() as directory:
        cfg = settings(Path(directory))
        jobs = PreparationJobManager(cfg, ("a", "b"), launcher=lambda *_: 4242)
        with patch.object(jobs, "_worker_alive", return_value=True):
            jobs.submit("a", "super-admin")
            with pytest.raises(PreparationCapacityError):
                jobs.submit("b", "super-admin")


def test_status_transitions_and_public_response_are_sanitized() -> None:
    with tempfile.TemporaryDirectory() as directory:
        cfg = settings(Path(directory))
        jobs = PreparationJobManager(cfg, ("a",), launcher=lambda *_: 4242)
        with patch.object(jobs, "_worker_alive", return_value=True):
            pending, _ = jobs.submit("a", "sensitive-user-id")
            jobs.worker_update(pending["id"], status="running", started_at=jobs._now())
            running = jobs.get(pending["id"])
            jobs.worker_update(
                pending["id"], status="completed", finished_at=jobs._now(),
                stats={"total_rows": 1, "valid_pois": 1},
            )
            completed = jobs.get(pending["id"])
        assert running["status"] == "running"
        assert completed["status"] == "completed"
        assert completed["stats"]["valid_pois"] == 1
        assert "pid" not in completed
        assert "requested_by" not in completed
        assert str(Path(directory)) not in str(completed)


def test_worker_crash_releases_reservation_for_retry() -> None:
    with tempfile.TemporaryDirectory() as directory:
        cfg = settings(Path(directory))
        jobs = PreparationJobManager(cfg, ("a",), launcher=lambda *_: 4242)
        with patch.object(jobs, "_worker_alive", return_value=True):
            first, _ = jobs.submit("a", "super-admin")
            jobs.worker_update(first["id"], status="running", started_at=jobs._now())
        with patch.object(jobs, "_worker_alive", return_value=False):
            failed = jobs.get(first["id"])
        assert failed["status"] == "failed"
        assert failed["error"] == "Preparation worker stopped unexpectedly."
        with patch.object(jobs, "_worker_alive", return_value=True):
            retry, accepted = jobs.submit("a", "super-admin")
        assert accepted is True
        assert retry["id"] != first["id"]


def test_unprepared_search_does_not_invoke_index_builder() -> None:
    with tempfile.TemporaryDirectory() as directory:
        cfg = settings(Path(directory))
        datasets = DatasetManager(cfg)
        with patch.object(datasets.search_index, "_build", side_effect=AssertionError("must not build")):
            with pytest.raises(PoiSearchNotReadyError):
                datasets.search_index.search("a")


def test_dashboard_metadata_stays_available_while_job_runs() -> None:
    with tempfile.TemporaryDirectory() as directory:
        cfg = settings(Path(directory))
        datasets = DatasetManager(cfg)
        jobs = PreparationJobManager(cfg, datasets.ids, launcher=lambda *_: 4242)
        with patch.object(jobs, "_worker_alive", return_value=True):
            job, _ = jobs.submit("a", "super-admin")
            jobs.worker_update(job["id"], status="running", started_at=jobs._now())
            before = time.monotonic()
            registry = jobs.decorate_registry(datasets.describe("b"))
            elapsed = time.monotonic() - before
        assert elapsed < 0.25
        assert registry["active_dataset"] == "b"
        assert registry["datasets"][0]["preparation_state"] == "preparing"


def test_real_worker_process_completes_small_preparation() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        cfg = settings(root)
        Path(cfg["_config_path"]).write_text(yaml.safe_dump({
            "active_dataset": "a",
            "backend": {
                "poi_index_dir": cfg["backend"]["poi_index_dir"],
                "preparation_job_dir": cfg["backend"]["preparation_job_dir"],
            },
            "datasets": cfg["datasets"],
        }), encoding="utf-8")
        jobs = PreparationJobManager(cfg, ("a", "b"))
        job, accepted = jobs.submit("a", "super-admin")
        assert accepted is True
        deadline = time.monotonic() + 10
        current = job
        while current["status"] in {"pending", "running"} and time.monotonic() < deadline:
            time.sleep(0.05)
            current = jobs.get(job["id"])
        assert current["status"] == "completed"
        assert current["stats"]["valid_pois"] == 1
        assert (root / "indexes").is_dir()
