"""Reproducible synthetic benchmark for the persistent SQLite POI index."""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import statistics
import sys
import tempfile
import time
import tracemalloc
from contextlib import closing
from pathlib import Path
from typing import Any, Callable

try:
    import resource
except ImportError:  # pragma: no cover - unavailable on Windows
    resource = None  # type: ignore[assignment]

from backend.app.poi_search import PoiSearchIndex


def _generate_source(path: Path, rows: int) -> float:
    started = time.perf_counter()
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            (
                "new_node_id",
                "mappls_poi_id",
                "name",
                "landmark_type",
                "priority",
                "visible",
                "lat",
                "lon",
                "osm_source_id",
            )
        )
        for number in range(rows):
            writer.writerow(
                (
                    f"node-{number}",
                    f"poi-{number}",
                    f"Generated school {number}",
                    "school" if number % 2 else "fuel",
                    number % 101,
                    "yes",
                    8 + (number % 2800) / 100,
                    68 + (number % 2900) / 100,
                    f"osm-{number}",
                )
            )
    return time.perf_counter() - started


def _measure(
    callback: Callable[[], dict[str, Any]], iterations: int
) -> tuple[dict[str, Any], dict[str, float | int]]:
    durations: list[float] = []
    result: dict[str, Any] = {}
    for _ in range(iterations):
        started = time.perf_counter()
        result = callback()
        durations.append(time.perf_counter() - started)
    ordered = sorted(durations)
    tail_index = max(0, min(len(ordered) - 1, int(0.95 * len(ordered) + 0.999999) - 1))
    return result, {
        "median_ms": statistics.median(durations) * 1_000,
        "p95_ms": ordered[tail_index] * 1_000,
        "returned": result["returned"],
        "response_bytes": len(json.dumps(result, separators=(",", ":")).encode("utf-8")),
    }


