#!/usr/bin/env bash
#
# Install the built AppImage into the desktop environment so "SIM Telemetry Lab"
# shows up in the application menu / launcher and can be pinned like any other app.
#
# Installs to the user's home only -- no root, no system-wide changes:
#   ~/Applications/SIM Telemetry Lab.AppImage
#   ~/.local/share/icons/hicolor/512x512/apps/sim-telemetry-lab.png
#   ~/.local/share/applications/sim-telemetry-lab.desktop
#
# Run ./build-linux-app.sh first. Re-run this after a rebuild to update in place.
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

APP_NAME="SIM Telemetry Lab"
SRC_APPIMAGE="$(ls -t "$SCRIPT_DIR"/dist-electron/*.AppImage 2>/dev/null | head -1)"

if [ -z "$SRC_APPIMAGE" ]; then
    echo "No AppImage found in dist-electron/. Run ./build-linux-app.sh first." >&2
    exit 1
fi

INSTALL_DIR="$HOME/Applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
DESKTOP_DIR="$HOME/.local/share/applications"
DEST_APPIMAGE="$INSTALL_DIR/$APP_NAME.AppImage"

mkdir -p "$INSTALL_DIR" "$ICON_DIR" "$DESKTOP_DIR"

echo "==> Installing $(basename "$SRC_APPIMAGE")"
cp "$SRC_APPIMAGE" "$DEST_APPIMAGE"
chmod +x "$DEST_APPIMAGE"

echo "==> Installing icon"
cp "$SCRIPT_DIR/desktop/build/icon.png" "$ICON_DIR/sim-telemetry-lab.png"

echo "==> Writing desktop entry"
cat > "$DESKTOP_DIR/sim-telemetry-lab.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=Analyse Le Mans Ultimate and ACC telemetry
Exec="$DEST_APPIMAGE" %U
Icon=sim-telemetry-lab
Terminal=false
Categories=Utility;Science;
StartupWMClass=$APP_NAME
EOF

chmod +x "$DESKTOP_DIR/sim-telemetry-lab.desktop"

# Refresh the menu cache where the tooling is available (best effort).
update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

echo ""
echo "Done. \"$APP_NAME\" is now in your application menu."
echo "You can also launch it directly:"
echo "  \"$DEST_APPIMAGE\""
