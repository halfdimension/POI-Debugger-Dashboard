#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

if [[ -x "$ROOT/backend/.venv/bin/python" ]]; then
  VPD_PYTHON="$ROOT/backend/.venv/bin/python"
elif [[ -x "$ROOT/.venv/bin/python" ]]; then
  VPD_PYTHON="$ROOT/.venv/bin/python"
else
  VPD_PYTHON="python3"
fi

VPD_UVICORN_ARGS=(
  backend.app.main:app
  --host "${VPD_BACKEND_HOST:-0.0.0.0}"
  --port "${VPD_BACKEND_PORT:-8010}"
)

if [[ "${VPD_RELOAD:-0}" == "1" ]]; then
  VPD_UVICORN_ARGS+=(--reload)
else
  VPD_UVICORN_ARGS+=(--workers "${VPD_BACKEND_WORKERS:-1}")
fi

PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}" \
  "$VPD_PYTHON" -m uvicorn "${VPD_UVICORN_ARGS[@]}"