def _query_plans(db_path: Path) -> dict[str, list[str]]:
    uri = db_path.resolve().as_uri() + "?mode=ro"
    plans: dict[str, list[str]] = {}

    def explain(name: str, sql: str, params: tuple[Any, ...]) -> None:
        with closing(sqlite3.connect(uri, uri=True)) as connection:
            plans[name] = [
                str(row[3])
                for row in connection.execute("EXPLAIN QUERY PLAN " + sql, params)
            ]

    ranked_select = (
        "SELECT p.id FROM pois p JOIN poi_fts ON poi_fts.rowid=p.id "
        "WHERE poi_fts.search_text LIKE ? "
        "ORDER BY CASE WHEN p.name_norm LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END DESC, "
        "COALESCE(p.priority,-1) DESC, p.name_norm, p.id LIMIT ?"
    )
    explain(
        "specific_text_candidate_probe",
        "SELECT 1 FROM pois p JOIN poi_fts ON poi_fts.rowid=p.id "
        "WHERE poi_fts.search_text LIKE ? LIMIT 1 OFFSET ?",
        ("%school 99999%", 1_000),
    )
    explain(
        "specific_text_ranked",
        ranked_select,
        ("%school 99999%", "school 99999%", 101),
    )
    explain(
        "broad_text_preoptimization_sort",
        ranked_select,
        ("%generated school%", "generated school%", 101),
    )
    explain(
        "broad_text_rank_scan",
        "SELECT p.id FROM pois p INDEXED BY pois_rank "
        "WHERE p.search_text LIKE ? AND p.name_norm LIKE ? ESCAPE '\\' "
        "ORDER BY COALESCE(p.priority,-1) DESC, p.name_norm, p.id LIMIT ?",
        ("%generated school%", "generated school%", 101),
    )
    explain(
        "bbox",
        "SELECT p.id FROM pois p JOIN poi_geo g ON g.id=p.id "
        "WHERE g.max_lon>=? AND g.min_lon<=? AND g.max_lat>=? AND g.min_lat<=? "
        "AND p.lon>=? AND p.lon<=? AND p.lat>=? AND p.lat<=? ORDER BY p.id LIMIT ?",
        (76.9, 77.3, 27.9, 28.3, 76.9, 77.3, 27.9, 28.3, 101),
    )
    explain(
        "text_bbox",
        "SELECT p.id FROM pois p JOIN poi_geo g ON g.id=p.id "
        "WHERE p.search_text LIKE ? AND g.max_lon>=? AND g.min_lon<=? "
        "AND g.max_lat>=? AND g.min_lat<=? AND p.lon>=? AND p.lon<=? "
        "AND p.lat>=? AND p.lat<=? "
        "ORDER BY CASE WHEN p.name_norm LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END DESC, "
        "COALESCE(p.priority,-1) DESC, p.name_norm, p.id LIMIT ?",
        ("%school%", 76.9, 77.3, 27.9, 28.3, 76.9, 77.3, 27.9, 28.3, "school%", 101),
    )
    explain(
        "text_priority_candidate_probe",
        "SELECT 1 FROM pois p JOIN poi_fts ON poi_fts.rowid=p.id "
        "WHERE poi_fts.search_text LIKE ? AND p.priority>=? LIMIT 1 OFFSET ?",
        ("%school%", 80, 1_000),
    )
    explain(
        "text_priority_rank_scan",
        "SELECT p.id FROM pois p INDEXED BY pois_rank "
        "WHERE p.search_text LIKE ? AND p.priority>=? "
        "AND NOT (p.name_norm LIKE ? ESCAPE '\\') "
        "ORDER BY COALESCE(p.priority,-1) DESC, p.name_norm, p.id LIMIT ?",
        ("%school%", 80, "school%", 101),
    )
    explain(
        "short_text_candidate_probe",
        "SELECT 1 FROM pois p JOIN poi_fts ON poi_fts.rowid=p.id "
        "WHERE poi_fts.search_text LIKE ? LIMIT 1 OFFSET ?",
        ("%a%", 1_000),
    )
    explain(
        "short_text_rank_scan",
        "SELECT p.id FROM pois p INDEXED BY pois_rank "
        "WHERE p.search_text LIKE ? AND p.name_norm LIKE ? ESCAPE '\\' "
        "ORDER BY COALESCE(p.priority,-1) DESC, p.name_norm, p.id LIMIT ?",
        ("%a%", "a%", 101),
    )
    explain(
        "literal_special",
        ranked_select.replace("LIKE ? ", "LIKE ? ESCAPE '\\' ", 1),
        (r"%\%%", r"\%%", 101),
    )
    explain(
        "name_prefix_probe",
        "SELECT 1 FROM pois p INDEXED BY pois_name_prefix "
        "WHERE p.search_text LIKE ? AND p.name_norm LIKE ? ESCAPE '\\' LIMIT 1",
        ("%school%", "school%"),
    )
    explain(
        "later_page_rank_scan",
        "SELECT p.id FROM pois p INDEXED BY pois_rank WHERE p.search_text LIKE ? "
        "AND p.name_norm LIKE ? ESCAPE '\\' AND (COALESCE(p.priority,-1)<? "
        "OR (COALESCE(p.priority,-1)=? AND p.name_norm>?) "
        "OR (COALESCE(p.priority,-1)=? AND p.name_norm=? AND p.id>?)) "
        "ORDER BY COALESCE(p.priority,-1) DESC, p.name_norm, p.id LIMIT ?",
        ("%generated school%", "generated school%", 100, 100, "", 100, "", 0, 101),
    )
    explain(
        "structured_priority_equality",
        "SELECT p.id FROM pois p WHERE p.priority=? "
        "ORDER BY COALESCE(p.priority,-1) DESC, p.name_norm, p.id LIMIT ?",
        (80, 101),
    )
    explain(
        "structured_priority_range_rank_scan",
        "SELECT p.id FROM pois p INDEXED BY pois_rank "
        "WHERE p.priority BETWEEN ? AND ? "
        "ORDER BY COALESCE(p.priority,-1) DESC, p.name_norm, p.id LIMIT ?",
        (60, 90, 101),
    )
    explain(
        "structured_selective_name_contains",
        "SELECT p.id FROM pois p WHERE p.id IN "
        "(SELECT rowid FROM poi_fields_fts WHERE name_norm LIKE ?) "
        "ORDER BY COALESCE(p.priority,-1) DESC, p.name_norm, p.id LIMIT ?",
        ("%school 999%", 101),
    )
    explain(
        "structured_broad_name_priority_rank_scan",
        "SELECT p.id FROM pois p INDEXED BY pois_rank "
        "WHERE p.name_norm LIKE ? AND p.priority>=? "
        "ORDER BY COALESCE(p.priority,-1) DESC, p.name_norm, p.id LIMIT ?",
        ("%school%", 70, 101),
    )
    explain(
        "structured_type_priority_rank_scan",
        "SELECT p.id FROM pois p INDEXED BY pois_rank "
        "WHERE p.landmark_type_norm=? AND p.priority>=? "
        "ORDER BY COALESCE(p.priority,-1) DESC, p.name_norm, p.id LIMIT ?",
        ("fuel", 70, 101),
    )
    explain(
        "structured_ascending_priority_rank_scan",
        "SELECT p.id FROM pois p INDEXED BY pois_rank_ascending "
        "WHERE p.priority BETWEEN ? AND ? "
        "ORDER BY COALESCE(p.priority,1e308) ASC, p.name_norm, p.id LIMIT ?",
        (1, 24, 101),
    )
    return plans


