#!/usr/bin/env bash
# Dev mode with hot reload. Starts two invisible background services (Vite HMR + dotnet watch)
# as systemd user units, then you just launch the app normally — main.js auto-detects Vite on
# :5173 and loads the UI with HMR (edits apply live, no rebuild, no Stop-hook). The C# backend is
# `dotnet watch --serve` on a pinned port (5174), so .cs edits recompile in ~seconds without losing
# the open window.
set -e

systemctl --user daemon-reload
systemctl --user enable --now livepaper-vite.service livepaper-watch.service

echo "==> dev services:"
systemctl --user --no-pager --plain is-active livepaper-vite.service livepaper-watch.service || true
echo "    Vite HMR : http://localhost:5173"
echo "    backend  : 127.0.0.1:5174  (dotnet watch)"
echo ""
echo "Now launch the app (livepaper-ui / your launcher) — it auto-uses HMR while these run."
echo "Logs : journalctl --user -fu livepaper-vite   |   journalctl --user -fu livepaper-watch"
echo "Stop : systemctl --user stop livepaper-vite livepaper-watch   (or: scripts/dev-stop.sh)"
