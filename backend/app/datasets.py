from __future__ import annotations

import csv
import json
import threading
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


FALSE_VALUES = {"0", "false", "no", "n", "off"}
LAT_CANDIDATES = ("lat", "latitude", "y")
LON_CANDIDATES = ("lon", "lng", "longitude", "x")


class DatasetError(RuntimeError):
    pass


class DatasetManager:
    """Runtime POI dataset registry for the local debugger.

    Phase 2A intentionally manages only debugger-side source data. Activating a
    dataset does not restart Valhalla and does not swap the tile set used by the
    already-running Valhalla service.
    """

    def __init__(self, settings: dict[str, Any]):
        self._settings = settings
        self._lock = threading.RLock()
        self._datasets = self._build_registry(settings)
        if not self._datasets:
            raise DatasetError("No debugger dataset is configured")

        requested = str(settings.get("active_dataset") or "").strip()
        self._active_id = requested if requested in self._datasets else next(iter(self._datasets))
        self._cache: dict[str, dict[str, Any]] = {}

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
        with self._lock:
            return self._active_id

    def active_config(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._datasets[self._active_id])

    def activate(self, dataset_id: str) -> dict[str, Any]:
        with self._lock:
            if dataset_id not in self._datasets:
                raise DatasetError(f"Unknown dataset: {dataset_id}")
            self._active_id = dataset_id
            self._load(dataset_id, force=False)
            return self._summary(dataset_id)

    def get_active_pois(self) -> dict[str, Any]:
        with self._lock:
            loaded = self._load(self._active_id, force=False)
            return deepcopy(loaded["feature_collection"])

    def reload(self, dataset_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            target = dataset_id or self._active_id
            if target not in self._datasets:
                raise DatasetError(f"Unknown dataset: {target}")
            self._load(target, force=True)
            return self._summary(target)

    def describe(self) -> dict[str, Any]:
        with self._lock:
            # Load the active dataset so the UI always has current validation stats.
            self._load(self._active_id, force=False)
            return {
                "active_dataset": self._active_id,
                "datasets": [self._summary(dataset_id) for dataset_id in self._datasets],
            }

    def _summary(self, dataset_id: str) -> dict[str, Any]:
        cfg = self._datasets[dataset_id]
        cached = self._cache.get(dataset_id)
        summary = {
            "id": dataset_id,
            "name": cfg.get("name", dataset_id),
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
            "source_kind": cached.get("source_kind") if cached else None,
            "source_path": cached.get("source_path") if cached else None,
            "source_exists": cached.get("source_exists") if cached else self._configured_source_exists(cfg),
            "loaded_at": cached.get("loaded_at") if cached else None,
            "stats": deepcopy(cached.get("stats")) if cached else None,
            "error": cached.get("error") if cached else None,
        }
        return summary

    @staticmethod
    def _configured_source_exists(cfg: dict[str, Any]) -> bool:
        for key in ("poi_csv_path", "poi_geojson_path"):
            value = cfg.get(key)
            if value and Path(str(value)).exists():
                return True
        return False

    def _load(self, dataset_id: str, force: bool) -> dict[str, Any]:
        if not force and dataset_id in self._cache:
            return self._cache[dataset_id]

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
                    "feature_collection": {"type": "FeatureCollection", "features": []},
                    "source_kind": "empty",
                    "source_path": configured,
                    "source_exists": False,
                    "stats": self._empty_stats(),
                    "error": f"POI source does not exist: {configured}" if (csv_path or geojson_path) else None,
                }
        except (OSError, ValueError, json.JSONDecodeError, DatasetError) as exc:
            loaded = {
                "feature_collection": {"type": "FeatureCollection", "features": []},
                "source_kind": "error",
                "source_path": str(csv_path or geojson_path or ""),
                "source_exists": bool((csv_path and csv_path.exists()) or (geojson_path and geojson_path.exists())),
                "stats": self._empty_stats(),
                "error": str(exc),
            }

        loaded["loaded_at"] = datetime.now(timezone.utc).isoformat()
        self._cache[dataset_id] = loaded
        return loaded

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
        features: list[dict[str, Any]] = []
        total_rows = 0
        invalid_coordinates = 0
        missing_names = 0
        invisible_pois = 0
        poi_ids: Counter[str] = Counter()
        node_ids: Counter[str] = Counter()
        landmark_types: Counter[str] = Counter()

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

                if not clean.get(name_col, "").strip():
                    missing_names += 1

                visible_value = clean.get(visible_col, "").strip().lower()
                if visible_value in FALSE_VALUES:
                    invisible_pois += 1

                node_id = clean.get(node_id_col, "").strip()
                if node_id:
                    node_ids[node_id] += 1

                poi_id = clean.get(poi_id_col, "").strip()
                if poi_id:
                    poi_ids[poi_id] += 1

                landmark_type = clean.get(type_col, "").strip() or "unknown"
                landmark_types[landmark_type] += 1

                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": clean,
                })

        duplicate_node_ids = sum(count - 1 for count in node_ids.values() if count > 1)
        stats = {
            "total_rows": total_rows,
            "valid_pois": len(features),
            "invalid_coordinates": invalid_coordinates,
            "missing_names": missing_names,
            "invisible_pois": invisible_pois,
            "duplicate_poi_ids": sum(count - 1 for count in poi_ids.values() if count > 1),
            "duplicate_node_ids": duplicate_node_ids,
            "landmark_types": dict(sorted(landmark_types.items(), key=lambda item: (-item[1], item[0]))),
        }
        return {
            "feature_collection": {"type": "FeatureCollection", "features": features},
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

        valid_features: list[dict[str, Any]] = []
        missing_names = 0
        invisible_pois = 0
        poi_ids: Counter[str] = Counter()
        node_ids: Counter[str] = Counter()
        landmark_types: Counter[str] = Counter()
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
                node_ids[node_id] += 1
            poi_id = str(properties.get("mappls_poi_id", "")).strip()
            if poi_id:
                poi_ids[poi_id] += 1
            landmark_type = str(properties.get("landmark_type", "")).strip() or "unknown"
            landmark_types[landmark_type] += 1
            valid_features.append(feature)

        stats = {
            "total_rows": len(payload["features"]),
            "valid_pois": len(valid_features),
            "invalid_coordinates": invalid_coordinates,
            "missing_names": missing_names,
            "invisible_pois": invisible_pois,
            "duplicate_poi_ids": sum(count - 1 for count in poi_ids.values() if count > 1),
            "duplicate_node_ids": sum(count - 1 for count in node_ids.values() if count > 1),
            "landmark_types": dict(sorted(landmark_types.items(), key=lambda item: (-item[1], item[0]))),
        }
        return {
            "feature_collection": {"type": "FeatureCollection", "features": valid_features},
            "source_kind": "geojson",
            "source_path": str(path),
            "source_exists": True,
            "stats": stats,
            "error": None,
        }
