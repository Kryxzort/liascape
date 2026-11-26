# #48: a first-ever scene load's shader compiles — plan

Research plan for the last open part of `docs/TODO.md` #48: the cost a scene's first-ever load pays to compile its
shaders on NVIDIA. Nothing here is built yet. Fork paths are in the pinned fork (`third_party/lwe/PIN`, rev
`0011f3d`); player paths are under `src/player/`.

## What a first-ever load costs today

`scene_load.py` (`src/player/tests/onmachine/scene_load.py`) separates the loads:

- `cold` empties both shader caches and drops the files from the page cache (the emptying is at line 441);
- `boot` drops the files but keeps the caches.

So `cold − boot` is all the first-ever shader work: the core's WE text passes (`unit`), glslang + SPIRV-Cross
(`glsl`), and NVIDIA's compile and link. Medians from `docs/player/reports/scene-load-we.md` (no spare):

| scene | cold | boot | cold − boot |
|---|---|---|---|
| 3042492564 | 1018 | 517 | 501 |
| 3163060610 | 868 | 509 | 359 |
| 2388299037 | 776 | 543 | 233 |
| 3426575339 | 563 | 508 | 55 |

These gaps are the most any option below can save.

**Inferred split** (not measured; step 1 measures it). 3042492564 builds 253 programs from 68 distinct
vertex + fragment pairs (`docs/player/modules/scene-lwe-core.md` § Shader cache). Two old numbers bear on it:

- With no NVIDIA cache directory at all, a load took ~2.2 s against ~1.1–1.3 s warm (commit `a60dd1f3`). That is
  ~4 ms per program, all 253 compiled.
- Uncached, glslang + SPIRV-Cross took 468 ms (commit `718b0e8b`), ~1.9 ms per pair.

A cold load starts with empty caches, but the caches exist. Each distinct pair is therefore compiled once, and its
repeats in the same build hit the entry just written. That gives roughly:

- NVIDIA: 68 × 4 ≈ 270 ms;
- `glsl`: 68 × 1.9 ≈ 130 ms;
- the rest: text passes and cache writes.

The total is close to the measured 501. So NVIDIA's compiles are probably about half of a first-ever load's extra
cost, not all of it.

**Where the compiles happen.** All on the render thread, one program at a time, inside the renderer build
(`render.rs:259` `first_render`):

- `CPass::setupShaders` (`src/core/WallpaperEngine/Render/Objects/Effects/CPass.cpp:797–888`) runs
  `toGlsl`, then `compileShader` ×2 (`:698–737`, which reads `GL_COMPILE_STATUS` at once), then `glLinkProgram`
  (`:847`). It reads `GL_LINK_STATUS` at once (`:852`), then the uniform locations.
- Every reading of a status waits for the driver to finish that program.
- Each `CPass` owns its program: `new CPass` in `CImage.cpp:1063/1188/1207/1271/1353`, `CParticle.cpp:2302`,
  `CModel.cpp:259/426` and `CLightVolumes.cpp:171`. The destructor deletes the program (`CPass.cpp:64–89`). So a
  pair that 20 passes use is compiled and linked 20 times.

**The phase timer core is gone.** `scene_load.py` sets `WPENGINE_TIMING=1` (line 150) and reads `b_glsl` /
`b_gl_compile` (lines 314–345) from a core "built with phase timers". The pinned fork has no `WPENGINE_TIMING`, and
no copy of that patch is kept. Step 1 brings it back.

## The options

### 1. NVIDIA's shader disk cache (`__GL_SHADER_DISK_CACHE*`)

- **Applies: already in place; no gain for a first-ever load.**
  - `gfx/shader_cache.rs` creates the folder that `__GL_SHADER_DISK_CACHE_PATH` names, because NVIDIA never
    creates it. It runs in `serve` (`runtime.rs:4958`) and in the worker (`main.rs:1482`, and `:165/:170` for the
    smoke and the sweep).
  - The worker inherits the compositor's whole environment (`worker/mod.rs:760–774`), so nothing turns the cache
    off or moves it.
  - The cache only helps a load after the first.
