<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

### Frame transport (Task 4)

The spike's mechanism (`dmabuf.md` §2, §9), reproduced: a worker-owned ring of **3**
`GL_RGBA8` textures exported once, imported once, `sync_file` fences both ways, and the
compositor **latches only the newest frame whose acquire fence has already signalled**.

**GPU side (`gfx/dmabuf.rs`, methods on `Gfx` — its own file, not `egl.rs`, which other
Phase 2 work also extends; `Gfx::egl_parts()` is the crate-private accessor it uses).**
`export_dmabuf(&Tex) -> Exported {desc, fds, image}` (`eglCreateImage(EGL_GL_TEXTURE_2D)` →
`eglExportDMABUFImageQueryMESA` + `eglExportDMABUFImageMESA`; one fd per plane even when
NVIDIA returns the same fd twice; the `EglImage` is kept with the slot, like the spike's
producer — returning it is a deviation from the plan's `-> DmabufDesc`). `import_dmabuf(&DmabufDesc,
fds) -> ImportedTex` (`eglCreateImage(EGL_LINUX_DMA_BUF_EXT, EGL_NO_CONTEXT)` with
`MODIFIER_LO/HI` per plane, then `glEGLImageTargetTexture2DOES` on a fresh texture with the
`Gfx::tex` defaults — LINEAR, CLAMP_TO_EDGE; the fds are closed after, the image holds its
own reference; `ImportedTex` deletes its texture on its own context (`GlKeepAlive`) and then
hands the image to **`free_image_off_thread`** — TODO F5 (2): one `lia-egl-free` thread, started
on first use, destroys it, never the loop. On NVIDIA an import's `eglDestroyImage` frees/unmaps
the memory through the kernel driver's resource manager, whose ioctls all take **one global lock**
(`rmapiLockAcquire`, an rwsem shared by every process on the GPU); while another process
allocates or frees, the destroy sleeps on it — 0.2–1.4 ms per image on the loop, a dying scene
has 3–6 (off-CPU stacks, below). A destroy never races an `eglTerminate` (both under the display
lifecycle lock), and one queued before a terminate is skipped (`egl::DISPLAY_EPOCH`: the
terminate freed it; its handle may name another image now). `probe workers` →
`images_freeing`. **The import itself stays on the loop** and sleeps on the same lock
(`eglCreateImage` → `rmapiControl`/`rmapiFree`, 0.2–4 ms per slot under contention, a ring is 3
slots on create and on every resize); it runs in `runtime::driver_call`, whose sleeps the `loop`
probe reports as `driver_blocked_ms` and leaves out of `max_busy_self_ms` — a driver limit, see
TODO F5. Moving it off the loop means an async import (`eglCreateImage` on a helper thread, the
ring's `frame`s deferred until it lands); the first composite of a fresh texture in a process
also maps it under that lock (`BlitProgram::draw` → `rmapiMap`/`rmapiDupObject`, seen in the
warm-up only). `dmabuf_modifiers(fourcc) -> [(modifier, external_only)]`
(`eglQueryDmaBufModifiersEXT`; empty without it). `native_fence()` (`eglCreateSync(
EGL_SYNC_NATIVE_FENCE_ANDROID)` + **`glFlush` before** `eglDupNativeFenceFDANDROID`; never
waits). `gpu_wait_fence(fd)` (`eglWaitSync`: the GPU waits, never the CPU; EGL owns the fd,
closed here on failure). `has_native_fences()`, `has_display_ext(ext)`. Every extension
entry point is looked up once per process (`OnceLock`). `DRM_FORMAT_ABGR8888` = `AB24`;
`gfx::dmabuf::Plane` is also `proto::Plane`.

**Context priority (`EGL_IMG_context_priority`).** `Gfx::new_offscreen_with(OffscreenOpts
{priority: Option<Priority>})`: the scene worker asks for **`Low`** (where the display lists
the extension; a refusal with the attribute retries without), logged `gfx.context_priority
{requested, granted, path}` and as `gfx: context priority requested low, granted low` in the
worker's log tail. **The compositor's contexts (`new_offscreen()`, `new_wayland()`,
`share_context`) keep the driver default** (`Medium` here), not the plan's `High`: tried, the
render worker's `render_worker_never_composes_a_torn_frame` read 13–72 capture rounds with
`High` vs 21–53 without on a machine at load ~21 — indistinguishable from load, and the spike
saw no effect either, so the Phase 1 contexts stay as they were and only the worker is
lowered (the ordering the spike wanted). `Gfx::context_priority()` = what was granted
(`eglQueryContext`). Test `worker_context_is_low_priority`. **That api test is
load-sensitive** (its distinct-capture bound failed once with the compositor exactly as on the
base commit) — rerun it on a quiet machine before blaming a change.

**The worker's renderer (`liascape-scene-worker` without `--stub`).** `hello {features:
[synthetic] (+ lwe), sync}` — `sync: fdpoll` when `LIASCAPE_SCENE_SYNC=fdpoll` or the display
lacks `EGL_ANDROID_native_fence_sync`, else `fence`; then a log line with the granted
priority. `start`: not `synthetic` → a real WE scene through LWE (§ "Real scenes (Task 7)";
built without LWE → a **fatal** error); `synthetic` without `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1` in its env → fatal;
`<path>/liascape-synthetic.json` unreadable or `fail: load` → fatal; `fail: build` → fatal; else
ring of 3 at `scene::cover_size(native, max_size)` → three `buffer` messages → `ready
{native, has_audio, wants_audio_input}`. A fatal error leaves it idle until `quit`. `tick`
→ the newest pending tick is rendered (older ones are answered by its `frame`: the host's
heartbeat pops every seq ≤ it) into a slot the compositor doesn't hold, after waiting on
that slot's release fence (`fence`: `eglWaitSync`; `fdpoll`: `poll` ≤ 1 s); no free slot →
it waits for a `release`. Then **alpha forced to 1** (colour mask alpha-only + clear —
LWE's core leaves 0 in every pixel) and `frame {slot, seq, t}` + an acquire fence, or in
`fdpoll` the worker `poll`s its own fence (≤ 2 s) and sends no fd; no native fence at all →
a bounded `glClientWaitSync` — **never `glFinish`** (spike §5: it spins a core under load).
No flip (R25: image top at texture row 0). Slot ids are unique per worker lifetime (0, 1,
2, then 3… for a re-export) so a later ring can't be confused with this one; `resize`
re-exports the ring (Task 5, below). `gpu_ms` = the worker's `GL_TIME_ELAPSED` of an earlier
frame, never waited for (Task 8, § "GPU budget and VRAM"). Synthetic and env knobs (`crash_after_ms`,
`hang_after_ms`, `gpu_stall`) both apply.

**Compositor side: `worker/dmabuf.rs` + `sources/scene.rs`.**
- `validate_modifier(fourcc, modifier, table)`: refuses a modifier the display can't sample
  as `GL_TEXTURE_2D` — absent, or **external-only (LINEAR on NVIDIA)** — with an error naming
  `docs/player/spikes/dmabuf.md §1`; an empty table (no query extension) lets the import
  decide. Unit `external_only_modifier_is_refused`.
- `ImportedRing {generation}` — one worker process's slots, imported once each (validated
  first). `Latch` — `push(slot, seq, t, acquire)` per `frame`; `latch(release_fence)` picks
  the **newest queued frame whose fd polls readable** (no fd = fdpoll = ready); older queued
  ones are released **without** a fence (never sampled); the previously latched slot is
  released with `release_fence()` created right then (it orders after every draw that
  sampled it); the latched frame's (already signalled) acquire fd comes back only to leave
  the source's epoll set — **no `gpu_wait_fence`** (F6b: the spike's "free safety net" was ~10
  syscalls and a semaphore ioctl per frame on NVIDIA; a fence that polls readable is done), and
  a `Frame` whose fence has already signalled is queued without it (`fence_signalled`).
  Nothing ready → `stale_reuses` += 1, the previous
  frame stays (never black, never a wait). `forget_worker()` (a restart): queued frames
  dropped, the shown frame kept but marked never-to-be-released (the new worker never had
  that slot), `generation` + 1. Units `latch_takes_newest_signalled_and_releases_the_rest`,
  `forget_worker_keeps_the_frame_and_never_releases_it` (pipes as fences). **`gen` is a
  reserved keyword in edition 2024** — the field is `generation`.
- `SceneSource` (Task 4: the texture path, driven directly; Task 5 makes it a graph
  `Source`). `SceneOpts::new(path, worker_bin)` (30 ticks/s, 1920×1080 demand, LWE, …;
  tests: `synthetic`, `tick_hz` 144, the env gate, a private crash dir). `open` **refuses a
  display without `EGL_EXT_image_dma_buf_import(_modifiers)`, `EGL_ANDROID_native_fence_sync`
  or `EGL_KHR_wait_sync`** (no CPU-copy path is built — spike §5) and spawns the worker (from
  a long-lived thread: PDEATHSIG). `update(gfx)` never blocks: `host.poll` → `buffer`s
  imported into the current generation's ring (an import/validation error is `error()`), `frame`s
  pushed, `ready` starts ticking, a fatal worker `error` → `error()` + `host.stop()`; then one
  `latch` (old generations' rings dropped at the first latch of a newer one;
  `set_resume_position(t)` of every latched frame, so a restart resumes there); releases sent;
  then at most one `tick {seq, t}` when due at `tick_hz`, **≤ `MAX_INFLIGHT` 2 unanswered**,
  skip-ahead when behind (never a burst). Scene time = `position` + wall time since open (Task
  5: the pause-excised clock). `texture()` = the latched slot — **it survives the worker's
  death** (spike §6) and, after a restart, stays the dead worker's frame until the new
  worker's first frame latches. `broken()` (budget spent; mapped to `Error` + `source.broken`, Task 10) is
  separate from `error()` (can't play). `stats()` (`latched`, `stale_reuses`, `superseded`,
  `queued`, `ticks_sent`, `frames_received`, `tick_send_failures`, `restarts`, `rings`,
  `latched_gen`), `latencies_ms()` (last 1024 tick → latch), `wake_fd()`, `pid()`,
  `size()` (export size), `native()`, `sync()`, `log_tail()`.
- `scene::cover_size(native, demand)` — aspect kept, smallest size covering `demand`
  (rounded; never under it on either axis), never above native, long edge ≤ 4096. Unit
  `cover_size_examples` (the plan's five + portrait, the cap, degenerate input).
- `scene::synthetic::SyntheticSpec` (`liascape-synthetic.json`, every field defaulted): `pattern`
  `frame_index` (top-left 64² = `marker_rgb(seq)` = `(seq & 255, seq >> 8 & 255, 0)`, bottom-
  right 16² = `grad_rgb(x, y, seq)`, rest grey 32) | `solid` | `split_tb` (top `rgb`, bottom
  `rgb2`) | `pointer_dot` | `input_level`; `native`, `alpha` (drawn with it; the worker forces
  1), `gpu_work` (a pixel-neutral loop: 2500 ≈ 3 ms, 4000 ≈ 6 ms per 1080p frame here),
  `tone_*`/`has_audio` (Task 6), `crash_after_ms`, `hang_after_ms`, `fail: load|build`,
  `gpu_stall: [after_ms, for_ms]` (frames in that window carry a stand-in acquire fence — a pipe,
  written when the window ends, after the real fence was waited for — as if the GPU finished
  nothing: the compositor latches none and starves the worker; the 2026-10-29 suspend false-hang).
  `tests/common::synthetic_scene(name, &spec)` writes `target/test-media/scenes/<name>/`
  (`project.json` type scene, 16-byte `scene.pkg`, 1×1 `preview.png`, `liascape-synthetic.json`).

**Measured** (`tests/scene.rs::transport_meets_the_spike_budget`, 5 s per config, 1920×1080,
144 ticks/s, every latched frame read back and checked; RTX 3070 Ti / NVIDIA 595.84, the
machine shared with other agents' tests; the spike's numbers for comparison):

| config | delivered fps | stale / torn / out-of-order | worker CPU | compositor `update` CPU | tick → latch p50 / p99 |
|---|---|---|---|---|---|
| trivial frame | **143.98** (spike 143.98) | **0 / 0 / 0** | **1.60 %** (1.48) | **1.77 %** (transport ≈ 0.54 % of 4.04) | 1.18 / 1.41 ms (incl. the test loop's 1 ms poll) |
| ~3 ms GPU per frame (`gpu_work` 2500) | **143.98** (144.00 at 3.7 ms) | **0 / 0 / 0** | 1.60 % (1.38) | 1.81 % | 4.21 / 5.25 ms |

**What the worker's CPU figure is (2026-10-28, the test's red full-suite runs settled).** The
same work — a constant **175–178 k user instructions and 4 wake-ups per frame** (debug worker;
~102 k release) — read anywhere from 2.1 to 25 % of a core, because CPU time per frame is set by
the machine, not the worker: **core type** (pinned: 214–231 µs a frame on a P-core, 276–290 on an
E-core of this i9-12900K — unpinned runs land in between), **clock** (`powersave`/HWP: the cores of
a light periodic load sit at 0.8–1.4 GHz on a quiet machine — 350 k user cycles a frame read 7.6 %
at load 3, 3.0 % when other load kept the clocks up) and **memory contention** (12
memory-streaming processes: the same 175 k instructions in 5.4 M user cycles, 25 %). Per-thread
(P-core, debug, load ~4): renderer 2.0–2.3 %, `lia-scene-proto` 0.9 % (Task 7's protocol thread:
one extra hop per message — the bulk of the growth since Task 4's 1.6 %; it is what answers pings
during a load), `lia-scene-audio` 0.06 % (now gone for a soundless scene, § "Scene audio").
Feature A/B (P-core, 2 × 5 s each, instructions per frame): the `GL_TIME_ELAPSED` query 7 k
(~11 µs, ≈ 0.15 %), `glGetGraphicsResetStatus` 0, the idle audio thread 0 instructions (0.06 %
CPU); log-tail reading is the compositor's, loudness segments exist only for a stream. GPU
contention (a second worker at `gpu_work` 6000) +20 %. So the test now measures the cost of the
work: the worker pinned to the P-cores (`performance_cores`, `/sys/devices/cpu_core/cpus`),
`schedstat` ns per thread, the **median of 1 s windows** over ≥ 5 s (up to 15 s while over
budget); it asserts the work — user instructions per frame < 250 k (`perf_event_open`, 1.4× the
measured) and voluntary wake-ups < 4.5 — and the CPU budget; a CPU figure over budget with that
work in budget is printed as `MACHINE, NOT WORK` (with the cycles) rather than failed — on a
machine without counters the CPU budget must hold as measured. The compositor's `update` cost is
this thread's CPU time (`CLOCK_THREAD_CPUTIME_ID`, preemption excluded), judged the same way.

Under ~6 ms of GPU per frame (`latch_never_waits_on_an_unsignalled_fence`, 2212 updates in
2 s): `update` p50 10 µs, p99 78 µs, max 103 µs, 1935 stale reuses — the latch never waits.
`transport_never_shows_stale_torn_or_out_of_order`: 600 of 600 ticks latched, 0 bad. Four
workers at once: `update` cost 48 µs per iteration vs 21 µs for one (≤ 4.5× asserted).
Negative control (mutation: every queued frame treated as ready, no `gpu_wait_fence`): the
transport test went RED at once — `frame 143: marker [141, 0, 0]`, the slot's previous
frame, exactly the spike's `nosync` signature.

**Tests (`tests/scene.rs`, GPU; SKIP without EGL; one at a time — a process lock — so their
rate/timing assertions don't fight each other):** `transport_never_shows_stale_torn_or_out_of_order`,
`latch_never_waits_on_an_unsignalled_fence` (asserts p99 ≤ 1 ms and max < 4 ms — "every update
≤ 1 ms" from the plan, robust to scheduler noise on a shared machine; a fence wait would cost a
frame's GPU time, ~6 ms), `killed_worker_keeps_last_frame` (zero budget: SIGKILL → 20
readbacks over 2 s identical, same texture), `restart_replaces_ring_after_first_new_frame`
(same texture + pixels until the new generation latches, then a new texture, one ring, seq
continues), `fdpoll_fallback_is_equally_correct` (300 frames), `scene_texture_holds_image_top_at_t0`,
`scene_frame_is_opaque`, `huge_native_scene_exports_at_cover_size` (7467×4200 → 1920×1080),
`four_workers_latch_independently` (a wall-time ratio of `update` costs: load-sensitive, failed
once 269 vs 57 µs in a full run, passed alone), `transport_meets_the_spike_budget`,
`audio_thread_only_for_a_scene_with_sound`, `context_priorities_compositor_high_worker_low`.

**What Task 5 builds on:** (done — § "The `scene` Source kind (Task 5)" below).
