# Apply and playlist-start latency — click to B's first frame, per step

A dated measurement (night of 2026-11-25), not the current state: how long `/apply`, `/playlist/play` take from the
request to the new wallpaper's first frame on screen, split into the backend's and the player's steps, before and
after the fixes of the same night (the first frame of a new video rendered before mpv tells its size, and the render
worker passing again over a slot it skipped).

- **Run:** lp-player `b73086f9` (before) and the same tree with the fixes (after), debug builds of the backend and
  the player. Machine: i9-12900K (24 threads), RTX 3070 Ti (NVIDIA 595.112), Linux 7.3.5. Night, nothing else heavy
  running (every run under `scripts/test-lock.sh`).
- **Setup:** a private backend (own HOME / XDG dirs, port, token) that starts its own player through a shim: `serve
  --headless --outputs 1920x1080@60 --clock real --ao null`, render worker on (CUDA interop). Settings: transitions
  on (`fade`, 600 ms, method `reveal`), "Switch when video ends", `hwdec` `auto`, scenes on. Videos: four 30 s
  1920×1080 30 fps H.264 clips with AAC. Scenes: synthetic scene items (`LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES`) — no
  real scene renders hermetically, so a scene's numbers here are the worker's spawn and hand-off only; a real scene's
  load is `scene-load-we.md`'s.
- **Method:** a driver posts the request the UI sends (`/apply {path}`, `/playlist/play {paths, settings}`) and
  reads the steps from three clocks on the same machine: the request's own (`t0` before the POST), backend timing
  points written with the wall clock (added for the run only, not committed), and the player's event log (`t_wall`:
  `transition.scheduled`, B's `source.ready`, `transition.started`, `.handoff`). Warm: the player runs and shows a
  video A (a scene A for S→S). Cold: the player quit after a `/stop`; the backend starts it with its last arguments
  and `--restore` (nothing to restore). 7 runs per row, medians.
- **First composed frame:** headless composes every tick, so B's first frame is composed within one output frame
  (≤ 16.7 ms at 60 Hz) of `transition.started`; a real output shows it at its next refresh. Neither is in the table.

## Steps

