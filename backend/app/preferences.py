from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


class PreferenceValidationError(ValueError):
    pass


DEFAULT_LAYOUT = {
    "leftCollapsed": False,
    "rightCollapsed": False,
    "analysisCollapsed": True,
    "activeAnalysisTab": "comparison",
}
ALLOWED_FIELDS = {
    "selected_dataset_id",
    "preferred_basemap",
    "map_display_mode",
    "route_view",
    "layout",
    "show_pois_on_map",
    "poi_visualization_mode",
    "show_3d_buildings",
    "imagery_mode",
    "street_imagery_enabled",
    "street_coverage_enabled",
    "driver_perspective_sync_enabled",
}
BASEMAPS = {"mapmyindia", "openfreemap"}
MAP_DISPLAY_MODES = {"2d", "3d"}
ROUTE_VIEWS = {"both", "valhalla", "osrm"}
ANALYSIS_TABS = {"comparison", "maneuvers", "candidates", "scenarios", "raw"}
POI_VISUALIZATION_MODES = {"auto", "density", "clusters", "points"}
IMAGERY_MODES = {"standard", "satellite", "hybrid"}


class UserPreferenceStore:
    """Small SQLite store keyed only by the authenticated stable user ID."""

    def __init__(self, path: str | Path, dataset_ids: Iterable[str], default_dataset_id: str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._dataset_ids = frozenset(dataset_ids)
        self._default_dataset_id = default_dataset_id
        self._schema_lock = threading.Lock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 10000")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        return connection

    def _initialize(self) -> None:
        with self._schema_lock, self._connect() as connection:
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if version > 3:
                raise RuntimeError(f"Preference database schema {version} is newer than this application supports")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS user_preferences (
                    user_id TEXT PRIMARY KEY NOT NULL,
                    selected_dataset_id TEXT NOT NULL,
                    preferred_basemap TEXT NOT NULL,
                    map_display_mode TEXT NOT NULL,
                    route_view TEXT NOT NULL,
                    layout_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            if version < 1:
                connection.execute("PRAGMA user_version = 1")
            if version < 2:
                columns = {
                    str(row[1])
                    for row in connection.execute("PRAGMA table_info(user_preferences)")
                }
                if "show_pois_on_map" not in columns:
                    connection.execute(
                        "ALTER TABLE user_preferences ADD COLUMN show_pois_on_map INTEGER NOT NULL DEFAULT 1"
                    )
                if "poi_visualization_mode" not in columns:
                    connection.execute(
                        "ALTER TABLE user_preferences ADD COLUMN poi_visualization_mode TEXT NOT NULL DEFAULT 'auto'"
                    )
                connection.execute("PRAGMA user_version = 2")
            if version < 3:
                columns = {
                    str(row[1])
                    for row in connection.execute("PRAGMA table_info(user_preferences)")
                }
                additions = {
                    "show_3d_buildings": "INTEGER NOT NULL DEFAULT 0",
                    "imagery_mode": "TEXT NOT NULL DEFAULT 'standard'",
                    "street_imagery_enabled": "INTEGER NOT NULL DEFAULT 0",
                    "street_coverage_enabled": "INTEGER NOT NULL DEFAULT 0",
                    "driver_perspective_sync_enabled": "INTEGER NOT NULL DEFAULT 0",
                }
                for name, definition in additions.items():
                    if name not in columns:
                        connection.execute(
                            f"ALTER TABLE user_preferences ADD COLUMN {name} {definition}"
                        )
                # Version 3 databases cannot be opened by the version 2 application;
                # no downgrade migration is supported.
                connection.execute("PRAGMA user_version = 3")

    def _defaults(self) -> dict[str, Any]:
        return {
            "selected_dataset_id": self._default_dataset_id,
            "preferred_basemap": "mapmyindia",
            "map_display_mode": "2d",
            "route_view": "both",
            "layout": dict(DEFAULT_LAYOUT),
            "show_pois_on_map": True,
            "poi_visualization_mode": "auto",
            "show_3d_buildings": False,
            "imagery_mode": "standard",
            "street_imagery_enabled": False,
            "street_coverage_enabled": False,
            "driver_perspective_sync_enabled": False,
        }

    @staticmethod
    def _validate_layout(value: Any) -> dict[str, Any]:
        if not isinstance(value, dict) or set(value) != set(DEFAULT_LAYOUT):
            raise PreferenceValidationError("layout must contain only the supported dashboard layout fields")
        if any(not isinstance(value[key], bool) for key in ("leftCollapsed", "rightCollapsed", "analysisCollapsed")):
            raise PreferenceValidationError("layout collapsed fields must be booleans")
        if value["activeAnalysisTab"] not in ANALYSIS_TABS:
            raise PreferenceValidationError("layout activeAnalysisTab is invalid")
        return dict(value)

    def _validate_patch(self, patch: Any) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise PreferenceValidationError("Preference update must be a JSON object")
        unknown = sorted(set(patch) - ALLOWED_FIELDS)
        if unknown:
            raise PreferenceValidationError(f"Unknown preference fields: {', '.join(unknown)}")
        result = dict(patch)
        if "selected_dataset_id" in result and result["selected_dataset_id"] not in self._dataset_ids:
            raise PreferenceValidationError(f"Unknown dataset: {result['selected_dataset_id']}")
        if "preferred_basemap" in result and result["preferred_basemap"] not in BASEMAPS:
            raise PreferenceValidationError("preferred_basemap is invalid")
        if "map_display_mode" in result and result["map_display_mode"] not in MAP_DISPLAY_MODES:
            raise PreferenceValidationError("map_display_mode is invalid")
        if "route_view" in result and result["route_view"] not in ROUTE_VIEWS:
            raise PreferenceValidationError("route_view is invalid")
        if "show_pois_on_map" in result and not isinstance(result["show_pois_on_map"], bool):
            raise PreferenceValidationError("show_pois_on_map must be a boolean")
        if "poi_visualization_mode" in result and result["poi_visualization_mode"] not in POI_VISUALIZATION_MODES:
            raise PreferenceValidationError("poi_visualization_mode is invalid")
        for field in (
            "show_3d_buildings",
            "street_imagery_enabled",
            "street_coverage_enabled",
            "driver_perspective_sync_enabled",
        ):
            if field in result and not isinstance(result[field], bool):
                raise PreferenceValidationError(f"{field} must be a boolean")
        if "imagery_mode" in result:
            imagery_mode = result["imagery_mode"]
            if not isinstance(imagery_mode, str) or imagery_mode not in IMAGERY_MODES:
                raise PreferenceValidationError("imagery_mode is invalid")
        if "layout" in result:
            result["layout"] = self._validate_layout(result["layout"])
        return result

    def get(self, user_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM user_preferences WHERE user_id = ?", (user_id,)
            ).fetchone()
        values = self._defaults()
        fallback_from: str | None = None
        if row is not None:
            values.update({
                "selected_dataset_id": row["selected_dataset_id"],
                "preferred_basemap": row["preferred_basemap"],
                "map_display_mode": row["map_display_mode"],
                "route_view": row["route_view"],
                "layout": json.loads(row["layout_json"]),
                "show_pois_on_map": bool(row["show_pois_on_map"]),
                "poi_visualization_mode": row["poi_visualization_mode"],
                "show_3d_buildings": bool(row["show_3d_buildings"]),
                "imagery_mode": row["imagery_mode"],
                "street_imagery_enabled": bool(row["street_imagery_enabled"]),
                "street_coverage_enabled": bool(row["street_coverage_enabled"]),
                "driver_perspective_sync_enabled": bool(row["driver_perspective_sync_enabled"]),
            })
        if values["selected_dataset_id"] not in self._dataset_ids:
            fallback_from = values["selected_dataset_id"]
            values["selected_dataset_id"] = self._default_dataset_id
            self._write(user_id, values)
        return {
            **values,
            "dataset_selection_fallback": fallback_from is not None,
            "unavailable_dataset_id": fallback_from,
        }

    def update(self, user_id: str, patch: Any) -> dict[str, Any]:
        validated = self._validate_patch(patch)
        with self._connect() as connection:
            # Serialize read/merge/write across processes so two concurrent
            # partial PATCH requests cannot overwrite each other's fields.
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM user_preferences WHERE user_id = ?", (user_id,)
            ).fetchone()
            values = self._defaults()
            if row is not None:
                values.update({
                    "selected_dataset_id": row["selected_dataset_id"],
                    "preferred_basemap": row["preferred_basemap"],
                    "map_display_mode": row["map_display_mode"],
                    "route_view": row["route_view"],
                    "layout": json.loads(row["layout_json"]),
                    "show_pois_on_map": bool(row["show_pois_on_map"]),
                    "poi_visualization_mode": row["poi_visualization_mode"],
                    "show_3d_buildings": bool(row["show_3d_buildings"]),
                    "imagery_mode": row["imagery_mode"],
                    "street_imagery_enabled": bool(row["street_imagery_enabled"]),
                    "street_coverage_enabled": bool(row["street_coverage_enabled"]),
                    "driver_perspective_sync_enabled": bool(row["driver_perspective_sync_enabled"]),
                })
            if values["selected_dataset_id"] not in self._dataset_ids:
                values["selected_dataset_id"] = self._default_dataset_id
            values.update(validated)
            self._write_on_connection(connection, user_id, values)
        return {**values, "dataset_selection_fallback": False, "unavailable_dataset_id": None}

    def _write(self, user_id: str, values: dict[str, Any]) -> None:
        with self._connect() as connection:
            self._write_on_connection(connection, user_id, values)

    @staticmethod
    def _write_on_connection(
        connection: sqlite3.Connection, user_id: str, values: dict[str, Any]
    ) -> None:
        connection.execute(
            """
                INSERT INTO user_preferences (
                    user_id, selected_dataset_id, preferred_basemap,
                    map_display_mode, route_view, layout_json,
                    show_pois_on_map, poi_visualization_mode,
                    show_3d_buildings, imagery_mode, street_imagery_enabled,
                    street_coverage_enabled, driver_perspective_sync_enabled,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    selected_dataset_id = excluded.selected_dataset_id,
                    preferred_basemap = excluded.preferred_basemap,
                    map_display_mode = excluded.map_display_mode,
                    route_view = excluded.route_view,
                    layout_json = excluded.layout_json,
                    show_pois_on_map = excluded.show_pois_on_map,
                    poi_visualization_mode = excluded.poi_visualization_mode,
                    show_3d_buildings = excluded.show_3d_buildings,
                    imagery_mode = excluded.imagery_mode,
                    street_imagery_enabled = excluded.street_imagery_enabled,
                    street_coverage_enabled = excluded.street_coverage_enabled,
                    driver_perspective_sync_enabled = excluded.driver_perspective_sync_enabled,
                    updated_at = excluded.updated_at
            """,
            (
                user_id,
                values["selected_dataset_id"],
                values["preferred_basemap"],
                values["map_display_mode"],
                values["route_view"],
                json.dumps(values["layout"], separators=(",", ":"), sort_keys=True),
                int(values["show_pois_on_map"]),
                values["poi_visualization_mode"],
                int(values["show_3d_buildings"]),
                values["imagery_mode"],
                int(values["street_imagery_enabled"]),
                int(values["street_coverage_enabled"]),
                int(values["driver_perspective_sync_enabled"]),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
