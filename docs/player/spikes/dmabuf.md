# Spike (b): GPU frame sharing, worker → compositor, on NVIDIA proprietary

## Context

- Status: done 2026-10-20.
- Spec: `docs/superpowers/specs/2026-10-20-utopia-player-design.md` §4.1, §5.2, §6.3, §12.
- Code (throwaway): `spikes/dmabuf/`. It contains `producer.c`, `consumer.c`, `common.h`, `run.sh` and `README.md`.
- Machine:
  - NixOS, Hyprland 0.56.2, kernel 7.1.3-cachyos
  - RTX 3070 Ti, **NVIDIA 595.84** (open kernel module + proprietary userspace)
  - i9-12900K, gcc 15.2
- Test output: **DP-2 1920×1080 @ 239.76 Hz**, primary. The consumer's layer surface sat at layer BOTTOM, over
  the desktop and under windows. It was removed after every run.
- The producer renders at **144 fps**, the spec's target rate. It is paced by its own `CLOCK_MONOTONIC` timer.
- **The legacy wallpaper was stopped** for the final battery, as the owner instructed:
  - `curl -X POST 127.0.0.1:5174/stop`; `pgrep -x mpvpaper` was empty before and after.
  - An earlier full battery ran while mpvpaper was playing on both outputs. §8 compares the two. The
    conclusions are the same.
  - mpvpaper is left stopped.

## Verdict: **GO**. dmabuf + sync_file fences, and the compositor latches only frames whose fence has signaled

**Chosen mechanism.** Every call it needs exists on NVIDIA 595.84 and works across processes. Per worker:

1. **Export, once per ring buffer.** The worker renders into a ring of **3** `GL_RGBA8` textures. Each one is
   exported once:
   - `eglCreateImage(EGL_GL_TEXTURE_2D)` → `eglExportDMABUFImageQueryMESA` / `eglExportDMABUFImageMESA`
   - the result: 1 plane, `DRM_FORMAT_ABGR8888` (`AB24`), NVIDIA block-linear modifier `0x0300000000e08014`,
     stride 7680
2. **Import, once.** The fds go over a unix socket with `SCM_RIGHTS`. The compositor imports each one once:
   - `eglCreateImage(EGL_LINUX_DMA_BUF_EXT)` with the modifier, then `glEGLImageTargetTexture2DOES`
   - this takes 0.04–0.4 ms per buffer
3. **Per frame:**
   - The worker sends `{slot, n, timestamp}` plus an **acquire fence fd** made with
     `eglCreateSync(EGL_SYNC_NATIVE_FENCE_ANDROID)` + `glFlush` + `eglDupNativeFenceFDANDROID`.
   - The compositor **latches a frame only once its sync_file polls readable** (`--latch signaled`). Until then
     it keeps showing the previous frame. It still imports the fence and calls `eglWaitSync`, which is a no-op at
     that point.
   - When the compositor stops sampling a slot, it returns a **release fence fd**. The worker makes its GPU
     `eglWaitSync` on that fence before rendering into the slot again.

**Pass criteria (brief):** ≥ 143 fps delivered, 0 out-of-order frames, < 5 % CPU in each process.

