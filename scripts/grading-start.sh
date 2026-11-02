#!/usr/bin/env sh
# Experimental pre-grading: start the local grading service on 127.0.0.1:8765 (this computer only).
set -e
cd "$(dirname "$0")/.."
[ -x .venv-grading/bin/python ] || { echo "Run scripts/grading-setup.sh first." >&2; exit 1; }
exec .venv-grading/bin/python -m uvicorn services.grading.app:app --host 127.0.0.1 --port 8765
