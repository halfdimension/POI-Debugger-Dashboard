from __future__ import annotations

import os
import resource
import sys

from .config import load_settings
from .datasets import DatasetManager
from .preparation_jobs import PreparationJobManager


def _apply_resource_controls(settings: dict) -> None:
    backend = settings.get("backend", {})
    nice = max(0, min(19, int(backend.get("preparation_worker_nice", 10))))
    memory_limit = max(0, int(backend.get("preparation_worker_memory_bytes", 0)))
    cpu_limit = max(0, int(backend.get("preparation_worker_cpu_seconds", 0)))
    file_limit = max(0, int(backend.get("preparation_worker_file_bytes", 0)))
    if nice:
        os.nice(nice)
    if memory_limit:
        resource.setrlimit(resource.RLIMIT_AS, (memory_limit, memory_limit))
    if cpu_limit:
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_limit, cpu_limit))
    if file_limit:
        resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))


def main() -> int:
    if len(sys.argv) != 3:
        return 2
    job_id, dataset_id = sys.argv[1:]
    settings = load_settings()
    _apply_resource_controls(settings)
    if os.getenv("VPD_PREPARATION_JOB_DIR"):
        settings.setdefault("backend", {})["preparation_job_dir"] = os.environ["VPD_PREPARATION_JOB_DIR"]
    datasets = DatasetManager(settings)
    jobs = PreparationJobManager(settings, datasets.ids)
    jobs.worker_update(job_id, status="running", started_at=jobs._now(), error=None)
    try:
        summary = datasets.reload(dataset_id)
        if summary.get("error"):
            raise RuntimeError("dataset validation failed")
        jobs.worker_update(
            job_id,
            status="completed",
            finished_at=jobs._now(),
            stats=summary.get("stats"),
            error=None,
        )
        return 0
    except Exception:
        jobs.worker_update(
            job_id,
            status="failed",
            finished_at=jobs._now(),
            error="Dataset preparation failed.",
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
