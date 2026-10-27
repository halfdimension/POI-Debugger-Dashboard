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
SCHEMA_VERSION = "7"
DEFAULT_LIMIT = 100
MAX_LIMIT = 500
BROAD_QUERY_THRESHOLD = 1_000
MAX_CONDITIONS = 10
MAX_TEXT_LENGTH = 200
PRIORITY_ASCENDING = "ascending"
PRIORITY_DESCENDING = "descending"
EARTH_RADIUS_M = 6_371_008.8

# Viewport visualization is intentionally separate from ranked POI search. A
# response contains at most this many geographical features, regardless of the
# number of source records represented by those features.
VIEWPORT_DEFAULT_MAX_FEATURES = 500
VIEWPORT_MAX_FEATURES = 1_000
VIEWPORT_MAX_ZOOM = 22.0
VIEWPORT_INDIVIDUAL_MIN_ZOOM = 15.0
VIEWPORT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
# A Web Mercator level four steps above the map zoom is approximately a
# 32-pixel square. This retains useful local structure while leaving enough
# room for restrained aggregate symbols; the response budget can still
# coarsen the level for unusually dispersed datasets.
VIEWPORT_AGGREGATION_LEVEL_OFFSET = 4
SPATIAL_MAX_LEVEL = 16
CLUSTER_MEMBER_DEFAULT_LIMIT = 100
CLUSTER_MEMBER_MAX_LIMIT = 500
SPATIAL_STRATEGY = "web_mercator_grid_centroid_v2"
WEB_MERCATOR_MAX_LAT = 85.0511287798066

STRUCTURED_OPERATORS = {
    "name": {"contains", "eq"},
    "priority": {"eq", "gt", "gte", "lt", "lte", "between"},
    "landmark_type": {"eq"},
    "mappls_poi_id": {"eq", "contains"},
    "new_node_id": {"eq", "contains"},
    "osm_source_id": {"eq", "contains"},
    "visible": {"is_visible", "is_hidden"},
}
TEXT_COLUMNS = {
    "name": "name_norm",
    "landmark_type": "landmark_type_norm",
    "mappls_poi_id": "mappls_poi_id_norm",
    "new_node_id": "new_node_id_norm",
    "osm_source_id": "osm_source_id_norm",
}


class PoiSearchError(RuntimeError):
    """A safe, user-facing POI search error."""


class PoiSearchValidationError(PoiSearchError):
    pass


class PoiSearchNotFoundError(PoiSearchError):
    pass


class PoiSearchNotReadyError(PoiSearchError):
    """The persistent index must be prepared by an authorized job."""


class PoiSearchStaleGenerationError(PoiSearchValidationError):
    """A generation-bound viewport reference no longer names the active index."""


class PoiSearchPayloadTooLargeError(PoiSearchError):
    """A visualization result cannot fit inside the bounded payload."""


def _spatial_cell_index(value: float, *, minimum: float, span: float, level: int) -> int:
    """Assign a coordinate to one half-open grid cell (the final cell is closed)."""
    cell_count = 1 << level
    index = math.floor(((value - minimum) / span) * cell_count)
    return min(cell_count - 1, max(0, index))


def _spatial_cell(lon: float, lat: float, level: int) -> tuple[int, int]:
    clamped_lat = min(WEB_MERCATOR_MAX_LAT, max(-WEB_MERCATOR_MAX_LAT, lat))
    mercator_y = 0.5 + math.asinh(math.tan(math.radians(clamped_lat))) / (
        2 * math.pi
    )
    return (
        _spatial_cell_index(lon, minimum=-180.0, span=360.0, level=level),
        min((1 << level) - 1, max(0, math.floor(mercator_y * (1 << level)))),
    )


def _spatial_cell_bounds(
    level: int, cell_x: int, cell_y: int
) -> tuple[float, float, float, float]:
    cell_count = 1 << level
    width = 360.0 / cell_count
    west = -180.0 + cell_x * width
    south_fraction = cell_y / cell_count
    north_fraction = (cell_y + 1) / cell_count

    def latitude(fraction: float) -> float:
        return math.degrees(math.atan(math.sinh(2 * math.pi * (fraction - 0.5))))

    south = -90.0 if cell_y == 0 else latitude(south_fraction)
    north = 90.0 if cell_y == cell_count - 1 else latitude(north_fraction)
    return west, south, west + width, north


def _haversine_meters(
    first: tuple[float, float], second: tuple[float, float]
) -> float:
    lon1, lat1 = first
    lon2, lat2 = second
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    delta_lat = lat2_rad - lat1_rad
    delta_lon = math.radians(lon2 - lon1)
    sin_lat = math.sin(delta_lat / 2)
    sin_lon = math.sin(delta_lon / 2)
    value = (
        sin_lat * sin_lat
        + math.cos(lat1_rad) * math.cos(lat2_rad) * sin_lon * sin_lon
    )
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(value)))


def _radius_bounds(
    lon: float, lat: float, radius_m: float
) -> tuple[list[tuple[float, float]], float, float]:
    latitude_padding = math.degrees(radius_m / EARTH_RADIUS_M)
    south = max(-90.0, lat - latitude_padding)
    north = min(90.0, lat + latitude_padding)
    cosine = min(
        abs(math.cos(math.radians(south))),
        abs(math.cos(math.radians(north))),
    )
    longitude_padding = 180.0 if cosine < 1e-12 else min(
        180.0, math.degrees(radius_m / (EARTH_RADIUS_M * cosine))
    )
    if longitude_padding >= 180.0:
        intervals = [(-180.0, 180.0)]
    else:
        west = lon - longitude_padding
        east = lon + longitude_padding
        if west < -180.0:
            intervals = [(west + 360.0, 180.0), (-180.0, east)]
        elif east > 180.0:
            intervals = [(west, 180.0), (-180.0, east - 360.0)]
        else:
            intervals = [(west, east)]
    return intervals, south, north


