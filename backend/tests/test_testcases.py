from pathlib import Path

import pytest

from backend.app.testcases import (
    TestcaseConflictError as ConflictError,
    TestcaseNotFoundError as NotFoundError,
    TestcaseRepository as Repository,
)


def payload(name: str = "Right turn landmark") -> dict:
    return {
        "name": name,
        "description": "Regression route",
        "dataset": "rohtak_lmg",
        "request": {
            "start": {"lon": 76.6, "lat": 28.9},
            "end": {"lon": 76.7, "lat": 28.95},
            "costing": "auto",
        },
        "expectation": {"instruction_contains": "Indian Oil", "case_sensitive": False},
    }


def test_testcases_are_private_and_persist_across_reopen(tmp_path: Path) -> None:
    path = tmp_path / "testcases.sqlite3"
    repository = Repository(path, ["rohtak_lmg"])
    created = repository.create("user-a", payload())

    assert repository.get("user-a", created["id"])["name"] == "Right turn landmark"
    assert repository.list("user-a")["total"] == 1
    assert repository.list("user-b")["total"] == 0
    with pytest.raises(NotFoundError):
        repository.get("user-b", created["id"])
    with pytest.raises(NotFoundError):
        repository.update("user-b", created["id"], {"name": "stolen", "revision": 1})
    with pytest.raises(NotFoundError):
        repository.delete("user-b", created["id"])

    reopened = Repository(path, ["rohtak_lmg"])
    assert reopened.get("user-a", created["id"])["request"] == created["request"]


def test_update_requires_current_revision_and_search_is_owner_scoped(tmp_path: Path) -> None:
    repository = Repository(tmp_path / "testcases.sqlite3", ["rohtak_lmg"])
    created = repository.create("user-a", payload())
    updated = repository.update(
        "user-a", created["id"], {"name": "Updated route", "description": "New detail", "revision": 1}
    )
    assert updated["revision"] == 2
    assert repository.list("user-a", query="new detail")["testcases"][0]["id"] == created["id"]
    with pytest.raises(ConflictError):
        repository.update("user-a", created["id"], {"name": "Stale update", "revision": 1})


def test_shared_testcases_are_discoverable_but_only_owner_can_mutate(tmp_path: Path) -> None:
    repository = Repository(tmp_path / "testcases.sqlite3", ["rohtak_lmg"])
    created = repository.create(
        "user-a", {**payload(), "visibility": "shared"},
        owner_display_name="Alice Example", owner_username="alice",
    )

    shared = repository.list_shared("user-b", query="right turn")
    assert shared["total"] == 1
    assert shared["testcases"][0]["owner"] == {
        "display_name": "Alice Example", "username": "alice",
    }
    assert shared["testcases"][0]["is_owner"] is False
    assert repository.get("user-b", created["id"])["id"] == created["id"]
    with pytest.raises(NotFoundError):
        repository.update("user-b", created["id"], {"visibility": "private", "revision": 1})
    with pytest.raises(NotFoundError):
        repository.delete("user-b", created["id"])

    private = repository.update("user-a", created["id"], {"visibility": "private", "revision": 1})
    assert private["visibility"] == "private"
    assert repository.list_shared("user-b")["total"] == 0
    with pytest.raises(NotFoundError):
        repository.get("user-b", created["id"])


def test_personal_listing_supports_visibility_sort_and_bounded_pagination(tmp_path: Path) -> None:
    repository = Repository(tmp_path / "testcases.sqlite3", ["rohtak_lmg"])
    repository.create("user-a", payload("Private route"))
    repository.create("user-a", {**payload("Shared route"), "visibility": "shared"})

    assert repository.list("user-a", visibility="private")["total"] == 1
    page = repository.list("user-a", limit=1, offset=1, sort="created_asc")
    assert page["total"] == 2
    assert len(page["testcases"]) == 1
