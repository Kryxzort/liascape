#!/usr/bin/env bash
# Hermetic test of "Start with your desktop" (src/backend/Helpers/Autostart.cs):
#  detect:  what each kind of session runs, from a made-up environment (`liascape-backend autostart-check`, read-only):
#           KDE / GNOME / Xfce / LXQt read autostart entries themselves, uwsm and an active xdg-desktop-autostart.target run
#           them, dex in Hyprland's config runs them; plain Hyprland / Sway (no uwsm, no systemd autostart, no dex) won't, and
#           say the line for their config (`exec-once = …` / `exec …`); a session it knows nothing about is unknown.
#  config:  a Hyprland / Sway config (or a file under it) that already runs `liascape restore` says so, wins over uwsm, and a
#           commented-out one doesn't count, a FIFO among the files never blocks the search.
#  command: the entry's Exec is the AppImage itself ($APPIMAGE, quoted for a space), else the launcher (LIASCAPE_LAUNCHER;
#           a Nix store path only without a profile link on PATH), else `liascape` on PATH, else none (and why).
#  entry:   through a private backend: POST /settings writes $XDG_CONFIG_HOME/autostart/liascape.desktop at once (Exec, the
#           marker) and removes it again; every other file in that folder is never touched (bytes, mtime, nothing added);
#           a liascape.desktop the user wrote is left alone either way; a compositor line added later takes the entry away
#           (GET /autostart) and its removal brings it back; `serve` puts a missing entry back at start; /health/features
#           reports the detection (ok, and a plain Hyprland's line as its reason).
# Runs in its own network namespace (`unshare -rn`), a temp HOME + XDG dirs, a stub `systemctl` (never the session's user
# manager) and a backend whose player is an `exit 1` stub. Never touches the real autostart folder or compositor config.
#
# Usage: scripts/test-autostart.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs and prints where (last line).
# Needs: dotnet (or DOTNET=…), unshare + ip (iproute2), curl, jq.
# Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
if [ -z "${LIASCAPE_AUTOSTART_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in unshare ip curl jq timeout mkfifo; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  DLL=${LIASCAPE_BACKEND_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
  if [ $BUILD = 1 ] && [ -z "${LIASCAPE_BACKEND_DLL:-}" ]; then
    "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
    [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
  fi
  [ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }
  T=$(mktemp -d /tmp/liascape-autostart-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-autostart- "$rc"; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_AUTOSTART_T=$T
  timeout -k 10 300 unshare -rn bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_AUTOSTART_T
DLL=$T/backend/liascape-backend.dll
DOTNET=$(readlink -f "$DOTNET")
BP=""
stopbe() { [ -n "$BP" ] && { kill "$BP" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null; }; BP=""; }
trap 'stopbe' EXIT
trap 'exit 130' INT TERM HUP
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got $2, want $3"; fi; }

H=$T/home; C=$H/.config
mkdir -p "$C/liascape" "$H/.cache" "$H/.local/share" "$H/rt/systemd" "$H/rt-bare" "$H/st"
# the runtime dir's user manager (only ever asked when its socket is there: never the session bus's), answered by a stub
# systemctl: what FAKE_SYSTEMD names (active | inactive), else nothing (a manager that doesn't answer)
: > "$H/rt/systemd/private"
SD=$T/sd; mkdir -p "$SD"
cat > "$SD/systemctl" <<'EOF'
#!/bin/sh
case "${FAKE_SYSTEMD:-}" in
  active) echo active; exit 0 ;;
  inactive) echo inactive; exit 3 ;;
  *) echo "Failed to connect to bus: No medium found" >&2; exit 1 ;;
esac
EOF
chmod +x "$SD/systemctl"
# a `liascape` on PATH (the command the entry and the line name when nothing else resolves)
LP=$T/lp; mkdir -p "$LP"; printf '#!/bin/sh\nexit 0\n' > "$LP/liascape"; chmod +x "$LP/liascape"
printf '#!/bin/sh\nexit 1\n' > "$T/player"; chmod +x "$T/player"

