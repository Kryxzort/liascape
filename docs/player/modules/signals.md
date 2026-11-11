<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Signals (Phase 3; `src/signal/`)

A Signal is an observed fact about the world outside the player that rules read (spec §4.2). The rules system
itself is not built (`docs/superpowers/specs/2026-10-29-rules-recon.md`); the Signals are exposed generally so it
can read them later, and one built-in rule uses the first.

**Covered** (Task 6; designer call 9 as revised 2026-10-30 — "covered" means **visible**, never focused: wlr-ft's
`activated` is keyboard focus, so a fullscreen game on DP-1 must keep covering when the user clicks DP-2).
- **Source**, picked at serve start (`signal::choose`): Hyprland IPC if `HYPRLAND_INSTANCE_SIGNATURE`, else Sway
  IPC if `SWAYSOCK`, else `zwlr_foreign_toplevel_manager_v1` v1–3 if advertised (bound in `wl.rs` only then),
  else **unavailable** (GNOME has no layer-shell; KDE grants no protocol) — every `out:<c>.covered` reads
  `unavailable`, `hello.health.cover.ok` false with the reason, and the rule never pauses. Headless: the
  `headless.cover` verb. `LIASCAPE_PLAYER_COVER_SOURCE=hyprland|sway|wlr|headless|none` forces one (`hyprland`
  headless = the end-to-end test against a fake socket).
- **Hyprland** (`signal/hypr.rs`, thread `lia-cover`, read-only): `.socket2.sock` events `fullscreen`,
  `workspace`, `focusedmon`, `activespecial`, `moveworkspace`, `openwindow`, `closewindow`, `movewindow`,
  `changefloatingmode`, `minimized`, `monitoradded`, `monitorremoved` (+ `v2`s), `configreloaded`, and
  `activewindowv2` only when the address changes (`hypr::Relevance`: `activewindow`/`v2` also fire on every title
  change of the focused window, ~1/s from a terminal spinner, and focus never changes visibility) → 30 ms later one `[[BATCH]]j/monitors;j/clients` on `.socket.sock` (replies separated by blank lines), and a
  confirm query 300 ms after. The `fullscreen` event names no window: state is always read back. Rule
  (`covered::hypr_cover`): a monitor is covered by the highest `fullscreen` bits (1 maximized, 2 fullscreen, 3
  both) among mapped, non-`hidden` clients on its open special workspace (`specialWorkspace.id` ≠ 0, negative)
  or its `activeWorkspace`. The client `visible` field is not "on screen" and is never read. Socket dir:
  `$XDG_RUNTIME_DIR/hypr/<sig>`, else `/run/user/<uid>/hypr/<sig>` (a private `XDG_RUNTIME_DIR` still finds it),
  else `/tmp/hypr/<sig>`; re-resolved on reconnect (retry 2 s). Field names/values checked on 0.56.2:
  `docs/player/spikes/cover-sources.md`.
- **Sway** (`signal/sway.rs`): i3 IPC, `SUBSCRIBE ["window","workspace","output","shutdown"]` on one
  connection, `GET_TREE` on another; a container with `fullscreen_mode` 1 that is `visible` (it or a view in it)
  covers its output, 2 every output; no maximized state. Tested against a fake socket only.
- **wlr-ft** (`wl.rs`): `app_id`/`state`/`output_enter`/`output_leave` apply on `done` into `Toplevels`; a
  toplevel fullscreen/maximized and not minimized covers every output it entered, **any focus**. It can't see
  workspaces, so a fullscreen window on a hidden workspace covers there (known false positive of the fallback).
- **The Signal:** observed `out:<c>.covered` / `out:<c>.covered_by` (`{app_id, pid}`: Hyprland `class` + `pid`,
  Sway `app_id`/X11 class + `pid`, wlr-ft `app_id` only), `cover.changed {output, covered, was, app_id, pid,
  source}` (info) per change, `cover.source {source, ok, reason}` on a status change, the `cover` probe (source,
  status, per output `covered/app_id/pid/showing/counts/since_ms`, monitors without an output node under
  `unmatched`, the rule, the hold, its last 16 decisions with `t_ms` (base clock) + `unix_ms`), `state.cover`.
