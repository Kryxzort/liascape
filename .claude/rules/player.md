---
paths:
  - "src/backend/Helpers/PlayerHelper.cs"
  - "src/backend/Helpers/AudioMonitor.cs"
  - "src/backend/Helpers/TransitionService.cs"
  - "src/native/liascape-transition/**"
---

## Player

`PlayerHelper` is the single entry point for mpvpaper. Under `PlayerEngine=liascape-player` its media primitives dispatch to `src/backend/Player/` instead (`player-adapter.md`); everything below describes the legacy engine, unchanged. Kills all existing mpvpaper processes before starting a new one.

**stdout/stderr redirection:**
- **mpvpaper** (`Launch`), **timer daemon** (`SpawnTimerDaemon`), **restart daemon** (`SpawnRestartDaemon`): `RedirectStandardOutput/Error = true`, `BeginOutputReadLine/BeginErrorReadLine` called — required to drain pipes and prevent deadlock.
- **LWE** (`SpawnLweProcesses`): `RedirectStandardOutput/Error = false` — do NOT add `BeginOutputReadLine/ErrorReadLine` here.

**IPC readiness**: after spawning mpvpaper, `Launch` polls `TryQueryTimeRemaining()` up to 40 × 50 ms (2 s total). `TryQueryTimeRemaining` splits the raw socket buffer on `\n` and tries to parse each line as JSON — mpv sometimes sends multiple responses in one read.

**Single video:**
```sh
mpvpaper -o "<mpv-options>" '*' /path/to/wallpaper.mp4
```
`'*'` targets all Wayland outputs.

**Playlist (Play All / Shuffle):**
- Shuffle **pre-applied** to path array in `ApplyPlaylist()` (not via `--shuffle`) so order is known for `playlist_observer_paths.json`
- Single video → `Launch(opts, path)` directly
- Multi-video → `ApplyTimedPlaylist(intervalSeconds, advanceOnVideoEnd: true)` (the interval = the minimum play time) — livepaper-owned; **no `--playlist=file` or `--loop-playlist=inf`**
- Scenes present + playable → the same (with "Separate timing for scenes" on — the default — a scene / still image moves on after "Switch scenes after", 0 = never; off: at the minimum, else the maximum, else a user switch — `player-adapter.md` § Rotation; the old fallback to `GlobalIntervalSeconds` is gone)
- Multi-video playlists are livepaper-owned through the timed machinery (no `playlist.txt` / `--playlist=file`)

**`AppendToActivePlaylist(IReadOnlyList<string> paths)`** — injects new paths into a running session:
- Timed mode (`_timedPaths != null`): dedup-appends to `_timedPaths` in-memory. IPC `loadfile append` is handled naturally by advance-on-end pre-fetch.
- Non-timed mode: sends `loadfile append` IPC for each path.
- Called from `AppOps` (the web layer) after `AutoAddLibraryToPlaylist` adds new WE items mid-session.

## Scenes (folder-based) & live overrides

