from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .scenarios import ScenarioError, normalize_scenario


class TestcaseError(ValueError):
    pass


class TestcaseNotFoundError(TestcaseError):
    pass


class TestcaseConflictError(TestcaseError):
    pass


MAX_NAME_LENGTH = 160
MAX_DESCRIPTION_LENGTH = 4000
MAX_CONFIGURATION_BYTES = 64 * 1024
VISIBILITIES = frozenset({"private", "shared"})
SORT_ORDERS = {
    "updated_desc": "updated_at DESC, id",
    "updated_asc": "updated_at ASC, id",
    "created_desc": "created_at DESC, id",
    "created_asc": "created_at ASC, id",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class TestcaseRepository:
    """SQLite repository whose every data operation is scoped to an owner ID."""

    def __init__(self, path: str | Path, dataset_ids: Iterable[str]):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._dataset_ids = frozenset(dataset_ids)
        self._schema_lock = threading.Lock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 10000")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self) -> None:
        with self._schema_lock, self._connect() as connection:
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if version > 2:
                raise RuntimeError(f"Testcase database schema {version} is newer than this application supports")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS testcases (
                    id TEXT PRIMARY KEY NOT NULL,
                    owner_user_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    dataset_id TEXT NOT NULL,
                    configuration_json TEXT NOT NULL,
                    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
                    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(testcases)")}
            if "owner_display_name" not in columns:
                connection.execute("ALTER TABLE testcases ADD COLUMN owner_display_name TEXT")
            if "owner_username" not in columns:
                connection.execute("ALTER TABLE testcases ADD COLUMN owner_username TEXT")
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_testcases_owner_updated ON testcases(owner_user_id, updated_at DESC, id)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_testcases_shared_updated ON testcases(visibility, updated_at DESC, id)"
            )
            if version < 2:
                connection.execute("PRAGMA user_version = 2")

    def _validate_configuration(self, payload: Any, *, testcase_id: str) -> tuple[str, str, dict[str, Any]]:
        if not isinstance(payload, dict):
            raise TestcaseError("Testcase payload must be a JSON object")
        unknown = sorted(set(payload) - {"name", "description", "dataset", "request", "expectation", "revision", "visibility"})
        if unknown:
            raise TestcaseError(f"Unknown testcase fields: {', '.join(unknown)}")
        if not isinstance(payload.get("name"), str):
            raise TestcaseError("Testcase name must be a string")
        name = payload["name"].strip()
        if not name:
            raise TestcaseError("Testcase name is required")
        if len(name) > MAX_NAME_LENGTH:
            raise TestcaseError(f"Testcase name must be at most {MAX_NAME_LENGTH} characters")
        if not isinstance(payload.get("description", ""), str):
            raise TestcaseError("Testcase description must be a string")
        description = payload.get("description", "").strip()
        if len(description) > MAX_DESCRIPTION_LENGTH:
            raise TestcaseError(f"Testcase description must be at most {MAX_DESCRIPTION_LENGTH} characters")
        if not isinstance(payload.get("dataset"), str):
            raise TestcaseError("Testcase dataset must be a string")
        dataset = payload["dataset"].strip()
        if dataset not in self._dataset_ids:
            raise TestcaseError(f"Unknown dataset: {dataset}")
        try:
            configuration = normalize_scenario(
                {**payload, "notes": description}, scenario_id=testcase_id
            )
        except ScenarioError as exc:
            raise TestcaseError(str(exc)) from exc
        configuration.pop("id", None)
        configuration.pop("name", None)
        configuration.pop("notes", None)
        configuration.pop("created_at", None)
        configuration.pop("updated_at", None)
        encoded = json.dumps(configuration, separators=(",", ":"), sort_keys=True)
        if len(encoded.encode("utf-8")) > MAX_CONFIGURATION_BYTES:
            raise TestcaseError("Testcase configuration is too large")
        return name, description, configuration

    @staticmethod
    def _public(row: sqlite3.Row, *, viewer_user_id: str, include_owner: bool = False) -> dict[str, Any]:
        configuration = json.loads(row["configuration_json"])
        result = {
            "id": row["id"],
            "name": row["name"],
            "description": row["description"],
            **configuration,
            "visibility": row["visibility"],
            "revision": row["revision"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "is_owner": row["owner_user_id"] == viewer_user_id,
        }
        if include_owner:
            result["owner"] = {
                "display_name": row["owner_display_name"] or row["owner_username"] or "Unknown user",
                "username": row["owner_username"] or None,
            }
        return result

    @staticmethod
    def _visibility(value: Any, *, default: str | None = None) -> str:
        if value is None and default is not None:
            return default
        if not isinstance(value, str) or value not in VISIBILITIES:
            raise TestcaseError("visibility must be 'private' or 'shared'")
        return value

    @staticmethod
    def _list_options(*, query: str, limit: int, offset: int, sort: str) -> tuple[str, str]:
        if not 1 <= limit <= 100:
            raise TestcaseError("limit must be between 1 and 100")
        if not 0 <= offset <= 1_000_000:
            raise TestcaseError("offset must be between 0 and 1000000")
        query = query.strip()
        if len(query) > 160:
            raise TestcaseError("q must be at most 160 characters")
        order_by = SORT_ORDERS.get(sort)
        if order_by is None:
            raise TestcaseError(f"sort must be one of: {', '.join(SORT_ORDERS)}")
        return query, order_by

    def create(
        self, owner_user_id: str, payload: Any, *, owner_display_name: str = "", owner_username: str = ""
    ) -> dict[str, Any]:
        testcase_id = str(uuid.uuid4())
        name, description, configuration = self._validate_configuration(payload, testcase_id=testcase_id)
        visibility = self._visibility(payload.get("visibility") if isinstance(payload, dict) else None, default="private")
        now = _utc_now()
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO testcases
                   (id, owner_user_id, owner_display_name, owner_username, name, description, dataset_id,
                    configuration_json, visibility, revision, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                (testcase_id, owner_user_id, owner_display_name[:160], owner_username[:160], name, description,
                 configuration["dataset"], json.dumps(configuration, separators=(",", ":"), sort_keys=True),
                 visibility, now, now),
            )
        return self.get(owner_user_id, testcase_id)

    def get(self, owner_user_id: str, testcase_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM testcases WHERE id = ? AND (owner_user_id = ? OR visibility = 'shared')",
                (testcase_id, owner_user_id),
            ).fetchone()
        if row is None:
            raise TestcaseNotFoundError("Testcase not found")
        return self._public(row, viewer_user_id=owner_user_id, include_owner=row["owner_user_id"] != owner_user_id)

    def list(
        self, owner_user_id: str, *, query: str = "", visibility: str | None = None,
        limit: int = 50, offset: int = 0, sort: str = "updated_desc",
    ) -> dict[str, Any]:
        query, order_by = self._list_options(query=query, limit=limit, offset=offset, sort=sort)
        where = "owner_user_id = ?"
        params: list[Any] = [owner_user_id]
        if visibility is not None:
            where += " AND visibility = ?"
            params.append(self._visibility(visibility))
        if query:
            where += " AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            params.extend([f"%{escaped}%", f"%{escaped}%"])
        with self._connect() as connection:
            total = int(connection.execute(f"SELECT COUNT(*) FROM testcases WHERE {where}", params).fetchone()[0])
            rows = connection.execute(
                f"SELECT * FROM testcases WHERE {where} ORDER BY {order_by} LIMIT ? OFFSET ?",
                [*params, limit, offset],
            ).fetchall()
        return {"testcases": [self._public(row, viewer_user_id=owner_user_id) for row in rows], "total": total, "limit": limit, "offset": offset}

    def list_shared(
        self, viewer_user_id: str, *, query: str = "", limit: int = 50, offset: int = 0,
        sort: str = "updated_desc",
    ) -> dict[str, Any]:
        query, order_by = self._list_options(query=query, limit=limit, offset=offset, sort=sort)
        where = "visibility = 'shared'"
        params: list[Any] = []
        if query:
            where += " AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            params.extend([f"%{escaped}%", f"%{escaped}%"])
        with self._connect() as connection:
            total = int(connection.execute(f"SELECT COUNT(*) FROM testcases WHERE {where}", params).fetchone()[0])
            rows = connection.execute(
                f"SELECT * FROM testcases WHERE {where} ORDER BY {order_by} LIMIT ? OFFSET ?",
                [*params, limit, offset],
            ).fetchall()
        return {
            "testcases": [self._public(row, viewer_user_id=viewer_user_id, include_owner=True) for row in rows],
            "total": total, "limit": limit, "offset": offset,
        }

    def update(
        self, owner_user_id: str, testcase_id: str, patch: Any, *,
        owner_display_name: str = "", owner_username: str = "",
    ) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise TestcaseError("Testcase update must be a JSON object")
        if "revision" not in patch or isinstance(patch["revision"], bool) or not isinstance(patch["revision"], int):
            raise TestcaseError("Current integer revision is required")
        expected_revision = patch["revision"]
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM testcases WHERE id = ? AND owner_user_id = ?", (testcase_id, owner_user_id)
            ).fetchone()
            if row is None:
                raise TestcaseNotFoundError("Testcase not found")
            existing = self._public(row, viewer_user_id=owner_user_id)
            visibility = self._visibility(patch.get("visibility"), default=row["visibility"])
            merged = {
                "name": existing["name"], "description": existing["description"],
                "dataset": existing["dataset"], "request": existing["request"],
                "expectation": existing.get("expectation"),
                **{key: value for key, value in patch.items() if key not in {"revision", "visibility"}},
            }
            name, description, configuration = self._validate_configuration(merged, testcase_id=testcase_id)
            now = _utc_now()
            cursor = connection.execute(
                """UPDATE testcases SET name = ?, description = ?, dataset_id = ?, configuration_json = ?, visibility = ?,
                   owner_display_name = COALESCE(NULLIF(?, ''), owner_display_name),
                   owner_username = COALESCE(NULLIF(?, ''), owner_username),
                   revision = revision + 1, updated_at = ?
                   WHERE id = ? AND owner_user_id = ? AND revision = ?""",
                (name, description, configuration["dataset"], json.dumps(configuration, separators=(",", ":"), sort_keys=True),
                 visibility, owner_display_name[:160], owner_username[:160], now,
                 testcase_id, owner_user_id, expected_revision),
            )
            if cursor.rowcount != 1:
                raise TestcaseConflictError("Testcase changed since it was loaded; refresh and try again")
        return self.get(owner_user_id, testcase_id)

    def delete(self, owner_user_id: str, testcase_id: str) -> None:
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM testcases WHERE id = ? AND owner_user_id = ?", (testcase_id, owner_user_id)
            )
        if cursor.rowcount != 1:
            raise TestcaseNotFoundError("Testcase not found")
