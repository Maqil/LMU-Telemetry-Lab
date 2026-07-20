#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$SCRIPT_DIR/.lmu-dev.pid"

stop_services() {
    if [ -f "$PIDFILE" ]; then
        while read -r pid; do
            kill "$pid" 2>/dev/null
        done < "$PIDFILE"
        rm -f "$PIDFILE"
    fi
}

# Stop any previously running instance
stop_services

# Activate venv
if [ -f "$SCRIPT_DIR/.venv/bin/activate" ]; then
    source "$SCRIPT_DIR/.venv/bin/activate"
fi

# Start backend
(cd "$SCRIPT_DIR/backend" && uvicorn main:app --port 8000) &
echo $! > "$PIDFILE"

# Start frontend
(cd "$SCRIPT_DIR/frontend" && npm run dev) &
echo $! >> "$PIDFILE"

# Wait for frontend to be ready, then open browser
for i in $(seq 1 30); do
    if curl -s -o /dev/null http://localhost:5173 2>/dev/null; then
        xdg-open http://localhost:5173 &
        break
    fi
    sleep 1
done

trap stop_services EXIT INT TERM

wait
