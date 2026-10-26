from __future__ import annotations

import hashlib
import hmac
import ipaddress
import secrets
import sqlite3
import time
from typing import Any
from urllib.parse import urlsplit

from authlib.integrations.base_client.errors import OAuthError
from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from starlette.middleware.sessions import SessionMiddleware

from .users import MAX_PASSWORD_LENGTH, AccountValidationError, DuplicateAccountError, LocalAccountStore


SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _safe_next(value: str | None) -> str:
    if (
        not value
        or not value.startswith("/")
        or value.startswith("//")
        or "\\" in value
        or any(ord(character) < 32 for character in value)
    ):
        return "/"
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc:
        return "/"
    return value


def _is_loopback(value: str | None) -> bool:
    if not value:
        return False
    hostname = urlsplit(value if "://" in value else f"//{value}").hostname
    if not hostname:
        return False
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


class AuthManager:
    """Local/OIDC authentication over one signed session and CSRF lifecycle."""

    def __init__(self, settings: dict[str, Any]):
        config = dict(settings.get("auth", {}))
        self.mode = str(config.get("mode", "oidc")).lower()
        self.local_enabled = self.mode in {"local", "local_oidc"}
        self.oidc_enabled = self.mode in {"oidc", "local_oidc"}
        self.environment = str(config.get("environment", "production")).lower()
        self.max_age = int(config.get("session_max_age_seconds", 8 * 60 * 60))
        self.cookie_name = str(config.get("cookie_name", "vpd_session"))
        self.issuer = str(config.get("oidc_issuer", "")).rstrip("/")
        self.redirect_uri = str(config.get("redirect_uri", ""))
        self.allowed_users = {
            str(value).strip().lower() for value in config.get("allowed_users", []) if str(value).strip()
        }
        self.allowed_groups = {
            str(value).strip() for value in config.get("allowed_groups", []) if str(value).strip()
        }
        self.groups_claim = str(config.get("groups_claim", "groups"))
        self.session_secret = str(config.get("session_secret", ""))
        self.oauth: OAuth | None = None
        self.accounts: LocalAccountStore | None = None

        if self.mode not in {"local", "oidc", "local_oidc", "development"}:
            raise RuntimeError("VPD_AUTH_MODE must be 'local', 'oidc', 'local_oidc', or 'development'")
        if self.max_age < 300:
            raise RuntimeError("VPD_SESSION_MAX_AGE_SECONDS must be at least 300")
        if self.mode == "development":
            if self.environment != "development":
                raise RuntimeError("Development authentication requires VPD_ENVIRONMENT=development")
        else:
            required = {"VPD_SESSION_SECRET": self.session_secret}
            if self.oidc_enabled:
                required.update({
                    "VPD_OIDC_ISSUER": self.issuer,
                    "VPD_OIDC_CLIENT_ID": config.get("client_id"),
                    "VPD_OIDC_REDIRECT_URI": self.redirect_uri,
                })
            missing = [name for name, value in required.items() if not value]
            if missing:
                raise RuntimeError(f"Production authentication configuration is incomplete: {', '.join(missing)}")
            if len(self.session_secret) < 32:
                raise RuntimeError("VPD_SESSION_SECRET must contain at least 32 characters")
            if self.oidc_enabled and self.environment == "production":
                if urlsplit(self.issuer).scheme != "https":
                    raise RuntimeError("Production VPD_OIDC_ISSUER must use HTTPS")
                if urlsplit(self.redirect_uri).scheme != "https":
                    raise RuntimeError("Production VPD_OIDC_REDIRECT_URI must use HTTPS")

        if self.mode != "development":
            users_path = config.get("users_db_path")
            if not users_path:
                raise RuntimeError("Persistent authentication requires VPD_USERS_DB_PATH")
            self.accounts = LocalAccountStore(str(users_path))

        if self.oidc_enabled:
            self.oauth = OAuth()
            self.oauth.register(
                name="company",
                client_id=str(config["client_id"]),
                client_secret=str(config.get("client_secret") or "") or None,
                server_metadata_url=f"{self.issuer}/.well-known/openid-configuration",
                client_kwargs={
                    "scope": "openid profile email",
                    "code_challenge_method": "S256",
                },
            )

    def install(self, app: Any) -> None:
        app.add_middleware(
            SessionMiddleware,
            secret_key=self.session_secret,
            session_cookie=self.cookie_name,
            max_age=self.max_age,
            same_site="lax",
            https_only=self.environment == "production",
        )

    def _session_user(self, request: Request) -> dict[str, Any] | None:
        user = request.session.get("user")
        expires_at = request.session.get("expires_at")
        if not isinstance(user, dict) or not isinstance(expires_at, (int, float)):
            return None
        if expires_at <= time.time():
            request.session.clear()
            return None
        return user

    @staticmethod
    def _ensure_csrf(request: Request) -> str:
        token = request.session.get("csrf_token")
        if not isinstance(token, str) or not token:
            token = secrets.token_urlsafe(32)
            request.session["csrf_token"] = token
        return token

    def _require_csrf(self, request: Request) -> None:
        supplied = request.headers.get("X-CSRF-Token", "")
        expected = str(request.session.get("csrf_token", ""))
        if not expected or not hmac.compare_digest(supplied, expected):
            raise HTTPException(status_code=403, detail="Invalid CSRF token")

    def require_user(self, request: Request) -> dict[str, Any]:
        user = self._session_user(request)
        if user is None:
            raise HTTPException(status_code=401, detail="Authentication required")
        if self.accounts is not None:
            account_id = str(user.get("account_id") or user.get("subject") or "")
            account = self.accounts.get(account_id)
            if account is None or account["status"] != "active":
                request.session.clear()
                raise HTTPException(status_code=401, detail="Account is no longer active")
            user = {
                **user,
                "account_id": account["id"],
                "display_name": account["full_name"],
                "email": account["email"] or None,
                "username": account["username"],
                "role": account["role"],
                "auth_provider": account["auth_provider"],
            }
            request.session["user"] = user
        return user

    async def require_super_admin(self, request: Request) -> dict[str, Any]:
        user = await self.require_authenticated_request(request)
        if user.get("role") != "super_admin":
            raise HTTPException(status_code=403, detail="Super Admin access required")
        return user

    async def require_authenticated_request(self, request: Request) -> dict[str, Any]:
        user = self.require_user(request)
        if request.method not in SAFE_METHODS:
            self._require_csrf(request)
        request.state.current_user = user
        return user

    def _authorized(self, claims: dict[str, Any]) -> bool:
        if not self.allowed_users and not self.allowed_groups:
            return True
        email = str(claims.get("email", "")).lower()
        raw_groups = claims.get(self.groups_claim, [])
        groups = {str(value) for value in raw_groups} if isinstance(raw_groups, list) else set()
        return email in self.allowed_users or bool(groups & self.allowed_groups)

    def _establish_session(self, request: Request, claims: dict[str, Any]) -> dict[str, Any]:
        issuer = str(claims.get("iss", "")).rstrip("/")
        subject = str(claims.get("sub", ""))
        if not issuer or not subject:
            raise HTTPException(status_code=401, detail="Identity token is missing issuer or subject")
        if self.oidc_enabled and issuer != self.issuer:
            raise HTTPException(status_code=401, detail="Identity token issuer does not match configuration")
        if not self._authorized(claims):
            raise HTTPException(status_code=403, detail="This account is not allowed to use the dashboard")

        stable_id = hashlib.sha256(f"{issuer}\0{subject}".encode()).hexdigest()
        if self.accounts is not None:
            account = self.accounts.sync_oidc(stable_id, claims)
            if account["status"] != "active":
                raise HTTPException(status_code=403, detail="This account has been disabled")
            user = {
                "id": stable_id,
                "account_id": account["id"],
                "issuer": issuer,
                "subject": subject,
                "display_name": account["full_name"],
                "email": account["email"] or None,
                "username": account["username"],
                "role": account["role"],
                "auth_provider": "oidc",
            }
        else:
            user = {
                "id": stable_id,
                "issuer": issuer,
                "subject": subject,
                "display_name": str(claims.get("name") or claims.get("preferred_username") or claims.get("email") or subject),
                "email": str(claims.get("email") or "") or None,
                "role": "user",
                "auth_provider": "development",
            }
        now = int(time.time())
        token_exp = claims.get("exp")
        expires_at = min(now + self.max_age, int(token_exp)) if isinstance(token_exp, (int, float)) else now + self.max_age
        request.session.clear()
        request.session.update(
            user=user,
            authenticated_at=now,
            expires_at=expires_at,
            csrf_token=secrets.token_urlsafe(32),
        )
        return user

    def _establish_local_session(self, request: Request, account: dict[str, Any]) -> dict[str, Any]:
        user = {
            "id": f"local:{account['id']}",
            "account_id": account["id"],
            "issuer": "urn:vpd:local-account",
            "subject": account["id"],
            "display_name": account["full_name"],
            "email": account["email"],
            "username": account["username"],
            "role": account["role"],
            "auth_provider": "local",
        }
        now = int(time.time())
        request.session.clear()
        request.session.update(
            user=user,
            authenticated_at=now,
            expires_at=now + self.max_age,
            csrf_token=secrets.token_urlsafe(32),
        )
        return user

    @staticmethod
    def _client_key(request: Request) -> str:
        return request.client.host if request.client is not None else "unknown"

    def _enforce_rate_limit(
        self, request: Request, scope: str, discriminator: str, *, limit: int, window_seconds: int
    ) -> None:
        if self.accounts is None:
            return
        retry_after = self.accounts.consume_rate_limit(
            scope, discriminator, limit=limit, window_seconds=window_seconds
        )
        if retry_after is not None:
            raise HTTPException(
                status_code=429,
                detail="Too many authentication attempts. Please try again later.",
                headers={"Retry-After": str(retry_after)},
            )

    def _check_rate_limit(
        self, scope: str, discriminator: str, *, limit: int, window_seconds: int
    ) -> None:
        if self.accounts is None:
            return
        retry_after = self.accounts.rate_limit_retry_after(
            scope, discriminator, limit=limit, window_seconds=window_seconds
        )
        if retry_after is not None:
            raise HTTPException(
                status_code=429,
                detail="Too many authentication attempts. Please try again later.",
                headers={"Retry-After": str(retry_after)},
            )

    def router(self) -> APIRouter:
        router = APIRouter(prefix="/api/auth", tags=["authentication"])

        @router.get("/config")
        async def auth_config(request: Request, response: Response) -> dict[str, Any]:
            response.headers["Cache-Control"] = "no-store"
            return {
                "mode": self.mode,
                "local_login_available": self.local_enabled,
                "oidc_login_available": self.oidc_enabled,
                "development_login_available": self.mode == "development",
                "csrf_token": self._ensure_csrf(request),
            }

        @router.get("/login")
        async def login(request: Request, next: str = "/") -> Any:
            if not self.oidc_enabled or self.oauth is None:
                raise HTTPException(status_code=404, detail="OIDC login is not configured")
            request.session.clear()
            request.session["login_next"] = _safe_next(next)
            client = self.oauth.create_client("company")
            if client is None:
                raise HTTPException(status_code=503, detail="OIDC client is unavailable")
            return await client.authorize_redirect(request, self.redirect_uri)

        @router.get("/callback")
        async def callback(request: Request) -> RedirectResponse:
            if not self.oidc_enabled or self.oauth is None:
                raise HTTPException(status_code=404, detail="OIDC callback is not configured")
            login_next = _safe_next(request.session.get("login_next"))
            try:
                client = self.oauth.create_client("company")
                if client is None:
                    raise HTTPException(status_code=503, detail="OIDC client is unavailable")
                token = await client.authorize_access_token(request)
                claims = dict(token.get("userinfo") or {})
                self._establish_session(request, claims)
            except OAuthError as exc:
                request.session.clear()
                raise HTTPException(status_code=401, detail="OIDC login could not be validated") from exc
            return RedirectResponse(login_next, status_code=303)

        @router.post("/register", status_code=201)
        async def register(request: Request, payload: dict[str, Any]) -> dict[str, Any]:
            if not self.local_enabled or self.accounts is None:
                raise HTTPException(status_code=404, detail="Local account registration is disabled")
            self._require_csrf(request)
            try:
                self._enforce_rate_limit(
                    request, "register-ip", self._client_key(request), limit=10, window_seconds=3600
                )
                account = self.accounts.register(payload)
            except AccountValidationError as exc:
                raise HTTPException(
                    status_code=400, detail={"message": str(exc), "field": exc.field}
                ) from exc
            except DuplicateAccountError as exc:
                raise HTTPException(
                    status_code=409, detail={"message": str(exc), "field": exc.field}
                ) from exc
            except sqlite3.Error as exc:
                raise HTTPException(
                    status_code=503, detail="Authentication service is temporarily unavailable"
                ) from exc
            return {"ok": True, "username": account["username"]}

        @router.post("/password-login")
        async def password_login(request: Request, payload: dict[str, Any]) -> dict[str, Any]:
            if not self.local_enabled or self.accounts is None:
                raise HTTPException(status_code=404, detail="Local account login is disabled")
            self._require_csrf(request)
            identifier = payload.get("identifier") if isinstance(payload, dict) else None
            password = payload.get("password") if isinstance(payload, dict) else None
            if not isinstance(identifier, str) or not identifier.strip() or not isinstance(password, str):
                raise HTTPException(status_code=400, detail="Username or email and password are required")
            if not password or len(identifier) > 254 or len(password) > MAX_PASSWORD_LENGTH:
                raise HTTPException(status_code=401, detail="Invalid username/email or password")
            client_key = self._client_key(request)
            normalized_identifier = identifier.strip().casefold()
            try:
                self._enforce_rate_limit(
                    request, "login-request-ip", client_key, limit=100, window_seconds=900
                )
                self._check_rate_limit(
                    "login-failure-ip", client_key, limit=30, window_seconds=900
                )
                self._check_rate_limit(
                    "login-failure-identifier", normalized_identifier, limit=10, window_seconds=900
                )
                account = self.accounts.authenticate(identifier, password)
                if account is None:
                    self.accounts.consume_rate_limit(
                        "login-failure-ip", client_key, limit=30, window_seconds=900
                    )
                    self.accounts.consume_rate_limit(
                        "login-failure-identifier", normalized_identifier, limit=10, window_seconds=900
                    )
                    raise HTTPException(status_code=401, detail="Invalid username/email or password")
                self.accounts.clear_rate_limit("login-failure-identifier", normalized_identifier)
            except sqlite3.Error as exc:
                raise HTTPException(
                    status_code=503, detail="Authentication service is temporarily unavailable"
                ) from exc
            return self.current_response(request, self._establish_local_session(request, account))

        @router.post("/dev-login")
        async def development_login(request: Request) -> dict[str, Any]:
            if self.mode != "development":
                raise HTTPException(status_code=404, detail="Development login is disabled")
            origin = request.headers.get("origin")
            if (
                request.client is None
                or not _is_loopback(request.client.host)
                or not _is_loopback(request.headers.get("host"))
                or (origin is not None and not _is_loopback(origin))
            ):
                raise HTTPException(status_code=403, detail="Development login is restricted to loopback")
            user = self._establish_session(
                request,
                {"iss": "urn:vpd:local-development", "sub": "local-developer", "name": "Local Developer"},
            )
            return self.current_response(request, user)

        @router.get("/current")
        async def current(request: Request, response: Response) -> dict[str, Any]:
            response.headers["Cache-Control"] = "no-store"
            return self.current_response(request, self.require_user(request))

        @router.post("/logout")
        async def logout(request: Request) -> dict[str, bool]:
            await self.require_authenticated_request(request)
            request.session.clear()
            return {"ok": True}

        return router

    def current_response(self, request: Request, user: dict[str, Any]) -> dict[str, Any]:
        return {
            "user": user,
            "csrf_token": request.session["csrf_token"],
            "expires_at": request.session["expires_at"],
            "auth_mode": self.mode,
        }
