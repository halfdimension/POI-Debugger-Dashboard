from __future__ import annotations

import fcntl
import json
import os
import re
import subprocess
import sys
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator


ACTIVE_STATES = {"pending", "running"}
TERMINAL_STATES = {"completed", "failed"}
JOB_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")


class PreparationJobError(RuntimeError):
    pass


class PreparationCapacityError(PreparationJobError):
    pass


class PreparationJobNotFoundError(PreparationJobError):
    pass


class PreparationJobManager:
    """Small file-backed supervisor for isolated dataset preparation workers."""

    def __init__(
        self,
        settings: dict[str, Any],
        dataset_ids: tuple[str, ...],
        launcher: Callable[[str, str], int] | None = None,
    ):
        backend = settings.get("backend", {})
        index_dir = Path(str(backend.get("poi_index_dir") or ".cache/poi-search"))
        self._directory = Path(
            str(backend.get("preparation_job_dir") or index_dir / "jobs")
        )
        self._directory.mkdir(parents=True, exist_ok=True)
        self._lock_path = self._directory / ".lock"
        self._dataset_ids = set(dataset_ids)
        self._settings = settings
        self._history_limit = max(10, int(backend.get("preparation_job_history_limit", 100)))
        self._launcher = launcher or self._launch

    @contextmanager
    def _locked(self) -> Iterator[None]:
        with self._lock_path.open("a+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _path(self, job_id: str) -> Path:
        if not JOB_ID_PATTERN.fullmatch(job_id):
            raise PreparationJobNotFoundError("Preparation job not found")
        return self._directory / f"{job_id}.json"

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    def _read(self, path: Path) -> dict[str, Any]:
        try:
            with path.open("r", encoding="utf-8") as handle:
                value = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            raise PreparationJobNotFoundError("Preparation job not found") from exc
        if not isinstance(value, dict):
            raise PreparationJobNotFoundError("Preparation job not found")
        return value

    @staticmethod
    def _write(path: Path, value: dict[str, Any]) -> None:
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _worker_alive(job: dict[str, Any]) -> bool:
        pid = job.get("pid")
        job_id = str(job.get("id", ""))
        if not isinstance(pid, int) or pid <= 1:
            return False
        try:
            command = Path(f"/proc/{pid}/cmdline").read_bytes().decode("utf-8", "replace")
        except OSError:
            return False
        return "backend.app.preparation_worker" in command and job_id in command

    def _reconcile(self, job: dict[str, Any], path: Path) -> dict[str, Any]:
        status = job.get("status")
        pending_grace = False
        if status == "pending":
            try:
                created = datetime.fromisoformat(str(job.get("created_at")))
                pending_grace = (datetime.now(timezone.utc) - created).total_seconds() < 5
            except ValueError:
                pass
        if status in ACTIVE_STATES and not pending_grace and not self._worker_alive(job):
            job = {
                **job,
                "status": "failed",
                "updated_at": self._now(),
                "finished_at": self._now(),
                "error": "Preparation worker stopped unexpectedly.",
            }
            self._write(path, job)
        return job

    def _jobs(self) -> list[tuple[Path, dict[str, Any]]]:
        result: list[tuple[Path, dict[str, Any]]] = []
        for path in self._directory.glob("*.json"):
            try:
                result.append((path, self._reconcile(self._read(path), path)))
            except PreparationJobNotFoundError:
                continue
        return result

    def _launch(self, job_id: str, dataset_id: str) -> int:
        env = os.environ.copy()
        env["VPD_CONFIG"] = str(self._settings["_config_path"])
        env["VPD_PREPARATION_JOB_DIR"] = str(self._directory)

        process = subprocess.Popen(
            [sys.executable, "-m", "backend.app.preparation_worker", job_id, dataset_id],
            cwd=Path(__file__).resolve().parents[2],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        threading.Thread(target=process.wait, daemon=True).start()
        return process.pid

    @staticmethod
    def _public(job: dict[str, Any]) -> dict[str, Any]:
        return {
            key: job.get(key)
            for key in (
                "id", "dataset_id", "status", "created_at", "started_at",
                "updated_at", "finished_at", "error", "stats",
            )
            if job.get(key) is not None
        }

    def submit(self, dataset_id: str, requested_by: str) -> tuple[dict[str, Any], bool]:
        if dataset_id not in self._dataset_ids:
            raise PreparationJobNotFoundError("Unknown dataset")
        with self._locked():
            jobs = self._jobs()
            for _, job in jobs:
                if job.get("dataset_id") == dataset_id and job.get("status") in ACTIVE_STATES:
                    return self._public(job), False
            if any(job.get("status") in ACTIVE_STATES for _, job in jobs):
                raise PreparationCapacityError("Another dataset preparation job is already active")

            job_id = uuid.uuid4().hex
            now = self._now()
            path = self._path(job_id)
            job = {
                "id": job_id,
                "dataset_id": dataset_id,
                "status": "pending",
                "created_at": now,
                "updated_at": now,
                "requested_by": requested_by,
            }
            self._write(path, job)
            try:
                pid = self._launcher(job_id, dataset_id)
                current = self._read(path)
                current["pid"] = pid
                current["updated_at"] = self._now()
                self._write(path, current)
                job = current
            except Exception as exc:
                job.update({
                    "status": "failed", "updated_at": self._now(),
                    "finished_at": self._now(), "error": "Preparation worker could not be started.",
                })
                self._write(path, job)
                raise PreparationJobError("Preparation worker could not be started") from exc
            self._trim(jobs)
            return self._public(job), True

    def _trim(self, jobs: list[tuple[Path, dict[str, Any]]]) -> None:
        terminal = sorted(
            ((path, job) for path, job in jobs if job.get("status") in TERMINAL_STATES),
            key=lambda item: str(item[1].get("created_at", "")),
            reverse=True,
        )
        for path, _ in terminal[self._history_limit:]:
            path.unlink(missing_ok=True)

    def get(self, job_id: str) -> dict[str, Any]:
        with self._locked():
            path = self._path(job_id)
            if not path.is_file():
                raise PreparationJobNotFoundError("Preparation job not found")
            return self._public(self._reconcile(self._read(path), path))

    def state_for_dataset(self, dataset_id: str) -> str:
        with self._locked():
            matching = [job for _, job in self._jobs() if job.get("dataset_id") == dataset_id]
            if not matching:
                return "pending"
            latest = max(matching, key=lambda job: str(job.get("created_at", "")))
            return str(latest.get("status", "pending"))

    def decorate_registry(self, registry: dict[str, Any]) -> dict[str, Any]:
        with self._locked():
            jobs = self._jobs()
        latest: dict[str, dict[str, Any]] = {}
        for _, job in jobs:
            dataset_id = str(job.get("dataset_id", ""))
            if dataset_id and str(job.get("created_at", "")) >= str(latest.get(dataset_id, {}).get("created_at", "")):
                latest[dataset_id] = job
        for summary in registry.get("datasets", []):
            job = latest.get(str(summary.get("id")))
            if not job:
                continue
            status = job.get("status")
            summary["preparation_state"] = "preparing" if status in ACTIVE_STATES else status
            if status == "completed" and isinstance(job.get("stats"), dict):
                summary["stats"] = job["stats"]
                summary["loaded_at"] = job.get("finished_at")
                summary["error"] = None
            elif status == "failed":
                summary["error"] = job.get("error")
        return registry

    def worker_update(self, job_id: str, **changes: Any) -> None:
        with self._locked():
            path = self._path(job_id)
            job = self._read(path)
            job.update(changes)
            job["updated_at"] = self._now()
            self._write(path, job)
