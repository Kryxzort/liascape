# lp-player — Phase 0 (spikes) + Phase 1 (core player) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the two riskiest mechanisms (LWE `next-v2` core rendering into a host framebuffer; GPU frame sharing
between processes on NVIDIA), then build `lp-player`: a single Rust compositor that plays videos, images and colours
on every monitor, with all three transition methods, a generic command API, AI-optimised debug/headless modes, a
player audio bus with a built-in dropout detector, and a backend adapter behind a `PlayerEngine` setting.

**Architecture:** One long-lived process (supervised) owns one wlr-layer-shell surface per output and one desktop-GL
context. Content is a graph of small nodes (Output, Layer, Source, Effect) whose properties are set or animated
through a JSON-lines socket API. A transition is a thin recipe over that API: create B, put A and B under an effect
node, animate `progress` and the gains, remove A. Nothing audible or visible ever moves between processes.

**Tech Stack:** Rust 1.96.1 (edition 2024) · smithay-client-toolkit + calloop (Wayland, event loop) · khronos-egl +
wayland-egl + glow (EGL, desktop GL 3.3 core) · libmpv 0.41 render API via bindgen (`mpv/client.h`,
`mpv/render_gl.h`) · pipewire-rs (audio bus + meter) · serde/serde_json · png · C# .NET 10 (backend adapter) ·
Nix flake + `scripts/install.sh`.

**Spec:** `docs/superpowers/specs/2026-10-20-utopia-player-design.md` (approved 2026-10-20). Executors read both.
Later phases (2 scene worker, 3 programs/signals, 4 web, 5 switch-over, 6 scene compatibility) get their own plans,
written after this one lands and informed by the Task 1–2 findings.

## Global Constraints

- **Invariant:** never hand an audible or visible stream between owners; only ramp gains/opacities on streams that keep running.
- **Gains are dB everywhere inside the player.** Never ramp a percent. mpv edge: `volume-gain` (exact dB), `volume`
  fixed at 100. Measured: `volume=50` → −18.07 dB (cubic); `volume-gain=-6` → −6.02 dB.
- Silent = **−96 dB** (mpv `volume-gain-min`). Crossfades are equal-power: out = cos(x·π/2), in = sin(x·π/2).
- **Audio follows the picture:** a held (paused) side is silent. Any audio start/stop at a hold boundary uses a
  **≤ 30 ms** anti-click gain ramp.
- Transition methods (all three kept; `TransitionMethod` values `full-live` | `reveal` | `frozen`):
  - full-live: both play, equal-power crossfade. On `align:end`, the effect ENDS at A's end.
  - reveal: A held and silent, B live with gain rising sin(x·π/2) over the effect. On `align:end`, the effect
    STARTS at A's end.
  - frozen: A held and B held at its first frame, silent through the effect; B starts playing (30 ms ramp) at the
    end. On `align:end`, the effect STARTS at A's end.
- No reveal-capable-effects gate: every effect works with every method.
- A source frame not ready never blocks presentation; the previous texture is reused.
- **Every setting is a live property** (project rule "settings apply live").
- `PlayerEngine` setting: `"legacy"` (default) | `"lp-player"`. Legacy behaviour must not change.
- Under `lp-player` in Phase 1, **scene items are skipped** exactly like `AllowScenes=false` (scenes arrive in Phase 2).
- Socket: `$XDG_RUNTIME_DIR/livepaper/lp-player.sock`. State: `$XDG_STATE_HOME/livepaper/lp-player/`
  (default `~/.local/state/livepaper/lp-player/`).
