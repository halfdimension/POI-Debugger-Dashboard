from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .auth import AuthManager
from .users import AccountOperationError


def admin_router(auth: AuthManager) -> APIRouter:
    router = APIRouter(
        prefix="/api/admin",
        tags=["administration"],
        dependencies=[Depends(auth.require_super_admin)],
    )

    def accounts():
        if auth.accounts is None:
            raise HTTPException(status_code=503, detail="Account administration is unavailable")
        return auth.accounts

    @router.get("/overview")
    async def overview() -> dict[str, int]:
        return accounts().counts()

    @router.get("/users")
    async def list_users(
        search: str = Query(default="", max_length=254),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=25, ge=1, le=100),
    ) -> dict[str, Any]:
        users, total = accounts().list_accounts(
            search=search, offset=(page - 1) * page_size, limit=page_size
        )
        return {"users": users, "total": total, "page": page, "page_size": page_size}

    @router.get("/users/{account_id}")
    async def get_user(account_id: str) -> dict[str, Any]:
        account = accounts().get(account_id)
        if account is None:
            raise HTTPException(status_code=404, detail="Account not found")
        return account

    @router.patch("/users/{account_id}/status")
    async def update_user_status(
        account_id: str, payload: dict[str, Any], request: Request
    ) -> dict[str, Any]:
        if set(payload) != {"status"} or not isinstance(payload.get("status"), str):
            raise HTTPException(status_code=400, detail="A valid status is required")
        actor = request.state.current_user
        try:
            return accounts().set_status(
                account_id, payload["status"], actor_id=str(actor["account_id"])
            )
        except AccountOperationError as exc:
            status_code = 404 if str(exc) == "Account not found" else 409
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc

    return router
