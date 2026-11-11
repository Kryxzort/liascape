# Scene crash policy

Covers the crash paths of `src/player/src/sources/scene.rs` (`hold_for_restart`, the preview, `ContextLost`),
`worker/mod.rs` (`kill_for_restart`, the budget), `snapshot.rs` (`broken`) and the worker's robust context
(`gfx/egl.rs` `OffscreenOpts::robust`). Rules: `.claude/rules/player/scenes.md` § Crash policy; invariant #9 in
`docs/player/invariants.md`.

A worker crash or hang keeps the source's last frame (or its preview if none arrived), restarts up to 3 times in a
sliding 60 s resuming at the held position, then the source is broken. Other outputs, videos and audio are never
touched: with a scene on one output killed four times, a video on another kept its frame pacing, its position and
its gains, and the loop's busy stayed within a few ms.

## Resume exactly at the held frame

`Tick.t` is the compositor's scene clock, so a clock left running through a restart (spawn + EGL + export + first
frame ≈ 0.1–0.3 s) made the new worker's first frame jump ahead of the frozen picture. `hold_for_restart` (on
`Hung`, `Exited`, and again at `Restarted`, after `Latch::forget_worker`, so a frame of the dead worker that latched
between a hang and the reap is the final one) stops the clock at the held frame's `t` and marks the source
`resuming`. While resuming, exactly one tick at that `t` is sent after the new worker's `Ready`; the clock runs again
when a frame of a later generation latched (`scene.resuming` / `scene.resumed`). `time_pos` is frozen through the
outage. Paused through the crash: nothing ticks until the un-pause. The GPU budget skips a resuming scene.

## The preview when nothing is on screen

A worker that dies with no frame latched makes the next `update` open the source's `preview` prop as an internal
paused, silent image `MpvSource`. `texture()` = the latched frame, else the preview once rendered, else `None`. The
first worker frame retires it. The open is synchronous on the loop (~10–30 ms: a core, a render context, a first
render), so it happens only on crash paths and for a restored broken scene, never on a normal load. A missing or
failed preview logs `scene.preview_failed` once and shows nothing.

## Broken

Budget spent → `SourceEvent::Error` plus one `source.broken {…, shows: last_frame|preview|nothing}` with the crash
record's fields (an outbox fact: the backend marks the item crashed). The source then holds its picture silently: no
worker, no stream, `has_audio` false and `AudioFlowing` immediate so nothing waits on it, clock frozen. Observed
`broken` (read-only) reads true until a `path` change brings a new worker and a fresh budget. Re-applying the same
item therefore needs a new source (a `transition`; a same-path `set` is a no-op).

A broken scene is saved `broken: true` in the snapshot and restored as its preview with no worker ever spawned, no
second `source.broken` and no restore fade — without it a player restart gave a crash-looping scene a fresh budget
every time. A source error marks the snapshot dirty (a break is no graph change).

## `loading`

Observed, read-only, false on every other kind: no first frame latched, no error, not broken, and a live worker
starting, running or restarting — i.e. inside its load and build. It never stays true for a hung worker (the
heartbeat kills it once the load gate stops covering) or a failed load. The transition recipe waits longer for a B
that reports it ([scene-source.md](scene-source.md)).

## GPU context loss

The worker's context is robust (`LOSE_CONTEXT_ON_RESET`, plus `EGL_GENERATE_RESET_ON_VIDEO_MEMORY_PURGE_NV` where
listed — NVIDIA purges VRAM on suspend/resume and VT switches) and polls `glGetGraphicsResetStatus` (no GPU sync)
after every frame and on every ping, so a purge seen while starved counts too. A reset → `ContextLost`: the worker
renders nothing more, fades its stream and waits to be killed (exits 4 after 5 s). The compositor kills it as a
crash through the same budget. The protocol carries no reset kind, so an innocent reset counts like a guilty one;
one suspend is one restart, well inside the budget. Real detection is on-machine only.

## A suspend is not a hang

After a resume the compositor may hold every slot (frames whose fences hadn't signalled while the GPU woke), and
NVIDIA's VRAM save can block the compositor's own loop for seconds. The heartbeat therefore leaves out a starved
worker's tick age and the time of a host stall ([scene-worker.md](scene-worker.md) § The heartbeat); a real hang
keeps its bound.
