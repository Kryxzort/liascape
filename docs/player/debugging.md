# Debugging liascape-player: symptom → query → likely cause

Covers diagnosing the running player (`src/player/`) from text alone. The general query order and a private player
for experiments are the skill `.claude/skills/player-debug/SKILL.md`; the probes themselves are in
[modules/command-api.md](modules/command-api.md). Every query below is `liascape-player ctl …` (or `liascape ctl …`).

## The dropout detector (`probe dropout`)

`ctl probe '{"name":"dropout","args":{"corr":"tr-N"}}'` compares what the bus really output (the meter) with what the
sources and the recorded gain schedule say should have played, over `transition.started` − 500 ms … `.done` + 500 ms.
It replies `{"status":"pending"}` at once and delivers `probe.dropout {corr, report}` as an event (`ctl subscribe
probe.`). With `player.debug` on (`serve --debug` or `set player.debug true`) it runs after every `transition.done`,
once the 500 ms post-roll was really captured. A retire's ramp and a pause gate record windows too; their log events
carry the corr to probe. Add `"dump":"/abs/path.json"` to write every analysis input plus the report for offline
replay — the evidence for "a real gap, or the detector's own alignment".

Report fields: `lag_ms` (the best alignment, refined to 1 ms), `fit_db` (how good it is — large means little
reliable overlap, not a bug), `offset_db` (a level mismatch, not a dropout), `drops` (10 ms-bin gaps), `micro_gaps`
(sub-bin gaps too short to move a bin), `unmeasured` (stretches the meter itself missed — many of them means the
meter isn't real-time or the machine is starved; the audio there is unchecked, not clean). Three "nothing to report"
shapes: a synchronous `unsupported` error (no window recorded yet, or the meter down — the hint says which); the
event's `skipped` (`busy`: two analyses already run; `window_too_long`; meter down); `report.fit: "insufficient"`
(it ran but had too few reliable bins to judge). Not modelled: a second audible wallpaper on another output sharing
the bus.

Other audio tools: `probe bus` first whenever `dropout` or `meter.window` says unsupported (it names the reason);
`probe meter.window {"last_ms":1000}` for raw 1 ms dBFS; `probe sources` for the graph's `gain_effective_db` next to
mpv's real `mpv_volume_gain`, pause, device and delay; `probe frames` — a dropout that coincides with a `missed`
frame is more likely a GPU stall than an audio bug.

## Audio

| symptom | query | likely cause |
|---|---|---|
| A fade feels uneven (loud, then suddenly quiet) | `probe sources`: `gain_effective_db` vs `mpv_volume_gain` mid-ramp | A gain pushed through mpv's cubic `volume` instead of `volume-gain` sags mid-ramp (`volume=50` = −18 dB). The player never does this; a mismatch is a regression in `units::mpv_volume_gain` or `MpvSource`. |
| A glitch right at a speed change | `logs {"kind_prefix":"source."}` around the `set`; `probe dropout` on a concurrent transition | Crossing 1× used to rebuild mpv's audio chain (3–5 ms silence); the always-present tempo filter prevents it ([modules/sources.md](modules/sources.md)). A new hole there means the `af` chain lost `@liascape-tempo`. |
| Silence for a second or more after a switch starts | `logs {"corr":…}`: a late `transition.started` or `transition.failed` | B must be `Ready` before the effect starts: `READY_TIMEOUT` (10 s), or 50 s for a scene still loading (`transition.waiting_load`). A slow decoder start, a cold mount, a corrupt file. |
| An onset clicks or starts mid-ramp | `logs {"kind_prefix":"onset."}` (debug), `source.audio_flowing`, `transition.onset_timeout` | Every ramp-in waits for flowing audio (invariant #8). `reason: timeout` means the source never confirmed — check it has audio and that its `AudioFlowing` arrived. |
| Silent after a restore though the picture plays | `probe sources` → `mpv_pause`; `logs {"kind_prefix":"source."}` for `parked`/`unparked` | A parked or restored source must come back unpaused and ramp in; a source still paused is a regression in park/unpark or the restore fade. |
| No wallpaper audio after the audio server restarted | `probe bus` (`state`, `reason`); `probe sources` → `mpv_audio_device`, `mpv_current_ao`; `logs {"kind_prefix":"audio.bus."}` | The bus re-creates itself with backoff and re-routes every source (`audio.bus.sources_rerouted`), then ramps back in on flowing audio. `mpv_current_ao: null` after `up` = the audio track wasn't re-selected. |
| Frozen or silent after a stop or a new wallpaper | `get player.paused` | The pause belongs to the session: `stop` clears it and the backend clears it for a new session. Still `true` after either is a regression. |
| Pause flipped after a crash restart or a stall | `get player.paused` before/after; adapter log (`player.paused = …, kept`) | The player is the only authority (it restores pause from its snapshot); the backend never re-asserts a copy. |

## Picture, outputs, pacing

| symptom | query | likely cause |
|---|---|---|
| A black or transparent frame between A and B | `logs {"kind_prefix":"output.seam"}`, `probe frames` → `seam_frames`/`last_seam`; `logs {"kind_prefix":"effects."}`; `capture` mid-transition | An uncompilable effect draws as a cut at the midpoint (`effects.compile_failed` once), never black. A seam with no such event is a source shown before it was `Ready` — a recipe bug. |
| The wrong wallpaper on one output, or the old one comes back | `state` → `lay:<c>:main.content`, `cur:<c>`, `parked`; `logs {"kind_prefix":"output."}` | Hotplug rules: a new output adopts the live transition, else `cur:` of the first output, else the parked wallpaper. With no output every `transition` replaces the parked wallpaper, so the last target shows on replug. |
| A transition never starts on `align: end` | `state` (phase `waiting_start`); `logs {"corr":…}` | A's end never comes: after its remaining time + `ALIGN_SLACK` (10 s) it starts anyway (`transition.align_fallback`). While paused the wait is frozen on purpose. |
| A hitch on every output at each switch | `probe loop {"reset":true}` before, `probe loop` after → `max_busy_ms`, `max_open_ms`; `probe frames` → `paced.missed` | With the render worker on, loop busy per switch is under a millisecond typically, a few ms worst. Much more: is the render worker off (`probe sources` → `render_worker` null)? |
| A switch hitch of 65–90 ms, or 230–320 ms | `probe sources` → `mpv_hwdec`, `mpv_hwdec_current`, `hwdec_interop`; the player's environment (`LD_LIBRARY_PATH`, `DISPLAY`) | Hardware-decoder init on the loop: a CUDA interop context made inside the render context (65–90 ms), or `vulkan-copy`'s device creation holding NVIDIA's process-wide lock with no X server reachable (230–320 ms). Loop-rendered sources must use copy modes ([modules/sources.md](modules/sources.md) § Hardware decoding). |
| The wallpaper paused by itself | `probe cover` → `decisions`, per-output `covered`/`app_id`; `get player.cover_hold_active`; `logs {"kind_prefix":"cover."}` | Every output showing content is covered at `player.pause_when_covered`'s threshold. `ok: false` = no usable cover source; the rule never pauses then. |

## Rotation

| symptom | query | likely cause |
|---|---|---|
| A playlist didn't switch | `probe programs` → `phase`, `played_ms`, `remaining_ms`, each item's `skip`/`broken`/`failed` | `holding` = a short clip looping up to its minimum; `armed` = waiting for A's end; `parked` with `while_parked: hold`; `empty` = nothing playable; `idle` = another client switched away (a verb restarts it); `keep` set. |
| A playlist switched early | `logs {"kind_prefix":"program.current"}` → `reason` | `max`, `scenes_after`, `broken` / `failed_skip`, `vram`, `items` (another client showed an item). |
| A playlist looks stuck after failures | `logs {"kind_prefix":"program.failed"}`; `probe programs` | The 1 → 30 s backoff ladder; marks clear when the items change, and when every item failed they are retried at the ladder's pace. |

## Memory

| symptom | query | likely cause |
|---|---|---|
| RSS grows per switch and doesn't come back | `probe memory` → live (`in_use_bytes + mmap_bytes`) vs `free_bytes`, `policy`; `{"trim":true}` | Live flat + free growing = allocator retention: the policy (`mem::apply_policy`) isn't applied (`LIASCAPE_PLAYER_MALLOC=glibc`, or a caller's own threshold). Live growing = a real leak: check `probe loop` → `bounds`, `reaper_pending`, dying/opening sources. |
| In-use heap grows ~1–2 MiB/min live but stays flat headless | in-use delta per minute vs `transitions_done_total`; `probe frames` → `explicit_sync`, `default_queue_dispatched`; `heaptrack` (`nix build --inputs-from . nixpkgs#heaptrack`, with `LD_LIBRARY_PATH=/run/opengl-driver/lib` or EGL won't init under it) | Minutes without a switch growing as fast = per present: an event queue nobody dispatches — explicit sync forced back on with an affected egl-wayland2 ([modules/wayland.md](modules/wayland.md) § NVIDIA). |
| Memory grows over a day of rotation | `probe loop` → `bounds` | Every per-source collection is listed; anything that keeps growing there is a leak. |

## Scenes

Start with `probe workers {"log_tail": true}`: per scene source its `state` (`not_spawned`, `starting`, `running`,
`restarting N`, `broken`, `stopped`), `ready`, `last_error`, `fps_target`/`fps_actual`, `latched`, `stale_reuses`,
`restarts_60s`, `audio {…}`, `loudness {…}`, `throttle`, `vram_stopped`, and the worker's last 50 output lines (LWE's
own warnings) — the first thing to read for any "this scene looks wrong". Crash records:
`~/.local/state/liascape/liascape-player/crashes/<scene-id>-<unix_ms>.json`. `liascape-player scene-check` answers
whether scenes can play here at all.

| symptom | query | likely cause |
|---|---|---|
| A scene shows black and nothing plays | `probe workers` (`state`, `last_error`, `log_tail`); `logs {"min_level":"warn"}`; `scene-check` | `not_spawned` + an error naming `LIASCAPE_WE_ASSETS_DIR` = WE's `assets/` not found. A fatal worker error (`load failed`, `renderer build failed`) = no restart, no record, by design; the tail has LWE's reason. A capture that is black while `latched` climbs = LWE drew black. |
| A scene is frozen though "playing" | `probe workers` → `ticks_sent` → `frames_received` → `latched`, `stale_reuses`, `paused`, `resuming`; `get player.vram_low_active` | `stale_reuses` climbing with `latched` flat = fences not signalling, the GPU starved (the compositor keeps the last frame, correctly). `ticks_sent` flat = paused (item, player, VRAM hold, parked) or resuming after a crash. `frames_received` flat while ticks go out = hung; the heartbeat kills it within the hang timeout. |
| A scene is silent while visibly playing | `probe workers` → `audio {route, gain_db, no_audio, has_audio, flows}`; `probe bus`; `pw-link -l` for `liascape-player-scene.<id>` | `has_audio: false` = the scene has no sound (no node exists, nothing is learned). −96 gain = a mute, volume 0 or a ramp in flight. A node not linked to the bus = a session policy moved it or PipeWire restarted. A debug worker at speed ≠ 1 misses cycles: judge release builds. |
| A scene takes long to appear | `logs {"kind_prefix":"worker."}` (`worker.ready.ms` = spawn → Hello: exec, link, EGL); `probe workers {"log_tail": true}` → `lwe: loaded … in A ms, built in B ms` | A large = reading `scene.pkg` and parsing (a cold disk after a boot). B large = the renderer build: shader text passes, translation (skipped by the shader cache, [scene-lwe-core.md](modules/scene-lwe-core.md) § Shader cache, unless it is off or the core was rebuilt), NVIDIA's GL compile (no disk cache: `gfx/shader_cache.rs`), textures. Split one with `src/player/tests/onmachine/scene_load.py`. |
| A scene keeps restarting, then "broken" | `logs {"kind_prefix":"worker."}`; the newest crash record; `logs {"kind_prefix":"source.broken"}` | 3 restarts in 60 s, then broken (held, silent, skipped by the backend unless whitelisted). Signal 6 = LWE threw past its C API; 11 = a segfault in LWE; "GL context lost" = a GPU reset (one suspend = one restart). A player restart keeps it broken. Reproduce with `liascape-scene-worker --lwe-smoke` under gdb. |
| A scene runs below its set fps; `scene.throttled` logged | `logs {"kind_prefix":"scene.throttle"}`; `probe workers` → `throttle`, `fps_demand`, `gpu_ms_p50`; `get out:<c>.scene_fps` | The GPU budget: the worker uses ≥ 40 % of the GPU and frames are being missed. `throttle: null` with low `fps_actual` = the GPU can't keep up, or the output's own `scene_fps` gate. A cap that never lifts = misses from another cause (`probe frames`). |
| A scene or every wallpaper became a still — "VRAM" | `probe vram` → `probe`, `sample`, `rule.state`, `hold`, `scenes`; `logs {"kind_prefix":"vram."}`, `{"kind_prefix":"scene.vram"}` | Per-scene limit: that worker was stopped, never crashed (`scene.vram_exceeded`). System low-VRAM hold: free VRAM stayed low (a game), the player paused and in `stop` mode freed every decoder; it resumes once free VRAM, minus what we freed, holds for 10 s. `probe: none` = nothing measurable, neither rule acts. |
| A scene's loudness is never learned | `probe workers` → `loudness`, `audio.has_audio`; `logs {"kind_prefix":"scene.loudness"}` | It needs 60 s of audible, unpaused, un-muted play; scenes without sound or under −70 LUFS never report. Switched away early: ≥ 20 s reports a partial. Only the head source of a scene measures. `capped` = 30 min measured, done by design. The index moves only by ≥ 0.5 LU. |
