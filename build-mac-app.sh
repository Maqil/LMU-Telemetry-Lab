#!/usr/bin/env bash
#
# Build the macOS "SIM Telemetry Lab.app" (Electron shell + bundled FastAPI backend).
#
# Pipeline:
#   1. Build the Vite frontend            -> frontend/dist
#   2. Bundle the backend with PyInstaller -> dist/lmu-telemetry-backend/
#   3. Package with electron-builder       -> dist-electron/mac-arm64/SIM Telemetry Lab.app
#   4. Ad-hoc code-sign the whole bundle   (REQUIRED on Apple Silicon / recent macOS,
#      otherwise Gatekeeper/XProtect flags the unsigned app as "malware" and trashes it)
#
# The result is signed for LOCAL use only (not notarized). To share it with other
# machines you'd need an Apple Developer ID certificate + notarization.
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

APP_NAME="SIM Telemetry Lab"
APP_PATH="$SCRIPT_DIR/dist-electron/mac-arm64/$APP_NAME.app"

echo "==> [1/4] Building frontend"
if [ -f "$SCRIPT_DIR/.venv/bin/activate" ]; then
    source "$SCRIPT_DIR/.venv/bin/activate"
fi
(cd frontend && npm run build)

echo "==> [2/4] Bundling backend with PyInstaller"
python -c "import PyInstaller" 2>/dev/null || pip install pyinstaller
pyinstaller --noconfirm backend.spec

echo "==> [3/4] Packaging Electron app"
(cd desktop && [ -d node_modules ] || npm install)
(cd desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack)

echo "==> [4/4] Ad-hoc code-signing (inside-out)"
BK="$APP_PATH/Contents/Resources/backend-dist/lmu-telemetry-backend"
# Sign nested native libraries first, then the backend binary, then the whole bundle.
find "$BK" -type f \( -name "*.so" -o -name "*.dylib" \) -print0 \
    | xargs -0 -I{} codesign --force --sign - --timestamp=none "{}"
codesign --force --sign - --timestamp=none "$BK/lmu-telemetry-backend"
codesign --force --deep --sign - --timestamp=none "$APP_PATH"

echo "==> Verifying signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo ""
echo "Done. App built and signed at:"
echo "  $APP_PATH"
echo ""
echo "Drag it into /Applications (or double-click it where it is) to run."
