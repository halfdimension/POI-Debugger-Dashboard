from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from backend.app.preferences import PreferenceValidationError, UserPreferenceStore


def test_two_users_keep_independent_dataset_preferences_across_reopen() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "preferences.sqlite3"
        store = UserPreferenceStore(path, ["example", "rohtak_lmg"], "example")
        store.update("stable-user-a", {"selected_dataset_id": "rohtak_lmg"})
        store.update("stable-user-b", {"selected_dataset_id": "example"})

        reopened = UserPreferenceStore(path, ["example", "rohtak_lmg"], "example")
        assert reopened.get("stable-user-a")["selected_dataset_id"] == "rohtak_lmg"
        assert reopened.get("stable-user-b")["selected_dataset_id"] == "example"


def test_user_identity_cannot_be_supplied_as_a_preference_field() -> None:
    with tempfile.TemporaryDirectory() as directory:
        store = UserPreferenceStore(Path(directory) / "preferences.sqlite3", ["example"], "example")
        with pytest.raises(PreferenceValidationError, match="Unknown preference fields: user_id"):
            store.update("stable-user-a", {"user_id": "stable-user-b"})
        with pytest.raises(PreferenceValidationError, match="Unknown dataset"):
            store.update("stable-user-a", {"selected_dataset_id": "missing"})


def test_removed_dataset_falls_back_and_repairs_persisted_selection() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "preferences.sqlite3"
        original = UserPreferenceStore(path, ["example", "removed"], "example")
        original.update("stable-user", {"selected_dataset_id": "removed"})

        changed = UserPreferenceStore(path, ["example"], "example")
        result = changed.get("stable-user")
        assert result["selected_dataset_id"] == "example"
        assert result["dataset_selection_fallback"] is True
        assert result["unavailable_dataset_id"] == "removed"
        assert changed.get("stable-user")["dataset_selection_fallback"] is False
