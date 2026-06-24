#!/bin/bash
# Install the web rewrite: publish the C# backend (CLI/daemons/--serve) + build the React UI,
# install a `livepaper` CLI launcher (restore/action/daemons/serve) and a `livepaper-ui` GUI
# launcher (Electron shell → spawns the backend, loads the UI). For a portable AppImage use
# electron-builder: (cd app/shell && npm run dist).
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$HOME/.local/share/livepaper-web"
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"

echo "==> building React UI"
(cd "$ROOT/app/ui" && npm install && npm run build)

echo "==> publishing backend (self-contained)"
rm -rf "$LIB/backend"
dotnet publish "$ROOT/src/livepaper" -r linux-x64 --self-contained -c Release -o "$LIB/backend"

echo "==> staging UI"
rm -rf "$LIB/ui"; mkdir -p "$LIB/ui"; cp -r "$ROOT/app/ui/dist/." "$LIB/ui/"

echo "==> ensuring Electron (shell)"
(cd "$ROOT/app/shell" && npm install >/dev/null 2>&1 || true)
ELECTRON="$ROOT/app/shell/node_modules/electron/dist/electron"
[ -x "$ELECTRON" ] || ELECTRON="$ROOT/demos/shell/node_modules/electron/dist/electron"

mkdir -p "$BIN"
echo "==> installing 'livepaper' (headless CLI: --restore/--action/daemons/--serve)"
cat > "$BIN/livepaper" <<WRAP
#!/bin/bash
export LP_UI_DIR="$LIB/ui"
# bare 'livepaper' opens the GUI; any flag (--restore/--action/--serve/daemons) runs the headless backend
[ \$# -eq 0 ] && exec "$BIN/livepaper-ui"
exec "$LIB/backend/livepaper" "\$@"
WRAP
chmod 755 "$BIN/livepaper"

echo "==> installing 'livepaper-ui' (GUI)"
cat > "$BIN/livepaper-ui" <<WRAP
#!/bin/bash
export LP_BACKEND="$LIB/backend/livepaper"
export LP_UI_DIR="$LIB/ui"
exec "$ELECTRON" "$ROOT/app/shell"
WRAP
chmod 755 "$BIN/livepaper-ui"

mkdir -p "$APPS"
cat > "$APPS/livepaper.desktop" <<EOF
[Desktop Entry]
Name=Livepaper
Comment=Live wallpaper manager (Wayland)
Exec=$BIN/livepaper-ui
Type=Application
Categories=Utility;
Keywords=wallpaper;live;wayland;video;
EOF
update-desktop-database "$APPS" 2>/dev/null || true

echo ""
echo "Done. Ensure $BIN is on PATH."
echo "  GUI:  livepaper            (bare = open the app; livepaper-ui also works)"
echo "  CLI:  livepaper --restore | --action=next-wallpaper | --kill | --serve | …"
