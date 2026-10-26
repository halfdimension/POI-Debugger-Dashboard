from __future__ import annotations

import asyncio
import sqlite3
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import Depends, FastAPI, HTTPException, Request

from backend.app.auth import AuthManager
from backend.app.preferences import UserPreferenceStore
from backend.app.users import LocalAccountStore, SCHEMA_VERSION


def development_app() -> FastAPI:
    manager = AuthManager({
        "auth": {
            "mode": "development",
            "environment": "development",
            "session_secret": "test-secret-that-is-long-enough-for-sessions",
            "session_max_age_seconds": 300,
        }
    })
    app = FastAPI()
    manager.install(app)
    app.include_router(manager.router())

    @app.post("/api/protected", dependencies=[Depends(manager.require_authenticated_request)])
    async def protected() -> dict[str, bool]:
        return {"ok": True}

    return app


def test_authenticated_access_csrf_logout_and_expiration() -> None:
    async def scenario() -> None:
        transport = httpx.ASGITransport(app=development_app(), client=("127.0.0.1", 50000))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            assert (await client.get("/api/auth/current")).status_code == 401
            login = await client.post("/api/auth/dev-login")
            assert login.status_code == 200
            session = login.json()
            assert session["user"]["id"]
            assert (await client.post("/api/protected")).status_code == 403
            assert (await client.post(
                "/api/protected", headers={"X-CSRF-Token": session["csrf_token"]}
            )).status_code == 200

            with patch("backend.app.auth.time.time", return_value=session["expires_at"] + 1):
                assert (await client.get("/api/auth/current")).status_code == 401

            session = (await client.post("/api/auth/dev-login")).json()
            assert (await client.post(
                "/api/auth/logout", headers={"X-CSRF-Token": session["csrf_token"]}
            )).status_code == 200
            assert (await client.get("/api/auth/current")).status_code == 401

    asyncio.run(scenario())


def test_development_login_rejects_non_loopback_origin() -> None:
    async def scenario() -> None:
        transport = httpx.ASGITransport(app=development_app(), client=("127.0.0.1", 50000))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            response = await client.post(
                "/api/auth/dev-login", headers={"Origin": "http://192.0.2.10:5173"}
            )
            assert response.status_code == 403

    asyncio.run(scenario())


def test_super_admin_dependency_rejects_ordinary_users() -> None:
    async def scenario() -> None:
        manager = AuthManager({
            "auth": {
                "mode": "development", "environment": "development",
                "session_secret": "test-secret-that-is-long-enough-for-sessions",
            }
        })
        with patch.object(
            manager, "require_authenticated_request",
            AsyncMock(return_value={"id": "ordinary", "role": "user"}),
        ):
            with pytest.raises(HTTPException) as denied:
                await manager.require_super_admin(object())
            assert denied.value.status_code == 403
        with patch.object(
            manager, "require_authenticated_request",
            AsyncMock(return_value={"id": "admin", "role": "super_admin"}),
        ):
            allowed = await manager.require_super_admin(object())
            assert allowed["id"] == "admin"

    asyncio.run(scenario())


def test_production_configuration_fails_closed() -> None:
    with pytest.raises(RuntimeError, match="incomplete"):
        AuthManager({"auth": {"mode": "oidc", "environment": "production"}})

    with pytest.raises(RuntimeError, match="VPD_ENVIRONMENT=development"):
        AuthManager({
            "auth": {
                "mode": "development",
                "environment": "production",
                "session_secret": "not-a-production-bypass-secret-value",
            }
        })