# run the backend in a made-up session: nothing from this shell's environment but what the case names
# be <env assignments…> -- <backend args…>
be() {
  local vars=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do vars+=("$1"); shift; done
  shift
  ${BE_TIMEOUT:+timeout $BE_TIMEOUT} env -i HOME="$H" XDG_CONFIG_HOME="$C" XDG_CACHE_HOME="$H/.cache" XDG_DATA_HOME="$H/.local/share" XDG_RUNTIME_DIR="$H/rt" \
    XDG_STATE_HOME="$H/st" PATH="$SD:$LP" LIASCAPE_SECRETS=file LIASCAPE_PLAYER_BIN="$T/player" \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DBUS_SESSION_BUS_ADDRESS="unix:path=$T/no-bus" "${vars[@]}" \
    "$DOTNET" "$DLL" "$@"
}
# detect <name> <env…> → the check's JSON in $J (a check that hangs — a FIFO read — is cut at 30 s and fails)
J=""
detect() { local n=$1; shift; J=$(BE_TIMEOUT=30 be "$@" -- autostart-check 2>"$T/check-$n.log"); [ -n "$J" ] || { bad "$n: no answer ($(head -c 300 "$T/check-$n.log"))"; J='{}'; }; }
jf() { printf '%s' "$J" | jq -r "$1" 2>/dev/null; }

# ---- detect: what each session runs ----------------------------------------------------------------------------------
detect kde XDG_CURRENT_DESKTOP=KDE XDG_SESSION_DESKTOP=KDE
check "detect KDE → runs (its desktop)" "$(jf '.state + " " + .via')" "runs desktop"
detect gnome XDG_CURRENT_DESKTOP=ubuntu:GNOME
check "detect GNOME (ubuntu:GNOME) → runs (its desktop)" "$(jf '.state + " " + .via')" "runs desktop"
detect xfce XDG_CURRENT_DESKTOP=XFCE
check "detect Xfce → runs (its desktop)" "$(jf '.state + " " + .via')" "runs desktop"
detect lxqt XDG_CURRENT_DESKTOP=LXQt
check "detect LXQt → runs (its desktop)" "$(jf '.state + " " + .via')" "runs desktop"
detect uwsm XDG_CURRENT_DESKTOP=Hyprland HYPRLAND_INSTANCE_SIGNATURE=x UWSM_FINALIZE_VARNAMES=HYPRLAND_INSTANCE_SIGNATURE
check "detect Hyprland under uwsm → runs (uwsm)" "$(jf '.state + " " + .via + " " + .compositor')" "runs uwsm Hyprland"
detect systemd XDG_CURRENT_DESKTOP=Hyprland HYPRLAND_INSTANCE_SIGNATURE=x FAKE_SYSTEMD=active
check "detect Hyprland with xdg-desktop-autostart.target active → runs (systemd)" "$(jf '.state + " " + .via')" "runs systemd"
detect no-manager XDG_CURRENT_DESKTOP=Hyprland HYPRLAND_INSTANCE_SIGNATURE=x FAKE_SYSTEMD=active XDG_RUNTIME_DIR="$H/rt-bare"
check "detect: a runtime dir without a user manager is never asked (no session-bus fallback)" "$(jf .state)" "wontRun"
detect hypr-tty XDG_CURRENT_DESKTOP=Hyprland HYPRLAND_INSTANCE_SIGNATURE=x FAKE_SYSTEMD=inactive
check "detect plain Hyprland (no uwsm, target inactive, no dex) → wontRun" "$(jf .state)" "wontRun"
check "detect plain Hyprland → the line for hyprland.conf" "$(jf .line)" "exec-once = liascape restore"
detect sway-tty XDG_CURRENT_DESKTOP=sway SWAYSOCK=/run/user/0/sway-ipc.sock
check "detect plain Sway (no user manager) → wontRun" "$(jf '.state + " " + .compositor')" "wontRun Sway"
check "detect plain Sway → the line for its config" "$(jf .line)" "exec liascape restore"
detect unknown FAKE_SYSTEMD=inactive
check "detect a session it knows nothing about → unknown" "$(jf .state)" "unknown"
case "$(jf .reason)" in ""|null) bad "detect unknown: no reason" ;; *) ok "detect unknown says why" ;; esac
check "detect unknown → the bare command as its line" "$(jf .line)" "liascape restore"
detect unknown-sd FAKE_SYSTEMD=active
check "detect an unknown compositor under systemd autostart → runs (systemd)" "$(jf '.state + " " + .via')" "runs systemd"

