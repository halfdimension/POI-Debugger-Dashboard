from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import load_settings
from .auth import AuthManager
from .admin import admin_router
from .datasets import DatasetError, DatasetManager, DatasetTooLargeError
from .poi_search import (
    PoiSearchError,
    PoiSearchNotFoundError,
    PoiSearchNotReadyError,
    PoiSearchValidationError,
    parse_bbox,
)
from .preparation_jobs import (
    PreparationCapacityError,
    PreparationJobError,
    PreparationJobManager,
    PreparationJobNotFoundError,
)
from .landmark_debug import OsrmLandmarkDebugManager
from .valhalla_landmark_debug import ValhallaLandmarkDebugManager
from .scenarios import ScenarioError, ScenarioManager
from .preferences import PreferenceValidationError, UserPreferenceStore
from .testcases import TestcaseConflictError, TestcaseError, TestcaseNotFoundError, TestcaseRepository

settings = load_settings()
auth = AuthManager(settings)
datasets = DatasetManager(settings)
preparation_jobs = PreparationJobManager(settings, datasets.ids)
preferences = UserPreferenceStore(
    settings["backend"]["preference_db_path"], datasets.ids, datasets.default_id
)
scenarios = ScenarioManager(settings)
testcases = TestcaseRepository(settings["backend"]["testcase_db_path"], datasets.ids)
osrm_landmark_debug = OsrmLandmarkDebugManager(settings, datasets)
valhalla_landmark_debug = ValhallaLandmarkDebugManager(settings, datasets)

app = FastAPI(
    title="Valhalla + OSRM POI Debugger API",
    version="0.6.0",
    description="Local debug API for Valhalla and OSRM POI/landmark comparison.",
    docs_url="/docs" if auth.environment == "development" else None,
    redoc_url=None,
    openapi_url="/openapi.json" if auth.environment == "development" else None,
)
auth.install(app)
app.include_router(auth.router())
app.include_router(admin_router(auth))
protected = APIRouter(dependencies=[Depends(auth.require_authenticated_request)])

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get("backend", {}).get("allowed_origins", []),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _valhalla_url(path: str) -> str:
    base = str(settings["valhalla"]["service_url"]).rstrip("/")
    suffix = str(path).strip()
    if not suffix.startswith("/"):
        suffix = "/" + suffix
    return base + suffix


def _osrm_url(path: str) -> str:
    base = str(settings["osrm"]["service_url"]).rstrip("/")
    suffix = str(path).strip()
    if not suffix.startswith("/"):
        suffix = "/" + suffix
    return base + suffix


def _user_id(request: Request) -> str:
    return str(request.state.current_user["id"])


def _effective_dataset_id(request: Request, requested: Any = None) -> str:
    if requested is not None:
        dataset_id = str(requested).strip()
        if not datasets.has(dataset_id):
            raise HTTPException(status_code=404, detail=f"Unknown dataset: {dataset_id}")
        return dataset_id
    return str(preferences.get(_user_id(request))["selected_dataset_id"])


def _public_config(dataset_id: str) -> dict[str, Any]:
    active = datasets.config(dataset_id)
    data = dict(settings.get("data", {}))
    for key in ("pbf_path", "poi_geojson_path", "poi_csv_path"):
        if active.get(key):
            data[key] = active[key]

    return {
        "project": settings.get("project", {}),
        "valhalla": {
            "service_url": settings["valhalla"].get("service_url"),
            "status_path": settings["valhalla"].get("status_path", "/status"),
            "route_path": settings["valhalla"].get("route_path", "/route"),
            "association_debug_jsonl_path": (
                active.get("valhalla_association_debug_jsonl_path")
                or settings["valhalla"].get(
                    "association_debug_jsonl_path"
                )
            ),
        },
        "osrm": {
            "service_url": settings["osrm"].get("service_url"),
            "profile": settings["osrm"].get("profile", "driving"),
            "route_path": settings["osrm"].get("route_path", "/route/v1"),
            "landmark_debug_jsonl_path": (
                active.get("osrm_landmark_debug_jsonl_path")
                or settings["osrm"].get("landmark_debug_jsonl_path")
            ),
        },
        "engine": settings.get("engine", {}),
        "data": data,
        "active_dataset": dataset_id,
        "frontend": settings.get("frontend", {}),
        "config_path": settings.get("_config_path"),
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "valhalla-poi-debugger",
        "phase": "4B",
    }


@protected.get("/api/config")
def get_config(request: Request) -> dict[str, Any]:
    return _public_config(_effective_dataset_id(request))


