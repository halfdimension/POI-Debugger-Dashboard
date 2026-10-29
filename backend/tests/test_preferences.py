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


def _create_v3_database(path: Path) -> None:
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
                poi_visualization_mode TEXT NOT NULL DEFAULT 'auto',
                show_3d_buildings INTEGER NOT NULL DEFAULT 0,
                imagery_mode TEXT NOT NULL DEFAULT 'standard',
                street_imagery_enabled INTEGER NOT NULL DEFAULT 0,
                street_coverage_enabled INTEGER NOT NULL DEFAULT 0,
                driver_perspective_sync_enabled INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        for user_id, buildings in (("buildings-on", 1), ("buildings-off", 0)):
            connection.execute(
                """
                INSERT INTO user_preferences VALUES (
                    ?, 'example', 'mapmyindia', '2d', 'both', ?,
                    '2026-01-01T00:00:00+00:00', 1, 'auto', ?,
                    'hybrid', 1, 1, 1
                )
                """,
                (user_id, json.dumps({
                    "leftCollapsed": False,
                    "rightCollapsed": False,
                    "analysisCollapsed": True,
                    "activeAnalysisTab": "comparison",
                }), buildings),
            )
        connection.execute("PRAGMA user_version = 3")


def test_fresh_database_uses_schema_version_4_and_buildings_default_on() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "preferences.sqlite3"
        store = UserPreferenceStore(path, ["example"], "example")

        preferences = store.get("new-user")
        assert preferences["show_3d_buildings"] is True
        with sqlite3.connect(path) as connection:
            assert connection.execute("PRAGMA user_version").fetchone()[0] == 4
            columns = {row[1] for row in connection.execute("PRAGMA table_info(user_preferences)")}
            assert columns.isdisjoint({
                "imagery_mode",
                "street_imagery_enabled",
                "street_coverage_enabled",
                "driver_perspective_sync_enabled",
            })


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


def test_schema_version_3_migration_preserves_saved_building_values_and_users() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "preferences.sqlite3"
        _create_v3_database(path)

        store = UserPreferenceStore(path, ["example"], "example")

        assert store.get("buildings-on")["show_3d_buildings"] is True
        assert store.get("buildings-off")["show_3d_buildings"] is False
        with sqlite3.connect(path) as connection:
            assert connection.execute("PRAGMA user_version").fetchone()[0] == 4
            assert connection.execute("SELECT count(*) FROM user_preferences").fetchone()[0] == 2


def test_two_users_keep_independent_dataset_preferences_across_reopen() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "preferences.sqlite3"
        store = UserPreferenceStore(path, ["example", "rohtak_lmg"], "example")
        store.update("stable-user-a", {"selected_dataset_id": "rohtak_lmg"})
        store.update("stable-user-b", {"selected_dataset_id": "example"})
        store.update("stable-user-a", {"show_3d_buildings": True})
        store.update("stable-user-b", {"show_3d_buildings": False})

        reopened = UserPreferenceStore(path, ["example", "rohtak_lmg"], "example")
        assert reopened.get("stable-user-a")["selected_dataset_id"] == "rohtak_lmg"
        assert reopened.get("stable-user-b")["selected_dataset_id"] == "example"
        assert reopened.get("stable-user-a")["show_3d_buildings"] is True
        assert reopened.get("stable-user-b")["show_3d_buildings"] is False


def test_reopening_migrated_database_is_idempotent() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "preferences.sqlite3"
        _create_v2_database(path)
        migrated = UserPreferenceStore(path, ["example", "rohtak_lmg"], "example")
        migrated.update("stable-user", {"show_3d_buildings": True})

        reopened = UserPreferenceStore(path, ["example", "rohtak_lmg"], "example")
        assert reopened.get("stable-user")["show_3d_buildings"] is True
        with sqlite3.connect(path) as connection:
            assert connection.execute("PRAGMA user_version").fetchone()[0] == 4


def test_partial_update_preserves_building_preference() -> None:
    with tempfile.TemporaryDirectory() as directory:
        store = UserPreferenceStore(Path(directory) / "preferences.sqlite3", ["example"], "example")
        store.update("stable-user", {"show_3d_buildings": False})

        result = store.update("stable-user", {"route_view": "osrm"})

        assert result["show_3d_buildings"] is False


@pytest.mark.parametrize("value", [0, 1, "true", None])
def test_building_preference_rejects_non_booleans(value: object) -> None:
    with tempfile.TemporaryDirectory() as directory:
        store = UserPreferenceStore(Path(directory) / "preferences.sqlite3", ["example"], "example")
        with pytest.raises(PreferenceValidationError, match="show_3d_buildings must be a boolean"):
            store.update("stable-user", {"show_3d_buildings": value})


@pytest.mark.parametrize("field", [
    "imagery_mode",
    "street_imagery_enabled",
    "street_coverage_enabled",
    "driver_perspective_sync_enabled",
])
def test_removed_imagery_preferences_are_rejected(field: str) -> None:
    with tempfile.TemporaryDirectory() as directory:
        store = UserPreferenceStore(Path(directory) / "preferences.sqlite3", ["example"], "example")
        with pytest.raises(PreferenceValidationError, match=f"Unknown preference fields: {field}"):
            store.update("stable-user", {field: True})


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
