---
paths:
  - "src/backend/Helpers/PlayerHelper.cs"
  - "src/backend/Helpers/AudioMonitor.cs"
  - "src/backend/Helpers/TransitionService.cs"
  - "src/backend/Helpers/MonitorDetector.cs"
  - "src/native/**"
  - "transitions/**"
---

# Legacy engine (`PlayerEngine=legacy`: mpvpaper + `liascape-transition` + LWE + `liascape-audio`)

Everything here applies only when `PlayerEngine.IsLiascapePlayer` is false; the liascape-player branch at the top of
each `PlayerHelper` primitive is `.claude/rules/backend/player-adapter.md`. Rotation semantics (minimum / maximum /
scene timing) live there too. Why behind the choices here: `docs/decisions.md` § Legacy engine.

## Processes and IPC
- `PlayerHelper` is the single entry point for mpvpaper; it kills existing mpvpaper processes before starting one.
- Drain stdout/stderr (`BeginOutputReadLine`/`BeginErrorReadLine`) for mpvpaper, `timer-daemon` and `restart-daemon` — an undrained pipe deadlocks. Do NOT redirect LWE's (`SpawnLweProcesses`).
- mpv may send several JSON replies in one read: split on `\n` (`TryQueryTimeRemaining`).
- Pre-shuffle playlists in `ApplyPlaylist`; never use mpv's `--shuffle`, `--playlist=file` or `--loop-playlist` — the timed machinery owns rotation.
- A video→video IPC switch carries the effective volume/speed/mute as `loadfile` per-file options, `mute=yes|no` explicitly both ways (file-local options restore the pre-file value at the next load).
- Read `_isMuted` fresh inside the task; never capture it into a local before `Task.Run`.
- A cold `Launch` re-announces `wallpaper-changed` with mpv's own `path` once its IPC first answers, only while `_shownGen` is unchanged (`AnnounceWhenIpcAnswers`): a page loaded during the launch can't stay on "nothing playing", and a superseded or stopped launch never announces. Guard: `scripts/test-legacy-launch.sh`.

## Timed playlist (legacy only)
- At most one process owns the timer: `timer.pid` (daemon) / `gui_timer.pid` (GUI). A stopping backend `ReleaseTimer()`s FIRST, deletes only its OWN pid, then hands off to `timer-daemon`.
- Every timed session has a tick, whatever its interval and length: start it only through `EnsureTimedTick` (`takeBack: false` for live edits).
- User switches go through `pending_action.txt` (atomic write + rename), consumed only by the tick owner. `restart` relaunches without advancing or resetting the countdown.
- Start an end-of-video wait only through `ArmVideoEndWait`; call `PostSwitch` after every timed switch; use `PlayingHistoryIndex` (the pre-fetch makes `_historyIndex` one ahead).
- `DoVideoEndWait` first waits until mpv's `path` equals `_lastSwitchTarget` (≤ 8 s) — without it a bailed transition re-fires every ~85 ms.
- `DoVideoEndWait` gives up on an empty time-remaining only after 30 polls (3 s), never sooner: `docs/decisions.md` § Give `DoVideoEndWait` 3 s of empty readings before it gives up.
- `RandomAndLaunch` re-seats both cursors (`_timedIndex` = the pick, forward history dropped). Guard: matrix `seq:random+next` / `seq:random+prev`.
- `UpdateTimedSettings` keeps the elapsed time proportionally; it never restarts the current wallpaper.
- A superseded aligned switch re-arms for A's end (backoff), it never switches now.

## Restart daemon (mpvpaper frame-buffer leak)
- `RestartMpvpaperEverySeconds <= 0` → every restart path is a no-op. Under a timed playlist write `restart` to `pending_action.txt` instead of restarting directly; skip it while paused.
- `RestartCurrent` re-checks `IsPlaying` inside `_lock` before `DoColdRestart`.

## Mute and auto-mute (`AudioMonitor`)
- `SetMute` (auto) never unmutes while the user muted (`_userMuted` or `user_mute.state`); `toggle-mute` uses `SetUserMute`.
- Monitor each stream with `parec --monitor-stream=<id>`; never `@DEFAULT_MONITOR@` (it hears our own audio → mute/unmute oscillation). Keep `--latency-msec=10` (parec's default buffering delays the first data ~2 s).
- Classify a stream (ours / LWE / mpv / foreign) before counting its level; remember our ids until their `remove`.
- Reset `_aboveThresholdCount` at the top of `WatchStreamsAsync`, not in `Stop()`.
- `monitor-daemon` (app closed) is legacy only; under liascape-player the player's Signal mutes.
- `AudioMonitor.SpawnDetachedMonitor` is a no-op while `AudioMonitor.RunsHere` (a forwarded `play` inside `serve` never adds a second monitor). Guard: `scripts/test-legacy-launch.sh`.

## Transitions (`TransitionService` + `src/native/liascape-transition`)
- `SwitchToFile` is the one switch chokepoint; the transition hook lives there.
- Only a SCENE side is constrained (no live GL texture): scene A → LWE's `--screenshot` dump (grim only as fallback), scene B → revealed live underneath. A B that ends up revealed needs a reveal-capable effect (`PickRevealEffect`); never freeze a live B on frame 0.
- Ramp volume in dB: mpv `volume` and PulseAudio volumes are cubic. The renderer ramps `volume-gain`; the backend pre-distorts percent ramps by the cube root (`XfPct`). Equal-power (`cos`/`sin`) crossfades.
- Wait `AUDIO_SETTLE` (300 ms past the last speed step) before cutting mpvpaper-A; do not lengthen `BAND_HOLD` instead (the tracker limit-cycles).
- The backend's ready-wait must exceed the renderer's worst case (~6.5 s).
- Killing an in-flight overlay unpauses mpvpaper; `Stop()` calls `TransitionService.ClearInProgress()`.
- libmpv in the renderer: set `vo=libmpv` and free `mpv_render_context` with the GL context current.
- Launch the primary monitor's LWE with its audio device open (`--volume 0` under NoAudio), never `--silent` (no sink-input to unmute → a relaunch); secondary monitors are `--silent`. A non-transition scene launch holds its volume with `CorrectSceneVolume` (PulseAudio's stream-restore replays a fade value).
- `liascape-audio` must skip re-applying a stream already at the wanted volume/mute (else a change-event loop wedges PulseAudio) and evict its client→pid cache on `remove`.
- 0 monitors detected → no transition (`transition SKIPPED`). `MonitorDetector` order: hyprctl → swaymsg → wlr-randr → `liascape-transition --list-outputs` → xrandr.
- Launch-only under legacy (LWE can't reconfigure live): `SceneMonitors` fps/primary and scene user properties (`--set-property`). Every other setting must apply live (`ApplyPlaybackSettingsLive`).

## Transition catalogue (`transitions/`, shared with the UI and liascape-player)
- `glsl/<id>.glsl` bodies + `manifest.json`, generated by `scripts/generate_transitions.py`; credit new effects in `UPSTREAM.md`.
