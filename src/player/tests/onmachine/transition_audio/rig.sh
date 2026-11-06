#!/usr/bin/env bash
# Transition audio on a PRIVATE PipeWire + a private headless liascape-player (TODO "Scene A's sound warbles
# during a transition", 2026-11-06). Never the owner's player, audio output, settings or library.
#   OUTS=1920x1080@144,1920x1080@240 rig.sh up [BIN_DIR]   start PipeWire + WirePlumber (policy profile, one null
#                          sink `hermetic-sink`, quantum 64 like the owner's graph) + `serve --headless --debug`
#                          (BIN_DIR: liascape-player + liascape-scene-worker; default <crate>/target/release —
#                          copy them somewhere first if a rebuild could replace them mid-run)
#   rig.sh down            stop everything it started
#   rig.sh ctl ARGS…       liascape-player ctl against the private instance
#   rig.sh pw CMD…         a command in the private PipeWire's client env (pw-top, pw-record, pw-dump …)
# Then `record.py <tag> <trials.json>` records each transition (the sink AND scene A's own stream), and
# `afade.py`, `srccmp.py` (A's stream vs the scene's own sound file × the equal-power fade), `sine.py`
# (discontinuities of a synthetic tone A) analyse them. Test media: the Workshop folder or synthetic only.
set -u
unset LD_LIBRARY_PATH
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# tmpfs: on a btrfs /tmp WirePlumber's state fsync blocked it in D state for minutes under I/O load — and every
# stream link with it (a scene's stream existed but was never linked: no sound, no error)
R=${TA_RIG:-/dev/shm/liascape-ta-$USER}
BIN=${BIN:-$HERE/../../../target/release}
[[ -f $R/bin ]] && BIN=$(cat $R/bin)
PW_DIR=$R/pw
PW_ENV=(-u LD_LIBRARY_PATH -u PULSE_SERVER HOME="$PW_DIR" XDG_RUNTIME_DIR="$PW_DIR/run" PIPEWIRE_RUNTIME_DIR="$PW_DIR/run"
    XDG_CONFIG_HOME="$PW_DIR/cfg" XDG_STATE_HOME="$PW_DIR/state" DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent)
lp() {
    env -u LD_LIBRARY_PATH -u PULSE_SERVER -u WAYLAND_DISPLAY -u DISPLAY HOME=$R/home XDG_CONFIG_HOME=$R/home/.config \
        XDG_RUNTIME_DIR="$R/run" XDG_STATE_HOME="$R/state" XDG_CACHE_HOME="$R/cache" \
        PIPEWIRE_RUNTIME_DIR="$PW_DIR/run" DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent \
        LIASCAPE_SCENE_WORKER_BIN="$BIN/liascape-scene-worker" LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1 \
        LIASCAPE_WE_ASSETS_DIR=/@steam/SteamLibrary/steamapps/common/wallpaper_engine/assets \
        LIASCAPE_SCENE_STORAGE_DIR=$R/storage ${EXTRA_ENV:-} "$BIN/liascape-player" "$@"
}
case ${1:-} in
up)
    [[ -n ${2:-} ]] && BIN=$2
    mkdir -p $R && echo "$BIN" >$R/bin
    mkdir -p "$PW_DIR/run" "$PW_DIR/state" "$PW_DIR/cfg/wireplumber/wireplumber.conf.d" $R/home/.config $R/state $R/cache $R/storage
    mkdir -p -m 700 $R/run; chmod 700 "$PW_DIR/run"
    cat >"$PW_DIR/pw.conf" <<'EOF'
context.properties = { core.daemon = true core.name = pipewire-0
  default.clock.rate = 48000 support.dbus = true log.level = 1 }
context.spa-libs = { audio.convert.* = audioconvert/libspa-audioconvert support.* = support/libspa-support }
context.modules = [
  { name = libpipewire-module-rt args = { nice.level = -11 rt.prio = 88 } flags = [ ifexists nofail ] }
  { name = libpipewire-module-protocol-native } { name = libpipewire-module-profiler }
  { name = libpipewire-module-access } { name = libpipewire-module-metadata }
  { name = libpipewire-module-spa-device-factory } { name = libpipewire-module-spa-node-factory }
  { name = libpipewire-module-client-node } { name = libpipewire-module-client-device }
  { name = libpipewire-module-adapter } { name = libpipewire-module-link-factory } ]
context.objects = [
  { factory = spa-node-factory args = { factory.name = support.node.driver node.name = Dummy-Driver
      node.group = pipewire.dummy priority.driver = 20000 } }
  { factory = adapter args = { factory.name = support.null-audio-sink node.name = hermetic-sink
      node.description = "hermetic sink" media.class = Audio/Sink audio.position = [ FL FR ]
      monitor.channel-volumes = true node.group = pipewire.dummy priority.driver = 21000 } } ]
EOF
    cat >"$PW_DIR/cfg/wireplumber/wireplumber.conf.d/99-hermetic.conf" <<'EOF'
wireplumber.profiles = { policy = { support.reserve-device = disabled monitor.alsa.reserve-device = disabled support.portal-permissionstore = disabled script.client.access-portal = disabled support.logind = disabled monitor.bluez.seat-monitoring = disabled hooks.device.profile.state = disabled hooks.device.routes.state = disabled } }
EOF
    setsid env "${PW_ENV[@]}" pipewire -c "$PW_DIR/pw.conf" >$R/pipewire.log 2>&1 &
    echo $! >$R/pw.pid
    for _ in $(seq 100); do [[ -S $PW_DIR/run/pipewire-0 ]] && break; sleep 0.05; done
    setsid env "${PW_ENV[@]}" wireplumber -p policy >$R/wireplumber.log 2>&1 &
    echo $! >$R/wp.pid
    sleep 1
    setsid bash -c "$(declare -f lp); BIN=$BIN R=$R PW_DIR=$PW_DIR EXTRA_ENV='${EXTRA_ENV:-}'; lp serve --headless --outputs ${OUTS:-1920x1080@60} --debug --log-level debug" >>$R/serve.log 2>&1 &
    echo $! >$R/serve.pid
    for _ in $(seq 150); do [[ -S $R/run/liascape/liascape-player.sock ]] && break; sleep 0.1; done
    for _ in $(seq 50); do [[ $(lp ctl probe '{"name":"bus"}' | jq -r .state) == up ]] && break; sleep 0.1; done
    lp ctl probe '{"name":"bus"}' | jq -c '{state, target, default_sink}'
    ;;
down)
    lp ctl quit >/dev/null 2>&1
    for f in serve wp pw; do
        [[ -f $R/$f.pid ]] || continue
        p=$(cat $R/$f.pid)
        for _ in $(seq 50); do kill -0 $p 2>/dev/null || break; [[ $f != serve ]] && kill $p 2>/dev/null; sleep 0.1; done
        kill $p 2>/dev/null
        trash $R/$f.pid
    done
    ;;
ctl) shift; lp ctl --timeout-ms 10000 "$@" ;;
pw) shift; env "${PW_ENV[@]}" "$@" ;;
*) echo "up|down|ctl|pw"; exit 2 ;;
esac