- **The rule (pause when covered):** `player.pause_when_covered` ≠ `off` and **every** output showing content
  (`srcs:<c>` non-empty) covered at the threshold (`fullscreen` = fullscreen only; `maximized` = either) →
  `CoverHold` engages after `COVER_ENGAGE_MS` = 300 ms in a row (base clock, so the stepped clock tests it
  exactly) and releases at the first tick it doesn't hold (uncovered, mode `off`, nothing shown). One covered
  monitor of two leaves the wallpaper playing (audio follows the picture). `Runtime::cover_tick` runs at the top of
  every tick/step, before `update_player_paused`, which composes `cover_held()` beside the low-VRAM hold — never
  `player.paused`, so a user pause survives the release; the R88 pause gates ramp the audio; the player clock
  (transitions, programs) is pause-excised. `cover.engaged {outputs, mode, pending_ms, covers}` /
  `cover.released {held_ms, reason}`; `player.cover_hold_active` mirrors it; `probe sources.effective_paused`
  counts the holds (`Runtime::held`).
- Tests: `signal::*` unit tests (each source's rule on records, the hold, source choice, fake Hyprland/Sway
  sockets); `tests/api.rs` `cover_*` (10, the fake source + a fake Hyprland end to end); `tests/program.rs`
  `cover_hold_freezes_a_program`.