- **How the driver keys it.** It keys the cache by app name. The 595.84 `libnvidia-glcore` holds
  `__GL_SHADER_DISK_CACHE_APP_NAME` and `__GL_SHADER_DISK_CACHE_READ_ONLY_APP_NAME`. NVIDIA's README says the cached
  binaries are "specific to each driver version".
  - On a dev machine one `GLCache/<hash>/` folder holds the worker's programs across dev and Nix builds. So the key
    is the binary's name, not its path, and a rebuild doesn't lose the cache.
  - A driver update does lose it: every scene's next load is then first-ever for NVIDIA's part.
- **Size.**
  - The README states no default. Users report 1 GiB for the `GLCache` default path, and 128 MiB for paths
    containing `/.nv/`.
  - The cache is trimmed when it goes over the limit (`__GL_SHADER_DISK_CACHE_SKIP_CLEANUP` turns that off).
  - The worker's folder holds tens of MB for a played library, so trimming is unlikely.
- **Risks.** A user's `__GL_SHADER_DISK_CACHE=0` (left alone, by design: `shader_cache.rs:12–17`). Setting
  `_APP_NAME` or `_SIZE` ourselves would go against the rule never to change those variables. Nothing to do here.
- **Measure.** A `cold` run with `__GL_SHADER_DISK_CACHE=0` exported for the private player gives the upper bound
  (all 253 programs compiled). Step 1's `cold_nv` gives NVIDIA's real first-ever share.

### 2. `GL_ARB_get_program_binary` / `glProgramBinary` keyed by the unit's text

- **Applies: no gain for a first-ever load.** No binary exists before the first compile, and NVIDIA's disk cache
  already stores the same thing per program text. The driver has the extension (`GL_ARB_get_program_binary` in
  595.84's strings).
- **Expected gain.** Warm only: what NVIDIA's own cache lookup costs over a `glProgramBinary` call. That is small,
  and the warm build isn't compile-bound (#48: the build's tail is texture uploads).
- **Risks.**
  - A third cache to key and invalidate: a binary is refused after a driver update, so every program needs a
    fallback compile.
  - `GL_PROGRAM_BINARY_RETRIEVABLE_HINT` plus a `glGetProgramBinary` per program adds work to the cold load itself.
  - Mesa already caches on its own.
- **Measure (only if ever revisited).** Warm `b_gl_compile` with the timer core, binary path against the plain one,
  in interleaved rounds. **Not recommended.**

### 3. Compile ahead in a hidden worker, at download or idle time (recommended)

- **Applies.** A load fills both caches as a side effect:
  - the core's text cache (`lwe.rs:299–302`, `ShaderCache.h`);
  - NVIDIA's disk cache (same binary name, same environment).

  So a one-shot worker that loads and builds a scene offscreen and exits makes that scene's later first apply a
  `boot`-like load.
- **Why not reuse an existing mode.**
  - The `--shader-sweep` path (`Project::shaderCheck`, `Project.cpp:678–760`) compiles a shader without the
    scene's texture formats, so its GLSL can differ from the real build's (`TEX0FORMAT`, the formats
    `CPass::shaderFormatOf` resolves). It can't fill the right entries.
  - `--lwe-smoke` turns the health report on, which skips cache reads but still renders frames.
  - So the prewarm needs its own worker mode, `--prewarm <scene> --assets <dir> [--prop …]`:
    - `check_folder` → load → the scene's user properties (the same ones an apply sends; combos can depend on them)
      → `first_render` into the 1×1 scratch FBO → `_exit(0)`;
    - no ring, no audio, no video decode, health off.
- **Expected gain.** The whole `cold − boot` gap for the scenes it reaches: 501 / 359 / 233 / 55 ms above. It hides
  all three shader stages, not only NVIDIA's.
- **When it runs.**
  - **At download / import.** The backend asks the player once an item lands (the same item flow that
    `Web/PreviewBackfill.cs` uses for previews made ahead of their cards).
  - **Ahead of a rotation.** For the next scene items of a running rotation (`Programs::rotation_scenes`,
    `recipes/program/mod.rs:1550`, already read by the spare).
  - **At idle, after the driver or the core changes.** The player records what it warmed, keyed by (driver string,
    core build id, scene path, property hash), and re-warms only the library's scenes once either key moves.
  - The player runs it, not the backend: it already has the worker's launch (`sources::scene::launch_for`) and
    environment, so the caches and the app name match by construction.
