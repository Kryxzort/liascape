#!/usr/bin/env bash
# agent-window.sh — a Liascape window for agents, so probes, benches and CDP scripts never drive the owner's.
#
#   bash scripts/agent-window.sh up       start it (prints its CDP / Vite / API ports)
#   bash scripts/agent-window.sh status   what runs, and the CDP endpoint
#   bash scripts/agent-window.sh down     stop everything it started; prints the session compositor's monitors /
#                                         workspaces / windows / focus diffed against the snapshot `up` took
#   bash scripts/agent-window.sh snapshot print that normalized snapshot (read-only)
#
# What `up` starts, all apart from the user's own app (CDP :9222, Vite :5173, backend :5174, media :5175 are the user's;
# this script refuses to use them) and apart from the user's Hyprland, which it only ever reads:
# - A private compositor: gamescope on its headless backend (no window, no DRM output; not session-based, so no seat and
#   no libinput), rendering with Vulkan on the GPU, in a bubblewrap sandbox with its own network namespace (its
#   Xwayland's abstract X socket would otherwise answer the session's DISPLAY), a private /tmp and /run/user/<uid> (its
#   Wayland socket lands in this state dir). The page gets a frameless window of the output's size, keyboard focus
#   (document.hasFocus()) and rAF at LIASCAPE_AGENT_HZ; hardware GL (ANGLE on the NVIDIA driver). gamescope keeps about
#   one CPU core busy while it runs.
#   Why not a headless output in the session's Hyprland: a window on a hidden workspace renders no frames, and taking
#   an output away again always snaps the user's cursor to another monitor's centre and focuses it (Hyprland 0.57.1
#   CMonitor::onDisconnect: warpTo(backup monitor centre, force = true), which `cursor:no_warps` doesn't stop).
# - The Electron shell from this checkout (app/shell) on native Wayland inside that compositor, with its own CDP port,
#   Chromium profile (private HOME / XDG dirs), no D-Bus (no MPRIS, no keyring) and no audio output.
# - Vite dev on its own port and cache dir (HMR works; the user's Vite keeps its own dep cache).
# - The backend (a snapshot of src/backend/bin/Debug) and a headless liascape-player (`--ao null`) inside a bubblewrap
#   sandbox: the whole filesystem read-only except this state dir, with private copies of the user's settings, library
#   index, playlists and preview caches bound over the user's own liascape dirs (same paths, so every stored path
#   resolves), a private /tmp and an empty /run/user/<uid> (no Wayland, Hyprland, D-Bus or audio server). The media
#   stays where it is, read-only; Steam client and steamcmd paths are cleared, secrets stay in a private file.
# - A watcher (read-only) for the whole of `up` / `down`: the session Hyprland's events and, at 20 Hz, the cursor, the
#   focused monitor and the active window, in log/watch-*.log. Any of those changing during one of this script's steps
#   aborts it: nothing here may show up on the user's side.
#
# State: $LIASCAPE_AGENT_DIR (default ~/.cache/liascape-agent-window); `run/cdp.port` there is how app/shell/cdp.js and
# scripts/bench-live-ui.mjs find the window (`--owner` targets the user's window instead). `up` rebuilds the private
# settings / library copy from the user's current ones, in place; the preview caches, Chromium profile and Vite cache
# persist.
# Ports: LIASCAPE_AGENT_CDP_PORT (9333), LIASCAPE_AGENT_VITE_PORT (5183), LIASCAPE_AGENT_PORT (5184; media +1).
# The private output: LIASCAPE_AGENT_SIZE (1920x1080), LIASCAPE_AGENT_HZ (144).
# Needs: gamescope, bwrap, hyprctl (read-only), jq, node, python3, electron (LIASCAPE_ELECTRON), curl; the backend built
# (`dotnet build src/backend`) and the release player (`scripts/dev.sh` builds both).
set -eEuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
S=${LIASCAPE_AGENT_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/liascape-agent-window}
RUN=$S/run LOG=$S/log H=$S/home
CPORT=${LIASCAPE_AGENT_CDP_PORT:-9333} VPORT=${LIASCAPE_AGENT_VITE_PORT:-5183} BPORT=${LIASCAPE_AGENT_PORT:-5184}
SIZE=${LIASCAPE_AGENT_SIZE:-1920x1080} HZ=${LIASCAPE_AGENT_HZ:-144}
# the user's own dirs, where their backend keeps them (.NET: ApplicationData / LocalApplicationData / UserProfile/.cache)
OCFG=${XDG_CONFIG_HOME:-$HOME/.config}/liascape
ODATA=${XDG_DATA_HOME:-$HOME/.local/share}/liascape
OCACHE=$HOME/.cache/liascape
ELECTRON=${LIASCAPE_ELECTRON:-electron}
PLAYER=${LIASCAPE_AGENT_PLAYER_BIN:-$ROOT/src/player/target/release/liascape-player}
MARK="LIASCAPE_AGENT_WINDOW=$S" # in every process this starts: how `down` finds them (never by name)

