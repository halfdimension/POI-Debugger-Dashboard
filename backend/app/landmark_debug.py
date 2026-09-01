from __future__ import annotations

import json
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any


OSRM_DEBUG_SCHEMA = "osrm_landmark_turn_debug_v2"
OSRM_CANDIDATE_SOURCE = "incoming_outgoing_nbg_edge_association"
NORMALIZED_SCHEMA = "poi_candidate_analysis_v1"


class OsrmLandmarkDebugError(RuntimeError):
    pass


class OsrmLandmarkDebugManager:
    """Load and join extraction-time OSRM landmark debug evidence.

    The authoritative join key is the final extraction TurnData ID exposed
    at runtime as maneuver.turn_id.

    Candidate geometry and selector decisions are NEVER recomputed here.
    This class only validates, indexes and normalizes engine-produced
    evidence.
    """

    def __init__(
        self,
        settings: dict[str, Any],
        datasets: Any,
    ):
        self._settings = settings
        self._datasets = datasets
        self._lock = threading.RLock()

        self._cached_path: str | None = None
        self._cached_mtime_ns: int | None = None
        self._cached_size: int | None = None
        self._index: dict[int, dict[str, Any]] = {}
        self._record_count = 0

    # ------------------------------------------------------------------
    # Source resolution
    # ------------------------------------------------------------------

    def _configured_path(self) -> Path | None:
        active = self._datasets.active_config()

        value = (
            active.get("osrm_landmark_debug_jsonl_path")
            or self._settings.get("osrm", {}).get(
                "landmark_debug_jsonl_path"
            )
        )

        if not value:
            return None

        return Path(str(value))

    # ------------------------------------------------------------------
    # Cache/index
    # ------------------------------------------------------------------

    def _ensure_loaded(self) -> dict[str, Any]:
        path = self._configured_path()

        if path is None:
            raise OsrmLandmarkDebugError(
                "OSRM landmark debug JSONL is not configured"
            )

        try:
            stat = path.stat()
        except OSError as exc:
            raise OsrmLandmarkDebugError(
                f"OSRM landmark debug JSONL does not exist or "
                f"cannot be read: {path}: {exc}"
            ) from exc

        path_text = str(path)

        with self._lock:
            if (
                self._cached_path == path_text
                and self._cached_mtime_ns == stat.st_mtime_ns
                and self._cached_size == stat.st_size
            ):
                return {
                    "path": path_text,
                    "records": self._record_count,
                    "cache": "hit",
                }

            index: dict[int, dict[str, Any]] = {}
            records = 0

            try:
                with path.open("r", encoding="utf-8") as handle:
                    for line_number, line in enumerate(handle, 1):
                        if not line.strip():
                            continue

                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError as exc:
                            raise OsrmLandmarkDebugError(
                                f"Invalid JSON at {path}:{line_number}: {exc}"
                            ) from exc

                        if not isinstance(record, dict):
                            raise OsrmLandmarkDebugError(
                                f"{path}:{line_number}: expected JSON object"
                            )

                        if record.get("schema") != OSRM_DEBUG_SCHEMA:
                            raise OsrmLandmarkDebugError(
                                f"{path}:{line_number}: unexpected schema "
                                f"{record.get('schema')!r}"
                            )

                        selector = record.get("selector")

                        if not isinstance(selector, dict):
                            raise OsrmLandmarkDebugError(
                                f"{path}:{line_number}: v2 record has no "
                                f"selector object"
                            )

                        candidate_source = selector.get(
                            "candidate_source"
                        )

                        if candidate_source != OSRM_CANDIDATE_SOURCE:
                            raise OsrmLandmarkDebugError(
                                f"{path}:{line_number}: unexpected candidate "
                                f"source {candidate_source!r}; expected "
                                f"{OSRM_CANDIDATE_SOURCE!r}"
                            )

                        turn_id = record.get("turn_id")

                        if isinstance(turn_id, bool):
                            raise OsrmLandmarkDebugError(
                                f"{path}:{line_number}: invalid boolean turn_id"
                            )

                        try:
                            turn_id = int(turn_id)
                        except (TypeError, ValueError) as exc:
                            raise OsrmLandmarkDebugError(
                                f"{path}:{line_number}: invalid turn_id "
                                f"{record.get('turn_id')!r}"
                            ) from exc

                        if turn_id in index:
                            raise OsrmLandmarkDebugError(
                                f"{path}:{line_number}: duplicate turn_id "
                                f"{turn_id}"
                            )

                        index[turn_id] = record
                        records += 1

            except OSError as exc:
                raise OsrmLandmarkDebugError(
                    f"Cannot read OSRM landmark debug JSONL {path}: {exc}"
                ) from exc

            self._cached_path = path_text
            self._cached_mtime_ns = stat.st_mtime_ns
            self._cached_size = stat.st_size
            self._index = index
            self._record_count = records

            return {
                "path": path_text,
                "records": records,
                "cache": "reload",
            }

    # ------------------------------------------------------------------
    # Normalization
    # ------------------------------------------------------------------

    @staticmethod
    def _normalized_status(raw: str) -> str:
        mapping = {
            "selected": "SELECTED",
            "eligible_not_selected": "ELIGIBLE / LOST RANKING",
            "rejected": "REJECTED",
        }
        return mapping.get(raw, raw.upper() if raw else "UNKNOWN")

    @staticmethod
    def _rejection_reasons(
        candidate: dict[str, Any],
        selector: dict[str, Any],
    ) -> list[dict[str, Any]]:
        if candidate.get("status") != "rejected":
            return []

        code = str(candidate.get("reason_code") or "")
        text = str(candidate.get("reason") or "")

        reason: dict[str, Any] = {
            "code": code,
            "text": text,
        }

        # Do not recreate selector logic here.
        #
        # Only attach structured values already emitted by the v2
        # extraction sidecar. The engine remains authoritative.
        if (
            "maneuver_distance" in code
            and candidate.get("maneuver_distance_m") is not None
        ):
            reason.update({
                "actual": candidate.get("maneuver_distance_m"),
                "operator": ">",
                "threshold": selector.get(
                    "max_maneuver_distance_m"
                ),
                "unit": "m",
            })

        elif (
            "perpendicular_distance" in code
            and candidate.get("perpendicular_distance_m") is not None
        ):
            reason.update({
                "actual": candidate.get(
                    "perpendicular_distance_m"
                ),
                "operator": ">",
                "threshold": selector.get(
                    "max_perpendicular_distance_m"
                ),
                "unit": "m",
            })

        elif code == "minimum_priority":
            reason.update({
                "actual": candidate.get("priority"),
                "operator": "<",
                "threshold": selector.get("minimum_priority"),
            })

        elif code == "visibility_required":
            reason.update({
                "actual": candidate.get("visible"),
                "required": "yes",
            })

        elif code == "empty_name":
            reason.update({
                "actual": candidate.get("name"),
                "required": "non-empty",
            })

        return [reason]

    @classmethod
    def _normalize_candidate(
        cls,
        candidate: dict[str, Any],
        selector: dict[str, Any],
    ) -> dict[str, Any]:
        raw_status = str(candidate.get("status") or "")
        selected = bool(candidate.get("selected"))
        eligible = bool(candidate.get("eligible"))

        result: dict[str, Any] = {
            "poi_id": candidate.get("poi_id"),
            "osm_node_id": candidate.get("osm_node_id"),
            "name": candidate.get("name"),
            "type": candidate.get("type"),
            "coordinate": deepcopy(candidate.get("coordinate")),
            "priority": candidate.get("priority"),
            "priority_raw": candidate.get("priority_raw"),
            "visible": candidate.get("visible"),

            # Authoritative v2 route-edge membership.
            "on_incoming": candidate.get("on_incoming"),
            "on_outgoing": candidate.get("on_outgoing"),

            # P2 association provenance emitted directly by OSRM.
            #
            # Do not derive these values in the debugger.
            # None is preserved for older sidecars that predate
            # provenance support.
            "incoming_association_augmented": candidate.get(
                "incoming_association_augmented"
            ),
            "outgoing_association_augmented": candidate.get(
                "outgoing_association_augmented"
            ),
            "association_augmented": candidate.get(
                "association_augmented"
            ),

            # Role-specific longitudinal evidence.
            "incoming_distance_to_turn_m": candidate.get(
                "incoming_distance_to_turn_m"
            ),
            "outgoing_distance_from_turn_m": candidate.get(
                "outgoing_distance_from_turn_m"
            ),

            # Role-specific lateral road-projection evidence.
            "incoming_perpendicular_distance_m": candidate.get(
                "incoming_perpendicular_distance_m"
            ),
            "outgoing_perpendicular_distance_m": candidate.get(
                "outgoing_perpendicular_distance_m"
            ),

            # Values actually used by the maneuver selector.
            "maneuver_distance_m": candidate.get(
                "maneuver_distance_m"
            ),
            "perpendicular_distance_m": candidate.get(
                "perpendicular_distance_m"
            ),

            "eligible": eligible,
            "selected": selected,
            "status": cls._normalized_status(raw_status),
            "engine_status": raw_status,
            "reason_code": candidate.get("reason_code"),
            "reason": candidate.get("reason"),
            "rejection_reasons": cls._rejection_reasons(
                candidate,
                selector,
            ),
        }

        # Ranking loss is not a rejection. Keep the exact engine reason
        # separately; the debugger does not recompute ranking.
        if raw_status == "eligible_not_selected":
            result["ranking_reason"] = {
                "code": candidate.get("reason_code"),
                "text": candidate.get("reason"),
            }
        else:
            result["ranking_reason"] = None

        return result

    @classmethod
    def _normalize_record(
        cls,
        record: dict[str, Any],
        *,
        leg_index: int,
        step_index: int,
        route_maneuver: dict[str, Any],
    ) -> dict[str, Any]:
        selector = record.get("selector")
        if not isinstance(selector, dict):
            selector = {}

        candidates = record.get("candidates")
        if not isinstance(candidates, list):
            candidates = []

        normalized_candidates = [
            cls._normalize_candidate(candidate, selector)
            for candidate in candidates
            if isinstance(candidate, dict)
        ]

        selected_candidates = [
            candidate
            for candidate in normalized_candidates
            if candidate["selected"]
        ]

        warnings: list[str] = []

        if len(selected_candidates) > 1:
            warnings.append(
                "debug record contains more than one selected candidate"
            )

        selected_poi_id = record.get("selected_poi_id")

        if selected_candidates:
            candidate_poi_id = selected_candidates[0].get("poi_id")
            if candidate_poi_id != selected_poi_id:
                warnings.append(
                    "selected_poi_id does not match selected candidate"
                )
        elif selected_poi_id is not None:
            warnings.append(
                "selected_poi_id is set but no candidate is selected"
            )

        return {
            "engine": "osrm",
            "matched": True,
            "leg_index": leg_index,
            "step_index": step_index,
            "identity": {
                "turn_id": record.get("turn_id"),
                "intersection_node": record.get("intersection_node"),
                "delayed": bool(record.get("delayed")),
            },
            # Raw extraction-time geometry. This is intentionally not
            # reconstructed from route JSON.
            "maneuver": deepcopy(record.get("maneuver")),
            "route_maneuver": {
                "type": route_maneuver.get("type"),
                "modifier": route_maneuver.get("modifier"),
                "location": deepcopy(route_maneuver.get("location")),
                "bearing_before": route_maneuver.get("bearing_before"),
                "bearing_after": route_maneuver.get("bearing_after"),
                "maneuver_id": route_maneuver.get("maneuver_id"),
                "turn_id": route_maneuver.get("turn_id"),
                "instruction": route_maneuver.get("instruction"),
            },
            "selector": deepcopy(selector),
            "selected_poi_id": selected_poi_id,
            "candidates": normalized_candidates,
            "warnings": warnings,
        }

    # ------------------------------------------------------------------
    # Public route join
    # ------------------------------------------------------------------

    def analyze_route(
        self,
        route_response: dict[str, Any],
    ) -> dict[str, Any]:
        base: dict[str, Any] = {
            "schema": NORMALIZED_SCHEMA,
            "engine": "osrm",
            "available": False,
            "source": None,
            "summary": {
                "route_steps": 0,
                "route_maneuvers_with_turn_id": 0,
                "matched_turns": 0,
                "unmatched_turns": 0,
                "candidate_decisions": 0,
                "selected_candidates": 0,
                "eligible_not_selected": 0,
                "rejected_candidates": 0,
            },
            "maneuvers": [],
            "warnings": [],
            "error": None,
        }

        try:
            source = self._ensure_loaded()
        except OsrmLandmarkDebugError as exc:
            base["error"] = str(exc)
            return base

        base["available"] = True
        base["source"] = source

        routes = route_response.get("routes")

        if not isinstance(routes, list) or not routes:
            base["warnings"].append(
                "OSRM response contains no routes"
            )
            return base

        route = routes[0]
        legs = route.get("legs")

        if not isinstance(legs, list):
            base["warnings"].append(
                "OSRM first route contains no legs array"
            )
            return base

        maneuvers: list[dict[str, Any]] = []

        with self._lock:
            index = self._index

            for leg_index, leg in enumerate(legs):
                if not isinstance(leg, dict):
                    continue

                steps = leg.get("steps")
                if not isinstance(steps, list):
                    continue

                for step_index, step in enumerate(steps):
                    if not isinstance(step, dict):
                        continue

                    base["summary"]["route_steps"] += 1

                    maneuver = step.get("maneuver")
                    if not isinstance(maneuver, dict):
                        continue

                    if "turn_id" not in maneuver:
                        continue

                    base["summary"][
                        "route_maneuvers_with_turn_id"
                    ] += 1

                    try:
                        turn_id = int(maneuver["turn_id"])
                    except (TypeError, ValueError):
                        base["summary"]["unmatched_turns"] += 1
                        maneuvers.append({
                            "engine": "osrm",
                            "matched": False,
                            "leg_index": leg_index,
                            "step_index": step_index,
                            "identity": {
                                "turn_id": maneuver.get("turn_id"),
                            },
                            "route_maneuver": deepcopy(maneuver),
                            "error": "route maneuver turn_id is not an integer",
                        })
                        continue

                    record = index.get(turn_id)

                    if record is None:
                        base["summary"]["unmatched_turns"] += 1
                        maneuvers.append({
                            "engine": "osrm",
                            "matched": False,
                            "leg_index": leg_index,
                            "step_index": step_index,
                            "identity": {
                                "turn_id": turn_id,
                            },
                            "route_maneuver": deepcopy(maneuver),
                            "error": (
                                "turn_id not present in configured "
                                "extraction debug sidecar"
                            ),
                        })
                        continue

                    normalized = self._normalize_record(
                        record,
                        leg_index=leg_index,
                        step_index=step_index,
                        route_maneuver=maneuver,
                    )

                    maneuvers.append(normalized)
                    base["summary"]["matched_turns"] += 1

                    for candidate in normalized["candidates"]:
                        base["summary"]["candidate_decisions"] += 1

                        status = candidate["engine_status"]

                        if status == "selected":
                            base["summary"]["selected_candidates"] += 1
                        elif status == "eligible_not_selected":
                            base["summary"][
                                "eligible_not_selected"
                            ] += 1
                        elif status == "rejected":
                            base["summary"]["rejected_candidates"] += 1

        base["maneuvers"] = maneuvers

        return base