- **Gates.**
  - The spare's "nothing competes" rule (`worker/spare.rs:121`) plus no low-VRAM hold.
  - At most one prewarm at a time, a low-priority context (the worker's default), and `nice` 19.
  - Killed at once when an apply, transition or spare refill needs the machine (a kill leaves the core's cache
    whole: temp + rename).
- **Risks.**
  - **VRAM and CPU of a full build.** A heavy scene's textures: 2921510865 holds 3.6 GB. The first version caps
    the prewarm at `scene_vram_limit_mib` (a kill, as for a real scene).
    - A follow-up fork patch could add a compile-only build: texture headers read for their formats, and no pixel
      decode or upload, so no VRAM spike.
  - **A kill mid-write of NVIDIA's own files.** Whether a SIGKILL can leave a cache entry the driver rejects or
    trusts is unknown. Prefer quitting between programs: a `Quit` checked by the prewarm loop, then `_exit`.
  - **A scene applied before its prewarm finishes.** The prewarm is killed, and the apply pays the usual cold load.
  - **Rules to update.** Today's rules cap scene workers at one spare (`.claude/rules/player/scenes.md` § Worker
    host lifecycle). A prewarm worker is a new kind of worker: it needs a rule bullet and a `docs/decisions.md`
    entry (why a hidden build, not program binaries).
- **Measure: a new `scene_load.py` mode `prewarmed`.**
  - Empty both caches as `cold` does. Run the prewarm for the scene through the player (a `ctl` command), wait for
    it to end, drop the pages as `boot` does, then apply.
  - Expect `prewarmed ≈ boot` per scene.
  - Record the prewarm's wall time, its CPU time (from `/proc/<pid>/stat` at exit) and its VRAM peak (a
    `vram_mib` poll).
  - Add a `prewarm_busy` mode: start a prewarm of scene X and apply scene Y at once. Y's time must match its plain
    `warm` time (the kill works), and X must still show no crash or restart.

### 4. `KHR_parallel_shader_compile` / `GL_MAX_SHADER_COMPILER_THREADS_KHR`

- **Applies, but only after the fork restructures the build.**
  - 595.84 exposes `GL_KHR_parallel_shader_compile` and `GL_ARB_parallel_shader_compile`.
  - On NVIDIA it makes `glLinkProgram` asynchronous, not `glCompileShader`. An NVIDIA engineer wrote that
    `glCompileShader` "is expected to be synchronous, and to take a very short amount of time".
  - It also stays off until the app calls `glMaxShaderCompilerThreadsKHR` once, even though the initial value is
    0xFFFFFFFF.
  - Source: NVIDIA forum "Bugs with GL_ARB_parallel_shader_compile" (drivers 376–425; no newer word).
  - LWE reads `GL_LINK_STATUS` and the uniform locations right after each link (`CPass.cpp:852–887`), so nothing
    can overlap today.
- **What it takes.** A two-phase build:
  1. Each `CPass` hands its `toGlsl` output to a per-build program registry, and the registry submits every link.
  2. After the scene graph is built, before `first_render`'s draw, each pass finishes: link status, uniform
     locations, attributes.

  The registry also dedupes byte-equal pairs (option 5).
  - Variant without the extension: link on worker threads that each hold a shared context, as the texture upload
    context does (`wp-tex-upload`, `scene-lwe-core.md` § Texture uploads). A program is visible across a share
    group once a fence says its link finished.
