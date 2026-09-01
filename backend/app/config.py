from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = REPO_ROOT / "config" / "debugger.yaml"
EXAMPLE_CONFIG = REPO_ROOT / "config" / "debugger.example.yaml"


def _expand_path(value: str) -> str:
    path = Path(os.path.expandvars(os.path.expanduser(value)))
    if not path.is_absolute():
        path = REPO_ROOT / path
    return str(path.resolve())


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Debugger config not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ValueError("Top-level debugger config must be a YAML object")
    return data


def _csv_env(name: str) -> list[str] | None:
    value = os.getenv(name)
    if value is None:
        return None
    return [item.strip() for item in value.split(",") if item.strip()]


def _float_list_env(name: str, expected_length: int) -> list[float] | None:
    values = _csv_env(name)
    if values is None:
        return None
    if len(values) != expected_length:
        raise ValueError(f"{name} must contain {expected_length} comma-separated numbers")
    try:
        return [float(value) for value in values]
    except ValueError as exc:
        raise ValueError(f"{name} must contain only numbers") from exc


def load_settings() -> dict[str, Any]:
    configured_path = os.getenv("VPD_CONFIG")
    config_path = Path(
        os.path.expandvars(os.path.expanduser(configured_path or str(DEFAULT_CONFIG)))
    ).resolve()
    if not configured_path and not config_path.exists():
        config_path = EXAMPLE_CONFIG
    cfg = _load_yaml(config_path)

    cfg.setdefault("project", {})
    cfg.setdefault("valhalla", {})
    cfg.setdefault("osrm", {})
    cfg.setdefault("engine", {})
    cfg.setdefault("data", {})
    cfg.setdefault("datasets", {})
    cfg.setdefault("scenarios", {})
    cfg.setdefault("frontend", {})
    cfg.setdefault("backend", {})

    # Environment variables override YAML. String values are listed here;
    # typed/list values are handled below.
    env_overrides = {
        ("project", "name"): "VPD_PROJECT_NAME",
        ("valhalla", "service_url"): "VPD_VALHALLA_URL",
        ("valhalla", "status_path"): "VPD_VALHALLA_STATUS_PATH",
        ("valhalla", "route_path"): "VPD_VALHALLA_ROUTE_PATH",
        ("valhalla", "association_debug_jsonl_path"): "VPD_VALHALLA_ASSOCIATION_DEBUG_JSONL",
        ("osrm", "service_url"): "VPD_OSRM_URL",
        ("osrm", "profile"): "VPD_OSRM_PROFILE",
        ("osrm", "route_path"): "VPD_OSRM_ROUTE_PATH",
        ("osrm", "nearest_path"): "VPD_OSRM_NEAREST_PATH",
        ("osrm", "landmark_debug_jsonl_path"): "VPD_OSRM_LANDMARK_DEBUG_JSONL",
        ("engine", "root"): "VPD_ENGINE_ROOT",
        ("data", "pbf_path"): "VPD_PBF_PATH",
        ("data", "poi_geojson_path"): "VPD_POI_GEOJSON_PATH",
        ("data", "poi_csv_path"): "VPD_POI_CSV_PATH",
        ("frontend", "map_style_url"): "VPD_MAP_STYLE_URL",
        ("frontend", "dist_path"): "VPD_FRONTEND_DIST_PATH",
        ("scenarios", "directory"): "VPD_SCENARIO_DIR",
    }
    for (section, key), env_name in env_overrides.items():
        value = os.getenv(env_name)
        if value is not None and value != "":
            cfg[section][key] = value

    numeric_overrides = {
        ("valhalla", "timeout_seconds"): ("VPD_VALHALLA_TIMEOUT_SECONDS", float),
        ("osrm", "timeout_seconds"): ("VPD_OSRM_TIMEOUT_SECONDS", float),
        ("frontend", "default_zoom"): ("VPD_DEFAULT_ZOOM", float),
        ("backend", "port"): ("VPD_BACKEND_PORT", int),
    }
    for (section, key), (env_name, converter) in numeric_overrides.items():
        value = os.getenv(env_name)
        if value is not None and value != "":
            cfg[section][key] = converter(value)

    if os.getenv("VPD_BACKEND_HOST"):
        cfg["backend"]["host"] = os.environ["VPD_BACKEND_HOST"]
    allowed_origins = _csv_env("VPD_ALLOWED_ORIGINS")
    if allowed_origins is not None:
        cfg["backend"]["allowed_origins"] = allowed_origins
    default_center = _float_list_env("VPD_DEFAULT_CENTER", 2)
    if default_center is not None:
        cfg["frontend"]["default_center"] = default_center

    if os.getenv("VPD_ACTIVE_DATASET"):
        cfg["active_dataset"] = os.environ["VPD_ACTIVE_DATASET"]

    # Named datasets take precedence over the legacy data block. Apply the same
    # deployment path overrides to the active named dataset as well.
    active_dataset = str(cfg.get("active_dataset") or "").strip()
    if (
        active_dataset
        and isinstance(cfg["datasets"], dict)
        and active_dataset not in cfg["datasets"]
    ):
        cfg["datasets"][active_dataset] = {
            **dict(cfg["data"]),
            "name": os.getenv("VPD_DATASET_NAME", active_dataset),
        }
    active_config = cfg["datasets"].get(active_dataset) if isinstance(cfg["datasets"], dict) else None
    if isinstance(active_config, dict):
        dataset_overrides = {
            "pbf_path": "VPD_PBF_PATH",
            "poi_geojson_path": "VPD_POI_GEOJSON_PATH",
            "poi_csv_path": "VPD_POI_CSV_PATH",
            "tiles_path": "VPD_TILES_PATH",
            "valhalla_config_path": "VPD_VALHALLA_CONFIG_PATH",
            "valhalla_association_debug_jsonl_path": "VPD_VALHALLA_ASSOCIATION_DEBUG_JSONL",
            "osrm_landmark_debug_jsonl_path": "VPD_OSRM_LANDMARK_DEBUG_JSONL",
        }
        for key, env_name in dataset_overrides.items():
            value = os.getenv(env_name)
            if value is not None and value != "":
                active_config[key] = value
        if os.getenv("VPD_DATASET_NAME"):
            active_config["name"] = os.environ["VPD_DATASET_NAME"]

    if cfg["engine"].get("root"):
        cfg["engine"]["root"] = _expand_path(str(cfg["engine"]["root"]))

    if cfg["valhalla"].get("association_debug_jsonl_path"):
        cfg["valhalla"]["association_debug_jsonl_path"] = _expand_path(
            str(cfg["valhalla"]["association_debug_jsonl_path"])
        )

    if cfg["osrm"].get("landmark_debug_jsonl_path"):
        cfg["osrm"]["landmark_debug_jsonl_path"] = _expand_path(
            str(cfg["osrm"]["landmark_debug_jsonl_path"])
        )

    if cfg["frontend"].get("dist_path"):
        cfg["frontend"]["dist_path"] = _expand_path(str(cfg["frontend"]["dist_path"]))

    if not cfg["scenarios"].get("directory"):
        cfg["scenarios"]["directory"] = "./data/scenarios"
    cfg["scenarios"]["directory"] = _expand_path(str(cfg["scenarios"]["directory"]))

    for key in ("pbf_path", "poi_geojson_path", "poi_csv_path"):
        if cfg["data"].get(key):
            cfg["data"][key] = _expand_path(str(cfg["data"][key]))

    dataset_path_keys = (
        "pbf_path",
        "poi_geojson_path",
        "poi_csv_path",
        "tiles_path",
        "valhalla_config_path",
        "valhalla_association_debug_jsonl_path",
        "osrm_landmark_debug_jsonl_path",
    )
    if isinstance(cfg["datasets"], dict):
        for dataset in cfg["datasets"].values():
            if not isinstance(dataset, dict):
                continue
            for key in dataset_path_keys:
                if dataset.get(key):
                    dataset[key] = _expand_path(str(dataset[key]))

    cfg["_config_path"] = str(config_path)
    return cfg
