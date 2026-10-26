from __future__ import annotations

import csv
import importlib
import sys
import tempfile
from pathlib import Path

import yaml


def test_reload_route_is_202_and_enforces_super_admin_dependency(monkeypatch) -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "pois.csv"
        with source.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=("name", "lat", "lon"))
            writer.writeheader()
            writer.writerow({"name": "one", "lat": 28, "lon": 77})
        config = root / "debugger.yaml"
        config.write_text(yaml.safe_dump({
            "active_dataset": "a",
            "auth": {
                "mode": "development", "environment": "development",
                "session_secret": "test-secret-that-is-long-enough-for-sessions",
            },
            "backend": {
                "poi_index_dir": str(root / "indexes"),
                "preparation_job_dir": str(root / "jobs"),
                "preference_db_path": str(root / "preferences.sqlite3"),
                "testcase_db_path": str(root / "testcases.sqlite3"),
            },
            "datasets": {"a": {"poi_csv_path": str(source)}},
            "scenarios": {"directory": str(root / "scenarios")},
            "valhalla": {"service_url": "http://127.0.0.1:8002"},
            "osrm": {"service_url": "http://127.0.0.1:8001"},
        }), encoding="utf-8")
        monkeypatch.setenv("VPD_CONFIG", str(config))
        sys.modules.pop("backend.app.main", None)
        main = importlib.import_module("backend.app.main")
        route = next(
            route for route in main.app.routes
            if getattr(route, "path", None) == "/api/datasets/{dataset_id}/reload-pois"
        )
        dependency_names = {
            getattr(item.call, "__name__", "") for item in route.dependant.dependencies
        }
        assert route.status_code == 202
        assert "require_super_admin" in dependency_names