def _run(root: Path, args: argparse.Namespace) -> dict[str, Any]:
    source = root / "generated.csv"
    metadata_path = root / "benchmark-metadata.json"
    index_dir = root / "index"
    if args.reuse:
        if not source.is_file() or not metadata_path.is_file():
            raise SystemExit(
                "--reuse requires generated.csv and benchmark-metadata.json in --work-dir"
            )
        try:
            benchmark_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            actual_rows = int(benchmark_metadata["rows"])
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise SystemExit("benchmark metadata is invalid") from exc
        generation_seconds: float | None = None
    else:
        if root.exists() and any(root.iterdir()):
            raise SystemExit("benchmark work directory is not empty; use --reuse or another path")
        root.mkdir(parents=True, exist_ok=True)
        actual_rows = args.rows
        generation_seconds = _generate_source(source, actual_rows)
        metadata_path.write_text(
            json.dumps({"generator_version": 1, "rows": actual_rows}),
            encoding="utf-8",
        )

    index = PoiSearchIndex({"benchmark": {"poi_csv_path": str(source)}}, index_dir)
    existed_before = any(index_dir.glob("*.sqlite3")) if index_dir.exists() else False
    tracemalloc.start()
    started = time.perf_counter()
    db_path = index.prepare("benchmark")
    prepare_seconds = time.perf_counter() - started
    _, python_peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    reopened = PoiSearchIndex({"benchmark": {"poi_csv_path": str(source)}}, index_dir)
    started = time.perf_counter()
    reopened.prepare("benchmark")
    reopen_seconds = time.perf_counter() - started

    queries: dict[str, dict[str, Any]] = {}

    def record(name: str, callback: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        result, measurement = _measure(callback, args.iterations)
        queries[name] = measurement
        return result

    specific_number = max(0, actual_rows - 1)
    record(
        "specific_text",
        lambda: reopened.search("benchmark", q=f"school {specific_number}", limit=100),
    )
    first = record(
        "broad_first_page",
        lambda: reopened.search("benchmark", q="generated school", limit=100),
    )
    record(
        "bbox",
        lambda: reopened.search("benchmark", bbox=(76.9, 27.9, 77.3, 28.3), limit=100),
    )
    record(
        "text_bbox",
        lambda: reopened.search(
            "benchmark", q="school", bbox=(76.9, 27.9, 77.3, 28.3), limit=100
        ),
    )
    record(
        "text_priority",
        lambda: reopened.search("benchmark", q="school", min_priority=80, limit=100),
    )
    record(
        "short_text",
        lambda: reopened.search("benchmark", q="a", limit=100),
    )
    record(
        "literal_special",
        lambda: reopened.search("benchmark", q="%", limit=100),
    )
    record(
        "structured_priority_equality",
        lambda: reopened.query("benchmark", conditions=[
            {"field": "priority", "operator": "eq", "value": 80}
        ], limit=100),
    )
    record(
        "structured_priority_range",
        lambda: reopened.query("benchmark", conditions=[
            {"field": "priority", "operator": "between", "value": [60, 90]}
        ], limit=100),
    )
    structured_page = record(
        "structured_name_and_priority",
        lambda: reopened.query("benchmark", mode="and", conditions=[
            {"field": "name", "operator": "contains", "value": "school"},
            {"field": "priority", "operator": "gte", "value": 70},
        ], limit=100),
    )
    record(
        "structured_type_and_priority",
        lambda: reopened.query("benchmark", mode="and", conditions=[
            {"field": "landmark_type", "operator": "eq", "value": "fuel"},
            {"field": "priority", "operator": "gte", "value": 70},
        ], limit=100),
    )
    record(
        "structured_name_or_name",
        lambda: reopened.query("benchmark", mode="or", conditions=[
            {"field": "name", "operator": "contains", "value": "school 999"},
            {"field": "name", "operator": "contains", "value": "school 1999"},
        ], limit=100),
    )
    record(
        "structured_mixed_indexed",
        lambda: reopened.query("benchmark", mode="and", conditions=[
            {"field": "landmark_type", "operator": "eq", "value": "school"},
            {"field": "mappls_poi_id", "operator": "contains", "value": "999"},
            {"field": "visible", "operator": "is_visible"},
        ], limit=100),
    )
    record(
        "structured_broad_or",
        lambda: reopened.query("benchmark", mode="or", conditions=[
            {"field": "landmark_type", "operator": "eq", "value": "school"},
            {"field": "priority", "operator": "gte", "value": 0},
        ], limit=100),
    )
    if structured_page["next_cursor"]:
        record(
            "structured_combined_second_page",
            lambda: reopened.query("benchmark", mode="and", conditions=[
                {"field": "name", "operator": "contains", "value": "school"},
                {"field": "priority", "operator": "gte", "value": 70},
            ], limit=100, cursor=structured_page["next_cursor"]),
        )
    if first["next_cursor"]:
        record(
            "broad_second_page",
            lambda: reopened.search(
                "benchmark", q="generated school", limit=100, cursor=first["next_cursor"]
            ),
        )

    later_cursor = first["next_cursor"]
    reached_page = 1
    while later_cursor and reached_page < args.later_page - 1:
        page = reopened.search(
            "benchmark", q="generated school", limit=100, cursor=later_cursor
        )
        later_cursor = page["next_cursor"]
        reached_page += 1
    if later_cursor:
        record(
            "broad_later_page",
            lambda: reopened.search(
                "benchmark", q="generated school", limit=100, cursor=later_cursor
            ),
        )
        reached_page += 1

    rss_bytes: int | None = None
    if resource is not None:
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        rss_bytes = int(rss if sys.platform == "darwin" else rss * 1_024)
    return {
        "rows_requested": args.rows,
        "rows_indexed": actual_rows,
        "work_dir": str(root),
        "reused_existing_files": args.reuse,
        "source_generation_seconds": generation_seconds,
        "index_created": not existed_before,
        "index_prepare_seconds": prepare_seconds,
        "existing_index_reopen_seconds": reopen_seconds,
        "python_tracemalloc_peak_bytes_during_prepare": python_peak,
        "process_peak_rss_bytes": rss_bytes,
        "index_bytes": sum(path.stat().st_size for path in index_dir.iterdir()),
        "warm_iterations": args.iterations,
        "later_page_requested": args.later_page,
        "later_page_reached": reached_page,
        "queries": queries,
        "query_plans": _query_plans(db_path) if args.plans else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=700_000)
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--reuse", action="store_true")
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--later-page", type=int, default=50)
    parser.add_argument("--plans", action="store_true")
    args = parser.parse_args()
    if args.rows < 1 or args.iterations < 1 or args.later_page < 2:
        parser.error("rows and iterations must be positive; later-page must be at least 2")
    if args.reuse and args.work_dir is None:
        parser.error("--reuse requires --work-dir")

    if args.work_dir is not None:
        result = _run(args.work_dir.resolve(), args)
    else:
        with tempfile.TemporaryDirectory() as directory:
            result = _run(Path(directory), args)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
