from __future__ import annotations

import os
import secrets
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
    cfg.setdefault("diagnostics", {})
    cfg.setdefault("auth", {})
    cfg["diagnostics"].setdefault("max_points", 1000)
    cfg["diagnostics"].setdefault("max_radius_m", 2000)
    cfg["diagnostics"].setdefault("max_results", 10000)
    cfg["diagnostics"].setdefault("max_candidates", 100000)

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
        ("backend", "poi_index_dir"): "VPD_POI_INDEX_DIR",
        ("backend", "preparation_job_dir"): "VPD_PREPARATION_JOB_DIR",
        ("backend", "preference_db_path"): "VPD_PREFERENCE_DB_PATH",
        ("backend", "testcase_db_path"): "VPD_TESTCASE_DB_PATH",
        ("auth", "users_db_path"): "VPD_USERS_DB_PATH",
        ("auth", "mode"): "VPD_AUTH_MODE",
        ("auth", "environment"): "VPD_ENVIRONMENT",
        ("auth", "oidc_issuer"): "VPD_OIDC_ISSUER",
        ("auth", "client_id"): "VPD_OIDC_CLIENT_ID",
        ("auth", "client_secret"): "VPD_OIDC_CLIENT_SECRET",
        ("auth", "redirect_uri"): "VPD_OIDC_REDIRECT_URI",
        ("auth", "session_secret"): "VPD_SESSION_SECRET",
        ("auth", "cookie_name"): "VPD_SESSION_COOKIE_NAME",
        ("auth", "groups_claim"): "VPD_OIDC_GROUPS_CLAIM",
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
        ("backend", "preparation_job_history_limit"): ("VPD_PREPARATION_JOB_HISTORY_LIMIT", int),
        ("backend", "preparation_worker_nice"): ("VPD_PREPARATION_WORKER_NICE", int),
        ("backend", "preparation_worker_memory_bytes"): ("VPD_PREPARATION_WORKER_MEMORY_BYTES", int),
        ("backend", "preparation_worker_cpu_seconds"): ("VPD_PREPARATION_WORKER_CPU_SECONDS", int),
        ("backend", "preparation_worker_file_bytes"): ("VPD_PREPARATION_WORKER_FILE_BYTES", int),
        ("diagnostics", "max_points"): ("VPD_DIAGNOSTIC_MAX_POINTS", int),
        ("diagnostics", "max_radius_m"): ("VPD_DIAGNOSTIC_MAX_RADIUS_M", float),
        ("diagnostics", "max_results"): ("VPD_DIAGNOSTIC_MAX_RESULTS", int),
        ("diagnostics", "max_candidates"): ("VPD_DIAGNOSTIC_MAX_CANDIDATES", int),
        ("auth", "session_max_age_seconds"): ("VPD_SESSION_MAX_AGE_SECONDS", int),
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
    allowed_users = _csv_env("VPD_AUTH_ALLOWED_USERS")
    if allowed_users is not None:
        cfg["auth"]["allowed_users"] = allowed_users
    allowed_groups = _csv_env("VPD_AUTH_ALLOWED_GROUPS")
    if allowed_groups is not None:
        cfg["auth"]["allowed_groups"] = allowed_groups
    default_center = _float_list_env("VPD_DEFAULT_CENTER", 2)
    if default_center is not None:
        cfg["frontend"]["default_center"] = default_center

    if os.getenv("VPD_ACTIVE_DATASET"):
        cfg["active_dataset"] = os.environ["VPD_ACTIVE_DATASET"]

    cfg["auth"].setdefault("mode", "oidc")
    cfg["auth"].setdefault("environment", "production")
    cfg["auth"].setdefault("cookie_name", "vpd_session")
    cfg["auth"].setdefault("session_max_age_seconds", 8 * 60 * 60)
    cfg["auth"].setdefault("groups_claim", "groups")
    cfg["auth"].setdefault("allowed_users", [])
    cfg["auth"].setdefault("allowed_groups", [])
    cfg["auth"].setdefault("users_db_path", "./data/users.sqlite3")
    if (
        cfg["auth"].get("mode") == "development"
        and cfg["auth"].get("environment") == "development"
        and not cfg["auth"].get("session_secret")
    ):
        # Ephemeral by design: restarting the local backend invalidates sessions.
        cfg["auth"]["session_secret"] = secrets.token_urlsafe(48)

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

    if cfg["backend"].get("poi_index_dir"):
        cfg["backend"]["poi_index_dir"] = _expand_path(
            str(cfg["backend"]["poi_index_dir"])
        )
    if cfg["backend"].get("preparation_job_dir"):
        cfg["backend"]["preparation_job_dir"] = _expand_path(
            str(cfg["backend"]["preparation_job_dir"])
        )
    if not cfg["backend"].get("preference_db_path"):
        cfg["backend"]["preference_db_path"] = "./data/user-preferences.sqlite3"
    cfg["backend"]["preference_db_path"] = _expand_path(
        str(cfg["backend"]["preference_db_path"])
    )
    if not cfg["backend"].get("testcase_db_path"):
        cfg["backend"]["testcase_db_path"] = "./data/testcases.sqlite3"
    cfg["backend"]["testcase_db_path"] = _expand_path(
        str(cfg["backend"]["testcase_db_path"])
    )
    cfg["auth"]["users_db_path"] = _expand_path(str(cfg["auth"]["users_db_path"]))

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