**Auto-mute** (Task 14, `signal/automute.rs` + `signal/mpris.rs` + `audio/foreign.rs` + `audio/sysmon.rs`;
spec §4.4). **The shipped auto-mute under liascape-player** since it passed the plan's parity bar against the
backend's `AudioMonitor` on the owner's machine (2026-11-02, `docs/player/reports/phase3.md` § 7; the backend's side,
`AudioMonitor.AutoMuteInPlayer`: player-adapter.md § Auto-mute). **On by default**; `LIASCAPE_PLAYER_AUTOMUTE=0` is
the escape hatch (`signal::automute::enabled_for`: unset or anything but `0` = on): then nothing runs — no thread,
no capability, the props are inert, `hello.health.automute` false — and the backend's `AudioMonitor` mutes while
the app is open. With the setting off (`player.automute` false) the Signal costs nothing: no capture, no `lia-mpris`.
- **Props** (Player, live, kept by the snapshot): `automute` (false), `automute_delay_ms` (**500**),
  `autounmute_delay_ms` (2000), `automute_min_level_db` (−70, a 10 ms slice's peak dBFS),
  `automute_only_if_mpris` (false); observed `automute_active`. Capability `automute` = the env gate and
  the bus up (criterion 10: no bus → the backend keeps `AudioMonitor`).
- **The capture is `sysmon`'s** (rules recon §0.6: one per stream, shared with the visualiser): it runs
  while a scene wants audio input **or** `automute` is on. Its captures now run on PipeWire's **RT data
  thread** (`RT_PROCESS`) and meter peaks in ≤ 480-frame (10 ms) slices of each buffer as it arrives (the
  visualiser's per-sample ring is filled only while a scene reads it); per
  stream the start of its audible run (a gap > `RUN_GAP_NS` = 20 ms between audible slices starts a new
  one — today's `AudioMonitor` resets on one quiet 20 ms chunk) and its last audible slice, on the
  buffers' cycle times (`pw_buffer.time`, CLOCK_MONOTONIC). A run starting on a counted stream pings the
  loop from the RT thread (calloop ping = an eventfd write). No process per stream (criterion 8).
- **Registry globals are a subset:** a Node's global props have no pid, no `node.virtual`, often no
  `target.object`; a Client's have no `application.process.id`. `sysmon` binds every captured node (its
  `info` → full props; its `Props` param → `mute`, `volume`, `channelVolumes`) and every Client (`info` →
  full props). Found here: on the registry props alone the bus's own playback read as a pid-less foreign
  stream and muted the wallpaper by itself. **Registry order matters:** ids are reused, so a batch's
  removals are applied before its additions (and an object added and removed within the batch is dropped
  at its removal) — applied after, a removal wiped a new Client's record and its stream never counted
  (3 runs in 10 of `automute_mutes_on_a_foreign_stream`). `audio.visualiser.classified {id, verdict, counts,
  identified, pid}` / `.stream_gone {buffers, counts, audible_seen}` (debug) show each stream's verdicts.
- **Who counts** (`audio::foreign`, pure): **ownership, never names** — the stream's process
  (`application.process.id` of the node, else of its Client; **never `pipewire.sec.pid`**, the pulse
  server's pid for pulse clients) is the player or a descendant (its scene workers; their pids are also
  passed in), or it targets the bus (`target.object`/`node.target` = `liascape-player-bus` or its
  serial/id), or a Link goes from it into the bus sink → `own:pid|worker|target|link`; everything else is
  `foreign` and counts — voice chat, notifications, a user's `mpv` (no default exclusions, owner
  2026-10-29). **Classify, then count** (`sysmon::counts_now`, the bug `AudioMonitor` had until
  2026-10-28): a stream counts only once its node's and its client's full props arrived, so a scene worker's
  stream ramping in can't mute before its pid is known; its run keeps its first audible time, so a foreign
  stream's delay still counts from its first sample. A stream muted / at master volume 0 / every channel 0 in its `Props` doesn't count (an
  empty `channelVolumes` = unknown, not silent); the capture is post-volume anyway (measured: `pw-cat
  --volume 0` reads −100 dBFS).
- **MPRIS mode** (`automute_only_if_mpris`): thread `lia-mpris` (zbus, blocking; started the first time the
  mode is on) reads every `org.mpris.MediaPlayer2.*` but `playerctld` — `PlaybackStatus`, `Identity`,
  `DesktopEntry`, `xesam:title`, the name owner's pid — on `PropertiesChanged` / `NameOwnerChanged`
  (`lia-mpris-sig`) and every 2 s. A foreign stream counts only when it belongs to a Playing player
  (`foreign::match_player`): its pid in the player's pid tree (`/proc/<pid>/stat` ppid walk), else its
  portal/Flatpak app id = `DesktopEntry`, else binary/`application.name` = `DesktopEntry`/`Identity`
  (case-insensitive, `.foo-wrapped` → `foo`, a reverse-DNS id's last part). A Playing player with no
  stream → `mpris.unmatched:<identity>` in the probe. No session bus → `mpris.available: false` and the
  mode never mutes.
- **The rule** (`automute::decide`, pure): not muted + a counted run live → the mute ramp
  (`gain.automute` of every source, `GainLinear` to −96 over `ANTICLICK` 30 ms on `setting_anim`, so it
  lands while paused) is timed to **end at run start + `automute_delay_ms`** (it starts a ramp early; a
  calloop timer at that instant, re-checked then: the run must still be live, its last audible slice within
  `RUN_GAP_NS` + one buffer period); with a delay < the ramp it
  starts at once. Muted → the ramp back **starts at the last counted audible slice +
  `autounmute_delay_ms`**, never sooner than one run gap (20 ms) of silence **proven by data**: each
  counted stream delivered a buffer reaching that far past its last audible slice (the RT callback pings
  the loop at that buffer), else — a stream that stopped delivering — one buffer period later. A timer
  alone can't tell a steady tone between two 21 ms buffers from silence (measured: a fixed 20 ms + one
  quantum cost 73 ms at quantum 1024). Silence counts from the mute on (a restored mute too).
  `automute.muted {run_start_ms, ramp_start_ms, end_ms, target_end_ms, late_ms, delay_ms, streams}` /
  `automute.unmuted {last_audible_ms, ramp_start_ms, silent_ms, delay_ms, reason}`.
- **The user's unmute** (verb `automute.release`, `toggle-mute` while auto-muted, criterion 6): the ramp back
  now, `automute_active` false, and `released` (probe) until the rule's own unmute condition holds — the
  unmute delay's silence, or auto-mute off — so the stream the user overrode can't mute again a tick later
  (what `AudioMonitor` does: its state stays "muted" until the silence). `{released: false}`, a no-op, when not
  muted. `automute.released` / `automute.release_ended {silent_ms, delay_ms, reason}`. Not in the snapshot: a
  crash restart forgets it, and a stream still playing mutes again.
- **New sources:** while muted, `sync_sources` first sets `gain.automute = −96` on every source without a
  ramp on the slot (a `create`, a program's or a transition's B comes up muted — criterion 7); unmuted, a
  source left at −96 (a crash restart's snapshot) ramps back. A restart whose snapshot restored sources at
  −96 starts muted (`automute_active`), so foreign audio still playing keeps it muted.
- **Probe `automute`:** settings, `capability`, `active`, `since_ms`, `monitor {connected, edges,
  last_counted_audible_ms}`, `timer_at_ms`, `buffer_ms`, every captured stream (`verdict`, `counts`,
  `mpris {player, how}`, `mute`/`volume`/`channel_volumes`, `peak_db`, `audible`, `run_start_ms`,
  `last_audible_ms`, identity), `mpris {available, players, unmatched}`, the last 32 decisions — times on
  the `t_mono_ms` clock.
- **Tests:** unit `foreign::*` (`foreign_streams_are_classified_by_ownership`,
  `mpris_streams_match_by_pid_tree_then_app_id_then_name`), `sysmon::*` (slices/runs/wake, the client join,
  `pipewire_sec_pid_is_never_read_as_the_process`, `a_stream_counts_only_once_it_is_identified`), `automute::*` (the rule's timing); `tests/automute.rs`
  on a private PipeWire with a second null sink `foreign-sink` (`automute_mutes_on_a_foreign_stream`,
  `_ignores_own_switches_every_combo` — V/S × full-live/reveal/frozen, 12 switches, 0 mutes —,
  `_delays_and_threshold` — incl. turned down below the threshold, volume 0 and a Props mute via `pw-cli
  set-param` —,
  `_new_source_comes_up_muted`, `_survives_a_crash_restart`, `_hears_a_pulse_client` (`paplay` on a private
  pipewire-pulse: its own pid, not the server's), `_spawns_no_processes` — 20 streams, 0
  children —, `_mpris_hears_only_the_playing_players_own_streams` — a private `dbus-daemon` and a fake
  MPRIS player (zbus) owning the test's pid tree —, `_mpris_mode_without_a_session_bus_never_mutes`,
  `_absent_without_the_env_gate`, `_absent_with_the_bus_down`, `_release_holds_until_silence`; ignored `measure_automute_latency`, `measure_automute_cpu`).
- **Measured** (`scripts/measure-automute-latency.py --engine both`, the ignored `measure_automute_latency`:
  both engines in one hermetic harness — private PipeWire + pipewire-pulse, an in-test observer on both sink
  monitors (same graph cycles, 1 ms blocks); `AudioMonitor` is a faithful Rust port, so a lower bound for the
  real C# path). Delay 0, p50/p95 ms, mute (first audible foreign sample → wallpaper at −96) / unmute (last
  audible sample → audible again): quantum 64 onset Signal 32/32 vs 53/65, unmute 22/22 vs 27/38; a new
  stream 36/39 vs 79/96; quantum 1024 onset 48/48 vs 48/69, unmute 52/52 vs 52/73; new 64/85 vs 107/128.
  Delay accuracy (actual − configured) at 500 / 2000: Signal +2.7 ms mute, +2–3.3 unmute; `AudioMonitor`
  +32–47 / +7–25. **Open:** with all cores saturated (the private graph has no RT) a new stream at quantum
  1024 reads 64/341 vs 107/128: `lia-sysmon` sees the node ~200 ms late, cause unknown
  (`LIASCAPE_AUTOMUTE_TIMELINE=1` prints each trial's timeline; `MISS` lines print any trial without a
  timing). Where the Signal's time goes: the 30 ms ramp + the same graph cycle (wake < 1 ms) + mpv
  pulling ≈ 1 quantum ahead; a new stream adds its capture's link-up. CPU (`measure_automute_cpu`, 5
  streams, quantum 64, release, two runs): +45 / +23 ms/s in the player vs 5 `parec` 30 / 14 ms/s + pipewire-pulse
  +74 / +33 ms/s.
  Full table: the plan's Task 14 implementer note 2026-10-30.
