<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Module map

- `src/main.rs` — CLI entry point: `--version`, `serve` (§ Runtime; without `--headless`
  = real Wayland outputs, § Wayland; supervised unless `--no-supervise`, § Supervisor),
  `ctl` (§ Command API), `scene-check` (§ Scene worker → "Real scenes"), `scene-loudness` (§ Scene worker →
  "Scene loudness" → "Offline estimate"), `health` (below); any other
  invocation prints usage and exits 2.
- `src/health.rs` — feature health (owner 2026-10-28, "make missing libraries fail loudly"): which optional
  pieces work here and why not, each `{ok, reason, …}` (`ok` null = not known): `effects` (the catalogue —
  none / empty / unloadable → every switch is a cut), `vram` (one sample of `vram::probe_from_env` — none →
  the VRAM limit and low-VRAM rule can't act; run once at serve start on the `lia-health` thread, `hello`
  never waits: `{ok: null, pending: true}` until it answered), `hwdec_interop` (the render worker's GL interop —
  none → copy-mode hwdec), `scenes` (`Runtime::scenes_available`), `automute` (the auto-mute Signal's
  capability: `LIASCAPE_PLAYER_AUTOMUTE=0` or the audio bus down → false with the reason), and in `hello.health` only
  `cover` (`{ok, reason, source}` — the covered Signal's source, § Signals), and `bus` (`{ok, reason, state}` — the
  player audio bus itself, `bus_json`: `Up`/`Retargeting` → ok, `state` = the bus probe's; `Down` → false with
  `BusInfo::reason` + "sources play on mpv's default device instead (nothing stops, but no bus meter and no in-player
  auto-mute)"; no bus at all (`Audio::down_reason`: `--ao` ≠ pipewire, `LIASCAPE_PLAYER_BUS=off`) → false, `state`
  `off`; the first session still being set up (`BusInfo::reason == bus::CONNECTING_REASON`, generation 0) → null).
  `hello.health` carries all seven; `liascape-player health` prints `{effects, vram, automute, bus}` (no render
  worker without a GL context; `automute` knows only the env gate: `ok: null` when on; `bus` only
  `LIASCAPE_PLAYER_BUS=off`, else null) for when no player runs —
  the backend's `/health/features` (web-backend.md). Unit tests in the module.
- `src/lib.rs` — module wiring only (`pub mod …;` lines). Add new
  `pub mod` lines here as later tasks add files; don't put logic in this file.
- `src/log.rs` — the event log (below).
- `src/units.rs` — audio units (below).
- `src/mpv/` — libmpv FFI (`ffi.rs`, bindgen output) + safe wrapper (`mod.rs`). § Sources.
- `src/sources/` — the `Source` trait, `MpvSource` (video/image), `ColorSource`,
  `SnapshotSource`, and `SourceHost` (graph nodes ↔ live sources). § Sources.
- `src/recipes/` — programs built only from the blocks; `transition.rs` (Task 11).
  § Transition recipe.
- `src/runtime.rs` — the running player: one calloop loop, ticks, stepped mode,
  hotplug, stop/quit. § Runtime.
- `src/headless.rs` — the `OutputBackend` trait + `Headless` virtual outputs. § Runtime.
- `src/wl.rs` — the Wayland backend: one wlr-layer-shell surface per `wl_output`
  (Task 13). § Wayland.
- `src/redraw.rs` — the redraw policy of frame-paced (Wayland) outputs. § Wayland.
- `src/signal/` — Signals (Phase 3): `covered.rs` (the pure cover rules per source + the hold's
  debounce), `hypr.rs` / `sway.rs` (the IPC cover sources on `lia-cover`), `mod.rs` (the feed, source
  choice, the runtime's `cover_tick`, the `cover` probe); `cursor.rs` (the desktop pointer, audit C6:
  Hyprland `cursorpos` polled on `lia-cursor`, the `pointer` probe — § Scene worker → "The desktop pointer"); `automute.rs` (the in-player auto-mute, on unless
  `LIASCAPE_PLAYER_AUTOMUTE=0`: the rule, `automute_tick`, the `automute` probe) + `mpris.rs`
  (`lia-mpris`, zbus). § Signals.