say() { echo "agent-window: $*" >&2; }
die() { say "$*"; exit 1; }

# ---- processes -------------------------------------------------------------------------------------------------
# A process is this window's by its marker variable, or (Chromium rewrites its environ for the process title) by the pid
# AND start time recorded when it was started: a recycled pid never matches.
is_ours() { [ "$1" != $$ ] && grep -qzxF "$MARK" "/proc/$1/environ" 2>/dev/null; }
ours() { grep -lzxF "$MARK" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3 | grep -vx "$$" || true; }
pstart() { local s; s=$(cat "/proc/$1/stat" 2>/dev/null) || return 1; s=${s##*) }; set -- $s; echo "${20}"; }
alive() { [ -n "$1" ] && [ "$(pstart "$1" 2>/dev/null)" = "$2" ]; } # $1 = pid, $2 = its recorded start time
record() { local st; st=$(pstart "$2") || return 1; echo "$2 $st" >"$RUN/$1.pid"; } # $1 = role, $2 = pid
role_pid() { local p st; read -r p st 2>/dev/null <"$RUN/$1.pid" || return 0; alive "$p" "$st" && echo "$p"; true; }
# every descendant of $1 as "pid start" lines (Electron's zygotes, GPU process, renderers)
descendants() {
  local kids k; kids=$(ps -e -o pid=,ppid= | awk -v p="$1" '$2 == p { print $1 }')
  for k in $kids; do echo "$k $(pstart "$k")"; descendants "$k"; done
}
# SIGTERM, up to $3 tenths of a second, then SIGKILL — only while the pid is still the process recorded ($2 = start time)
stop_pid() {
  local p=$1 st=$2 t=${3:-50} i
  alive "$p" "$st" || return 0
  kill -TERM "$p" 2>/dev/null || return 0
  for ((i = 0; i < t; i++)); do alive "$p" "$st" || return 0; sleep 0.1; done
  alive "$p" "$st" && { say "pid $p ignored SIGTERM: SIGKILL"; kill -KILL "$p" 2>/dev/null; }
  true
}
stop_role() { # $1 = role, $2 = tenths of a second to wait
  local p st; read -r p st 2>/dev/null <"$RUN/$1.pid" || return 0
  [ -n "${st:-}" ] && stop_pid "$p" "$st" "$2"
  : >"$RUN/$1.pid"
}
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || (exec 3<>"/dev/tcp/::1/$1") 2>/dev/null; }
wait_for() { # $1 = tenths of a second, rest = a command that succeeds when ready; gives up at once on a watcher abort
  local t=$1 i; shift
  for ((i = 0; i < t; i++)); do check_abort; "$@" && return 0; sleep 0.1; done
  return 1
}

# ---- the watcher: what the compositor did while this script ran ------------------------------------------------
# A Python sidecar for the whole of `up` / `down`, reading the session Hyprland's sockets only: every socket2 event
# (window titles left out: they are the user's) and, at 20 Hz, the cursor position, the focused monitor and the active
# window, into log/watch-<command>.log. The script marks its steps in run/step; a cursor move over 2 px, a focus change
# or an output / workspace / window / layer event while a step runs (or within 0.5 s after it) writes run/abort, and
# the script stops at its next check.
WATCH_PY='import json, os, socket, sys, time
log, stepf, abortf, cap = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
base = os.path.join(os.environ["XDG_RUNTIME_DIR"], "hypr", os.environ["HYPRLAND_INSTANCE_SIGNATURE"])
def req(cmd):
    c = socket.socket(socket.AF_UNIX); c.settimeout(1); c.connect(base + "/.socket.sock"); c.sendall(cmd.encode()); out = b""
    while True:
        d = c.recv(65536)
        if not d: break
        out += d
    c.close(); return out.decode(errors="replace")
def state():
    x, y = (float(v) for v in req("cursorpos").split(","))
    mon = next((m["name"] for m in json.loads(req("j/monitors")) if m.get("focused")), "")
    win = (json.loads(req("j/activewindow") or "{}") or {}).get("address", "")
    return x, y, mon, win
def ts():
    t = time.time(); return time.strftime("%H:%M:%S", time.localtime(t)) + ".%03d" % (int(t * 1000) % 1000)
def redact(line):
    name, _, data = line.partition(">>")
    if name.startswith("windowtitle") or name == "activewindow": return name + ">>(title)"
    if name == "openwindow": return name + ">>" + ",".join(data.split(",")[:3]) + ",(title)"
    return line[:200]
STRUCT = ("monitor", "createworkspace", "destroyworkspace", "moveworkspace", "focusedmon", "openwindow", "closewindow",
          "movewindow", "openlayer", "closelayer", "activespecial", "workspace")
ev = socket.socket(socket.AF_UNIX); ev.connect(base + "/.socket2.sock"); ev.setblocking(False)
out = open(log, "a", buffering=1); buf = b""; last = ""; grace = 0.0; end = time.time() + cap
prev = state(); out.write("%s start cursor=%.0f,%.0f mon=%s win=%s\n" % (ts(), prev[0], prev[1], prev[2], prev[3]))
while time.time() < end:
    try:
        while True:
            d = ev.recv(65536)
            if not d: break
            buf += d
    except BlockingIOError: pass
    try: step = open(stepf).read().strip()
    except OSError: step = ""
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1); line = line.decode(errors="replace"); out.write("%s event %s\n" % (ts(), redact(line)))
        if line.split(">>")[0].startswith(STRUCT) and (step or time.time() < grace) and not os.path.getsize(abortf):
            why = "%s during step \"%s\": event %s" % (ts(), step or last, redact(line))
            open(abortf, "w").write(why + "\n"); out.write("%s ABORT %s\n" % (ts(), why))
    if step != last:
        out.write("%s step %s\n" % (ts(), step or "(done)"))
        if last and not step: grace = time.time() + 0.5
        last = step
    cur = state()
    out.write("%s sample cursor=%.0f,%.0f mon=%s win=%s\n" % (ts(), cur[0], cur[1], cur[2], cur[3]))
    moved = abs(cur[0] - prev[0]) > 2 or abs(cur[1] - prev[1]) > 2
    if (moved or cur[2:] != prev[2:]) and (step or time.time() < grace) and not os.path.getsize(abortf):
        why = "%s during step \"%s\": cursor %.0f,%.0f -> %.0f,%.0f, monitor %s -> %s, window %s -> %s" % (
            ts(), step or last or "(grace)", prev[0], prev[1], cur[0], cur[1], prev[2], cur[2], prev[3], cur[3])
        open(abortf, "w").write(why + "\n"); out.write("%s ABORT %s\n" % (ts(), why))
    prev = cur
    time.sleep(0.05)
