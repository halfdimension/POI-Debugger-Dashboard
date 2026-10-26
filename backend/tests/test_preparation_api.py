from __future__ import annotations

import csv
import importlib
import sys
import tempfile
from pathlib import Path

import yaml
from fastapi import HTTPException


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


def test_viewport_routes_are_authenticated_bounded_and_available_to_users(
    monkeypatch,
) -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "pois.csv"
        with source.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=("new_node_id", "mappls_poi_id", "name", "lat", "lon"),
            )
            writer.writeheader()
            for index in range(3):
                writer.writerow(
                    {
                        "new_node_id": f"node-{index}",
                        "mappls_poi_id": "duplicate",
                        "name": f"POI {index}",
                        "lat": 28,
                        "lon": 77,
                    }
                )
        config = root / "debugger.yaml"
        config.write_text(
            yaml.safe_dump(
                {
                    "active_dataset": "a",
                    "auth": {
                        "mode": "development",
                        "environment": "development",
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
                }
            ),
            encoding="utf-8",
        )
        monkeypatch.setenv("VPD_CONFIG", str(config))
        sys.modules.pop("backend.app.main", None)
        main = importlib.import_module("backend.app.main")

        try:
            main.viewport_pois(
                None,
                dataset_id="a",
                bbox="76,27,78,29",
                zoom=22,
                max_features=1,
            )
        except HTTPException as not_ready:
            assert not_ready.status_code == 503
            assert not_ready.detail["code"] == "poi_index_not_ready"
        else:
            raise AssertionError("unprepared viewport query unexpectedly succeeded")

        for kwargs in (
            {"dataset_id": None, "bbox": "76,27,78,29", "zoom": 10},
            {"dataset_id": "a", "bbox": "170,-10,-170,10", "zoom": 10},
            {
                "dataset_id": "a",
                "bbox": "76,27,78,29",
                "zoom": 10,
                "max_features": 1001,
            },
        ):
            try:
                main.viewport_pois(None, **kwargs)
            except HTTPException as invalid:
                assert invalid.status_code == 400
            else:
                raise AssertionError("invalid viewport request unexpectedly succeeded")

        main.datasets.search_index.prepare("a")
        body = main.viewport_pois(
            None,
            dataset_id="a",
            bbox="76,27,78,29",
            zoom=22,
            max_features=1,
        )
        assert body["complete"] is True
        assert body["total_matching_pois"] == 3
        assert sum(
            aggregate["source_record_count"] for aggregate in body["aggregates"]
        ) == 3
        assert body["meta"]["feature_count"] <= 1

        member_body = main.viewport_cluster_members(
            None,
            dataset_id="a",
            cluster_ref=body["aggregates"][0]["cluster_ref"],
            limit=2,
        )
        assert member_body["total_matching_pois"] == 3
        assert member_body["returned"] == 2
        assert member_body["has_more"] is True
        assert member_body["next_cursor"]

        main.datasets.search_index.rebuild("a")
        try:
            main.viewport_cluster_members(
                None,
                dataset_id="a",
                cluster_ref=body["aggregates"][0]["cluster_ref"],
            )
        except HTTPException as stale:
            assert stale.status_code == 409
            assert stale.detail["code"] == "poi_index_generation_stale"
        else:
            raise AssertionError("stale cluster reference unexpectedly succeeded")

        for path in (
            "/api/pois/viewport",
            "/api/pois/viewport/cluster-members",
        ):
            route = next(
                route
                for route in main.app.routes
                if getattr(route, "path", None) == path
            )
            dependency_names = {
                getattr(item.call, "__name__", "")
                for item in route.dependant.dependencies
            }
            assert "require_authenticated_request" in dependency_names
            assert "require_super_admin" not in dependency_names
        sys.modules.pop("backend.app.main", None)
