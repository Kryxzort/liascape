#!/usr/bin/env bash
# Stop dev hot-reload services. After this, launching the app falls back to PROD (own backend + dist),
# and the Stop hook resumes rebuilding on change.
systemctl --user stop livepaper-vite.service livepaper-watch.service 2>/dev/null
echo "dev services stopped."
