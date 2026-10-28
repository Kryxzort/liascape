# lp-player — Phase 2 (scene worker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WE scenes play under `PlayerEngine=lp-player`: LWE's `next-v2` core runs in an isolated worker process
per scene source, hands the compositor GPU frames over dmabuf + `sync_file`, owns its audio as a dB gain on a
stream that keeps running, survives crashes without touching anything else, and composes with every transition
method and switch combo (V↔S, S↔S).

**Architecture:** A `scene` kind joins the graph's `Source` schema. `SourceHost` opens it as a `SceneSource`, which
drives one `lp-scene-worker` child over a `SOCK_SEQPACKET` socketpair: the compositor sends `Tick {t}` frame
requests (its own scene clock, so pause and stepped mode are exact), the worker renders the LWE project into a
3-slot ring of exported `GL_RGBA8` textures and answers `Frame {slot}` + an acquire fence. The compositor latches
only frames whose fence already signalled, samples them like any other source texture, and returns a release
fence. Scene audio leaves the worker on its own PipeWire stream to the player bus, gained in dB by the
compositor's `Gain` pushes. The transition recipe, aliases, snapshot and adapter stay kind-agnostic; only the
places that hard-code `kind == "video"` learn about `scene`.

**Tech Stack:** Rust 1.96 (edition 2024, the existing `lp-player` crate + a second binary `lp-scene-worker`) ·
LWE `next-v2` core (C++20, CMake, its C API `include/linux-wallpaperengine/*.h`) · EGL
`EGL_MESA_image_dma_buf_export` / `EGL_EXT_image_dma_buf_import_modifiers` / `EGL_ANDROID_native_fence_sync` ·
pipewire-rs 0.10 · C# .NET 10 (adapter) · Nix flake + `scripts/install.sh`.

**Spec:** `docs/superpowers/specs/2026-10-20-utopia-player-design.md` (§4.1, §4.3, §5.2, §5.3, §6.1, §6.3, §10,
§11, §12). Evidence it argues from: `docs/player/spikes/lwe-core.md`, `docs/player/spikes/dmabuf.md`. What Phase 1
built: `.claude/rules/player-core.md`, `.claude/rules/player-adapter.md`. Executors read all of these.

---

## Decisions for the owner

**Decided by the owner, 2026-10-27** (interview):
- **D1 shared worker** · **D2 Rust** · **D5 30 fps** · **D6 skip unless whitelisted** — as recommended.
- **D3 a fork on the owner's GitHub** (`Kryxzort/linux-wallpaperengine`): our patches are commits on a branch there,
  the build fetches the fork by hash. Survives upstream deleting anything; patches stay PR-able upstream. Task 1
  changes: `third_party/lwe/PIN` names the fork + commit; `patches/lwe/` is generated from the fork branch
  (`git format-patch`) so `CREDITS.md`/`tests/credits.rs` keep working. Creating the fork is an outward action — ask
  the owner right before doing it.
- **D4 exactly like Wallpaper Engine**: WE always listens to all system audio (Windows can't tell programs apart —
  help.wallpaperengine.io/en/audio/limittomusicplayer.html), which includes a wallpaper's own sound; that's why some
  wallpapers seemed to react only to themselves. So: the default sink's monitor. Build the visualiser input as a mix
  of PipeWire streams (not one opaque monitor capture) so a **future per-app white/blacklist** for visualisers can
  plug in.
- **D7 both**: the synthetic renderer for exact/repeatable checks (crash on command, timing, every switch combo), AND
  matrix/IT cells that play real SFW scenes from `~/.local/share/Steam/steamapps/workshop/content/431960` with the
  owner's installed WE `assets/` whenever WE is installed (skipped, with a printed reason, when it isn't).