| config (60 s each) | delivered fps | dropped | out-of-order | stale/torn | worker CPU | compositor CPU | → scanout p50 / p99 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chosen, trivial frame | **143.98** | 1 | **0** | 0 | **1.48 %** | **4.04 %** (3.49 % without the spike's checks) | 10.2 / 12.3 ms |
| chosen, 3.7 ms of GPU per frame | **144.00** | 0 | **0** | 0 | **1.38 %** | **3.83 %** | 14.0 / 19.7 ms |

- **0 stale, torn or out-of-order frames** in 124,238 checked frames across the 20 synchronised runs (fence,
  finish, fdpoll).
- The negative control proves the checks work. The same transport without sync shows **121 stale frames per
  minute** (1.4 %).

**Fallbacks (brief step 4):**

| fallback | result | why |
| --- | --- | --- |
| (a) same transport, `glFinish` instead of fences | passes on a trivial frame (3.1 % worker CPU). **Fails under load: 64 % worker CPU** (45 % with `__GL_YIELD=USLEEP`). | NVIDIA's `glFinish` busy-waits for GPU completion. The CPU cost grows with the scene's GPU time. |
| (b) CPU copy: `glReadPixels` → memfd → `glTexSubImage2D` | **fails**: 142.1 fps, **17.5 % worker / 36.8 % compositor CPU**, 18 ms p50 latency | moves 1.19 GB/s each way. One 1080p memcpy alone costs 8–9 % of a core at 144 fps on this CPU, so < 5 % is out of reach. |
| (extra) dmabuf + worker-side `poll()` on its own sync_file, no fence crosses | **passes** at both loads: 143.98 / 144.00 fps, **1.3 % worker CPU** | a kernel wait, no spinning. This is the CPU-side handshake to use if fence passing ever breaks. |

- Design §12's "raise with owner" fallback **does not apply**. The primary mechanism passes, and so does a
  spin-free CPU-side handshake.
- **Spec change to make:** §5.2 says "else a CPU-side `glFinish` handshake". It should say "else a worker-side
  sync_file wait", because `glFinish` fails the CPU budget under real GPU load. See §5.

**Two findings that change the Phase 2 design:**

1. **Latch on signaled; never `eglWaitSync` on a worker fence that hasn't signaled.**
   - The brief's literal step 2 is "latch the newest frame, `eglWaitSync` on its fence". That puts the
     compositor's GPU queue *behind the worker's job*.
   - Under 3.7 ms of GPU per frame it delivered 143.18 fps, and 141.22 with mpvpaper running. At 6.2 ms it
     delivered 130.95 fps.
   - It also lets a slow or hung worker stall every output the compositor drives. That contradicts §4.1
     isolation and the rule "a frame not ready never blocks presentation".
   - Latching only signaled frames gives 144.00 fps at the same load.
2. **A dead worker's frame stays valid.**
   - We SIGKILLed the worker while its acquire fence was still unsignaled, 3/3 times.
   - The fence still signaled: NVIDIA finished the in-flight job.
   - The imported dmabuf kept its memory: the held frame read back intact 128/128 times over about 13 s.
   - The compositor kept presenting through the kill. Its max frame-callback gap was 6.3–8.6 ms, no worse than
     the same configs without a kill.
   - So §6.3 "hold the last frame" needs no copy.

## 1. Extension availability (`eglQueryString` dumps)

All dumps come from libglvnd 1.7.0 with NVIDIA 595.84 as the only EGL vendor. The device list has one entry:
the NVIDIA GPU, `/dev/dri/card1`.

**Client extensions** (`eglQueryString(EGL_NO_DISPLAY, EGL_EXTENSIONS)`):

```text
EGL_EXT_platform_base EGL_EXT_device_base EGL_KHR_client_get_all_proc_addresses EGL_EXT_client_extensions
EGL_KHR_debug EGL_KHR_platform_x11 EGL_EXT_platform_x11 EGL_EXT_platform_device EGL_MESA_platform_surfaceless
EGL_EXT_explicit_device EGL_KHR_platform_wayland EGL_EXT_platform_wayland EGL_KHR_platform_gbm EGL_MESA_platform_gbm
EGL_EXT_platform_xcb
```

**Producer display.** `EGL_PLATFORM_SURFACELESS_MESA`, vendor NVIDIA, EGL 1.5. This is the same path Task 1
used:

```text
EGL_ANDROID_native_fence_sync EGL_EXT_buffer_age EGL_EXT_client_sync EGL_EXT_create_context_robustness
EGL_EXT_image_dma_buf_import EGL_EXT_image_dma_buf_import_modifiers EGL_MESA_image_dma_buf_export EGL_EXT_output_base
EGL_EXT_protected_content EGL_EXT_stream_acquire_mode EGL_EXT_sync_reuse EGL_IMG_context_priority
EGL_KHR_config_attribs EGL_KHR_create_context_no_error EGL_KHR_context_flush_control EGL_KHR_create_context
EGL_KHR_fence_sync EGL_KHR_get_all_proc_addresses EGL_KHR_partial_update EGL_KHR_swap_buffers_with_damage
EGL_KHR_no_config_context EGL_KHR_gl_colorspace EGL_KHR_gl_renderbuffer_image EGL_KHR_gl_texture_2D_image
EGL_KHR_gl_texture_3D_image EGL_KHR_gl_texture_cubemap_image EGL_KHR_image EGL_KHR_image_base EGL_KHR_reusable_sync
EGL_KHR_stream EGL_KHR_stream_attrib EGL_KHR_stream_consumer_gltexture EGL_KHR_stream_cross_process_fd
EGL_KHR_stream_fifo EGL_KHR_stream_producer_eglsurface EGL_KHR_surfaceless_context EGL_KHR_wait_sync
EGL_NV_nvrm_fence_sync EGL_NV_quadruple_buffer EGL_NV_stream_consumer_eglimage EGL_NV_stream_cross_display
EGL_NV_stream_cross_object EGL_NV_stream_cross_process EGL_NV_stream_cross_system EGL_NV_stream_dma
EGL_NV_stream_flush EGL_NV_stream_metadata EGL_NV_stream_remote EGL_NV_stream_reset EGL_NV_stream_socket
EGL_NV_stream_socket_inet EGL_NV_stream_socket_unix EGL_NV_stream_sync EGL_NV_stream_fifo_next
EGL_NV_stream_fifo_synchronous EGL_NV_stream_consumer_gltexture_yuv EGL_NV_stream_attrib EGL_NV_stream_origin
EGL_NV_system_time EGL_NV_output_drm_flip_event EGL_NV_triple_buffer EGL_NV_robustness_video_memory_purge
EGL_WL_bind_wayland_display EGL_WL_wayland_eglstream
```

**Consumer display.** `eglGetPlatformDisplay(EGL_PLATFORM_WAYLAND_KHR, wl_display)`, vendor NVIDIA, EGL 1.5. It
has the same list as the producer display, plus three:

```text
EGL_EXT_output_drm EGL_EXT_stream_consumer_egloutput EGL_EXT_present_opaque
```

The `EGL_EXT_platform_device` display has the producer list plus `EGL_EXT_output_drm` and
`EGL_EXT_stream_consumer_egloutput`. Reproduce the dumps with `spikes/dmabuf/producer --dump-ext`; the consumer
logs its own dump on every run.

**What the mechanism needs:**

| need | producer (surfaceless) | consumer (wayland) |
| --- | --- | --- |
| `EGL_KHR_gl_texture_2D_image` | yes | yes |
| `EGL_MESA_image_dma_buf_export` | yes | yes |
| `EGL_EXT_image_dma_buf_import` + `_modifiers` | yes | yes |
| `EGL_ANDROID_native_fence_sync` | yes | yes |
| `EGL_KHR_wait_sync` | yes | yes |
| `EGL_IMG_context_priority` | yes. high and low were granted unprivileged (§4) | yes |
| `EGL_KHR_surfaceless_context` | yes | yes |

**GL extensions** (desktop GL 3.3 core, `3.3.0 NVIDIA 595.84`):

| extension | present? |
| --- | --- |
| `GL_OES_EGL_image` | yes, so `glEGLImageTargetTexture2DOES` works in core profile |
| `GL_EXT_EGL_image_storage` | yes |
| `GL_EXT_memory_object_fd` + `GL_EXT_semaphore_fd` | yes |
| `GL_OES_EGL_image_external` | **no**, see the modifier note below |

**Modifiers.** `eglQueryDmaBufModifiersEXT(AB24)` on the consumer display returns 13 modifiers:

- 12 NVIDIA block-linear modifiers, `0x03000000006060{10..15}` and `0x0300000000e080{10..15}`. All of them can be
  sampled as `GL_TEXTURE_2D`.
- `0x0` (LINEAR), marked **external_only**.
- **The LINEAR flag is a Phase 4 (web worker) risk.** Without `GL_OES_EGL_image_external` in the core context,
  our compositor *cannot sample a linear dmabuf at all*. Workers must hand over NVIDIA block-linear buffers.
  - GL-rendered, MESA-exported textures already are block-linear.
  - Check what CEF hands out before building the web worker.
- The exported modifier `0x0300000000e08014` decodes as follows. Each
  `eglExportDMABUFImageMESA` returns one fd.

  | field | value |
  | --- | --- |
  | layout | block-linear 2D |
  | `h` | 4, i.e. 16-GOB blocks |
  | page kind | 0x08 |
  | GOB kind | 2 |
  | sector layout | 1 |
  | compression | 1 |

## 2. The mechanism as built

**Wire protocol** (`common.h`):

- The socket is a `SOCK_SEQPACKET` socketpair. The compositor creates it and execs the worker with one end.
- Each message is a fixed-size struct. Fds ride `SCM_RIGHTS`.

| message | direction | carries | when |
| --- | --- | --- | --- |
| `BUFFER` | worker → compositor | slot, w, h, fourcc, nplanes, stride/offset per plane, modifier + plane fds | once per ring slot, at startup |
| `START` | compositor → worker | measurement window | spike-only |
| `FRAME` | worker → compositor | slot, `n`, render-start timestamp, send timestamp + acquire fence fd | per frame |
| `RELEASE` | compositor → worker | slot + release fence fd (optional) | when the compositor stops sampling a slot |
| `STATS` | worker → compositor | worker-side measurements | spike-only |
| `SHM` | worker → compositor | memfd holding `RING` frames | CPU-copy fallback only |

**Worker, per frame:**

1. Take a free slot. If its release fence fd is set, import it (`eglCreateSync(EGL_SYNC_NATIVE_FENCE_ANDROID,
   fd)`) and `eglWaitSync`. The GPU waits, not the CPU.
2. Render into the slot's FBO.
3. Create the native fence (`eglCreateSync(EGL_SYNC_NATIVE_FENCE_ANDROID, EGL_NO_NATIVE_FENCE_FD_ANDROID)`).
   Call `glFlush`, which **must come before** the dup. Then call `eglDupNativeFenceFDANDROID` and send `FRAME`
   with the fd.
4. CPU cost from render start to `FRAME` sent: p50 0.08 ms, p99 0.20 ms.
   - That covers 144 frames per second from a single thread; NVIDIA's surfaceless context added no driver
     threads.

**Compositor, per frame callback:**

1. Pick the newest queued frame whose acquire fd polls readable. Supersede (release) older queued frames
   without a fence: they were never sampled, and the worker's own context orders its next render after them.
2. Import the fence and `eglWaitSync`. When the latch is on signaled, the fence is always already signaled.
3. Draw with `texelFetch`, 1:1.
4. Release the previous slot. Create a native fence after this frame's draw, `glFlush`, dup it, and send
   `RELEASE` with the fd.
5. Request the frame callback and presentation feedback, then `eglSwapBuffers`. Swap interval is 0; the pacing
   comes from frame callbacks.

**Ring size.** 3 slots are enough. Below GPU saturation:

- the worker never found a slot without a free buffer: 0 slot stalls in every run
- it never found a release fence still unsignaled when reusing a slot

At saturation (§4) it did: 552 stalls in 20 s.

**What the checks verify.** These run on every latched frame, through a PBO plus a GL fence, so presentation
never blocks on them:

1. The top-left 64×64 block is uniform and equals `n` from the message.
   - A stale buffer shows `n-3`, because the ring has 3 slots.
   - Every `nosync` failure looked exactly like that.
2. A 16×16 gradient probe at the far corner matches `grad_rgb(x, y, n)` bit-exactly. This catches torn or
   partial frames.
3. The decoded `n` rises strictly in latch order.

## 3. Measurements: trivial frame (60 s, worker 144 fps, DP-2 @ 239.76 Hz, legacy wallpaper stopped)

Column meanings:

- **redraw**:
  - `vblank` redraws on every frame callback, which is what lp-player will do: present at the output's refresh.
  - `new` draws only when a new frame arrived, throttled by frame callbacks.
- **dropped**: frames delivered by the worker but never shown, because a newer one superseded them within one
  vblank.
- **→ scanout**: worker render-start timestamp to `wp_presentation.presented`, which reports actual scanout on
  `CLOCK_MONOTONIC`.
- **CPU**: `getrusage(RUSAGE_SELF)` over the window, all threads, as a percentage of one core.

| run | sync / latch | redraw | delivered fps | dropped | out-of-order | stale/torn | worker CPU % | compositor CPU % | → scanout p50 / p99 / max ms | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fence-signaled-vblank` | fence / signaled | vblank | 143.98 | 1 | 0 | 0 | 1.48 | 4.04 | 10.22 / 12.31 / 13.35 | **PASS** |
| `fence-signaled-new` | fence / signaled | new | 144.00 | 0 | 0 | 0 | 1.58 | 3.21 | 5.03 / 8.78 / 10.09 | **PASS** |
| `fence-gpuwait-vblank` | fence / gpu-wait | vblank | 144.00 | 0 | 0 | 0 | 1.51 | 4.09 | 10.02 / 12.12 / 13.28 | **PASS** |
| `fence-gpuwait-new` | fence / gpu-wait | new | 144.00 | 0 | 0 | 0 | 1.55 | 3.16 | 4.93 / 8.82 / 10.02 | **PASS** |
| `finish-vblank` | glFinish (a) | vblank | 144.00 | 0 | 0 | 0 | 3.09 | 3.87 | 10.19 / 12.26 / 12.68 | **PASS** |
| `finish-new` | glFinish (a) | new | 144.00 | 0 | 0 | 0 | 3.16 | 3.02 | 4.92 / 8.83 / 10.45 | **PASS** |
| `fdpoll-vblank` | worker-side poll | vblank | 143.98 | 1 | 0 | 0 | 1.32 | 3.80 | 10.21 / 12.28 / 12.88 | **PASS** |
| `shm-vblank` | CPU copy (b) | vblank | 142.08 | 115 | 0 | 0 | 17.53 | 36.81 | 18.15 / 26.07 / 30.80 | FAIL |
| `shm-new` | CPU copy (b) | new | 143.12 | 53 | 0 | 0 | 16.56 | 34.99 | 15.52 / 24.86 / 29.86 | FAIL |
| `nosync-vblank` | **none** (control) | vblank | 144.00 | 0 | **121** | **121** | 0.85 | 3.85 | 9.99 / 12.08 / 13.22 | FAIL (as intended) |

- Worker frames rendered in every run: 8640 out of 8640 (144.00 fps), with 0 missed ticks.
- The single dropped frame in the two runs that have one is jitter. Two frames finished within one 4.17 ms
  vblank, so the older one was superseded.
- The `nosync` failures all show the slot's *previous* content: corner = `n-3`, gradient = `grad(n-3)`.
  - This proves two things.
  - First, NVIDIA does **not** implicitly order GPU work across the two processes' contexts on a shared dmabuf.
  - Second, the acquire handshake (fence, finish or fdpoll) is load-bearing.
- With the signaled latch at trivial load, a queued frame was not yet complete at 409 of about 14,400 vblanks
  (2.8 %), and the previous frame was reused. The run still delivered 8639 of 8640 frames.

## 4. Measurements: under GPU load (`LP_SPIKE_WORK`)

The trivial gradient frame takes about 0.1 ms of GPU. Real LWE scenes take milliseconds. `LP_SPIKE_WORK` adds a
per-pixel loop that never changes the pixels:

- `2500` gives **3.7–3.9 ms of GPU per frame**, a heavy scene at 144 fps, using about 55 % of the GPU.
- `4000` gives **6.2 ms**, which is GPU saturation at 144 fps.

| run | sync / latch | redraw | GPU/frame | delivered fps | dropped | worker CPU % | compositor CPU % | → scanout p50 / p99 ms | host frame-callback p50 / p95 ms | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `load-fence-signaled-vblank` | fence / signaled | vblank | 3.7 ms | **144.00** | 0 | 1.38 | 3.83 | 14.04 / 19.71 | 4.17 / 4.44 | **PASS** |
| `load-fence-signaled-new` | fence / signaled | new | 3.7 ms | **144.00** | 0 | 1.40 | 3.34 | 8.73 / 13.27 | 7.05 / 8.43 | **PASS** |
| `load-fence-signaled-vblank-prio` | + ctx priority compositor HIGH / worker LOW | vblank | 3.7 ms | 144.00 | 0 | 1.39 | 3.85 | 14.04 / 19.52 | 4.17 / 4.44 | **PASS** |
| `load-fence-gpuwait-vblank` | fence / gpu-wait | vblank | 3.7 ms | 143.18 | **49** | 1.38 | 3.83 | 10.26 / 15.25 | 4.17 / 4.50 | PASS, barely (141.22 with mpvpaper running: FAIL) |
| `load-fdpoll-vblank` | worker-side poll | vblank | 3.9 ms | **144.00** | 0 | **1.34** | 3.60 | 14.09 / 19.62 | 4.17 / 4.41 | **PASS** |
| `load-finish-vblank` | glFinish (a) | vblank | 3.7 ms | 144.00 | 0 | **64.40** | 3.64 | 14.37 / 19.59 | 4.17 / 4.43 | FAIL (CPU) |
| `load-finish-vblank-glyield-usleep` | glFinish + `__GL_YIELD=USLEEP` (30 s) | vblank | 3.7 ms | 144.00 | 0 | **45.40** | 3.60 | 14.42 / 19.64 | 4.17 / 4.42 | FAIL (CPU) |
| `sat-fence-signaled-vblank` | fence / signaled (20 s) | vblank | 6.2 ms | 140.40 | 53 | 1.06 | 2.59 | 23.81 / 30.07 | **8.29** / 8.49 | FAIL |
| `sat-fence-gpuwait-vblank` | fence / gpu-wait (20 s) | vblank | 6.2 ms | 130.95 | 261 | 1.10 | 2.43 | 16.14 / 26.95 | **8.32** / 12.51 | FAIL |

What this shows:

- **gpu-wait vs signaled.**
  - With gpu-wait, the compositor latches a frame about 0.1 ms after the worker *submitted* it.
  - The compositor's own draw and present then wait on the GPU behind the worker's 3.7 ms job. Its next latch
    comes late, and two worker frames are pending by then: 49 drops.
  - With signaled, the compositor shows the previous frame until the new one is finished (5437 vblanks reused
    the previous frame) and drops nothing.
  - **Latency cost of signaled:** +3.8 ms at p50 (14.0 vs 10.3 ms). That is the worker's own GPU time. Showing a
    frame before it is rendered isn't possible anyway; gpu-wait merely queues the wait inside the compositor.
- **glFinish burns a core under load.**
  - The worker thread spins in `glFinish` for the whole GPU time, about 4.5 ms of every 6.9 ms.
  - `__GL_YIELD=USLEEP` only takes the cost from 64 % to 45 %.
  - `fdpoll` does the same CPU-side handshake with a kernel `poll()` on the worker's own sync_file, at 1.34 %.
- **Saturation (6.2 ms/frame, about 90 % of the GPU for one worker).**
  - Nothing passes, and no transport can fix it: the host compositor's own cadence halves to 120 Hz (callback
    p50 8.3 ms).
  - Signaled still degrades more gracefully: 140 vs 131 fps, callback p95 8.5 vs 12.5 ms.
  - The ring starts to stall there: 552 slot stalls, and release fences unsignaled at reuse.
  - **Phase 2 needs a worker GPU budget.** See §9.
- **Context priority.**
  - NVIDIA grants `EGL_IMG_context_priority` HIGH to the compositor and LOW to the worker without privileges;
    `eglQueryContext` confirms both.
  - It made no measurable difference at this load: identical numbers.
  - Keep it in the design, because it is free, but don't count on it.

## 5. Fallbacks in detail

**(a) `glFinish` instead of fences.** Same dmabuf ring. The worker `glFinish`es before `FRAME`. The compositor
releases a slot when a local `glFenceSync` after its last use polls signaled.

- Correctness: 0 errors in 30,240 checked frames.
- Cost:
  - at trivial load: worker CPU doubles to 3.1–3.2 % and submit p99 rises to 0.75 ms
  - under a real GPU load: 64 % worker CPU (above)
- **Not a viable fallback.**
- If cross-process fences ever break (a driver regression, a platform without `EGL_ANDROID_native_fence_sync`
  import), use **fdpoll** instead:
  - Have the worker `poll()` its own native fence, then send `FRAME` without an fd.
  - It measured 1.32 % / 1.34 % worker CPU and 0 errors in 17,279 frames.
  - The latency is the same as the signaled latch, since both wait for GPU completion.

**(b) CPU copy.**

- The worker pipelines the readback: `glReadPixels` → PBO + fence → next tick: map + `memcpy` into a 3-frame
  memfd ring → `FRAME`.
- The compositor calls `glTexSubImage2D` from the shm slot and releases it immediately.
- Correctness is fine: 0 errors.
- It fails delivered fps (142.08 / 143.12), CPU (16.6–17.5 % worker, 35.0–36.8 % compositor) and latency (p50
  15.5–18.2 ms, from the +1 frame pipeline and slow upload).
- **The floor is physical.** Measured on this i9-12900K, a `memcpy` of one 1920×1080×4 frame (8.29 MB) into a
  memfd mapping takes **0.57–0.63 ms**, which is **8.2–9.0 % of one core at 144 fps**.
  - The scratch benchmark is not in the spike. It ran 1000 iterations, three times, at 13.2–14.6 GB/s.
  - Each side needs at least one such copy.
  - So no tuning can get CPU copy under 5 % per process at 1080p144.
  - An unpack PBO on the compositor side might bring 36 % down towards that floor. We did not try it, because
    it cannot reach the budget.
- It remains usable as a degraded mode: correct, and still isolated.

## 6. Crash isolation (spec §4.1, §6.3)

`--kill-at`: the compositor SIGKILLs the worker the instant a `FRAME` arrives, so the frame and its acquire
fence are in hand. It then keeps presenting at 240 Hz for about 13 s, reading the held frame back every 24
vblanks.

| run | GPU/frame | fence at kill | frame latched after kill | held-frame readbacks | corrupt | max frame-callback gap |
| --- | --- | --- | --- | --- | --- | --- |
| `crash-idle-signaled` | ~0.1 ms | not yet signaled | 1 (content correct) | 128 | 0 | 6.34 ms |
| `crash-load-gpuwait` | 3.7 ms | not yet signaled | 1 (content correct) | 128 | 0 | 8.58 ms |
| `crash-load-signaled` | 3.7 ms | not yet signaled | 1 (content correct) | 128 | 0 | 8.54 ms |

Plus 7 earlier runs with mpvpaper playing: 3 at idle with the kill landing between frames, and 4 under load
(2 per latch policy) with the fence unsignaled. All were identical: 0 corrupt, no stall.

- NVIDIA **completes the killed process's in-flight GPU job and signals its sync_file**.
- The compositor's imported `EGLImage` **keeps the buffer memory alive** after the exporter is gone.
- So:
  - "hold the last frame" needs no snapshot copy
  - a worker restart is a new set of `BUFFER` messages; drop the old images once the new worker's first frame
    latches
  - the socket EOF is the crash signal
- **Not tested:** a worker GPU *hang*, where an infinite shader triggers an Xid/RC recovery. We can't trigger
  one safely on the owner's session.
  - With the signaled latch, a never-signaling fence just means the output holds its frame. The compositor's
    GPU timeline never depends on the worker.
  - With gpu-wait, the same hang would stall the compositor on every output.
  - That is the second reason, after §4, to require the signaled latch.

## 7. Where the compositor's CPU goes, and latency

**CPU attribution at 240 Hz** (vblank redraw, trivial load, 60 s each):

| run | compositor CPU % |
| --- | --- |
| `local-vblank`: no worker, a static texture drawn every vblank, same loop | 2.95 |
| `fence-signaled-vblank-noverify`: real transport, the spike's checks off | 3.49 (+0.54) |
| `fence-signaled-vblank`: + PBO readback checks (spike-only) | 4.04 (+0.55) |

- **The transport costs the compositor about 0.54 % of a core**, about 37 µs per received frame at 144 fps. That
  covers fence poll, import, `eglWaitSync`, release fence and socket.
- Most of the compositor's CPU is **presenting at 240 Hz itself**, which lp-player pays regardless of workers.
- With redraw on new frames only, the same transport costs 3.2 % in total.

**Latency** (`fence-signaled-vblank`, trivial):

| stage | p50 | p99 |
| --- | --- | --- |
| worker render start → compositor receives `FRAME` | **0.10 ms** | 0.24 ms |
| → compositor swap (waits for the next 240 Hz frame callback) | 2.5 ms | — |
| → scanout | 10.2 ms | 12.3 ms |

- The swap-to-scanout part, about 7.7 ms, is Hyprland's pipeline of about 2 vblanks at 240 Hz. Every client pays
  it, including lp-player's own output.
- With redraw on new frames (render on arrival), scanout comes at 5.0 ms p50.
- The transport's share of the latency is negligible.
- The compositor's render timing within the vblank interval is a Phase 1/2 latency knob, not a transport
  question.

## 8. With vs without the legacy wallpaper running

The first full battery ran while mpvpaper was playing a 60 fps video wallpaper on both outputs, as the session
had it. The owner then asked to stop it and re-run. Same configs, 60 s each:

| run | delivered fps (with → without) | worker CPU % | compositor CPU % | → scanout p50 ms | host callback p95 ms |
| --- | --- | --- | --- | --- | --- |
| fence / gpu-wait, vblank | 143.98 → 144.00 | 1.53 → 1.51 | 4.17 → 4.09 | 10.04 → 10.02 | 4.36 → 4.33 |
| fence / gpu-wait, new | 144.00 → 144.00 | 1.62 → 1.55 | 3.26 → 3.16 | 5.53 → 4.93 | 8.52 → 8.45 |
| finish, vblank | 144.00 → 144.00 | 3.47 → 3.09 | 4.02 → 3.87 | 10.19 → 10.19 | 4.34 → 4.33 |
| shm, vblank | 140.18 → 142.08 | 18.81 → 17.53 | 39.62 → 36.81 | 18.60 → 18.15 | 8.39 → 8.26 |
| nosync (control) | stale 162 → 121 | 0.89 → 0.85 | 4.01 → 3.85 | 9.99 → 9.99 | 4.34 → 4.33 |
| local (baseline) | — | — | 3.16 → 2.95 | — | 4.35 → 4.33 |
| load fence / gpu-wait | **141.22 → 143.18** | 1.51 → 1.38 | 3.92 → 3.83 | 10.31 → 10.26 | **8.25 → 4.50** |
| load fence / signaled | 144.00 → 144.00 | 1.45 → 1.38 | 3.94 → 3.83 | 14.58 → 14.04 | **8.35 → 4.44** |
| load finish | 143.80 → 144.00 | 63.13 → 64.40 | 3.93 → 3.64 | 14.68 → 14.37 | **8.20 → 4.43** |
| load finish, `__GL_YIELD=USLEEP` | 144.00 → 144.00 | 44.34 → 45.40 | 3.74 → 3.60 | 14.62 → 14.42 | 8.32 → 4.42 |
| load fence / signaled + priority | 143.98 → 144.00 | 1.47 → 1.39 | 3.92 → 3.85 | 14.44 → 14.04 | 8.31 → 4.44 |

What changed:

- **Under load, the host compositor missed vblanks only while mpvpaper was also on the GPU.** Callback p95 was
  8.2–8.4 ms then, and 4.4–4.5 ms without it. The effect is the same in every mode, including `finish`, which
  has no fence coupling, so it is GPU contention and not the transport.
- **The gpu-wait latch moved from FAIL (141.22) to a marginal PASS (143.18).** It is the configuration most
  sensitive to GPU contention.
- Everything else moved by at most 0.4 CPU points. **No verdict changed.**
- Raw logs of the with-mpvpaper battery are in `spikes/dmabuf/out/with-mpvpaper/`, which is gitignored.

## 9. What Phase 2 must do

1. **Transport.**
   - One `SOCK_SEQPACKET` socketpair per worker, created by the compositor, with fds over `SCM_RIGHTS`.
   - A ring of 3 worker-allocated `GL_RGBA8` textures. Export them once with `eglCreateImage(EGL_GL_TEXTURE_2D)`
     + `eglExportDMABUFImageMESA`. Import them once with `eglCreateImage(EGL_LINUX_DMA_BUF_EXT)` + modifier
     lo/hi, then `glEGLImageTargetTexture2DOES` (`GL_OES_EGL_image`, present in core).
   - For LWE (spike (a)), the worker attaches the exported texture as the color attachment of the FBO it already
     hands to `wp_project_set_output_framebuffer`, so there is no extra copy.
2. **Sync.**
   - Per-frame acquire fence: `EGL_ANDROID_native_fence_sync` via `glFlush` → `eglDupNativeFenceFDANDROID`.
   - Release fence back to the worker; the worker calls `eglWaitSync` before reuse.
   - **The compositor latches only frames whose sync_file polls readable.**
     - Register queued fence fds as calloop sources (`POLLIN` = signaled), or poll them at each output's frame
       time.
     - Keep `eglWaitSync` after latch as a free safety net.
     - Never latch on submission.
3. **Fallback**, behind a capability check: worker-side `poll()` on its own sync_file (fdpoll), not `glFinish`.
   CPU copy is the last-resort degraded mode only, and it is far over the CPU budget at 1080p144.
4. **Crash.**
   - Socket EOF or SIGCHLD → hold the last latched image (it stays valid) → restart the worker → re-import.
   - Drop the old `EGLImage`s once the new worker's first frame is latched.
5. **Buffers must be NVIDIA block-linear.**
   - LINEAR dmabufs are external-only and unsampleable in our core context, because there is no
     `GL_OES_EGL_image_external`.
   - Validate `{fourcc, modifier}` against `eglQueryDmaBufModifiersEXT` at `BUFFER` time.
   - This matters for the web worker (CEF).
6. **Worker GPU budget.**
   - At about 90 % GPU for one worker, the whole compositor drops to 120 Hz. No sync scheme helps.
   - The compositor should detect its own missed vblanks (it has the frame-callback/presentation data) and
     throttle the scene worker's fps. It already owns the clock.
   - Context priority (compositor HIGH, worker LOW) is granted on NVIDIA but showed no effect. Set it anyway.
7. **Worker pacing.**
   - The spike's worker free-runs at 144 Hz. On a 143.98 Hz output that beats: about 1 drop per minute was
     already visible at 240 Hz from jitter alone.
   - Pace scene workers from the compositor (a per-output "frame request" message, like `wl_surface.frame`)
     rather than an independent timer.

## 10. Not tested / open

- **A worker GPU hang** (Xid/RC recovery). The signaled latch makes the compositor immune by construction; the
  driver's behaviour on the hung channel is unverified.
- **Suspend/resume, VT switch.** NVIDIA exposes `EGL_NV_robustness_video_memory_purge`: video memory, including
  shared dmabufs, can be purged. Phase 2 should treat "purged/context lost" as a worker restart.
- **Several workers or outputs at once.** One worker → one output here. The per-frame cost is per frame, so it
  should scale linearly. Unmeasured.
- **DP-1 (143.98 Hz).** Only DP-2 was approved for the test surface.
- **Other formats** (10-bit, sRGB) and resizing or reallocating the ring. Hotplug or scene resolution changes
  mean a new `BUFFER` set.
- **AMD/Intel (Mesa).** The extensions are standard there, but Mesa *does* implicit-sync dmabufs, so `nosync`
  might pass. Don't rely on it; keep explicit fences everywhere.
- **The real LWE render path into an exported texture.** It is mechanically the FBO attachment above, and
  untested together.

## 11. Reproduce

```bash
env -u LD_LIBRARY_PATH nix develop -c make -C spikes/dmabuf   # devShell has everything; nothing ad hoc
curl -s -X POST 127.0.0.1:5174/stop                            # stop the legacy wallpaper
bash spikes/dmabuf/run.sh                                      # 24 runs (~24 min) on DP-2 → spikes/dmabuf/out/
spikes/dmabuf/producer --dump-ext                              # §1 dumps
```

- `out/results.jsonl` has one JSON line per run, with every number above.
- `out/<label>.txt` / `.err` are the human summary and the full logs, including the per-run extension and
  modifier dumps.
- Build dependencies:
  - nothing beyond the repo devShell: gcc, wayland, wayland-scanner, libglvnd, pkg-config
  - `presentation-time.xml` was copied from nixpkgs `wayland-protocols` 1.48 into `spikes/dmabuf/protocol/`,
    because the devShell has no wayland-protocols