def priority_policy(cfg: dict[str, Any]) -> dict[str, Any]:
    """Return the dataset's structured-search priority semantics."""
    raw = cfg.get("priority")
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise PoiSearchError("Dataset priority configuration must be an object")
    rank_order = raw.get("rank_order", PRIORITY_DESCENDING)
    if rank_order not in {PRIORITY_ASCENDING, PRIORITY_DESCENDING}:
        raise PoiSearchError("priority.rank_order must be ascending or descending")
    bounds: dict[str, float | None] = {}
    for key in ("minimum", "maximum"):
        value = raw.get(key)
        if value is None:
            bounds[key] = None
            continue
        if isinstance(value, bool):
            raise PoiSearchError(f"priority.{key} must be a finite number")
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise PoiSearchError(f"priority.{key} must be a finite number") from exc
        if not math.isfinite(number):
            raise PoiSearchError(f"priority.{key} must be a finite number")
        bounds[key] = number
    if bounds["minimum"] is not None and bounds["maximum"] is not None and bounds["minimum"] > bounds["maximum"]:
        raise PoiSearchError("priority.minimum must not exceed priority.maximum")
    return {"rank_order": rank_order, **bounds}


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

    def __init__(
        self,
        datasets: dict[str, dict[str, Any]],
        index_dir: Path,
        *,
        allow_implicit_build: bool = True,
    ):
        self._datasets = datasets
        self._index_dir = index_dir
        self._allow_implicit_build = allow_implicit_build
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

    def rebuild(self, dataset_id: str) -> Path:
        """Atomically replace one index, preserving the old file on failure."""
        if dataset_id not in self._datasets:
            raise PoiSearchNotFoundError("Unknown dataset")
        with self._lock_for(dataset_id):
            cfg = self._datasets[dataset_id]
            try:
                source_kind, source_path = _source(cfg)
                fingerprint = _fingerprint(source_kind, source_path)
            except OSError as exc:
                raise PoiSearchError("The configured POI source is unavailable") from exc
            db_path = self._db_path(dataset_id)
            self._build(db_path, fingerprint, source_kind, source_path, cfg)
            return db_path

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
        if not self._allow_implicit_build:
            raise PoiSearchNotReadyError("The POI search index is not prepared")
        self._build(db_path, fingerprint, source_kind, source_path, cfg)
        return db_path, fingerprint

    def is_ready(self, dataset_id: str) -> bool:
        """Check index freshness without constructing or mutating an index."""
        if dataset_id not in self._datasets:
            return False
        try:
            source_kind, source_path = _source(self._datasets[dataset_id])
            fingerprint = _fingerprint(source_kind, source_path)
        except (OSError, PoiSearchError):
            return False
        return self._valid_database(self._db_path(dataset_id), fingerprint)

    @staticmethod
    def _valid_database(path: Path, fingerprint: str) -> bool:
        if not path.is_file():
            return False
        try:
            uri = path.resolve().as_uri() + "?mode=ro"
            with closing(sqlite3.connect(uri, uri=True)) as connection:
                values = dict(connection.execute("SELECT key, value FROM metadata"))
                spatial_cell_columns = {
                    str(row[1])
                    for row in connection.execute("PRAGMA table_info(spatial_cells)")
                }
                required_objects = {
                    str(row[0])
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master "
                        "WHERE name IN ("
                        "'pois', 'poi_geo', 'poi_fts', 'spatial_cells', "
                        "'pois_spatial_cell', 'spatial_cells_yx'"
                        ")"
                    )
                }
            return (
                values.get("schema_version") == SCHEMA_VERSION
                and values.get("source_fingerprint") == fingerprint
                and bool(values.get("generation"))
                and values.get("spatial_strategy") == SPATIAL_STRATEGY
                and values.get("spatial_max_level") == str(SPATIAL_MAX_LEVEL)
                and {"level", "cell_x", "cell_y", "poi_count", "lon_sum", "lat_sum"}
                <= spatial_cell_columns
                and required_objects
                == {
                    "pois",
                    "poi_geo",
                    "poi_fts",
                    "spatial_cells",
                    "pois_spatial_cell",
                    "spatial_cells_yx",
                }
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
                        landmark_type_norm TEXT NOT NULL,
                        mappls_poi_id_norm TEXT NOT NULL,
                        new_node_id_norm TEXT NOT NULL,
                        osm_source_id_norm TEXT NOT NULL,
                        priority REAL,
                        visible INTEGER NOT NULL,
                        lon REAL NOT NULL,
                        lat REAL NOT NULL,
                        spatial_x INTEGER NOT NULL,
                        spatial_y INTEGER NOT NULL
                    );
                    CREATE VIRTUAL TABLE poi_fts USING fts5(
                        search_text, tokenize='trigram'
                    );
                    CREATE VIRTUAL TABLE poi_fields_fts USING fts5(
                        name_norm, mappls_poi_id_norm, new_node_id_norm,
                        osm_source_id_norm, tokenize='trigram'
                    );
                    CREATE VIRTUAL TABLE poi_geo USING rtree(
                        id, min_lon, max_lon, min_lat, max_lat
                    );
                    CREATE TABLE spatial_cells (
                        level INTEGER NOT NULL,
                        cell_x INTEGER NOT NULL,
                        cell_y INTEGER NOT NULL,
                        poi_count INTEGER NOT NULL,
                        lon_sum REAL NOT NULL,
                        lat_sum REAL NOT NULL,
                        PRIMARY KEY (level, cell_x, cell_y)
                    ) WITHOUT ROWID;
                    """
                )
                iterator = _iter_csv(source_path, cfg) if source_kind == "csv" else _iter_geojson(source_path)
                for ordinal, feature in enumerate(iterator, start=1):
                    properties = feature.get("properties")
                    if not isinstance(properties, dict):
                        properties = {}
                    coordinates = feature["geometry"]["coordinates"]
                    lon, lat = float(coordinates[0]), float(coordinates[1])
                    spatial_x, spatial_y = _spatial_cell(
                        lon, lat, SPATIAL_MAX_LEVEL
                    )
                    name_norm = _text(properties.get("name")).lower()
                    landmark_type = _text(properties.get("landmark_type")).strip()
                    landmark_type_norm = landmark_type.lower()
                    mappls_poi_id_norm = _text(properties.get("mappls_poi_id")).strip().lower()
                    new_node_id_norm = _text(properties.get("new_node_id")).strip().lower()
                    osm_source_id_norm = _text(properties.get("osm_source_id")).strip().lower()
                    search_text = " ".join(
                        _text(properties.get(field)) for field in SEARCH_FIELDS
                    ).lower()
                    connection.execute(
                        "INSERT INTO pois VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            ordinal,
                            json.dumps(feature, ensure_ascii=False, separators=(",", ":")),
                            search_text,
                            name_norm,
                            landmark_type,
                            landmark_type_norm,
                            mappls_poi_id_norm,
                            new_node_id_norm,
                            osm_source_id_norm,
                            _priority(properties.get("priority")),
                            int(_visible(properties.get("visible"))),
                            lon,
                            lat,
                            spatial_x,
                            spatial_y,
                        ),
                    )
                    connection.execute(
                        "INSERT INTO poi_fts(rowid, search_text) VALUES (?, ?)",
                        (ordinal, search_text),
                    )
                    connection.execute(
                        "INSERT INTO poi_fields_fts(rowid, name_norm, mappls_poi_id_norm, new_node_id_norm, osm_source_id_norm) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (ordinal, name_norm, mappls_poi_id_norm, new_node_id_norm, osm_source_id_norm),
                    )
                    connection.execute(
                        "INSERT INTO poi_geo VALUES (?, ?, ?, ?, ?)",
                        (ordinal, lon, lon, lat, lat),
                    )
                connection.executescript(
                    """
                    CREATE INDEX pois_type ON pois(landmark_type);
                    CREATE INDEX pois_type_norm ON pois(landmark_type_norm);
                    CREATE INDEX pois_mappls_id ON pois(mappls_poi_id_norm);
                    CREATE INDEX pois_node_id ON pois(new_node_id_norm);
                    CREATE INDEX pois_osm_id ON pois(osm_source_id_norm);
                    CREATE INDEX pois_priority ON pois(priority);
                    CREATE INDEX pois_visible ON pois(visible);
                    CREATE INDEX pois_spatial_cell ON pois(spatial_x, spatial_y, id);
                    CREATE INDEX pois_name_exact ON pois(name_norm);
                    CREATE INDEX pois_name_prefix ON pois(name_norm COLLATE NOCASE);
                    CREATE INDEX pois_rank ON pois(
                        COALESCE(priority, -1) DESC, name_norm ASC, id ASC
                    );
                    CREATE INDEX pois_rank_ascending ON pois(
                        COALESCE(priority, 1e308) ASC, name_norm ASC, id ASC
                    );
                    """
                )
                connection.execute(
                    "INSERT INTO spatial_cells(level, cell_x, cell_y, poi_count, lon_sum, lat_sum) "
                    "SELECT ?, spatial_x, spatial_y, COUNT(*), SUM(lon), SUM(lat) FROM pois "
                    "GROUP BY spatial_x, spatial_y",
                    (SPATIAL_MAX_LEVEL,),
                )
                for level in range(SPATIAL_MAX_LEVEL - 1, -1, -1):
                    connection.execute(
                        "INSERT INTO spatial_cells(level, cell_x, cell_y, poi_count, lon_sum, lat_sum) "
                        "SELECT ?, cell_x / 2, cell_y / 2, SUM(poi_count), SUM(lon_sum), SUM(lat_sum) "
                        "FROM spatial_cells WHERE level = ? "
                        "GROUP BY cell_x / 2, cell_y / 2",
                        (level, level + 1),
                    )
                connection.execute(
                    "CREATE INDEX spatial_cells_yx "
                    "ON spatial_cells(level, cell_y, cell_x)"
                )
                connection.executemany(
                    "INSERT INTO metadata VALUES (?, ?)",
                    (
                        ("schema_version", SCHEMA_VERSION),
                        ("source_fingerprint", fingerprint),
                        ("generation", uuid.uuid4().hex),
                        ("spatial_strategy", SPATIAL_STRATEGY),
                        ("spatial_max_level", str(SPATIAL_MAX_LEVEL)),
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
            if dataset_id not in self._datasets:
                raise PoiSearchNotFoundError("Unknown dataset")
            cfg = self._datasets[dataset_id]
            source_kind, source_path = _source(cfg)
            fingerprint = _fingerprint(source_kind, source_path)
            path = self._db_path(dataset_id)
            if not self._valid_database(path, fingerprint):
                self._build(path, fingerprint, source_kind, source_path, cfg)
            return path

    @staticmethod
    def _serialized_bytes(value: dict[str, Any]) -> int:
        return len(
            json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(
                "utf-8"
            )
        )

    @classmethod
    def _finalize_viewport_response(cls, response: dict[str, Any]) -> dict[str, Any]:
        # Iterate to the tiny fixed point created by including the byte count's
        # own digits in the serialized envelope.
        response["meta"]["serialized_bytes"] = 0
        while True:
            size = cls._serialized_bytes(response)
            if response["meta"]["serialized_bytes"] == size:
                break
            response["meta"]["serialized_bytes"] = size
        return response

    @staticmethod
    def _viewport_bbox_sql() -> str:
        # R-tree values are outward-rounded float32 bounds. The REAL predicates
        # are the authoritative inclusive viewport-boundary check.
        return (
            "g.max_lon >= ? AND g.min_lon <= ? "
            "AND g.max_lat >= ? AND g.min_lat <= ? "
            "AND p.lon >= ? AND p.lon <= ? "
            "AND p.lat >= ? AND p.lat <= ?"
        )

    @staticmethod
    def _viewport_bbox_params(
        bbox: tuple[float, float, float, float]
    ) -> tuple[float, ...]:
        west, south, east, north = bbox
        return west, east, south, north, west, east, south, north

    @staticmethod
    def _individual_item(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": f"poi-{int(row['id'])}",
            "source_record_id": int(row["id"]),
            "coordinates": [float(row["lon"]), float(row["lat"])],
            "feature": json.loads(row["feature_json"]),
        }

    @staticmethod
    def _generation(connection: sqlite3.Connection) -> str:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key='generation'"
        ).fetchone()
        if row is None or not row[0]:
            raise PoiSearchError("The POI search index has no generation")
        return str(row[0])

    def _individual_viewport_response(
        self,
        connection: sqlite3.Connection,
        *,
        dataset_id: str,
        generation: str,
        bbox: tuple[float, float, float, float],
        zoom: float,
        max_features: int,
    ) -> dict[str, Any] | None:
        where = self._viewport_bbox_sql()
        params = self._viewport_bbox_params(bbox)
        probe = connection.execute(
            "SELECT p.id, LENGTH(p.feature_json) AS feature_bytes "
            "FROM poi_geo g JOIN pois p ON p.id = g.id "
            f"WHERE {where} ORDER BY p.id ASC LIMIT ?",
            (*params, max_features + 1),
        ).fetchall()
        if len(probe) > max_features:
            return None
        # Avoid materializing large source properties when the complete
        # individual envelope clearly cannot fit the payload budget.
        estimated_bytes = sum(int(row["feature_bytes"]) for row in probe)
        estimated_bytes += len(probe) * 256 + 2_048
        if estimated_bytes > VIEWPORT_MAX_PAYLOAD_BYTES:
            return None

        rows = connection.execute(
            "SELECT p.id, p.feature_json, p.lon, p.lat "
            "FROM poi_geo g JOIN pois p ON p.id = g.id "
            f"WHERE {where} ORDER BY p.id ASC",
            params,
        ).fetchall()
        items = [self._individual_item(row) for row in rows]
        response = {
            "dataset_id": dataset_id,
            "generation": generation,
            "bbox": list(bbox),
            "zoom": zoom,
            "mode": "individual",
            "complete": True,
            "total_matching_pois": len(items),
            "aggregates": [],
            "individual_pois": items,
            "meta": {
                "spatial_strategy": SPATIAL_STRATEGY,
                "requested_aggregation_level": None,
                "aggregation_level": None,
                "adaptive_coarsening": False,
                "feature_count": len(items),
                "aggregate_count": 0,
                "individual_count": len(items),
                "represented_poi_count": len(items),
                "max_features": max_features,
                "server_max_features": VIEWPORT_MAX_FEATURES,
                "max_payload_bytes": VIEWPORT_MAX_PAYLOAD_BYTES,
            },
        }
        self._finalize_viewport_response(response)
        if response["meta"]["serialized_bytes"] > VIEWPORT_MAX_PAYLOAD_BYTES:
            return None
        return response

    @staticmethod
    def _candidate_cells(
        connection: sqlite3.Connection,
        *,
        bbox: tuple[float, float, float, float],
        level: int,
        limit: int,
    ) -> list[sqlite3.Row]:
        west, south, east, north = bbox
        min_x, min_y = _spatial_cell(west, south, level)
        max_x, max_y = _spatial_cell(east, north, level)
        if max_x - min_x <= max_y - min_y:
            index_hint = ""
            order_by = "cell_x ASC, cell_y ASC"
        else:
            index_hint = " INDEXED BY spatial_cells_yx"
            order_by = "cell_y ASC, cell_x ASC"
        return connection.execute(
            f"SELECT cell_x, cell_y, poi_count, lon_sum, lat_sum FROM spatial_cells{index_hint} "
            "WHERE level = ? AND cell_x BETWEEN ? AND ? "
            "AND cell_y BETWEEN ? AND ? "
            f"ORDER BY {order_by} LIMIT ?",
            (level, min_x, max_x, min_y, max_y, limit),
        ).fetchall()

    def _partial_cell_statistics(
        self,
        connection: sqlite3.Connection,
        *,
        level: int,
        cell_x: int,
        cell_y: int,
        bounds: tuple[float, float, float, float],
    ) -> tuple[int, float, float]:
        scale = 1 << (SPATIAL_MAX_LEVEL - level)
        min_spatial_x = cell_x * scale
        max_spatial_x = (cell_x + 1) * scale - 1
        min_spatial_y = cell_y * scale
        max_spatial_y = (cell_y + 1) * scale - 1
        row = connection.execute(
            "SELECT COUNT(*), COALESCE(SUM(p.lon), 0), COALESCE(SUM(p.lat), 0) "
            "FROM poi_geo g JOIN pois p ON p.id = g.id "
            f"WHERE {self._viewport_bbox_sql()} "
            "AND p.spatial_x BETWEEN ? AND ? "
            "AND p.spatial_y BETWEEN ? AND ?",
            (
                *self._viewport_bbox_params(bounds),
                min_spatial_x,
                max_spatial_x,
                min_spatial_y,
                max_spatial_y,
            ),
        ).fetchone()
        return int(row[0]), float(row[1]), float(row[2])

    def _cluster_reference(
        self,
        *,
        dataset_id: str,
        generation: str,
        level: int,
        cell_x: int,
        cell_y: int,
        bounds: tuple[float, float, float, float],
    ) -> tuple[str, str]:
        reference = self._encode_cursor(
            {
                "kind": "viewport_cluster",
                "version": 1,
                "dataset_hash": hashlib.sha256(
                    dataset_id.encode("utf-8")
                ).hexdigest(),
                "generation": generation,
                "level": level,
                "cell_x": cell_x,
                "cell_y": cell_y,
                "bounds": list(bounds),
            }
        )
        identifier = "cluster-" + hashlib.sha256(
            reference.encode("ascii")
        ).hexdigest()[:24]
        return identifier, reference

    def _aggregated_viewport_response(
        self,
        connection: sqlite3.Connection,
        *,
        dataset_id: str,
        generation: str,
        bbox: tuple[float, float, float, float],
        zoom: float,
        max_features: int,
        requested_level: int,
    ) -> dict[str, Any]:
        level = requested_level
        while True:
            candidates = self._candidate_cells(
                connection,
                bbox=bbox,
                level=level,
                limit=max_features + 1,
            )
            if len(candidates) > max_features:
                level -= 1
                continue

            aggregates: list[dict[str, Any]] = []
            total = 0
            west, south, east, north = bbox
            for row in candidates:
                cell_x = int(row["cell_x"])
                cell_y = int(row["cell_y"])
                cell_bounds = _spatial_cell_bounds(level, cell_x, cell_y)
                represented_bounds = (
                    max(west, cell_bounds[0]),
                    max(south, cell_bounds[1]),
                    min(east, cell_bounds[2]),
                    min(north, cell_bounds[3]),
                )
                fully_contained = (
                    cell_bounds[0] >= west
                    and cell_bounds[1] >= south
                    and cell_bounds[2] <= east
                    and cell_bounds[3] <= north
                )
                if fully_contained:
                    count = int(row["poi_count"])
                    lon_sum = float(row["lon_sum"])
                    lat_sum = float(row["lat_sum"])
                else:
                    count, lon_sum, lat_sum = self._partial_cell_statistics(
                        connection,
                        level=level,
                        cell_x=cell_x,
                        cell_y=cell_y,
                        bounds=represented_bounds,
                    )
                if count == 0:
                    continue
                identifier, reference = self._cluster_reference(
                    dataset_id=dataset_id,
                    generation=generation,
                    level=level,
                    cell_x=cell_x,
                    cell_y=cell_y,
                    bounds=represented_bounds,
                )
                aggregates.append(
                    {
                        "id": identifier,
                        "source_record_count": count,
                        "coordinates": [
                            lon_sum / count,
                            lat_sum / count,
                        ],
                        "coordinate_kind": "density_weighted_centroid",
                        "bounds": list(represented_bounds),
                        "aggregation_level": level,
                        "cluster_ref": reference,
                    }
                )
                total += count

            response = {
                "dataset_id": dataset_id,
                "generation": generation,
                "bbox": list(bbox),
                "zoom": zoom,
                "mode": "aggregated",
                "complete": True,
                "total_matching_pois": total,
                "aggregates": aggregates,
                "individual_pois": [],
                "meta": {
                    "spatial_strategy": SPATIAL_STRATEGY,
                    "requested_aggregation_level": requested_level,
                    "aggregation_level": level,
                    "adaptive_coarsening": level < requested_level,
                    "feature_count": len(aggregates),
                    "aggregate_count": len(aggregates),
                    "individual_count": 0,
                    "represented_poi_count": total,
                    "max_features": max_features,
                    "server_max_features": VIEWPORT_MAX_FEATURES,
                    "max_payload_bytes": VIEWPORT_MAX_PAYLOAD_BYTES,
                },
            }
            self._finalize_viewport_response(response)
            if response["meta"]["serialized_bytes"] <= VIEWPORT_MAX_PAYLOAD_BYTES:
                return response
            if level == 0:
                raise PoiSearchPayloadTooLargeError(
                    "The viewport result cannot fit the maximum response payload"
                )
            level -= 1

    def viewport(
        self,
        dataset_id: str,
        *,
        bbox: tuple[float, float, float, float] | None,
        zoom: float,
        max_features: int = VIEWPORT_DEFAULT_MAX_FEATURES,
    ) -> dict[str, Any]:
        """Return exact, bounded geographical coverage for map visualization."""
        if not isinstance(dataset_id, str) or not dataset_id.strip():
            raise PoiSearchValidationError("dataset_id is required")
        if dataset_id not in self._datasets:
            raise PoiSearchNotFoundError("Unknown dataset")
        if bbox is None:
            raise PoiSearchValidationError("bbox is required")
        if (
            isinstance(zoom, bool)
            or not isinstance(zoom, (int, float))
            or not math.isfinite(zoom)
            or not 0 <= zoom <= VIEWPORT_MAX_ZOOM
        ):
            raise PoiSearchValidationError(
                f"zoom must be a finite number between 0 and {VIEWPORT_MAX_ZOOM:g}"
            )
        if (
            isinstance(max_features, bool)
            or not isinstance(max_features, int)
            or not 1 <= max_features <= VIEWPORT_MAX_FEATURES
        ):
            raise PoiSearchValidationError(
                f"max_features must be between 1 and {VIEWPORT_MAX_FEATURES}"
            )
        requested_level = min(
            SPATIAL_MAX_LEVEL,
            max(0, math.floor(float(zoom)) + VIEWPORT_AGGREGATION_LEVEL_OFFSET),
        )

        with self._lock_for(dataset_id):
            db_path, _ = self._current_database(dataset_id)
            uri = db_path.resolve().as_uri() + "?mode=ro"
            with closing(sqlite3.connect(uri, uri=True)) as connection:
                connection.row_factory = sqlite3.Row
                generation = self._generation(connection)
                if zoom >= VIEWPORT_INDIVIDUAL_MIN_ZOOM:
                    individual = self._individual_viewport_response(
                        connection,
                        dataset_id=dataset_id,
                        generation=generation,
                        bbox=bbox,
                        zoom=float(zoom),
                        max_features=max_features,
                    )
                    if individual is not None:
                        return individual
                return self._aggregated_viewport_response(
                    connection,
                    dataset_id=dataset_id,
                    generation=generation,
                    bbox=bbox,
                    zoom=float(zoom),
                    max_features=max_features,
                    requested_level=requested_level,
                )

    def _validated_cluster_reference(
        self,
        raw: str,
        *,
        dataset_id: str,
        generation: str,
    ) -> dict[str, Any]:
        if not isinstance(raw, str) or not raw or len(raw) > 4096:
            raise PoiSearchValidationError("Invalid cluster reference")
        try:
            payload = self._decode_cursor(raw)
        except PoiSearchValidationError as exc:
            raise PoiSearchValidationError("Invalid cluster reference") from exc
        if payload.get("kind") != "viewport_cluster" or payload.get("version") != 1:
            raise PoiSearchValidationError("Invalid cluster reference")
        dataset_hash = hashlib.sha256(dataset_id.encode("utf-8")).hexdigest()
        if payload.get("dataset_hash") != dataset_hash:
            raise PoiSearchValidationError(
                "Cluster reference does not match this dataset"
            )
        if payload.get("generation") != generation:
            raise PoiSearchStaleGenerationError("Cluster reference is stale")
        level = payload.get("level")
        cell_x = payload.get("cell_x")
        cell_y = payload.get("cell_y")
        if any(
            isinstance(value, bool) or not isinstance(value, int)
            for value in (level, cell_x, cell_y)
        ):
            raise PoiSearchValidationError("Invalid cluster reference")
        if not 0 <= level <= SPATIAL_MAX_LEVEL:
            raise PoiSearchValidationError("Invalid cluster reference")
        cell_count = 1 << level
        if not (0 <= cell_x < cell_count and 0 <= cell_y < cell_count):
            raise PoiSearchValidationError("Invalid cluster reference")
        raw_bounds = payload.get("bounds")
        if not isinstance(raw_bounds, list) or len(raw_bounds) != 4:
            raise PoiSearchValidationError("Invalid cluster reference")
        if any(isinstance(value, bool) for value in raw_bounds):
            raise PoiSearchValidationError("Invalid cluster reference")
        try:
            bounds = tuple(float(value) for value in raw_bounds)
        except (TypeError, ValueError) as exc:
            raise PoiSearchValidationError("Invalid cluster reference") from exc
        if not all(math.isfinite(value) for value in bounds):
            raise PoiSearchValidationError("Invalid cluster reference")
        west, south, east, north = bounds
        cell_bounds = _spatial_cell_bounds(level, cell_x, cell_y)
        if (
            west > east
            or south > north
            or west < cell_bounds[0]
            or south < cell_bounds[1]
            or east > cell_bounds[2]
            or north > cell_bounds[3]
        ):
            raise PoiSearchValidationError("Invalid cluster reference")
        return {
            "level": level,
            "cell_x": cell_x,
            "cell_y": cell_y,
            "bounds": bounds,
            "full_cell": bounds == cell_bounds,
        }

    def viewport_cluster_members(
        self,
        dataset_id: str,
        *,
        cluster_ref: str,
        limit: int = CLUSTER_MEMBER_DEFAULT_LIMIT,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """Page source records represented by one generation-bound aggregate."""
        if not isinstance(dataset_id, str) or not dataset_id.strip():
            raise PoiSearchValidationError("dataset_id is required")
        if dataset_id not in self._datasets:
            raise PoiSearchNotFoundError("Unknown dataset")
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= CLUSTER_MEMBER_MAX_LIMIT
        ):
            raise PoiSearchValidationError(
                f"limit must be between 1 and {CLUSTER_MEMBER_MAX_LIMIT}"
            )
        if cursor is not None and not isinstance(cursor, str):
            raise PoiSearchValidationError("Invalid pagination cursor")

        with self._lock_for(dataset_id):
            db_path, _ = self._current_database(dataset_id)
            uri = db_path.resolve().as_uri() + "?mode=ro"
            with closing(sqlite3.connect(uri, uri=True)) as connection:
                connection.row_factory = sqlite3.Row
                generation = self._generation(connection)
                cluster = self._validated_cluster_reference(
                    cluster_ref,
                    dataset_id=dataset_id,
                    generation=generation,
                )
                cluster_id = "cluster-" + hashlib.sha256(
                    cluster_ref.encode("ascii")
                ).hexdigest()[:24]
                after_id = 0
                if cursor:
                    page = self._decode_cursor(cursor)
                    if page.get("kind") != "viewport_cluster_cursor":
                        raise PoiSearchValidationError("Invalid pagination cursor")
                    if page.get("generation") != generation:
                        raise PoiSearchStaleGenerationError(
                            "Pagination cursor is stale"
                        )
                    if (
                        page.get("dataset_hash")
                        != hashlib.sha256(dataset_id.encode("utf-8")).hexdigest()
                        or page.get("cluster_id") != cluster_id
                    ):
                        raise PoiSearchValidationError(
                            "Pagination cursor does not match this cluster"
                        )
                    try:
                        after_id = int(page["after_id"])
                    except (KeyError, TypeError, ValueError) as exc:
                        raise PoiSearchValidationError(
                            "Invalid pagination cursor"
                        ) from exc
                    if after_id < 1:
                        raise PoiSearchValidationError("Invalid pagination cursor")

                level = cluster["level"]
                scale = 1 << (SPATIAL_MAX_LEVEL - level)
                spatial_bounds = (
                    cluster["cell_x"] * scale,
                    (cluster["cell_x"] + 1) * scale - 1,
                    cluster["cell_y"] * scale,
                    (cluster["cell_y"] + 1) * scale - 1,
                )
                if cluster["full_cell"]:
                    total_row = connection.execute(
                        "SELECT poi_count FROM spatial_cells "
                        "WHERE level = ? AND cell_x = ? AND cell_y = ?",
                        (level, cluster["cell_x"], cluster["cell_y"]),
                    ).fetchone()
                    total = int(total_row[0]) if total_row is not None else 0
                    rows = connection.execute(
                        "SELECT p.id, p.feature_json, p.lon, p.lat FROM pois p "
                        "WHERE p.spatial_x BETWEEN ? AND ? "
                        "AND p.spatial_y BETWEEN ? AND ? AND p.id > ? "
                        "ORDER BY p.id ASC LIMIT ?",
                        (*spatial_bounds, after_id, limit + 1),
                    ).fetchall()
                else:
                    base_where = (
                        self._viewport_bbox_sql()
                        + " AND p.spatial_x BETWEEN ? AND ?"
                        + " AND p.spatial_y BETWEEN ? AND ?"
                    )
                    base_params = (
                        *self._viewport_bbox_params(cluster["bounds"]),
                        *spatial_bounds,
                    )
                    total = int(
                        connection.execute(
                            "SELECT COUNT(*) FROM poi_geo g "
                            "JOIN pois p ON p.id = g.id "
                            f"WHERE {base_where}",
                            base_params,
                        ).fetchone()[0]
                    )
                    rows = connection.execute(
                        "SELECT p.id, p.feature_json, p.lon, p.lat "
                        "FROM poi_geo g JOIN pois p ON p.id = g.id "
                        f"WHERE {base_where} AND p.id > ? "
                        "ORDER BY p.id ASC LIMIT ?",
                        (*base_params, after_id, limit + 1),
                    ).fetchall()
                if total < 1:
                    raise PoiSearchValidationError("Invalid cluster reference")

        available = rows[:limit]
        items: list[dict[str, Any]] = []
        used_bytes = 2_048
        for row in available:
            item = self._individual_item(row)
            item_bytes = len(
                json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode(
                    "utf-8"
                )
            )
            if items and used_bytes + item_bytes > VIEWPORT_MAX_PAYLOAD_BYTES:
                break
            if not items and used_bytes + item_bytes > VIEWPORT_MAX_PAYLOAD_BYTES:
                raise PoiSearchPayloadTooLargeError(
                    "A cluster member exceeds the maximum response payload"
                )
            items.append(item)
            used_bytes += item_bytes

        while True:
            has_more = len(rows) > len(items)
            next_cursor = None
            if has_more and items:
                next_cursor = self._encode_cursor(
                    {
                        "kind": "viewport_cluster_cursor",
                        "dataset_hash": hashlib.sha256(
                            dataset_id.encode("utf-8")
                        ).hexdigest(),
                        "generation": generation,
                        "cluster_id": cluster_id,
                        "after_id": items[-1]["source_record_id"],
                    }
                )
            response = {
                "dataset_id": dataset_id,
                "generation": generation,
                "cluster_id": cluster_id,
                "cluster_ref": cluster_ref,
                "bounds": list(cluster["bounds"]),
                "aggregation_level": cluster["level"],
                "total_matching_pois": total,
                "individual_pois": items,
                "returned": len(items),
                "has_more": has_more,
                "next_cursor": next_cursor,
                "meta": {
                    "order": "source_record_id_ascending",
                    "max_limit": CLUSTER_MEMBER_MAX_LIMIT,
                    "max_payload_bytes": VIEWPORT_MAX_PAYLOAD_BYTES,
                },
            }
            self._finalize_viewport_response(response)
            if response["meta"]["serialized_bytes"] <= VIEWPORT_MAX_PAYLOAD_BYTES:
                return response
            if not items:
                raise PoiSearchPayloadTooLargeError(
                    "A cluster member exceeds the maximum response payload"
                )
            items.pop()

    def nearby(
        self,
        dataset_id: str,
        *,
        points: Any,
        radius_m: float,
        max_results: int = 10_000,
        max_candidates: int = 100_000,
        max_points: int = 1_000,
        max_radius_m: float = 2_000,
    ) -> dict[str, Any]:
        """Return source POIs within radius of any point using R-tree candidates."""
        if not isinstance(dataset_id, str) or not dataset_id.strip():
            raise PoiSearchValidationError("dataset_id is required")
        if dataset_id not in self._datasets:
            raise PoiSearchNotFoundError("Unknown dataset")
        if not isinstance(points, list) or not points:
            raise PoiSearchValidationError("points must be a non-empty array")
        if (
            isinstance(radius_m, bool)
            or not isinstance(radius_m, (int, float))
            or not math.isfinite(radius_m)
            or radius_m <= 0
            or radius_m > max_radius_m
        ):
            raise PoiSearchValidationError(
                f"radius_m must be greater than 0 and at most {max_radius_m:g}"
            )
        if max_results < 1 or max_candidates < 1 or max_points < 1 or max_radius_m <= 0:
            raise PoiSearchError("Diagnostic POI limits must be positive")

        normalized_points: list[tuple[float, float]] = []
        seen_points: set[tuple[float, float]] = set()
        for raw in points:
            if not isinstance(raw, (list, tuple)) or len(raw) != 2:
                raise PoiSearchValidationError("Each point must be [longitude, latitude]")
            try:
                lon, lat = float(raw[0]), float(raw[1])
            except (TypeError, ValueError) as exc:
                raise PoiSearchValidationError(
                    "Each point must contain finite numeric coordinates"
                ) from exc
            if not math.isfinite(lon) or not math.isfinite(lat) or not (-180 <= lon <= 180) or not (-90 <= lat <= 90):
                raise PoiSearchValidationError(
                    "Diagnostic point coordinates are outside valid longitude/latitude ranges"
                )
            point = (lon, lat)
            if point not in seen_points:
                seen_points.add(point)
                normalized_points.append(point)

        candidate_sql = """
            SELECT p.id, p.feature_json, p.lon, p.lat
            FROM poi_geo g JOIN pois p ON p.id = g.id
            WHERE g.max_lon >= ? AND g.min_lon <= ?
              AND g.max_lat >= ? AND g.min_lat <= ?
              AND p.lon >= ? AND p.lon <= ?
              AND p.lat >= ? AND p.lat <= ?
            ORDER BY p.id ASC
        """
        requested_point_count = len(normalized_points)
        incomplete_reason: str | None = None
        if requested_point_count > max_points:
            normalized_points = normalized_points[:max_points]
            incomplete_reason = "point_limit"

        candidate_ids: set[int] = set()
        matches: dict[int, tuple[float, str]] = {}
        processed_points = 0

        with self._lock_for(dataset_id):
            db_path, _ = self._current_database(dataset_id)
            uri = db_path.resolve().as_uri() + "?mode=ro"
            with closing(sqlite3.connect(uri, uri=True)) as connection:
                connection.row_factory = sqlite3.Row
                for point in normalized_points:
                    intervals, south, north = _radius_bounds(
                        point[0], point[1], float(radius_m)
                    )
                    point_complete = True
                    for west, east in intervals:
                        rows = connection.execute(
                            candidate_sql,
                            (west, east, south, north, west, east, south, north),
                        )
                        for row in rows:
                            row_id = int(row["id"])
                            if row_id not in candidate_ids:
                                if len(candidate_ids) >= max_candidates:
                                    incomplete_reason = "candidate_limit"
                                    point_complete = False
                                    break
                                candidate_ids.add(row_id)
                            distance_m = _haversine_meters(
                                point, (float(row["lon"]), float(row["lat"]))
                            )
                            if distance_m <= radius_m:
                                existing = matches.get(row_id)
                                if existing is None or distance_m < existing[0]:
                                    matches[row_id] = (distance_m, str(row["feature_json"]))
                        if not point_complete:
                            break
                    if not point_complete:
                        break
                    processed_points += 1

        ordered = sorted(
            ((distance, row_id, feature_json) for row_id, (distance, feature_json) in matches.items()),
            key=lambda item: (item[0], item[1]),
        )
        matched_total: int | None = len(ordered) if incomplete_reason is None else None
        if len(ordered) > max_results:
            ordered = ordered[:max_results]
            if incomplete_reason is None:
                incomplete_reason = "result_limit"

        return {
            "type": "FeatureCollection",
            "dataset_id": dataset_id,
            "features": [json.loads(item[2]) for item in ordered],
            "returned": len(ordered),
            "complete": incomplete_reason is None,
            "incomplete_reason": incomplete_reason,
            "matched_total": matched_total,
            "candidate_count": len(candidate_ids),
            "point_count": requested_point_count,
            "processed_points": processed_points,
            "radius_m": float(radius_m),
        }

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
    def _contains_has_many(
        connection: sqlite3.Connection, condition: dict[str, Any]
    ) -> bool:
        column = TEXT_COLUMNS[condition["field"]]
        value = condition["value"]
        escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        escape_sql = " ESCAPE '\\'" if escaped != value else ""
        sql = f"SELECT 1 FROM poi_fields_fts WHERE {column} LIKE ?{escape_sql} LIMIT 1 OFFSET ?"
        return connection.execute(
            sql, (f"%{escaped}%", BROAD_QUERY_THRESHOLD)
        ).fetchone() is not None

    @staticmethod
    def _search_broad_ranked(
        connection: sqlite3.Connection,
        *,
        conditions: list[str],
        params: list[Any],
        escaped_prefix: str,
        limit: int,
        after: dict[str, Any] | None,
        rank_order: str = PRIORITY_DESCENDING,
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
        ascending = rank_order == PRIORITY_ASCENDING
        priority_expression = "COALESCE(p.priority, 1e308)" if ascending else "COALESCE(p.priority, -1)"
        priority_direction = "ASC" if ascending else "DESC"
        priority_after_operator = ">" if ascending else "<"
        rank_index = "pois_rank_ascending" if ascending else "pois_rank"
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
                    f"({priority_expression} {priority_after_operator} ? "
                    f"OR ({priority_expression} = ? AND p.name_norm > ?) "
                    f"OR ({priority_expression} = ? AND p.name_norm = ? AND p.id > ?))"
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
                f"{starts} AS name_starts, {priority_expression} AS priority_sort "
                f"FROM pois p INDEXED BY {rank_index} WHERE "
                + " AND ".join(part_conditions)
                + f" ORDER BY {priority_expression} {priority_direction}, p.name_norm ASC, p.id ASC LIMIT ?"
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

    @staticmethod
    def _validate_structured_conditions(
        raw_conditions: Any,
        policy: dict[str, Any],
    ) -> list[dict[str, Any]]:
        if not isinstance(raw_conditions, list):
            raise PoiSearchValidationError("conditions must be an array")
        if len(raw_conditions) > MAX_CONDITIONS:
            raise PoiSearchValidationError(
                f"conditions must contain at most {MAX_CONDITIONS} items"
            )
        validated: list[dict[str, Any]] = []
        for index, raw in enumerate(raw_conditions):
            if not isinstance(raw, dict):
                raise PoiSearchValidationError(f"condition {index + 1} must be an object")
            field = raw.get("field")
            operator = raw.get("operator")
            if field not in STRUCTURED_OPERATORS:
                raise PoiSearchValidationError(f"Unsupported condition field: {field}")
            if operator not in STRUCTURED_OPERATORS[field]:
                raise PoiSearchValidationError(
                    f"Operator {operator} is not supported for {field}"
                )
            condition: dict[str, Any] = {"field": field, "operator": operator}
            if field == "visible":
                if raw.get("value") not in (None, ""):
                    raise PoiSearchValidationError(
                        "Visibility conditions do not accept a value"
                    )
            elif field == "priority":
                values = raw.get("value")
                if operator == "between":
                    if not isinstance(values, list) or len(values) != 2:
                        raise PoiSearchValidationError(
                            "Priority between requires a two-number array"
                        )
                    numeric = values
                else:
                    numeric = [values]
                parsed: list[float] = []
                for value in numeric:
                    if isinstance(value, bool):
                        raise PoiSearchValidationError("Priority must be numeric")
                    try:
                        number = float(value)
                    except (TypeError, ValueError) as exc:
                        raise PoiSearchValidationError("Priority must be numeric") from exc
                    if not math.isfinite(number):
                        raise PoiSearchValidationError("Priority must be a finite number")
                    minimum = policy["minimum"]
                    maximum = policy["maximum"]
                    if minimum is not None and number < minimum:
                        raise PoiSearchValidationError(f"Priority must be at least {minimum:g}")
                    if maximum is not None and number > maximum:
                        raise PoiSearchValidationError(f"Priority must be at most {maximum:g}")
                    parsed.append(number)
                if operator == "between" and parsed[0] > parsed[1]:
                    raise PoiSearchValidationError(
                        "Priority between lower bound must not exceed upper bound"
                    )
                condition["value"] = parsed if operator == "between" else parsed[0]
            else:
                value = raw.get("value")
                if not isinstance(value, str) or not value.strip():
                    raise PoiSearchValidationError(
                        f"{field} requires a non-empty text value"
                    )
                value = value.strip()
                if len(value) > MAX_TEXT_LENGTH:
                    raise PoiSearchValidationError(
                        f"{field} must not exceed {MAX_TEXT_LENGTH} characters"
                    )
                condition["value"] = value.lower()
            validated.append(condition)
        return validated

    @staticmethod
    def _structured_clause(condition: dict[str, Any]) -> tuple[str, list[Any]]:
        field = condition["field"]
        operator = condition["operator"]
        if field == "visible":
            return "p.visible = ?", [1 if operator == "is_visible" else 0]
        if field == "priority":
            value = condition["value"]
            if operator == "between":
                return "p.priority IS NOT NULL AND p.priority BETWEEN ? AND ?", value
            sql_operator = {"eq": "=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[operator]
            return f"p.priority IS NOT NULL AND p.priority {sql_operator} ?", [value]
        column = TEXT_COLUMNS[field]
        value = condition["value"]
        if operator == "eq":
            return f"p.{column} = ?", [value]
        escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        escape_sql = " ESCAPE '\\'" if escaped != value else ""
        return (
            f"p.id IN (SELECT rowid FROM poi_fields_fts WHERE {column} LIKE ?{escape_sql})",
            [f"%{escaped}%"],
        )

    @staticmethod
    def _structured_rank_clause(condition: dict[str, Any]) -> tuple[str, list[Any]]:
        """Use direct predicates while scanning the rank index for broad results."""
        if condition["operator"] != "contains":
            return PoiSearchIndex._structured_clause(condition)
        column = TEXT_COLUMNS[condition["field"]]
        value = condition["value"]
        escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        escape_sql = " ESCAPE '\\'" if escaped != value else ""
        return f"p.{column} LIKE ?{escape_sql}", [f"%{escaped}%"]

    def query(
        self,
        dataset_id: str,
        *,
        q: str | None = None,
        mode: str = "and",
        conditions: Any = None,
        bbox: tuple[float, float, float, float] | None = None,
        limit: int = DEFAULT_LIMIT,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """Execute an allowlisted structured query over the persistent dataset index."""
        if not isinstance(dataset_id, str) or not dataset_id.strip():
            raise PoiSearchValidationError("dataset_id is required")
        if dataset_id not in self._datasets:
            raise PoiSearchNotFoundError("Unknown dataset")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_LIMIT:
            raise PoiSearchValidationError(f"limit must be between 1 and {MAX_LIMIT}")
        if q is not None and not isinstance(q, str):
            raise PoiSearchValidationError("q must be text")
        if cursor is not None and not isinstance(cursor, str):
            raise PoiSearchValidationError("Invalid pagination cursor")
        query = (q or "").strip().lower()
        if len(query) > MAX_TEXT_LENGTH:
            raise PoiSearchValidationError(f"q must not exceed {MAX_TEXT_LENGTH} characters")
        normalized_mode = mode.lower() if isinstance(mode, str) else ""
        if normalized_mode not in {"and", "or"}:
            raise PoiSearchValidationError("mode must be 'and' or 'or'")
        policy = priority_policy(self._datasets[dataset_id])
        validated = self._validate_structured_conditions(
            [] if conditions is None else conditions, policy
        )
        ascending_priority = policy["rank_order"] == PRIORITY_ASCENDING
        priority_expression = "COALESCE(p.priority, 1e308)" if ascending_priority else "COALESCE(p.priority, -1)"
        priority_direction = "ASC" if ascending_priority else "DESC"
        priority_after_operator = ">" if ascending_priority else "<"
        rank_index = "pois_rank_ascending" if ascending_priority else "pois_rank"
        filters_hash = hashlib.sha256(
            json.dumps(
                [dataset_id, query, normalized_mode, validated, bbox, policy],
                separators=(",", ":"),
                sort_keys=True,
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
                sql_conditions: list[str] = []
                params: list[Any] = []
                escaped_query = ""
                if query:
                    search_column = "p.search_text" if bbox is not None else "poi_fts.search_text"
                    if bbox is None:
                        joins.append("JOIN poi_fts ON poi_fts.rowid = p.id")
                    escaped_query = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                    if escaped_query != query:
                        sql_conditions.append(f"{search_column} LIKE ? ESCAPE '\\'")
                    else:
                        sql_conditions.append(f"{search_column} LIKE ?")
                    params.append(f"%{escaped_query}%")

                if bbox is not None:
                    joins.append("JOIN poi_geo g ON g.id = p.id")
                    west, south, east, north = bbox
                    sql_conditions.extend((
                        "g.max_lon >= ?", "g.min_lon <= ?", "g.max_lat >= ?", "g.min_lat <= ?",
                        "p.lon >= ?", "p.lon <= ?", "p.lat >= ?", "p.lat <= ?",
                    ))
                    params.extend((west, east, south, north, west, east, south, north))

                clauses: list[str] = []
                rank_clauses: list[str] = []
                clause_params: list[Any] = []
                for item in validated:
                    clause, values = self._structured_clause(item)
                    rank_clause, _ = self._structured_rank_clause(item)
                    clauses.append(f"({clause})")
                    rank_clauses.append(f"({rank_clause})")
                    clause_params.extend(values)
                rank_group = ""
                if clauses:
                    joiner = " AND " if normalized_mode == "and" else " OR "
                    sql_conditions.append("(" + joiner.join(clauses) + ")")
                    rank_group = "(" + joiner.join(rank_clauses) + ")"
                    params.extend(clause_params)

                base_condition_count = len(sql_conditions)
                base_param_count = len(params)
                broad_ranked = False
                broad_advanced = False
                if query and bbox is None and escaped_query == query:
                    broad_ranked = self._has_many_candidates(
                        connection, joins, sql_conditions, params
                    )
                elif not query and bbox is None and sql_conditions:
                    contains_items = [item for item in validated if item["operator"] == "contains"]
                    has_selective_equality = any(
                        item["operator"] == "eq" and item["field"] in {
                            "name", "mappls_poi_id", "new_node_id", "osm_source_id"
                        }
                        for item in validated
                    )
                    if contains_items and not has_selective_equality:
                        probes = [
                            self._contains_has_many(connection, item)
                            for item in contains_items
                        ]
                        broad_advanced = (
                            all(probes) if normalized_mode == "and" else any(probes)
                        )
                    elif not contains_items:
                        broad_advanced = self._has_many_candidates(
                            connection, joins, sql_conditions, params
                        )
                    if broad_advanced and rank_group:
                        sql_conditions[0] = rank_group

                if query:
                    starts_sql = "CASE WHEN p.name_norm LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END"
                    prefix = escaped_query + "%"
                    select_params: list[Any] = [prefix]
                    if after is not None:
                        try:
                            last_starts = int(after["starts"])
                            last_priority = float(after["priority"])
                            last_name = str(after["name"])
                            last_id = int(after["id"])
                        except (KeyError, TypeError, ValueError) as exc:
                            raise PoiSearchValidationError("Invalid pagination cursor") from exc
                        sql_conditions.append(
                            f"(({starts_sql}) < ? OR (({starts_sql}) = ? AND {priority_expression} {priority_after_operator} ?) "
                            f"OR (({starts_sql}) = ? AND {priority_expression} = ? AND p.name_norm > ?) "
                            f"OR (({starts_sql}) = ? AND {priority_expression} = ? AND p.name_norm = ? AND p.id > ?))"
                        )
                        params.extend([
                            prefix, last_starts, prefix, last_starts, last_priority,
                            prefix, last_starts, last_priority, last_name,
                            prefix, last_starts, last_priority, last_name, last_id,
                        ])
                    select_extra = f", {starts_sql} AS name_starts, {priority_expression} AS priority_sort"
                    order_by = f"name_starts DESC, priority_sort {priority_direction}, p.name_norm ASC, p.id ASC"
                else:
                    select_params = []
                    if after is not None:
                        try:
                            last_priority = float(after["priority"])
                            last_name = str(after["name"])
                            last_id = int(after["id"])
                        except (KeyError, TypeError, ValueError) as exc:
                            raise PoiSearchValidationError("Invalid pagination cursor") from exc
                        sql_conditions.append(
                            f"({priority_expression} {priority_after_operator} ? OR "
                            f"({priority_expression} = ? AND p.name_norm > ?) OR "
                            f"({priority_expression} = ? AND p.name_norm = ? AND p.id > ?))"
                        )
                        params.extend((last_priority, last_priority, last_name, last_priority, last_name, last_id))
                    select_extra = f", {priority_expression} AS priority_sort"
                    order_by = f"priority_sort {priority_direction}, p.name_norm ASC, p.id ASC"

                if broad_ranked:
                    broad_conditions = [
                        item.replace("poi_fts.search_text", "p.search_text")
                        for item in sql_conditions[:base_condition_count]
                    ]
                    rows = self._search_broad_ranked(
                        connection,
                        conditions=broad_conditions,
                        params=params[:base_param_count],
                        escaped_prefix=prefix,
                        limit=limit,
                        after=after,
                        rank_order=policy["rank_order"],
                    )
                else:
                    index_hint = f" INDEXED BY {rank_index}" if broad_advanced else ""
                    sql = f"SELECT p.id, p.feature_json, p.name_norm, p.priority{select_extra} FROM pois p{index_hint} {' '.join(joins)}"
                    if sql_conditions:
                        sql += " WHERE " + " AND ".join(sql_conditions)
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
                "priority": last["priority_sort"],
                "name": last["name_norm"],
            }
            if query:
                cursor_payload["starts"] = last["name_starts"]
            next_cursor = self._encode_cursor(cursor_payload)
        return {
            "type": "FeatureCollection",
            "dataset_id": dataset_id,
            "features": [json.loads(row["feature_json"]) for row in page],
            "returned": len(page),
            "has_more": has_more,
            "next_cursor": next_cursor,
        }

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