**Decided, round 2 (scene behaviour)** — each changes or adds to the tasks below; executors apply these over the
task text where they differ:
- **Speed: animation AND audio**, pitch-corrected (not 1× like WE). The scene clock (`Tick {t}`) advances at
  `speed`; the host audio driver (Task 2's patch / Task 6) time-stretches the scene's PCM pitch-preserving (a
  scaletempo/WSOLA stage in the worker's pull path, bit-exact passthrough at 1×). A live `speed` set retimes both;
  align:end uses it like a video's. Scenes still never emit `Ended`. **+M task.**
- **Mouse interaction on** (as planned, Task 7).
- **Scene properties editor IN Phase 2**: read each scene's `project.json` `general.properties` (types: color,
  slider, bool, combo, text, …), show them in the item settings modal, apply live (`wp_project_property_set_*`
  through the worker protocol), persist per item in the library index (`LibMeta`), re-applied at every open. Matrix
  cells for set → live → persisted → survives a switch/restart. **+L task** (backend + worker + UI).
  **Done (2026-10-28)** — the worker side was Task 7's `scene_props`; this added the rest
  (`.claude/rules/library.md` § "Scene properties", `player-adapter.md` § Scenes, `web-backend.md`, `web-ui.md`):
  `Helpers/SceneProperties.cs` (parse — order/index, types, HTML/`ui_*` labels —, coerce/encode, a JS-subset
  `condition` evaluator), `LibMeta.SceneProps` (WE encoding, field-level, == default dropped), `GET/POST
  /library/scene-props` + `/preview` (the drag twin), `scene_props` as a per-source value of the R61 resolver (every
  open, Fresh passes incl. R81, live per item; a reset sends the default — LWE has no reset), the modal's "Scene
  properties" (`ScenePropsEditor.tsx`), legacy `--set-property` at LWE's launch. **Deviations:** legacy is
  launch-only (LWE has no live property IPC) — the modal says so; `scenetexture`/`file`/`directory` (a file picker)
  and `usershortcut` (Windows launchers) are listed, not editable; a refused property (`scene.property` ok:false)
  only logs; a multi-selection hides the section (each scene has its own set); the synthetic renderer gained a `color`
  property (WE's 0–1 colour → `rgb`) so hermetic tests see the editor's encoding on a pixel (the one player change).
  Tests: self-test `ScenePropertyAssertions` (a fixture of the corpus's odd cases + all 96 real scenes: 2066
  properties, 868 conditions — RED first: 9 failures, the order rule, a default below its slider's min, conditions
  with `a. value` and `ds+media.value`), adapter IT § scene properties (RED on the base backend: 15 failing, the rest
  175 pass; GREEN 189/0), matrix `sceneProp:set|switch|restart|reset` (RED on the base backend + UI: 2 fail + 2
  error; GREEN 4/4). Full matrix (`--changed lp-player`, every cell — central files changed, `--jobs 2`, 33 min, load
  5–9 with other agents' runs): 748 pass / 1 fail / 2 error / 29 skip — `playlist × stripVol:other`,
  `globalDragVol`, `globalDragSpd` (a Settings slider "not found" / an override not saved in time), each passing 2/2
  alone (load). `test-settings-merge.sh` 53/0, `--lp-player-selftest` PASS.
- **Install: hard-fail with per-distro package lines**, `--no-scenes` to build without (as planned).
- **GPU budget = a setting, default auto-throttle**: on missed compositor frames attributable to a scene, lower that
  scene's fps stepwise, restore when it recovers (logged; `probe`); the setting turns it off (fixed fps).
  **Plus a VRAM guard** (toggle + limit in MiB): a scene worker whose VRAM use exceeds the limit is stopped —
  per-process VRAM from NVIDIA's per-process accounting (NVML / `nvidia-smi --query-compute-apps`) or
  `/proc/<pid>/fdinfo` `drm-memory-vram` on AMD/Intel; then playback behaves like a broken scene (advance / preview)
  but it is NOT marked crashed — the UI says "stopped: used X MiB > limit Y". **+M task** (folds into Task 8).
- **Loudness: learn on first play**: measure a scene's integrated loudness over its first ~60 s of play (from the
  worker's stream on the bus), store it in the index like a video's `loudness*`, apply normalization from then on.
  **+M task.**
  **Done (2026-10-28)** (`.claude/rules/player-core.md` § Scene worker → "Scene loudness", `player-adapter.md` §
  Scenes → "Loudness", `library.md` § Loudness). The player measures, the backend stores + applies (the video path's
  split). Worker: `audio::loudness::SegmentMeter` K-weights the scene's sound after the stretch, **before the gate
  and the gain**, only for buffers that really played it (not paused / `no_audio` / a fade-out / the PipeWire-down
  fallback) → `FromWorker::Loudness {segments}` per 100 ms (`PROTOCOL` 3). Compositor: a `Learner` per
  `SceneSource` (kept across worker restarts) — BS.1770-4 400 ms blocks, absolute −70 / relative −10 gates —
  emits `scene.loudness {id, path, lufs, peak_dbfs, seconds, played_s, complete, window_s}` once 60 s of AUDIBLE
  play are in (`LP_PLAYER_LOUDNESS_WINDOW_S`), or at the source's end with ≥ a third of the window (`complete:
  false`). Backend: subscribed; `LibraryService.MergeSceneLoudness` → `loudnessI`/`loudnessTP` (sample peak)/
  `loudnessSeconds`/`loudnessPartial`, learned once (a partial until a complete one or a longer partial); the
  resolver's per-source `gain.normalize` = `NormalizeTargetLufs − I`, the sample peak kept ≤ −1.5 dBFS, clamped
  −60…+24 dB — set at create, live as a 500 ms `animate` (the moment it's learned, a target change, on/off).
  **Deviations / judgement calls:** not "from the worker's stream on the bus" literally (the bus mixes every source)
  nor from the `SceneEnvelopes` track (1 ms max-channel RMS, no K-weighting): from the worker's own pre-gain samples
  — the same stream, K-weighted; the window is *audible* play (silence, pauses and mutes don't count — a mostly
  silent scene takes longer); a partial needs a third of the window (else the next play starts afresh — no
  cross-play accumulation of blocks); the peak is the sample peak (no true-peak oversampling); NoAudio doesn't
  zero `gain.normalize`; every play re-measures (cheap: two biquads per channel) and the backend keeps the first
  complete result; legacy LWE scenes stay unnormalized; no matrix cell (the IT covers it — the matrix player has
  no short-window knob). Tests: units `audio::loudness` ×6 (RED by mutation: no K-weighting + no gates → 5 fail),
  worker `loudness_segments_count_only_played_sound`, api ×5 (RED: 5/5 fail before), self-test
  `SceneLoudnessAssertions`, adapter IT § scene loudness (RED on the base backend: 13 failing, the rest 193 pass;
  GREEN 204/0). Crate suite: default 1 fail (`transport_meets_the_spike_budget`, worker CPU 7.6 % at load ~10 — a
  soundless scene, no loudness code runs; passes alone), `LP_PLAYER_RENDER_WORKER=off` all pass;
  `test-settings-merge.sh` 53/0; `--lp-player-selftest` PASS; matrix (`--changed` → full, `--jobs 2`, 32 min)
  751 pass / 0 fail / 0 error / 29 skip.
- **Broken scene while playing in a rotation: advance to the next item at once** (single wallpaper: keep its last
  frame / preview, silent).

- **VRAM, round 3** (owner, after checking WE on Windows): WE has an (undocumented) "Pause when VRAM is exhausted";
  ours, in one Settings group, two parts: (1) **when the GPU's VRAM runs low: Pause / Stop (free memory) / Off,
  default Stop** — system-wide (a game filled it), measured from free VRAM (NVML / `mem_info_vram_*` sysfs on
  AMD, fdinfo totals), with hysteresis + a hold time so it never flaps (WE's version false-fires under light load per
  a Steam report); it applies to every source — videos too — and resumes when VRAM is free again; (2) the
  **per-scene VRAM limit** above: off by default, ~1.5 GB suggested when enabled. Folds into Task 8 (+M).

Revised size: the original 15 tasks + 4 (speed, properties, VRAM guard/budget setting, loudness learning).

The original recommendations follow for reference.

1. **D1 — Same scene on several outputs:** one worker per scene source, shared by every output showing it (like videos). **Recommend this.** Spec §4.3 says one worker per output; that doubles GPU/VRAM and needs per-output plumbing (+1 L task) for little isolation gain.
2. **D2 — Worker language:** Rust binary `lp-scene-worker` in the lp-player crate, calling LWE's C API. **Recommend this.** Alternative: C++ (spec §13's note).
3. **D3 — LWE source:** pin + fetch at build (`third_party/lwe/PIN`, patches in `patches/lwe/`). **Recommend this.** Alternative: the spec's verbatim `third_party/lwe/` tree (~125 MB with submodules).
4. **D4 — Visualiser input:** the default sink's monitor (system audio, as LWE's frontend and WE do). **Recommend this.** Alternative: the player bus (wallpaper audio only, spike §6).
5. **D5 — Scene fps for an output with no `LweMonitors` entry:** 30 (LWE's default). **Recommend this.** Alternative: the output's refresh.
6. **D6 — Crashed scenes:** skip a scene marked crashed unless whitelisted (what the UI already promises; nothing enforces it today). **Recommend this.** Alternative: report only.
7. **D7 — Hermetic test scene:** the worker's synthetic renderer behind a test-only gate; real LWE is covered on-machine with `431960` scenes. **Recommend this.** (WE's `assets/` are proprietary, so no real scene renders hermetically.)

| # | why the recommendation | if you pick the alternative |
|---|---|---|
| D1 | Every output shows the same scene until the per-monitor follow-up project; a scene bug crashes every instance of it anyway, so per-output workers buy little isolation. One worker halves GPU time and VRAM (Bunk: 538 MiB per instance, spike §3) — the GPU budget is this phase's top risk. Animation stays in sync across monitors. Per-monitor fps survives as a per-output present gate (Task 8). Real per-monitor wallpapers later are simply two sources = two workers. | Add **Task 5b (L)**: `SourceHost::texture_on(id, output)`, per-(A, output) snapshots and effects in `build_sides`, a primary-output audio rule (`IsPrimary`), and Task 8's gate becomes per-instance fps. |
| D2 | One wire protocol as shared Rust types (`worker::proto`), reuses `gfx::egl`, `log`, `units`, pipewire-rs; LWE's API is plain C (~25 calls + ours), no C++ needed outside the patches. The compositor binary never links LWE (`rustc-link-arg-bin` targets the worker only). | Worker becomes `src/player-workers/scene/` (C++, CMake); `worker::proto` is mirrored in a C header and a protocol test checks both encodings. +~1 day. |
| D3 | Spec §7's goals (mechanical rebases, credited patches) hold; the repo doesn't grow by ~125 MB of glslang/SPIRV-Cross/json/Catch2 sources. The flake fetch is hash-pinned; `install.sh` already needs network (npm, dotnet). | Task 1 commits the tree via `scripts/lwe.sh vendor` instead of `fetch`; the flake uses `./third_party/lwe`. Same patches. |
| D4 | WE and LWE's own frontend (`frontend/.../Pulseaudio.cpp`: "output monitor" of the default sink) feed visualisers system audio, so bars move with your music. | `audio::sysmon` taps the bus monitor instead; bars react to wallpaper audio only. |
| D5 | LWE's own default and `LweMonitorSettings.Fps`'s default; the UI pre-fills listed monitors with their refresh anyway. | Schema default of `out:<c>.scene_fps` becomes 0 (= refresh). |
| D6 | `LibrarySettingsModal` shows "Scene crashed — won't be played" + a whitelist box, but `MarkCrashed` has no caller and nothing skips. Inert for legacy (nothing marks there). | `source.broken` only marks + notifies; `IsSkippedPath` unchanged. |
| D7 | Every real scene needs WE's `assets/shaders/*`; CI/sandbox has none. Task 1 Step 6 still checks whether an assets-free scene renders; if one does it becomes a second fixture. | Hermetic tests cover only protocol/lifecycle; all rendering tests become on-machine. |

---

## Global Constraints

- **Invariant:** never hand an audible or visible stream between owners; only ramp gains/opacities on streams that
  keep running. A scene worker's audio stream is opened silent and closed only after it was ramped to −96 dB.
- Gains are dB everywhere; silent = **−96 dB**; equal-power crossfades (cos/sin); **≤ 30 ms** anti-click ramps at
  hold boundaries; audio follows the picture (a held side is silent). Invariants #1–#8 (`docs/player/invariants.md`)
  apply to scene sources unchanged.
- **Frames from workers (spec §5.2, verbatim decisions):** dmabuf + `sync_file` fences in both directions; the
  compositor latches **only the newest frame whose fence has already signalled** and never `eglWaitSync`s on an
  unsignalled worker fence; a frame not ready → reuse the previous one, never block, never black. Fallback when
  fences are unavailable: the worker waits on its **own** `sync_file` (fdpoll). Never `glFinish`; CPU copy is not
  built in Phase 2.
- Ring = **3** `GL_RGBA8` textures, exported once (`eglCreateImage(EGL_GL_TEXTURE_2D)` →
  `eglExportDMABUFImageMESA`), imported once (`EGL_LINUX_DMA_BUF_EXT` + modifier → `glEGLImageTargetTexture2DOES`).
  `{fourcc, modifier}` validated against `eglQueryDmaBufModifiersEXT`; an external-only (LINEAR on NVIDIA) buffer is
  refused with an error naming `docs/player/spikes/dmabuf.md` §1.
- **Crash policy (spec §6.3):** a worker crash or hang keeps that source's last frame (or its preview if none
  arrived); restart **up to 3 times within 60 s**, resuming at the last position; then **broken**: event, persisted
  crash record (scene id, exit signal/code, last 50 log lines), the backend's skip/advance applies. Other outputs,
  videos and audio are never affected.
- **LWE pin:** branch `next-v2`, commit `ddea3b493d2f4cca78a2e9547c4e61b92a14e0fc` (2026-08-03). Our changes live
  only in `patches/lwe/NNNN-*.patch` with `git format-patch` headers + `Origin:` / `Why:` / `Status:` (+
  `Upstream-PR:`/`Upstream-Commit:`/`Adapted-by: livepaper` for imported ones); `CREDITS.md` is regenerated by
  `scripts/gen-credits.py` and `tests/credits.rs` fails when stale.
- **LWE host rules (spike a §6):** pass the assets dir explicitly; render frame 0 into a scratch FBO, then size to
  `wp_project_get_width/height`; `NULL` from load or size ≤ 1 after the first render = broken, never render again;
  `wp_render_update_time` once per frame; core output is y-down = our R25 orientation (**no flip in the worker**);
  alpha is 0 in every core pixel → the worker forces alpha = 1.
- **Build (spec §3):** the scene worker builds by default; `install.sh` hard-fails with per-distro package lines when
  its dependencies are missing unless `--no-scenes`, which hides scenes like `AllowScenes=false`. The flake builds it.
- **Settings apply live:** `LweMonitors` fps becomes the live `out:<c>.scene_fps`; under lp-player it is no longer
  the launch-only exception. Scenes are 1×: `speed`/`loop` and the video-only props are accepted, stored, ignored;
  a scene never emits `Ended`.
- `PlayerEngine` stays `legacy` by default; legacy behaviour must not change.
- **Test media:** synthetic scenes (worker synthetic renderer, D7) and ffmpeg clips, or the SFW Workshop folder
  `~/.local/share/Steam/steamapps/workshop/content/431960`. **Never** the steamcmd cache
  (`~/.cache/livepaper/steamcmd_workshop/…`). Every hermetic test runs `--ao null` or a private PipeWire.
- The synthetic renderer is honoured only when `serve` runs with `LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1`; production
  never sets it.
- The owner approved taking over the live wallpaper session for on-machine batteries; never restart/kill their
  Electron UI or backend; leave the session as the tests end it; never print `/settings` (Steam token).
- Build natives with `env -u LD_LIBRARY_PATH nix develop -c …`, from `pwd -P` paths (the `/home` symlink alias
  breaks MSBuild's incremental clean). Delete with `trash`, never `rm`; no `git stash`.
- Commits: short, Title Case, no trailing period, ending with `Co-Authored-By: Claude Opus 5.5
  <noreply@anthropic.com>` and the executing session's `Claude-Session:` trailer. Docs ship in the same commit as
  the behaviour they describe.

## Review Focus

1. **The scene folder is gone or half-downloaded** (Steam still syncing, a dangling `local/<id>` symlink). The
   switch fails cleanly back to A, no crash record, no restart loop, the item is not marked crashed. → Task 7
   `missing_scene_folder_fails_without_crash_record`, Task 11 IT step "missing folder".
2. **WE isn't installed / its library moved** (no `assets/`). Scenes are hidden like `AllowScenes=false`; a scene
   requested anyway errors with a hint naming `LP_WE_ASSETS_DIR` / `player.scene_assets`, never a 1×1 render loop.
   → Task 7 `no_assets_dir_hides_scenes_and_errors_with_hint`.
3. **A 4K or 7467×4200 scene** (43 of 93 library scenes are 3840×2160). The export ring is sized to cover the
   largest output showing it, never the native size. → Task 4 `huge_native_scene_exports_at_cover_size`.
4. **All monitors switched off while a scene plays** (DPMS, KVM), then back. The scene is parked (no ticks,
   silent, worker kept), then resumes; no worker leaks. → Task 5 `scene_parks_and_resumes_on_hotplug`.
5. **Next spammed across scenes** (keybind auto-repeat over S→S→S). Each superseded B's worker is reaped; at most
   2 unpaused sources per output; no zombie pids. → Task 9 `scene_switch_storm_reaps_workers`.

---

## File map

```text
third_party/lwe/PIN                         pinned upstream rev + submodule revs + Nix hash (D3)
patches/lwe/0001-cmake-version-override.patch          build: version without git tags
patches/lwe/0002-build-drop-gmpxx-add-glm-include.patch build: undeclared deps
patches/lwe/0003-host-audio-output-driver.patch         audio: host pull driver (wp_config_set_audio_output)
patches/lwe/0004-null-wallpaper-render-guard.patch      fix: 2nd render after a failed build segfaults
patches/lwe/0005-script-timers-host-clock.patch         fix: JS timers follow the host clock (pause)
patches/lwe/tests/host_api_test.c (+ fixtures/)         C tests of the patched API
scripts/lwe.sh                              fetch | prepare | build | check | test | rebase <rev>
src/player/src/worker/{mod,proto,dmabuf}.rs compositor side: WorkerHost, wire protocol, import/latch
src/player/src/scene/{mod,assets,pointer,budget}.rs  pure helpers: cover size, assets dir, pointer map, GPU budget
src/player/src/sources/scene.rs             SceneSource (Source impl)
src/player/src/audio/sysmon.rs              default-sink monitor tap for visualisers (D4)
src/player/src/probe/workers.rs             `workers` probe
src/player/src/bin/lp-scene-worker/{main,ring,synthetic,audio,lwe,render}.rs   the worker binary
src/player/tests/{worker,scene,lwe_build}.rs   new test targets; tests/common gains synthetic_scene + PrivatePw
src/player/tests/onmachine/scene_corpus.sh  corpus runner
src/livepaper/Player/*.cs, Helpers/PlayerHelper.cs, Web/ServerHost.cs, app/ui/src/views/Settings.tsx   adapter
```

**Render worker interplay (decided):** dmabuf imports, latching and release fences run on the **loop's own
context**, not on the `lp-render` thread. Import is a one-off 0.04–0.4 ms per ring slot, latching is an fd poll,
and the release fence is created on the context that sampled the texture, so the share-group rebind rule and an
extra cross-thread hop (a frame of latency) never arise. `lp-render` keeps owning mpv render contexts only.

**Order:** 1 → 2 → 4 → 5 → {6, 7} → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15. Task 3 needs no LWE and can run in
parallel with 1–2.

**Sizes:** S ≤ ½ day, M ½–1½ days, L 1½–3 days of focused agent work. Total ≈ 22–28 days, plus the follow-ups
Task 14 will find (Phase 1's battery produced four).

---

### Task 1: Vendor LWE `next-v2` and build its core everywhere

**Files:**
- Create: `third_party/lwe/PIN` (JSON: `repo`, `branch`, `rev`, `date`, `version`, `nix_hash`, `submodules`
  {path → commit} for the 10 submodules in `.gitmodules`)
- Create: `patches/lwe/0001-cmake-version-override.patch`, `patches/lwe/0002-build-drop-gmpxx-add-glm-include.patch`
- Create: `scripts/lwe.sh`, `src/player/tests/lwe_build.rs`
- Modify: `flake.nix` (new `lwe-src`, `lwe-core`; `lp-player` buildInputs + env; devShell env; `packages`),
  `scripts/install.sh`, `.gitignore` (`/build/`), `UPSTREAM.md` (LWE section), `CREDITS.md` (regenerated)

**Interfaces:**
- Produces: `$LP_LWE_CORE_DIR/{lib/liblinux-wallpaperengine-core.so*, include/linux-wallpaperengine/*.h}` — set by
  the flake (lp-player derivation and devShell) and by `install.sh`; dev default `$(pwd -P)/build/lwe-core`.
- `scripts/lwe.sh fetch` → `${LWE_SRC_CACHE:-$HOME/.cache/livepaper/src}/lwe-<rev>` (clone, checkout `rev`,
  submodules at the PIN's commits, each verified); `prepare` → `build/lwe-src-<rev>` (copy without VCS dirs,
  every patch `--check`ed, then applied in filename order); `build` → CMake with the spike flags
  (`-DWPBUILD_CORE=ON -DWPBUILD_WEBHELPER=OFF -DWPBUILD_FRONTEND=OFF -DWPBUILD_DEVVIEWER=OFF -DWPBUILD_TESTS=OFF
  -DWPBUILD_VERSION_OVERRIDE=<PIN.version>`), target `linux-wallpaperengine-core` only; `check` → exports + headers;
  `rebase <rev>` → re-applies every patch onto `<rev>` in a scratch copy, prints ok/conflict per patch, changes
  nothing on failure.

- [x] **Step 1: Write failing tests** (`tests/lwe_build.rs`; SKIP when `LP_LWE_CORE_DIR` is unset, FAIL then under
  `LP_REQUIRE_SCENES=1`):
  - `core_exports_only_wp_symbols`: `nm -D --defined-only` of the `.so` → every symbol starts `wp_`; the set ⊇ the
    66 of the pin (fixture list `tests/fixtures/lwe_exports_ddea3b4.txt`).
  - `patch_headers_are_complete`: every `patches/lwe/*.patch` has `From:`, `Subject:`, `Origin:` ∈ {ours,
    upstream-PR, upstream-commit}, `Why:`, `Status:` ∈ {candidate-for-upstream, local-only}.
  - `pin_matches_flake`: `PIN.rev` and `PIN.nix_hash` equal the values in `flake.nix` (text match).
- [x] **Step 2:** `cd src/player && env -u LD_LIBRARY_PATH nix develop -c cargo test -q --test lwe_build` → FAIL.
- [x] **Step 3: Implement.**
  - 0001: accept `-DWPBUILD_VERSION_OVERRIDE`; without it and without a tag keep upstream's `FATAL_ERROR`.
  - 0002: delete `#include <gmpxx.h>` in `core/WallpaperEngine/Render/FBOProvider.cpp`; add glm's include dir to
    `common-object` (the spike needed `CPATH`).
  - `lwe-core` derivation: `stdenv.mkDerivation`, `src = lwe-src` (`fetchFromGitHub { owner = "Almamu"; repo =
    "linux-wallpaperengine"; rev; fetchSubmodules = true; hash }`), `patches` = the sorted `patches/lwe/*.patch`,
    `nativeBuildInputs = [cmake pkg-config]`, `buildInputs = [SDL2 freetype glm lz4 zlib libGL ffmpeg
    mpv-unwrapped]`, build target only, install `lib/` + `include/`.
  - `install.sh`: preflight `cmake`, SDL2, freetype, glm, lz4, zlib, FFmpeg (avformat/avcodec/swresample/swscale/
    avutil), libGL dev — print Arch / Debian / Fedora package lines and exit 1 unless `--no-scenes`; build via
    `scripts/lwe.sh fetch prepare build`; install the `.so*` into `$S_WEB/lib/` (the worker gets
    `RUNPATH $ORIGIN/../lib`).
  - `UPSTREAM.md`: pin, patch table, `scripts/lwe.sh rebase` + corpus runner (Task 13) as the resync recipe, last
    sync date; regenerate `CREDITS.md`.
- [x] **Step 4:** `bash scripts/lwe.sh fetch prepare build check` → exit 0; `nix build .#lwe-core` → ok; the test
  target PASSES; `tests/credits.rs` PASSES. Record the clean build time (spike: 69 s / 24 threads, 688 MB RSS).
- [x] **Step 5:** `bash scripts/install.sh --no-scenes` on this machine still installs (no cmake used), and without
  `--no-scenes` with `cmake` hidden from `PATH` it exits 1 printing the package lines.
- [x] **Step 6 (D7 probe):** write `patches/lwe/tests/fixtures/min-scene/` (`project.json` type scene + a
  `scene.json` with only `general.clearcolor`) and run the spike host against it with an empty assets dir. Record
  in `docs/player/spikes/lwe-core.md` §7 whether it renders; if it does, Task 4–9 tests may use it as a second
  fixture.
- [x] **Step 7:** Commit `Vendor LWE next-v2 Core With Build Patches`.

**Done 2026-10-27 — as built (deviations, per D3):** the build fetches the owner's fork
`Kryxzort/linux-wallpaperengine` branch `livepaper/next-v2` at `rev` (= base `ddea3b4` + our
commits); the flake reads `third_party/lwe/PIN` itself (`builtins.fromJSON`), so
`pin_matches_flake` checks that it keeps doing so (no duplicated literals); `lwe-core` builds the
fork's tree as is (no `patches =`); `patches/lwe/` is `git format-patch base..rev`
(`lwe.sh patches`), and `lwe.sh verify` proves base + patches == rev. `lwe.sh` gained `verify`,
`patches`, `deps` (the per-distro lines `install.sh` prints), `--nix` and `LWE_DEV_SRC` (patch
work in place). Export fixture: `tests/fixtures/lwe_exports.txt` (70 = 66 + 0003's 4). Extra
tests: `core_is_the_pinned_one`, `worker_links_the_core`. Build: `lwe.sh` 54–56 s at `-j8`, the
flake's `lwe-core` 49 s. Step 6 (D7): a clear-colour-only scene renders without assets —
recorded in `docs/player/spikes/lwe-core.md` §8 (§7 was taken). `install.sh` also installs
`lp-scene-worker` (+ the core in `livepaper-web/lib`, worker RUNPATH `$ORIGIN/../lib`), and a
DESTDIR install no longer exits 1 (its last line). The `lwe` feature is **on by default**: the
devShell and the `lp-player` package set `LP_LWE_CORE_DIR`.

**Size: L** (1.5–2 days; nix hash + CMake quirks + three distros' package names).

### Task 2: LWE patches — host audio output, render guard, host-clock script timers

**Files:**
- Create: `patches/lwe/0003-host-audio-output-driver.patch`, `0004-null-wallpaper-render-guard.patch`,
  `0005-script-timers-host-clock.patch`, `patches/lwe/tests/host_api_test.c`
- Modify: `scripts/lwe.sh` (`test`: compile `host_api_test.c` against the built core, run it, exit status),
  `tests/fixtures/lwe_exports_ddea3b4.txt` → the post-patch export list, `UPSTREAM.md`, `CREDITS.md`

**Interfaces (C, added to `include/linux-wallpaperengine/{configuration,context}.h`):**
```c
typedef struct wp_audio_output { int sample_rate; int channels; } wp_audio_output; /* host pulls F32 interleaved */
WPENGINE_API void        wp_config_set_audio_output (wp_configuration* config, const wp_audio_output* out); /* before wp_context_create; NULL = SDL */
WPENGINE_API size_t      wp_context_audio_pull (wp_context* ctx, float* interleaved, size_t frames);       /* unity-gain mix of every stream; fills silence; returns frames */
WPENGINE_API int         wp_context_audio_stream_count (wp_context* ctx);
WPENGINE_API const char* wp_context_audio_driver_name (wp_context* ctx);                                   /* "host" | "sdl" */
```
- 0003: `HostAudioDriver : Audio::Drivers::AudioDriver` (7 virtuals; `getFormat` = `AV_SAMPLE_FMT_FLT`); `Context`
  picks it instead of `SDLAudioDriver` when the config carries an output — so **no SDL device is opened** (the
  spike measured a sink-input even with audio disabled). `wp_context_audio_pull` is the body of
  `SDLAudioDriver`'s `audio_callback` (per-stream `decodeFrame`, the same wait-condition signalling) summing into
  float with no volume. Est. 150–200 lines. `Status: candidate-for-upstream`.
- 0004: `Project::render` returns when `wallpaper == nullptr` (spike §4.4). Status: candidate-for-upstream.
- 0005: `Scripting/EngineObject.cpp` timers read the context's time counter instead of `std::chrono::steady_clock`
  (invariant #7: pause freezes time). Status: candidate-for-upstream.

- [x] **Step 1: Write failing tests** in `host_api_test.c` (env `SDL_AUDIODRIVER=dummy`):
  - `host_output_replaces_sdl`: with an output set → `driver_name == "host"` and `SDL_WasInit(SDL_INIT_AUDIO) == 0`.
  - `pull_without_streams_is_silence`: pull 1024 frames → returns 1024, all samples `0.0f`.
  - `sdl_stays_default_without_host_output`: no output → `driver_name == "sdl"`.
  - `render_after_failed_build_returns`: the Task 1 `min-scene` with an empty assets dir → `wp_render_frame` twice,
    no SIGSEGV, width ≤ 1.
- [x] **Step 2:** `bash scripts/lwe.sh test` → FAIL (symbols missing).
- [x] **Step 3:** Write the three patches; regenerate the export fixture; `scripts/lwe.sh prepare build`.
- [x] **Step 4:** `bash scripts/lwe.sh test` → PASS; `cargo test -q --test lwe_build --test credits` → PASS.
  (`0005` is verified on-machine in Task 14, step "pause on a scripted scene".)
- [x] **Step 5:** Commit `Add LWE Host Audio Driver And Render Fixes`.

**Done 2026-10-27 — as built:** the test is `patches/lwe/tests/host_api_test.cpp` (LWE's public
headers are C++-only) with two committed fixtures (`min-scene`, `fail-scene` — the failed build
needs no missing assets: an object with a missing parent) and three extra cases
(`min_scene_renders_without_assets`, `host_pull_mixes_scene_sound_at_unity_gain` with
`LP_WE_ASSETS_DIR`, `pull_on_sdl_context_returns_zero`). The audio-mix test found a heap overflow
for mono sounds on a stereo output → **patch 0006** (resample buffer sized by the output's
channels). 0003's pull never waits for decoding (safe in a PipeWire RT callback) and the frames
pulled per host second set the speed — the hook for the owner's pitch-corrected scene speed
(Task 6's time-stretch). RED seen: compile failure (no symbols), SIGSEGV on the 2nd render
(before 0004), `double free or corruption` (before 0006). Real-scene smoke: `lp-scene-worker
--lwe-smoke` (`lwe.rs`, the seed of Task 7's renderer). `.claude/rules/player-core.md` § Scene
worker → "LWE core".

**Size: M–L** (1–1.5 days; LWE's decode threading is the unknown — Risk 3).

### Task 3: Worker protocol and process lifecycle

**Files:**
- Create: `src/player/src/worker/{mod.rs,proto.rs}`, `src/player/src/bin/lp-scene-worker/main.rs` (`--fd N
  --parent-pid P [--stub]`), `src/player/tests/worker.rs`
- Modify: `src/player/src/lib.rs`, `Cargo.toml` (feature `lwe`, default on; the bin), `build.rs` (feature `lwe` →
  `cargo::rustc-link-arg-bin=lp-scene-worker=-L$LP_LWE_CORE_DIR/lib -llinux-wallpaperengine-core
  -Wl,-rpath,$LP_LWE_CORE_DIR/lib`; missing env → build error naming `scripts/lwe.sh build` and
  `--no-default-features`), `src/player/src/paths.rs` (`scene_worker_bin()`: `LP_SCENE_WORKER_BIN` → sibling of
  `/proc/self/exe` → `PATH`; `crash_dir()` = `<state>/crashes/`)

**Interfaces:**
```rust
// worker/proto.rs — JSON datagrams on SOCK_SEQPACKET, fds via SCM_RIGHTS, ≤ 64 KiB each
pub const PROTOCOL: u32 = 1;
#[serde(tag = "t", rename_all = "snake_case")] pub enum ToWorker {
  Start { path: String, assets_dir: Option<String>, steam_dir: Option<String>, position: f64, paused: bool,
          audio: AudioRoute, max_size: [u32; 2], synthetic: bool },
  Tick { seq: u64, t: f64, input: Option<Vec<u8>> },  // render one frame at scene time t; input = 1024 u8 visualiser samples
  Release { slot: u8 },                               // + optional release fence fd
  Gain { db: f64 }, Paused { paused: bool }, NoAudio { on: bool }, Route { audio: AudioRoute },
  Pointer { x: f64, y: f64, buttons: u32 }, Resize { max_size: [u32; 2] }, Ping { seq: u64 }, Quit }
#[serde(tag = "t", rename_all = "snake_case")] pub enum FromWorker {
  Hello { protocol: u32, pid: u32, features: Vec<String>, sync: String },   // features: lwe, synthetic; sync: fence|fdpoll
  Buffer { slot: u8, w: u32, h: u32, fourcc: u32, modifier: u64, planes: Vec<Plane> }, // + plane fds
  Frame { slot: u8, seq: u64, t: f64, gpu_ms: Option<f32> },                // + acquire fence fd (none in fdpoll)
  Ready { native: [u32; 2], has_audio: bool, wants_audio_input: bool },
  HasAudio { on: bool }, AudioFlowing, Envelope { t0_ms: f64, dbfs_1ms: Vec<f32> },
  Pong { seq: u64 }, Error { reason: String, fatal: bool }, ContextLost, Log { level: String, line: String } }
pub enum AudioRoute { Null, Default, Device(String) }
pub struct Plane { pub offset: u32, pub stride: u32 }
pub fn send<M: Serialize>(fd: BorrowedFd, m: &M, fds: &[BorrowedFd]) -> io::Result<()>;
pub fn recv<M: DeserializeOwned>(fd: BorrowedFd) -> io::Result<Option<(M, Vec<OwnedFd>)>>; // None = would block; Err(UnexpectedEof) = peer gone

// worker/mod.rs
pub struct WorkerSpec { pub id: String, pub bin: PathBuf, pub start: ToWorker, pub env: Vec<(String, String)>, pub hang_timeout: Duration }
pub enum WorkerState { Starting, Running, Restarting { attempt: u32 }, Broken { reason: String }, Stopped }
pub enum WorkerEvent { Msg(FromWorker, Vec<OwnedFd>), Exited { signal: Option<i32>, code: Option<i32> },
                       Hung { waited_ms: u64 }, Restarted { attempt: u32 }, Broken { record: PathBuf } }
impl WorkerHost {
  pub fn spawn(spec: WorkerSpec) -> io::Result<WorkerHost>;   // socketpair; child end → fd 3; PDEATHSIG SIGKILL; stderr → log ring
  pub fn wake_fd(&self) -> RawFd;                              // dup of the socket, for calloop
  pub fn send(&mut self, m: &ToWorker, fds: &[BorrowedFd]) -> io::Result<()>;
  pub fn poll(&mut self, now: Instant) -> Vec<WorkerEvent>;    // never blocks: drain msgs, reap, heartbeat, restart
  pub fn set_resume_position(&mut self, t: f64);               // what a restart's Start carries
  pub fn stop(&mut self);                                      // Quit, SIGKILL after STOP_GRACE; never blocks
  pub fn state(&self) -> &WorkerState; pub fn pid(&self) -> Option<u32>; pub fn log_tail(&self) -> Vec<String>;
}
pub struct RestartBudget { pub window: Duration, pub max: u32 }  // 60 s, 3
pub const HANG_TIMEOUT: Duration = Duration::from_secs(2);  // a Tick or Ping unanswered this long = hung → SIGKILL
pub const STOP_GRACE: Duration = Duration::from_millis(500);
pub const LOG_TAIL: usize = 50; pub const MAX_CRASH_RECORDS: usize = 20;
```
- Heartbeat: while running, every `Tick` is answered (`Frame`); while no ticks are due, `Ping` every 1 s.
  Crash = socket EOF (spike §6) → `waitpid` for the status. Restart re-sends the last `Start` with the resume
  position. Crash record `<state>/crashes/<scene-id>-<unix_ms>.json` = `{scene_id, path, signal|code, restarts,
  uptime_ms, t_wall, log_tail}`; oldest dropped past 20. Events `worker.spawned|ready|exited|hung|restart` +
  `source.broken` (Task 10 wires it to the source).
- Spawn runs off the loop (the `host::OpenPool`, like mpv cores) — forking the compositor costs page-table copies.
- `--stub` mode: answers `Hello`/`Ping`; knobs in `LP_SCENE_WORKER_TEST` (comma-separated): `crash_after_ms:N`
  (prints "stub: crashing" to stderr, then `abort()`), `hang_after_ms:N` (stops answering), `exit_code:N`,
  `ignore_quit`, `spam_stderr:N`.

- [x] **Step 1: Write failing tests** (`tests/worker.rs`, no GPU):
  - `proto_roundtrip_with_fds` (a `Buffer` with 2 memfds → same message, both fds readable with their bytes)
  - `proto_rejects_oversized_and_garbage` (65 KiB → `Err`; a non-JSON datagram → `Err` and the next valid one parses)
  - `spawn_handshake_hello` (`Hello {protocol: 1}` ≤ 1 s; `pid()` = the child)
  - `worker_exit_is_seen_with_its_signal` (crash_after_ms 100 → `Exited {signal: Some(6)}` ≤ 500 ms)
  - `hang_is_detected_by_heartbeat` (hang_after_ms 100, `hang_timeout` 300 ms → `Hung` ≤ 600 ms, pid gone ≤ 100 ms later)
  - `restarts_three_times_then_broken` (crash_after_ms 50 → `Restarted{1,2,3}` then `Broken`; record has `restarts: 3`,
    the signal and the stub's `stub: crashing` stderr line)
  - unit `budget_window_slides` (3 crashes, then one 61 s later → restart, not broken)
  - `stop_never_blocks` (`ignore_quit` → `stop()` < 5 ms; child gone ≤ STOP_GRACE + 100 ms)
  - `worker_dies_with_its_parent` (parent SIGKILLed → worker gone ≤ 300 ms)
  - `log_tail_and_crash_records_are_bounded` (10 000 stderr lines → 50 kept, newest last; 25 broken → 20 records)
- [x] **Step 2:** `cargo test -q --test worker` → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [x] **Step 5:** Commit `Add Scene Worker Protocol And Lifecycle`.

**Size: L** (≈ 2 days, ~900 lines).

### Task 4: dmabuf frame transport — export ring, synthetic renderer, latch-signalled import

**Files:**
- Modify: `src/player/src/gfx/egl.rs` — `Gfx::new_offscreen_with(OffscreenOpts { priority })` (worker: LOW;
  compositor contexts get HIGH where `EGL_IMG_context_priority` exists, granted value logged `gfx.context_priority`),
  `export_dmabuf(&Tex) -> Result<DmabufDesc, String>`, `import_dmabuf(&DmabufDesc, Vec<OwnedFd>) ->
  Result<ImportedTex, String>`, `dmabuf_modifiers(fourcc) -> Vec<(u64, bool /*external_only*/)>`,
  `native_fence() -> Result<OwnedFd, String>` (`EGL_SYNC_NATIVE_FENCE_ANDROID` + `glFlush` + dup — flush before the
  dup), `gpu_wait_fence(OwnedFd)`; `glEGLImageTargetTexture2DOES` fetched by name
- Create: `src/player/src/worker/dmabuf.rs` (`ImportedRing`, `Latch`), `src/player/src/scene/mod.rs`
  (`cover_size`), `src/player/src/bin/lp-scene-worker/{ring.rs,synthetic.rs}`, `src/player/src/sources/scene.rs`
  (texture path), `src/player/tests/scene.rs`
- Modify: `tests/common/mod.rs` — `synthetic_scene(name, SyntheticSpec) -> PathBuf` writes
  `target/test-media/scenes/<name>/{project.json (type scene), scene.pkg (16-byte placeholder), preview.png,
  lp-synthetic.json}`

**Interfaces:**
- `lp-synthetic.json` = `SyntheticSpec { pattern: frame_index|solid|split_tb|pointer_dot|input_level, rgb, native:
  [w,h], alpha: f32 (to prove the worker forces 1), gpu_work: u32, tone_hz, tone_dbfs, has_audio, crash_after_ms,
  hang_after_ms, fail: Option<load|build> }`. `frame_index` = the spike's top-left 64×64 = `seq mod 256` + a 16×16
  gradient probe at the far corner.
- `pub fn cover_size(native: (u32,u32), demand: (u32,u32)) -> (u32,u32)` — scene aspect kept, smallest size whose
  scale covers `demand`, never above native, long edge ≤ 4096.
- `Latch::push(slot, seq, t, acquire: Option<OwnedFd>)`; `Latch::latch() -> Option<Latched>` = newest queued frame
  whose fd polls readable (no fd = fdpoll mode = ready); older queued ones are released without a fence; the slot
  latched before gets `Release` with a `native_fence()` created right at the latch (it orders after every earlier
  draw that sampled it); `gpu_wait_fence` on the newly latched acquire fd is kept as a free safety net.
- `SceneSource::texture()` = the latched slot's texture; it survives worker death (spike §6); a restart's new
  `Buffer` set replaces the old `ImportedRing` only once the new worker's first frame latched.
- fdpoll: `LP_SCENE_SYNC=fdpoll`, or a worker lacking `EGL_ANDROID_native_fence_sync` → `Hello.sync = "fdpoll"`.
- In this task `SceneSource` ticks at a fixed `opts.tick_hz` (tests pass 144) with `max_size` from opts; Task 5
  replaces both with the graph's demand.

- [x] **Step 1: Write failing tests** (`tests/scene.rs`, GPU, SKIP without EGL; synthetic worker):
  - `transport_never_shows_stale_torn_or_out_of_order` (frame_index at 144 Hz ticks, 600 frames: every latched
    texture's corner == its `seq mod 256` (±1) and the gradient probe exact; seqs strictly increase; ≥ 590 latched)
  - `latch_never_waits_on_an_unsignalled_fence` (gpu_work ≈ 6 ms/frame: every `SceneSource::update` ≤ 1 ms while
    the GPU is busy; `stale_reuses > 0`)
  - `killed_worker_keeps_last_frame` (SIGKILL the worker: readbacks every 100 ms for 2 s identical, texture never None)
  - `restart_replaces_ring_after_first_new_frame`
  - unit `external_only_modifier_is_refused` (fake modifier table: LINEAR external-only → error naming dmabuf.md §1)
  - `fdpoll_fallback_is_equally_correct` (`LP_SCENE_SYNC=fdpoll`, the first test at 300 frames)
  - `scene_texture_holds_image_top_at_t0` (split_tb red/blue: low y red — R25, no flip)
  - `scene_frame_is_opaque` (alpha 0 in the pattern → alpha 255 sampled)
  - `huge_native_scene_exports_at_cover_size` (native 7467×4200, demand 1920×1080 → `Buffer` 1920×1080)
  - `four_workers_latch_independently` (4 synthetic workers: each keeps its own seq order; the summed `update`
    cost per iteration ≤ 4.5× one worker's)
  - unit `cover_size_examples`: 3840×2160→1920×1080; 2048×1423→(1920×1334); 3840×1080→3840×1080; 7467×4200→1920×1080;
    1280×720→1280×720 (demand 1920×1080 each)
- [x] **Step 2:** `cargo test -q --test scene transport` → FAIL. **Step 3:** implement. **Step 4:** → PASS
  (`cargo test -q --test scene`).
- [x] **Step 5:** Commit `Add dmabuf Scene Frame Transport`.

**Size: L** (≈ 2 days, ~1000 lines; the spike's `producer.c`/`consumer.c` are the reference).

### Task 5: The `scene` Source kind — graph, SourceHost, clock, pause, Ready, persistence

**Files:**
- Modify: `graph/props.rs` (Source `kind` enum + `scene`; Source `preview: Str`; Output `scene_fps: F64` 0–480,
  default 30 (D5), 0 = the output's refresh), `graph/mod.rs` (`outputs_of(id) -> Vec<String>`: the inverse of
  `srcs:<c>`), `sources/mod.rs` (`Source::as_scene/as_scene_mut`), `sources/host.rs` (open `scene` → `SceneSource`;
  each `sync` → `set_demand`; scene wake fds; `set_audio_route`/`push_gain` include scenes), `sources/scene.rs`,
  `onset.rs` (`kind_has_audio(kind)` = video | scene; `has_audio` uses it), `runtime.rs` (`video_playing` →
  `media_playing` incl. scenes; restore's audible check; stepped `begin_step` steps scenes; park/unpark),
  `snapshot.rs` (scene position = scene time; `playing` for video | scene), `api/handlers.rs` (`hello.capabilities`
  + `scene` when `scene_worker_bin()` resolves; `state.workers`), `probe/mod.rs` (`sources` scene fields),
  `probe/workers.rs` (new)

**Interfaces:**
- `SceneSource::open(gfx, node_props, base_opts) -> Result<SceneSource, ApiError>` (base opts: `ao`,
  `audio_device`, `scene_worker`, `scene_assets`, `stepped`, `allow_synthetic`); the worker is spawned on the
  first `set_demand` that names an output.
- `set_demand(&mut self, outs: &[OutputDemand])`, `OutputDemand { name, width, height, refresh_hz, scene_fps }` →
  `max_size` = the largest output, tick rate = max over outputs of `eff(scene_fps, refresh)` (Task 8 adds the cap).
- `step_to(&mut self, t: f64)` / `step_status() -> StepStatus` (`Done` once the frame of exactly `t` latched).
- A demand change that moves the largest output sends `Resize {max_size}`; the worker re-exports its ring at the
  new `cover_size` and the old latched texture stays until the first new frame latches.
- `workers` probe / `state.workers`: per scene source `{id, pid, state, restarts_60s, total_restarts, sync,
  fourcc, modifier, size, native, fps_target, fps_actual, latched, stale_reuses, queued, last_error}` (Task 8 adds
  the GPU fields).
- Scene clock: `Instant`-based, paused intervals excised; `paused` (effective: `node.paused || player.paused`)
  stops ticks and latching at once (the held texture is exact, so no paused-mpv frame drift).
- Property semantics:

| prop | on a scene |
|---|---|
| `path` | the item folder; a live change = a new worker on the new folder, old frame held until Ready, not a crash |
| `paused` | freezes clock, rendering, latching; the worker stops pulling audio (callers ramp first) |
| `position` | scene time (s) at start / restore / crash resume; a live set jumps the clock |
| `loop`, `speed`, `hwdec`, `fps_cap`, `cache`, `demuxer_*`, `af`, `audio_delay` | stored, no effect |
| `gain.*`, `no_audio` | Task 6 |
| `preview` | image shown while no worker frame exists (Task 10) |
| observed | `ready`, `width`/`height` (export size), `time_pos` (scene clock), `duration` 0, `has_audio` (Task 6) |

- [x] **Step 1: Write failing tests:**
  - unit `scene_kind_in_schema_and_kind_change_unsupported`; unit `kind_has_audio_counts_scenes`
  - `scene_ready_is_first_latched_frame` (one Ready; texture = the frame of `t = position`)
  - `paused_scene_readies_with_its_first_frame` (opened paused: Ready, then identical for 1 s, exactly one Tick)
  - `pause_freezes_picture_exactly` (no latch after the apply; resume continues `time_pos` within one tick)
  - api `player_pause_freezes_scene` (`set player.paused` → `time_pos` frozen; `probe sources` `effective_paused`)
  - api `stepped_scene_is_deterministic` (two stepped servers, frame_index, 60 × 16 ms steps → byte-identical captures)
  - `scene_tick_rate_follows_demand` (scene_fps 30 → 30 ± 2 latched/s; set 60 → 60 ± 3 within 0.5 s, same pid)
  - `path_change_restarts_worker_and_holds_frame`
  - api `scene_create_and_destroy_never_stall_the_loop` (`probe loop` max_busy ≤ 3 ms around each; pid gone ≤ 600 ms)
  - api `scene_parks_and_resumes_on_hotplug` (remove both virtual outputs → parked, no Ticks, gain −96; re-add →
    unparked, ticking, same pid)
  - supervise `scene_snapshot_restores_at_position` (compositor SIGSEGV with a scene shown → restored, `time_pos`
    within ±2 s of the saved one)
  - api `capture_scene_source_is_upright`
  - api `demand_change_reexports_without_black` (add a 2560×1440 virtual output → one `Resize`, a new `Buffer` set
    at the new cover size, the texture never None in between)
- [x] **Step 2:** run the new tests → FAIL. **Step 3:** implement. **Step 4:** full suite → PASS (render worker on
  and off: `LP_PLAYER_RENDER_WORKER=off cargo test -q`).
- [x] **Step 5:** Commit `Add Scene Source Kind`.

**Done (2026-10-27) — deviations** (`.claude/rules/player-core.md` § Scene worker → "The
`scene` Source kind"): `SceneSource::open` takes the node id too (`open(gfx, id, node, base)`;
Task 4's direct path is `open_opts`); the clock runs from the load's first frame (Ready = the
frame of exactly `position`); scene speed scales the clock (owner decision; audio is Task 6);
the wake fd is the source's own epoll incl. one-shot acquire fences (a stepped loop has no
timer); step completion by tick seq, not `t`; `demand_change_reexports_without_black` is a
harness test (exact ring stats) instead of an api one; a broken worker already reports
`SourceEvent::Error` (Task 10 adds `source.broken`); added `scene_clock_follows_speed_and_position`
and the supervise test's new-worker checks.

**Size: L** (2–3 days; `runtime.rs` is 3.7 k lines of interlocking rules).

### Task 6: Scene audio — a dB-gained stream on the bus

**Files:**
- Create: `src/player/src/bin/lp-scene-worker/audio.rs`
- Modify: `sources/scene.rs` (effective-dB `Gain` on every gain change incl. the 1 kHz `push_gain` path;
  `NoAudio`; `Route`; `AudioFlowing`/`HasAudio` → `SourceEvent::AudioFlowing` / observed `has_audio`; `Envelope`
  → `probe::dropout`), `audio/meter.rs` (`pub fn dbfs_block(&[f32], channels) -> f32` shared with the worker),
  `probe/dropout.rs` (a scene side's reference = its worker's `Envelope`, not a decoded file),
  `tests/common/mod.rs` (move `PrivatePw` here from `tests/api.rs`)

**Interfaces:**
- Worker stream: PipeWire playback, F32 stereo 48 kHz, `node.latency 256/48000`, props `node.name =
  lp-player-scene.<source id>`, `application.name = lp-player`, `media.role = Wallpaper`, `target.object =
  lp-player-bus` when `Route` is the bus, `state.restore-props = false`, `state.restore-target = false`. Opened at
  Start (silent at −96 dB until a `Gain` arrives), closed only at `Quit` after the compositor's retire ramp.
- Process callback: pull `frames` from `wp_context_audio_pull` (synthetic: the tone; paused / `no_audio`: nothing
  pulled, silence written), multiply by a gain interpolated **linearly in amplitude** from the previous to the
  latest `db_to_lin(db)` across the buffer; −96 dB → exactly `0.0`. `AudioRoute::Null` (tests, `--ao null`) = a
  real-time timer thread pulling and discarding.
- `AudioFlowing` armed on: un-pause, `no_audio` off, a start that plays, a route change; sent from the first
  callback after arming that pulled source samples. `has_audio` = LWE stream count > 0 (synthetic: `has_audio`),
  default `true` until Ready says otherwise (R92's conservative rule).
- `Envelope`: 1 ms max-channel RMS dBFS of the **pre-gain** samples, batched every 50 ms.

- [x] **Step 1: Write failing tests:**
  - worker unit (`cargo test --bin lp-scene-worker`): `gain_change_ramps_across_one_buffer` (0 → −96 within a
    480-frame buffer of 1.0: first ≈ 1.0, last = 0.0, monotonic, max step ≤ 1/479 + 1e-6),
    `silent_db_is_exact_zero`, `gain_matches_db_to_lin` (−6.0206 dB → 0.5 ± 1e-6),
    `envelope_of_full_scale_sine_is_minus_3_01` (± 0.05)
  - api (PrivatePw; SKIP without the binaries): `scene_audio_on_bus_with_identity` (synthetic 440 Hz −20 dBFS:
    the stream's props as above, linked to `lp-player-bus`; `meter.window` median −23 ± 3 dB),
    `scene_gain_ramp_reaches_the_bus` (animate `gain.user` 0 → −20 over 300 ms: end −43 ± 3, monotonic),
    `scene_no_audio_toggle_is_live` (on → ≤ −90 within 100 ms; off → `source.audio_flowing` then −23 ± 3; same pid),
    `scene_audio_flowing_gates_onset` (frozen V→S: B's `onset.started {reason: flowed}` after its flowing event),
    `scene_has_audio_false_skips_onset_wait` (no `transition.onset_timeout`),
    `scene_reroutes_after_pipewire_restart` (the `i7_bus_reconnects_after_pipewire_restart` pattern: back on the bus,
    `gain.pause` ramp-in `reason: flowed`)
  - unit `dropout_uses_scene_envelope_as_reference` (synthetic envelope + gain schedule → expected matches ±1.5 dB)
- [x] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [x] **Step 5:** Commit `Add Scene Audio On The Player Bus`.

**Done (2026-10-28) — deviations** (`.claude/rules/player-core.md` § Scene worker → "Scene
audio (Task 6)"): the owner's speed decision is in — a WSOLA stage (`stretch.rs`, bit-exact
passthrough at 1×) and a new `ToWorker::Speed`; `PROTOCOL` 2 (`Start` gained `id`, `gain_db`,
`no_audio`, `speed`; `Gain`/`NoAudio`/`Speed` fold into the restart's `Start`); the worker's
`paused` means "play no audio" (also always in stepped mode); a worker-side 30 ms gate
declicks anything that stops while audible (pause, mute, route change, quit) and fades a
restarted worker in, but jumps when the stream is silent (no extra pull, no drift); the protocol
thread applies the audio messages directly (never behind a render or a load); a PipeWire that
can't be reached falls back to the null timer (no flow) and retries every 1 s; the stream opens
when the loaded scene has sound (not at `Start`: a soundless scene opens none — no wake-ups for
silence).
`scene_audio_flowing_gates_onset` + `scene_has_audio_false_skips_onset_wait` became one test,
`scene_audio_flowing_gates_every_onset` (`--ao null`, every onset path), plus
`scene_crossfades_are_equal_power_on_the_bus`, `scene_pause_park_and_destroy_on_the_bus`, the
opt-in `real_scene_sound_on_the_bus`, the stretch units and `--lwe-smoke --audio-dump`; the
identity check accepts any `N/48000` `node.latency` (PipeWire rewrites the prop to the running
quantum). `PrivatePw` lives in `tests/common/pw.rs`.

**Size: L** (≈ 2 days).

### Task 7: Real scenes — LWE in the worker, assets dir, pointer, visualiser input

**Files:**
- Create: `src/player/src/bin/lp-scene-worker/{lwe.rs (extern "C" decls + safe wrapper), render.rs}`,
  `src/player/src/scene/{assets.rs,pointer.rs}`, `src/player/src/audio/sysmon.rs`
- Modify: `graph/props.rs` (Player `scene_assets: Str` default "" = auto; read-only `scene_assets_resolved`),
  `main.rs` (`lp-player scene-check` → JSON `{worker, features, assets_dir, ok, reason}`, exit 0/1),
  `runtime.rs` (forward `out:<c>.pointer` to every scene source shown on `<c>`, both sides mid-transition; feed
  visualiser windows), `api/handlers.rs` (`headless.pointer {output, x, y, buttons}`)

**Interfaces:**
- `scene::assets::resolve(explicit: Option<&Path>, home: &Path) -> Result<PathBuf, String>`: explicit →
  `LP_WE_ASSETS_DIR` → each Steam root (`~/.local/share/Steam`, `~/.steam/steam`, Flatpak) and each
  `libraryfolders.vdf` `"path"` → `<root>/steamapps/common/wallpaper_engine/assets` containing
  `shaders/genericimage2.vert` (this machine: workshop in the primary library, WE in
  `/mnt/Games/Steam/SteamLibrary`). `parse_libraryfolders(&str) -> Vec<PathBuf>`;
  `steam_root_of_item(dir) -> Option<PathBuf>` (realpath `…/steamapps/workshop/content/431960/<id>` → the root,
  passed as `Start.steam_dir` so dependencies resolve). The scene path is the folder itself
  (`wp_project_load_folder`); `local/<id>` symlinks resolve.
- From this task on, `hello.capabilities` has `scene` only when the worker resolves **and** an assets dir resolves
  (with `LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1` the assets dir is optional, so hermetic stacks still get it);
  `scene-check` applies the same rule.
- `render.rs`: `LweScene::load(dir, assets, steam_dir, audio) -> Result<LweScene, String>` (NULL → `"load failed:
  <stderr tail>"`); `first_render() -> Result<(u32,u32), String>` (frame 0 into a 1×1 scratch FBO; size ≤ 1 →
  `Error {fatal: true, "renderer build failed (assets: <dir>)"}`, never rendered again); `render(t, slot)` =
  `wp_render_update_time` + `wp_render_frame` into the native FBO, then blit to the slot at `cover_size`, no flip,
  alpha forced to 1. `wants_audio_input` = project.json `general.supportsaudioprocessing`.
