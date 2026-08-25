from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = REPO_ROOT / "config" / "debugger.yaml"


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


def load_settings() -> dict[str, Any]:
    config_path = Path(
        os.path.expandvars(
            os.path.expanduser(os.getenv("VPD_CONFIG", str(DEFAULT_CONFIG)))
        )
    ).resolve()
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

    # Environment variables override YAML, useful when switching services or the legacy/default dataset.
    env_overrides = {
        ("valhalla", "service_url"): "VPD_VALHALLA_URL",
        ("valhalla", "association_debug_jsonl_path"): "VPD_VALHALLA_ASSOCIATION_DEBUG_JSONL",
        ("osrm", "service_url"): "VPD_OSRM_URL",
        ("osrm", "landmark_debug_jsonl_path"): "VPD_OSRM_LANDMARK_DEBUG_JSONL",
        ("engine", "root"): "VPD_ENGINE_ROOT",
        ("data", "pbf_path"): "VPD_PBF_PATH",
        ("data", "poi_geojson_path"): "VPD_POI_GEOJSON_PATH",
        ("data", "poi_csv_path"): "VPD_POI_CSV_PATH",
        ("frontend", "map_style_url"): "VPD_MAP_STYLE_URL",
        ("scenarios", "directory"): "VPD_SCENARIO_DIR",
    }
    for (section, key), env_name in env_overrides.items():
        value = os.getenv(env_name)
        if value:
            cfg[section][key] = value

    if os.getenv("VPD_ACTIVE_DATASET"):
        cfg["active_dataset"] = os.environ["VPD_ACTIVE_DATASET"]

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