- **A scene's play path IS its item folder** (`workshop/<id>` / `local/<id>`) — no `.scene` marker. `IsScenePath(path)` = "the path has no media file extension" (a folder ⟺ scene). `SwitchToFile`'s scene branch launches LWE by **id** (local — LWE's native WE-dir lookup) or **dir path** (owned `workshop/` copy; derived via `LibraryStore.Locate`); `QueryCurrentSceneWorkshopId` = the folder name. Scenes have no mpv socket, so `QueryCurrentPath` returns the folder from `_history`, and `Apply` sets `_history=[path]` for single applies so a lone scene is trackable.
- **Per-item volume/speed come from the index.** `PlayerHelper`'s private `ReadVolumeOverride/ReadSpeedOverride` **delegate to `LibraryService`** (→ `LibraryStore`); effective = `override ?? global` on every path (launch, advance, transition, scene).
- **Live apply, no restart:** `ApplyOverrideLive(path)` retargets the *playing* wallpaper — mpv `set_property volume/speed` (video) or `ApplyLweVolume`→`pactl` (scene volume; scenes are 1× → speed no-op). `SetVideoScale` applies fill/fit live via mpv `panscan`. A video→video IPC switch (`TryIpcSwitchToFile`) carries the effective volume/speed as **`loadfile` per-file options** — atomic, so mpv can't reset volume to the launch default after the load (otherwise the advanced-to item played at global).

## WE-style transitions (`TransitionService` + `liascape-transition`)

Animated effect between wallpaper switches, à la Wallpaper Engine. **Full-live** (video→video): BOTH
sides keep *playing* through the effect — the renderer decodes A (from its live position) and B (from
0) with libmpv, not two frozen stills. Frozen stills remain the warmup fallback + the only source for
scene sides.

**Under `PlayerEngine=liascape-player` none of the scene constraints below apply** (Phase 2 Task 9): a scene
is a live texture like a video, so every method runs as picked for V→S, S→V and S→S — no auto-fallback,
no `--reveal-b`, no `SceneTransitionDelayMs` cover. full-live animates both sides; reveal/frozen hold a
scene A by a still copy of its last frame (its worker stops rendering at the hold); frozen holds a scene
B on its first frame until the handoff. A scene never ends, so an `align: end` switch away from one
starts as soon as B is ready. `player-core.md` § Scene worker → "Transitions
with scenes (Task 9)".

**Methods + per-switch auto-fallback.** One picker (`TransitionMethod` = frozen|reveal|full-live);
`TryStart` resolves the *actual* method per switch from the A/B kinds. **Only a SCENE side is
constrained** — it can't be a live GL texture: a scene **A** → LWE `--screenshot` still (windowless; grim fallback) (`fromTex`), a scene **B**
→ revealed live underneath (transparent `toTex`). A **video** side is always decodable. So:

- **full-live** decodes each *video* side: **V→V** decode A + decode B (both textured → all effects).
- **S→V** → **reveal-a** (`--reveal-a`, transparent): the overlay decodes B **live** (plays + crossfades
  its own audio in) and reveals it over the **LIVE scene-A** underneath (transparent fromTex → compositor
  blends B over the live wallpaper). **No scene-A capture** (no grim/still → no stale frame, no baked-in
  windows). The B handoff can't copy V→V's trick (V→V plays mpvpaper-B *in sync* hidden under its OPAQUE
  cover; reveal-a's transparent cover would expose it), so: mpvpaper-B is launched **late + paused**, under
  the overlay's opaque **end-hold** (`--hold-end-ms`), **pre-buffered** near the handoff (`--start≈`
  effect+hold); at teardown the renderer **seeks it to overlay-B's exact frame** (`--mpv-seek-b`, hr-seek +
  a ~0.1s anticipation for the decode-settle) then unpauses → seam **≈ −0.03s** (a ~2-frame forward skip,
  never a repeat; measured `B-SEAM` in the renderer log vs V→V's 0.000). Reveal effects only (A is the
  transparent side). scene-A fades out via liascape-audio across the effect+end-hold (no silence gap).
