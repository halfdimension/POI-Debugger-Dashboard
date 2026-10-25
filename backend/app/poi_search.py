from __future__ import annotations

import base64
import csv
import hashlib
import json
import math
import os
import sqlite3
import threading
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any, Iterator


SEARCH_FIELDS = (
    "name",
    "mappls_poi_id",
    "new_node_id",
    "osm_source_id",
    "landmark_type",
)
FALSE_VISIBLE_VALUES = {"0", "false", "no", "n"}
LAT_CANDIDATES = ("lat", "latitude", "y")
LON_CANDIDATES = ("lon", "lng", "longitude", "x")
SCHEMA_VERSION = "3"
DEFAULT_LIMIT = 100
MAX_LIMIT = 500
BROAD_QUERY_THRESHOLD = 1_000


class PoiSearchError(RuntimeError):
    """A safe, user-facing POI search error."""


class PoiSearchValidationError(PoiSearchError):
    pass


class PoiSearchNotFoundError(PoiSearchError):
    pass


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _priority(value: Any) -> float | None:
    # JavaScript Number('') and Number(null), used by the current frontend, are 0.
    if value is None or value == "" or (isinstance(value, str) and not value.strip()):
        return 0.0
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _visible(value: Any) -> bool:
    value_text = "yes" if value is None or value == "" else _text(value)
    return value_text.strip().lower() not in FALSE_VISIBLE_VALUES


def _detect_column(
    fieldnames: list[str], configured: str | None, candidates: tuple[str, ...]
) -> str | None:
    if configured and configured in fieldnames:
        return configured
    lookup = {field.strip().lower(): field for field in fieldnames}
    return next((lookup[item] for item in candidates if item in lookup), None)


def _source(cfg: dict[str, Any]) -> tuple[str, Path]:
    csv_path = Path(str(cfg["poi_csv_path"])) if cfg.get("poi_csv_path") else None
    geojson_path = (
        Path(str(cfg["poi_geojson_path"])) if cfg.get("poi_geojson_path") else None
    )
    if csv_path and csv_path.is_file():
        return "csv", csv_path
    if geojson_path and geojson_path.is_file():
        return "geojson", geojson_path
    if csv_path or geojson_path:
        raise PoiSearchError("The configured POI source is unavailable")
    raise PoiSearchError("No POI source is configured for this dataset")


