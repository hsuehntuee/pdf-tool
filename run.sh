#!/usr/bin/env sh
# PDF Tool launcher for macOS / Linux. Usage: ./run.sh [--port 8765] [--host 127.0.0.1] | ./run.sh passwd
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "[PDF Tool] First run: creating virtual environment..."
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
fi
exec .venv/bin/python -m app "$@"