- **Expected gain.** Cold only: NVIDIA's distinct-program share, ~270 ms inferred for 3042492564, divided by the
  threads the driver uses. At best ~150–220 ms there and proportionally less on the others. `glsl` (~130 ms) can
  run on a CPU pool in the same restructure.
  - It moves the first frame only while the render thread is the build's tail. Cold it likely is (`cold − boot` is
    larger than any texture time); warm it isn't. The preprocessing cache saved 20 ms of render thread and didn't
    move the first frame (#48).
- **Risks.**
  - A large fork change across every pass kind (images, particles, models, light volumes, `CWallpaper`'s final
    program, `CScene`'s fade program).
  - The old driver bug where `GL_COMPLETION_STATUS` never turns true: poll it with a bound, then fall back to a
    blocking `GL_LINK_STATUS`.
  - Driver threads compete with the texture upload thread and with the desktop.
  - The worker's `LoadGate` watches only the render thread's CPU time past the 30 s bound
    (`scene-worker.md` § The worker binary). A render thread that sleeps while driver threads link could read as
    stalled on a saturated machine: count the process's CPU time there.
- **Measure.**
  - The timer core's `b_gl_compile` and `b_glsl`, and `total`, `cold` and `cold_nv` (step 1), base against new,
    interleaved as in commit `3f1940e4`: alternating `--bin`, ≥ 10 cold loads per scene and build, with
    `--keep-pages` too to take the disk out.
  - Plus `--capture`: the first frames must match the base's as closely as two base runs match each other.

### 5. Fewer programs compiled

- **Applies.**
  - WE's combos are not ours to reduce: each one changes the code, and WE compiles per combo as well.
  - What we can cut is repeats: 253 programs from 68 distinct pairs in 3042492564.
  - A per-context program registry, keyed by the two GLSL texts and refcounted in `~CPass`, gives each distinct
    pair one compile and one link.
  - Sharing a program is safe for uniforms: `CPass::render` re-sends every uniform it owns at each draw
    (`setupRenderUniforms`, `CPass.cpp:449–480`, and the reference uniforms at `:412`), samplers included
    (`g_Texture0..7`, `:1048`).
  - Check before relying on it: that no pass sets a uniform only at setup, and that a uniform one pass leaves at its
    default isn't set by another pass sharing the program.
- **Expected gain.**
  - Cold: small if NVIDIA already serves the repeats from the entries the same build just wrote, which the
    measured cold gap suggests.
  - Warm: whatever 185 cache-hit compile + link calls cost.
  - Both unknown; the timer core gives the upper bound (the time spent on repeated pairs).
  - It is also the first step of option 4.
- **Risks.**
  - Program lifetime across scene teardown and context loss.
  - The `#if !NDEBUG` object labels would name the program after its first pass only.
- **Measure.** The timer core's `b_gl_compile` and `build`, warm and cold, base against new, interleaved, with
  `--capture` checks.

## Recommendation

1. **Measure the split first.** This needs no fork change for its first half.
   - Add `--cold-caches nv|lwe|both` to `scene_load.py`: which of the two folders `cold` empties (line 441). Run
     `cold_nv` (NVIDIA's empty, the text cache kept) and `cold_lwe` (the reverse) against `boot` for the four
     scenes, `--keep-pages` and not. That splits each `cold − boot` gap into NVIDIA's and the core's shares.
   - Bring the phase timers back as a fork patch gated like the health report (one relaxed atomic load when off):
     `io`, `shader_text`, `glsl`, `gl_compile`, `texture`, `texture_finish`, `first_draw`, `build_total`. These
     are the names `phases()` reads. Add the counts of programs and distinct pairs.
   - Log whether the context has `GL_KHR_parallel_shader_compile` in the worker's log at the context setup.
2. **Build option 3, the prewarm.** It is the only option that removes the whole first-ever cost (233–501 ms for
   the three image scenes) whatever the vendor or driver, and it re-warms after a driver update or a pin bump, which
   reset NVIDIA's cache and the core's text cache.
3. **Then options 5 + 4 together,** only if step 1 shows NVIDIA's cold share at ≥ ~150 ms on at least two of the
   three scenes. They cover what a prewarm can't reach: a scene applied right after it downloads. Option 5 lands
   first: it is small, safe, and the registry option 4 needs.
4. **Drop option 2.** Option 1 needs no change.

## Done when

- `scene_load.py`'s `prewarmed` medians are within the `boot` medians' p25–p75 for 3042492564, 3163060610 and
  2388299037.
- A `prewarm_busy` apply is no slower than `warm`.
- The new rule bullets, a `docs/decisions.md` entry and `scene-lwe-core.md` § Shader cache are updated, and this
  file is deleted in the commit that finishes the work.