- A scene **B** → **reveal-b** (`--reveal-b`, transparent): **V→S** decode-A + reveal scene-B; **S→S**
  still-A + reveal scene-B (reveal effects only — B isn't textured).
- **frozen** + B=scene → **reveal** (a still-B can't match a continuously-animating scene → jump).
  frozen + video-B = both stills, all effects, B hands off paused frame0→play.
- **reveal** = still-A + live B revealed (reveal effects only).
- **effect gate**: when B ends up live-*revealed* (reveal / reveal-b / S→S) the effect must be
  reveal-capable (`IsRevealEffect`/`RevealEffects`); a warp there → **re-pick a reveal effect**
  (`PickRevealEffect`) so B keeps PLAYING (never freeze B on frame0); only a video-B with NO reveal
  effect enabled falls back to frozen. (full-live with a decoded B has no gate — all effects work.)

- **Assets** (`transitions/`, shared with the UI): `glsl/<id>.glsl` (gl-transitions bodies — `vec4 transition(vec2 uv)`), `manifest.json` (`id,name,category,defaultOn,author,license,uniforms[]`), `wrap.vert`/`wrap.frag.template`. Generated by `scripts/generate_transitions.py`. See `transitions/README.md`.
- **Renderer** (`src/native/liascape-transition`, C): per-output `wlr-layer-shell` **BOTTOM** surface, opaque, input-transparent, EGL/GLES3. **Full-live:** `--from-video`/`--to-video` (+ `--from-start`/`--to-start`) → a **libmpv render-context per side per surface** decodes into an FBO texture each frame (sampled as `fromTex`/`toTex`); `--from`/`--to` **raw RGBA** stills (ffmpeg-normalized → no image lib) are the warmup fallback until the first decoded frame + the only source for a scene side. Effect runs over `--duration-ms` at display-refresh fps (composites at refresh even though video updates at its own rate — `BLOCK_FOR_TARGET_TIME=0`). **libmpv gotchas:** must set `vo=libmpv` (else mpv spins a real Vulkan VO → NVIDIA crash) and free `mpv_render_context` with the GL context current. Links `mpv` (pkg-config). Built by `install.sh` (no-ops if the wayland/EGL/mpv toolchain is absent).
- **`TransitionService`**: `Effective(settings, playlistSettings)` = override-or-global (mirrors `AppOps.Eff*`); `CurrentConfig()` reads `PlaylistService.LoadCurrentState()` + settings; `PickEffect` (shuffle, no-immediate-repeat, or sequential) + `PickDuration` (single or `Max>Min` range). `TryStart(from, fromScene, to, toScene, cfg)` captures both frames **per output** (video → ffmpeg @ mpv `time-pos`/0; scene-from → LWE's **`--screenshot` dump** `~/.cache/livepaper/liascape-scene-<output>.png` (the GPU framebuffer, **no compositor windows**) written at scene launch via `--screenshot … --screenshot-delay 30`, **grim only as fallback** when the dump is missing — grim composites whatever windows are open; scene-to → the item's library preview image), composes the shader, spawns `liascape-transition` detached. Resolves `transitions/` + the binary via `LIASCAPE_TRANSITIONS_DIR`/`LIASCAPE_TRANSITION_BIN` (set by `install.sh`), else a repo-relative walk (dev).
- **Video-END alignment (`--align-a-end`, sub-frame)**: a timed video-end V→V advance (`DoVideoEndWait`
  → `TransitionService.RequestAlignAEnd()`, one-shot flag consumed by `TryStart`) makes the renderer
  end the effect exactly at A's EOF. It holds at p=0 (opaque live A — looks exactly like the wallpaper)
  and **anchors on a time-pos TICK**: at the instant A's time-pos advances, its true position is exact
  (a raw threshold check would be ±1 SOURCE frame, 17–42ms) → `go_time = (EOF_wall − duration −
  reveal_hold)`, an exact wall-clock target that can land between display frames; p's clamp holds 0
  until it, then p=1 lands at EOF (log `A-END: wall-err`; measured **+1.4–3.4ms** at 100/1000/10000ms
  + real wallpapers — under ½ display frame @144Hz, the physical floor). Re-anchored every tick until
  start. CLOSED-LOOP: the backend lead (`durationNow + LastCoverMs + slack`, duration re-read per
  iteration → live) only needs to fire EARLY — the gate spends the slack invisibly. Fired LATE (cover
  blowout) → immediate start. **Loop semantics mirror the desktop** (`--from-loop`/`--to-loop` =
  `settings.Loop`, exactly what mpvpaper runs with — timed / advance-on-end sessions included):
  a side **shorter than the effect** keeps LOOPING through it when its context loops (that's its
  normal on-screen look), and **freezes on its last frame** (`keep-open=yes`) when Loop is off —
  never rewinds a non-looping clip, never goes black. The aligned advance additionally runtime-pins A
  `loop-file=no` for a clip ≥ effect (at the GATE, not init — during warmup the visible mpvpaper-A
  still loops; a pre-pinned overlay-A would jump at cover) so a late fire ends in a freeze, not a
  rewind. Loop-off short B: overlay-B freezes at its last frame and the mpvpaper-B pre-seek clamps
  just short of EOF → seam 0.000 (verified).
  A target further than `A_HOLD_MAX` (8s — e.g. A wrapped during warmup after a very late fire) →
  start unaligned rather than hold a whole pass. The teardown pre-seek of mpvpaper-B is media-time =
  `duration × B-speed`, **wrapped by B's duration** (a raw `seek duration` past a short B's EOF clamps
  → up to a full clip of seam); the `B-SEAM` log is wrap-aware. Full-live V→V only (reveal/frozen
  freeze A at the cover — a still can't rewind). Overlay-B + mpvpaper-B stay paused through the gate
  so the handoff position stays = duration. `PlayerHelper.Stop()` calls
  `TransitionService.ClearInProgress()` — a stale InProgress marker would delay the next session's
  first video-end sample.
- **Monitors (`MonitorDetector`)**: hyprctl → swaymsg → wlr-randr → **`liascape-transition --list-outputs`** (plain wl_output, hyprctl-shaped JSON — needs only `WAYLAND_DISPLAY`) → xrandr. hyprctl gets `HYPRLAND_INSTANCE_SIGNATURE` auto-discovered from `$XDG_RUNTIME_DIR/hypr/` when the env lacks it (systemd user unit / boot daemon). **0 monitors = TryStart bails = NO transition** (logged `transition SKIPPED: …`) — that was the silent cause of the storm below.
- **Re-arm settle gate (`DoVideoEndWait`)**: after ANY switch the re-armed wait first blocks until mpv's `path` == `_lastSwitchTarget` (set by `PostSwitch`/`Launch`; ≤8s) — `InProgress` alone only covers switches that got an overlay. Without it a bare loadfile (transition bailed) is re-armed ~1ms later while mpv still reports the OUTGOING file's last seconds (< lead) → instant re-fire → **storm of switches ~85ms apart** (2–9 flashes per advance, random landing item, per-file state lost).
- **Per-file `mute=` is explicit both ways** in `TryIpcSwitchToFile` (`mute=yes|no`, like `volume=`): file-local options restore the pre-file value at the next load, so a `mute=yes`-only load that was later auto-unmuted via `set_property` handed the NEXT file the launch global (`--mute=yes`) → muted while `_isMuted=false` and auto-mute never corrected it.
- **Hook = `SwitchToFile`** (the single switch chokepoint → every entry: apply, next/prev/random, timed advance, keybind `--action`). **Fires for video→video AND scene-involved switches.** Full-live handoff (video→video): B is loaded **unpaused** (`TryIpcSwitchToFile` with no `pauseAtStart`) so it plays LIVE under the opaque overlay and is revealed at teardown at a matching position (the overlay's own B decoder and mpvpaper's B both run from 0 → match within ~1 frame). Gated on the IPC path actually running (`mpvAlive && !_restartPending`) so a cold launch never gaps under the overlay. **Scene-involved switches**: the overlay covers (grim still / live-A) **inside the existing pre-launch crossover** — the crossover launches B (LWE / mpvpaper) UNDERNEATH (the overlay sits at layer **BOTTOM/level 1**, above LWE+mpvpaper at **BACKGROUND/level 0**, by level not creation order), so the LWE launch flash / player swap is hidden; `--reveal-hold-ms` (reuses `SceneTransitionDelayMs`) holds the cover while the slow LWE scene-B renders, then reveals. `fromPath` is a sentinel for scene-A (the LWE `--screenshot` dump / grim captures the on-screen scene regardless of path; the playlist history has already advanced so `QueryCurrentPath` returns the target). Frozen S→V launches mpvpaper-B **paused** (`--pause=yes` + the renderer's `--mpv-unpause`) → still-B frame0 hands off to live-B with no jump. `--scaling fill|fit` matches `VideoScale`.
- **Volume curves are CUBIC — never ramp a percent.** Measured on mpv 0.41: `volume=100` → -24.08 dBFS,
  `volume=50` → -42.15 (**-18.07 dB**, not -6), `volume=25` → -60.18 (-36.10). PulseAudio software volume
  (liascape-audio's `pa_volume_t = PA_VOLUME_NORM·pct/100`) cubes the fraction the same way. So a linear
  percent crossfade collapses: at the midpoint both sides sit at 0.5³ = -18 dB instead of -6. Measured
  before the fix: a **-17 dB sag, >1s below -40 dB, in the MIDDLE of every transition** ("it goes quiet
  around the switch"). Two corrections, both **equal-power** (`cos`/`sin`, so A²+B² = 1 → constant total
  power end to end, no dip at any point):
  - **Renderer** (`liascape-transition`, V→V + reveal-a): `volume` holds the user's level; the fade ramps
    **`volume-gain`**, which IS exact dB (measured: -6 → -6.02, -12 → -12.04). Decoders init at
    `volume-gain=-96` (silent) so overlay-A never doubles the live mpvpaper-A during warmup.
  - **Backend** (scene crossfade, `PlayerHelper`): both legs go through cubic percent paths (mpv
    `volume` + liascape-audio), so the percent is **pre-distorted by the cube root** of the wanted gain
    (`XfPct = target·∛gain`) — the cubic curve then reproduces that gain exactly. Steps also
    refined to ~50ms (was 5-12 steps over up to 8s = audible stepping).
  Verified V→V by capturing the sink monitor across a switch: midpoint sag -17.2 dB → **-2.6 dB**, which
  is the equal-power ideal for those two clips' own loudness difference (fade error **+0.0 dB**); longest
  run below -40 dB 1074ms → 8ms. Scene legs use the same correction (not yet measured).
- **V→V audio handoff = AUDIO_SETTLE, not GO** (`liascape-transition`). The renderer speed-tracks overlay-A
  onto mpvpaper-A (2×/0.5×/1×) before GO; every speed step reconfigures overlay-A's audio chain
  (scaletempo in/out) → a 3-4ms discontinuity that reaches the sink ~one audio buffer later (measured
  **202-240ms after the step**). GO = ~83ms after the last step (`BAND_HOLD`), so on manual-next /
  late-fire switches the hole landed ~130ms after E0, when overlay-A was the ONLY source of A → 3-4ms of
  digital silence ("flicker" at the start, on A; timing varied with the track → inconsistent). Aligned
  advances were already clean (A-END gate holds 400ms+). Fix: overlay-A stays at -96 dB and the
  ready-file (→ backend cuts mpvpaper-A) waits **`AUDIO_SETTLE` = 300ms past the last speed step**;
  the overlay still covers visually at GO, mpvpaper-A carries A audibly underneath until then (manual
  E0→ACUT ≈ 220ms, aligned unchanged ≈ 45ms). Do NOT lengthen `BAND_HOLD` instead — at 350ms the tracker
  limit-cycled across the deadband and blew its 4s budget.
- **Backend ready-wait (`TransitionService`) must exceed the renderer's worst case** (4.0s track budget +
  AUDIO_SETTLE + spawn) → capped at ~6.5s. At the old 3.5s a slow warmup timed out first → mpvpaper-A was
  cut to B under a still-silent, still-transparent overlay → measured **446ms of digital silence**.
- **Killing an in-flight overlay unpauses mpvpaper** (`TryStart`): a next pressed mid-effect killed the
  overlay that mpvpaper-B was parked for (paused, awaiting its teardown) → silent + frozen ~4.5s and the
  new overlay's A-track couldn't converge. Pre-handoff kill → mpvpaper still playing → no-op.
- **Measuring it**: capture the sink monitor and compare against a REFERENCE mix decoded from the source
  files at the logged positions (A full → A·cos + B·sin → B), latency-aligned by cross-correlation —
  baseline-only dip detection mistakes real silence in the content (e.g. an OP's silent tail + an ED's
  silent intro, ~300ms both at once) for dropouts. Verified 4/4 manual + aligned + mid-effect interrupt clean.
- **Audio crossfade.** V→V full-live crossfades in the renderer (its two libmpv decoders, `audio_volume`). Scene-involved switches crossfade in the **backend** (mode-independent), synced 50/50 over the transition duration: OLD ramps X→0, NEW ramps 0→X, crossing at the midpoint; OLD is reaped when it hits 0 (replaces the fixed `SceneTransitionDelayMs` kill). The **video** side is faded via mpv `set_property volume` (new launched `--volume=0`). The **scene** side is faded by **`liascape-audio`** — a small persistent libpulse helper (`src/native/liascape-audio`, `LIASCAPE_AUDIO_BIN`, built by `install.sh`): the backend pushes `set <pidcsv> <vol> <mute>` lines (`PlayerHelper.AudioCtl` → its stdin), and liascape-audio applies the volume to that scene's sink-inputs **in-process on every PulseAudio sink-input new/change event** (~1ms). This is mandatory because shelling `pactl` per stream (~10-40ms) can't beat PA's default-volume-on-stream-create + the connect/disconnect volume resets LWE triggers → audible flashes. liascape-audio maps **sink-input → client → process PID** (`application.process.id`; PID is stable across LWE's client/stream re-creation, unlike sink-input # / client.id) and matches against the backend's old/new **PID sets** (`GetLweProcPids`, snapshotted before/after launch). **It MUST skip re-applying a stream already at the wanted vol/mute** — else setting volume fires a `change` event → re-apply → infinite loop that storms+wedges PulseAudio (this was the root of both the residual flashes and recurring server hangs). During the cover the OLD is held at target + NEW muted+0; after the reap the held group keeps NEW at target (event-driven, no end dip); `AudioCtl("clear")` releases ~3s later so steady-state `ApplyLweVolume` resumes. No fade-in on the first wallpaper (`hasOld`). liascape-audio's client→pid cache **evicts on PA `remove` + FIFO-recycles when full** — else it fills with dead LWE clients (LWE churns ~4/transition) and new scenes stop resolving → stuck at 0. **stream-restore poison:** PulseAudio continuously saves the (single, `application.name`-keyed) LWE app volume, so a transient fade value gets remembered and poisons the NEXT *fresh* launch (first item / restore / random — no crossfade to correct it). `CorrectSceneVolume` counters it: on a non-transition scene launch, hold the new scene at target via liascape-audio (event-driven → overrides the restored value as the stream appears) ~3s, then release. (LWE forces its own `application.name` + pipewire ignores `module-stream-restore.id`, so the restore key can't be changed — correction is reactive.) Absent helper → scene audio just doesn't crossfade (plain switch). **Gap:** V→V *reveal/frozen* is a single mpvpaper `loadfile` (hard A→B switch) → no overlap crossfade there (V→V's real mode is full-live, which does).
- **Config**: `PlaylistSettings.Transition*` (per-playlist, gated by `OverrideGlobalSettings`) + `AppSettings.GlobalTransition*` (fallback). UI: `TransitionPicker` (live WebGL previews via `/transitions/frag|vert|preview`) opened from the playlist-settings modal + the global Settings "Rotation" section.

## Mute: user vs auto

**`SetMute(bool)`** — auto-mute path. If `!mute && (_userMuted || UserMuteStatePath exists)`, returns without unmuting.

**`SetUserMute(bool)`** — user action path. Writes/deletes `UserMuteStatePath`, updates `_userMuted`. `toggle-mute` CLI action uses this, not `cycle mute` IPC.

**`AudioMonitor.IsMuted`** — exposed so `PlayerHelper` can read mute state on LWE launch.

**`PlayerHelper.IsMuted`** — `public bool IsMuted => _isMuted` used by `Program.cs` for toggle-mute 3-way logic.

**Scene→video mute**: `SwitchToFile` bakes `--mute=yes` into `launchOpts` if `_isMuted` is true. Always read `_isMuted` fresh inside the task — never capture into a `bool` local before `Task.Run`, value goes stale.

**LWE orphan prevention**: `_prelaunchPidsToKill` (`private static string[]? _prelaunchPidsToKill`) holds LWE pids from an in-flight scene launch cancelled before the process started. `SwitchToFile` checks and kills these at entry. Also cleared in `TeardownTimer` and crash-detection block.

## Auto-Mute (`AudioMonitor`)

`AudioMonitor.Start/Stop` called by the `/settings` handler (`Web/ServerHost.cs`) when an AutoMute field changes; started on `--serve` startup, `Stop()`ped (+ handed to a detached `--monitor`) on `ApplicationStopping`. Three concurrent tasks:

1. **`WatchStreamsAsync`** — runs `pactl subscribe`; one `StreamWatch` (parec CTS + `Foreign` flag) per stream, plus an `own` set. **Classify, then count**: on `'new'`/`'change'` of an unknown id it starts `parec` at once (warm-up) AND classifies the stream right away (`ListStreamsAsync`: one `pactl list sink-inputs`, the liascape-player ownership filter + LWE client ids built concurrently; not listed yet → asked again ≤ 3× 50 ms apart); its level counts only once classified **foreign**. Ours → parec stopped and the id remembered in `own` until its `'remove'` (indices are reused), so its later `'change'` events (uncork, relink) never re-open a window. On `'remove'`: cancels immediately. Initial reconciliation on startup (foreign → watched, ours → `own`). Filters mpv streams (`application.process.binary = "mpv"` / `application.name = "mpv"`), LWE, and liascape-player's own (player-adapter.md). **Never count a stream before its verdict** — the old "count at once, verify 100 ms later" + "every `change` re-adds" let each switch's incoming own stream auto-mute the wallpaper (owner report 2026-10-28; player-adapter.md § auto-mute).

2. **`MonitorStreamAsync`** — `parec --monitor-stream=<id> --format=float32le --channels=1 --rate=8000 --raw --latency-msec=10` (the small fragment: parec's default buffering held the first data ~2 s back — measured 2023 → 65 ms, `scripts/measure-automute-latency.py`); reads 160-sample chunks (20ms), computes peak dBFS. `Interlocked.Increment/Decrement` on `_aboveThresholdCount`. `finally` always decrements if above threshold when cancelled.

3. **`WatchMuteAsync`** — polls `_aboveThresholdCount` every 20ms. Counts consecutive ms above/below threshold; fires `PlayerHelper.SetMute` once delay exceeded.

**Critical invariant**: always `--monitor-stream=<id>`. Never `@DEFAULT_MONITOR@` — captures livepaper's own audio → oscillation (mute → silence → unmute → audio detected → mute...).

**LWE stream filter**: linux-wallpaperengine's audio registers as `application.process.binary = "linux-wallpaperengine"` (also `application.name = "linux-wallpaperengine"`). `GetNonMpvStreamIdsAsync()` + `GetLweSinkInputIds()` match on the binary — auto-mute **skips** it (else LWE mutes itself) and live scene-volume **targets** it (`ApplyLweVolume` via `pactl`).

**`_aboveThresholdCount` reset**: `Interlocked.Exchange(..., 0)` at top of `WatchStreamsAsync` (not in `Stop()`), so `finally` blocks from previous run can decrement safely without racing against new monitors.

**Daemon persistence**: on close with AutoMute enabled, `SpawnDetachedMonitor()` launches `livepaper --monitor` via `setsid`, writes PID to `~/.config/livepaper/monitor.pid`. On next open, `KillDetachedMonitor()` kills it before app's own `AudioMonitor` starts.

## Restart Daemon

mpvpaper has a frame-buffer memory leak (~1.3 MB/s). `--restart-daemon` periodically kills and relaunches mpvpaper to work around it. Interval configured via `RestartIntervalSeconds` (default 600s, min 5, max 3600) in Settings → Playback.

**In-process (GUI open)**: `UpdateRestartTimer()` starts a `System.Threading.Timer`. No-op when `_daemonMode = true` so the timer daemon doesn't start a competing in-process timer. Timer stops in `TeardownTimer()` (called by `Stop()` and before each new session). Restarted via `UpdateRestartTimer()` after every `Apply`/`ApplyPlaylist`/`ApplyTimedPlaylist`/`ResumeTimedTimer`/`RestoreTimedPlaylist`.

**Detached daemon (GUI closed)**: `SpawnRestartDaemon()` launches `livepaper --restart-daemon` via `setsid`, writes PID to `restart.pid`. Bails if `IsGuiTimerAlive()` (mirrors timer-daemon guard). Killed on GUI open, by `Stop()`, and by `--kill`.

**Restart disabled**: `RestartIntervalSeconds <= 0` → all restart paths (`SpawnRestartDaemon`, `UpdateRestartTimer`, daemon loop) bail immediately with no-op. Restart is fully off when interval is 0.

**Timed playlist coordination**: `RestartCurrent()` writes `"restart"` to `pending_action.txt` instead of cold-restarting directly. The tick owner dispatches to `RestartCurrentAndLaunch()` which kills and relaunches the current wallpaper without advancing or resetting the countdown. Skipped when `_timedTimerPaused` is true (daemon also checks `IsTimedPlaylistPaused()` from the state file) to avoid queuing a restart that fires immediately on unpause.

**Race guard**: `RestartCurrent()` checks `IsPlaying` inside `_lock` before calling `DoColdRestart` — prevents relaunch if `Stop()` ran while the callback was waiting on the lock.

## Centralized Helpers

**`ArmVideoEndWait(string next, bool prevIsVideo = true)`** — canonical way to start a `DoVideoEndWait` task. Sets `_waitingForVideoEnd = true`, creates and assigns `_waitCts`, spawns task. Always use this — never inline the 3-line pattern.

**`PostSwitch(string path)`** — called after every wallpaper switch in timed machinery. Resets the item's play time and `_timedRemainingMs`; if `_advanceOnVideoEnd && !IsScenePath(path) && CanRotate`: calls `AdvanceToNext()` and `ArmVideoEndWait`. Always calls `SaveTimedState()`. Used in `LaunchAndReset` and both `DoVideoEndWait` completion paths.

**`PlayingHistoryIndex`** (private property) — when `_waitingForVideoEnd = true`, `_historyIndex` is pre-fetched one step ahead; actual playing item is at `_historyIndex - 1`. Property returns `_historyIndex - 1` when `_waitingForVideoEnd && _historyIndex > 0`, else `_historyIndex`. Use this everywhere "current playing index" is needed. Under liascape-player an aligned switch's B counts as playing from its `transition.started` (its effect runs, `cur:*` = B) — `DoVideoEndWait` commits it then, not at the handoff, like legacy at its overlay's start (player-adapter.md, `DoVideoEndWait` row); a next/prev/random mid-effect steps from B.

**`EnsureTimedTick(takeBack = true)`** — the only way to start the tick (`StartTimedTimer`): EVERY timed session has
one, whatever its interval and whatever its length (it takes the queued next/prev/random/restart — a pure
advance-on-end session, a 1-item session and one grown back by an Undo had none, so every queued switch sat untaken
until a later tick's start threw it away). A 1-item session takes a next / random (a switch to its one item, with its
transition) and legacy's leak `restart`, but **never rotates by itself** (`CanRotate` = > 1 item: its interval only
starts over, `PostSwitch` arms no aligned switch to itself — as `ApplyTimedPlaylist`/`RearmAdvanceOnVideoEnd` already
did). Shared by both engines. Call it wherever the list or rotation changes; `takeBack: false` for live edits (no
restart after `ReleaseTimer`). Details: `session.md` § Timed Playlist.

**`RandomAndLaunch`** (a timed session's `random`) — a switch OUTSIDE the rotation's order, so it re-seats both
cursors: `_timedIndex` = the pick's index in `_timedPaths` (the rotation goes on from the pick: next / the re-armed
aligned switch = the item after it), and the history after the playing item is dropped before the pick is appended
(an advance-on-end session's pre-fetched, never-played next + any forward stack left by previous). Before, the pick
only went into the history: `AdvanceToNext` stepped the OLD `_timedIndex` (still at the pre-random item, or at the
pre-fetch) → random onto that position's successor re-armed / nexted to the pick itself (stuck), and previous went
to the never-played pre-fetch. Next after a previous still walks the history forward (= the pick again). Shared by
both engines. Guard: matrix `seq:random+next` / `seq:random+prev` (`playlist`, `pending`).

## Mode Switches (mid-session, no mpvpaper restart)

**`UpdateTimedSettings(shuffle, interval, advance)`**: called when interval/mode settings change mid-session. Preserves proportional remaining: `elapsed = max(0, oldIntervalMs - _timedRemainingMs)`, `newRemaining = max(tickInterval, newIntervalMs - elapsed)`. Advance toggled → cancel / re-arm the end-of-video wait; a new minimum under advance-on-end (liascape-player) → re-arm the armed one to the same B. Never restarts current wallpaper. (`SwitchFromTimedToAdvanceOnEnd` / `SwitchFromAdvanceOnEndToTimed` had no caller — removed 2026-10-28.)

**App close**: the Electron shell (`app/shell/main.js`, `window-all-closed` / `before-quit`) kills `livepaper --serve`. The backend's ASP.NET `app.Lifetime.ApplicationStopping` hook (`Web/ServerHost.cs`) is the close handler: it `AudioMonitor.Stop()`s and hands mute back to a detached `--monitor` when AutoMute + playing.

**One timer owner (`ReleaseTimer`, `OtherTimerOwner`).** The stopping backend `ReleaseTimer()`s FIRST —
saves the timed state, disposes the tick, cancels its armed end-of-video wait (the new owner arms its
own), without touching the session (`TeardownTimer` would clear it) — then clears `gui_timer.pid` (only
its OWN pid: deleting the next backend's let `SpawnTimerDaemon`'s guard spawn a daemon next to it) and
hands off to `--timer-daemon`. Before, it ticked on until the process exited — up to Kestrel's 30 s
shutdown timeout while the UI's WebSocket held it open — next to the daemon and then the next backend
(dotnet watch, an app relaunch): their aligned switches superseded each other and each "switched now",
a switch every 1–16 s. Also: a GUI-mode tick checks `gui_timer.pid` once a second and yields when another
live `--serve` backend (cmdline-checked, not liveness alone) owns it, and so does a superseded aligned
switch; **a superseded aligned switch re-arms for A's end** (backoff) instead of switching now — this
process cancels its own wait before it switches, so a supersede always means another requester.