@protected.get("/api/users/me/preferences")
def get_preferences(request: Request) -> dict[str, Any]:
    return preferences.get(_user_id(request))


@protected.patch("/api/users/me/preferences")
def patch_preferences(request: Request, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return preferences.update(_user_id(request), payload)
    except PreferenceValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@protected.get("/api/datasets")
def get_datasets(request: Request) -> dict[str, Any]:
    return preparation_jobs.decorate_registry(
        datasets.describe(_effective_dataset_id(request))
    )


@protected.post("/api/datasets/{dataset_id}/activate")
def activate_dataset(dataset_id: str, request: Request) -> dict[str, Any]:
    try:
        dataset = datasets.activate(dataset_id)
        updated = preferences.update(_user_id(request), {"selected_dataset_id": dataset_id})
    except (DatasetError, PreferenceValidationError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True, "active_dataset": updated["selected_dataset_id"], "dataset": dataset}


@protected.post(
    "/api/datasets/{dataset_id}/reload-pois",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(auth.require_super_admin)],
)
def reload_dataset_pois(dataset_id: str, request: Request) -> dict[str, Any]:
    try:
        job, accepted = preparation_jobs.submit(dataset_id, _user_id(request))
    except PreparationJobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PreparationCapacityError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PreparationJobError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"ok": True, "accepted": accepted, "job": job}


@protected.get("/api/datasets/preparation-jobs/{job_id}")
def get_preparation_job(job_id: str) -> dict[str, Any]:
    try:
        return preparation_jobs.get(job_id)
    except PreparationJobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _index_not_ready(dataset_id: str) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "code": "poi_index_not_ready",
            "message": "The POI index is not ready. A Super Admin must prepare this dataset.",
            "dataset_id": dataset_id,
            "preparation_state": preparation_jobs.state_for_dataset(dataset_id),
        },
    )


@protected.get("/api/pois")
def get_pois(request: Request, dataset_id: str | None = None) -> dict[str, Any]:
    try:
        return datasets.get_pois(_effective_dataset_id(request, dataset_id))
    except DatasetTooLargeError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except DatasetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@protected.get("/api/pois/search")
def search_pois(
    request: Request,
    dataset_id: str | None = None,
    q: str | None = None,
    type: str | None = None,
    min_priority: float | None = None,
    visible: bool | None = None,
    bbox: str | None = None,
    limit: int = 100,
    cursor: str | None = None,
) -> dict[str, Any]:
    selected_dataset_id = _effective_dataset_id(request, dataset_id)
    try:
        return datasets.search_index.search(
            selected_dataset_id,
            q=q,
            landmark_type=type,
            min_priority=min_priority,
            visible=visible,
            bbox=parse_bbox(bbox),
            limit=limit,
            cursor=cursor,
        )
    except PoiSearchNotReadyError as exc:
        raise _index_not_ready(selected_dataset_id) from exc
    except PoiSearchNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PoiSearchValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PoiSearchError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@protected.post("/api/pois/query")
