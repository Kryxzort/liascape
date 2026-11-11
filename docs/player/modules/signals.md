# Signals: covered and auto-mute

Covers `src/player/src/signal/` (`mod.rs`, `covered.rs`, `hypr.rs`, `sway.rs`, `automute.rs`, `mpris.rs`),
`src/player/src/audio/sysmon.rs` and `audio/foreign.rs`. Rules: `.claude/rules/player/runtime-api.md` § Signals.
The desktop pointer (`signal/cursor.rs`) is in [scene-source.md](scene-source.md).

A Signal is an observed fact about the world outside the player that rules read. A general rules system isn't
built; the Signals are exposed as observed props and probes, and one built-in rule uses each.

## Covered

**Source**, picked once at serve start (`signal::choose`): Hyprland IPC if `HYPRLAND_INSTANCE_SIGNATURE`, else
Sway IPC if `SWAYSOCK`, else `zwlr_foreign_toplevel_manager_v1` if advertised, else unavailable (GNOME has no
layer-shell; KDE grants no protocol) — every `out:<c>.covered` then reads `unavailable` and the rule never pauses.
Headless uses the `headless.cover` verb. `LIASCAPE_PLAYER_COVER_SOURCE` forces one.

- **Hyprland** (thread `lia-cover`, read-only): window/workspace/monitor events on `.socket2.sock` trigger, 30 ms
  later, one batched `j/monitors;j/clients` query on `.socket.sock` and a confirm query 300 ms after. A monitor is
  covered by the highest `fullscreen` bits (1 maximized, 2 fullscreen) among mapped, non-hidden clients on its open
  special workspace or its active workspace. The client `visible` field doesn't mean on screen and is never read;
  `activewindow` also fires on every title change of the focused window, so only an address change counts. The
  socket dir is found under `$XDG_RUNTIME_DIR/hypr/<sig>`, else `/run/user/<uid>/hypr/<sig>` (so a private
  `XDG_RUNTIME_DIR` still finds it), else `/tmp/hypr/<sig>`. Field names: `docs/player/spikes/cover-sources.md`.
- **Sway:** i3 IPC subscribe on one connection, `GET_TREE` on another; a visible `fullscreen_mode` 1 container
  covers its output, 2 every output; Sway has no maximized state.
- **wlr foreign-toplevel:** a fullscreen/maximized, not minimized toplevel covers every output it entered, whatever
  the focus. It can't see workspaces, so a fullscreen window on a hidden workspace covers there — a known false
  positive of the fallback.

"Covered" is visibility, not focus: wlr-ft's `activated` is keyboard focus, and a fullscreen game on one monitor
must keep covering when the user clicks the other.

**The rule:** `player.pause_when_covered` ≠ `off` and every output showing content covered at the threshold
(`fullscreen`, or `maximized` = either) for `COVER_ENGAGE_MS` (300 ms, base clock) engages the hold; the first tick
it doesn't hold releases it. One covered monitor of two leaves the wallpaper playing (audio follows the picture).
The hold composes into the effective pause beside the low-VRAM hold, so the pause gates ramp the audio, the player
clock stops, and a user pause survives the release. Observability: `cover.changed`, `cover.engaged`,
`cover.released`, `player.cover_hold_active`, the `cover` probe (per output state, monitors with no output node
under `unmatched`, the last 16 decisions).

## Auto-mute

On by default; `LIASCAPE_PLAYER_AUTOMUTE=0` turns the whole Signal off (no thread, no capability; the backend's
`AudioMonitor` mutes instead). With `player.automute` false it costs nothing (no capture, no MPRIS thread). The
`automute` capability also needs the bus up. Settings (player props, live, in the snapshot): `automute_delay_ms`
(500), `autounmute_delay_ms` (2000), `automute_min_level_db` (−70, a 10 ms slice's peak), `automute_only_if_mpris`.

**Capture** (`sysmon`, one capture per application playback stream, shared with the scene visualiser input) runs
while a scene wants audio input or auto-mute is on. Its callbacks run on PipeWire's RT data thread and meter peaks
in ≤ 10 ms slices as buffers arrive; per stream it tracks the start of its audible run (a gap > `RUN_GAP_NS`,
20 ms, starts a new run) and its last audible slice, on the buffers' own cycle times. A run starting on a counted
stream pings the loop from the RT thread. No process per stream.

**Registry globals are a subset:** a Node's global props have no pid, no `node.virtual`, often no
`target.object`, and a Client's no `application.process.id`. `sysmon` binds every captured node (`info` → full
props, `Props` → mute and volumes) and every client. On registry props alone the bus's own playback read as a
pid-less foreign stream and muted the wallpaper by itself. Ids are reused, so a batch's removals are applied
before its additions.

**Who counts** (`audio::foreign`): ownership, never names. A stream is ours when its process
(`application.process.id` of the node, else of its client — never `pipewire.sec.pid`, which is the pulse server's
pid for pulse clients) is the player or a descendant (its scene workers), when it targets the bus, or when a link
goes from it into the bus sink. Everything else counts — voice chat, notifications, a user's own mpv. A stream
counts only once its node's and its client's full props arrived, so a scene worker's stream ramping in can't mute
before its pid is known; its run keeps its first audible time. A stream muted, at volume 0 or with every channel 0
doesn't count (an empty `channelVolumes` is unknown, not silent).

**MPRIS mode:** `lia-mpris` (zbus) reads every MPRIS player but `playerctld` on change signals and every 2 s; a
foreign stream counts only when it belongs to a Playing player — by pid tree, then portal/Flatpak app id =
`DesktopEntry`, then binary or `application.name` = `DesktopEntry`/`Identity` (case-insensitive, `.foo-wrapped` →
`foo`, a reverse-DNS id's last part). No session bus → the mode never mutes.

**Timing** (`automute::decide`): the 30 ms mute ramp (`gain.automute` on `setting_anim`, so it lands while paused)
is timed to end at run start + `automute_delay_ms`, re-checked at that instant. The ramp back starts at the last
counted audible slice + `autounmute_delay_ms`, but only after silence proven by data: each counted stream
delivered a buffer reaching past its last audible slice by a run gap (else one buffer period later). A timer alone
can't tell a steady tone between two 21 ms buffers from silence. While muted, new sources come up with
`gain.automute` −96; a restart whose snapshot restored sources at −96 starts muted. `automute.release` (the user's
unmute) ramps back now and stays released until the rule's own unmute condition holds, so the overridden stream
can't re-mute a tick later; it is not in the snapshot.

**Measured** (hermetic harness with a private PipeWire, both engines observed on the same graph cycles; delay 0,
p50/p95 ms, Signal vs a faithful port of `AudioMonitor`): quantum 64 onset mute 32/32 vs 53/65, unmute 22/22 vs
27/38, a new stream 36/39 vs 79/96; quantum 1024 onset 48/48 vs 48/69, unmute 52/52 vs 52/73. Delay accuracy at
500/2000 ms: +2–3 ms. The Signal's time is the 30 ms ramp plus about one quantum. CPU with 5 streams at quantum 64:
+23–45 ms/s in the player vs 5 `parec` + pipewire-pulse at 47–104 ms/s. Open: with every core saturated a new
stream at quantum 1024 is seen ~200 ms late (`LIASCAPE_AUTOMUTE_TIMELINE=1` prints each trial's timeline).
