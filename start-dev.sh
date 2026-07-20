#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Activate venv if present
if [ -f "$SCRIPT_DIR/.venv/bin/activate" ]; then
    source "$SCRIPT_DIR/.venv/bin/activate"
fi

# Install dependencies if needed
pip install -q -r "$SCRIPT_DIR/backend/requirements.txt"
(cd "$SCRIPT_DIR/frontend" && npm install --silent)

# Start backend
(cd "$SCRIPT_DIR/backend" && uvicorn main:app --port 8000 --reload) &
BACKEND_PID=$!

# Start frontend
(cd "$SCRIPT_DIR/frontend" && npm run dev) &
FRONTEND_PID=$!

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT INT TERM

echo ""
echo "Backend:  http://localhost:8000"
echo "Frontend: http://localhost:5173"
echo "Press Ctrl+C to stop both."
echo ""

wait
