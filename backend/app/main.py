from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import load_settings

settings = load_settings()

app = FastAPI(
    title="Valhalla POI Debugger API",
    version="0.1.0",
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
    return {
        "project": settings.get("project", {}),
        "valhalla": {
            "service_url": settings["valhalla"].get("service_url"),
            "status_path": settings["valhalla"].get("status_path", "/status"),
            "route_path": settings["valhalla"].get("route_path", "/route"),
        },
        "engine": settings.get("engine", {}),
        "data": settings.get("data", {}),
        "frontend": settings.get("frontend", {}),
        "config_path": settings.get("_config_path"),
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "valhalla-poi-debugger",
        "config_path": settings.get("_config_path"),
    }


@app.get("/api/config")
def get_config() -> dict[str, Any]:
    return _public_config()


@app.get("/api/pois")
def get_pois() -> dict[str, Any]:
    poi_path = Path(settings["data"]["poi_geojson_path"])
    if not poi_path.exists():
        return {"type": "FeatureCollection", "features": []}

    try:
        with poi_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"Cannot read POI GeoJSON: {exc}") from exc

    if payload.get("type") != "FeatureCollection":
        raise HTTPException(status_code=500, detail="POI GeoJSON must be a FeatureCollection")
    return payload


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

    # Send the route JSON directly in the POST body.
    # This avoids query-string encoding differences in Valhalla/company forks.
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
        raise HTTPException(status_code=response.status_code, detail={"valhalla_status": response.status_code, "body": body})

    return body