| column | from → to |
|---|---|
| reply | the POST → its HTTP reply (what the UI's "Applied" status waits for) |
| entry | the POST → the route's handler running |
| queued | the handler → the adapter's queue running the switch / the program load |
| ready | the queue item → `Ready()` done (player started if needed, events subscribed, layer fit set) |
| send | → `transition` / `program.play` sent |
| sched | → the player's `transition.scheduled` (request received, B created) |
| bready | `transition.scheduled` → B's `source.ready` (B opened and its first frame rendered) |
| start | B ready → `transition.started` (reveal: A's still copied one iteration later; tick alignment) |
| total | the POST → `transition.started`: B's first frame goes on screen |
| effect | `transition.started` → `.handoff` (the 600 ms fade; a cut from nothing is 0) |

## Results (median ms, n = 7 each)

| scenario | run | reply | entry | queued | ready | send | sched | bready | start | total | effect |
|---|---|---|---|---|---|---|---|---|---|---|---|
| apply video, warm (V→V) | before | 5 | 1 | 1 | 2 | 0 | 1 | 310 | 25 | 337 | 617 |
| apply video, warm (V→V) | after | 2 | 0 | 1 | 1 | 0 | 1 | 103 | 27 | 130 | 600 |
| apply scene, warm (V→S) | before | 4 | 1 | 0 | 2 | 1 | 1 | 7 | 23 | 40 | 600 |
| apply scene, warm (V→S) | after | 5 | 1 | 1 | 2 | 1 | 1 | 7 | 28 | 42 | 616 |
| apply scene, warm (S→S) | before | 4 | 1 | 0 | 2 | 0 | 1 | 5 | 25 | 36 | 617 |
| apply scene, warm (S→S) | after | 5 | 1 | 1 | 2 | 1 | 1 | 8 | 25 | 41 | 617 |
| playlist of videos, warm | before | 4 | 1 | 1 | 1 | 2 | 1 | 316 | 25 | 347 | 616 |
| playlist of videos, warm | after | 5 | 1 | 2 | 2 | 2 | 1 | 110 | 22 | 138 | 600 |
| playlist of scenes, warm | before | 4 | 1 | 1 | 2 | 1 | 1 | 6 | 24 | 35 | 617 |
| playlist of scenes, warm | after | 5 | 1 | 2 | 2 | 2 | 1 | 7 | 26 | 42 | 600 |
| apply video, cold | before | 4 | 1 | 1 | 231 | 0 | 1 | 341 | 4 | 575 | 0 |
| apply video, cold | after | 3 | 1 | 1 | 224 | 0 | 1 | 137 | 8 | 374 | 0 |
| apply scene, cold | before | 4 | 1 | 1 | 238 | 0 | 0 | 73 | 9 | 336 | 0 |
| apply scene, cold | after | 4 | 1 | 1 | 230 | 0 | 1 | 75 | 7 | 320 | 0 |
| playlist of videos, cold | before | 59 | 1 | 56 | 216 | 0 | 1 | 331 | 4 | 608 | 0 |
| playlist of videos, cold | after | 5 | 1 | 1 | 231 | 1 | 0 | 131 | 4 | 368 | 0 |
| playlist of scenes, cold | before | 5 | 1 | 2 | 251 | 1 | 1 | 73 | 9 | 337 | 0 |
| playlist of scenes, cold | after | 5 | 1 | 2 | 238 | 0 | 1 | 71 | 10 | 330 | 0 |

## Where the time went (before)

- **A video B's first frame: ~310 ms, of which mpv needs ~30.** From a private player's event log and mpv's own
  log: B's core prepared and attached in 2–60 ms (60 with the CUDA interop), FILE_LOADED 5 ms later, then nothing
  until vo_libmpv's 200 ms wait for the first frame to be rendered ran out ("mpv_render_context_render() not being
  called or stuck", one VO drop per load). mpv sends `dwidth`/`dheight` only after that frame was shown, and the
  source rendered only at a known size (~200 ms). With that fixed alone (the frame rendered at once into a stand-in
  target), B was Ready ~210 ms after the request, not ~110: the size arrives while the stand-in render is still on
  the GPU, the render worker's pass that the size woke skips the slot, and nothing woke the worker again until mpv's
  next frame or its 100 ms idle backstop (~100 ms).
- **Cold: the player's start, ~225 ms** (spawn → its socket answers a `hello`, debug build), then the same B.
- **A cold playlist of videos: 56 ms in the handler** — the program's item list asked whether scenes can play
  (`liascape-player scene-check`, no player answering) though no item was a scene.
- Everything else in the backend (route, queue, `Ready()`, the request) is 1–5 ms in total; the UI's own POST
  returns in 2–5 ms. One run (discarded) saw the `/apply` reply take 37 s on its settings write (`LastSession`,
  an fsync'd atomic write) while the disk stalled; the switch itself had gone out 37 s earlier, so only the
  status line waited.

## After

- Video switches: B's first frame 103–137 ms after the request instead of 310–341 ms; click → first frame
  130–138 ms warm (−207 ms), 368–374 ms cold (−201 to −240 ms). What remains of `bready`: the core and its CUDA
  interop render context (~60 ms of it is the interop: ~40 ms with `hwdec no`), mpv's open and first decode
  (~30 ms), the stand-in render and its redraw.
- Scenes (synthetic) were never held by either wait (the worker's frames have their size): unchanged within noise.
- The cold playlist of videos no longer runs `scene-check`: 56 → 1 ms.
- Not changed: the player's own start (~225 ms debug), the effect (the transition's duration, a setting), the
  reveal's one-iteration still copy (~25 ms), a real scene's load (`scene-load-we.md`, `docs/TODO.md` #48).
