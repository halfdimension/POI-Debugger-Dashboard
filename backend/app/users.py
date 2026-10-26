from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError


USERNAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{2,31}$")
EMAIL_LOCAL_PATTERN = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$")
EMAIL_DOMAIN_LABEL_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
SCHEMA_VERSION = 3
MAX_PASSWORD_LENGTH = 4096


class AccountValidationError(ValueError):
    def __init__(self, message: str, field: str | None = None):
        super().__init__(message)
        self.field = field


class DuplicateAccountError(ValueError):
    def __init__(self, field: str):
        super().__init__(f"That {field} is already in use")
        self.field = field


class AccountOperationError(ValueError):
    pass


def normalize_username(value: str) -> str:
    return value.strip().casefold()


def normalize_email(value: str) -> str:
    return value.strip().casefold()


def valid_email(value: str) -> bool:
    if len(value) > 254 or not value.isascii() or value.count("@") != 1:
        return False
    local, domain = value.rsplit("@", 1)
    if not local or len(local) > 64 or local.startswith(".") or local.endswith(".") or ".." in local:
        return False
    labels = domain.split(".")
    return (
        EMAIL_LOCAL_PATTERN.fullmatch(local) is not None
        and len(labels) >= 2
        and all(EMAIL_DOMAIN_LABEL_PATTERN.fullmatch(label) is not None for label in labels)
    )


