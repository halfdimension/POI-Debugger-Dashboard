from __future__ import annotations

import asyncio
import sqlite3
import tempfile
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI

from backend.app.admin import admin_router
from backend.app.auth import AuthManager


def make_app(directory: str) -> tuple[FastAPI, AuthManager]:
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
    app.include_router(admin_router(manager))

    @app.get("/api/protected", dependencies=[Depends(manager.require_authenticated_request)])
    async def protected() -> dict[str, bool]:
        return {"ok": True}

    return app, manager


async def register(client: httpx.AsyncClient, username: str) -> str:
    csrf = (await client.get("/api/auth/config")).json()["csrf_token"]
    response = await client.post(
        "/api/auth/register",
        json={
            "full_name": f"{username} Engineer",
            "username": username,
            "email": f"{username}@example.com",
            "password": "correct-horse-42",
            "confirm_password": "correct-horse-42",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 201
    return response.json()["username"]


async def login(client: httpx.AsyncClient, username: str) -> dict:
    csrf = (await client.get("/api/auth/config")).json()["csrf_token"]
    response = await client.post(
        "/api/auth/password-login",
        json={"identifier": username, "password": "correct-horse-42"},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    return response.json()


def test_signup_cannot_choose_role_and_admin_authorization_tracks_database() -> None:
    async def scenario(directory: str) -> None:
        app, manager = make_app(directory)
        assert manager.accounts is not None
        transport = httpx.ASGITransport(app=app, client=("192.0.2.30", 50000))
        async with httpx.AsyncClient(transport=transport, base_url="https://dashboard.test") as client:
            csrf = (await client.get("/api/auth/config")).json()["csrf_token"]
            elevated_signup = await client.post(
                "/api/auth/register",
                json={
                    "full_name": "Sneaky Admin", "username": "sneaky", "email": "sneaky@example.com",
                    "password": "correct-horse-42", "confirm_password": "correct-horse-42", "role": "super_admin",
                },
                headers={"X-CSRF-Token": csrf},
            )
            assert elevated_signup.status_code == 400

            await register(client, "ordinary")
            await register(client, "adminone")
            await register(client, "admintwo")
            ordinary = manager.accounts.list_accounts(search="ordinary")[0][0]
            admin_one = manager.accounts.list_accounts(search="adminone")[0][0]
            admin_two = manager.accounts.list_accounts(search="admintwo")[0][0]
            manager.accounts.set_role(admin_one["id"], "super_admin", actor_id="operator:test")
            manager.accounts.set_role(admin_two["id"], "super_admin", actor_id="operator:test")

            regular_session = await login(client, "ordinary")
            assert regular_session["user"]["role"] == "user"
            assert (await client.get("/api/admin/overview")).status_code == 403
            assert (await client.get("/api/admin/users")).status_code == 403

            manager.accounts.set_status(ordinary["id"], "disabled", actor_id=admin_one["id"])
            assert (await client.get("/api/protected")).status_code == 401

        async with httpx.AsyncClient(transport=transport, base_url="https://dashboard.test") as admin_client:
            session = await login(admin_client, "adminone")
            assert session["user"]["role"] == "super_admin"
            overview = await admin_client.get("/api/admin/overview")
            assert overview.status_code == 200
            assert overview.json() == {"total": 3, "active": 2, "disabled": 1}
            listing = await admin_client.get("/api/admin/users", params={"search": "admin", "page_size": 1})
            assert listing.status_code == 200
            assert listing.json()["total"] == 2
            assert "password_hash" not in str(listing.json())

            enabled = await admin_client.patch(
                f"/api/admin/users/{ordinary['id']}/status",
                json={"status": "active"},
                headers={"X-CSRF-Token": session["csrf_token"]},
            )
            assert enabled.status_code == 200
            assert enabled.json()["status"] == "active"
            with sqlite3.connect(Path(directory) / "users.sqlite3") as connection:
                assert connection.execute(
                    "SELECT COUNT(*) FROM admin_audit_log WHERE action = 'account_status_changed'"
                ).fetchone()[0] == 2

            manager.accounts.set_role(admin_one["id"], "user", actor_id="operator:test")
            assert (await admin_client.get("/api/admin/overview")).status_code == 403

    with tempfile.TemporaryDirectory() as directory:
        asyncio.run(scenario(directory))


def test_last_active_super_admin_cannot_be_revoked() -> None:
    with tempfile.TemporaryDirectory() as directory:
        _, manager = make_app(directory)
        assert manager.accounts is not None
        account = manager.accounts.register({
            "full_name": "Only Admin", "username": "onlyadmin", "email": "only@example.com",
            "password": "correct-horse-42", "confirm_password": "correct-horse-42",
        })
        manager.accounts.set_role(account["id"], "super_admin", actor_id="operator:test")
        try:
            manager.accounts.set_role(account["id"], "user", actor_id="operator:test")
        except ValueError as exc:
            assert "last active" in str(exc)
        else:
            raise AssertionError("last active Super Admin was revoked")
