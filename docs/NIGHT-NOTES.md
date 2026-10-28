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
- Pushed the scene-timing follow-up (`1c1918a`): 0 = off for min/max, "Separate timing for scenes" + "Switch scenes
  after". **Your rotation config is migrated** (backup: `~/livepaper-backup-20261028-2247`): your playlists with
  advance+wait (`dp`, `Full?`, the active one) → min off, max off, scenes after 20 s = exactly today's behaviour;
  `gg` keeps 3660 s as the maximum; the globals and `ds` stay plain timers. I stopped/started the dev backend unit for
  it (your wallpaper may have gone blank for a moment). Press Ctrl+R in the app before changing settings.
- Found by the rotation agent: an fps cap (VideoFps > 0) stopped still images from ever showing — an agent is fixing it.
- **LWE fixes ported: scene corpus 86/96 → 92/96 ok** (`61b4d4c`, fork `livepaper/next-v2` fast-forwarded to
  `40eacc9`). 8 of upstream main's 13 new commits ported (text `padding` as a string, the `"particle": null` crash on
  clock text — that was the "leaf particle" segfault —, a script leak, effect sizing, …), plus 3 small patches of our own
  (a wrong-typed JSON field no longer aborts the process, case-insensitive asset lookup fallback, an effect that can't
  compile is left out instead of blacking out its object). Still not ok: 3 3D scenes (LWE has no 3D) + 1 still image by
  design. The live player picks it up on its next upgrade (release rebuilt).
- Pushed the fps-cap fix (`6e06b53`): an fps cap never reaches a still image any more (mpv's `fps` filter swallowed
  the image's single frame). Found meanwhile: a race where re-opening the same scene right after a stop can seed it
  with the previous loudness measurement (loses a few seconds of measurement, intermittent IT check) — in TODO, after
  the rename.
- Running: **Task 14 battery on your real monitors** (it stops the dev backend while it runs and starts it again at
  the end; your wallpaper is not re-applied) and the **Liascape rename** (merged only after the battery).
- **Liascape rename is built** (7 commits, not merged yet — it lands right after the battery so the two don't
  collide). One `liascape` command: no argument = the app, `liascape next|previous|toggle-mute|toggle-pause|toggle-play|
  restore|random|kill|volume up|volume down`, `liascape ctl …` = the player. Settings keys now match their UI labels
  (e.g. `VideoFps` → `VideoFpsCap`, `AdvanceOnVideoEnd` → `SwitchWhenVideoEnds`, `LweMonitors` → `SceneMonitors`).
  Checks: crate 498/498 in both render modes, adapter IT 264/266 (the 2 = the known loudness reseed race), settings
  merge 72/72, UI matrix 780 pass / 29 skip / 0 fail, `nix build .#liascape` ok. A one-off migration script copies
  your config/library to `~/.config/liascape` etc. (never touches the old dirs) — tested on a copy of your data: 315
  library items, 2 scene monitors, the 219-item playlist all came through.
- **Your Stop hook (`~/.local/bin/livepaper-post-hook.sh`) kills every Electron whose args contain `/app/shell`**
  — including the test matrix's headless windows from the agents' worktrees (it was the cause of tonight's mystery
  matrix hangs). It fires whenever `livepaper-watch` is inactive and the source changed. Worth narrowing it to your
  installed app's path, or skipping it while a test runs. After the rename it also needs the new names
  (`liascape-watch.service`, `~/.cache/liascape`, `liascape`, the backend now runs as `liascape-backend serve`).

## 2026-10-29 night — Phase 2 Task 14 (scene-worker on-machine battery)
- **Report: `docs/player/reports/phase2.md`.** Crash isolation, pause on a scripted scene and the 1 h soak PASS
  (soak 0.17 MiB/min, VRAM per worker flat, 116 switches all done); dropout matrix 720 switches, **0 drops**, one 3 ms
  micro-gap left (frozen scene→scene at 240 Hz, open); pacing 6.94 / 4.17 ms on DP-1 / DP-2 with scenes at the refresh.
- **Five fixes, each with a test:** scenes at `scene_fps 0` used to miss every few vblanks (now paced by frame
  callbacks); the dropout detector's false drops on late ramp edges + meter gaps; the bus meter on the real-time
  thread; the GPU budget now sees every monitor's missed frames; the compositor no longer rewrites unchanged source
  values every frame (CPU per scene worker 2.9 % → 0.1 %).
- **Open (docs/TODO.md → "Phase 2 battery findings"):** heavy real scenes cost 7–26 % CPU in their worker (same as
  LWE itself per frame), a very GPU-heavy scene can still cost your 240 Hz monitor frames, CPU mid-transition.
- **Scene corpus vs legacy:** nothing that plays under legacy fails under lp-player; 37 scenes play only under
  lp-player (legacy crashes or shows black on them).
- **For you:** the VT-switch / suspend check (`phase2.md` § 8) — listed under "Waiting on owner".
- Your wallpaper was taken over for the runs (blank between them); `livepaper-watch` is started again at the end.