'
watch_start() { # $1 = the command (up / down)
  mkdir -p "$RUN" "$LOG"
  : >"$RUN/step"; : >"$RUN/abort"; : >"$LOG/watch-$1.log"
  python3 -I -c "$WATCH_PY" "$LOG/watch-$1.log" "$RUN/step" "$RUN/abort" 900 </dev/null >>"$LOG/watch-$1.log" 2>&1 &
  record watch $!
  wait_for 30 test -s "$LOG/watch-$1.log" || say "the watcher didn't start (log/watch-$1.log)"
}
watch_stop() { sleep 0.6; stop_role watch 20; }   # 0.6 s: past the last step's grace window
step() { echo "$1" >"$RUN/step.tmp" && mv "$RUN/step.tmp" "$RUN/step"; sleep 0.1; check_abort; }
step_done() { sleep 0.6; : >"$RUN/step"; check_abort; } # the grace window: a change Hyprland makes just after a step
TEARDOWN="" # set while stopping: the teardown goes on after an abort
check_abort() { if [ -z "$TEARDOWN" ] && [ -s "$RUN/abort" ]; then say "ABORT (the session compositor changed during a step): $(cat "$RUN/abort")"; exit 3; fi; }

# ---- the session compositor's snapshot (read-only; what `up` and `down` must leave as they found it) --------------
snapshot() {
  local cur; cur=$(hyprctl cursorpos)
  jq -n --argjson m "$(hyprctl -j monitors all)" --argjson w "$(hyprctl -j workspaces)" --argjson c "$(hyprctl -j clients)" \
    --argjson a "$(hyprctl -j activeworkspace)" --argjson aw "$(hyprctl -j activewindow)" \
    --arg cx "${cur%%,*}" --arg cy "${cur##*, }" '
    ($cx | tonumber) as $x | ($cy | tonumber) as $y |
    { monitors: [$m[] | {name, width, height, refreshRate, x, y, scale, transform, disabled, focused,
                         active: .activeWorkspace.name, special: .specialWorkspace.name}] | sort_by(.name),
      workspaces: [$w[] | {id, name, monitor, windows}] | sort_by(.id),
      windows: [$c[] | {address, class, workspace: .workspace.name, monitor, at, size, floating, fullscreen, pinned, hidden}] | sort_by(.address),
      activeWorkspace: {id: $a.id, name: $a.name, monitor: $a.monitor},
      activeWindow: ($aw.address // null),
      cursorMonitor: ([$m[] | select($x >= .x and $x < .x + .width and $y >= .y and $y < .y + .height) | .name][0] // null) }'
}
snapdiff() { # $1 = before, $2 = after [, $3 = a jq filter applied to both]: prints the differences, empty when none
  diff <(jq -S "${3:-.}" "$1") <(jq -S "${3:-.}" "$2") || true
}
cdp_page() { curl -sf -m 1 "http://127.0.0.1:$CPORT/json" | jq -e 'any(.[]; .type == "page")' >/dev/null 2>&1; }
# ---- the private compositor -------------------------------------------------------------------------------------
GS=$S/gs # its /tmp, /run/user/<uid>, caches and log
compositor_up() {
  mkdir -p "$GS/tmp" "$GS/rt" "$GS/cache"; chmod 700 "$GS/rt"
  : >"$RUN/gamescope.raw"
  # -r twice the rate: the headless backend releases a client's frame callback every second refresh (measured: -r 144
  # gave 73 rAF/s, -r 288 gave 144). --unshare-net: Xwayland's abstract socket (@/tmp/.X11-unix/X<n>) lives in the network namespace, and libxcb tries
  # it before the file socket: in the session's namespace it would answer the user's X clients
  env -u WAYLAND_DISPLAY -u DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE -u SWAYSOCK -u DBUS_SESSION_BUS_ADDRESS -u PULSE_SERVER \
    -u PIPEWIRE_REMOTE -u LD_LIBRARY_PATH "$MARK" XDG_RUNTIME_DIR="/run/user/$(id -u)" XDG_CACHE_HOME="$GS/cache" \
    setsid bwrap --ro-bind / / --dev-bind /dev /dev --unshare-net --bind "$S" "$S" --bind "$GS/tmp" /tmp \
      --bind "$GS/rt" "/run/user/$(id -u)" -- bash -c 'echo $$ >"$0"; exec "$@"' "$RUN/gamescope.raw" \
      gamescope --backend headless -W "${SIZE%x*}" -H "${SIZE#*x}" -w "${SIZE%x*}" -h "${SIZE#*x}" -r "$((HZ * 2))" --expose-wayland \
      </dev/null >"$LOG/gamescope.log" 2>&1 &
  wait_for 50 test -s "$RUN/gamescope.raw" || die "gamescope didn't start"
  record gamescope "$(cat "$RUN/gamescope.raw")"
  wait_for 150 grep -q "Running compositor on wayland display" "$LOG/gamescope.log" \
    || { tail -5 "$LOG/gamescope.log" >&2; die "gamescope never opened its Wayland socket"; }
  GSOCK=$GS/rt/$(sed -n "s/.*Running compositor on wayland display '\([^']*\)'.*/\1/p" "$LOG/gamescope.log" | head -1)
  [ -S "$GSOCK" ] || die "no Wayland socket at $GSOCK"
}
compositor_down() {
  stop_role gamescope 50 # its Xwayland carries the marker and goes with the sweep
  local left; left=$(find "$GS/rt" "$GS/tmp" -type s 2>/dev/null | tr '\n' ' ')
  [ -z "$left" ] || say "sockets left in the private compositor's dirs: $left"
}

# ---- private state ---------------------------------------------------------------------------------------------
snapshot_backend() { # → $S/backend: a copy of the Debug build that the user's `dotnet watch` can't rebuild under it
  local src=$ROOT/src/backend/bin/Debug/net10.0 dll m0 i
  dll=$src/liascape-backend.dll
  [ -f "$dll" ] || die "no backend build in $src (dotnet build src/backend)"
  mkdir -p "$S/backend"
  for ((i = 0; i < 60; i++)); do
    if [ -f "$src/liascape-backend.runtimeconfig.json" ]; then
      m0=$(stat -c %Y.%s "$dll")
      cp -a --reflink=auto --remove-destination "$src/." "$S/backend/" 2>/dev/null || true
      [ -f "$S/backend/liascape-backend.runtimeconfig.json" ] && [ "$(stat -c %Y.%s "$dll")" = "$m0" ] \
        && cmp -s "$dll" "$S/backend/liascape-backend.dll" && return 0
    fi
    sleep 1
  done
  die "no complete backend build to copy (a rebuild kept running)"
}
prepare_state() {
  mkdir -p "$S" "$RUN" "$LOG" "$S/tmp" "$S/rt" "$S/owner-library" "$S/vite-cache" "$H/.config" "$H/.local/share" "$H/.local/state" "$H/.cache"
  chmod 700 "$S" "$S/rt"
  # the private copies are overwritten in place (nothing deleted): the user's current files replace the last run's; files
  # only the agent backend wrote stay, and an item the user has since removed keeps a dead link
  : >"$LOG/up.log"
  # settings: the user's, minus every way out to their Steam account (the Steam app's client library, steamcmd); the
  # engine pinned to liascape-player (the legacy engine draws on the session's outputs)
  local c=$H/.config/liascape d=$H/.local/share/liascape f
  mkdir -p "$c" "$d/library"
  if [ -f "$OCFG/settings.json" ]; then
    jq '.SteamClientLibPath = "" | .SteamCmdPath = "" | .PlayerEngine = "liascape-player"' "$OCFG/settings.json" >"$c/settings.json.tmp"
    mv "$c/settings.json.tmp" "$c/settings.json"
  fi
  for f in playlist_state.json user_mute.state; do if [ -f "$OCFG/$f" ]; then cp -p "$OCFG/$f" "$c/$f"; fi; done
  if [ -e "$c/serve.port" ]; then : >"$c/serve.port"; fi # `up` waits for the new backend to write it
  # data: the library's index files copied, each item linked (an item that is a symlink keeps its target; a real folder
  # links to the read-only view of the user's library the sandbox mounts at $S/owner-library); no trash
  for f in "$ODATA"/* "$ODATA"/.[!.]*; do
    [ -e "$f" ] || continue
    case "$(basename "$f")" in library) ;; *) cp -a --reflink=auto --remove-destination "$f" "$d/" ;; esac
  done
  local src it
  for src in "$ODATA"/library/*/; do
    src=${src%/}; mkdir -p "$d/library/$(basename "$src")"
    for it in "$src"/* "$src"/.[!.]*; do
      [ -e "$it" ] || [ -L "$it" ] || continue
      local to="$d/library/$(basename "$src")/$(basename "$it")"
      if [ -L "$it" ]; then ln -sfn "$(readlink "$it")" "$to"
      elif [ -d "$it" ]; then ln -sfn "$S/owner-library/$(basename "$src")/$(basename "$it")" "$to"
      else case "$it" in *.lock) ;; *) cp -p --remove-destination "$it" "$to" ;; esac; fi
    done
  done
  # caches the backend fills slowly (preview clips, Workshop previews, scene loudness) and the Steam cooldown: kept
  # across runs, topped up from the user's (reflinks on btrfs: no extra space)
  mkdir -p "$H/.cache/liascape"
  for f in video_clips workshop_previews we_thumbs scene-loudness media-art; do
    if [ -d "$OCACHE/$f" ]; then cp -a -n --reflink=auto "$OCACHE/$f" "$H/.cache/liascape/" 2>/dev/null || say "couldn't copy all of $f"; fi
  done
  if [ -f "$OCACHE/steam-cooldown.json" ]; then cp -p "$OCACHE/steam-cooldown.json" "$H/.cache/liascape/"; fi
  # the window renders with the user's fonts
  local fc=${XDG_CONFIG_HOME:-$HOME/.config}/fontconfig fd=${XDG_DATA_HOME:-$HOME/.local/share}/fonts
  if [ -d "$fc" ]; then ln -sfn "$fc" "$H/.config/fontconfig"; fi
  if [ -d "$fd" ]; then ln -sfn "$fd" "$H/.local/share/fonts"; fi
}

# ---- the sandbox (backend + player) ----------------------------------------------------------------------------
BW=()
sandbox_args() {
  mkdir -p "$OCFG" "$ODATA/library" "$OCACHE" # mount points (the user's own dirs; never written here)
  BW=(--ro-bind / / --dev-bind /dev /dev --bind "$S" "$S"
      --ro-bind "$ODATA/library" "$S/owner-library" # before the private copy hides it
      --bind "$S/tmp" /tmp --bind "$S/rt" "/run/user/$(id -u)"
      --bind "$H/.config/liascape" "$OCFG" --bind "$H/.local/share/liascape" "$ODATA" --bind "$H/.cache/liascape" "$OCACHE")
}
# $1 = role (pid file, log), rest = the command; runs detached from this shell (setsid), pid = the sandboxed process
in_sandbox() {
  local role=$1; shift
  : >"$RUN/$role.raw"
  env -u WAYLAND_DISPLAY -u DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE -u SWAYSOCK -u PULSE_SERVER -u PULSE_SINK \
    -u PIPEWIRE_REMOTE -u PIPEWIRE_RUNTIME_DIR -u LIASCAPE_PLAYER_SOCKET -u LIASCAPE_UI_DIR -u LIASCAPE_BACKEND \
    "$MARK" XDG_RUNTIME_DIR="/run/user/$(id -u)" XDG_STATE_HOME="$H/.local/state" XDG_CACHE_HOME="$H/.cache" \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent LD_LIBRARY_PATH=/run/opengl-driver/lib \
    setsid bwrap "${BW[@]}" -- bash -c 'echo $$ >"$0"; exec "$@"' "$RUN/$role.raw" "$@" </dev/null >"$LOG/$role.log" 2>&1 &
  wait_for 50 test -s "$RUN/$role.raw" || die "$role didn't start (log: $LOG/$role.log)"
  record "$role" "$(cat "$RUN/$role.raw")"
}
dotnet_root() {
  local cache=$HOME/.cache/liascape/dev-dotnet-root dr="${DOTNET_ROOT:-}"
  [ -n "$dr" ] && [ -x "$dr/dotnet" ] && { echo "$dr"; return; }
  dr=$(cat "$cache" 2>/dev/null || true)
  [ -n "$dr" ] && [ -x "$dr/dotnet" ] && { echo "$dr"; return; }
  dr=$(env -u LD_LIBRARY_PATH nix develop "$ROOT" -c bash -c 'echo "${DOTNET_ROOT:-}"' 2>/dev/null | tail -1)
  [ -x "$dr/dotnet" ] || die "no .NET found (set DOTNET_ROOT)"
  echo "$dr"
}

# ---- the Vite dev server ---------------------------------------------------------------------------------------
VITE_JS='import { createServer } from "vite";
const [port, cacheDir] = process.argv.slice(1);
const server = await createServer({ configFile: "vite.config.ts", root: process.cwd(), cacheDir, clearScreen: false,
  server: { port: Number(port), strictPort: true, host: "localhost" } });
await server.listen(); server.printUrls();
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => server.close().then(() => process.exit(0)));'

# ---- commands --------------------------------------------------------------------------------------------------
up() {
  for p in "$CPORT" "$VPORT" "$BPORT" "$((BPORT + 1))"; do
    case "$p" in 9222|5173|5174|5175) die "port $p is the user's own app's" ;; esac
    port_busy "$p" && die "port $p is taken (already up? $0 status)"
  done
  [ -z "$(ours)$(role_pid electron)" ] || die "processes of an earlier run are still alive (run: $0 down)"
  for t in gamescope hyprctl bwrap jq node curl python3 "$ELECTRON"; do command -v "$t" >/dev/null || die "missing: $t"; done
  [ -x "$PLAYER" ] || die "no release player at $PLAYER (scripts/dev.sh builds it)"
  [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] && [ -n "${WAYLAND_DISPLAY:-}" ] || die "not in the Hyprland session"
  mkdir -p "$RUN"
  snapshot >"$RUN/before.json"
  watch_start up
  trap 'say "up failed — tearing down"; down_quiet; watch_stop' EXIT
  say "state in $S"
  prepare_state
  snapshot_backend
  sandbox_args
  local dr; dr=$(dotnet_root)

  # player: headless, small outputs (nothing shows them; the UI only needs a player to talk to), no audio device
  in_sandbox player "$PLAYER" serve --headless --outputs 640x360@30 --redraw-policy content --clock real --ao null
  wait_for 100 env XDG_RUNTIME_DIR="$S/rt" "$PLAYER" ctl --timeout-ms 500 hello >/dev/null 2>&1 \
    || { tail -5 "$LOG/player.log" >&2; false; }
  # backend: the dev topology (no UI of its own), the agent Vite as its allowed origin, Steam secrets in a private file
  in_sandbox backend env DOTNET_ROOT="$dr" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 LIASCAPE_PORT="$BPORT" \
    LIASCAPE_SECRETS=file LIASCAPE_DEV_ORIGINS="http://localhost:$VPORT,http://127.0.0.1:$VPORT" \
    LIASCAPE_PLAYER_BIN="$PLAYER" LIASCAPE_SCENE_WORKER_BIN="${PLAYER%/*}/liascape-scene-worker" \
    LIASCAPE_TRANSITIONS_DIR="$ROOT/transitions" "$S/backend/liascape-backend" serve
  wait_for 300 test -s "$H/.config/liascape/serve.port" || { tail -5 "$LOG/backend.log" >&2; false; }
  wait_for 100 curl -sf -m 1 "http://127.0.0.1:$BPORT/health" -o /dev/null

  (cd "$ROOT/app/ui" && exec env -u LD_LIBRARY_PATH "$MARK" XDG_CONFIG_HOME="$H/.config" \
     setsid node --input-type=module -e "$VITE_JS" "$VPORT" "$S/vite-cache" </dev/null >"$LOG/vite.log" 2>&1) &
  record vite $!
  wait_for 300 curl -sf -m 1 "http://localhost:$VPORT/" -o /dev/null || { tail -5 "$LOG/vite.log" >&2; false; }

  step "compositor start"
  compositor_up
  step_done
  # Electron on the private compositor's Wayland socket (an absolute WAYLAND_DISPLAY): never the session's display
  step "window open"
  env -u LD_LIBRARY_PATH -u LIASCAPE_PORT -u LIASCAPE_BACKEND -u LIASCAPE_UI_DIR -u DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE \
    -u PULSE_SERVER "$MARK" HOME="$H" WAYLAND_DISPLAY="$GSOCK" XDG_RUNTIME_DIR="$GS/rt" XDG_SESSION_TYPE=wayland \
    XDG_CONFIG_HOME="$H/.config" XDG_CACHE_HOME="$H/.cache" XDG_DATA_HOME="$H/.local/share" XDG_STATE_HOME="$H/.local/state" \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent LIASCAPE_DEBUG=1 LIASCAPE_CDP_PORT="$CPORT" \
    LIASCAPE_VITE="http://localhost:$VPORT" LIASCAPE_MUTE=1 LIASCAPE_WINDOW="$SIZE" \
    setsid "$ELECTRON" "$ROOT/app/shell" </dev/null >"$LOG/electron.log" 2>&1 &
  record electron $!
  wait_for 600 cdp_page || { say "no page on CDP :$CPORT"; tail -5 "$LOG/electron.log" >&2; false; }
  step_done
  echo "$CPORT" >"$RUN/cdp.port.tmp" && mv "$RUN/cdp.port.tmp" "$RUN/cdp.port"
  trap - EXIT
  watch_stop
  snapshot >"$RUN/up.json"
  local d; d=$(snapdiff "$RUN/before.json" "$RUN/up.json")
  if [ -z "$d" ]; then say "the session's monitors, workspaces, windows, focus and cursor monitor: unchanged"
  else say "WARNING: the user's side of the compositor changed during up:"; echo "$d" >&2; fi
  status
}

down_quiet() {
  TEARDOWN=1
  # the window first, then its compositor, then the servers, then any straggler
  local p kids
  p=$(role_pid electron)
  if [ -n "$p" ]; then step "window close"; kids=$(descendants "$p"); stop_role electron 100
    echo "$kids" | while read -r k st; do [ -n "$k" ] && stop_pid "$k" "$st" 30; done; step_done; fi
  [ -s "$RUN/cdp.port" ] && : >"$RUN/cdp.port" # the CDP helpers' "is it up" (an empty file = down)
  step "compositor stop"; compositor_down; step_done
  stop_role backend 100
  if [ -n "$(role_pid player)" ]; then env XDG_RUNTIME_DIR="$S/rt" "$PLAYER" ctl --timeout-ms 1000 quit >/dev/null 2>&1 || true; fi
  stop_role player 50
  stop_role vite 50
  # whatever they started (scene workers, ffmpeg, a daemon the backend detached, Chromium's helpers)
  for p in $(ours); do kill -TERM "$p" 2>/dev/null || true; done
  local i; for ((i = 0; i < 50; i++)); do [ -z "$(ours)" ] && break; sleep 0.1; done
  for p in $(ours); do say "pid $p ($(cat "/proc/$p/comm" 2>/dev/null)) outlived SIGTERM: SIGKILL"; kill -KILL "$p" 2>/dev/null || true; done
  true
}

down() {
  mkdir -p "$RUN"; : >"$RUN/abort"
  watch_start down
  trap 'watch_stop' EXIT
  down_quiet
  local left; left=$(ours)
  [ -z "$left" ] || say "still alive: $left"
  for p in "$CPORT" "$VPORT" "$BPORT" "$((BPORT + 1))"; do port_busy "$p" && say "port $p still in use"; done
  if [ -f "$RUN/before.json" ]; then
    snapshot >"$RUN/after.json"
    local d; d=$(snapdiff "$RUN/before.json" "$RUN/after.json")
    if [ -z "$d" ]; then say "the session's monitors, workspaces, windows, focus and cursor monitor: as before \`up\`"
    else say "the session differs from before \`up\` (the user may have changed it meanwhile; log/watch-*.log says when):"; echo "$d" >&2; fi
  fi
  say "down"
}

status() {
  local r p any=""
  for r in electron gamescope vite backend player; do
    p=$(role_pid "$r")
    if [ -n "$p" ]; then echo "$r: pid $p"; any=1; else echo "$r: not running"; fi
  done
  [ -n "$(role_pid gamescope)" ] && echo "compositor: gamescope headless ${SIZE}@${HZ} (log: $LOG/gamescope.log)"
  if [ -s "$RUN/cdp.port" ]; then
    echo "CDP: http://127.0.0.1:$(cat "$RUN/cdp.port")/json  (node app/shell/cdp.js \"<expr>\")"
    echo "Vite: http://localhost:$VPORT   backend: 127.0.0.1:$BPORT (media $((BPORT + 1)))   logs: $LOG"
  fi
  [ -n "$any" ]
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  snapshot) snapshot ;;
  *) echo "usage: $0 up|down|status|snapshot" >&2; exit 2 ;;
esac