- Pointer: `scene::pointer::to_source_uv(rect: &UvRect, px: f64, py: f64) -> Option<(f64, f64)>` (inverse of
  `fit_rect`); the worker hands LWE native scene pixels, y from the top (`CScene` divides by its width/height).
- Visualiser (D4): `audio::sysmon` captures the default sink's monitor (follows default changes) only while ≥ 1
  live scene has `wants_audio_input`; each such scene's `Tick.input` = the latest 1024 mono u8 samples (centre 128).

- [x] **Step 1: Write failing tests:**
  - unit: `vdf_paths_parsed`, `assets_found_in_secondary_library`, `missing_assets_error_names_every_candidate`,
    `steam_root_of_symlinked_local_item`, `pointer_maps_through_fill_and_viewport` (a 2:1 scene filled into 16:9:
    output centre → (0.5, 0.5); left edge → u ≈ 0.0556; a point outside the visible rect → None)
  - api `pointer_reaches_scene_in_source_coords` (pointer_dot, `headless.pointer` (960, 540) on 1920×1080 → the dot
    at the scene centre ± 2 px; both sides of a running fade see it)
  - api (PrivatePw) `visualiser_input_reaches_only_scenes_that_want_it` (tone on the default sink → an input_level
    scene reports RMS > −30 dBFS; a scene without the flag gets none and no capture stream exists in `pw-dump`)
  - api `missing_scene_folder_fails_without_crash_record` (Review 1: `source.error` "load failed", no file under
    `crashes/`, no `worker.restart`)
  - api `no_assets_dir_hides_scenes_and_errors_with_hint` (Review 2: no `scene` capability, `scene-check` exit 1
    with a reason; a create anyway → Error naming `LP_WE_ASSETS_DIR` / `player.scene_assets`)
  - opt-in on-machine (`LP_PLAYER_TEST_SCENES=<431960 dir>`, else SKIP; FAIL under `LP_REQUIRE_SCENES=1`):
    `real_scenes_render_and_animate` (1726902114, 2371103399, 2134765860: Ready ≤ 3 s, non-blank, the frames at
    1 s and 3 s differ, 0 GL errors in the worker log), `renderer_build_failure_is_broken_not_a_segfault` (empty
    assets dir → fatal Error, worker exit 0)
