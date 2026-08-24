from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import load_settings
from .datasets import DatasetError, DatasetManager
from .scenarios import ScenarioError, ScenarioManager

settings = load_settings()
datasets = DatasetManager(settings)
scenarios = ScenarioManager(settings)

app = FastAPI(
    title="Valhalla + OSRM POI Debugger API",
    version="0.4.0",
    description="Local debug API for Valhalla and OSRM POI/landmark comparison.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get("backend", {}).get("allowed_origins", []),
    allow_credentials=False,
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


def _public_config() -> dict[str, Any]:
    active = datasets.active_config()
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
        },
        "osrm": {
            "service_url": settings["osrm"].get("service_url"),
            "profile": settings["osrm"].get("profile", "driving"),
            "route_path": settings["osrm"].get("route_path", "/route/v1"),
        },
        "engine": settings.get("engine", {}),
        "data": data,
        "active_dataset": datasets.active_id,
        "frontend": settings.get("frontend", {}),
        "config_path": settings.get("_config_path"),
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "valhalla-poi-debugger",
        "phase": "3A",
        "config_path": settings.get("_config_path"),
        "active_dataset": datasets.active_id,
    }


@app.get("/api/config")
def get_config() -> dict[str, Any]:
    return _public_config()


@app.get("/api/datasets")
def get_datasets() -> dict[str, Any]:
    return datasets.describe()


@app.post("/api/datasets/{dataset_id}/activate")
def activate_dataset(dataset_id: str) -> dict[str, Any]:
    try:
        dataset = datasets.activate(dataset_id)
    except DatasetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True, "active_dataset": datasets.active_id, "dataset": dataset}


@app.post("/api/datasets/{dataset_id}/reload-pois")
def reload_dataset_pois(dataset_id: str) -> dict[str, Any]:
    try:
        dataset = datasets.reload(dataset_id)
    except DatasetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True, "active_dataset": datasets.active_id, "dataset": dataset}


@app.get("/api/pois")
def get_pois() -> dict[str, Any]:
    return datasets.get_active_pois()


@app.get("/api/scenarios")
def get_scenarios() -> dict[str, Any]:
    return scenarios.list()


@app.get("/api/scenarios/{scenario_id}")
def get_scenario(scenario_id: str) -> dict[str, Any]:
    try:
        return scenarios.get(scenario_id)
    except ScenarioError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/scenarios", status_code=201)
def create_scenario(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return scenarios.create(payload)
    except ScenarioError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/api/scenarios/{scenario_id}")
def update_scenario(scenario_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return scenarios.update(scenario_id, payload)
    except ScenarioError as exc:
        status = 404 if "not found" in str(exc).lower() else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@app.delete("/api/scenarios/{scenario_id}")
def delete_scenario(scenario_id: str) -> dict[str, Any]:
    try:
        scenarios.delete(scenario_id)
    except ScenarioError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True, "id": scenario_id}


@app.get("/api/valhalla/status")
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


@app.post("/api/route")
async def route(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload.get("locations"), list) or len(payload["locations"]) < 2:
        raise HTTPException(status_code=400, detail="Route request needs at least two locations")

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


@app.get("/api/osrm/status")
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


async def _compare_valhalla(payload: dict[str, Any]) -> dict[str, Any]:
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

    return {
        "ok": True,
        "url": url,
        "status_code": response.status_code,
        "response": body,
    }


async def _compare_osrm(payload: dict[str, Any]) -> dict[str, Any]:
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

    return {
        "ok": True,
        "url": str(response.request.url),
        "status_code": response.status_code,
        "response": body,
    }


@app.post("/api/route/compare")
async def compare_route(payload: dict[str, Any]) -> dict[str, Any]:
    locations = payload.get("locations")

    if not isinstance(locations, list) or len(locations) < 2:
        raise HTTPException(
            status_code=400,
            detail="Route request needs at least two locations",
        )

    valhalla_result, osrm_result = await asyncio.gather(
        _compare_valhalla(payload),
        _compare_osrm(payload),
    )

    return {
        "valhalla": valhalla_result,
        "osrm": osrm_result,
    }

