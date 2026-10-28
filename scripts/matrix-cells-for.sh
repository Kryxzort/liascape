#!/usr/bin/env bash
# Which UI-matrix cells a change can affect: `scripts/test-ui-matrix.sh --changed [<rev>]` runs only those.
# Prints FULL (run everything), NONE (the matrix covers nothing that changed) or a regex over cell names
# (`<state> × <control>`, the same as --only); why, per file, goes to stderr.
#
# Usage: scripts/matrix-cells-for.sh [<rev>]
#   no rev: the uncommitted change (staged + unstaged vs HEAD, plus untracked files) — "before I commit";
#   <rev>:  everything since it (e.g. the commit the last full run passed on).
#
# Conservative on purpose: a file this table doesn't know, or one most of the app runs through (PlayerHelper,
# LpPlayerMedia, ServerHost, AppOps, the UI store/API/App, the whole Rust player, the transitions, the
# matrix's own runner/oracle), means FULL — the matrix exists to catch seams, and a narrow guess that misses
# one is worse than 20 minutes. The full run stays the gate before a merge or a release build.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
REV=${1:-}

if [ -n "$REV" ]; then
  FILES=$(git diff --name-only "$REV" --)
else
  FILES=$( { git diff --name-only HEAD --; git ls-files --others --exclude-standard; } | sort -u)
fi

# control families (matched anywhere after "× ", so the seq:/seq3:/seq5: chains that contain them run too)
LIB='itemVol|itemSpd|stripVol|trash|sel[A-Z]|cardToggle|cardApply|race:index|normalize|cli:volume'
PL='pl[A-Z]|strip|race:playlist|shuffle|cardToggle'
SET='set:|g[A-Z]|globalDrag|appear|noop|race:settings|cli:volume|autoMute|normalize'
AUTOMUTE='autoMute|mute'
MODAL='itemVol|itemSpd|stripVol|selVol|previewDrag|globalDrag'
CARD='card|sel[A-Z]|trash|itemVol|itemSpd'
# the scene cells (Phase 2 Task 12): every control on a scene, the scene switches, the GPU / VRAM settings
SCENE='[sS]cene|vram|next:[sv]→[sv]'

full=0; parts=()
add() { parts+=("$1"); echo "  $2 → $1" >&2; }
for f in $FILES; do
  case "$f" in
    docs/*|.claude/*|*.md|LICENSE*|.gitignore) echo "  $f → nothing (docs)" >&2 ;;
    scripts/matrix-cells-for.sh|scripts/test-settings-*.sh|scripts/measure-*|scripts/gen-credits.py) echo "  $f → nothing (a test/tool script)" >&2 ;;
    src/livepaper/Helpers/LibraryStore.cs|src/livepaper/Helpers/LibraryService.cs) add "$LIB" "$f" ;;
    src/livepaper/Helpers/PlaylistService.cs|src/livepaper/Models/CustomPlaylist*.cs) add "$PL" "$f" ;;
    src/livepaper/Helpers/SettingsService.cs|src/livepaper/Models/AppSettings.cs) add "$SET" "$f" ;;
    src/livepaper/Helpers/AudioMonitor.cs) add "$AUTOMUTE" "$f" ;;
    src/livepaper/Helpers/AtomicFile.cs) add "race:|$LIB|$PL|$SET" "$f" ;;
    src/livepaper/Helpers/ImportService.cs) add "cardApply" "$f (the matrix imports its clips with it)" ;;
    src/livepaper/Scrapers/*|src/livepaper/Services/*|src/livepaper/Helpers/Steam*|src/livepaper/Web/SteamOps.cs|\
    src/livepaper/Helpers/Workshop*|src/livepaper/Helpers/DownloadHelper.cs)
      echo "  $f → nothing (Browse/download/Steam: not in the matrix — test it by hand / its own script)" >&2 ;;
    # the scene worker, its compositor side, the scene helpers, the VRAM rules and their probes: only scenes use them
    src/player/src/sources/scene.rs|src/player/src/worker/*|src/player/src/scene/*|src/player/src/bin/lp-scene-worker/*|\
    src/player/src/vram.rs|src/player/src/probe/workers.rs|src/player/src/probe/vram.rs) add "$SCENE" "$f" ;;
    app/ui/src/views/Settings.tsx) add "$SET|$SCENE" "$f" ;;
    app/ui/src/components/LibrarySettingsModal.tsx) add "$MODAL" "$f" ;;
    app/ui/src/components/Playlist*|app/ui/src/components/PlaylistToggle.tsx) add "$PL" "$f" ;;
    app/ui/src/components/LibraryCard.tsx|app/ui/src/views/Library.tsx|app/ui/src/components/MotionThumb.tsx) add "$CARD" "$f" ;;
    app/ui/src/index.css) add "$CARD|$PL|$MODAL|appear" "$f" ;;
    app/ui/src/components/morph.ts|app/ui/src/components/useMorph.ts|app/ui/src/components/PreviewModal.tsx|\
    app/ui/src/components/Card.tsx|app/ui/src/views/Browse.tsx)
      echo "  $f → nothing here — run scripts/test-ui-matrix.sh --probe probe-morph.js (the morph probe)" >&2 ;;
    app/shell/probe-morph.js|app/shell/probe-preview.js|app/shell/probe-plmenu.js|app/shell/probe.js)
      echo "  $f → nothing (another probe — run it with --probe)" >&2 ;;
    app/shell/probe-matrix.js)
      # the cells whose definitions the diff touches: each changed line's enclosing top-level statement must
      # be a cell (`C[…] = …`, or a `for` loop defining cells); a helper / the oracle / the runner → FULL
      names=$(git diff -U0 ${REV:-HEAD} -- "$f" 2>/dev/null | python3 -c '
import re, sys
new = open(sys.argv[1]).read().split("\n")
lines = set()
for h in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", sys.stdin.read(), re.M):
    a, n = int(h.group(1)), int(h.group(2) or 1)
    lines.update(range(a, a + max(n, 1)))   # a pure deletion (n=0) still names the statement at that spot
out = set()
for ln in sorted(lines):
    k = min(ln, len(new)) - 1
    while k > 0 and not re.match(r"\S", new[k]): k -= 1     # the top-level line this one belongs to
    while k > 0 and (new[k].startswith((" ", "\t", "}", ")")) or new[k].strip() == "" or new[k].startswith("//")): k -= 1
    top = new[k]
    m = re.match(r"(?:for \(.*\) )?C\[[`\x22]([^`\x22$]*)", top)
    if not m: print("FULL"); sys.exit()
    out.add(re.escape(m.group(1)) if m.group(1) else "FULL")
print("FULL" if "FULL" in out or not out else "|".join(sorted(out)))
' "$f")
      if [ "$names" = FULL ] || [ -z "$names" ]; then full=1; echo "  $f → FULL (runner/oracle/helpers changed)" >&2
      else add "$names" "$f (cells in the diff)"; fi ;;
    *) full=1; echo "  $f → FULL (central or unmapped)" >&2 ;;
  esac
done

if [ "$full" = 1 ]; then echo FULL
elif [ ${#parts[@]} -eq 0 ]; then echo NONE
else (IFS='|'; echo "× .*(${parts[*]})"); fi