- Binary resolution: env `LP_PLAYER_BIN` → `PATH` (`lp-player`) → repo `src/player/target/release/lp-player`.
- Event log: JSON Lines, `events.jsonl` in the state dir, rotated at 20 MiB × 3 files.
- Crate licence: `GPL-3.0-or-later` (lp-player inherits GPL-3.0 from mpvpaper/LWE; the repo-wide LICENSE is still the owner's open item).
- Test media:
  - synthetic clips generated with `ffmpeg` (on PATH), or the SFW Workshop folder
    `~/.local/share/Steam/steamapps/workshop/content/431960`
  - **never** the steamcmd cache
- The owner approved taking over the live wallpaper session for test batteries. Never restart or kill their
  Electron UI. Leave the session in whatever state the tests end in.
- Commit messages: short, Title Case, no trailing period, ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01R12HE7TTJb1JwwG1CDyqqo
  ```
- Build natives with `env -u LD_LIBRARY_PATH nix develop -c …`. This machine's shell can carry a stray
  `LD_LIBRARY_PATH` (alsa-lib vs glibc 2.43) that breaks links.

## Review Focus

1. **A monitor disappears or appears mid-transition** (lid, KVM, DPMS sleep). The transition must finish on the
   remaining outputs, nothing crashes, and a new output immediately shows the current wallpaper. → Task 12 test
   `hotplug_mid_transition`.
2. **Transition target is missing, unreadable or not decodable** (moved file, 0-byte, garbage). A keeps playing
   audibly with no black frame, and an `error` event names the path and the reason. → Task 11 test
   `bad_target_keeps_a`.
3. **Clip shorter than the effect, or `align:end` on an image** (images never end). The short clip holds its last
   frame; `align:end` on an image behaves as `align:now`. → Task 11 tests `short_a_holds_last_frame`,
   `image_align_end_is_now`.
4. **Next spammed (keybind auto-repeat, 10 commands in 1 s).** Each new transition commits the previous one: at most
   2 live sources per output, no paused/parked source left behind, no audio pile-up. → Task 11 test
   `rapid_interrupt_chain`.
5. **Audio server restarts or the default sink changes mid-playback** (headphones swapped). The bus re-targets or is
   re-created, playback continues, and the detector reports `unavailable` for the gap instead of false dropouts.
   → Task 14 test `default_sink_change_retargets`.

---

## Phase 0 — Spikes (throwaway code, durable findings)

### Task 1: Spike — LWE `next-v2` core renders a scene into our framebuffer

**Files:**
- Create: `spikes/lwe-core/README.md`, `spikes/lwe-core/host.cpp`, `spikes/lwe-core/build.sh`
- Create: `docs/player/spikes/lwe-core.md` (findings)

**Interfaces:**
- Consumes: LWE public C API on branch `next-v2` @ `ddea3b4` (`include/linux-wallpaperengine/*.h`):
  - `wp_context_create`, `wp_context_set_gl_proc_address`, `wp_context_set_time_counter`
  - `wp_project_load_folder`, `wp_project_hint_size`, `wp_project_set_output_framebuffer`
  - `wp_render_frame`, `wp_render_update_time`
- Produces: a go/no-go decision plus the exact build recipe consumed by the Phase 2 plan.

- [ ] **Step 1:** Clone `https://github.com/Almamu/linux-wallpaperengine` at `ddea3b4` into `spikes/lwe-core/lwe/` (gitignored). In `build.sh`, build only the `core` library target with CMake inside `env -u LD_LIBRARY_PATH nix develop` (add needed packages ad hoc with `nix shell`; record every one).
- [ ] **Step 2:** Write `host.cpp`. It creates a surfaceless EGL desktop-GL 3.3 core context (`EGL_PLATFORM_SURFACELESS_MESA`, else `EGL_EXT_platform_device`), feeds `eglGetProcAddress` and a monotonic time counter to the context, loads a scene folder, hints 1920×1080, renders 300 frames into an FBO, and writes frames 1, 150 and 300 as PNG.
- [ ] **Step 3:** Run it on 3 scenes from `431960`: the smallest by folder size, the one whose `scene.json` has the most particle objects, and one with an audio-visualiser property. Pass = non-blank PNGs that visibly match each item's `preview.*` and no crash. Record fps, peak RSS and VRAM (`nvidia-smi`).
- [ ] **Step 4:** Probe what the API leaves open and record the answers:
  - how scene audio is produced (SDL device? controllable volume? pause?)
  - whether time can be paused or stepped (fake `wp_time_counter`)
  - whether two projects can live in one process
  - behaviour on a truncated `scene.pkg` (copy a scene, truncate the pkg to 50%)
- [ ] **Step 5:** Write `docs/player/spikes/lwe-core.md`: build recipe and dependencies, per-scene results with PNGs embedded, the Step 4 answers, and a verdict.
  - **GO**: vendor `next-v2`.
  - **NO-GO**: vendor `master` and write the embedding patch ourselves; list the size of that patch.
- [ ] **Step 6:** Commit `spikes/lwe-core/{README.md,host.cpp,build.sh}` and the findings: `git commit -m "Spike: LWE next-v2 Core Offscreen Render"`.

### Task 2: Spike — GPU frame sharing worker → compositor on NVIDIA proprietary

**Files:**
- Create: `spikes/dmabuf/producer.c`, `spikes/dmabuf/consumer.c`, `spikes/dmabuf/Makefile`, `spikes/dmabuf/README.md`
- Create: `docs/player/spikes/dmabuf.md` (findings)

**Interfaces:**
- Produces: the chosen frame-transport mechanism and its measured cost, for the Phase 2 plan.

- [ ] **Step 1:** **producer** (desktop-GL 3.3 EGL, surfaceless) renders 1920×1080 frames into a texture.
  - Encode the frame counter `n` in the pixels: the top-left 64×64 is the colour `(n & 255, (n>>8) & 255, 0)`, and
    the rest is an animated gradient.
  - Export with `eglCreateImage(EGL_GL_TEXTURE_2D_KHR)` + `eglExportDMABUFImageQueryMESA`/`eglExportDMABUFImageMESA`.
  - Create a fence fd with `EGL_ANDROID_native_fence_sync`.
  - Send fd(s), stride, offset, modifier and the fence fd over a unix socket with `SCM_RIGHTS`, using a 3-buffer ring.
- [ ] **Step 2:** **consumer** (wayland layer-shell window on DP-2, desktop GL):
  - import each buffer once with `eglCreateImage(EGL_LINUX_DMA_BUF_EXT)` + `glEGLImageTargetTexture2DOES`
  - per frame: wait on the fence (`eglCreateSync(EGL_SYNC_NATIVE_FENCE_ANDROID)` + `eglWaitSync`), draw the texture
    fullscreen, read back the 64×64 corner and check that `n` is monotonic
- [ ] **Step 3:** Measure for 60 s at 144 Hz: delivered fps, dropped/out-of-order `n`, consumer CPU %, producer CPU %, latency (producer timestamp → consumer present). Pass = ≥ 143 fps, 0 out-of-order frames, < 5% CPU each.
- [ ] **Step 4:** Measure the fallbacks the same way: (a) the same transport with `glFinish` in the producer instead of fences; (b) CPU copy (`glReadPixels` → memfd shared memory → `glTexSubImage2D`).
- [ ] **Step 5:** Write `docs/player/spikes/dmabuf.md`: extension availability (`eglQueryString` dumps), the measurements table, and the chosen mechanism. If none passes, the design §12 fallback "raise with owner" applies; state that explicitly.
- [ ] **Step 6:** Commit: `git commit -m "Spike: dmabuf Frame Sharing on NVIDIA"`.

---

## Phase 1 — lp-player core

### File map (Rust crate `src/player/`, one responsibility per file)

| File | Responsibility |
|---|---|
| `Cargo.toml`, `build.rs` | crate manifest; bindgen over `mpv/client.h` + `mpv/render_gl.h` via pkg-config `mpv` |
| `src/main.rs` | CLI: `serve [--headless --outputs WxH@HZ,… --clock real|stepped]`, `ctl <cmd> [json]`, `--version` |
| `src/lib.rs` | module wiring |
| `src/log.rs` | JSONL event log, correlation ids, ring buffer for the `logs` query, rotation |
| `src/units.rs` | dB/linear math, equal-power pair, gain-slot sum, edge conversions |
| `src/clock.rs` | `Clock` trait, `MonoClock`, `SteppedClock`, `OutputClock` (pausable) |
| `src/anim.rs` | `Curve`, `Animation`, `Animator` |
| `src/graph/mod.rs` | node store, ids, aliases, `state` snapshot |
| `src/graph/props.rs` | property schema per node kind (type, range, live), typed set/get, `ApiError` |
| `src/gfx/egl.rs` | EGL display/context (desktop GL 3.3 core), window and offscreen targets |
| `src/gfx/gl.rs` | texture/FBO/shader helpers on `glow`, PNG readback |
| `src/gfx/effects.rs` | effect catalogue: `transitions/manifest.json` + `glsl/*.glsl`, header rewrite, uniform binding |
| `src/gfx/compose.rs` | per-output frame: layer transforms (fill/fit/stretch/crop/viewport), opacity, effect pass |
| `src/mpv/{mod.rs,ffi.rs}` | safe libmpv wrapper: handle, properties, commands, events, render context |
| `src/sources/{mod.rs,mpv.rs,color.rs}` | `Source` trait; libmpv video/image source; solid colour |
| `src/recipes/transition.rs` | transition recipe (methods, align, interrupt, completion) |
| `src/api/{proto.rs,server.rs,handlers.rs}` | wire types; unix-socket JSON-lines server + subscriptions; dispatch |
| `src/wl.rs` | sctk: outputs + hotplug, one layer surface per output, frame callbacks, pointer region |
| `src/headless.rs` | virtual outputs, stepped rendering, capture |
| `src/audio/{bus.rs,meter.rs}` | player audio bus (PipeWire loopback sink); bus-monitor 1 ms RMS ring |
| `src/probe/{dropout.rs,frames.rs}` | reference-based dropout detector; frame-timing stats |
| `src/supervise.rs`, `src/snapshot.rs` | supervisor restart loop; debounced state snapshot + restore |
| `src/runtime.rs` | calloop loop wiring all of the above |
| `tests/common/mod.rs` | headless harness + synthetic media (`ensure_clip`) |
| `tests/*.rs` | integration tests named per task |

C# adapter (backend): `src/livepaper/Player/{PlayerEngine.cs,LpPlayerClient.cs,LpPlayerMedia.cs,MpvPropertyMap.cs}`.

---

### Task 3: Crate scaffold, flake/devShell, event log

**Files:**
- Create: `src/player/Cargo.toml`, `src/player/build.rs`, `src/player/src/{main.rs,lib.rs,log.rs}`, `src/player/.gitignore` (`target/`)
- Modify: `flake.nix`: new `lp-player` package (`rustPlatform.buildRustPackage`, `cargoLock.lockFile = ./src/player/Cargo.lock`, `nativeBuildInputs = [ pkg-config rustPlatform.bindgenHook ]`, `buildInputs = [ mpv-unwrapped wayland libGL libxkbcommon pipewire ]`); add it to `packages`; add `cargo rustc clippy rustfmt rust-analyzer` and `inputsFrom = [ … lp-player ]` to the devShell
- Modify: `scripts/dev.sh`: `cargo build --release --manifest-path src/player/Cargo.toml` next to the native `make`s
- Create: `.claude/rules/player-core.md` (frontmatter `paths: ["src/player/**"]`): purpose, the invariant, module map; later tasks append their sections

**Interfaces:**
- Produces:
  - `log::init(dir: &Path, level: Level) -> io::Result<()>`
  - `log::event(comp: &'static str, level: Level, kind: &str, corr: Option<CorrId>, fields: serde_json::Value)`
  - `pub struct CorrId(pub String)`; `log::new_corr(prefix: &str) -> CorrId` (format `"<prefix>-<n>"`, e.g. `"tr-12"`)
  - `log::recent(filter: &LogFilter, limit: usize) -> Vec<serde_json::Value>`
  - `enum Level { Error, Warn, Info, Debug, Trace }`
  - `struct LogFilter { comp: Option<String>, corr: Option<String>, min_level: Level, kind_prefix: Option<String> }`
  - Line schema: `{"t_mono_ms":f64,"t_wall":"RFC3339","comp":str,"level":str,"kind":str,"corr":str|null, …fields}`

- [ ] **Step 1: Write the failing tests.** In `log.rs`:
  - `line_schema`: an emitted event parses as JSON with exactly the keys above plus its fields, and `t_mono_ms` is monotonic across two events
  - `recent_filters_by_corr`: 3 events with `corr` a/b/a → `recent(corr=a)` returns 2 in order
  - `rotates_at_20_mib`: writing 21 MiB yields `events.jsonl` + `events.1.jsonl`, and at most 3 files exist
- [ ] **Step 2:** Run `cd src/player && cargo test log::` → FAIL (module missing).
- [ ] **Step 3:** Implement `log.rs`: a buffered writer behind a `Mutex`, a ring of the last 10 000 events in memory, and size-checked rotation.
- [ ] **Step 4:** Run `cargo test log::` → PASS. Run `env -u LD_LIBRARY_PATH nix build .#lp-player` → builds (binary prints `--version`).
- [ ] **Step 5:** Commit: `git commit -m "lp-player: Scaffold Crate, Flake Package, Event Log"`.

### Task 4: Units — dB, equal-power, gain slots, edge conversions

**Files:**
- Create: `src/player/src/units.rs`
- Create: `docs/player/invariants.md` (numbered; this task adds #1 "never hand off an audible stream", #2 "gains are dB; never ramp a percent", #3 "silent = −96 dB", #4 "≤ 30 ms anti-click ramp at hold boundaries", each with *why* + *enforced by*)

**Interfaces:**
- Produces:
  - `pub const SILENT_DB: f64 = -96.0;`
  - `pub fn db_to_lin(db: f64) -> f64` (amplitude)
  - `pub fn lin_to_db(lin: f64) -> f64` (≤ 1e-5 → `SILENT_DB`)
  - `pub fn equal_power(x: f64) -> (f64, f64)` (out, in) linear
  - `pub enum GainSlot { User, Override, Normalize, Mute, AutoMute, Xfade, AntiClick }`; string forms (property
    paths `gain.<slot>`, JSON) are the lowercase names `user, override, normalize, mute, automute, xfade, anticlick`
  - `pub struct Gains(BTreeMap<GainSlot, f64>)` with `set(slot, db)`, `effective_db() -> f64` (sum, clamped to `[SILENT_DB, 12.0]`)
  - `pub fn mpv_volume_gain(db: f64) -> f64` (clamp to [−96, 12])
  - `pub fn pulse_volume_from_db(db: f64) -> u32` (= `round(65536 · cbrt(db_to_lin(db)))`)

- [ ] **Step 1: Write failing tests:**
  - `equal_power_mid`: `equal_power(0.5)` → both `0.70710678 ± 1e-8`, and `lin_to_db` of each is `−3.0103 ± 1e-4`
  - `equal_power_sums_to_unity_power`: Σ(out²+in²) = 1 ± 1e-12 for x ∈ {0, 0.1, …, 1}
  - `gains_sum`: User −6 + Normalize −4.5 + Xfade −3.0103 → `−13.5103 ± 1e-4`; Mute at −96 dominates → `−96.0`
  - `pulse_cubic`: `pulse_volume_from_db(-18.0618)` → `32768 ± 1`; `pulse_volume_from_db(0.0)` → `65536`
  - `mpv_clamp`: `mpv_volume_gain(-200.0) == -96.0`; `mpv_volume_gain(20.0) == 12.0`
- [ ] **Step 2:** `cargo test units::` → FAIL.
- [ ] **Step 3:** Implement `units.rs`.
- [ ] **Step 4:** `cargo test units::` → PASS.
- [ ] **Step 5:** Commit: `git commit -m "lp-player: dB Units, Equal-Power Gains, Edge Conversions"`.

### Task 5: Clocks and Animator

**Files:**
- Create: `src/player/src/clock.rs`, `src/player/src/anim.rs`

**Interfaces:**
- Consumes: `units::{db_to_lin, lin_to_db}`
- Produces:
  - `pub trait Clock { fn now(&self) -> Duration; }`
  - `MonoClock::new()`; `SteppedClock::new()` with `step(&self, d: Duration)`
  - `OutputClock::new(base: Rc<dyn Clock>)` with `pause()`, `resume()`, `is_paused()`, `now()`; paused time does not advance
  - `pub enum Curve { Linear, Smoothstep, EqualPowerOut, EqualPowerIn, Step }` with `fn eval(&self, x: f64) -> f64`; x is clamped to [0, 1]
  - `pub struct PropPath(pub String)` (e.g. `"src7.gain.xfade"`, `"fx2.progress"`)
  - `pub enum AnimUnit { Scalar, GainLinear }`: GainLinear targets receive dB via `lin_to_db` of the curve value
  - `pub struct Animation { pub target: PropPath, pub from: f64, pub to: f64, pub start: Duration, pub duration: Duration, pub curve: Curve, pub unit: AnimUnit, pub corr: Option<CorrId> }`
  - `pub struct AnimId(pub u64)`; `Animator::add(a) -> AnimId`, `cancel(id)`, `cancel_target(&PropPath)`
  - `tick(now) -> Vec<(PropPath, f64)>` (values to apply; finished animations emit their final value exactly once)
  - `finished() -> Vec<(AnimId, Option<CorrId>)>` (drained)
  - `value_at(&PropPath, t: Duration) -> Option<f64>` (used by the dropout probe)

- [ ] **Step 1: Write failing tests:**
  - `stepped_clock`: steps of 16 ms ×3 → `now()` = 48 ms
  - `output_clock_pause`: pause at 100 ms, base steps 50 ms, `now()` stays 100 ms; resume, step 10 → 110 ms
  - `curves`: `Smoothstep.eval(0.5)=0.5`; `EqualPowerIn.eval(0.5)=0.70710678`; `Linear.eval(1.7)=1.0`
  - `animator_gain_linear`: an EqualPowerIn GainLinear anim from 0 to 1 over 5000 ms → at 2500 ms emits `−3.0103 ± 1e-3` dB; at 0 ms emits `SILENT_DB`
  - `final_value_once`: after the end, `tick` emits the target value once and `finished()` returns its id
  - `cancel_target_replaces`: a second `add` on the same target after `cancel_target` → only the new one emits
- [ ] **Step 2:** `cargo test clock:: anim::` → FAIL.
- [ ] **Step 3:** Implement both.
- [ ] **Step 4:** `cargo test clock:: anim::` → PASS.
- [ ] **Step 5:** Commit: `git commit -m "lp-player: Clocks and Animator"`.

### Task 6: Node graph, property schema, errors, state snapshot

**Files:**
- Create: `src/player/src/graph/mod.rs`, `src/player/src/graph/props.rs`
- Modify: `.claude/rules/player-core.md` (section "Graph & properties": the id scheme and the alias rules)

**Interfaces:**
- Consumes: `units::Gains`, `anim::PropPath`
- Produces:
  - `pub enum NodeKind { Player, Output, Layer, Source, Effect }`
    - `Player` is a singleton with id `player`
  - `pub enum Fit { Fill, Fit, Stretch, Crop }` (serde lowercase)
  - `pub enum PropValue { Bool(bool), F64(f64), I64(i64), Str(String), List(Vec<f64>), Map(serde_json::Map<String, serde_json::Value>) }`
  - `pub struct ApiError { pub code: &'static str, pub message: String, pub hint: String }`
    - codes: `"no_such_node"`, `"no_such_prop"`, `"bad_type"`, `"out_of_range"`, `"read_only"`, `"unsupported"`, `"io"`
    - `hint` names the doc anchor or the `ctl` command to inspect
  - `Graph::create(kind, id: Option<String>, props: serde_json::Map) -> Result<String, ApiError>`
    - ids: outputs `out:<connector>`; auto ids `src<n>` / `lay<n>` / `fx<n>`
  - `Graph::destroy(id)`, `set(&PropPath, PropValue)`, `get(&PropPath) -> Result<PropValue, ApiError>`
  - `Graph::resolve(alias) -> Vec<String>`
    - `out:*` → all outputs
    - `lay:<connector>:main` → that output's auto-created main layer; `lay:*:main` → every main layer
    - `cur:<connector>` / `cur:*` → the source currently shown by the main layer(s)
  - `Graph::snapshot() -> serde_json::Value`: every node with every property, plus gains per slot in dB
  - Property schemas (initial):
    - **Player**: `debug` (bool, default false; enables the automatic probes); `version`, `pid` (read-only)
    - **Output**: `name`, `width`, `height`, `refresh_hz` (read-only); `layer` (`"background"|"bottom"`, default `"background"`); `paused` (bool)
    - **Layer**: `output`, `content` (node id), `fit` (`"fill"|"fit"|"stretch"|"crop"`, default `"fill"`), `viewport` (`[x,y,w,h]` normalised, default `[0,0,1,1]`), `opacity` (0..1)
    - **Source** common: `kind` (`"video"|"image"|"color"`), `path`, `paused`, `speed` (0.1–4.0), `loop`, `position` (seek, s), `gain.<slot>` (dB), `color` (`[r,g,b]`); read-only: `ready`, `duration`, `time_pos`, `width`, `height`
    - **Source** video-only: `hwdec`, `fps_cap` (0 = native), `cache`, `demuxer_max_mib`, `demuxer_back_mib`, `af`, `no_audio`, `audio_delay` (s)
    - **Effect**: `effect_id`, `from`, `to` (node ids), `progress` (0..1), `params` (map)

- [ ] **Step 1: Write failing tests:**
  - `create_and_alias`: create `out:DP-1` and `out:DP-2` → `resolve("out:*")` = both; `lay:DP-1:main` exists
  - `set_get_typed`: `set src1.speed 1.5` ok; `set src1.speed "fast"` → `bad_type`; `set src1.speed 9` → `out_of_range` with a hint mentioning `0.1–4.0`
  - `read_only`: `set src1.duration 3` → `read_only`
  - `cur_alias_follows_layer`: layer content `src1` → `resolve("cur:DP-1") == ["src1"]`; after `set lay:DP-1:main.content src2` → `["src2"]`
  - `snapshot_roundtrip`: `snapshot()` contains every set property with its value; gains appear as `{"user":-6.0,…}`
- [ ] **Step 2:** `cargo test graph::` → FAIL.
- [ ] **Step 3:** Implement. Property application to live sources is a hook the source registers (Task 10); here schema + storage only.
- [ ] **Step 4:** `cargo test graph::` → PASS.
- [ ] **Step 5:** Commit: `git commit -m "lp-player: Node Graph, Property Schema, State Snapshot"`.

### Task 7: EGL/GL core and offscreen targets

**Files:**
- Create: `src/player/src/gfx/egl.rs`, `src/player/src/gfx/gl.rs`
- Create: `src/player/tests/common/mod.rs` (`fn headless_gl() -> Option<Gfx>`, which returns `None` when no EGL device so tests can `return` early with a printed SKIP; `fn read_rgba(gfx, tex, x, y) -> [u8;4]`)
- Create: `src/player/tests/gfx_basic.rs`

**Interfaces:**
- Produces:
  - `pub struct Gfx { pub gl: glow::Context, … }`
  - `Gfx::new_offscreen() -> Result<Gfx, String>`: surfaceless EGL (`EGL_PLATFORM_SURFACELESS_MESA`, else `EGL_EXT_platform_device`), `eglBindAPI(EGL_OPENGL_API)`, core 3.3
  - `Gfx::new_wayland(display_ptr) -> Result<Gfx, String>`
  - `Gfx::window_target(wl_surface_ptr, w, h) -> WindowTarget` with `resize`, `make_current`, `swap`
  - `pub struct Tex { pub id: glow::Texture, pub w: u32, pub h: u32 }`; `Gfx::tex(w,h) -> Tex`; `Gfx::fbo(&Tex) -> Fbo`
  - `Gfx::program(vs, fs) -> Result<glow::Program, String>` (error includes the info log)
  - `Gfx::write_png(&Tex, path) -> io::Result<()>`

- [ ] **Step 1: Write the failing test** `clear_readback`: clear a 64×64 FBO to (255,0,0,255) → `read_rgba` at (10,10) = `[255,0,0,255]`; `write_png` writes a decodable 64×64 PNG.
- [ ] **Step 2:** `cargo test --test gfx_basic` → FAIL.
- [ ] **Step 3:** Implement. Set `GL_TEXTURE_MIN_FILTER/MAG_FILTER = LINEAR`, `WRAP = CLAMP_TO_EDGE` on all textures.
- [ ] **Step 4:** `cargo test --test gfx_basic` → PASS on the owner's machine (NVIDIA).
- [ ] **Step 5:** Commit: `git commit -m "lp-player: EGL Desktop-GL Core + Offscreen Targets"`.

### Task 8: Effect catalogue (all 122 effects under desktop GL)

**Files:**
- Create: `src/player/src/gfx/effects.rs`, `src/player/tests/effects_all.rs`

**Interfaces:**
- Consumes: `Gfx::program`
- Produces:
  - `pub struct Catalogue { … }`
  - `Catalogue::load(dir: &Path) -> Result<Catalogue, String>`
    - dir = `LP_TRANSITIONS_DIR` → `~/.local/share/livepaper-web/transitions` → repo `transitions/`
  - `Catalogue::ids() -> Vec<String>`
  - `Catalogue::program(&Gfx, id) -> Result<&EffectProgram, String>` (lazy compile + cache)
  - `EffectProgram::draw(&Gfx, from: &Tex, to: &Tex, progress: f64, ratio: f64, params: &serde_json::Map)`
    - params fall back to the manifest `uniforms[].default`
    - uniform types `bool | float | int | ivec2 | vec2 | vec3 | vec4`
  - Shader assembly:
    - read `wrap.vert` / `wrap.frag.template`
    - replace the first line `#version 300 es` with `#version 330 core`
    - delete the `precision highp float;` line
    - substitute `//<<BODY>>` with `glsl/<id>.glsl`
    - the vertex shader draws a fullscreen triangle with `gl_VertexID`, so bind an empty VAO

- [ ] **Step 1: Write failing tests:**
  - `all_compile`: every id in `manifest.json` (122) compiles + links; failures are listed by id with their info log
  - `fade_midpoint`: `fade` with from = solid (255,0,0), to = solid (0,0,255), progress 0.5 → centre pixel `(127±2, 0, 127±2)`
  - `defaults_applied`: the first manifest entry with non-empty `uniforms` renders without GL errors using only the manifest defaults
- [ ] **Step 2:** `cargo test --test effects_all` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cargo test --test effects_all` → PASS (122/122).
- [ ] **Step 5:** Commit: `git commit -m "lp-player: Effect Catalogue on Desktop GL"`.

### Task 9: Composition — layer transforms, opacity, effect pass

**Files:**
- Create: `src/player/src/gfx/compose.rs`, `src/player/tests/compose.rs`

**Interfaces:**
- Consumes: `Gfx`, `Tex`, `Catalogue`, `Graph` (layer/effect props)
- Produces:
  - `pub struct UvRect { pub uv: [f64;4] /* x,y,w,h in source texture */, pub dst: [f64;4] /* x,y,w,h in output px */ }`
  - `pub fn fit_rect(src: (u32,u32), dst: (u32,u32), fit: Fit, viewport: [f64;4]) -> UvRect` (pure)
  - `pub fn compose_output(gfx, graph, cat, output_id, textures: &dyn Fn(&str) -> Option<&Tex>, target: &Fbo)`: draws the output's main layer
    - layer content = source → draw transformed
    - content = effect → transform `from`/`to` into two output-sized intermediates, then `EffectProgram::draw`
    - apply opacity; a missing texture means the previous frame for that node, else transparent
  - `fit` semantics:
    - `fill` covers the output, cropping the excess (= mpv `panscan=1.0`)
    - `fit` contains with black bars (= `panscan=0.0`)
    - `stretch` ignores aspect
    - `crop` uses the source pixels 1:1, centred
    - `viewport` selects a normalised sub-rectangle of the *source* before fitting (span: DP-1 `[0,0,0.5,1]`, DP-2 `[0.5,0,0.5,1]`)

- [ ] **Step 1: Write failing tests** (unit tests of `fit_rect` + pixel tests):
  - `fit_letterbox`: source 1920×800 into 1920×1080 with `fit` → bars of 140 px top and bottom; pixel (960,70) = black, (960,540) = source
  - `fill_crops`: source 1920×800, `fill` → the uv rect horizontally crops 1080/800 scaling (uv.x span = 0.7407 ± 1e-3)
  - `span_halves`: a 2-colour source (left red, right blue) spanned → DP-1 centre red, DP-2 centre blue
  - `opacity_half`: a red layer at opacity 0.5 over black → (127±2,0,0)
- [ ] **Step 2:** `cargo test --test compose` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cargo test --test compose` → PASS.
- [ ] **Step 5:** Commit: `git commit -m "lp-player: Layer Transforms, Opacity, Effect Pass"`.

