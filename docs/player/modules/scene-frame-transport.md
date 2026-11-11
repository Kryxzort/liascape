# Scene frame transport (dmabuf + fences)

Covers `src/player/src/gfx/dmabuf.rs`, `src/player/src/worker/dmabuf.rs` (`ImportedRing`, `Latch`), the frame path
of `src/player/src/sources/scene.rs` and the worker's renderer loop. Rules: `.claude/rules/player/scenes.md` § Frame
transport. Evidence and the CPU-copy alternative it rules out: `docs/player/spikes/dmabuf.md`.

A worker-owned ring of 3 `GL_RGBA8` textures is exported once, imported once, and synchronised with `sync_file`
fences both ways. The compositor latches only the newest frame whose acquire fence has already signalled.

## GPU side (`gfx/dmabuf.rs`, methods on `Gfx`)

- `export_dmabuf` (`eglCreateImage(GL_TEXTURE_2D)` → `eglExportDMABUFImage*MESA`; one fd per plane even when NVIDIA
  returns the same fd twice; the image is kept with the slot). `import_dmabuf` (`EGL_LINUX_DMA_BUF_EXT` with the
  modifier per plane, then `glEGLImageTargetTexture2DOES` on a fresh texture; the fds are closed after, the image
  holds its own reference). `native_fence()` flushes before `eglDupNativeFenceFDANDROID` and never waits.
  Extension entry points are looked up once per process.
- **Destroying an import never runs on the loop** (`free_image_off_thread`, thread `lia-egl-free`). On NVIDIA an
  image's `eglDestroyImage` frees through the kernel driver's resource manager, whose ioctls all take one global lock
  shared by every process on the GPU: while another process allocates, the destroy sleeps — 0.2–1.4 ms per image,
  and a dying scene has 3–6. A destroy queued before an `eglTerminate` is skipped (`DISPLAY_EPOCH`: the terminate
  freed it and the handle may name another image now).
- **The import stays on the loop** and sleeps on the same lock (0.2–4 ms per slot under contention; 3 slots on
  create and on every resize). It runs inside `runtime::driver_call`, so the `loop` probe reports those sleeps as
  `driver_blocked_ms` apart from the loop's own time. Moving it off would need an async import with the ring's frames
  deferred until it lands.
- `validate_modifier` refuses a modifier the display can't sample as `GL_TEXTURE_2D` — absent, or external-only
  (LINEAR on NVIDIA). An empty modifier table (no query extension) lets the import decide.

## Context priority

The worker asks for a low-priority context (`EGL_IMG_context_priority`, retried without the attribute when refused;
`gfx.context_priority` logs what was granted). The compositor's contexts keep the driver default: `High` there was
indistinguishable from load in the render-worker torn-frame test, and the spike saw no effect either, so only the
worker is lowered.

## Worker side

`tick` renders the newest pending tick (older ones are answered by its `frame`: the heartbeat pops every seq ≤ it)
into a slot the compositor doesn't hold, after waiting on that slot's release fence on the GPU (`fence`:
`eglWaitSync`; `fdpoll`: `poll` ≤ 1 s). No free slot → it waits for a `release`. Then alpha is forced to 1 (LWE
leaves 0 everywhere) and `frame {slot, seq, t, gpu_ms}` goes out with an acquire fence. In `fdpoll` mode
(`LIASCAPE_SCENE_SYNC=fdpoll`, or no native fence sync) the worker polls its own fence (≤ 2 s) and sends no fd.
Never `glFinish` — it spins a core under load. No flip: the image top is at texture row 0. Slot ids are unique per
worker lifetime (0, 1, 2, then 3… for a re-export) so a later ring can't be confused with this one.

## Compositor side

- `ImportedRing {generation}` holds one worker process's slots. `Latch::latch` picks the newest queued frame whose
  fd polls readable (no fd = fdpoll = ready), releases older queued ones without a fence (never sampled), and
  releases the previously latched slot with a fresh release fence that orders after every draw that sampled it.
  Nothing ready → the previous frame stays (`stale_reuses`), never black, never a wait. No `eglWaitSync` on a fence
  that already polls readable: the spike's "free safety net" cost ~10 syscalls and a semaphore ioctl per frame on
  NVIDIA.
- Each queued frame's acquire fence joins the source's epoll set one-shot, so a signalled fence wakes the loop once
  — a stepped loop has no timer, and without it a frame whose fence hadn't signalled at its `Frame` latched only at
  the step's 2 s deadline.
- After a restart `forget_worker()` drops queued frames and keeps the shown one, never releasing it (the new worker
  never had that slot); the texture survives the worker's death and stays until the new worker's first frame latches.
- `SceneSource::update` sends at most one `tick` when due, ≤ `MAX_INFLIGHT` (2) unanswered, skipping ahead when
  behind (never a burst).
- A `resize` re-exports a new ring into the same generation; once a frame of the new set latched, the other slots
  go (`ImportedRing::retain_slots`). A dmabuf lives while anyone holds it, so the old ring's memory stays until then
  and the texture is never `None` in between.

`scene::cover_size(native, demand)` = the smallest aspect-kept size covering the demand on both axes, never above
native, long edge ≤ 4096.

## Measured

RTX 3070 Ti, NVIDIA 595, 1920×1080 at 144 ticks/s, every latched frame read back and checked:

| config | delivered fps | stale / torn / out-of-order | tick → latch p50 / p99 |
|---|---|---|---|
| trivial frame | 143.98 | 0 / 0 / 0 | 1.18 / 1.41 ms |
| ~3 ms GPU per frame | 143.98 | 0 / 0 / 0 | 4.21 / 5.25 ms |

Under ~6 ms of GPU per frame the compositor's `update` stays p50 10 µs, p99 78 µs, max 103 µs (the latch never
waits). Four workers at once cost 48 µs per iteration vs 21 µs for one. A mutation that treats every queued frame as
ready shows the slot's previous frame at once — the spike's no-sync signature.

**The worker's CPU figure measures the machine, not the work.** The same ~175 k user instructions and 4 wake-ups
per frame (debug worker; ~102 k release) read 2–25 % of a core depending on core type (P vs E core on the
i9-12900K), clock (`powersave` keeps a light periodic load at 0.8–1.4 GHz) and memory contention. The transport test
therefore pins the worker to the P-cores, takes the median of 1 s windows and asserts instructions per frame
(< 250 k via `perf_event_open`) and wake-ups; a CPU figure over budget with the work in budget prints
`MACHINE, NOT WORK`. Per frame, the `GL_TIME_ELAPSED` query costs ~7 k instructions (~11 µs).

What a scene frame still costs the compositor is the transport itself: the `Frame` `recvmsg`, the `Tick` and
`Release` `sendmsg`s and the release fence (NVIDIA's `eglCreateSync` + `eglDupNativeFenceFDANDROID` alone is ~12
syscalls plus a semaphore ioctl) — about 29 main-thread syscalls per worker frame. A worker thread that waits for
each fence and sends the `Frame` after it (one compositor wake per frame instead of ~1.5) was tried and dropped: no
gain once a wake was cheap, for two more worker context switches per frame.