def query_pois(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """Field-specific search. Quick text is ANDed with the condition group."""
    selected_dataset_id = _effective_dataset_id(request, payload.get("dataset_id"))
    try:
        raw_bbox = payload.get("bbox")
        if raw_bbox is None:
            bbox = None
        elif isinstance(raw_bbox, list):
            bbox = parse_bbox(",".join(str(value) for value in raw_bbox))
        elif isinstance(raw_bbox, str):
            bbox = parse_bbox(raw_bbox)
        else:
            raise PoiSearchValidationError(
                "bbox must be [west,south,east,north]"
            )
        return datasets.search_index.query(
            selected_dataset_id,
            q=payload.get("q"),
            mode=payload.get("mode", "and"),
            conditions=payload.get("conditions", []),
            bbox=bbox,
            limit=payload.get("limit", 100),
            cursor=payload.get("cursor"),
        )
    except PoiSearchNotReadyError as exc:
        raise _index_not_ready(selected_dataset_id) from exc
    except PoiSearchNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PoiSearchValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PoiSearchError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@protected.post("/api/pois/diagnostics/nearby")
def nearby_diagnostic_pois(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """Retrieve source POIs truly within radius of route/maneuver points."""
    limits = settings.get("diagnostics", {})
    selected_dataset_id = _effective_dataset_id(request, payload.get("dataset_id"))
    try:
        return datasets.search_index.nearby(
            selected_dataset_id,
            points=payload.get("points"),
            radius_m=payload.get("radius_m"),
            max_results=int(limits.get("max_results", 10_000)),
            max_candidates=int(limits.get("max_candidates", 100_000)),
            max_points=int(limits.get("max_points", 1_000)),
            max_radius_m=float(limits.get("max_radius_m", 2_000)),
        )
    except PoiSearchNotReadyError as exc:
        raise _index_not_ready(selected_dataset_id) from exc
    except PoiSearchNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PoiSearchValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PoiSearchError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@protected.get("/api/scenarios")
def get_scenarios() -> dict[str, Any]:
    return {**scenarios.list(), "source": "legacy", "read_only": True}


@protected.get("/api/scenarios/{scenario_id}")
def get_scenario(scenario_id: str) -> dict[str, Any]:
    try:
        return scenarios.get(scenario_id)
    except ScenarioError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@protected.get("/api/testcases")
def list_testcases(
    request: Request, q: str = "", visibility: str | None = None, limit: int = 50,
    offset: int = 0, sort: str = "updated_desc",
) -> dict[str, Any]:
    try:
        return testcases.list(
            _user_id(request), query=q, visibility=visibility, limit=limit, offset=offset, sort=sort
        )
    except TestcaseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@protected.get("/api/testcases/shared")
def list_shared_testcases(
    request: Request, q: str = "", limit: int = 50, offset: int = 0,
    sort: str = "updated_desc",
) -> dict[str, Any]:
    try:
        return testcases.list_shared(_user_id(request), query=q, limit=limit, offset=offset, sort=sort)
    except TestcaseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@protected.post("/api/testcases", status_code=201)
def create_testcase(request: Request, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        user = request.state.current_user
        return testcases.create(
            _user_id(request), payload,
            owner_display_name=str(user.get("display_name") or ""),
            owner_username=str(user.get("username") or ""),
        )
    except TestcaseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@protected.get("/api/testcases/{testcase_id}")
def get_testcase(testcase_id: str, request: Request) -> dict[str, Any]:
    try:
        return testcases.get(_user_id(request), testcase_id)
    except TestcaseNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@protected.patch("/api/testcases/{testcase_id}")
def update_testcase(testcase_id: str, request: Request, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        user = request.state.current_user
        return testcases.update(
            _user_id(request), testcase_id, payload,
            owner_display_name=str(user.get("display_name") or ""),
            owner_username=str(user.get("username") or ""),
        )
    except TestcaseNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except TestcaseConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TestcaseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@protected.delete("/api/testcases/{testcase_id}")
def delete_testcase(testcase_id: str, request: Request) -> dict[str, Any]:
    try:
        testcases.delete(_user_id(request), testcase_id)
    except TestcaseNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True, "id": testcase_id}


@protected.get("/api/valhalla/status")
async def valhalla_status() -> dict[str, Any]:
    timeout = float(settings["valhalla"].get("timeout_seconds", 20))
    url = _valhalla_url(settings["valhalla"].get("status_path", "/status"))
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url)
        response.raise_for_status()
        return {"ok": True, "url": url, "response": response.json()}
    except (httpx.HTTPError, ValueError) as exc:
        return {"ok": False, "url": url, "error": str(exc)}


@protected.post("/api/route")
async def route(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    if not isinstance(payload.get("locations"), list) or len(payload["locations"]) < 2:
        raise HTTPException(status_code=400, detail="Route request needs at least two locations")

    _effective_dataset_id(request, payload.get("dataset_id"))
    engine_payload = {key: value for key, value in payload.items() if key != "dataset_id"}
    timeout = float(settings["valhalla"].get("timeout_seconds", 20))
    url = _valhalla_url(settings["valhalla"].get("route_path", "/route"))

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                url,
                content=json.dumps(engine_payload, separators=(",", ":")),
                headers={"Content-Type": "application/json"},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Cannot reach Valhalla: {exc}") from exc

    try:
        body = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Valhalla returned non-JSON HTTP {response.status_code}: {response.text[:500]}",
        ) from exc

    if response.is_error:
        raise HTTPException(
            status_code=response.status_code,
            detail={"valhalla_status": response.status_code, "body": body},
        )

    return body


@protected.get("/api/osrm/status")
async def osrm_status() -> dict[str, Any]:
    timeout = float(settings["osrm"].get("timeout_seconds", 20))
    profile = str(settings["osrm"].get("profile", "driving"))
    nearest_path = settings["osrm"].get("nearest_path", "/nearest/v1")

    center = settings.get("frontend", {}).get("default_center", [77.2090, 28.6139])
    lon = float(center[0])
    lat = float(center[1])

    url = f"{_osrm_url(nearest_path)}/{profile}/{lon},{lat}"

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url, params={"number": 1})
        body = response.json()
        return {
            "ok": not response.is_error,
            "url": str(response.request.url),
            "status_code": response.status_code,
            "response": body,
        }
    except (httpx.HTTPError, ValueError) as exc:
        return {"ok": False, "url": url, "error": str(exc)}


async def _compare_valhalla(payload: dict[str, Any], dataset_id: str) -> dict[str, Any]:
    timeout = float(settings["valhalla"].get("timeout_seconds", 20))
    url = _valhalla_url(settings["valhalla"].get("route_path", "/route"))

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                url,
                content=json.dumps(payload, separators=(",", ":")),
                headers={"Content-Type": "application/json"},
            )
    except httpx.HTTPError as exc:
        return {
            "ok": False,
            "url": url,
            "error": f"Cannot reach Valhalla: {exc}",
        }

    try:
        body = response.json()
    except ValueError:
        return {
            "ok": False,
            "url": url,
            "status_code": response.status_code,
            "error": f"Valhalla returned non-JSON HTTP {response.status_code}: {response.text[:500]}",
        }

    if response.is_error:
        return {
            "ok": False,
            "url": url,
            "status_code": response.status_code,
            "response": body,
            "error": f"Valhalla returned HTTP {response.status_code}",
        }

    candidate_analysis = valhalla_landmark_debug.analyze_route(body, dataset_id)

    return {
        "ok": True,
        "url": url,
        "status_code": response.status_code,
        "response": body,
        "candidate_analysis": candidate_analysis,
    }


