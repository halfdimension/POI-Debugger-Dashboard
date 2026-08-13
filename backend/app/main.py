from __future__ import annotations

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
    title="Valhalla POI Debugger API",
    version="0.3.0",
    description="Local debug API for Valhalla POI/landmark testing.",
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