- `src/api/` — `proto.rs` (wire shapes), `server.rs` (socket, clients, event tap),
  `handlers.rs` (the verbs), `capture.rs` (`capture`'s readback + encode off the loop). `src/ctl.rs` — the shell client. `src/paths.rs` — socket
  and state paths. § Command API.
- `src/probe/` — the probe registry (`mod.rs`: `list`, `sources`, `loop`; `frames.rs`:
  `frames`, Task 13; `audio.rs`: `bus`, `meter.window`, Task 14; Task 15 adds more;
  `memory.rs`: `memory`, Task 20b; `workers.rs`: `workers`, Phase 2; `vram.rs`: `vram`, Task 8; `cover`, `automute`, Phase 3).
  § Command API.
- `src/audio/` — the player audio bus (`bus.rs`) + bus meter (`meter.rs`), `loudness.rs` (scene
  loudness learned on first play and refined on every play, one measurement per path in the `Book` — § Scene
  worker → "Scene loudness"), `Audio` (what
  `serve` runs, `mod.rs`). § Audio bus. `sysmon.rs` — one capture per application playback stream,
  shared by the scene visualiser's system-audio input (Phase 2 Task 7, § Scene worker → "Real scenes")
  and the auto-mute's per-stream meter (Phase 3 Task 14); `foreign.rs` — which streams auto-mute
  counts (ownership, MPRIS matching, Props mute/volume). § Signals → Auto-mute.
- `src/supervise.rs` — the supervisor (`serve` without `--no-supervise`): spawns, waits
  for and restarts the compositor child (Task 16). § Supervisor.
- `src/snapshot.rs` — the persisted state snapshot (`<state>/snapshot.json`, `--restore`)
  + its writer thread (Task 16). § Snapshot.
- `src/outbox.rs` — the backend's outbox (`<state>/outbox.jsonl`, Phase 3 Task 9): the facts the backend must store
  even when it isn't listening, appended where they're logged, read/acked over the API. § Outbox.
- `src/mem.rs` — process memory (`/proc/self/status`, glibc `mallinfo2`/`malloc_info`)
  and the allocator policy `serve` applies first thing (Task 20b). § Memory.
- `src/onset.rs` — invariant #8's one onset helper (`PendingOnset`/`Onsets`: ramp-ins held
  until the source's audio flows, bounded by `ONSET_TIMEOUT`) and the one "can it be heard"
  predicate (`has_audio`, `audible`). § Runtime "Onsets" (final review I6/M12).
- `src/worker/` — Phase 2: the compositor side of the scene worker (`proto.rs` wire
  protocol, `mod.rs` `WorkerHost` lifecycle, `dmabuf.rs` `ImportedRing`/`Latch`).
  `src/bin/liascape-scene-worker/` — the worker binary (second `[[bin]]`; `ring.rs`,
  `synthetic.rs`). `src/scene/` — pure scene helpers (`cover_size`, the synthetic spec,
  `assets.rs` WE's assets dir, `pointer.rs` output → scene coordinates, `pkg.rs` the `scene.pkg` reader,
  `loudness_estimate.rs` the offline loudness estimate — § Scene worker → "Scene loudness" → "Offline estimate").
  `src/sources/scene.rs` — `SceneSource`. `src/gfx/dmabuf.rs` — dmabuf export/import +
  native fences on `Gfx`. `src/bin/liascape-scene-worker/lwe.rs` — LWE's core (feature `lwe`);
  `render.rs` — a real scene in the worker (Task 7); `audio.rs` + `stretch.rs` — the scene's
  sound as a stream on the player bus, time-stretched (Task 6); `gputimer.rs` — per-frame
  `GL_TIME_ELAPSED` (Task 8). `src/scene/budget.rs` — the worker GPU budget (Task 8).
- `src/vram.rs` — VRAM measurement (NVML dlopened / DRM sysfs+fdinfo / `nvidia-smi` / a fake) on
  the `lia-vram` thread and the pure low-VRAM rule (Phase 2 Task 8); `src/probe/vram.rs` — the
  `vram` probe.
  § Scene worker → "GPU budget and VRAM (Task 8)".

**`build.rs`** (Task 10) runs bindgen over `mpv/client.h` + `mpv/render.h` +
`mpv/render_gl.h`, found through pkg-config `mpv` (≥ client API 2.0; this machine has
mpv 0.41 / API 2.5), allowlisting `mpv_.*` functions/types and `MPV_.*` vars. C enums are
generated as **module consts** (`mpv_event_id::MPV_EVENT_FILE_LOADED`), never Rust
`enum`s — a value a newer libmpv adds can't become UB. pkg-config also emits the
`-lmpv` + `-L` that nixpkgs auto-rpaths (same mechanism as `khronos-egl`'s `static`
feature, § GFX / EGL). The flake's `liascape-player` derivation already carries
`rustPlatform.bindgenHook` (libclang) + `pkg-config` + `mpv-unwrapped`, and the devShell
inherits them, so neither needed a change.
