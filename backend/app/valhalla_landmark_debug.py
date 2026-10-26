from __future__ import annotations

import json
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any


ASSOCIATION_SCHEMA = "valhalla_landmark_association_debug_v1"
NORMALIZED_SCHEMA = "poi_candidate_analysis_v1"


class ValhallaLandmarkDebugError(RuntimeError):
    pass


class ValhallaLandmarkDebugManager:
    """Normalize Valhalla route-time Odin landmark decisions.

    Runtime landmark_debug is authoritative for Odin maneuver selection.

    The optional association JSONL is separate build-time Mjolnir evidence.
    It is joined by POI ID and the exact route-associated graph ID.

    Because EdgeInfo is shared by opposing DirectedEdges, a route graph ID
    is considered a match when it equals either the build event's edge
    graph_id OR opposing_edge graph_id.
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
        self._index: dict[str, list[dict[str, Any]]] = {}
        self._record_count = 0

    # -----------------------------------------------------------------
    # Build-time association sidecar
    # -----------------------------------------------------------------

    def _configured_path(self, dataset_id: str) -> Path | None:
        active = self._datasets.config(dataset_id)

        value = (
            active.get("valhalla_association_debug_jsonl_path")
            or self._settings.get("valhalla", {}).get(
                "association_debug_jsonl_path"
            )
        )

        return Path(str(value)) if value else None

    def _ensure_loaded(self, dataset_id: str) -> dict[str, Any]:
        path = self._configured_path(dataset_id)

        if path is None:
            raise ValhallaLandmarkDebugError(
                "Valhalla association debug JSONL is not configured"
            )

        try:
            stat = path.stat()
        except OSError as exc:
            raise ValhallaLandmarkDebugError(
                f"Valhalla association debug JSONL cannot be read: "
                f"{path}: {exc}"
            ) from exc

        path_text = str(path)

        with self._lock:
            if (
                self._cached_path == path_text
                and self._cached_mtime_ns == stat.st_mtime_ns
                and self._cached_size == stat.st_size
            ):
                return {
                    "available": True,
                    "path": path_text,
                    "records": self._record_count,
                    "pois": len(self._index),
                    "cache": "hit",
                }

            index: dict[str, list[dict[str, Any]]] = {}
            records = 0

            try:
                with path.open("r", encoding="utf-8") as handle:
                    for line_number, line in enumerate(handle, 1):
                        if not line.strip():
                            continue

                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError as exc:
                            raise ValhallaLandmarkDebugError(
                                f"Invalid JSON at {path}:{line_number}: {exc}"
                            ) from exc

                        if not isinstance(record, dict):
                            raise ValhallaLandmarkDebugError(
                                f"{path}:{line_number}: expected JSON object"
                            )

                        if record.get("schema") != ASSOCIATION_SCHEMA:
                            raise ValhallaLandmarkDebugError(
                                f"{path}:{line_number}: unexpected schema "
                                f"{record.get('schema')!r}"
                            )

                        poi_id = str(record.get("poi_id") or "").strip()

                        if not poi_id:
                            raise ValhallaLandmarkDebugError(
                                f"{path}:{line_number}: missing poi_id"
                            )

                        index.setdefault(poi_id, []).append(record)
                        records += 1

            except OSError as exc:
                raise ValhallaLandmarkDebugError(
                    f"Cannot read Valhalla association sidecar "
                    f"{path}: {exc}"
                ) from exc

            self._cached_path = path_text
            self._cached_mtime_ns = stat.st_mtime_ns
            self._cached_size = stat.st_size
            self._index = index
            self._record_count = records

            return {
                "available": True,
                "path": path_text,
                "records": records,
                "pois": len(index),
                "cache": "reload",
            }

    @staticmethod
    def _graph_id(value: Any) -> int | None:
        if isinstance(value, bool):
            return None

        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @classmethod
    def _event_match_kind(
        cls,
        event: dict[str, Any],
        route_graph_id: int,
    ) -> str | None:
        edge = event.get("edge")
        opposing = event.get("opposing_edge")

        if isinstance(edge, dict):
            if cls._graph_id(edge.get("graph_id")) == route_graph_id:
                return "edge"

        if isinstance(opposing, dict):
            if cls._graph_id(opposing.get("graph_id")) == route_graph_id:
                return "opposing_edge"

        return None

    @staticmethod
    def _compact_event(event: dict[str, Any]) -> dict[str, Any]:
        return {
            "pass": event.get("pass"),
            "stage": event.get("stage"),
            "status": event.get("status"),
            "reason": event.get("reason"),
            "policy": deepcopy(event.get("policy")),
            "edge": deepcopy(event.get("edge")),
            "opposing_edge": deepcopy(event.get("opposing_edge")),
            "road_name": event.get("road_name"),
            "distance_m": event.get("distance_m"),
            "classification": event.get("classification"),
            "superseded": event.get("superseded"),
            "link": event.get("link"),
        }

    def _association_evidence(
        self,
        candidate: dict[str, Any],
        *,
        sidecar_available: bool,
        sidecar_error: str | None,
    ) -> dict[str, Any]:
        runtime = candidate.get("association")

        result: dict[str, Any] = {
            "runtime": deepcopy(runtime) if isinstance(runtime, dict) else None,
            "build": {
                "available": sidecar_available,
                "matched": False,
                "match_kind": None,
                "poi_event_count": 0,
                "selected_association_count": 0,
                "selected_event": None,
                "selected_associations": [],
                "route_edge_event_count": 0,
                "route_edge_events": [],
                "warnings": [],
                "error": sidecar_error,
            },
        }

        build = result["build"]

        if not sidecar_available:
            return result

        poi_id = str(candidate.get("poi_id") or "")
        rows = self._index.get(poi_id, [])

        build["poi_event_count"] = len(rows)

        selected_events = [
            row
            for row in rows
            if (
                row.get("stage") == "final_selection"
                and row.get("status") == "selected"
            )
        ]

        build["selected_association_count"] = len(selected_events)
        build["selected_associations"] = [
            self._compact_event(row)
            for row in selected_events
        ]

        if not isinstance(runtime, dict):
            build["warnings"].append(
                "runtime candidate has no association provenance"
            )
            return result

        route_graph_id = self._graph_id(runtime.get("graph_id"))

        if route_graph_id is None:
            build["warnings"].append(
                "runtime association has no valid graph_id"
            )
            return result

        route_events: list[tuple[str, dict[str, Any]]] = []

        for row in rows:
            kind = self._event_match_kind(
                row,
                route_graph_id,
            )

            if kind is not None:
                route_events.append((kind, row))

        build["route_edge_event_count"] = len(route_events)
        build["route_edge_events"] = [
            {
                "match_kind": kind,
                **self._compact_event(row),
            }
            for kind, row in route_events
        ]

        matching_selected = [
            (kind, row)
            for kind, row in route_events
            if (
                row.get("stage") == "final_selection"
                and row.get("status") == "selected"
            )
        ]

        if len(matching_selected) == 1:
            kind, row = matching_selected[0]
            build["matched"] = True
            build["match_kind"] = kind
            build["selected_event"] = self._compact_event(row)

        elif len(matching_selected) > 1:
            build["matched"] = True
            build["match_kind"] = "multiple"
            build["selected_event"] = self._compact_event(
                matching_selected[0][1]
            )
            build["warnings"].append(
                "multiple selected build associations match runtime graph_id"
            )

        else:
            build["warnings"].append(
                "no selected build association matches runtime graph_id "
                "or its opposing DirectedEdge"
            )

        return result

    # -----------------------------------------------------------------
    # Runtime Odin selection normalization
    # -----------------------------------------------------------------

    @staticmethod
    def _normalized_status(raw_status: str) -> str:
        mapping = {
            "selected": "SELECTED",
            "eligible_not_selected": "ELIGIBLE / LOST RANKING",
            "deduplicated": "DEDUPLICATED",
            "rejected": "REJECTED",
            "invalid": "REJECTED",
        }

        return mapping.get(
            raw_status,
            raw_status.upper() if raw_status else "UNKNOWN",
        )

    def _normalize_candidate(
        self,
        candidate: dict[str, Any],
        *,
        sidecar_available: bool,
        sidecar_error: str | None,
    ) -> dict[str, Any]:
        selected = bool(candidate.get("selected"))
        raw_status = str(candidate.get("status") or "")

        if selected and not raw_status:
            raw_status = "selected"

        location = candidate.get("location")
        coordinate = None

        if isinstance(location, dict):
            lon = location.get("lon")
            lat = location.get("lat")

            if lon is not None and lat is not None:
                coordinate = [lon, lat]

        if raw_status in ("selected", "eligible_not_selected"):
            eligible: bool | None = True
        elif raw_status in ("rejected", "invalid"):
            eligible = False
        else:
            # A deduplicated candidate was valid before deduplication,
            # therefore forcing eligible=True/False would be misleading.
            eligible = None

        reason = candidate.get("reason")

        rejection_reasons = []

        if raw_status in ("rejected", "invalid"):
            rejection_reasons.append({
                "code": raw_status,
                "text": reason,
            })

        ranking_reason = None
        if raw_status == "eligible_not_selected":
            ranking_reason = {
                "code": "ranking",
                "text": reason,
            }

        deduplication_reason = None
        if raw_status == "deduplicated":
            deduplication_reason = {
                "code": "deduplicated",
                "text": reason,
            }

        return {
            "poi_id": candidate.get("poi_id"),
            "name": candidate.get("name"),
            "type": candidate.get("type"),
            "coordinate": coordinate,
            "location": deepcopy(location),
            "priority": candidate.get("priority"),
            "visible": None,
            "distance_m": candidate.get("distance_to_maneuver_m"),
            "distance_to_maneuver_m": candidate.get(
                "distance_to_maneuver_m"
            ),
            "right": candidate.get("right"),

            # Not exposed authoritatively by current Valhalla runtime debug.
            "poi_bearing_deg": None,
            "bearing_deviation_deg": None,

            "eligible": eligible,
            "selected": selected,
            "status": self._normalized_status(raw_status),
            "engine_status": raw_status,
            "reason": reason,
            "ranking_reason": ranking_reason,
            "deduplication_reason": deduplication_reason,
            "rejection_reasons": rejection_reasons,

            # Keep Mjolnir association conceptually separate from Odin
            # maneuver selection.
            "association": self._association_evidence(
                candidate,
                sidecar_available=sidecar_available,
                sidecar_error=sidecar_error,
            ),
        }

    # -----------------------------------------------------------------
    # Public route analysis
    # -----------------------------------------------------------------

    def analyze_route(
        self,
        route_response: dict[str, Any],
        dataset_id: str,
    ) -> dict[str, Any]:
        # Keep the selected sidecar/index stable for this entire normalization.
        with self._lock:
            return self._analyze_route_locked(route_response, dataset_id)

    def _analyze_route_locked(
        self,
        route_response: dict[str, Any],
        dataset_id: str,
    ) -> dict[str, Any]:

        base: dict[str, Any] = {
            "schema": NORMALIZED_SCHEMA,
            "engine": "valhalla",
            "available": False,
            "source": {
                "route_debug": "embedded landmark_debug",
                "association": None,
            },
            "summary": {
                "route_maneuvers": 0,
                "maneuvers_with_landmark_debug": 0,
                "candidate_decisions": 0,
                "selected_candidates": 0,
                "eligible_not_selected": 0,
                "deduplicated_candidates": 0,
                "rejected_candidates": 0,
                "association_matches": 0,
                "association_direct_matches": 0,
                "association_opposing_matches": 0,
                "association_unmatched": 0,
            },
            "maneuvers": [],
            "warnings": [],
            "limitations": [
                (
                    "Current Valhalla landmark_debug does not expose an "
                    "authoritative maneuver coordinate or incoming/outgoing "
                    "bearings; the backend does not derive them."
                )
            ],
            "error": None,
        }

        sidecar_available = False
        sidecar_error = None

        try:
            association_source = self._ensure_loaded(dataset_id)
            sidecar_available = True
        except ValhallaLandmarkDebugError as exc:
            sidecar_error = str(exc)
            association_source = {
                "available": False,
                "error": sidecar_error,
            }

        base["source"]["association"] = association_source

        trip = route_response.get("trip")

        if not isinstance(trip, dict):
            base["error"] = "Valhalla response contains no trip object"
            return base

        legs = trip.get("legs")

        if not isinstance(legs, list):
            base["error"] = "Valhalla trip contains no legs array"
            return base

        base["available"] = True

        normalized_maneuvers = []

        for leg_index, leg in enumerate(legs):
            if not isinstance(leg, dict):
                continue

            maneuvers = leg.get("maneuvers")

            if not isinstance(maneuvers, list):
                continue

            for maneuver_index, maneuver in enumerate(maneuvers):
                if not isinstance(maneuver, dict):
                    continue

                base["summary"]["route_maneuvers"] += 1

                debug = maneuver.get("landmark_debug")

                if not isinstance(debug, dict):
                    continue

                base["summary"][
                    "maneuvers_with_landmark_debug"
                ] += 1

                candidates = debug.get("candidates")
                if not isinstance(candidates, list):
                    candidates = []

                normalized_candidates = [
                    self._normalize_candidate(
                        candidate,
                        sidecar_available=sidecar_available,
                        sidecar_error=sidecar_error,
                    )
                    for candidate in candidates
                    if isinstance(candidate, dict)
                ]

                warnings = []

                candidate_count = debug.get("candidate_count")

                if (
                    isinstance(candidate_count, int)
                    and candidate_count != len(normalized_candidates)
                ):
                    warnings.append(
                        "candidate_count does not match candidates array length"
                    )

                selected_object = debug.get("selected")
                selected_poi_id = None

                if isinstance(selected_object, dict):
                    selected_poi_id = selected_object.get("poi_id")

                selected_candidates = [
                    candidate
                    for candidate in normalized_candidates
                    if candidate["selected"]
                ]

                if len(selected_candidates) > 1:
                    warnings.append(
                        "more than one Odin candidate is marked selected"
                    )

                if selected_candidates:
                    if (
                        selected_candidates[0].get("poi_id")
                        != selected_poi_id
                    ):
                        warnings.append(
                            "selected object does not match selected candidate"
                        )
                elif selected_poi_id is not None:
                    warnings.append(
                        "selected object exists but no candidate is selected"
                    )

                for candidate in normalized_candidates:
                    summary = base["summary"]

                    summary["candidate_decisions"] += 1

                    status = candidate["engine_status"]

                    if status == "selected":
                        summary["selected_candidates"] += 1
                    elif status == "eligible_not_selected":
                        summary["eligible_not_selected"] += 1
                    elif status == "deduplicated":
                        summary["deduplicated_candidates"] += 1
                    elif status in ("rejected", "invalid"):
                        summary["rejected_candidates"] += 1

                    build = candidate["association"]["build"]

                    if sidecar_available:
                        if build["matched"]:
                            summary["association_matches"] += 1

                            if build["match_kind"] == "edge":
                                summary[
                                    "association_direct_matches"
                                ] += 1
                            elif build["match_kind"] == "opposing_edge":
                                summary[
                                    "association_opposing_matches"
                                ] += 1
                        else:
                            summary["association_unmatched"] += 1

                normalized_maneuvers.append({
                    "engine": "valhalla",
                    "matched": True,
                    "leg_index": leg_index,
                    "maneuver_index": maneuver_index,

                    # Explicitly unavailable rather than reconstructed.
                    "maneuver": {
                        "coordinate": None,
                        "incoming_bearing": None,
                        "outgoing_bearing": None,
                    },

                    "route_maneuver": {
                        "type": maneuver.get("type"),
                        "instruction": maneuver.get("instruction"),
                        "begin_shape_index": maneuver.get(
                            "begin_shape_index"
                        ),
                        "end_shape_index": maneuver.get(
                            "end_shape_index"
                        ),
                        "begin_heading": maneuver.get("begin_heading"),
                    },

                    "selector": deepcopy(
                        debug.get("selection_policy")
                    ),

                    "selected_poi_id": selected_poi_id,
                    "selected": deepcopy(selected_object),
                    "candidates": normalized_candidates,
                    "warnings": warnings,
                })

        base["maneuvers"] = normalized_maneuvers

        return base
