# Night notes — things the owner should know (newest last)

Read this when the owner asks "anything I should know". Append during unattended runs; never ask questions then.

## 2026-10-28 evening (before the owner slept)
- Pushed `0604307`: settings morph 720 ms open / 560 ms close (tune `SETTINGS_MORPH` in
  `app/ui/src/components/morph.ts`); the card's sharp image + preview video load at the click again; **NVIDIA now
  defaults to hardware GPU** (ANGLE `gles-egl`) — `LP_SOFTGL=1 livepaper-ui` brings back the old software path if the
  window ever misbehaves.
- Queue for the night, in order: rotation redesign (agent running) → Liascape rename + code-to-UI names
  (`docs/superpowers/plans/2026-10-28-liascape-rename.md`) → one-off migration of the owner's config/library (backup
  first) → branch cleanup → Phase 2 Task 14 (on-machine battery) → anything else worthwhile.
- No redirect needed from the old repo name (owner).
- Merged + pushed the rotation redesign (`13ee4d5`) and loudness refinement (merged locally, push after checks).
  Your rotation answer → a follow-up agent: 0 = off for min AND max (max off = a 10 h video plays to its end; min off =
  switch at every end), plus a **"Separate timing for scenes"** toggle with one "Switch scenes after" field (a scene
  never ends, so min/max make no sense for it). Your config migration will keep today's behaviour exactly: min 0,
  scenes switch after your 20 s.
- Pushed the loudness refinement (`01a5d60`) and the player hygiene batch (`9a480c8`). The long-red
  `transport_meets_the_spike_budget` is settled: the worker's work per frame is constant; the CPU % swung with the core
  type / clocks / memory contention. A soundless scene no longer runs an idle audio thread; screenshots no longer stall
  the player (810 ms → < 1 ms); a VRAM-stopped scene frees all but its shown buffer. **First fully green crate suite in
  both render modes in two days.**
- LWE: upstream's new fixes landed on `main`, not `next-v2` (ours). An agent is porting the relevant ones onto your
  fork's `livepaper/next-v2` (fast-forward push only) and re-running the scene corpus.