- [x] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS (the opt-in ones with the 431960 folder).
- [x] **Step 5:** Commit `Render WE Scenes In The Scene Worker`.

**Done (2026-10-27) — deviations** (`.claude/rules/player-core.md` § Scene worker → "Real scenes
(Task 7)"): the load runs on the renderer thread while a second worker thread (`lp-scene-proto`)
answers pings (LWE's GL objects must be built and rendered on one context — a loader thread with
its own context can't share VAOs/FBOs), bounded by `LP_SCENE_LOAD_TIMEOUT_MS`; no assets → the
open fails before any worker is spawned; the visualiser mixes every app playback stream except
loopback halves (D4's stream mix; streams on non-default sinks count too), `admit()` is the
white/blacklist plug point; user properties ride a new `scene_props` Source prop (Map) →
`Start.properties` + `ToWorker::SetProperty` (folded into restarts) → `PropertySet` /
`scene.property`; `headless.pointer` answers which scenes it reached; the synthetic
`input_level` draws the input's RMS (was its mean — a sine's mean is 128) and gained `load_ms`.
Added `slow_scene_load_keeps_the_heartbeat`, `min_scene_renders_through_the_worker` (hermetic
real LWE), `missing_or_half_downloaded_scene_fails_cleanly`, `scene_props_apply_at_open_and_live`;
`renderer_build_failure_is_broken_not_a_segfault` uses the `fail-scene` fixture (hermetic) instead
of real scenes with an empty assets dir; `real_scenes_render_and_animate` steps 30 fps of scene
time (three far-apart ticks don't move particles).

**Size: L** (≈ 2 days).

### Task 8: Per-output scene fps and the worker GPU budget

**Files:**
- Create: `src/player/src/scene/budget.rs`
- Modify: `sources/scene.rs` (tick rate = min(demand, budget cap)), `runtime.rs` (every 500 ms: feed each scene's
  budget from the `frames` stats of the outputs showing it + the worker's `gpu_ms`), `redraw.rs` (a scene
  texture change wakes output `<c>` at most `eff(scene_fps, refresh)` times per second), worker `main.rs`
  (`GL_TIME_ELAPSED` query per frame, read back a frame later without waiting → `Frame.gpu_ms`),
  `probe/workers.rs` (`fps_target`, `fps_actual`, `gpu_ms_p50/p95`, `throttle`)

**Interfaces:**
- `eff(scene_fps, refresh) = if scene_fps == 0 { refresh } else { min(scene_fps, refresh) }`.
- `Budget::observe(&mut self, now: Duration, missed_pct: f64, gpu_ms_p50: f64, fps_actual: f64) -> Option<f64>`
  (new cap): throttle when the showing outputs missed > **2 %** of frames over the last 2 s **and**
  `gpu_ms_p50 × fps_actual ≥ 400` ms/s → cap = max(**10**, fps_actual / 2); after **5 s** below **0.5 %** missed,
  cap × 1.25 up to demand. Events `scene.throttled {id, fps_from, fps_to, gpu_ms, missed_pct}` / `scene.unthrottled`.

- [x] **Step 1: Write failing tests:** unit `budget_halves_under_starvation_and_recovers`,
  `budget_ignores_misses_a_light_worker_cannot_cause` (10 % GPU load → never throttles), `budget_floor_is_10`;
  api `per_output_scene_fps_gates_presents` (`--redraw-policy content`, VIRTUAL-1 scene_fps 60, VIRTUAL-2 15, one
  60 fps scene on both → 60 ± 3 and 15 ± 2 presents/s); api `scene_fps_change_is_live_same_pid`.
- [x] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS. (The on-machine numbers are Task 14 step 4.)
- [x] **Step 5:** Commit `Add Scene FPS And Worker GPU Budget`.

**Done (2026-10-28) — with the owner's VRAM decisions folded in** (`.claude/rules/player-core.md`
§ Scene worker → "GPU budget and VRAM (Task 8)"; invariant #7 gained the VRAM hold):
- **As planned:** `scene/budget.rs` (`Budget::observe`, the plan's thresholds; plus `SETTLE` 2 s
  between cuts — the 2 s miss window must hold only frames made at the new rate — and each
  ×1.25 step needs another calm 5 s), tick rate = min(demand, cap) live on the same worker, the
  runtime feeding every 500 ms, the worker's `GL_TIME_ELAPSED` (`gputimer.rs`, read back only
  when available, ≤ 4 queries in flight), the per-output present gate in `redraw.rs` (a grid of
  `1/eff`, an early frame deferred to its slot — never dropped), probe fields (`fps_target` =
  effective, `fps_demand`, `fps_actual`, `gpu_ms_p50/p95`, `throttle`), events
  `scene.throttled` / `scene.unthrottled` (+ `scene.throttle_eased` for a step still below the
  demand).
- **Deviation:** the budget's `missed_pct` also counts the scene's **own** missed frames (< 90 %
  of its tick rate over a whole 2 s window at it): a 30 fps scene on a 144 Hz output presents with
  idle gaps, so the output's paced window never sees its misses; the 400 ms/s GPU-load condition
  still keeps a light worker from ever being throttled.
- **The budget setting:** `player.scene_throttle` (bool, default true; false = fixed fps, a cap
  lifted at once — `scene.unthrottled {reason: off}`).
- **VRAM guard:** `player.scene_vram_limit_mib` (0 = off, default) → a worker over it for 2 s is
  stopped: `scene.vram_exceeded {id, path, pid, used_mib, limit_mib}` + `source.error`
  "stopped: used X MiB > limit Y MiB of VRAM (vram_exceeded)", no restart, no crash record.
  Measured per process: NVML dlopened (never linked) → AMD sysfs + `/proc/<pid>/fdinfo` →
  `nvidia-smi` (its plain process table: `--query-compute-apps` lists compute processes only, never
  a GL client), on the `lp-vram` thread; `LP_PLAYER_VRAM_PROBE=none|fake:<file>|…` (tests).
- **Low-VRAM rule:** `player.vram_low_mode` `stop` (default) | `pause` | `off`; low = free <
  max(512 MiB, 5 %) for 3 s; free again = free − reserve ≥ low + max(1 GiB, 10 %) for 10 s (doubling
  on a re-trigger within 60 s, ≤ 160 s; reserve = what our resumed sources take back); applied as a
  composed player pause (R75/R88 unchanged), `stop` then frees every video/image/scene source
  (stills of their last frames shown, new media nodes wait) and reopens them at their positions on
  release. Events `vram.low`, `vram.stopped`, `vram.recovered`, `vram.resuming`, `vram.resumed`,
  `source.suspended`/`.resumed`; probe `vram`; observed `player.vram_low_active`. Inert under the
  stepped clock. Intel GPUs have no `mem_info_vram_*` → no system total → no rule there (noted).
- **Tests added beyond the plan:** `tests/scene.rs::scene_budget_throttles_live_and_recovers`;
  `tests/api.rs::scene_over_vram_limit_is_stopped_not_crashed`,
  `low_vram_stop_frees_and_resumes_every_source`, `low_vram_pause_mode_pauses_without_freeing`;
  units in `redraw.rs` and `vram.rs` (rule, parsers, fake probe). Every test server runs
  `LP_PLAYER_VRAM_PROBE=none` unless it drives a fake.
- **For Task 11:** the property/event table in player-core § "GPU budget and VRAM (Task 8)" → "For
  Task 11" (also listed under Task 11 below).

**Size: M** (1–1.5 days).

### Task 9: Transitions with scenes — every switch combo

**Files:**
- Modify: `recipes/transition.rs` (align: a lead A whose kind never ends — image, colour, snapshot, **scene** — is
  `Now` at once instead of waiting out `ALIGN_SLACK`), `tests/common/harness.rs` (`Harness::scene(spec)`),
  `tests/transition.rs`, `tests/api.rs`

Nothing else in the recipe is kind-specific: a scene is not a still (reveal/frozen snapshot it via
`SnapshotSource`, which blits the latched dmabuf texture), and `b_has_audio` already goes through
`onset::has_audio` (Task 5).

- [x] **Step 1: Write failing tests** (synthetic scenes, VIRTUAL-1/2, `ao: null`):
  - `v_to_s_each_method`, `s_to_v_each_method`, `s_to_s_each_method` — full-live: both sides keep latching new
    frames, graph `gain.xfade` −3.0103 dB ± 0.05 each at the midpoint; reveal: A shown as a snapshot pixel-identical
    to A's last latched frame, A's worker gets no Tick after `pause_at` (t0 + 45 ms), B's xfade rises sin; frozen:
    B's `time_pos` stays at its start through the effect, rises after handoff + 30 ms ramp; progress 0/1 captures
    equal the plain-source captures (the `effect_progress_endpoints_match_plain_source` property)
  - `align_end_video_a_to_scene_b` (full-live ends at A's `Ended` ± 17 ms; reveal/frozen start at it)
  - unit `scene_lead_a_align_end_starts_now` (started on the first tick, no `transition.align_fallback`)
  - `shared_scene_a_is_untouched` (A also on VIRTUAL-2 outside the request: never paused/ramped; snapshot on VIRTUAL-1)
  - `scene_b_load_error_keeps_a` (missing folder → `transition.failed`, A audible)
  - `scene_b_worker_crash_mid_effect_still_hands_off` (kill B's worker at progress 0.5: B holds, restarts, handoff)
  - `scene_b_broken_mid_effect_snaps_back` (crash loop → broken before handoff → `transition.failed`, A restored)
  - api `scene_switch_storm_reaps_workers` (Review 5: 10 S→S starts 100 ms apart → ≤ 2 unpaused sources per
    output after every tick; 1 s after the last: one live worker, every earlier pid reaped, the 10th current)
  - api `rapid_interrupt_chain_mixed_kinds` (V, S, V, S… 10 starts; invariant #6's assertions)
- [x] **Step 2:** → FAIL (the align one at least). **Step 3:** implement. **Step 4:** → PASS.
- [x] **Step 5:** Commit `Make Every Transition Work With Scenes`.

**Done (2026-10-28) — deviations** (`.claude/rules/player-core.md` § Scene worker → "Transitions
with scenes (Task 9)"): the rule is `never_ends` (still | scene) in `start_instant`, End's
loop-off and `follows_a_end`; the same rule found missing in the runtime's parked path
(`transition_parked`: an `align: end` from a parked scene waited for an output) — fixed +
`tests/api.rs::parked_scene_align_end_hands_off_at_once`. `Harness::scene(name, spec, extra)`
already existed (Task 5). Interpretations: "A's worker gets no Tick after `pause_at`" = none after
the pause *applies* (the recipe pauses on the first tick ≥ t0 + 45 ms; the source learns it at the
next `sync`); a held **video** A's `time_pos` is compared from 150 ms after its pause (mpv presents
queued frames — known, why snapshots exist), a scene A's from the pause itself; "progress 0/1
captures" = progress forced to 0 and 1 mid-effect, the output compared with the plain side
composed in the same iteration (±1); the frozen B "rises after handoff + 30 ms" = at 0 dB at
handoff + 30 ms, then playing. The chains (`mixed_kind_interrupt_chain_every_tick`, harness, and
the api `rapid_interrupt_chain_mixed_kinds`) pick their gaps by condition (one tick / 100 ms /
until Running) — a scene's first frame takes > 100 ms, so plain 100 ms gaps never commit; the
storm keeps the plan's 100 ms. Added: `scene_a_align_end_starts_at_once` (harness, counted in
ticks), `scene_b_load_error_keeps_a` covers the real worker's missing folder plus synthetic
`fail: load`/`fail: build`. Crash tests needed no Task 10 piece (the B's last frame is held, a
broken worker is already a `SourceEvent::Error`).

**Size: M** (1–1.5 days; mostly tests).

### Task 10: Crash policy end to end

**Files:**
- Modify: `sources/scene.rs` (`Restarted` → resume at the last latched `t`; no frame yet → the `preview` image via
  an internal image `MpvSource`; `Broken` → `SourceEvent::Error {reason}` + `source.broken {id, path, scene_id,
  reason, signal|code, restarts, record}`; `ContextLost` (`EGL_NV_robustness_video_memory_purge`/GL context loss in
  the worker) = a crash restart), `snapshot.rs` (a broken scene is saved `broken: true` and restored as its preview,
  no worker), `tests/scene.rs`, `tests/api.rs`, `tests/supervise.rs`

- [x] **Step 1: Write failing tests:**
  - `crash_holds_last_frame_and_resumes_at_position` (kill at t ≈ 3.0: captures identical during the restart; the
    new worker's first frame has t ≥ 3.0 − one tick; `time_pos` continuous within 0.1 s)
  - `crash_before_first_frame_shows_preview` (crash_after_ms 0 on a restored scene → texture = the preview's colour)
  - api `crash_never_touches_other_outputs` (VIRTUAL-1 frame_index video, VIRTUAL-2 scene; 5 kills: VIRTUAL-1's
    markers keep advancing with no repeat > 2 ticks, its gains/paused untouched, `loop` max_busy ≤ 5 ms)
  - `hang_is_killed_and_restarted` (hang knob; `SceneSource` fills `WorkerSpec.hang_timeout` from
    `LP_SCENE_WORKER_HANG_MS` — 300 in tests — else `HANG_TIMEOUT` 2 s)
  - api `broken_after_three_restarts_in_60s` (`source.broken {restarts: 3}`; the record JSON's fields; Error event)
  - supervise `broken_scene_restores_as_preview`; `context_lost_is_a_restart`
- [x] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [x] **Step 5:** Commit `Hold Frames And Restart Crashed Scene Workers`.

**Done (2026-10-28) — deviations** (`.claude/rules/player-core.md` § Scene worker → "Crash
policy (Task 10)"; invariant #9): **resume** = the scene clock stopped at the held frame's `t` from
`Hung`/`Exited`/`Restarted` until a frame of the next worker generation latched, one resume tick at
it (the worker ignores `Start.position` — it renders `Tick.t` — so the clock was the fix; a `position`
set the frame didn't show yet wins); measured first new frame `t` = the held `t` exactly (RED: +0.18 s).
**Preview** = a paused silent image `MpvSource` opened **only** on the crash paths (a worker dies with
no frame on screen, a restored broken scene) — a synchronous ~10–30 ms loop cost there, never on a
normal load; retired (two-phase teardown) at the first worker frame; stepped `Pending("preview")`.
**Broken**: a read-only observed Source prop `broken` (graph + `state`, seeded at create by a restore);
`has_audio` false / `AudioFlowing` immediate once broken (nothing waits on it); `source.broken` gained
`total_restarts`, `uptime_ms`, `shows` (`last_frame|preview|nothing`) — Task 11's shape kept.
**ContextLost**: the worker's context is now robust (`OffscreenOpts::robust`, + the NV video-memory-purge
reset where listed) and polls `glGetGraphicsResetStatus` per frame; the compositor
`kill_for_restart("GL context lost")` → the ordinary restart through the **same** budget (judgement
call: the protocol has no reset kind, so an innocent reset counts too — one suspend/resume is one
restart); hermetic test via a synthetic `context_lost_after_ms` knob, real detection on-machine only.
**Snapshot**: `SourceSnap.broken` (only when true), restored with no worker ever spawned; a source
`Error` now marks the snapshot dirty (a scene that never readied isn't refreshed by the 2 s rule).
**Hang knob** `LP_SCENE_WORKER_HANG_MS` read at each scene's open (unit `hang_timeout_knob`).
Test changes: `hang_is_killed_and_restarted` is an api test (it tests the env knob through `serve`);
`crash_before_first_frame_shows_preview` runs in the harness (not on a restored scene — the restore
is `broken_scene_restores_as_preview`); `context_lost_is_a_restart` is a harness test, not supervise;
`crash_never_touches_other_outputs` kills **4** times (3 restarts, then broken — a 5th has no worker)
and bounds VIRTUAL-1 against its own baseline window (GREEN before Task 10 too: a guard); unit
`broken_scene_is_saved_and_recreated_broken`. **For the backend (not changed here):** a player restart
brings a broken scene back `broken` (preview, no worker) — expected after a restart; replaying the same
item needs a new source (a `transition`), as whitelisting already does; a break can come from repeated
GPU context losses (the record's `reason` starts "GL context lost").

**Size: M** (≈ 1 day).

### Task 11: Backend adapter — scenes playable under lp-player

**Files:**
- Modify: `src/livepaper/Player/PlayerEngine.cs` (`ScenesPlayable(s) = s.AllowScenes && (IsLpPlayer ?
  LpPlayerClient.Shared.ScenesAvailable : PlayerHelper.IsLweAvailable())`), `LpPlayerClient.cs` (capabilities
  from `hello`; `ScenesAvailable` = `scene` capability when connected, else `lp-player scene-check` cached 30 s;
  `Topics` += `source.broken`), `LpPlayerMedia.cs` (`SourceProps`: a scene folder → `kind: "scene"` + `preview` =
  the item's `ThumbnailPath`, `af` ""; `OwnStreamFilter` also matches `node.name` prefix `lp-player-`;
  `ApplySceneFps(LweMonitors)` → `set out:<name>.scene_fps` per entry, queued coalescible `scene_fps:<name>`;
  `OnEvent("source.broken")` → `PlayerHelper.OnSceneBroken(path)`), `Helpers/PlayerHelper.cs` (`Apply(scene)` goes
  through `ScenesPlayable` with lp-player reasons — no WE assets / built `--no-scenes` / scene support off — instead
  of always throwing; `IsSkippedPath` = scene && (!playable || (`HasCrashed` && !`IsWhitelisted`)) (D6);
  `OnSceneBroken(path)`: `LibraryService.MarkCrashed`, `OnSceneCrashed`, and if it is the playing item of a timed
  playlist, advance now (the legacy tick's crash branch); the V→S lead and `SceneTransitionDelayMs` stay
  legacy-only), `Web/ServerHost.cs` (`/settings`: a `LweMonitors` diff → `ApplySceneFps` live; `/player-engine` +
  `scenes {available, reason, assets_dir}`), `app/ui/src/views/Settings.tsx` (under lp-player: hide "Scene
  transition delay" and the primary radio, label the fps "fps (live)"), `Player/LpPlayerSelfTest.cs`,
  `scripts/test-lp-player-adapter.sh`, `.claude/rules/player-adapter.md`

`LweVolume` is read by neither engine (scenes follow Volume / the item override), so there is nothing to port.

**From Task 8 (player side done; wire these live — NOT done in Task 11, a follow-up):** a Settings group "GPU & VRAM" → `set
player.scene_throttle <bool>` (default true; "auto-throttle"), `set player.scene_vram_limit_mib
<MiB>` (0 = off, the default; toggle on → the limit, suggested 1536), `set player.vram_low_mode
stop|pause|off` (default `stop`); per-monitor fps stays `out:<c>.scene_fps` (above). Subscribe
`scene.vram_exceeded {id, path, pid, used_mib, limit_mib}` → like `source.broken` for playback
(advance a rotation / show the preview) but **never** `MarkCrashed`; the UI says "stopped: used X
MiB > limit Y" (also the `source.error` reason, suffix `(vram_exceeded)`). Optional status:
`vram.low` / `vram.resumed`, observed `player.vram_low_active`; the low-VRAM pause is not a user
pause (`player.paused` stays false — don't mirror it into the UI's pause state). Adapter IT: each
setting → `get player.<prop>` live; with `LP_PLAYER_VRAM_PROBE=fake:<file>` a scene over the limit
advances the rotation without a crash mark.

- [x] **Done (2026-10-28), commit `Wire Scene GPU Budget And VRAM Settings`** (`.claude/rules/player-adapter.md` §
  Scenes → "GPU / VRAM settings"): `AppSettings.SceneThrottle` (true), `SceneVramLimitEnabled` (false) +
  `SceneVramLimitMib` (1536, 64–1048576, kept while off), `VramLowMode` (`stop`); `/settings` diff →
  `LpPlayerMedia.ApplyGpuSettings` (coalescible `player:<prop>`), re-asserted per player process with the scene fps;
  `scene.vram_exceeded` subscribed → `PlayerHelper.OnSceneVramStopped` (WS `scene-vram-stopped`, the shared
  `AdvanceIfPlaying`, no `MarkCrashed`); `/player-engine.vram {low_active, mode}`; Settings "GPU / VRAM" (lp-player
  only) + a status-bar line for the WS event. Deviations: the VRAM limit is two settings (a toggle + the MiB value,
  so the toggle keeps the number) rather than one MiB field with 0 = off; the optional `vram.low`/`vram.resumed`
  events are not subscribed — the Settings group polls `/player-engine` (`player.vram_low_active`) every 5 s while
  open instead. RED (adapter IT on the base backend): 12 checks failing; GREEN: all pass.

- [x] **Step 1: Write failing checks:**
  - self-test: `SourceProps` of a scene folder (kind, preview, no af); `OwnStreamFilter` excludes a synthetic
    `pactl` block with `node.name = lp-player-scene.src4`; the `ScenesPlayable` truth table (AllowScenes ×
    capability × engine)
  - adapter IT (hermetic, synthetic scenes, `LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1`): `/apply` a scene →
    `cur:*.kind == scene`, ready ≤ 3 s; `/next` V→S and S→V full-live fades → `transition.handoff`; Volume 50 →
    the scene's `gain.user` −18.06; `/library/volume` on the playing scene moves that source only; NoAudio toggles
    its `no_audio` live, same worker pid; a `LweMonitors` fps change → `out:<c>.scene_fps`, same pid; a crashing
    scene in a timed playlist → WS `scene-crashed`, index `Crashed: true`, advanced ≤ 2 s, skipped by `/next`,
    whitelisted → plays again; missing folder → `transition.failed`, not marked crashed; `AllowScenes=false` →
    `/next` skips scenes; `LP_SCENE_WORKER_BIN=/nonexistent` → scenes skipped and `/player-engine.scenes.available
    == false` with a reason; `/stop` → the worker pid gone ≤ 1 s; the legacy section starts/kills no mpvpaper
- [x] **Step 2:** `bash scripts/test-lp-player-adapter.sh` → the new checks FAIL. **Step 3:** implement.
- [x] **Step 4:** IT → `RESULT pass=N fail=0`; `dotnet run --project src/livepaper -- --lp-player-selftest` → PASS;
  `cd app/ui && npm run build` ok.
- [x] **Step 5:** Commit `Play Scenes Under lp-player In The Backend`.

**Done (2026-10-28) — deviations** (`.claude/rules/player-adapter.md` § Scenes): every player-side name the
task assumed matched the code (`hello.capabilities` `scene`, `kind: "scene"`, `preview`, `out:<c>.scene_fps`,
`lp-player scene-check` `{worker, features, assets_dir, ok, reason}`, worker streams `lp-player-scene.<id>`)
except **`source.broken`, which didn't exist** (Task 10 isn't done): the player now logs it — the minimal
event half of Task 10 (`sources/scene.rs` `log_broken`, `{id, path, scene_id, reason, restarts, record,
signal|code}` from the crash record; `tests/api.rs::source_broken_event_names_the_scene`); Task 10 keeps the
preview fallback, the snapshot's `broken` and the rest. `ScenesAvailable` = the capability from the CURRENT
connection's `hello` (a dropped connection re-greets — a player restarted with another environment), else
`scene-check` cached 30 s. Extra, found while wiring: the tick's LWE crash branch and `UpdateTimedSettings`'s
"scene plays" were `IsLweRunning` checks (always false under lp-player → a scene would have counted as
crashed every tick) — gated / `ScenePlaying`; `DoVideoEndWait`'s lp-player branch now takes scene sides
(`align:"now"` when A is a scene — it never ends); its failure fallback, `ApplyTimedPlaylist`'s first item and
`AdvanceToNext`'s history walk skip a crashed scene (lp-player only — legacy unchanged); `Apply` refuses a
crashed non-whitelisted scene with a message; a scene's `preview` falls back to `preview.gif|webp`. The
plan's `/next V→S and S→V` became V→S, S→S, S→V through `/next` + an aligned V→S at a clip's end; `/library/
volume` "moves that source only" is checked mid-fade between two scenes; the IT exports
`LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1` + `LP_SCENE_WORKER_BIN` for every player (the upgrade test copies the
binary away from its worker) and gained `LP_IT_DLL` (the RED run: the base commit's backend failed every scene
check). Settings also shows `/player-engine.scenes.reason` when scenes can't play.

**Size: L** (≈ 2 days incl. the IT).

### Task 12: UI × player-state matrix — scene cells

**Files:** `scripts/test-ui-matrix.sh` (seed `library/workshop/900000000{1,2,3}/` synthetic scenes into the private
library before the backend starts: s1 red + 440 Hz, s2 blue + 660 Hz, s3 crashing; `AllowScenes=true`;
`LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1` for the private player), `app/shell/probe-matrix.js`,
`scripts/matrix-cells-for.sh` (`sources/scene.rs`, `worker/`, `scene/`, `bin/lp-scene-worker/` → the scene family)

- [x] **Step 1:** Add cells, each with a `ctl`/probe oracle: `apply:scene` (idle/single/playlist), `next:v→s`,
  `next:s→v`, `next:s→s` × TransitionMethod, `pause:scene` (two captures 500 ms apart equal, `gain.pause` −96),
  `mute:scene`, `volume:scene`, `itemVol:scene`, `noAudio:scene`, `trash:playingScene`, `crash:scene` (s3 →
  broken → `crashed` card + strip advanced), `noOutput:scene`, `settings:sceneFps` (same pid, new rate),
  `playlist:sceneInterval` (3 s interval advances off a scene), `restore:scene` (backend restart → same scene).
- [x] **Step 2:** `scripts/test-ui-matrix.sh --changed` → the scene cells run, FAIL where the UI hides scenes.
- [x] **Step 3:** fix what they find. **Step 4:** full matrix green (Phase 1 baseline 681 pass / 28 structural
  skips, plus the new cells).
- [x] **Step 5:** Commit `Cover Scenes In The UI Matrix`.

**Done (2026-10-28)** (`.claude/rules/web-ui.md` § "Scene cells"): 29 scene cells — the plan's list + `itemSpd:scene`,
`settings:sceneThrottle|vramLimit|vramLowMode` (Task 8's settings), `vram:exceeded` (the fake VRAM probe), `trash:
playingScene` in a playlist too. **Deviations:** scene support stays OFF in the baseline settings (with it on, the
library-stepping / random cells landed on scenes nondeterministically, s3 included) — the opt-in scene states
(`scene`, `sceneV`/`sceneS`/`sceneS2` = the playlist [k1, s1, s2, k2] at each) and each scene control turn it on; s3
crashes 1.5 s after every start (not 400 ms: the strip-click switch's 1.2 s fade must hand off first); the interval
cell uses 4 s (3 s raced the checks' settle); `restore:scene` restarts the backend on the same port from the probe
(`LP_PORT`, recorded for the cleanup) — the scene stays on the same worker. **Bugs found + fixed (UI):** a crashed
scene's card wasn't marked until a library reload (WS `scene-crashed` unhandled → now `hasCrashed`); the VRAM stop's
status line was overwritten at once by the now-playing line of the switch it caused (→ a held status); the item
modal hid the speed slider for every scene (legacy's 1× rule) though lp-player plays scenes at speed. Fixture:
previews are 320×180 (a 1×1 PNG made `/still` 502 — ffmpeg can't scale it; real previews never are). Two existing
cells assumed the library held k1–k4 only (`selAll+Delete+undo`'s count, `selRange+Delete`'s neighbour → a title
mapping). RED (scene cells against the base UI): crash card, `itemSpd` slider "not found", the status line;
`playlist × apply:scene` and `playlist:sceneInterval` failed once at load 8 and passed alone and in two later runs.
Full matrix (`--jobs 2`): first 744 pass / 3 fail / 29 skip (the two fixture assumptions, fixed and re-run green); final 745 pass / 1 fail / 1 setup / 29 skip in 32 min at load 4–5.5 — `paused × appear:theme` ("wasn't saved") and `pausedEffect × set:normalizeOff` (state not reached), both passing 2/2 alone and in the first full run (load).

**Size: M** (≈ 1 day + run time).

### Task 13: Scene corpus runner

**Files:** `src/player/tests/onmachine/scene_corpus.sh`, `src/player/tests/onmachine/scene_corpus_report.py`,
`docs/player/reports/scene-corpus.{md,json}`

- [x] **Step 1:** The runner takes `--dir` (default the 431960 folder; **refuses any path under
  `~/.cache/livepaper/steamcmd_workshop`**), picks items whose `project.json` type is `scene`, runs one private
  `serve --headless --outputs 1920x1080@60 --clock real --ao null`, and per scene: cut to it, wait Ready ≤ 20 s,
  capture at +1 s and +4 s, classify `ok` | `static` (identical captures) | `blank` (luma stddev < 2 or ≥ 99 % one
  colour) | `load_failed` | `renderer_failed` | `crashed` | `broken` | `timeout`, and record `ready_ms`, native
  size, worker peak RSS, `gpu_ms_p50`. `--ab-legacy` (on-machine, takes over the session) also screenshots each with
  the installed `linux-wallpaperengine --screenshot` and lists scenes that start there but not here.
- [x] **Step 2:** Run it over the library (96 scenes, ≤ 15 min). **Acceptance (§11.5):** newly failing vs legacy
  = 0, or each one listed with a Phase 6 TODO entry and its log tail.
- [x] **Step 3:** Commit `Add Scene Corpus Runner And First Report`.

**Size: M** (≈ 1 day).

**Done (2026-10-28) — deviations** (`.claude/rules/player-core.md` § Scene worker → "Scene corpus (Task 13)"):
96 scenes in 481 s: **86 ok, 1 static (a still image + a sound — by design), 1 blank, 4 load_failed, 4 broken**,
0 renderer_failed/crashed/timeout (`docs/player/reports/scene-corpus.md`). Every failure reproduces with
`lp-scene-worker --lwe-smoke` (LWE's core alone, no worker/compositor) and is an LWE cause — 3D/perspective
scenes (3), a text `padding` string → an uncaught JSON exception (2), a `CParticle` segfault on embedded leaves
presets (2), a case-mismatched asset path (1), an object dropped when its packaged effect fails to compile (1) —
each a Phase 6 entry in `docs/TODO.md` with its backtrace / log tail in the report. **`--ab-legacy` is implemented
but not run** (it draws on a real output — owner-run: `scene_corpus.sh --ab-legacy --legacy-output DP-1 --reuse
<results>`), so until then every non-ok scene is listed as possibly newly failing (the acceptance's second
branch). Deviations: captures at +1 s, **+2.3 s** and +4 s — `static` needs all three identical (ticks run on a
30 fps grid of scene time, so a loop whose period divides 3 s repeated its +1 s frame at +4 s: a false `static`
in one run); the rates are read before the +4 s capture; no preview on the source (a crash can't pass for a
picture); `ready_ms` = `worker.spawned` → `source.ready`. Three player fixes found by the runs, each with a test:
`probe workers {"log_tail": true}` + `WorkerHost::stop` drains the pipe (a fatal error's own stderr line was lost,
3/3), the worker's soft `RLIMIT_CORE` 1 (the first run's 16 LWE crashes each went through systemd-coredump and a
desktop crash notification; 0 coredumps since), `write_png*` with fdeflate `Fast` (a capture held the loop
820–875 ms for a 3840×1080 frame → 39–112 ms; the stall had made the GPU budget throttle two 4K scenes).

### Task 14: On-machine battery and Phase 2 report

**Files:** `src/player/tests/onmachine/{outputs.sh,dropout.sh,battery.sh}` (scene sections),
`docs/player/reports/phase2.md`

- [x] **Step 1 — outputs:** synthetic + the three spike scenes on DP-1 (143.98 Hz) and DP-2 (239.76 Hz): grim pixels
  non-blank at the overlay layer; paced mean 6.9 ± 0.5 / 4.2 ± 0.5 ms with `scene_fps 0`; worker CPU < 5 %,
  compositor CPU ≤ +1 % per worker vs the video baseline; a cursor warp moves the synthetic pointer_dot; Bunk's
  bars move with a `pw-play` tone on the default sink.
- [x] **Step 2 — dropout:** V→S, S→V, S→S × {full-live, reveal, frozen} × align now, + V→S align end; synthetic tone
  scenes and one SFW scene with audio; 20 switches per cell at 60 Hz and 240 Hz: drops 0, micro_gaps 0, onset check
  (first 10 ms ≤ settled + 6 dB).
- [x] **Step 3 — crash isolation (§11.3):** per-monitor via `ctl` (DP-1 video, DP-2 scene): 5 SIGKILLs, 2 hangs,
  1 crash loop to broken → DP-1 paced p95 within +10 % of baseline and missed ≤ baseline + 1, DP-1 dropout windows
  0 drops; DP-2 holds its frame (grim identical) and recovers ≤ 2 s (real) / ≤ 0.5 s (synthetic).
- [x] **Step 4 — GPU budget:** synthetic gpu_work 3.7 ms/frame at 144 fps on DP-1 → DP-2 paced p95 ≤ 4.6 ms, no
  throttle; 6.2 ms/frame → `scene.throttled` ≤ 4 s and DP-2 paced p95 ≤ 5.0 ms after; record loop tick p99 under
  the heavy worker with explicit sync off (Task 20e's default) — Risk 2's evidence.
- [x] **Step 5 — several workers:** distinct scenes per output + S→S on both: transport ≤ 0.6 % compositor CPU per
  worker (spike: 0.54 %).
- [x] **Step 6 — pause on a scripted scene:** a 431960 scene whose `scene.json` has scripts, paused 10 s → the first
  frame after resume equals the last before (patch 0005).
- [x] **Step 7 — soak:** 1 h mixed playlist (2 videos, 2 synthetic, 2 SFW scenes, 30 s interval, methods rotating):
  compositor RSS slope ≤ 0.5 MiB/min (Phase 1: 0.31), live workers ≤ 2 + dying at every sample, per-worker VRAM
  (`nvidia-smi -q -d PIDS`) flat ± 10 %, no worker after `ctl stop`.
- [x] **Step 8 — owner-run checklist** (documented in the report, not automated): VT switch and suspend/resume with
  a scene playing → it recovers (context lost → restart), the compositor survives.
- [x] **Step 9:** Write `docs/player/reports/phase2.md` (every number above, RED→GREEN for anything fixed); file
  each product finding as its own follow-up task (Task 20 produced 20b–20e). Commit `Report Phase 2 On-Machine Battery`.

**Size: L** (≈ 2 days, plus whatever follow-ups it finds).

**Done (2026-10-29) — `docs/player/reports/phase2.md`.** Battery `src/player/tests/onmachine/scenes.sh` (+
`scenes_steps.sh`, `battery.sh scenes`) rather than sections in `outputs.sh`/`dropout.sh` (its own player, private
real-time PipeWire — no sound reaches the speakers; the visualiser noise goes into that graph, not the default sink).
Steps 1–7 run on the owner's machine, step 8 documented for the owner. Five fixes with tests (scene pacing at the
refresh, the dropout detector's edges, the RT bus meter, the GPU budget over every output, the source mirror), a
corpus-runner fix; open findings in `docs/TODO.md` → "Phase 2 battery findings".


### Task 15: Docs sweep

**Files:** `docs/player/architecture.md` (§2 process model with workers, §4 table rows, §6 roadmap),
`docs/player/invariants.md` (#9 "a worker frame never blocks the compositor" — latch-signalled, enforced by
`latch_never_waits_on_an_unsignalled_fence`; #10 "a worker's audio is a gain on a stream that keeps running"),
`docs/player/debugging.md` (rows: scene black → `probe workers`/`source.error`; scene frozen → `latched` vs
`stale_reuses`; scene silent → bus links + `has_audio`; crash loop → `crashes/*.json`; throttled →
`scene.throttled`), `.claude/rules/player-core.md` (§ Scene worker, § Sources scene rows — each earlier task already
added its own), `CLAUDE.md` (scenes play under lp-player; `LweMonitors` is no longer launch-only there; the new
build dependencies), `docs/TODO.md` (tick Phase 2; add the Phase 6 corpus items and the deferred items below)

- [x] **Step 1:** Update the files; `cargo test -q --test credits` PASS.
- [x] **Step 2:** Commit `Document The Scene Worker`.

**Done (2026-10-28) — deviations:** invariant numbers are **#10** (worker frame never blocks the compositor) and
**#11** (worker audio is a gain on a stream that keeps running) — #9 was taken by Task 10's crash policy. The
architecture doc's "one worker per output" text became "one per scene source, shared by outputs" (D1); the
`player-core.md` Scene worker section got its header/`PROTOCOL` 3 note and the stale "dmabuf imports land on the
`lp-render` thread" sentence corrected (they run on the loop's context). No `CLAUDE.md` claim was wrong; it gained
the Rust/`libclang`/PipeWire build line, the WE `assets/` requirement for lp-player scenes and `--no-scenes`.

**Size: S.**

---

## Risks and fallbacks

1. **LWE beyond the spike's three scenes** (96 in the library): crashes, hangs, leaks or blanks in our embedding.
   *Fallback:* process isolation + the crash policy contain it; Task 13 measures it; failing scenes become Phase 6
   patches; a scene that keeps crashing is marked broken and skipped (D6) — never worse than legacy's "doesn't
   start".
2. **A worker starves the compositor's GPU** (spike: ~90 % GPU for one worker halves the compositor to 120 Hz;
   context priority had no effect). With `__NV_DISABLE_EXPLICIT_SYNC=1` (Task 20e) each compositor swap also waits
   for its own GPU work, which can queue behind a heavy worker. *Fallback:* the budget (Task 8); the 30 fps default
   (D5); explicit sync back once egl-wayland2 > 1.0.2 ships; last resort, a smaller export (cover size × 0.75).
3. **The host audio-driver patch** has to move LWE's decode/queue signalling from SDL's thread to our pull thread
   (est. 150–200 lines; glitch and upstream-drift risk). *Fallback:* patch 0003b — keep SDL output, replace the
   int volume with a float gain ramped per callback (~40 lines), route SDL to the bus by node name; AudioFlowing
   then comes from the first non-empty callback.
4. **Mesa (AMD/Intel) and LINEAR buffers** are untested. *Fallback:* modifier validation + fdpoll; implicit sync is
   never relied on; CPU copy is built only if a real machine needs it.
5. **Build weight:** ~10 extra `-dev` packages per distro, a 69 s / 688 MB RSS LWE build. *Fallback:* `--no-scenes`.
6. **Fetch-at-build (D3):** the pinned commit disappears upstream. *Fallback:* the Nix hash keeps integrity;
   `scripts/lwe.sh` can produce a source tarball to commit or attach to a release.
7. **LWE isn't bit-exact** (particles). Determinism tests use the synthetic renderer only; the corpus uses tolerant
   checks.
8. **If D1 goes per-output:** +1 L task (5b) and roughly double the GPU/VRAM exposure in Risk 2.

## Deferred (not Phase 2)

~~Scene user properties live from the UI (`wp_project_property_set_*`, spec §6.1 "later")~~ (pulled into Phase 2 by
the owner, done 2026-10-28 — see "Decided, round 2"); `g_Daytime` (spike §4.2,
always 0); web wallpapers (Phase 4); scene-compatibility patches from the corpus (Phase 6); auto-mute as a player
Signal (Phase 3 — the worker streams already carry the bus identity it will exclude).
