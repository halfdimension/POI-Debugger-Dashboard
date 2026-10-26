from __future__ import annotations

import csv
import json
import sqlite3
import threading
import tempfile
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .poi_search import PoiSearchError, PoiSearchIndex, priority_policy


FALSE_VALUES = {"0", "false", "no", "n", "off"}
LAT_CANDIDATES = ("lat", "latitude", "y")
LON_CANDIDATES = ("lon", "lng", "longitude", "x")


class DatasetError(RuntimeError):
    pass


class DatasetTooLargeError(DatasetError):
    pass


class DatasetManager:
    """Runtime POI dataset registry for the local debugger.

    Phase 2A intentionally manages only debugger-side source data. Activating a
    dataset does not restart Valhalla and does not swap the tile set used by the
    already-running Valhalla service.
    """

    def __init__(self, settings: dict[str, Any]):
        self._settings = settings
        self._datasets = self._build_registry(settings)
        if not self._datasets:
            raise DatasetError("No debugger dataset is configured")

        requested = str(settings.get("active_dataset") or "").strip()
        self._default_id = requested if requested in self._datasets else next(iter(self._datasets))
        self._cache_lock = threading.Lock()
        self._dataset_locks = {
            dataset_id: threading.Lock() for dataset_id in self._datasets
        }
        self._reload_locks = {
            dataset_id: threading.Lock() for dataset_id in self._datasets
        }
        self._cache: dict[str, dict[str, Any]] = {}
        self._legacy_poi_limit = int(
            settings.get("backend", {}).get("legacy_poi_feature_limit", 50_000)
        )
        if self._legacy_poi_limit < 1:
            raise DatasetError("backend.legacy_poi_feature_limit must be positive")
        self._legacy_geojson_byte_limit = int(
            settings.get("backend", {}).get("legacy_poi_geojson_byte_limit", 64 * 1024 * 1024)
        )
        if self._legacy_geojson_byte_limit < 1:
            raise DatasetError("backend.legacy_poi_geojson_byte_limit must be positive")
        index_dir = Path(
            str(
                settings.get("backend", {}).get("poi_index_dir")
                or Path(__file__).resolve().parents[2] / ".cache" / "poi-search"
            )
        )
        self.search_index = PoiSearchIndex(self._datasets, index_dir)

    @staticmethod
    def _build_registry(settings: dict[str, Any]) -> dict[str, dict[str, Any]]:
        configured = settings.get("datasets")
        if isinstance(configured, dict) and configured:
            result: dict[str, dict[str, Any]] = {}
            for dataset_id, raw in configured.items():
                if not isinstance(raw, dict):
                    continue
                dataset = deepcopy(raw)
                dataset["id"] = str(dataset_id)
                dataset.setdefault("name", str(dataset_id))
                result[str(dataset_id)] = dataset
            if result:
                return result

        # Backward compatibility with the Phase 1/1.5 single-data configuration.
        legacy = deepcopy(settings.get("data", {}))
        legacy["id"] = "default"
        legacy["name"] = "Default dataset"
        return {"default": legacy}

    @property
    def active_id(self) -> str:
        """Deployment default retained for compatibility; it is never user-mutated."""
        return self._default_id

    @property
    def default_id(self) -> str:
        return self._default_id

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(self._datasets)

    def has(self, dataset_id: str) -> bool:
        return dataset_id in self._datasets

    def config(self, dataset_id: str) -> dict[str, Any]:
        if dataset_id not in self._datasets:
            raise DatasetError(f"Unknown dataset: {dataset_id}")
        return deepcopy(self._datasets[dataset_id])

    def active_config(self) -> dict[str, Any]:
        return self.config(self._default_id)

    def activate(self, dataset_id: str) -> dict[str, Any]:
        """Validate a selection without preparing or materializing its POIs."""
        if dataset_id not in self._datasets:
            raise DatasetError(f"Unknown dataset: {dataset_id}")
        return self._summary(dataset_id)

    def get_pois(self, dataset_id: str) -> dict[str, Any]:
        """Compatibility API for small sources; large sources must use search."""
        if dataset_id not in self._datasets:
            raise DatasetError(f"Unknown dataset: {dataset_id}")
        with self._dataset_locks[dataset_id]:
            cfg = self._datasets[dataset_id]
            csv_path = Path(str(cfg["poi_csv_path"])) if cfg.get("poi_csv_path") else None
            geojson_path = Path(str(cfg["poi_geojson_path"])) if cfg.get("poi_geojson_path") else None
            if csv_path and csv_path.exists():
                return self._load_csv_features(csv_path, cfg)
            if geojson_path and geojson_path.exists():
                return self._load_geojson_features(geojson_path)
            raise DatasetError("The configured POI source is unavailable")

    def reload(self, dataset_id: str | None = None) -> dict[str, Any]:
        target = dataset_id or self._default_id
        if target not in self._datasets:
            raise DatasetError(f"Unknown dataset: {target}")
        reload_lock = self._reload_locks[target]
        if not reload_lock.acquire(blocking=False):
            # Share the result of an in-flight explicit reload instead of
            # repeating both the statistics scan and index construction.
            with reload_lock:
                return self._summary(target)
        try:
            loaded = self._load(target, force=True)
            if loaded.get("error") is not None:
                return self._summary(target)
            try:
                # PoiSearchIndex builds into a temporary file and atomically
                # replaces the prior generation only after a successful build.
                self.search_index.rebuild(target)
            except PoiSearchError as exc:
                with self._cache_lock:
                    self._cache[target]["preparation_state"] = "error"
                    self._cache[target]["error"] = str(exc)
                raise
            return self._summary(target)
        finally:
            reload_lock.release()

    def describe(self, selected_dataset_id: str | None = None) -> dict[str, Any]:
        selected = selected_dataset_id or self._default_id
        if selected not in self._datasets:
            raise DatasetError(f"Unknown dataset: {selected}")
        return {
            "active_dataset": selected,
            "datasets": [self._summary(dataset_id) for dataset_id in self._datasets],
        }

    def _summary(self, dataset_id: str) -> dict[str, Any]:
        cfg = self._datasets[dataset_id]
        with self._cache_lock:
            cached = deepcopy(self._cache.get(dataset_id))
        source_kind, source_path, source_exists = self._source_metadata(cfg)
        summary = {
            "id": dataset_id,
            "name": cfg.get("name", dataset_id),
            "priority": priority_policy(cfg),
            "map_bounds": deepcopy(cfg.get("map_bounds")),
            "pbf_path": cfg.get("pbf_path"),
            "poi_csv_path": cfg.get("poi_csv_path"),
            "poi_geojson_path": cfg.get("poi_geojson_path"),
            "tiles_path": cfg.get("tiles_path"),
            "valhalla_config_path": cfg.get("valhalla_config_path"),
            "valhalla_association_debug_jsonl_path": cfg.get(
                "valhalla_association_debug_jsonl_path"
            ),
            "osrm_landmark_debug_jsonl_path": cfg.get(
                "osrm_landmark_debug_jsonl_path"
            ),
            "source_kind": cached.get("source_kind") if cached else source_kind,
            "source_path": cached.get("source_path") if cached else source_path,
            "source_exists": cached.get("source_exists") if cached else source_exists,
            "loaded_at": cached.get("loaded_at") if cached else None,
            "stats": deepcopy(cached.get("stats")) if cached else None,
            "error": cached.get("error") if cached else None,
            "preparation_state": cached.get("preparation_state") if cached else "pending",
        }
        return summary

    @staticmethod
    def _source_metadata(cfg: dict[str, Any]) -> tuple[str | None, str | None, bool]:
        csv_path = Path(str(cfg["poi_csv_path"])) if cfg.get("poi_csv_path") else None
        geojson_path = Path(str(cfg["poi_geojson_path"])) if cfg.get("poi_geojson_path") else None
        if csv_path and csv_path.exists():
            return "csv", str(csv_path), True
        if geojson_path and geojson_path.exists():
            return "geojson", str(geojson_path), True
        configured = csv_path or geojson_path
        return (
            "empty" if configured is None else "error",
            str(configured) if configured else None,
            False,
        )

    def _load(self, dataset_id: str, force: bool) -> dict[str, Any]:
        with self._cache_lock:
            cached = self._cache.get(dataset_id)
            if not force and cached is not None:
                return deepcopy(cached)
            preparing = bool(cached and cached.get("preparation_state") == "preparing")
        if preparing:
            # A concurrent request for the same dataset owns the expensive
            # preparation. Wait for it and reuse its result instead of scanning
            # the source a second time.
            with self._dataset_locks[dataset_id]:
                pass
            with self._cache_lock:
                return deepcopy(self._cache[dataset_id])
        with self._dataset_locks[dataset_id]:
            with self._cache_lock:
                cached = self._cache.get(dataset_id)
                if not force and cached is not None:
                    return deepcopy(cached)
                previous = deepcopy(cached)
                self._cache[dataset_id] = {
                    **(cached or {}), "preparation_state": "preparing"
                }

            cfg = self._datasets[dataset_id]
            csv_path = Path(str(cfg["poi_csv_path"])) if cfg.get("poi_csv_path") else None
            geojson_path = Path(str(cfg["poi_geojson_path"])) if cfg.get("poi_geojson_path") else None

            try:
                if csv_path and csv_path.exists():
                    loaded = self._load_csv(csv_path, cfg)
                elif geojson_path and geojson_path.exists():
                    loaded = self._load_geojson(geojson_path)
                else:
                    configured = str(csv_path or geojson_path or "no POI source configured")
                    loaded = {
                        "source_kind": "empty",
                        "source_path": configured,
                        "source_exists": False,
                        "stats": self._empty_stats(),
                        "error": f"POI source does not exist: {configured}" if (csv_path or geojson_path) else None,
                    }
            except (OSError, ValueError, json.JSONDecodeError, DatasetError, sqlite3.Error) as exc:
                loaded = {
                    "source_kind": "error",
                    "source_path": str(csv_path or geojson_path or ""),
                    "source_exists": bool((csv_path and csv_path.exists()) or (geojson_path and geojson_path.exists())),
                    "stats": previous.get("stats") if previous else None,
                    "error": str(exc),
                }
            loaded["loaded_at"] = datetime.now(timezone.utc).isoformat()
            loaded["preparation_state"] = "ready" if loaded.get("error") is None else "error"
            with self._cache_lock:
                self._cache[dataset_id] = loaded
            return deepcopy(loaded)

    @staticmethod
    def _empty_stats() -> dict[str, Any]:
        return {
            "total_rows": 0,
            "valid_pois": 0,
            "invalid_coordinates": 0,
            "missing_names": 0,
            "invisible_pois": 0,
            "duplicate_poi_ids": 0,
            "duplicate_node_ids": 0,
            "landmark_types": {},
        }

    @staticmethod
    def _detect_column(fieldnames: list[str], configured: str | None, candidates: tuple[str, ...]) -> str | None:
        if configured and configured in fieldnames:
            return configured
        lookup = {field.strip().lower(): field for field in fieldnames}
        for candidate in candidates:
            if candidate in lookup:
                return lookup[candidate]
        return None

    def _load_csv(self, path: Path, cfg: dict[str, Any]) -> dict[str, Any]:
        total_rows = 0
        valid_pois = 0
        invalid_coordinates = 0
        missing_names = 0
        invisible_pois = 0
        # Exact duplicate/type counts are kept in a temporary SQLite database,
        # so memory use does not grow with the number of distinct identifiers.
        with tempfile.TemporaryDirectory(prefix="poi-stats-") as directory:
            with sqlite3.connect(Path(directory) / "counts.sqlite3") as counts:
                counts.executescript(
                    """
                    PRAGMA cache_size=-2048;
                    CREATE TABLE ids (kind TEXT, value TEXT, count INTEGER, PRIMARY KEY(kind, value));
                    CREATE TABLE types (value TEXT PRIMARY KEY, count INTEGER);
                    """
                )
                with path.open("r", encoding="utf-8", newline="") as handle:
                    reader = csv.DictReader(handle)
                    if not reader.fieldnames:
                        raise DatasetError(f"CSV has no header: {path}")
                    fieldnames = [field.strip() for field in reader.fieldnames]
                    lat_col = self._detect_column(fieldnames, cfg.get("lat_column"), LAT_CANDIDATES)
                    lon_col = self._detect_column(fieldnames, cfg.get("lon_column"), LON_CANDIDATES)
                    if not lat_col or not lon_col:
                        raise DatasetError(
                            f"Cannot detect latitude/longitude columns in {path.name}; columns={fieldnames}"
                        )
                    name_col = str(cfg.get("name_column") or "name")
                    visible_col = str(cfg.get("visible_column") or "visible")
                    node_id_col = str(cfg.get("node_id_column") or "new_node_id")
                    poi_id_col = str(cfg.get("poi_id_column") or "mappls_poi_id")
                    type_col = str(cfg.get("type_column") or "landmark_type")

                    for row in reader:
                        total_rows += 1
                        clean = {str(key).strip(): ("" if value is None else str(value)) for key, value in row.items() if key is not None}
                        try:
                            lat = float(clean.get(lat_col, ""))
                            lon = float(clean.get(lon_col, ""))
                            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                                raise ValueError("coordinate out of range")
                        except (TypeError, ValueError):
                            invalid_coordinates += 1
                            continue
                        valid_pois += 1
                        missing_names += int(not clean.get(name_col, "").strip())
                        invisible_pois += int(clean.get(visible_col, "").strip().lower() in FALSE_VALUES)
                        for kind, value in (("node", clean.get(node_id_col, "").strip()), ("poi", clean.get(poi_id_col, "").strip())):
                            if value:
                                counts.execute(
                                    "INSERT INTO ids VALUES (?, ?, 1) ON CONFLICT(kind, value) DO UPDATE SET count=count+1",
                                    (kind, value),
                                )
                        landmark_type = clean.get(type_col, "").strip() or "unknown"
                        counts.execute(
                            "INSERT INTO types VALUES (?, 1) ON CONFLICT(value) DO UPDATE SET count=count+1",
                            (landmark_type,),
                        )
                duplicate_poi_ids = counts.execute(
                    "SELECT COALESCE(SUM(count - 1), 0) FROM ids WHERE kind='poi' AND count > 1"
                ).fetchone()[0]
                duplicate_node_ids = counts.execute(
                    "SELECT COALESCE(SUM(count - 1), 0) FROM ids WHERE kind='node' AND count > 1"
                ).fetchone()[0]
                landmark_types = dict(counts.execute(
                    "SELECT value, count FROM types ORDER BY count DESC, value ASC"
                ))
        stats = {
            "total_rows": total_rows,
            "valid_pois": valid_pois,
            "invalid_coordinates": invalid_coordinates,
            "missing_names": missing_names,
            "invisible_pois": invisible_pois,
            "duplicate_poi_ids": duplicate_poi_ids,
            "duplicate_node_ids": duplicate_node_ids,
            "landmark_types": landmark_types,
        }
        return {
            "source_kind": "csv",
            "source_path": str(path),
            "source_exists": True,
            "stats": stats,
            "error": None,
        }

    def _load_geojson(self, path: Path) -> dict[str, Any]:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if payload.get("type") != "FeatureCollection" or not isinstance(payload.get("features"), list):
            raise DatasetError(f"POI GeoJSON must be a FeatureCollection: {path}")

        valid_pois = 0
        missing_names = 0
        invisible_pois = 0
        poi_ids: dict[str, int] = {}
        node_ids: dict[str, int] = {}
        landmark_types: dict[str, int] = {}
        invalid_coordinates = 0

        for feature in payload["features"]:
            geometry = feature.get("geometry") or {}
            coordinates = geometry.get("coordinates")
            if geometry.get("type") != "Point" or not isinstance(coordinates, list) or len(coordinates) < 2:
                invalid_coordinates += 1
                continue
            try:
                lon = float(coordinates[0])
                lat = float(coordinates[1])
                if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    raise ValueError("coordinate out of range")
            except (TypeError, ValueError):
                invalid_coordinates += 1
                continue

            properties = feature.get("properties") or {}
            if not str(properties.get("name", "")).strip():
                missing_names += 1
            if str(properties.get("visible", "")).strip().lower() in FALSE_VALUES:
                invisible_pois += 1
            node_id = str(properties.get("new_node_id", "")).strip()
            if node_id:
                node_ids[node_id] = node_ids.get(node_id, 0) + 1
            poi_id = str(properties.get("mappls_poi_id", "")).strip()
            if poi_id:
                poi_ids[poi_id] = poi_ids.get(poi_id, 0) + 1
            landmark_type = str(properties.get("landmark_type", "")).strip() or "unknown"
            landmark_types[landmark_type] = landmark_types.get(landmark_type, 0) + 1
            valid_pois += 1

        stats = {
            "total_rows": len(payload["features"]),
            "valid_pois": valid_pois,
            "invalid_coordinates": invalid_coordinates,
            "missing_names": missing_names,
            "invisible_pois": invisible_pois,
            "duplicate_poi_ids": sum(count - 1 for count in poi_ids.values() if count > 1),
            "duplicate_node_ids": sum(count - 1 for count in node_ids.values() if count > 1),
            "landmark_types": dict(sorted(landmark_types.items(), key=lambda item: (-item[1], item[0]))),
        }
        return {
            "source_kind": "geojson",
            "source_path": str(path),
            "source_exists": True,
            "stats": stats,
            "error": None,
        }

    def _load_csv_features(self, path: Path, cfg: dict[str, Any]) -> dict[str, Any]:
        features: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                raise DatasetError(f"CSV has no header: {path}")
            fieldnames = [field.strip() for field in reader.fieldnames]
            lat_col = self._detect_column(fieldnames, cfg.get("lat_column"), LAT_CANDIDATES)
            lon_col = self._detect_column(fieldnames, cfg.get("lon_column"), LON_CANDIDATES)
            if not lat_col or not lon_col:
                raise DatasetError(f"Cannot detect latitude/longitude columns in {path.name}")
            for row in reader:
                clean = {str(key).strip(): ("" if value is None else str(value)) for key, value in row.items() if key is not None}
                try:
                    lat, lon = float(clean.get(lat_col, "")), float(clean.get(lon_col, ""))
                    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                        continue
                except (TypeError, ValueError):
                    continue
                if len(features) >= self._legacy_poi_limit:
                    raise DatasetTooLargeError(
                        f"Dataset exceeds the legacy /api/pois limit of {self._legacy_poi_limit}; use /api/pois/search"
                    )
                features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": clean})
        return {"type": "FeatureCollection", "features": features}

    def _load_geojson_features(self, path: Path) -> dict[str, Any]:
        if path.stat().st_size > self._legacy_geojson_byte_limit:
            raise DatasetTooLargeError(
                f"GeoJSON exceeds the legacy /api/pois byte limit of {self._legacy_geojson_byte_limit}; use /api/pois/search"
            )
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        features = payload.get("features") if isinstance(payload, dict) else None
        if not isinstance(payload, dict) or payload.get("type") != "FeatureCollection" or not isinstance(features, list):
            raise DatasetError(f"POI GeoJSON must be a FeatureCollection: {path}")
        if len(features) > self._legacy_poi_limit:
            raise DatasetTooLargeError(
                f"Dataset exceeds the legacy /api/pois limit of {self._legacy_poi_limit}; use /api/pois/search"
            )
        return payload