# ---- config: what the compositor's config already holds ----------------------------------------------------------------
mkdir -p "$C/hypr/conf.d"
printf 'monitor = ,preferred,auto,1\nexec-once = dex -a -s %s/autostart\n' "$C" > "$C/hypr/hyprland.conf"
detect dex XDG_CURRENT_DESKTOP=Hyprland HYPRLAND_INSTANCE_SIGNATURE=x
check "config: dex -a in hyprland.conf → runs (dex)" "$(jf '.state + " " + .via')" "runs dex"
printf 'monitor = ,preferred,auto,1\n  # exec-once = liascape restore\nsource = ~/.config/hypr/conf.d/autostart.conf\n' > "$C/hypr/hyprland.conf"
: > "$C/hypr/conf.d/autostart.conf"
detect commented XDG_CURRENT_DESKTOP=Hyprland HYPRLAND_INSTANCE_SIGNATURE=x
check "config: a commented-out liascape restore doesn't count" "$(jf .state)" "wontRun"
printf 'exec-once = waybar\nexec-once = /usr/bin/liascape restore # wallpaper\n' > "$C/hypr/conf.d/autostart.conf"
mkfifo "$C/hypr/conf.d/a-pipe.conf" "$C/hypr/conf.d/zz-pipe.conf" # never read: a FIFO would block the search
detect hypr-has XDG_CURRENT_DESKTOP=Hyprland HYPRLAND_INSTANCE_SIGNATURE=x
check "config: a sourced Hyprland file runs liascape restore → compositor" "$(jf .state)" "compositor"
check "config: it names that file" "$(jf .configFile)" "~/.config/hypr/conf.d/autostart.conf"
detect hypr-has-uwsm XDG_CURRENT_DESKTOP=Hyprland HYPRLAND_INSTANCE_SIGNATURE=x UWSM_WAIT_VARNAMES=x
check "config: the compositor's own line wins over uwsm (no second restore)" "$(jf .state)" "compositor"
detect gnome-hypr-cfg XDG_CURRENT_DESKTOP=GNOME
check "config: a Hyprland config doesn't count in a GNOME session" "$(jf .state)" "runs"
mkdir -p "$C/sway/config.d"; printf 'output * bg #000 solid_color\n' > "$C/sway/config"
printf 'exec "liascape restore"\n' > "$C/sway/config.d/50-liascape"
detect sway-has XDG_CURRENT_DESKTOP=sway SWAYSOCK=/x
check "config: a Sway config.d file runs liascape restore → compositor" "$(jf '.state + " " + .configFile')" "compositor ~/.config/sway/config.d/50-liascape"
rm -rf "$C/hypr" "$C/sway"

# ---- command: what the entry runs ----------------------------------------------------------------------------------------
mkdir -p "$T/apps/My Apps"; printf '' > "$T/apps/My Apps/Liascape.AppImage"
detect appimage APPIMAGE="$T/apps/My Apps/Liascape.AppImage" LIASCAPE_LAUNCHER=/tmp/.mount_xyz/usr/bin/liascape XDG_CURRENT_DESKTOP=Hyprland HYPRLAND_INSTANCE_SIGNATURE=x
check "command: the AppImage itself, quoted for its space" "$(jf .exec)" "\"$T/apps/My Apps/Liascape.AppImage\" restore"
check "command: the AppImage's line names the image, shell-quoted" "$(jf .line)" "exec-once = '$T/apps/My Apps/Liascape.AppImage' restore"
detect launcher LIASCAPE_LAUNCHER=/opt/liascape/bin/liascape
check "command: the launcher that started the backend" "$(jf .exec)" "/opt/liascape/bin/liascape restore"
mkdir -p "$T/profile/bin"; ln -s "$LP/liascape" "$T/profile/bin/liascape"
detect nix-profile LIASCAPE_LAUNCHER=/nix/store/0000-liascape-1/bin/liascape PATH="$SD:$T/profile/bin"
check "command: a Nix store launcher → the profile link on PATH" "$(jf .exec)" "$T/profile/bin/liascape restore"
detect nix-store LIASCAPE_LAUNCHER=/nix/store/0000-liascape-1/bin/liascape PATH="$SD"
check "command: a Nix store launcher with no profile link → the store path" "$(jf .exec)" "/nix/store/0000-liascape-1/bin/liascape restore"
detect onpath
check "command: no launcher → liascape on PATH" "$(jf .exec)" "$LP/liascape restore"
detect none PATH="$SD"
check "command: nothing resolves → no Exec" "$(jf '.exec|tostring') $(jf 'has("state")')" "null true"
[ "$(jf .missing)" != "null" ] && [ -n "$(jf .missing)" ] && ok "command: nothing resolves → says why" || bad "command: no reason when nothing resolves"

