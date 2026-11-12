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
# LiascapePlayerMedia, ServerHost, AppOps, the UI store/API/App, the whole Rust player, the transitions, the
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
LIB='itemVol|itemSpd|playlistBarVol|trash|sel[A-Z]|cardToggle|cardApply|race:index|normalize|cli:volume'
PL='pl[A-Z]|playlistBar|race:playlist|shuffle|cardToggle'
SET='set:|g[A-Z]|globalDrag|appear|noop|race:settings|cli:volume|autoMute|normalize'
AUTOMUTE='autoMute|mute'
MODAL='itemVol|itemSpd|playlistBarVol|selVol|previewDrag|globalDrag|cli:volume-up:modalOpen'
CARD='card|sel[A-Z]|trash|itemVol|itemSpd'
# the scene cells: every control on a scene, the scene switches, the GPU / VRAM settings
SCENE='[sS]cene|vram|next:[sv]→[sv]'
# keys while a slider is held (hooks/rangeDrag.ts) / numeric fields that snap on blur (components/NumInput.tsx)
KEYS='keys:'
NUM='num:|plTr'
# programs at the seams: the cover Signal, the start choice, parked rotation, the expert tier, a backend
# that comes and goes, the keybinds (program/ = the states programArmed / programHeld / coverHeld)
PROG='program|cover|plStart|parked|expert|restart:backend|cli:'