### Task 10: Sources — libmpv video/image, colour

**Files:**
- Create: `src/player/src/mpv/{mod.rs,ffi.rs}`, `src/player/src/sources/{mod.rs,mpv.rs,color.rs}`, `src/player/tests/sources.rs`
- Modify: `src/player/tests/common/mod.rs`: add `ensure_clip(name: &str, spec: ClipSpec) -> PathBuf`, which generates into `target/test-media/` with ffmpeg once. Clip specs:
  - `ClipSpec::Solid { rgb, secs, tone_hz, tone_dbfs }`: 1920×1080 @ 30 fps, stereo 48 kHz sine
  - `ClipSpec::FrameIndex { frames }`: frame n has the top-left 64×64 = `(n,n,n)`, for frame-exact checks
  - `ClipSpec::Image { rgb }` (PNG)
- Modify: `.claude/rules/player-core.md` (section "Sources": the libmpv gotchas)

**Interfaces:**
- Consumes: `Gfx`, `Tex`, `units::{Gains, mpv_volume_gain}`, graph property schema (Task 6)
- Produces:
  - `pub trait Source`:
    - `kind() -> &'static str`
    - `update(&mut self, gfx: &Gfx) -> bool` (renders a new frame if mpv signals one; never blocks)
    - `texture() -> Option<&Tex>` (last good frame persists)
    - `size() -> (u32,u32)`
    - `apply(&mut self, prop: &str, v: &PropValue) -> Result<(), ApiError>`
    - `read(&self, prop) -> Option<PropValue>`
    - `poll_events(&mut self) -> Vec<SourceEvent>`
  - `pub enum SourceEvent { Ready, Ended, Position(f64), Error { reason: String } }`
  - `MpvSource::open(gfx, path, opts: &serde_json::Map) -> Result<MpvSource, ApiError>`
  - `ColorSource::new(rgb)`
  - mpv setup (fixed):
    - `vo=libmpv`, `config=no`, `terminal=no`, `keep-open=yes`, `volume=100`
    - `volume-gain` = effective gains dB; `volume-gain-min=-96`
    - `image-display-duration=inf` for images
    - `ao` = `pipewire` with `audio-device` = the bus device when the bus exists (Task 14), else default
    - render at native size: `dwidth`/`dheight`, capped at 4096
  - Property map:
    - `loop` → `loop-file` (`inf`/`no`)
    - `paused` → `pause`
    - `speed` → `speed`
    - `position` → `seek <t> absolute exact`
    - `hwdec` → `hwdec`
    - `fps_cap` → `vf` (`fps=<n>` or empty)
    - `cache` → `cache`
    - `demuxer_max_mib` / `demuxer_back_mib` → `demuxer-max-bytes` / `demuxer-max-back-bytes` (`<n>MiB`)
    - `af` → `af`
    - `no_audio` → `aid` (`no` / `auto`; `auto` re-inits the AO even after a no-audio start)
    - `audio_delay` → `audio-delay`
  - Free the render context with its GL context current (lp-transition gotcha).
  - **Fence-leak mitigation (adopted from mpvpaper 1.9, PR #132, credited in Task 19):** the `get_proc_address`
    handed to `mpv_render_context_create` returns a stub for `glFenceSync` that returns 0, so libmpv never
    accumulates sync objects. This is safe here: the frame is sampled in the same context that rendered it.

- [ ] **Step 1: Write failing tests:**
  - `first_frame_and_ready`: Solid red 2 s → within 3 s `Ready` arrives and the texture centre is (255±3,0,0)
  - `frame_exact_seek`: FrameIndex 120, `paused=true`, `position=2.0` (frame 60 at 30 fps) → corner = (60±1,60±1,60±1)
  - `ended_holds_last_frame`: Solid blue 1 s, `loop=false` → `Ended` arrives and the texture stays blue (keep-open)
  - `gain_maps_to_volume_gain`: set `gain.user=-6`, `gain.xfade=-3.0103` → mpv `volume-gain` reads `−9.0103 ± 1e-3`; `volume` stays 100
  - `image_source`: Image green → Ready + green; `duration` reads as unset and no `Ended` arrives within 2 s
  - `no_audio_live`: `no_audio=true` then `false` → mpv `aid` goes `no` → `auto` and audio-params become set again
- [ ] **Step 2:** `cargo test --test sources` → FAIL.
- [ ] **Step 3:** Implement.
  - `build.rs`: bindgen with `allowlist_function("mpv_.*")`, `allowlist_type("mpv_.*")`.
  - Wakeups: `mpv_set_wakeup_callback` writes to an eventfd that the runtime polls (Task 12); tests poll directly.
- [ ] **Step 4:** `cargo test --test sources` → PASS.
- [ ] **Step 5:** Commit: `git commit -m "lp-player: libmpv Video/Image Sources + Colour Source"`.

### Task 11: Transition recipe (three methods, align, interrupt, failures)

**Files:**
- Create: `src/player/src/recipes/transition.rs`, `src/player/tests/transition.rs`
- Modify: `docs/player/invariants.md` (add #5 "audio follows the picture", #6 "a new transition commits the in-flight one: never park, never stack")

**Interfaces:**
- Consumes: `Graph`, `Animator`, `Curve`, `AnimUnit`, `Source`/`SourceEvent`, `units::SILENT_DB`, `log::new_corr`
- Produces:
  - `pub enum Method { FullLive, Reveal, Frozen }` (serde `"full-live"|"reveal"|"frozen"`)
  - `pub enum Align { Now, End }`
  - `pub struct TransitionReq { pub outputs: String /* alias */, pub to: serde_json::Map /* source create props incl. path */, pub effect_id: Option<String> /* None = cut */, pub params: serde_json::Map, pub duration_ms: u32, pub method: Method, pub align: Align }`
  - `Transitions::start(&mut self, req, graph, anim, now) -> Result<CorrId, ApiError>`
  - `Transitions::cancel(corr)`
  - `Transitions::tick(&mut self, graph, anim, sources_events, now)`
  - Events emitted (via `log::event` and API subscriptions):
    - `transition.scheduled`, `transition.started {method, effect_id}`
    - `transition.handoff`: B is now `cur:`, and A's removal is scheduled
    - `transition.done`, `transition.cancelled {reason}`, `transition.failed {path, reason}`
  - Recipe (per the Global Constraints):
    1. Create B paused at 0 with `gain.xfade = SILENT_DB`, shared by all outputs in `outputs`.
    2. Wait for B's `Ready`. On `Error` → `transition.failed`; A untouched.
    3. Wait for the start instant:
       - `Now` → immediately
       - `End` + full-live → when A's remaining / speed == duration
       - `End` + reveal/frozen → A's `Ended`
       - `End` on an image A → treated as `Now`
       - while waiting for `End`, A gets `loop=false`
    4. Create effect `fx` (`from = A`, `to = B`); point each output's main layer content at `fx`.
    5. Per method:
       - **full-live**: unpause B; animate `fx.progress` 0→1 (Linear); `A.gain.xfade` EqualPowerOut; `B.gain.xfade` EqualPowerIn (GainLinear)
       - **reveal**: ramp `A.gain.anticlick` 0→SILENT over 30 ms, then pause A; unpause B; `B.gain.xfade` EqualPowerIn; animate progress
       - **frozen**: ramp-and-pause A as in reveal; B stays paused; animate progress; at the end unpause B with a 30 ms `B.gain.anticlick` ramp SILENT→0 (B's `xfade` set to 0 dB)
    6. On progress = 1: point layer content at B (`transition.handoff`), destroy fx, destroy A after its gain is at SILENT.
       - `effect_id = None` → steps 4–5 collapse to: 30 ms ramp down A, 30 ms ramp up B, swap.
         With `End`: B is unpaused on A's `Ended`, with no ramp on A (it has already ended) and a 30 ms ramp-in on B.
    7. **Interrupt**: `start` while one is in flight on the same outputs → commit the in-flight one immediately.
       - B → current (unpause if held; its xfade → 0 dB over 30 ms; A ramped to SILENT over 30 ms then destroyed)
       - then proceed with the new request from B

- [ ] **Step 1: Write failing tests** (headless `SteppedClock`, 1 virtual output 640×360, synthetic clips):
  - `full_live_gains`: duration 1000 ms; at 500 ms `A.gain.xfade = −3.0103 ± 0.01`, `B.gain.xfade = −3.0103 ± 0.01`, `fx.progress = 0.5 ± 0.01`; at 1000 ms+ `cur:* = B`, A destroyed
  - `reveal_holds_a_silent`: A = FrameIndex; at 100 ms A is paused, its corner value is constant across 10 steps, `A.gain` effective ≤ −90 dB; B unpaused with gain rising
  - `frozen_silent_then_b_starts`: during the effect A and B are both paused with effective gains ≤ −90 dB; B's corner = frame 0; after the end B advances and its gain reaches 0 dB within 30 ms
  - `align_end_full_live`: A = Solid 3 s, effect 1000 ms → `fx.progress` reaches 1 at A's end ± 1 frame (33 ms)
  - `align_end_reveal_starts_at_end`: same, reveal → `transition.started` at A's `Ended` ± 1 frame, and A's held frame = its last frame
  - `short_a_holds_last_frame`: A = 0.5 s, full-live 2000 ms `End` → starts immediately; A holds its last frame; no rewind (corner never decreases)
  - `image_align_end_is_now`: A = Image, `End` → `transition.started` within one tick of `start`
  - `bad_target_keeps_a`: `to.path` = nonexistent, then a 0-byte file → `transition.failed` with the path and the reason; `cur:*` still A, A's gain unchanged, A unpaused
  - `rapid_interrupt_chain`: 10 `start`s 100 ms apart → after each tick ≤ 2 live sources, 0 paused sources outside an active held method, and the final `cur:*` is the 10th target
  - `cut_without_effect`: `effect_id = None` → swap completes in ≤ 60 ms with no source above SILENT besides the current
  - `handoff_no_seam`: full-live with B = FrameIndex → B's corner index is non-decreasing and advances by 1 ± 1 per
    30 fps frame across the handoff step. B is the same source before and after, so there is no seam to match.
- [ ] **Step 2:** `cargo test --test transition` → FAIL.
- [ ] **Step 3:** Implement `recipes/transition.rs` as a state machine (`Scheduled → WaitingReady → WaitingStart → Running → Handoff → Done`) that only issues graph `set`/`animate`/`create`/`destroy`; no special-case rendering.
- [ ] **Step 4:** `cargo test --test transition` → PASS.
- [ ] **Step 5:** Commit: `git commit -m "lp-player: Transition Recipe — Three Methods, Align, Interrupt"`.

### Task 12: Runtime, command API, `ctl`, headless serve

**Files:**
- Create: `src/player/src/runtime.rs`, `src/player/src/headless.rs`, `src/player/src/api/{proto.rs,server.rs,handlers.rs}`, `src/player/src/ctl.rs`, `src/player/tests/api.rs`
- Modify: `src/player/src/main.rs` (subcommands), `.claude/rules/player-core.md` (section "Command API": the full verb list + examples)

**Interfaces:**
- Consumes: everything above.
- Produces — wire protocol (JSON lines over the socket):
  - request `{"id":N,"cmd":"<verb>","args":{…}}` → `{"id":N,"ok":true,"result":…}` | `{"id":N,"ok":false,"error":{"code","message","hint"}}`
  - event (subscribed connections) `{"event":"<kind>","corr":…,"t_mono_ms":…, …}`
  - verbs:
    - `hello` → `{version, pid /* compositor process */, capabilities:["video","image","color","transition","headless"?]}`
    - `create {kind,id?,props}`, `destroy {id}`, `set {path,value}`, `get {path}`
    - `animate {path,to,duration_ms,curve,from?,unit?}`
    - `transition {…TransitionReq}` → `{corr}`, `cancel {corr}`
    - `state`, `subscribe {topics:[prefix…]}`, `capture {target,path}`
    - `logs {comp?,corr?,min_level?,kind_prefix?,limit?}`, `probe {name,args}`
    - `stop` (destroy all sources, unmap surfaces), `quit`, `step {ms}` (headless + stepped clock only)
    - headless only: `headless.add_output {name,width,height,hz}`, `headless.remove_output {name}`
    - headless outputs are named `VIRTUAL-1`, `VIRTUAL-2`, … in `--outputs` order
  - `ctl`: `lp-player ctl <verb> ['<json args>']` prints the JSON result; `ctl subscribe <prefix…>` streams events until interrupted.
  - Runtime: one calloop loop.
    - sources: the Wayland fd, the listening socket + clients, mpv wakeup eventfds, a timer at the max output refresh driving `Animator::tick` + `Transitions::tick`
    - per-output render on its frame callback (headless: on `step`)
  - Headless: `serve --headless --outputs 1920x1080@60[,…] --clock real|stepped`.
    - Stepped mode: before rendering each step, every video source is paused and `seek <clock_t> absolute exact`-ed, so frames are deterministic.

- [ ] **Step 1: Write failing tests** (spawn `lp-player serve --headless --outputs 640x360@60,320x180@60 --clock stepped` with a temp `XDG_RUNTIME_DIR`/`XDG_STATE_HOME`):
  - `hello_and_state`: `hello.capabilities` ⊇ {video, image, color, transition, headless}; `state` lists both outputs
  - `error_shape`: `set nope.x 1` → `ok:false`, `code:"no_such_node"`, non-empty hint
  - `color_capture`: create colour (0,255,0) → set `lay:*:main.content` → `step 16` → `capture out:VIRTUAL-1 /tmp/x.png` → centre pixel green
  - `transition_events_in_order`: subscribe `transition.` → transition colour→colour 200 ms → events scheduled, started, handoff, done, in order, all with the same corr
  - `logs_by_corr`: `logs {corr}` returns that transition's events only
  - `hotplug_mid_transition`: during a 500 ms transition, remove `VIRTUAL-2` (headless verb `headless.remove_output`) → `transition.done` still arrives and `VIRTUAL-1` shows B; then add `VIRTUAL-3` → `cur:VIRTUAL-3` = B within one step
- [ ] **Step 2:** `cargo test --test api` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cargo test --test api` → PASS; `cargo clippy -- -D warnings` clean.
- [ ] **Step 5:** Commit: `git commit -m "lp-player: Runtime, Command API, ctl, Headless Serve"`.

### Task 13: Wayland outputs (on-machine)

**Files:**
- Create: `src/player/src/wl.rs`
- Modify: `src/player/src/runtime.rs` (window outputs), `.claude/rules/player-core.md` (section "Wayland")

**Interfaces:**
- Consumes: `Gfx::new_wayland`, `Gfx::window_target`, `Graph` outputs
- Produces:
  - One `zwlr_layer_surface_v1` per `wl_output`:
    - layer from `out:<c>.layer`; anchored to all edges; exclusive zone −1; keyboard interactivity none
    - input region = whole surface (pointer accepted; pointer events are logged as `input.pointer` and stored as `out:<c>.pointer` `[x,y,buttons]` for Phase 2)
  - Outputs appear and disappear with the registry (hotplug): new outputs get a main layer whose content = the current `cur:*` of the first output (same-wallpaper default).
  - Present on each output's frame callback, at its own refresh. Output names come from `wl_output` v4 `name`.

- [ ] **Step 1: Write the failing check** (shell script `src/player/tests/onmachine/outputs.sh`, run manually):
  - `lp-player serve &`
  - `ctl state` lists `out:DP-1` (refresh_hz 144) and `out:DP-2` (240)
  - set a red colour on DP-1 and blue on DP-2 via `lay:<c>:main.content`
  - `grim -o DP-1 -` / `-o DP-2 -` centre pixels = red / blue
  - the probe `frames` reports mean present interval 6.9 ± 0.5 ms on DP-1 and 4.2 ± 0.5 ms on DP-2
  - Exit 0 = pass.
- [ ] **Step 2:** Run it → FAIL (no Wayland outputs yet).
- [ ] **Step 3:** Implement `wl.rs` (sctk `LayerShell`, `OutputState`, `SeatState` pointer) and the frame-timing probe `src/probe/frames.rs` (rolling present intervals per output; `probe {name:"frames"}`).
- [ ] **Step 4:** Run `outputs.sh` → PASS. Also verify on-machine: unplugging is not practical, so use Hyprland `hyprctl keyword monitor DP-1,disable` then `…,preferred,auto,1` → the output disappears and reappears without a player crash and comes back showing the current wallpaper.
- [ ] **Step 5:** Commit: `git commit -m "lp-player: Wayland Layer-Shell Outputs, Hotplug, Frame Probe"`.

### Task 14: Player audio bus + bus meter

**Files:**
- Create: `src/player/src/audio/{bus.rs,meter.rs}`, `src/player/tests/onmachine/bus.sh`
- Modify: `src/player/src/sources/mpv.rs` (target the bus device; apply `audio_delay` = −bus latency)

**Interfaces:**
- Produces:
  - `Bus::create() -> Result<Bus, String>`:
    - via pipewire-rs, load `libpipewire-module-loopback` in-process with
      `capture.props = { media.class = Audio/Sink, node.name = lp-player-bus, node.description = "lp-player bus", audio.position = [FL FR] }`
      and `playback.props = { node.target = <current default sink> }`
    - watch `default.audio.sink` metadata and re-target playback on change
    - the loopback's playback stream gets an unmistakable identity: `node.name = lp-player-bus.playback`,
      `application.name = lp-player`, `media.role = Wallpaper`. Today's `AudioMonitor` must exclude it (Task 17),
      otherwise auto-mute hears the wallpaper's own audio and oscillates.
  - `Bus::device() -> String` (mpv `audio-device` value)
  - `Bus::latency() -> Duration` (measured once at creation with an impulse; logged)
  - `Bus::state() -> BusState { Up, Retargeting, Down }` (events `audio.bus.*`)
  - `Meter::start(bus) -> Meter`: captures the bus monitor at 48 kHz float with a 10 ms quantum; keeps a 4-minute ring of `(t_mono, dbfs_1ms)`
  - `Meter::window(from, to) -> Vec<(Duration, f64)>`, `Meter::available() -> bool`
  - Fallback: `Bus::create` error → sources use the default device; the meter is unavailable; `audio.bus.down {reason}` is logged.

- [ ] **Step 1: Write the failing check** `bus.sh`:
  - start `serve`; play Solid 440 Hz −20 dBFS
  - `pactl list sinks short` contains `lp-player-bus`
  - `pw-link -l` shows the bus playback port linked to the default sink
  - `probe {name:"meter.window", args:{last_ms:1000}}` median within −23 ± 3 dBFS (sine RMS = peak − 3 dB)
  - `default_sink_change_retargets`: `pactl set-default-sink <other sink>` → within 1 s the bus links to the new sink, the meter keeps producing (no gap > 50 ms), and `audio.bus.retargeting` → `audio.bus.up` events appear; set the default back
- [ ] **Step 2:** Run `bus.sh` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `bus.sh` → PASS. Record `Bus::latency()` in the commit message; it must be ≤ 1 PipeWire quantum + 5 ms, otherwise stop and raise it before continuing.
- [ ] **Step 5:** Commit: `git commit -m "lp-player: Player Audio Bus + Bus Meter"`.

### Task 15: Reference-based dropout detector

**Files:**
- Create: `src/player/src/probe/dropout.rs`, `src/player/tests/dropout.rs`
- Create: `scripts/lp_audiowatch.py` (the proven external monitor from 2026-10-20, moved from the session scratchpad, with ffmpeg resolved from PATH; reference implementation and legacy-engine monitor)
- Modify: `docs/player/debugging.md` (create; symptom → probe/log query → likely cause, seeded with the 2026-10-20 findings: cubic sag, speed-step hiccup, ready-timeout silence, parked pause)

**Interfaces:**
- Consumes: `Meter::window`, `Animator::value_at`, the transition corr ids and the source positions logged at `transition.started`
- Produces:
  - `pub fn analyse(observed: &[(Duration,f64)], expected: &[(Duration,f64)]) -> DropoutReport`
  - `pub struct DropoutReport { pub lag_ms: u32, pub fit_db: f64, pub offset_db: f64, pub drops: Vec<Drop>, pub micro_gaps: Vec<Drop> }`
  - `pub struct Drop { pub at_ms: i64 /* rel. effect start */, pub len_ms: u32, pub under_db: f64 }`
  - `pub fn expected_envelope(src_paths_and_positions, gain_schedule, window) -> Vec<(Duration,f64)>`
    - decode with `ffmpeg -ss <pos> -t <len> -i <path> -vn -ac 1 -ar 48000 -f f32le -` into 10 ms power bins
    - multiply by db_to_lin(gain)² per source per bin and sum
  - Algorithm (port of `lp_audiowatch.py`):
    - 10 ms bins
    - lag search 0–250 ms in 10 ms steps, minimising the median absolute dB error over bins where expected > −60 dB
    - offset = median(observed − expected)
    - **drops**: runs of 10 ms bins with expected + offset > −55 and observed < expected + offset − 15
    - **micro_gaps**: runs ≥ 2 ms of 1 ms observed values < expected(10 ms bin) + offset − 35 where expected + offset > −45
  - The probe runs automatically after every `transition.done` when debug mode is on (`serve --debug`, or `set player.debug true`) and emits `probe.dropout {corr, report}`.

- [ ] **Step 1: Write failing unit tests** with synthetic envelopes:
  - `clean_crossfade`: observed = expected with a 30 ms lag → `lag_ms=30`, `fit_db < 0.5`, no drops
  - `injected_4ms_gap`: zero 4 ms of observed at +130 ms in loud content (−25 dB) → exactly 1 micro_gap, `len_ms=4`
  - `content_silence_not_flagged`: expected has 300 ms at −140 dB (silent content) and observed is silent there → no drops/gaps
  - `held_method_silence_not_flagged`: the frozen-method schedule (both gains SILENT during the effect) and observed silent → no drops
  - `big_hole`: observed silent 446 ms where expected −20 dB → 1 drop of ~440–450 ms
- [ ] **Step 2:** `cargo test --test dropout` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cargo test --test dropout` → PASS.
- [ ] **Step 5:** Commit: `git commit -m "lp-player: Reference-Based Dropout Detector"`.

### Task 16: Supervisor + state snapshot/restore

**Files:**
- Create: `src/player/src/supervise.rs`, `src/player/src/snapshot.rs`, `src/player/tests/supervise.rs`

**Interfaces:**
- Produces:
  - `serve` forks:
    - parent = supervisor; it restarts the child within ≤ 1 s after an abnormal exit, passing `--restore`
    - give up after 5 restarts in 60 s with `supervisor.giving_up`
    - a clean exit (`quit`/`stop`) is not restarted
  - Snapshot:
    - debounced 250 ms after any property change, plus on clean exit
    - written to `<state>/snapshot.json`: outputs' main-layer content, sources (kind, path, position, paused, speed, loop, gains per slot, per-source props), output props
    - transient nodes (effects, in-flight transitions) are excluded; a transition in flight is restored as its target B
  - `--restore` recreates from the snapshot and seeks to the saved positions.

- [ ] **Step 1: Write the failing test** `crash_restores` (headless, real clock):
  - play FrameIndex at position 2.0, wait 300 ms
  - `kill -SEGV` the child pid (`hello.result.pid`)
  - within 1.5 s `hello` answers again with a new pid
  - `state` shows the same path, and position ≥ 2.0
  - `supervisor.restart` logged with the signal
- [ ] **Step 2:** `cargo test --test supervise` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cargo test --test supervise` → PASS.
- [ ] **Step 5:** Commit: `git commit -m "lp-player: Supervisor Restart + Snapshot Restore"`.

### Task 17: Backend adapter behind `PlayerEngine` (C#)

**Files:**
- Create: `src/livepaper/Player/PlayerEngine.cs`, `LpPlayerClient.cs`, `LpPlayerMedia.cs`, `MpvPropertyMap.cs`
- Modify: `src/livepaper/Models/AppSettings.cs` (`public string PlayerEngine { get; set; } = "legacy";`)
- Modify: `src/livepaper/Helpers/PlayerHelper.cs` — dispatch at the media primitives only:
  - `SwitchToFile` (l. 1070), `Launch` (l. 2826), `SendCommand` (l. 2542), `TrySendCommand`
  - `TryQueryCurrentPath`, `TryQueryTimePos` (l. 1862), `TryQueryProperty` (l. 1833), `TryQueryTimeRemaining` (l. 1884)
  - `KillCurrentProcess` (l. 2944), `KillAll` (l. 3042), `TogglePause` (l. 2515)
  - the V→V transitions-on branch of `DoVideoEndWait`
  - scene checks at l. 705, 736, 1011, 1149 and `IsSkippedPath` (l. 3071) → `PlayerEngine.ScenesPlayable(settings)`
- Modify: `src/livepaper/Helpers/AudioMonitor.cs` (`GetNonMpvStreamIdsAsync`: exclude the lp-player bus playback stream)
- Modify: `src/livepaper/Helpers/TransitionService.cs`: extract `public static (string effectId, Dictionary<string,double[]> uniforms, int durationMs, string method)? Pick(Config cfg)` from `TryStart` (reuses `PickEffect`/`PickDuration`; no capture work)
- Modify: `src/livepaper/Web/ServerHost.cs` (`/settings`: a `PlayerEngine` change → `PlayerHelper.SwitchEngineLive(prev, cur)` = stop the old engine, replay `LastSession` on the new one)
- Modify: `src/livepaper/Program.cs`: hidden `--lp-player-selftest` (runs `MpvPropertyMap` assertions + a protocol round-trip against `lp-player serve --headless`, prints `PASS`/`FAIL <reason>`, exits 0/1)
- Modify: `app/ui/src/views/Settings.tsx` (advanced row "Player engine": Legacy / lp-player (experimental)), `app/ui/src/store/index.ts` (default `playerEngine: "legacy"`)
- Create: `.claude/rules/player-adapter.md` (`paths: ["src/livepaper/Player/**"]`): the dispatch points, the property map, the event flow

**Interfaces:**
- Consumes: lp-player wire protocol (Task 12), `TransitionReq` fields (Task 11)
- Produces:
  - `PlayerEngine.IsLpPlayer` (from settings, cached and refreshed on `/settings`), `PlayerEngine.ScenesPlayable(AppSettings s) => s.AllowScenes && PlayerHelper.IsLweAvailable() && !IsLpPlayer`, `PlayerEngine.ResolveBinary()`
  - `LpPlayerClient`:
    - `EnsureRunning()`: connect, or `setsid lp-player serve` and wait ≤ 3 s for the socket
    - `Task<JsonElement> Call(string cmd, object args, int timeoutMs = 2000)`
    - `event Action<string kind, JsonElement e> Event` (background reader on a subscribed connection to `transition.`, `source.`, `supervisor.`)
  - `LpPlayerMedia`:
    - `Switch(string path, AppSettings s, TransitionService.Config? tcfg, bool alignEnd)` → `transition { outputs:"out:*", to:{path, props from s + per-item overrides}, effect from Pick(tcfg) or null, method, align }`
    - `Task<bool> SwitchAndWaitHandoff(…, CancellationToken)` (completes on `transition.handoff` / false on cancel/fail)
    - `Stop()`, `Set(string prop, object value)` (targets `cur:*`), `double? Query(string prop)`, `string? CurrentPath()`
  - `MpvPropertyMap.Translate(object[] mpvArgs) -> (string prop, object value)?`:
    - volume / speed / mute / pause / loop-file / panscan (→ layer `fit`) / vf fps / hwdec / cache / demuxer-max-bytes / demuxer-max-back-bytes / af / aid (→ `no_audio`)
    - **volume N → `gain.user` = 60·log10(N/100) dB** (= the cubic curve users are used to; N = 50 → −18.06 dB); N = 0 → −96
    - unknown → `null` + a log line
  - `DoVideoEndWait` under lp-player:
    - **both** V→V branches (transitions on, and the transitions-off gapless-append branch) become
      `await LpPlayerMedia.SwitchAndWaitHandoff(next, …, tcfg: transitionsOn ? cfg : null, alignEnd:true, ct)`, then
      the existing `lock { … PostSwitch(next); }`
    - Cancel → `cancel {corr}`.
    - The `_lastSwitchTarget` settle gate (commit `27b9591`) is legacy-only; under lp-player the handoff event replaces it.
  - `AudioMonitor` (legacy auto-mute, still used in Phase 1): `GetNonMpvStreamIdsAsync` also skips streams whose
    `node.name` starts with `lp-player-bus` or whose `application.name` is `lp-player`.

- [ ] **Step 1: Write the failing self-test** (`--lp-player-selftest`):
  - `MpvPropertyMap` assertions: `volume 50` → `gain.user = −18.0618 ± 1e-3`; `volume 100` → 0; `panscan 0.0` → `fit:"fit"`; `aid no` → `no_audio:true`
  - round-trip: `hello`; a `transition` colour→clip with `align:now` receives `transition.handoff`
- [ ] **Step 2:** Run `dotnet run --project src/livepaper -- --lp-player-selftest` → FAIL.
- [ ] **Step 3:** Implement the four classes + dispatch + UI row. Legacy branches stay byte-for-byte when `!IsLpPlayer`.
- [ ] **Step 4:** Self-test → PASS. Then on-machine with `PlayerEngine=lp-player` via `curl -X POST /settings`:
  - `/apply` a clip; `/next` in the owner's `dp` playlist
  - timed interval 20 s with `WaitForVideoEnd` + `AdvanceOnVideoEnd` (the owner's settings)
  - live `/settings` changes of Volume, Speed, Loop, VideoScale, VideoFps, HwDec, NoAudio, NormalizeAudio; mute toggle; pause toggle; `--action=volume-up`
  - each takes effect on the playing wallpaper without a restart (`ctl state` confirms)
  - switching back to `legacy` restores today's behaviour
  - `automute_ignores_own_bus`: `AutoMute=true`, delay 0, a clip playing for 30 s → no `SetMute(true)`, and the
    wallpaper stays audible on the meter; then `paplay` a 1 kHz tone (another app) → the wallpaper is muted, and
    unmutes after `AutoUnmuteDelayMs` once it stops
- [ ] **Step 5:** Commit: `git commit -m "Backend: lp-player Adapter Behind PlayerEngine Setting"`.

### Task 18: Packaging — install.sh + flake wrappers

**Files:**
- Modify: `scripts/install.sh`:
  - preflight requires `cargo`/`rustc` (per-distro install hint, hard fail)
  - `cargo build --release --locked --manifest-path src/player/Cargo.toml`
  - install `lp-player` to `~/.local/share/livepaper-web/bin/` and export `LP_PLAYER_BIN` in both wrappers
- Modify: `flake.nix`: `--set LP_PLAYER_BIN ${lp-player}/bin/lp-player` in the `livepaper-ui` and `livepaper-cli` wrappers
- Modify: `.claude/rules/distribution.md` (lp-player build + resolution order)

**Interfaces:**
- Consumes: Task 3 package.

- [ ] **Step 1: Write the failing check:** `nix build .#default` then `grep LP_PLAYER_BIN result/bin/livepaper-ui` → no match (FAIL).
- [ ] **Step 2:** Implement both files.
- [ ] **Step 3:** Verify:
  - `env -u LD_LIBRARY_PATH nix build .#default` succeeds
  - the grep finds `LP_PLAYER_BIN` in both wrappers
  - `result/bin/livepaper-cli --lp-player-selftest` prints `PASS`
  - `bash -n scripts/install.sh` passes
  - with `PATH` lacking cargo, `install.sh` exits non-zero with the hint
- [ ] **Step 4:** Commit: `git commit -m "Packaging: Build and Wire lp-player"`.

### Task 19: Documentation + generated credits

**Files:**
- Create: `docs/player/architecture.md` (the block model, process model, recipes, data flow from backend → API → graph → compose; the invariant first; the Phase roadmap)
- Create: `UPSTREAM.md`:
  - mpvpaper: URL, last reviewed commit `fc5ed28` (2026-08-28), the techniques adopted (layer-shell per output, layer choice, auto-pause idea for Phase 3, the `glFenceSync` stub from 1.9 / PR #132 by manv-3, adopted in Task 10)
  - LWE: placeholder section "vendored in Phase 2 at `next-v2` — see `docs/player/spikes/lwe-core.md`"
- Create: `scripts/gen-credits.py`: reads `patches/*/*.patch` headers (`From:`, `Upstream-PR:`/`Upstream-Commit:`, `Origin:`, subject) and the `UPSTREAM.md` "adopted techniques" tables → writes `CREDITS.md`; `--check` exits 1 when `CREDITS.md` differs
- Create: `CREDITS.md` (generated; currently the mpvpaper techniques section only)
- Modify: `CLAUDE.md`: architecture tree gains `src/player/` + `docs/player/`; the CLI/engine note; a pointer to `docs/TODO.md`
- Modify: `docs/TODO.md`: tick "Approve the lp-player design"; tick "Commit lp_audiowatch.py" (done in Task 15)

- [ ] **Step 1: Write the failing check:** `python3 scripts/gen-credits.py --check` → exit 1 (no CREDITS.md yet).
- [ ] **Step 2:** Write the docs + generator + generate `CREDITS.md`.
- [ ] **Step 3:** Verify: `gen-credits.py --check` exits 0; every `paths:` glob in `.claude/rules/player-*.md` matches at least one file (`python3 -c` glob check); `docs/player/*.md` link targets exist.
- [ ] **Step 4:** Commit: `git commit -m "Docs: lp-player Architecture, Upstream, Generated Credits"`.

### Task 20: Phase 1 on-machine battery + report

**Files:**
- Create: `src/player/tests/onmachine/battery.sh` (drives the backend over HTTP with `PlayerEngine=lp-player`; collects `probe.dropout` events and frame probes)
- Create: `docs/player/reports/phase1.md`

**Interfaces:**
- Consumes: the adapter (Task 17), probes (Tasks 13, 15), the owner's `dp` playlist and the `431960` videos/images.

- [ ] **Step 1:** Write `battery.sh`. For each method ∈ {full-live, reveal, frozen} × each mode ∈ {manual `/next`, `/prev`, timed interval, advance-on-end, wait-for-end, `/random`, `--restore` replay, `/next` mid-transition}:
  - ≥ 50 switches, alternating video and image targets, with some clips shorter than the effect
  - record every `probe.dropout` report and the frame-probe stats
  - stop on the first failure, with that transition's `logs {corr}` dumped
- [ ] **Step 2:** Run the battery on the live session (owner-approved). Pass:
  - **0 drops and 0 micro-gaps** in all runs, except the silence that held methods intend (which the detector already excludes)
  - frame present intervals within ±0.5 ms of refresh on both outputs
  - no `transition.failed` except injected ones
- [ ] **Step 3:** Per-monitor capability check via `ctl` only: a different clip on DP-1 and DP-2, a transition on `out:DP-1` alone → DP-2's frames and audio unaffected (frame probe + meter), and a span of one clip across both.
- [ ] **Step 4:** 1-hour soak with the owner's playlist: RSS and VRAM sampled every 60 s, slope < 1 MiB/min after the first 5 min. (The 8 h soak is the Phase 5 switch-over bar.)
- [ ] **Step 5:** Write `docs/player/reports/phase1.md` (tables per method × mode, failures found and fixed, soak curve). Tick the Phase 1 items in `docs/TODO.md`. Commit: `git commit -m "lp-player: Phase 1 Battery Report"`.
