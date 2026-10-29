from __future__ import annotations

import json
import sqlite3
import tempfile
from pathlib import Path

import pytest

from backend.app.preferences import PreferenceValidationError, UserPreferenceStore


def _create_v2_database(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            CREATE TABLE user_preferences (
                user_id TEXT PRIMARY KEY NOT NULL,
                selected_dataset_id TEXT NOT NULL,
                preferred_basemap TEXT NOT NULL,
                map_display_mode TEXT NOT NULL,
                route_view TEXT NOT NULL,
                layout_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                show_pois_on_map INTEGER NOT NULL DEFAULT 1,
                poi_visualization_mode TEXT NOT NULL DEFAULT 'auto'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO user_preferences (
                user_id, selected_dataset_id, preferred_basemap, map_display_mode,
                route_view, layout_json, updated_at, show_pois_on_map,
                poi_visualization_mode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "stable-user",
                "rohtak_lmg",
                "openfreemap",
                "3d",
                "osrm",
                json.dumps({
                    "leftCollapsed": True,
                    "rightCollapsed": False,
                    "analysisCollapsed": False,
                    "activeAnalysisTab": "raw",
                }),
                "2026-01-01T00:00:00+00:00",
                0,
                "clusters",
            ),
        )
        connection.execute("PRAGMA user_version = 2")


def test_fresh_database_uses_schema_version_3_and_geo_defaults() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "preferences.sqlite3"
        store = UserPreferenceStore(path, ["example"], "example")

        preferences = store.get("new-user")
        assert preferences["show_3d_buildings"] is False
        assert preferences["imagery_mode"] == "standard"
        assert preferences["street_imagery_enabled"] is False
        assert preferences["street_coverage_enabled"] is False
        assert preferences["driver_perspective_sync_enabled"] is False
        with sqlite3.connect(path) as connection:
            assert connection.execute("PRAGMA user_version").fetchone()[0] == 3


def test_schema_version_2_migration_preserves_existing_preferences() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "preferences.sqlite3"
        _create_v2_database(path)

        store = UserPreferenceStore(path, ["example", "rohtak_lmg"], "example")
        preferences = store.get("stable-user")

        assert preferences["selected_dataset_id"] == "rohtak_lmg"
        assert preferences["preferred_basemap"] == "openfreemap"
        assert preferences["map_display_mode"] == "3d"
        assert preferences["route_view"] == "osrm"
        assert preferences["show_pois_on_map"] is False
        assert preferences["poi_visualization_mode"] == "clusters"
        assert preferences["layout"]["activeAnalysisTab"] == "raw"
        assert preferences["show_3d_buildings"] is False
        assert preferences["imagery_mode"] == "standard"
        assert preferences["street_imagery_enabled"] is False
        assert preferences["street_coverage_enabled"] is False
        assert preferences["driver_perspective_sync_enabled"] is False


def test_two_users_keep_independent_dataset_preferences_across_reopen() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "preferences.sqlite3"
        store = UserPreferenceStore(path, ["example", "rohtak_lmg"], "example")
        store.update("stable-user-a", {"selected_dataset_id": "rohtak_lmg"})
        store.update("stable-user-b", {"selected_dataset_id": "example"})
        store.update("stable-user-a", {"imagery_mode": "hybrid", "show_3d_buildings": True})
        store.update("stable-user-b", {"street_coverage_enabled": True})

        reopened = UserPreferenceStore(path, ["example", "rohtak_lmg"], "example")
        assert reopened.get("stable-user-a")["selected_dataset_id"] == "rohtak_lmg"
        assert reopened.get("stable-user-b")["selected_dataset_id"] == "example"
        assert reopened.get("stable-user-a")["imagery_mode"] == "hybrid"
        assert reopened.get("stable-user-a")["show_3d_buildings"] is True
        assert reopened.get("stable-user-a")["street_coverage_enabled"] is False
        assert reopened.get("stable-user-b")["imagery_mode"] == "standard"
        assert reopened.get("stable-user-b")["show_3d_buildings"] is False
        assert reopened.get("stable-user-b")["street_coverage_enabled"] is True


def test_reopening_migrated_database_is_idempotent() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "preferences.sqlite3"
        _create_v2_database(path)
        migrated = UserPreferenceStore(path, ["example", "rohtak_lmg"], "example")
        migrated.update("stable-user", {"street_imagery_enabled": True})

        reopened = UserPreferenceStore(path, ["example", "rohtak_lmg"], "example")
        assert reopened.get("stable-user")["street_imagery_enabled"] is True
        with sqlite3.connect(path) as connection:
            assert connection.execute("PRAGMA user_version").fetchone()[0] == 3


def test_partial_update_preserves_other_geo_preferences() -> None:
    with tempfile.TemporaryDirectory() as directory:
        store = UserPreferenceStore(Path(directory) / "preferences.sqlite3", ["example"], "example")
        store.update("stable-user", {
            "show_3d_buildings": True,
            "street_imagery_enabled": True,
            "street_coverage_enabled": True,
            "driver_perspective_sync_enabled": True,
        })

        result = store.update("stable-user", {"imagery_mode": "satellite"})

        assert result["imagery_mode"] == "satellite"
        assert result["show_3d_buildings"] is True
        assert result["street_imagery_enabled"] is True
        assert result["street_coverage_enabled"] is True
        assert result["driver_perspective_sync_enabled"] is True


@pytest.mark.parametrize("field", [
    "show_3d_buildings",
    "street_imagery_enabled",
    "street_coverage_enabled",
    "driver_perspective_sync_enabled",
])
@pytest.mark.parametrize("value", [0, 1, "true", None])
def test_geo_boolean_preferences_reject_non_booleans(field: str, value: object) -> None:
    with tempfile.TemporaryDirectory() as directory:
        store = UserPreferenceStore(Path(directory) / "preferences.sqlite3", ["example"], "example")
        with pytest.raises(PreferenceValidationError, match=f"{field} must be a boolean"):
            store.update("stable-user", {field: value})


@pytest.mark.parametrize("value", ["Standard", "terrain", "", 1, None, [], {}])
def test_imagery_mode_rejects_unsupported_values(value: object) -> None:
    with tempfile.TemporaryDirectory() as directory:
        store = UserPreferenceStore(Path(directory) / "preferences.sqlite3", ["example"], "example")
        with pytest.raises(PreferenceValidationError, match="imagery_mode is invalid"):
            store.update("stable-user", {"imagery_mode": value})


def test_user_identity_cannot_be_supplied_as_a_preference_field() -> None:
    with tempfile.TemporaryDirectory() as directory:
        store = UserPreferenceStore(Path(directory) / "preferences.sqlite3", ["example"], "example")
        with pytest.raises(PreferenceValidationError, match="Unknown preference fields: user_id"):
            store.update("stable-user-a", {"user_id": "stable-user-b"})
        with pytest.raises(PreferenceValidationError, match="Unknown dataset"):
            store.update("stable-user-a", {"selected_dataset_id": "missing"})


def test_removed_dataset_falls_back_and_repairs_persisted_selection() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "preferences.sqlite3"
        original = UserPreferenceStore(path, ["example", "removed"], "example")
        original.update("stable-user", {"selected_dataset_id": "removed"})

        changed = UserPreferenceStore(path, ["example"], "example")
        result = changed.get("stable-user")
        assert result["selected_dataset_id"] == "example"
        assert result["dataset_selection_fallback"] is True
        assert result["unavailable_dataset_id"] == "removed"
        assert changed.get("stable-user")["dataset_selection_fallback"] is False