class LocalAccountStore:
    """SQLite-backed local identities and shared authentication throttles."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._schema_lock = threading.Lock()
        self._hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)
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
            # Serialize schema inspection and repair across worker processes.  Using
            # execute() instead of executescript() keeps every DDL statement and the
            # version update in this one transaction (executescript commits first).
            connection.execute("BEGIN IMMEDIATE")
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if version > SCHEMA_VERSION:
                raise RuntimeError(
                    f"User database schema {version} is newer than this application supports"
                )
            connection.execute(
                """CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY NOT NULL,
                    full_name TEXT NOT NULL,
                    username TEXT NOT NULL,
                    username_normalized TEXT NOT NULL UNIQUE,
                    email TEXT NOT NULL,
                    email_normalized TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'disabled')),
                    role TEXT NOT NULL DEFAULT 'user'
                )"""
            )
            connection.execute(
                """CREATE TABLE IF NOT EXISTS auth_rate_limits (
                    bucket_key TEXT PRIMARY KEY NOT NULL,
                    window_started INTEGER NOT NULL,
                    attempts INTEGER NOT NULL
                )"""
            )
            connection.execute(
                """CREATE TABLE IF NOT EXISTS admin_audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    actor_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    target_user_id TEXT,
                    details_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                )"""
            )
            columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(users)")}
            if "status" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
            if "role" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'")
            if "auth_provider" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'local'")
            if "issuer" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN issuer TEXT")
            if "subject" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN subject TEXT")
            if "last_login_at" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN last_login_at TEXT")
            connection.execute(
                """CREATE UNIQUE INDEX IF NOT EXISTS users_external_identity
                    ON users(issuer, subject) WHERE issuer IS NOT NULL AND subject IS NOT NULL"""
            )
            connection.execute("CREATE INDEX IF NOT EXISTS users_created_at ON users(created_at DESC)")
            connection.execute(
                "CREATE INDEX IF NOT EXISTS admin_audit_created_at ON admin_audit_log(created_at DESC)"
            )
            connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            connection.commit()

    @staticmethod
    def _public_account(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": str(row["id"]),
            "full_name": str(row["full_name"]),
            "username": str(row["username"]),
            "email": str(row["email"]),
            "status": str(row["status"]),
            "role": str(row["role"]),
            "auth_provider": str(row["auth_provider"]),
            "created_at": str(row["created_at"]),
            "last_login_at": str(row["last_login_at"]) if row["last_login_at"] else None,
        }

    def get(self, account_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM users WHERE id = ?", (account_id,)).fetchone()
        return self._public_account(row) if row is not None else None

    def touch_login(self, account_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE users SET last_login_at = ? WHERE id = ?",
                (datetime.now(timezone.utc).isoformat(), account_id),
            )

    def sync_oidc(self, account_id: str, claims: dict[str, Any]) -> dict[str, Any]:
        issuer = str(claims.get("iss", "")).rstrip("/")
        subject = str(claims.get("sub", ""))
        if not issuer or not subject:
            raise AccountOperationError("OIDC identity is missing issuer or subject")
        email = str(claims.get("email") or "")
        full_name = str(claims.get("name") or claims.get("preferred_username") or email or subject)[:100]
        preferred = str(claims.get("preferred_username") or (email.split("@", 1)[0] if email else "oidc-user"))
        base = re.sub(r"[^A-Za-z0-9._-]", "-", preferred).strip(".-_")[:24] or "oidc-user"
        if not base[0].isalpha():
            base = f"u-{base}"[:24]
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM users WHERE issuer = ? AND subject = ?", (issuer, subject)
            ).fetchone()
            if row is None:
                username = base
                suffix = 0
                while connection.execute(
                    "SELECT 1 FROM users WHERE username_normalized = ?", (normalize_username(username),)
                ).fetchone():
                    suffix += 1
                    username = f"{base[:24]}-{suffix}"
                connection.execute(
                    """
                    INSERT INTO users (
                        id, full_name, username, username_normalized, email, email_normalized,
                        password_hash, created_at, status, role, auth_provider, issuer, subject,
                        last_login_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'user', 'oidc', ?, ?, ?)
                    """,
                    (
                        account_id, full_name, username, normalize_username(username), email,
                        f"oidc:{hashlib.sha256(f'{issuer}\0{subject}'.encode()).hexdigest()}",
                        "!oidc-no-local-password", now, issuer, subject, now,
                    ),
                )
            else:
                connection.execute(
                    "UPDATE users SET full_name = ?, email = ?, last_login_at = ? WHERE id = ?",
                    (full_name, email, now, row["id"]),
                )
            refreshed = connection.execute("SELECT * FROM users WHERE id = ?", (account_id,)).fetchone()
        if refreshed is None:
            raise AccountOperationError("Could not synchronize OIDC account")
        return self._public_account(refreshed)

    @staticmethod
    def _clean_registration(payload: Any) -> dict[str, str]:
        if not isinstance(payload, dict):
            raise AccountValidationError("Registration request must be a JSON object")
        allowed = {"full_name", "username", "email", "password", "confirm_password"}
        unknown = set(payload) - allowed
        if unknown:
            raise AccountValidationError("Registration contains unsupported fields")
        values: dict[str, str] = {}
        for field in {"full_name", "username", "email"}:
            value = payload.get(field)
            if not isinstance(value, str) or not value.strip():
                raise AccountValidationError(f"{field.replace('_', ' ').title()} is required", field)
            values[field] = value
        for field in {"password", "confirm_password"}:
            value = payload.get(field)
            if not isinstance(value, str):
                raise AccountValidationError(f"{field.replace('_', ' ').title()} is required", field)
            values[field] = value

        full_name = " ".join(values["full_name"].split())
        if not 2 <= len(full_name) <= 100:
            raise AccountValidationError("Full name must be between 2 and 100 characters", "full_name")
        username = values["username"].strip()
        if not USERNAME_PATTERN.fullmatch(username):
            raise AccountValidationError(
                "Username must be 3–32 characters, start with a letter, and use only letters, numbers, dots, underscores, or hyphens",
                "username",
            )
        email = values["email"].strip()
        if not valid_email(email):
            raise AccountValidationError("Enter a valid email address", "email")
        password = values["password"]
        if not password:
            raise AccountValidationError("Password is required", "password")
        if len(password) > MAX_PASSWORD_LENGTH:
            raise AccountValidationError(
                f"Password must be no more than {MAX_PASSWORD_LENGTH} characters", "password"
            )
        if password != values["confirm_password"]:
            raise AccountValidationError("Passwords do not match", "confirm_password")
        return {"full_name": full_name, "username": username, "email": email, "password": password}

    def register(self, payload: Any) -> dict[str, Any]:
        values = self._clean_registration(payload)
        account_id = str(uuid.uuid4())
        password_hash = self._hasher.hash(values["password"])
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO users (
                        id, full_name, username, username_normalized, email,
                        email_normalized, password_hash, created_at, status, role
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'user')
                    """,
                    (
                        account_id,
                        values["full_name"],
                        values["username"],
                        normalize_username(values["username"]),
                        values["email"],
                        normalize_email(values["email"]),
                        password_hash,
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
        except sqlite3.IntegrityError as exc:
            message = str(exc)
            if "username_normalized" in message:
                raise DuplicateAccountError("username") from exc
            if "email_normalized" in message:
                raise DuplicateAccountError("email") from exc
            raise
        return {"id": account_id, "username": values["username"], "email": values["email"], "role": "user"}

    def authenticate(self, identifier: str, password: str) -> dict[str, Any] | None:
        if not isinstance(identifier, str) or not isinstance(password, str):
            return None
        normalized = normalize_email(identifier) if "@" in identifier else normalize_username(identifier)
        column = "email_normalized" if "@" in identifier else "username_normalized"
        with self._connect() as connection:
            row = connection.execute(f"SELECT * FROM users WHERE {column} = ?", (normalized,)).fetchone()
        if row is None:
            # Keep unknown-account work close to a real verification without retaining a shared dummy hash.
            self._hasher.hash(password[:256] or "invalid-password")
            return None
        try:
            valid = self._hasher.verify(row["password_hash"], password)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return None
        if not valid or row["status"] != "active":
            return None
        if self._hasher.check_needs_rehash(row["password_hash"]):
            with self._connect() as connection:
                connection.execute(
                    "UPDATE users SET password_hash = ? WHERE id = ?",
                    (self._hasher.hash(password), row["id"]),
                )
        self.touch_login(str(row["id"]))
        return self.get(str(row["id"]))

    def counts(self) -> dict[str, int]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) total, SUM(status = 'active') active, SUM(status = 'disabled') disabled FROM users"
            ).fetchone()
        return {"total": int(row["total"] or 0), "active": int(row["active"] or 0), "disabled": int(row["disabled"] or 0)}

    def list_accounts(self, *, search: str = "", offset: int = 0, limit: int = 25) -> tuple[list[dict[str, Any]], int]:
        term = search.strip().casefold()
        where = ""
        params: list[Any] = []
        if term:
            where = "WHERE username_normalized LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'"
            escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            params.extend([f"%{escaped}%", f"%{escaped}%"])
        with self._connect() as connection:
            total = int(connection.execute(f"SELECT COUNT(*) FROM users {where}", params).fetchone()[0])
            rows = connection.execute(
                f"SELECT * FROM users {where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?",
                [*params, limit, offset],
            ).fetchall()
        return [self._public_account(row) for row in rows], total

    def _audit(self, connection: sqlite3.Connection, actor_id: str, action: str, target_id: str, details: dict[str, Any]) -> None:
        connection.execute(
            "INSERT INTO admin_audit_log (actor_id, action, target_user_id, details_json, created_at) VALUES (?, ?, ?, ?, ?)",
            (actor_id, action, target_id, json.dumps(details, sort_keys=True), datetime.now(timezone.utc).isoformat()),
        )

    def set_status(self, account_id: str, status: str, *, actor_id: str) -> dict[str, Any]:
        if status not in {"active", "disabled"}:
            raise AccountOperationError("Status must be active or disabled")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM users WHERE id = ?", (account_id,)).fetchone()
            if row is None:
                raise AccountOperationError("Account not found")
            if row["role"] != "user":
                raise AccountOperationError("Administrative accounts can only be changed through the operator CLI")
            previous = str(row["status"])
            if previous != status:
                connection.execute("UPDATE users SET status = ? WHERE id = ?", (status, account_id))
                self._audit(connection, actor_id, "account_status_changed", account_id, {"from": previous, "to": status})
            refreshed = connection.execute("SELECT * FROM users WHERE id = ?", (account_id,)).fetchone()
        return self._public_account(refreshed)

    def set_role(self, account_id: str, role: str, *, actor_id: str) -> dict[str, Any]:
        if role not in {"user", "super_admin"}:
            raise AccountOperationError("Role must be user or super_admin")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM users WHERE id = ?", (account_id,)).fetchone()
            if row is None:
                raise AccountOperationError("Account not found")
            previous = str(row["role"])
            if previous == "super_admin" and role != previous and row["status"] == "active":
                remaining = int(connection.execute(
                    "SELECT COUNT(*) FROM users WHERE role = 'super_admin' AND status = 'active' AND id != ?", (account_id,)
                ).fetchone()[0])
                if remaining == 0:
                    raise AccountOperationError("Cannot remove the last active Super Admin")
            if previous != role:
                connection.execute("UPDATE users SET role = ? WHERE id = ?", (role, account_id))
                self._audit(connection, actor_id, "account_role_changed", account_id, {"from": previous, "to": role})
            refreshed = connection.execute("SELECT * FROM users WHERE id = ?", (account_id,)).fetchone()
        return self._public_account(refreshed)

    def consume_rate_limit(
        self, scope: str, discriminator: str, *, limit: int, window_seconds: int
    ) -> int | None:
        now = int(time.time())
        digest = hashlib.sha256(discriminator.encode("utf-8", errors="replace")).hexdigest()
        key = f"{scope}:{digest}"
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "DELETE FROM auth_rate_limits WHERE window_started < ?", (now - 86400,)
            )
            row = connection.execute(
                "SELECT window_started, attempts FROM auth_rate_limits WHERE bucket_key = ?", (key,)
            ).fetchone()
            if row is None or int(row["window_started"]) + window_seconds <= now:
                connection.execute(
                    "INSERT INTO auth_rate_limits (bucket_key, window_started, attempts) VALUES (?, ?, 1) "
                    "ON CONFLICT(bucket_key) DO UPDATE SET window_started = excluded.window_started, attempts = 1",
                    (key, now),
                )
                return None
            retry_after = int(row["window_started"]) + window_seconds - now
            if int(row["attempts"]) >= limit:
                return max(1, retry_after)
            connection.execute(
                "UPDATE auth_rate_limits SET attempts = attempts + 1 WHERE bucket_key = ?", (key,)
            )
            return None

    def rate_limit_retry_after(
        self, scope: str, discriminator: str, *, limit: int, window_seconds: int
    ) -> int | None:
        now = int(time.time())
        digest = hashlib.sha256(discriminator.encode("utf-8", errors="replace")).hexdigest()
        with self._connect() as connection:
            row = connection.execute(
                "SELECT window_started, attempts FROM auth_rate_limits WHERE bucket_key = ?",
                (f"{scope}:{digest}",),
            ).fetchone()
        if row is None or int(row["window_started"]) + window_seconds <= now:
            return None
        if int(row["attempts"]) < limit:
            return None
        return max(1, int(row["window_started"]) + window_seconds - now)

    def clear_rate_limit(self, scope: str, discriminator: str) -> None:
        digest = hashlib.sha256(discriminator.encode("utf-8", errors="replace")).hexdigest()
        with self._connect() as connection:
            connection.execute("DELETE FROM auth_rate_limits WHERE bucket_key = ?", (f"{scope}:{digest}",))
