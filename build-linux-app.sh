#!/usr/bin/env bash
#
# Build the Linux "SIM Telemetry Lab" desktop app (Electron shell + bundled FastAPI backend).
#
# Pipeline:
#   0. Delete previous build output (frontend/dist, dist/, build/, dist-electron/)
#   1. Build the Vite frontend             -> frontend/dist
#   2. Bundle the backend with PyInstaller -> dist/lmu-telemetry-backend/
#   3. Package with electron-builder       -> dist-electron/
#
# Output:
#   dist-electron/SIM Telemetry Lab-<version>.AppImage   single clickable file
#   dist-electron/linux-unpacked/                        unpacked dir + launcher binary
#
# Unlike macOS there is no code-signing step; AppImages just need the exec bit,
# which electron-builder already sets.
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> [0/3] Removing previous build output"
# Stale artifacts are the usual cause of "my fix didn't show up": electron-builder
# happily reuses an old frontend/dist or backend bundle. Always start clean.
rm -rf "$SCRIPT_DIR/dist-electron" "$SCRIPT_DIR/dist" "$SCRIPT_DIR/build" "$SCRIPT_DIR/frontend/dist"

echo "==> [1/3] Building frontend"
if [ -f "$SCRIPT_DIR/.venv/bin/activate" ]; then
    source "$SCRIPT_DIR/.venv/bin/activate"
fi
(cd frontend && [ -d node_modules ] || npm install)
(cd frontend && npm run build)

echo "==> [2/3] Bundling backend with PyInstaller"
python -c "import PyInstaller" 2>/dev/null || pip install pyinstaller
pyinstaller --noconfirm backend.spec

echo "==> [3/3] Packaging Electron app"
(cd desktop && [ -d node_modules ] || npm install)
(cd desktop && npm run dist)

echo ""
echo "Done. Artifacts in dist-electron/:"
ls -1 dist-electron/*.AppImage 2>/dev/null || true
echo "  dist-electron/linux-unpacked/sim-telemetry-lab"
echo ""
echo "Run it by double-clicking the .AppImage (make sure it is executable:"
echo "  chmod +x dist-electron/*.AppImage )"
echo ""
echo "To get it into your app menu, run: ./install-linux-app.sh"