def _fingerprint(source_kind: str, path: Path) -> str:
    stat = path.stat()
    identity = f"{SCHEMA_VERSION}\0{source_kind}\0{path.resolve()}\0{stat.st_size}\0{stat.st_mtime_ns}"
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _iter_csv(path: Path, cfg: dict[str, Any]) -> Iterator[dict[str, Any]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise PoiSearchError("The configured CSV has no header")
        fieldnames = [field.strip() for field in reader.fieldnames]
        lat_col = _detect_column(fieldnames, cfg.get("lat_column"), LAT_CANDIDATES)
        lon_col = _detect_column(fieldnames, cfg.get("lon_column"), LON_CANDIDATES)
        if not lat_col or not lon_col:
            raise PoiSearchError("The configured CSV has no latitude/longitude columns")

        for row in reader:
            clean = {
                str(key).strip(): "" if value is None else str(value)
                for key, value in row.items()
                if key is not None
            }
            try:
                lat = float(clean.get(lat_col, ""))
                lon = float(clean.get(lon_col, ""))
                if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    continue
            except (TypeError, ValueError):
                continue
            yield {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": clean,
            }


def _iter_geojson(path: Path) -> Iterator[dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PoiSearchError("The configured GeoJSON could not be read") from exc
    if not isinstance(payload, dict) or payload.get("type") != "FeatureCollection":
        raise PoiSearchError("The configured GeoJSON is not a FeatureCollection")
    features = payload.get("features")
    if not isinstance(features, list):
        raise PoiSearchError("The configured GeoJSON has no feature list")
    for feature in features:
        if not isinstance(feature, dict):
            continue
        geometry = feature.get("geometry")
        coordinates = geometry.get("coordinates") if isinstance(geometry, dict) else None
        if (
            not isinstance(geometry, dict)
            or geometry.get("type") != "Point"
            or not isinstance(coordinates, list)
            or len(coordinates) < 2
        ):
            continue
        try:
            lon, lat = float(coordinates[0]), float(coordinates[1])
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                continue
        except (TypeError, ValueError):
            continue
        yield feature


def parse_bbox(raw: str | None) -> tuple[float, float, float, float] | None:
    if raw is None or not raw.strip():
        return None
    pieces = [piece.strip() for piece in raw.split(",")]
    if len(pieces) != 4:
        raise PoiSearchValidationError("bbox must be west,south,east,north")
    try:
        west, south, east, north = (float(piece) for piece in pieces)
    except ValueError as exc:
        raise PoiSearchValidationError("bbox values must be finite numbers") from exc
    if not all(math.isfinite(value) for value in (west, south, east, north)):
        raise PoiSearchValidationError("bbox values must be finite numbers")
    if not (-180 <= west <= 180 and -180 <= east <= 180):
        raise PoiSearchValidationError("bbox longitudes must be between -180 and 180")
    if not (-90 <= south <= 90 and -90 <= north <= 90):
        raise PoiSearchValidationError("bbox latitudes must be between -90 and 90")
    if south > north:
        raise PoiSearchValidationError("bbox south must not exceed north")
    if west > east:
        raise PoiSearchValidationError("bbox values crossing the antimeridian are not supported")
    return west, south, east, north


class PoiSearchIndex:
    """Lazy persistent SQLite indexes for explicitly selected POI datasets."""

    def __init__(self, datasets: dict[str, dict[str, Any]], index_dir: Path):
        self._datasets = datasets
        self._index_dir = index_dir
        self._locks_guard = threading.Lock()
        self._locks: dict[str, threading.RLock] = {}

    def _lock_for(self, dataset_id: str) -> threading.RLock:
        with self._locks_guard:
            return self._locks.setdefault(dataset_id, threading.RLock())

    def _db_path(self, dataset_id: str) -> Path:
        digest = hashlib.sha256(dataset_id.encode("utf-8")).hexdigest()[:16]
        return self._index_dir / f"{digest}.sqlite3"

    def invalidate(self, dataset_id: str) -> None:
        if dataset_id not in self._datasets:
            raise PoiSearchNotFoundError("Unknown dataset")
        with self._lock_for(dataset_id):
            path = self._db_path(dataset_id)
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                raise PoiSearchError("The POI search index could not be invalidated") from exc

    def _current_database(self, dataset_id: str) -> tuple[Path, str]:
        if dataset_id not in self._datasets:
            raise PoiSearchNotFoundError("Unknown dataset")
        cfg = self._datasets[dataset_id]
        try:
            source_kind, source_path = _source(cfg)
            fingerprint = _fingerprint(source_kind, source_path)
        except OSError as exc:
            raise PoiSearchError("The configured POI source is unavailable") from exc
        db_path = self._db_path(dataset_id)
        if self._valid_database(db_path, fingerprint):
            return db_path, fingerprint
        self._build(db_path, fingerprint, source_kind, source_path, cfg)
        return db_path, fingerprint

    @staticmethod
    def _valid_database(path: Path, fingerprint: str) -> bool:
        if not path.is_file():
            return False
        try:
            uri = path.resolve().as_uri() + "?mode=ro"
            with closing(sqlite3.connect(uri, uri=True)) as connection:
                values = dict(connection.execute("SELECT key, value FROM metadata"))
            return (
                values.get("schema_version") == SCHEMA_VERSION
                and values.get("source_fingerprint") == fingerprint
                and bool(values.get("generation"))
            )
        except (OSError, sqlite3.Error):
            return False

    def _build(
        self,
        db_path: Path,
        fingerprint: str,
        source_kind: str,
        source_path: Path,
        cfg: dict[str, Any],
    ) -> None:
        temp_path = db_path.with_name(f".{db_path.name}.{uuid.uuid4().hex}.tmp")
        try:
            self._index_dir.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(temp_path)) as connection:
                connection.executescript(
                    """
                    PRAGMA journal_mode=DELETE;
                    PRAGMA synchronous=NORMAL;
                    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE TABLE pois (
                        id INTEGER PRIMARY KEY,
                        feature_json TEXT NOT NULL,
                        search_text TEXT NOT NULL,
                        name_norm TEXT NOT NULL,
                        landmark_type TEXT NOT NULL,
                        priority REAL,
                        visible INTEGER NOT NULL,
                        lon REAL NOT NULL,
                        lat REAL NOT NULL
                    );
                    CREATE VIRTUAL TABLE poi_fts USING fts5(
                        search_text, tokenize='trigram'
                    );
                    CREATE VIRTUAL TABLE poi_geo USING rtree(
                        id, min_lon, max_lon, min_lat, max_lat
                    );
                    """
                )
                iterator = _iter_csv(source_path, cfg) if source_kind == "csv" else _iter_geojson(source_path)
                for ordinal, feature in enumerate(iterator, start=1):
                    properties = feature.get("properties")
                    if not isinstance(properties, dict):
                        properties = {}
                    coordinates = feature["geometry"]["coordinates"]
                    lon, lat = float(coordinates[0]), float(coordinates[1])
                    name_norm = _text(properties.get("name")).lower()
                    landmark_type = _text(properties.get("landmark_type")).strip()
                    search_text = " ".join(
                        _text(properties.get(field)) for field in SEARCH_FIELDS
                    ).lower()
                    connection.execute(
                        "INSERT INTO pois VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            ordinal,
                            json.dumps(feature, ensure_ascii=False, separators=(",", ":")),
                            search_text,
                            name_norm,
                            landmark_type,
                            _priority(properties.get("priority")),
                            int(_visible(properties.get("visible"))),
                            lon,
                            lat,
                        ),
                    )
                    connection.execute(
                        "INSERT INTO poi_fts(rowid, search_text) VALUES (?, ?)",
                        (ordinal, search_text),
                    )
                    connection.execute(
                        "INSERT INTO poi_geo VALUES (?, ?, ?, ?, ?)",
                        (ordinal, lon, lon, lat, lat),
                    )
                connection.executescript(
                    """
                    CREATE INDEX pois_type ON pois(landmark_type);
                    CREATE INDEX pois_priority ON pois(priority);
                    CREATE INDEX pois_visible ON pois(visible);
                    CREATE INDEX pois_name_prefix ON pois(name_norm COLLATE NOCASE);
                    CREATE INDEX pois_rank ON pois(
                        COALESCE(priority, -1) DESC, name_norm ASC, id ASC
                    );
                    """
                )
                connection.executemany(
                    "INSERT INTO metadata VALUES (?, ?)",
                    (
                        ("schema_version", SCHEMA_VERSION),
                        ("source_fingerprint", fingerprint),
                        ("generation", uuid.uuid4().hex),
                    ),
                )
                connection.commit()
            os.replace(temp_path, db_path)
        except Exception as exc:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise PoiSearchError("The POI search index could not be built") from exc

    def prepare(self, dataset_id: str) -> Path:
        """Build or validate a dataset index without including a search in its timing."""
        with self._lock_for(dataset_id):
            path, _ = self._current_database(dataset_id)
            return path

    @staticmethod
    def _has_many_candidates(
        connection: sqlite3.Connection,
        joins: list[str],
        conditions: list[str],
        params: list[Any],
    ) -> bool:
        sql = f"SELECT 1 FROM pois p {' '.join(joins)}"
        if conditions:
            sql += " WHERE " + " AND ".join(conditions)
        sql += " LIMIT 1 OFFSET ?"
        return connection.execute(sql, [*params, BROAD_QUERY_THRESHOLD]).fetchone() is not None

    @staticmethod
    def _search_broad_ranked(
        connection: sqlite3.Connection,
        *,
        conditions: list[str],
        params: list[Any],
        escaped_prefix: str,
        limit: int,
        after: dict[str, Any] | None,
    ) -> list[sqlite3.Row]:
        """Read a broad result directly in rank order, avoiding a large temp sort."""
        try:
            after_starts = int(after["starts"]) if after is not None else None
            after_priority = float(after["priority"]) if after is not None else None
            after_name = str(after["name"]) if after is not None else None
            after_id = int(after["id"]) if after is not None else None
        except (KeyError, TypeError, ValueError) as exc:
            raise PoiSearchValidationError("Invalid pagination cursor") from exc

        rows: list[sqlite3.Row] = []
        partitions = (1, 0) if after_starts in (None, 1) else (0,)
        if 1 in partitions:
            prefix_sql = (
                "SELECT 1 FROM pois p INDEXED BY pois_name_prefix WHERE "
                + " AND ".join([*conditions, "p.name_norm LIKE ? ESCAPE '\\'"])
                + " LIMIT 1"
            )
            if connection.execute(
                prefix_sql, [*params, escaped_prefix]
            ).fetchone() is None:
                partitions = (0,)
        for starts in partitions:
            remaining = limit + 1 - len(rows)
            if remaining <= 0:
                break
            part_conditions = list(conditions)
            part_params = list(params)
            prefix_condition = "p.name_norm LIKE ? ESCAPE '\\'"
            part_conditions.append(prefix_condition if starts else f"NOT ({prefix_condition})")
            part_params.append(escaped_prefix)
            if after is not None and starts == after_starts:
                part_conditions.append(
                    "(COALESCE(p.priority, -1) < ? "
                    "OR (COALESCE(p.priority, -1) = ? AND p.name_norm > ?) "
                    "OR (COALESCE(p.priority, -1) = ? AND p.name_norm = ? AND p.id > ?))"
                )
                part_params.extend(
                    (
                        after_priority,
                        after_priority,
                        after_name,
                        after_priority,
                        after_name,
                        after_id,
                    )
                )
            sql = (
                "SELECT p.id, p.feature_json, p.name_norm, p.priority, "
                f"{starts} AS name_starts, COALESCE(p.priority, -1) AS priority_sort "
                "FROM pois p INDEXED BY pois_rank WHERE "
                + " AND ".join(part_conditions)
                + " ORDER BY COALESCE(p.priority, -1) DESC, p.name_norm ASC, p.id ASC LIMIT ?"
            )
            rows.extend(connection.execute(sql, [*part_params, remaining]).fetchall())
        return rows

    @staticmethod
    def _encode_cursor(payload: dict[str, Any]) -> str:
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    @staticmethod
    def _decode_cursor(raw: str) -> dict[str, Any]:
        if len(raw) > 4096:
            raise PoiSearchValidationError("Invalid pagination cursor")
        try:
            padded = raw + "=" * (-len(raw) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
            raise PoiSearchValidationError("Invalid pagination cursor") from exc
        if not isinstance(payload, dict):
            raise PoiSearchValidationError("Invalid pagination cursor")
        return payload

    def search(
        self,
        dataset_id: str,
        *,
        q: str | None = None,
        landmark_type: str | None = None,
        min_priority: float | None = None,
        visible: bool | None = None,
        bbox: tuple[float, float, float, float] | None = None,
        limit: int = DEFAULT_LIMIT,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        if not 1 <= limit <= MAX_LIMIT:
            raise PoiSearchValidationError(f"limit must be between 1 and {MAX_LIMIT}")
        if min_priority is not None and not math.isfinite(min_priority):
            raise PoiSearchValidationError("min_priority must be a finite number")
        query = (q or "").strip().lower()
        type_filter = None if landmark_type is None else landmark_type.strip()
        if len(query) > 200:
            raise PoiSearchValidationError("q must not exceed 200 characters")
        if type_filter is not None and len(type_filter) > 200:
            raise PoiSearchValidationError("type must not exceed 200 characters")
        filters_hash = hashlib.sha256(
            json.dumps(
                [dataset_id, query, type_filter, min_priority, visible, bbox],
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()[:20]

        with self._lock_for(dataset_id):
            db_path, _ = self._current_database(dataset_id)
            uri = db_path.resolve().as_uri() + "?mode=ro"
            with closing(sqlite3.connect(uri, uri=True)) as connection:
                connection.row_factory = sqlite3.Row
                generation = connection.execute(
                    "SELECT value FROM metadata WHERE key='generation'"
                ).fetchone()[0]
                after: dict[str, Any] | None = None
                if cursor:
                    after = self._decode_cursor(cursor)
                    if after.get("generation") != generation:
                        raise PoiSearchValidationError("Pagination cursor is stale")
                    if after.get("filters") != filters_hash:
                        raise PoiSearchValidationError("Pagination cursor does not match this query")

                joins: list[str] = []
                conditions: list[str] = []
                params: list[Any] = []
                if query:
                    search_column = "p.search_text" if bbox is not None else "poi_fts.search_text"
                    if bbox is None:
                        joins.append("JOIN poi_fts ON poi_fts.rowid = p.id")
                    escaped_query = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                    if any(character in query for character in ("%", "_", "\\")):
                        # FTS5 cannot optimize LIKE when ESCAPE is present. Preserve
                        # literal matching for these uncommon queries with a scan.
                        conditions.append(f"{search_column} LIKE ? ESCAPE '\\'")
                        params.append(f"%{escaped_query}%")
                    else:
                        conditions.append(f"{search_column} LIKE ?")
                        params.append(f"%{query}%")
                if bbox is not None:
                    joins.append("JOIN poi_geo g ON g.id = p.id")
                    west, south, east, north = bbox
                    # R-tree values use outward-rounded float32 bounds. Use it for
                    # candidates, then exact REAL columns for boundary correctness.
                    conditions.extend(
                        (
                            "g.max_lon >= ?", "g.min_lon <= ?", "g.max_lat >= ?", "g.min_lat <= ?",
                            "p.lon >= ?", "p.lon <= ?", "p.lat >= ?", "p.lat <= ?",
                        )
                    )
                    params.extend((west, east, south, north, west, east, south, north))
                if type_filter is not None:
                    conditions.append("p.landmark_type = ?")
                    params.append(type_filter)
                if min_priority is not None:
                    conditions.append("p.priority IS NOT NULL AND p.priority >= ?")
                    params.append(min_priority)
                if visible is not None:
                    conditions.append("p.visible = ?")
                    params.append(int(visible))

                broad_ranked = False
                broad_condition_count = len(conditions)
                broad_param_count = len(params)
                if query and bbox is None and not any(
                    character in query for character in ("%", "_", "\\")
                ):
                    broad_ranked = self._has_many_candidates(
                        connection, joins, conditions, params
                    )

                if query:
                    starts_sql = "CASE WHEN p.name_norm LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END"
                    escaped = escaped_query + "%"
                    starts_params: list[Any] = [escaped]
                    if after is not None:
                        try:
                            last_starts = int(after["starts"])
                            last_priority = float(after["priority"])
                            last_name = str(after["name"])
                            last_id = int(after["id"])
                        except (KeyError, TypeError, ValueError) as exc:
                            raise PoiSearchValidationError("Invalid pagination cursor") from exc
                        conditions.append(
                            f"(({starts_sql}) < ? OR (({starts_sql}) = ? AND COALESCE(p.priority, -1) < ?) "
                            f"OR (({starts_sql}) = ? AND COALESCE(p.priority, -1) = ? AND p.name_norm > ?) "
                            f"OR (({starts_sql}) = ? AND COALESCE(p.priority, -1) = ? AND p.name_norm = ? AND p.id > ?))"
                        )
                        params.extend(
                            [escaped, last_starts, escaped, last_starts, last_priority,
                             escaped, last_starts, last_priority, last_name,
                             escaped, last_starts, last_priority, last_name, last_id]
                        )
                    select_extra = f", {starts_sql} AS name_starts, COALESCE(p.priority, -1) AS priority_sort"
                    order_by = "name_starts DESC, priority_sort DESC, p.name_norm ASC, p.id ASC"
                    select_params = starts_params
                else:
                    if after is not None:
                        try:
                            last_id = int(after["id"])
                        except (KeyError, TypeError, ValueError) as exc:
                            raise PoiSearchValidationError("Invalid pagination cursor") from exc
                        conditions.append("p.id > ?")
                        params.append(last_id)
                    select_extra = ""
                    order_by = "p.id ASC"
                    select_params = []

                if broad_ranked:
                    broad_conditions = [
                        condition.replace("poi_fts.search_text", "p.search_text")
                        for condition in conditions[:broad_condition_count]
                    ]
                    rows = self._search_broad_ranked(
                        connection,
                        conditions=broad_conditions,
                        params=params[:broad_param_count],
                        escaped_prefix=escaped,
                        limit=limit,
                        after=after,
                    )
                else:
                    sql = f"SELECT p.id, p.feature_json, p.name_norm, p.priority{select_extra} FROM pois p {' '.join(joins)}"
                    if conditions:
                        sql += " WHERE " + " AND ".join(conditions)
                    sql += f" ORDER BY {order_by} LIMIT ?"
                    rows = connection.execute(sql, [*select_params, *params, limit + 1]).fetchall()

        has_more = len(rows) > limit
        page = rows[:limit]
        next_cursor = None
        if has_more and page:
            last = page[-1]
            cursor_payload: dict[str, Any] = {
                "generation": generation,
                "filters": filters_hash,
                "id": last["id"],
            }
            if query:
                cursor_payload.update(
                    starts=last["name_starts"],
                    priority=last["priority_sort"],
                    name=last["name_norm"],
                )
            next_cursor = self._encode_cursor(cursor_payload)
        return {
            "type": "FeatureCollection",
            "dataset_id": dataset_id,
            "features": [json.loads(row["feature_json"]) for row in page],
            "returned": len(page),
            "has_more": has_more,
            "next_cursor": next_cursor,
        }