async def _compare_osrm(payload: dict[str, Any], dataset_id: str) -> dict[str, Any]:
    osrm = settings["osrm"]
    timeout = float(osrm.get("timeout_seconds", 20))
    profile = str(osrm.get("profile", "driving"))
    route_path = osrm.get("route_path", "/route/v1")

    locations = payload.get("locations") or []

    try:
        coordinate_parts = [
            f"{float(location['lon'])},{float(location['lat'])}"
            for location in locations
        ]
    except (KeyError, TypeError, ValueError) as exc:
        return {
            "ok": False,
            "error": f"Cannot build OSRM coordinates from route request: {exc}",
        }

    coordinates = ";".join(coordinate_parts)
    url = f"{_osrm_url(route_path)}/{profile}/{coordinates}"

    # `instructions=true` is important for this custom fork:
    # route_api.hpp fills StepManeuver::banner_instruction and json_factory.cpp
    # serializes it as maneuver.instruction.
    params = {
        "steps": "true",
        "overview": "full",
        "geometries": "geojson",
        "annotations": "true",
        "alternatives": "false",
        "instructions": "true",
        "banner_instructions": "true",
    }

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url, params=params)
    except httpx.HTTPError as exc:
        return {
            "ok": False,
            "url": url,
            "error": f"Cannot reach OSRM: {exc}",
        }

    try:
        body = response.json()
    except ValueError:
        return {
            "ok": False,
            "url": url,
            "status_code": response.status_code,
            "error": f"OSRM returned non-JSON HTTP {response.status_code}: {response.text[:500]}",
        }

    if response.is_error or body.get("code") != "Ok":
        return {
            "ok": False,
            "url": str(response.request.url),
            "status_code": response.status_code,
            "response": body,
            "error": f"OSRM route failed: HTTP {response.status_code}, code={body.get('code')}",
        }

    candidate_analysis = osrm_landmark_debug.analyze_route(body, dataset_id)

    return {
        "ok": True,
        "url": str(response.request.url),
        "status_code": response.status_code,
        "response": body,
        "candidate_analysis": candidate_analysis,
    }


@protected.post("/api/route/compare")
async def compare_route(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    locations = payload.get("locations")

    if not isinstance(locations, list) or len(locations) < 2:
        raise HTTPException(
            status_code=400,
            detail="Route request needs at least two locations",
        )

    dataset_id = _effective_dataset_id(request, payload.get("dataset_id"))
    engine_payload = {key: value for key, value in payload.items() if key != "dataset_id"}
    valhalla_result, osrm_result = await asyncio.gather(
        _compare_valhalla(engine_payload, dataset_id),
        _compare_osrm(engine_payload, dataset_id),
    )

    return {
        "dataset_id": dataset_id,
        "valhalla": valhalla_result,
        "osrm": osrm_result,
    }


app.include_router(protected)


# A production build can be served by this process, keeping the frontend and
# API on one origin and leaving only one port for DevOps to expose.
frontend_dist = settings.get("frontend", {}).get("dist_path")
if frontend_dist:
    frontend_dist_path = Path(str(frontend_dist))
else:
    frontend_dist_path = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist_path.is_dir():
    app.mount("/", StaticFiles(directory=str(frontend_dist_path), html=True), name="frontend")