# ---- entry: written, removed, nothing else touched ---------------------------------------------------------------------
AD=$C/autostart; E=$AD/liascape.desktop
mkdir -p "$AD/sub"
printf '[Desktop Entry]\nType=Application\nName=Other\nExec=other\n' > "$AD/other.desktop"
printf '[Desktop Entry]\nType=Application\nName=Tray\nExec=liascape-tray\n' > "$AD/liascape-tray.desktop"
printf 'x' > "$AD/.hidden"; printf 'y' > "$AD/sub/inner.desktop"; ln -s other.desktop "$AD/link.desktop"
touch -d '2001-01-01 00:00:00' "$AD/other.desktop" "$AD/liascape-tray.desktop" "$AD/.hidden" "$AD/sub/inner.desktop"
snap() { (cd "$AD" && find . -mindepth 1 -path ./liascape.desktop -prune -o -printf '%p %y %s %T@ %l\n' | sort; cd "$AD" && find . -type f ! -name liascape.desktop -exec sha256sum {} + | sort); }
BEFORE=$(snap)
LAUNCH=$T/inst/bin/liascape; mkdir -p "${LAUNCH%/*}"; printf '#!/bin/sh\n' > "$LAUNCH"; chmod +x "$LAUNCH"
SESSION=(XDG_CURRENT_DESKTOP=Hyprland HYPRLAND_INSTANCE_SIGNATURE=x UWSM_FINALIZE_VARNAMES=x LIASCAPE_LAUNCHER="$LAUNCH")
LOG=$T/backend.log
startbe() {
  rm -f "$C/liascape/serve.port"
  be "$@" -- serve >> "$LOG" 2>&1 & BP=$!
  for _ in $(seq 1 300); do [ -s "$C/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
  [ -s "$C/liascape/serve.port" ] || { bad "backend didn't start"; tail -15 "$LOG"; exit 1; }
  U=http://127.0.0.1:$(cat "$C/liascape/serve.port"); TOKEN=$(cat "$C/liascape/serve.token")
  for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
}
api() { curl -s -m 10 -H "X-Liascape-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }
setting() { api -o /dev/null -w '%{http_code}' -X POST "$U/settings" -d "{\"startWithDesktop\":$1}"; }
startbe "${SESSION[@]}"

J=$(api "$U/autostart")
check "entry: off at first, none there" "$(jf '.enabled|tostring') $(jf .entry) $([ -e "$E" ] && echo file || echo nofile)" "false none nofile"
check "entry: POST /settings on → 200" "$(setting true)" "200"
WROTE=0; if [ -f "$E" ]; then WROTE=1; ok "entry: written at once"; else bad "entry: no $E after turning it on"; fi
check "entry: its Exec runs the launcher's restore" "$(grep '^Exec=' "$E" 2>/dev/null)" "Exec=$LAUNCH restore"
grep -qx 'X-Liascape-Autostart=true' "$E" 2>/dev/null && ok "entry: carries the marker" || bad "entry: no marker line"
grep -qx 'Type=Application' "$E" 2>/dev/null && ok "entry: a desktop entry (Type=Application)" || bad "entry: no Type=Application"
J=$(api "$U/autostart")
check "entry: GET /autostart says ours, on, runs (uwsm)" "$(jf '.enabled|tostring') $(jf .entry) $(jf .state) $(jf .via)" "true ours runs uwsm"
check "entry: settings.json keeps it" "$(jq -r '.StartWithDesktop' "$C/liascape/settings.json")" "true"
check "entry: the other files in the folder are untouched (written)" "$(snap)" "$BEFORE"
check "entry: nothing else added to the folder" "$(ls -A "$AD" | LC_ALL=C sort | tr "\n" " ")" ".hidden liascape-tray.desktop liascape.desktop link.desktop other.desktop sub "
F=$(api "$U/health/features" | jq -c '.features[] | select(.id == "autostart")')
check "health: autostart ok, in use, affects startWithDesktop" "$(printf '%s' "$F" | jq -r '"\(.ok) \(.inUse) \(.affects|join(","))"')" "true true startWithDesktop"
check "entry: POST /settings off → 200" "$(setting false)" "200"
if [ -e "$E" ]; then bad "entry: still there after turning it off"; elif [ $WROTE = 0 ]; then bad "entry: removed — proved nothing (it was never written)"; else ok "entry: removed at once"; fi
check "entry: the other files in the folder are untouched (removed)" "$(snap)" "$BEFORE"

# a liascape.desktop the user wrote: never ours to write over or remove
printf '[Desktop Entry]\nType=Application\nName=Mine\nExec=liascape restore --mine\n' > "$E"; MINE=$(sha256sum < "$E")
setting true >/dev/null
check "foreign: turning it on leaves the user's liascape.desktop as it was" "$(sha256sum < "$E")" "$MINE"
J=$(api "$U/autostart"); check "foreign: GET /autostart says foreign" "$(jf .entry)" "foreign"
setting false >/dev/null
check "foreign: turning it off leaves it too" "$( [ -f "$E" ] && sha256sum < "$E")" "$MINE"
rm -f "$E"

# the compositor's config gains `liascape restore` while the entry is on: the entry goes (restore would run twice), and
# comes back when the line goes
setting true >/dev/null
HAD=0; [ -f "$E" ] && HAD=1 || bad "compositor: no entry to start from"
mkdir -p "$C/hypr"; printf 'exec-once = liascape restore\n' > "$C/hypr/hyprland.conf"; HB=$(sha256sum < "$C/hypr/hyprland.conf")
J=$(api "$U/autostart")
check "compositor: GET /autostart says it's in hyprland.conf" "$(jf .state) $(jf .configFile)" "compositor ~/.config/hypr/hyprland.conf"
if [ -e "$E" ]; then bad "compositor: the entry stayed beside the compositor's own line"; elif [ $HAD = 0 ]; then bad "compositor: taken away — proved nothing"; else ok "compositor: the entry is taken away"; fi
check "compositor: the config is only read" "$(sha256sum < "$C/hypr/hyprland.conf")" "$HB"
printf 'exec-once = waybar\n' > "$C/hypr/hyprland.conf"
J=$(api "$U/autostart")
check "compositor: the line gone → the entry is back" "$(jf .entry) $([ -f "$E" ] && echo file)" "ours file"
rm -rf "$C/hypr"
check "entry: the other files in the folder are untouched (throughout)" "$(snap)" "$BEFORE"

# serve puts a missing entry back at start (the setting on, the file gone while it was closed)
stopbe; rm -f "$E"
startbe "${SESSION[@]}"
for _ in $(seq 1 50); do [ -f "$E" ] && break; sleep 0.1; done
if [ -f "$E" ]; then ok "start: serve writes the entry back"; else bad "start: serve didn't put the entry back"; fi
stopbe

# a plain Hyprland: the health report warns with the line, the entry is still written (it may run after a session change)
startbe XDG_CURRENT_DESKTOP=Hyprland HYPRLAND_INSTANCE_SIGNATURE=x FAKE_SYSTEMD=inactive LIASCAPE_LAUNCHER="$LAUNCH"
F=$(api "$U/health/features" | jq -c '.features[] | select(.id == "autostart")')
check "health: plain Hyprland → not ok, in use" "$(printf '%s' "$F" | jq -r '"\(.ok) \(.inUse)"')" "false true"
case "$(printf '%s' "$F" | jq -r .reason)" in *"exec-once = $LAUNCH restore"*) ok "health: its reason gives the exec-once line (the launcher, not the other liascape on PATH)" ;; *) bad "health: reason lacks the line: $F" ;; esac
setting false >/dev/null
[ -e "$E" ] && bad "entry: still there after the last off" || ok "entry: off at the end"
check "entry: the other files in the folder are untouched (end)" "$(snap)" "$BEFORE"
stopbe

echo "RESULT pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