def test_registration_database_error_returns_generic_message() -> None:
    async def scenario(directory: str) -> None:
        manager = AuthManager({
            "auth": {
                "mode": "local",
                "environment": "production",
                "session_secret": "test-secret-that-is-long-enough-for-sessions",
                "session_max_age_seconds": 300,
                "users_db_path": str(Path(directory) / "users.sqlite3"),
            }
        })
        app = FastAPI()
        manager.install(app)
        app.include_router(manager.router())
        transport = httpx.ASGITransport(app=app, client=("192.0.2.21", 50000))
        async with httpx.AsyncClient(transport=transport, base_url="https://dashboard.test") as client:
            csrf = (await client.get("/api/auth/config")).json()["csrf_token"]
            assert manager.accounts is not None
            with patch.object(
                manager.accounts,
                "consume_rate_limit",
                side_effect=sqlite3.OperationalError("internal database detail"),
            ):
                response = await client.post(
                    "/api/auth/register",
                    json={
                        "full_name": "Database Tester",
                        "username": "database.tester",
                        "email": "database.tester@example.com",
                        "password": "x",
                        "confirm_password": "x",
                    },
                    headers={"X-CSRF-Token": csrf},
                )
            assert response.status_code == 503
            assert response.json()["detail"] == "Authentication service is temporarily unavailable"
            assert "database detail" not in response.text

    with tempfile.TemporaryDirectory() as directory:
        asyncio.run(scenario(directory))


def test_local_registration_login_duplicates_and_preference_identity() -> None:
    async def scenario(directory: str) -> None:
        manager = AuthManager({
            "auth": {
                "mode": "local",
                "environment": "production",
                "session_secret": "test-secret-that-is-long-enough-for-sessions",
                "session_max_age_seconds": 300,
                "users_db_path": str(Path(directory) / "users.sqlite3"),
            }
        })
        preferences = UserPreferenceStore(Path(directory) / "preferences.sqlite3", ["one", "two"], "one")
        app = FastAPI()
        manager.install(app)
        app.include_router(manager.router())

        @app.get("/api/preference", dependencies=[Depends(manager.require_authenticated_request)])
        async def get_preference(request: Request):
            return preferences.get(request.state.current_user["id"])

        @app.post("/api/preference", dependencies=[Depends(manager.require_authenticated_request)])
        async def set_preference(request: Request):
            return preferences.update(request.state.current_user["id"], {"selected_dataset_id": "two"})

        transport = httpx.ASGITransport(app=app, client=("192.0.2.20", 50000))
        async with httpx.AsyncClient(transport=transport, base_url="https://dashboard.test") as client:
            config = (await client.get("/api/auth/config")).json()
            assert config["local_login_available"] is True
            assert config["oidc_login_available"] is False
            csrf = config["csrf_token"]
            registration = {
                "full_name": "Test Engineer",
                "username": "Route.User",
                "email": "Engineer@Example.com",
                "password": "correct-horse-42",
                "confirm_password": "correct-horse-42",
            }
            assert (await client.post("/api/auth/register", json=registration)).status_code == 403
            created = await client.post(
                "/api/auth/register", json=registration, headers={"X-CSRF-Token": csrf}
            )
            assert created.status_code == 201

            duplicate = await client.post(
                "/api/auth/register",
                json={**registration, "username": "route.user", "email": "other@example.com"},
                headers={"X-CSRF-Token": csrf},
            )
            assert duplicate.status_code == 409
            assert duplicate.json()["detail"]["field"] == "username"
            duplicate_email = await client.post(
                "/api/auth/register",
                json={**registration, "username": "another.user", "email": "engineer@example.COM"},
                headers={"X-CSRF-Token": csrf},
            )
            assert duplicate_email.status_code == 409
            assert duplicate_email.json()["detail"]["field"] == "email"

            invalid_username = await client.post(
                "/api/auth/register",
                json={**registration, "username": "1bad", "email": "unused@example.com"},
                headers={"X-CSRF-Token": csrf},
            )
            assert invalid_username.status_code == 400
            assert invalid_username.json()["detail"]["field"] == "username"

            invalid = await client.post(
                "/api/auth/password-login",
                json={"identifier": "ENGINEER@example.COM", "password": "wrong-password-42"},
                headers={"X-CSRF-Token": csrf},
            )
            assert invalid.status_code == 401
            assert "Invalid username/email or password" in invalid.json()["detail"]

            login = await client.post(
                "/api/auth/password-login",
                json={"identifier": "route.user", "password": "correct-horse-42"},
                headers={"X-CSRF-Token": csrf},
            )
            assert login.status_code == 200
            session = login.json()
            assert session["user"]["id"].startswith("local:")
            assert session["user"]["role"] == "user"
            assert "password" not in str(session).lower()
            authenticated_csrf = session["csrf_token"]
            assert (await client.post(
                "/api/preference", headers={"X-CSRF-Token": authenticated_csrf}
            )).status_code == 200
            stable_id = session["user"]["id"]
            assert (await client.post(
                "/api/auth/logout", headers={"X-CSRF-Token": authenticated_csrf}
            )).status_code == 200

            csrf = (await client.get("/api/auth/config")).json()["csrf_token"]
            relogin = await client.post(
                "/api/auth/password-login",
                json={"identifier": "ENGINEER@example.com", "password": "correct-horse-42"},
                headers={"X-CSRF-Token": csrf},
            )
            assert relogin.json()["user"]["id"] == stable_id
            assert (await client.get("/api/preference")).json()["selected_dataset_id"] == "two"

        with sqlite3.connect(Path(directory) / "users.sqlite3") as connection:
            row = connection.execute("SELECT password_hash, role, status FROM users").fetchone()
            assert row is not None and row[0].startswith("$argon2id$")
            assert row[1:] == ("user", "active")
            columns = {item[1] for item in connection.execute("PRAGMA table_info(users)")}
            assert "confirm_password" not in columns

    with tempfile.TemporaryDirectory() as directory:
        asyncio.run(scenario(directory))