full=0; parts=()
add() { parts+=("$1"); echo "  $2 → $1" >&2; }
for f in $FILES; do
  case "$f" in
    docs/*|.claude/*|*.md|LICENSE*|.gitignore) echo "  $f → nothing (docs)" >&2 ;;
    scripts/matrix-cells-for.sh|scripts/test-settings-*.sh|scripts/measure-*|scripts/gen-credits.py) echo "  $f → nothing (a test/tool script)" >&2 ;;
    src/backend/Helpers/LibraryStore.cs|src/backend/Helpers/LibraryService.cs) add "$LIB" "$f" ;;
    src/backend/Helpers/PlaylistService.cs|src/backend/Models/CustomPlaylist*.cs) add "$PL" "$f" ;;
    src/backend/Helpers/SettingsService.cs|src/backend/Models/AppSettings.cs) add "$SET|cover|plStart|parked|expert" "$f" ;;
    src/backend/Helpers/AudioMonitor.cs) add "$AUTOMUTE" "$f" ;;
    src/backend/Helpers/AtomicFile.cs) add "race:|$LIB|$PL|$SET" "$f" ;;
    src/backend/Helpers/ImportService.cs) add "cardApply" "$f (the matrix imports its clips with it)" ;;
    src/backend/Scrapers/*|src/backend/Services/*|src/backend/Helpers/Steam*|src/backend/Web/SteamOps.cs|\
    src/backend/Helpers/Workshop*|src/backend/Helpers/DownloadHelper.cs)
      echo "  $f → nothing (Browse/download/Steam: not in the matrix — test it by hand / its own script)" >&2 ;;
    # the scene worker, its compositor side, the scene helpers, the VRAM rules and their probes: only scenes use them
    src/player/src/sources/scene.rs|src/player/src/worker/*|src/player/src/scene/*|src/player/src/bin/liascape-scene-worker/*|\
    src/player/src/vram.rs|src/player/src/probe/workers.rs|src/player/src/probe/vram.rs) add "$SCENE" "$f" ;;
    app/ui/src/views/Settings.tsx) add "$SET|$SCENE|$NUM|cover|plStart|expert" "$f" ;;
    app/ui/src/hooks/rangeDrag.ts) add "$KEYS|$MODAL" "$f" ;;
    app/ui/src/components/NumInput.tsx) add "$NUM|$SET" "$f (+ --probe probe-expert.js — the stepper: − / +, hold, wheel, keys, roll, look)" ;;
    # the scene properties editor: its parser/values/conditions and the sidebar section (cells sceneProp:*)
    src/backend/Helpers/SceneProperties.cs|app/ui/src/components/ScenePropsEditor.tsx|app/ui/src/components/scenePropsCache.ts) add "$SCENE|$MODAL" "$f" ;;
    # the item sidebar (it replaced the card settings modal): the cells that open it + its own probe
    app/ui/src/components/LibrarySide.tsx|app/ui/src/components/SidePanel.tsx|app/ui/src/components/sidePreview.ts|app/ui/src/components/YouTubeEmbed.tsx|app/ui/src/hooks/useLinger.ts|app/ui/src/hooks/gridKeys.ts|app/ui/src/components/motion.ts)
      add "$MODAL|sceneProp|appear|$KEYS" "$f (+ scripts/test-ui-matrix.sh --probe probe-sidebar.js — the sidebar probe; probe-layout.js perf:sidebar)" ;;
    app/ui/src/components/PlaylistBar.tsx|app/ui/src/hooks/useSmoothScroll.ts|app/ui/src/hooks/useDockLift.ts|app/ui/src/hooks/useBarFold.ts)
      add "$PL|plStart|plTr|travel:|hoverPreview|global:sceneTiming|playlist:sceneTiming" "$f (+ --probe probe-plbar.js — wheel + gap hover; probe-layout.js dock:, scroll:, look:plFold, perf:tabs, perf:plFold, perf:dockRepaint)" ;;
    # the segmented control: the playlist modal's order / start switches, the sidebar's preview strip (the level picker is in App.tsx)
    app/ui/src/components/Segmented.tsx)
      add "$PL|plStart|$MODAL|sceneProp|appear" "$f (+ --probe probe-layout.js seg:, probe-sidebar.js look:strip, probe-expert.js)" ;;
    app/ui/src/components/Playlist*|app/ui/src/components/PlaylistToggle.tsx) add "$PL|plStart|plTr|travel:|global:sceneTiming|playlist:sceneTiming" "$f" ;;
    # the health warning icon (Settings rows + the playlist modal's Transitions field): drawn only — the modal cells must still open
    app/ui/src/components/FeatureWarn.tsx) add "plTr|plStart|$NUM" "$f" ;;
    app/ui/src/components/LibraryCard.tsx|app/ui/src/views/Library.tsx|app/ui/src/components/MotionThumb.tsx|app/ui/src/hooks/useResetOnLeave.ts) add "$CARD|$KEYS|travel:" "$f (+ --probe probe-select.js — box selection; probe-layout.js tabs:keep, perf:tabs)" ;;
    # the preview clips: the backend's store, the card's clip and its hand-overs
    app/ui/src/components/PreviewPlayer.tsx|app/ui/src/components/clipSource.ts|src/backend/Web/ClipStore.cs) add "appear:video|clip:" "$f" ;;
    app/ui/src/hooks/travelToPlaying.ts) add "travel:" "$f" ;;
    # box selection in the Library / Browse grids: the selection cells + its own probe
    app/ui/src/hooks/useMarquee.ts) add "$CARD|browse:" "$f (+ LIASCAPE_MATRIX_SCREEN=1920x1080 scripts/test-ui-matrix.sh --probe probe-select.js)" ;;
    # the grids' column fit and the cards' stable handlers (a tab switch, a sidebar focus)
    app/ui/src/hooks/useGridFit.ts|app/ui/src/hooks/useStableFn.ts)
      add "$CARD|$KEYS|browse:" "$f (+ --probe probe-layout.js — perf:tabs, perf:sidebar, resize:)" ;;
    app/ui/src/index.css) add "$CARD|$PL|$MODAL|appear|$KEYS" "$f (+ LIASCAPE_MATRIX_SCREEN=2560x1440 … --probe probe-layout.js — sizes, tab slide, dock hover, perf:skeleton; --probe probe-icons.js — icon motion)" ;;
    # the icon motion vocabulary: one-shots on every icon button, the magnet on the primary actions, the two-part icons
    app/ui/src/components/iconMotion.ts|app/ui/src/components/magnet.ts|app/ui/src/components/icons.ts)
      add "$CARD|$PL|$MODAL|appear" "$f (+ --probe probe-icons.js — every role; probe-layout.js perf:idle)" ;;
    app/ui/src/components/Card.tsx|app/ui/src/views/Browse.tsx|app/ui/src/components/BrowseSide.tsx|app/ui/src/hooks/useKeptScroll.ts)
      add "browse:" "$f (+ scripts/test-ui-matrix.sh --probe probe-sidebar.js — the sidebar probe; --probe probe-filters.js — the Workshop filter column; --probe probe-select.js — box selection; --probe probe-layout.js — tabs:browse, perf:tabs)" ;;
    # the filter panel and the top bar's split button: not in the matrix (Browse needs the network) — its own probe stubs
    # /browse (hooks/filterMorph.ts: gone, listed so its deletion maps here)
    app/ui/src/components/WorkshopFilterColumn.tsx|app/ui/src/components/workshopFilter.ts|app/ui/src/components/SortFilterButton.tsx|app/ui/src/hooks/filterMorph.ts)
      echo "  $f → nothing in the matrix (run LIASCAPE_MATRIX_SCREEN=2560x1440 scripts/test-ui-matrix.sh --probe probe-filters.js; probe-layout.js resize:)" >&2 ;;
    app/shell/probe-filters.js|app/shell/probe-sidebar.js|app/shell/probe-plbar.js|app/shell/probe-layout.js|app/shell/probe-preview.js|app/shell/probe-plmenu.js|app/shell/probe.js|app/shell/probe-health.js|app/shell/probe-expert.js|app/shell/probe-select.js|app/shell/probe-icons.js|app/shell/probe-steam.js)
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
    # the player's rotation program + the covered Signal, and the backend adapter that feeds the program: every rotation, every
    # keybind, every user switch runs through them — the whole matrix (the PROG families alone would miss the plain cells)
    src/player/src/recipes/program/*|src/player/src/signal/*|src/backend/Player/LiascapePlayerProgram.cs)
      full=1; echo "  $f → FULL (the program / the Signals: all rotation runs in them; the $PROG cells above all)" >&2 ;;
    *) full=1; echo "  $f → FULL (central or unmapped)" >&2 ;;
  esac
done

if [ "$full" = 1 ]; then echo FULL
elif [ ${#parts[@]} -eq 0 ]; then echo NONE
else (IFS='|'; echo "× .*(${parts[*]})"); fi
