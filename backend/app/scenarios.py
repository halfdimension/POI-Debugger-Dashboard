from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class ScenarioError(RuntimeError):
    pass


_SLUG_RE = re.compile(r"[^a-z0-9]+")
_VALID_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _slugify(value: str) -> str:
    slug = _SLUG_RE.sub("-", value.strip().lower()).strip("-")
    return slug[:72].rstrip("-") or "scenario"


def _number(value: Any, label: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ScenarioError(f"{label} must be a number") from exc
    return result


def _validate_point(value: Any, label: str) -> dict[str, float]:
    if not isinstance(value, dict):
        raise ScenarioError(f"{label} must be an object with lon and lat")
    lon = _number(value.get("lon"), f"{label}.lon")
    lat = _number(value.get("lat"), f"{label}.lat")
    if not -180 <= lon <= 180:
        raise ScenarioError(f"{label}.lon must be between -180 and 180")
    if not -90 <= lat <= 90:
        raise ScenarioError(f"{label}.lat must be between -90 and 90")
    return {"lon": lon, "lat": lat}


class ScenarioManager:
    """File-backed route scenarios for local/debug use.

    Each scenario is deliberately stored as one JSON file so it remains human-readable,
    git-diffable, and usable later by a headless regression runner.
    """

    def __init__(self, settings: dict[str, Any]):
        directory = str(settings.get("scenarios", {}).get("directory", "")).strip()
        if not directory:
            raise ScenarioError("scenarios.directory is not configured")
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def _path(self, scenario_id: str) -> Path:
        if not _VALID_ID_RE.fullmatch(scenario_id):
            raise ScenarioError(f"Invalid scenario id: {scenario_id}")
        return self.directory / f"{scenario_id}.json"

    def _read_path(self, path: Path) -> dict[str, Any]:
        try:
            with path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            raise ScenarioError(f"Cannot read scenario {path.name}: {exc}") from exc
        if not isinstance(payload, dict):
            raise ScenarioError(f"Scenario file must contain a JSON object: {path.name}")
        return payload

    def list(self) -> dict[str, Any]:
        scenarios: list[dict[str, Any]] = []
        errors: list[str] = []
        for path in sorted(self.directory.glob("*.json")):
            try:
                scenario = self._read_path(path)
                scenarios.append(scenario)
            except ScenarioError as exc:
                errors.append(str(exc))
        scenarios.sort(key=lambda item: (str(item.get("name", "")).lower(), str(item.get("id", ""))))
        return {
            "directory": str(self.directory),
            "count": len(scenarios),
            "scenarios": scenarios,
            "errors": errors,
        }

    def get(self, scenario_id: str) -> dict[str, Any]:
        path = self._path(scenario_id)
        if not path.exists():
            raise ScenarioError(f"Scenario not found: {scenario_id}")
        return self._read_path(path)

    def _normalized(self, payload: dict[str, Any], *, scenario_id: str, created_at: str | None = None) -> dict[str, Any]:
        name = str(payload.get("name", "")).strip()
        if not name:
            raise ScenarioError("Scenario name is required")

        dataset = str(payload.get("dataset", "")).strip()
        if not dataset:
            raise ScenarioError("Scenario dataset is required")

        request = payload.get("request")
        if not isinstance(request, dict):
            raise ScenarioError("Scenario request is required")

        start = _validate_point(request.get("start"), "request.start")
        end = _validate_point(request.get("end"), "request.end")
        costing = str(request.get("costing", "auto")).strip() or "auto"

        now = _utc_now()
        result: dict[str, Any] = {
            "id": scenario_id,
            "name": name,
            "dataset": dataset,
            "request": {
                "start": start,
                "end": end,
                "costing": costing,
            },
            "created_at": created_at or now,
            "updated_at": now,
        }

        notes = str(payload.get("notes", "")).strip()
        if notes:
            result["notes"] = notes

        return result

    def _write(self, scenario: dict[str, Any]) -> dict[str, Any]:
        path = self._path(str(scenario["id"]))
        temp = path.with_suffix(".json.tmp")
        try:
            temp.write_text(json.dumps(scenario, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            temp.replace(path)
        except OSError as exc:
            try:
                temp.unlink(missing_ok=True)
            except OSError:
                pass
            raise ScenarioError(f"Cannot write scenario {path.name}: {exc}") from exc
        return scenario

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name", "")).strip()
        if not name:
            raise ScenarioError("Scenario name is required")

        base_id = _slugify(name)
        scenario_id = base_id
        suffix = 2
        while self._path(scenario_id).exists():
            suffix_text = f"-{suffix}"
            scenario_id = f"{base_id[:80-len(suffix_text)]}{suffix_text}"
            suffix += 1

        scenario = self._normalized(payload, scenario_id=scenario_id)
        return self._write(scenario)

    def update(self, scenario_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        existing = self.get(scenario_id)
        merged = dict(existing)
        merged.update(payload)
        scenario = self._normalized(
            merged,
            scenario_id=scenario_id,
            created_at=str(existing.get("created_at") or _utc_now()),
        )
        return self._write(scenario)

    def delete(self, scenario_id: str) -> None:
        path = self._path(scenario_id)
        if not path.exists():
            raise ScenarioError(f"Scenario not found: {scenario_id}")
        try:
            path.unlink()
        except OSError as exc:
            raise ScenarioError(f"Cannot delete scenario {scenario_id}: {exc}") from exc