@pytest.mark.parametrize("password", ["7", "letters only", " \t ", "密碼 🔐"])
def test_nonempty_passwords_are_preserved_and_authenticate(password: str) -> None:
    with tempfile.TemporaryDirectory() as directory:
        store = LocalAccountStore(Path(directory) / "users.sqlite3")
        account = store.register({
            "full_name": "Password Tester",
            "username": "password.tester",
            "email": "password.tester@example.com",
            "password": password,
            "confirm_password": password,
        })
        assert store.authenticate(account["username"], password) is not None
        if password.strip() != password:
            assert store.authenticate(account["username"], password.strip()) is None


def test_existing_database_is_repaired_atomically_without_losing_account_or_preferences() -> None:
    with tempfile.TemporaryDirectory() as directory:
        users_path = Path(directory) / "users.sqlite3"
        preferences_path = Path(directory) / "preferences.sqlite3"
        original = LocalAccountStore(users_path)
        account = original.register({
            "full_name": "Existing Admin",
            "username": "existing.admin",
            "email": "existing.admin@example.com",
            "password": "existing password",
            "confirm_password": "existing password",
        })
        original.set_role(account["id"], "super_admin", actor_id="operator:test")
        preferences = UserPreferenceStore(preferences_path, ["one", "two"], "one")
        preferences.update(f"local:{account['id']}", {"selected_dataset_id": "two"})

        # Reproduce a database created before shared rate-limit storage existed.
        with sqlite3.connect(users_path) as connection:
            connection.execute("DROP TABLE auth_rate_limits")
            connection.execute("PRAGMA user_version = 2")

        with ThreadPoolExecutor(max_workers=4) as executor:
            stores = list(executor.map(lambda _: LocalAccountStore(users_path), range(4)))

        repaired = stores[0]
        assert repaired.get(account["id"])["role"] == "super_admin"
        assert repaired.authenticate("existing.admin", "existing password") is not None
        added = repaired.register({
            "full_name": "Added Later",
            "username": "added.later",
            "email": "added.later@example.com",
            "password": "9",
            "confirm_password": "9",
        })
        assert repaired.authenticate(added["username"], "9") is not None
        assert repaired.consume_rate_limit("test", "same-client", limit=1, window_seconds=60) is None
        assert repaired.consume_rate_limit("test", "same-client", limit=1, window_seconds=60) is not None
        assert UserPreferenceStore(preferences_path, ["one", "two"], "one").get(
            f"local:{account['id']}"
        )["selected_dataset_id"] == "two"
        with sqlite3.connect(users_path) as connection:
            assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
            assert connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_rate_limits'"
            ).fetchone() == (1,)
