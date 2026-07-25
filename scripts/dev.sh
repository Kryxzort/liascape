#!/usr/bin/env bash
# Dev mode with hot reload. Starts two invisible background services (Vite HMR + dotnet watch)
# as systemd user units, then you just launch the app normally — main.js auto-detects Vite on
# :5173 and loads the UI with HMR (edits apply live, no rebuild, no Stop-hook). The C# backend is
# `dotnet watch --serve` on a pinned port (5174), so .cs edits recompile in ~seconds without losing
# the open window.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Native helpers are core (transitions + scene-audio crossfade), not optional — build them so dev
# exercises them too. The dotnet-watch backend runs with WorkingDirectory=repo and auto-discovers
# these via its repo-relative fallback (TransitionService.RepoPath / PlayerHelper cwd path), so no
# env wiring is needed. set -e aborts loudly if the toolchain is missing (same deps as install.sh).
echo "==> building native helpers (lp-transition + lp-audio)"
make -C "$ROOT/src/native/lp-transition" >/dev/null
make -C "$ROOT/src/native/lp-audio" >/dev/null

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
