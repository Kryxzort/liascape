# Spike: GPU frame sharing, worker → compositor, on NVIDIA proprietary

Throwaway code for Phase 0 spike (b) of liascape-player. Findings and verdict: `docs/player/spikes/dmabuf.md`.

- `producer` plays the **worker**. It runs a surfaceless EGL desktop-GL 3.3 core context and renders 1920×1080
  frames into a 3-buffer ring:
  - the top-left 64×64 block is the colour `(n & 255, (n >> 8) & 255, 0)`
  - the rest is an integer gradient of `n`
- `consumer` plays the **compositor**:
  - It puts a wlr-layer-shell surface on one output (default DP-2, layer BOTTOM, click-through), using desktop
    GL 3.3 core on EGL's Wayland platform.
  - It spawns `producer` over a `SOCK_SEQPACKET` socketpair, the way liascape-player will spawn workers.
  - It presents on frame callbacks, checks every frame, and prints and logs the measurements.

## Build

```bash
env -u LD_LIBRARY_PATH nix develop -c make -C spikes/dmabuf
```

The repo devShell has everything: gcc, wayland, wayland-scanner, libglvnd (EGL, GL, headers) and pkg-config.
`protocol/` holds copies of three protocol XMLs:

- `wlr-layer-shell-unstable-v1.xml` and `xdg-shell.xml`, from `src/native/liascape-transition/protocol/`
- `presentation-time.xml`, from nixpkgs `wayland-protocols` 1.48, because the devShell has no wayland-protocols

Build outputs, the generated protocol glue and `out/` are gitignored.

## Run

```bash
curl -s -X POST 127.0.0.1:5174/stop        # stop the legacy wallpaper first (it competes for the GPU)
bash spikes/dmabuf/run.sh                  # the whole battery: 24 runs, ~24 min, DP-2
bash spikes/dmabuf/run.sh fence-signaled-vblank load-finish-vblank   # selected runs, by label
env -u LD_LIBRARY_PATH spikes/dmabuf/producer --dump-ext             # EGL client/display extensions
```

You can also run `consumer` directly. Run it from `spikes/dmabuf/`, because it execs `./producer`:

| option | values (default first) | meaning |
| --- | --- | --- |
| `--mode` | `fence` `finish` `fdpoll` `shm` `nosync` `local` | transport. `fence`: dmabuf + `EGL_ANDROID_native_fence_sync` acquire and release fences. `finish`: dmabuf, worker `glFinish`es. `fdpoll`: dmabuf, the worker `poll()`s its own sync_file and hands over only finished frames, so no fence crosses processes. `shm`: CPU copy through a memfd. `nosync`: dmabuf with no acquire sync (negative control). `local`: no worker at all (present-cost baseline). |
| `--latch` | `gpu-wait` `signaled` | `gpu-wait`: latch the newest frame at the next vblank and let the GPU wait on its fence with `eglWaitSync` (the brief's step 2). `signaled`: latch only frames whose sync_file already polls readable, otherwise reuse the previous frame. |
| `--redraw` | `vblank` `new` | `vblank`: redraw on every frame callback (what liascape-player does). `new`: draw only when a new frame arrived, throttled by frame callbacks. |
| `--seconds` / `--warmup` / `--fps` | `60` / `3` / `144` | measurement window, warm-up before it, worker frame rate |
| `--output` / `--layer` | `DP-2` / `bottom` | where the test surface goes |
| `--verify` | `on` `off` | the PBO readback checks (their CPU cost is measured separately) |
| `--kill-at S` | — | crash test: SIGKILL the worker S seconds into the window, the moment a frame and its fence are in hand |
| `--out` / `--label` | — | append a JSON line with every number to this file |

Environment variables:

- `LIASCAPE_SPIKE_WORK=N`: synthetic per-pixel GPU load in the producer. `2500` gives about 3.7 ms of GPU time per
  frame.
- `LIASCAPE_SPIKE_CONSUMER_PRIO` and `LIASCAPE_SPIKE_PRODUCER_PRIO`, set to `high`, `medium` or `low`: the
  `EGL_IMG_context_priority` experiment.

## What gets checked, per frame

- **Corner:** all 64×64 pixels equal the frame counter `n` from the message.
  - This proves the content belongs to the frame the metadata claims.
  - A stale buffer shows `n-3`, because the ring has 3 slots.
- **Gradient probe:** the bottom-right 16×16 block matches `grad_rgb(x, y, n)` exactly. This catches torn or
  partial frames.
- **Order:** the decoded `n` rises strictly in latch order. Gaps count as drops.
- **Readback:** each check reads the frame back through a PBO, guarded by a GL fence and mapped later. Nothing in
  the present path stalls on it.
- **Timing:** latency runs from the producer's timestamp to the consumer receiving the frame, to the consumer's
  swap, and to `wp_presentation` `presented` (actual scanout, `CLOCK_MONOTONIC`).
- **CPU:** `getrusage(RUSAGE_SELF)` over the window, all threads, in each process separately.

## Files

- `common.h`: the wire protocol, which is fixed-size messages with fds sent by `SCM_RIGHTS`. Also the timing,
  stats, and `grad_rgb` helpers.
- `producer.c`: the worker. EGL init, ring export (`eglCreateImage(EGL_GL_TEXTURE_2D)` +
  `eglExportDMABUFImageQueryMESA` / `eglExportDMABUFImageMESA`), per-frame fences, release-fence waits, and the
  shm pipeline.
- `consumer.c`: the compositor stand-in. Layer surface, import, latch policies, checks, presentation feedback and
  the results report.
- `run.sh`: the battery. It holds the list of run labels and their configurations.
- `Makefile`, `protocol/`, `.gitignore`.
