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
- Found by the rotation agent: an fps cap (VideoFpsCap > 0) stopped still images from ever showing — an agent is fixing it.
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

## 2026-10-29 morning
- **Liascape merged + pushed** (`93cf2d4`); the GitHub repo is now `Kryxzort/liascape` (origin updated). Your data is
  migrated to `~/.config/liascape` etc. (old dirs untouched; tar backup `~/livepaper-backup-20261029-0542.tar`); the dev
  units are now `liascape-vite` / `liascape-watch` (the old ones disabled). Verified on the new backend: 315 library
  items, 2 scene monitors, the 219-item "Full?" playlist, engine `liascape-player`, every feature healthy.
- The Stop hook is off (owner). 37 merged agent branches + worktrees and 11 merged local branches removed.
- Your steps are on the on-screen todo (NixOS module + keybinds + the VT/suspend check).

## Night of 2026-10-29 → 30

Plan (owner: "do whatever you want tonight … continue with our project"; switch to Windows for WE screenshots tomorrow):
- LWE scene port, one batch at a time (they all patch the same fork branch): B1 property scripts (running), then B2 alpha/colour + keyframes, B3 particle core, B4 text, … per `docs/player/spikes/we-lwe-gap-audit.md`.
- F6b (compositor CPU per worker mid-transition, 2.45 % vs 0.6 % on-machine) — agent running.
- ≤ 2 big agents at once; model/effort chosen per agent.
- **Change of plan (owner, later that evening): "defer port for later, lets focus on the bigger picture".** The LWE
  port is PARKED after batch B1 (owner: "dont stop it, just let it complete and then leave it there"): B1
  (property scripts) finishes; B2+ wait. Instead: **Phase 3 implementation started** — Tasks 1–3 (pure rotation rules, the `program` node,
  the rotation engine), one agent, Opus high. F6b agent still running.
- **Owner, before sleeping:** max 2 agents at once tonight (the 3 running — F6b, Phase 3 T1–3, LWE B1 — finish
  naturally first); then run through the plans by priority. Order: Phase 3 T4 → T5 → T5b → T6 (revise the cover
  rule per the recon first) → T7 → … ; second slot: the offline loudness estimator's backend wiring (TODO design).
  Auto-mute (T14): latency must be ≤ today's p50/p95 (no 100 ms slack), and NO default exclusions (rules feature
  may default-exclude notifications only).
- **LWE B1 done** (`7528abf`, fork `e78d94d` pushed): property scripts run — init/update/applyUserProperties,
  thisLayer/thisObject, scale/angles/visible drive the layer; WE's own JS classes load at run time from the user's
  WE install (nothing copied). Also fixed: solid layers vanishing at random (uninitialised config). Corpus 92 ok,
  0 blank/broken/timeout (2 former timeouts now ok). Port now PARKED (B2+ wait).
- **Phase 3 Tasks 1–3 done** (`7dfda3f`, `3f57ca9`, `52caea7`): rotation rules, the `program` node, the rotation
  engine inside the player (timer, end-of-video with min/max, scene timing, failure ladder). 28 program tests.
  Not wired to the backend yet (Task 7). Next: Tasks 4, 5, 5b (agent running).
- **F6b fixed** (`b8be9bf`, `3c37047`, `5bf3c82`, `871f4bd`, `de263c7`): a wake updates only its own source,
  worker reads follow epoll, no wait on a signalled fence, no idle gain messages, schema built once. Syscalls per
  worker frame ~56 → ~29; headless excess instructions mid-fade 0.28 → 0.08–0.14 G/s. On your monitors: 2/2 under
  the 0.6 % bound (machine was busy — worth a quiet re-run: `scenes.sh workers`). Audio unchanged (onset harness).
- **Started:** the loudness estimator wiring (import + Settings → Audio "Scene loudness" Estimate / Recalculate
  all / Cancel, per-property-combination loudness, live re-seed on a property change).
- **Phase 3 Tasks 4, 5, 5b done** (`ffb8eb2`, `c95982a`, `876deae`): user next/prev/random + live playlist edits
  (re-arm, never reset the countdown), programs survive player restarts (`program.json`, snapshot), "hold until a
  monitor returns" (`while_parked`), and the playlist "Start over / Resume where it left off" (player side).
  65 program tests. **Next: Task 6** (pause when covered) — with the cover rule revised to "visible", not "focused".
- **Fans (side request):** `/etc/nixos/fans.nix` adds the writable `nct6687d` driver + CoolerControl (uncommitted in
  /etc/nixos; the rebuild compiled the CachyOS kernel locally — same kernel). fan6 = the splitter with the rattling
  fan; nothing slowed (owner: "its quiet rn").
- **Scene loudness estimator wired in** (`bfee7c6`, `4134f72`, `b21d494`, `c60561f`): estimates on import/sync/start
  (96 scenes in 9.8 s warm, 323 s cold, 0 errors), Settings → Playback under "Normalize audio": "Scene loudness"
  Estimate / Recalculate all / Cancel, the card info shows "≈ … (estimated)" / "(measured, N min)". Loudness is now
  stored per audio configuration — toggling a sound property (tested live on 2951169110's orchestral switch)
  re-keys, ramps the normalisation in 500 ms and continues that configuration's own measurement. A one-off script
  moved your 13 measured scenes to the new format (index backed up first). Adapter 281/0, UI matrix 780/0.
  ⚠ An older installed liascape (the NixOS one) writing the index would drop the new fields — reinstall/bump.
- **Next:** Phase 3 Task 7 (the backend hands rotation to the player program) — running beside Task 6.
- **Phase 3 Task 6 done** (`8ee525d`, `dc64641`): pause-when-covered in the player. "Covered" = a fullscreen /
  maximized window is VISIBLE on the monitor (Hyprland: the monitor's active or open special workspace; Sway:
  `visible`; other wlroots: foreign-toplevel; GNOME/KDE: unavailable, never pauses) — focus plays no part. Every
  monitor showing the wallpaper must be covered for 300 ms; release at once. Checked on your Hyprland: both
  monitors read "none" (no fullscreen/maximized window was open) — a real covered pause is checked in Task 12.
  The setting/UI comes with Tasks 7/10.
- **Started:** Task 14's player side (in-player auto-mute, behind a flag) — owner's bars: latency ≤ today's, delay
  accuracy, 500 ms default, no default exclusions, MPRIS = the player's own streams. Backend switch-over after Task 7.

## 2026-10-31 night

- **Phase 3 Task 7 done** (`db77cb1`, `670b12e`): rotation runs as the player's program `prog:main`. Your bar
  playlist "Full?" is rotating through it (left running). Local scene 3276522107 never loads — the program skips it.
  Adapter IT 314/0, UI matrix 778/2 (both load-only, pass alone).
- **Task 14 player side done** (`e62c9ea`, `288000b`, still behind `LIASCAPE_PLAYER_AUTOMUTE=1`): on an idle machine
  p50 mute 32 ms vs today's 53, a new stream 36 vs 79; a set delay lands within ~3 ms (today 32–47 ms late).
  Open: a 341 ms p95 tail for a brand-new stream at quantum 1024 with all cores saturated (cause unknown); CPU
  criterion 9 — 5 streams cost 23–45 ms/s in the player + 14–30 in the `parec`s it starts (+33–74 in pipewire-pulse):
  **your call** whether the criterion counts the helpers. Not yet tried on your real session / a real browser.
- **Task 8 done** (`810b2c1`): under liascape-player no timer/restart daemon, pid file, `pending_action.txt` or
  `timed_state.json` is ever written; `liascape restore` starts the player with `--restore --session-start`.
  Adapter IT 345/0. Only tested through a headless stand-in — a real boot/restore on your session is still Task 12's
  owner-run step. Decisions: `play` while a single wallpaper shows does nothing; a restored paused rotation stays paused.
- **Task 9 done** (`f98f398`): the player keeps an outbox of crashes / loudness / VRAM stops while the app is closed;
  the backend stores them on its next start (37 ms after connecting). IT 353/0 merged.
- **Task 10 done** (`7c14964`): Settings → "Pause when covered" (default: fullscreen or maximized), "When the playlist
  starts again" (Start over / Resume, also per playlist), Advanced → "Show expert options" with the expert row "When no
  monitor shows the wallpaper". "Resume from last on launch" removed. Matrix 780/0, IT 363/0.
- **Task 11 done** (`d3752fd`): 47 new UI-matrix cells, full matrix 827/0. Fixed 3 real bugs it found: a max-play
  switch could start under a pause (picture stayed on A while the UI said B); `previous` at the first item un-paused;
  Play on the playing playlist under Resume marked item 1. ⚠ One old fuzz sequence (playlist-bar drag + next on a
  2-item bar) fails on `lp-player` too — handed to Task 12 as optional.
- **Task 12 done** (`docs/player/reports/phase3.md`), on your real session, audio on a private PipeWire: 600 program
  switches 0 drops, 1 h app closed 118/118, 5 crashes all back at their item, 2 h soak 0.065 MiB/min. **Bug found and
  fixed:** with all monitors off Hyprland adds a fake `FALLBACK` output; the player counted it, so "Hold until a monitor
  returns" kept rotating. **Your calls:** the cover pause takes 374–401 ms against 350 (250 ms debounce, or a 400 ms
  bound?); "handoff ≤ 1 frame" passes as a clip frame (33 ms), fails as an output frame. Still yours: cold boot,
  suspend, VT switch (report § 6).
- **Task 13 done**, and the old fuzz failure is explained: the test's own (on a 2-item bar its "drag" was a click).
- Your wallpaper is off: you stopped it at 20:11:46 yesterday (the backend logged it), so I did not restart it.
- **Task 14, backend half merged, switch off** (`4b25588`): nothing changes for you until `AutoMuteParityPassed` is
  flipped. Tests on a private PipeWire, not your session: IT 389/0 off and 398/0 on, settings 104/0, matrix `autoMute`
  21/0 both ways. Added a player verb, `automute.release`, because no prop could lift a mute while the stream plays.
  **Still yours:** the ten criteria on your session (a real browser, `mpv`, Spotify) and CPU criterion 9, which only
  meets the bar if pipewire-pulse's cost is counted. A flaky stall test is logged as TODO F5; not caused by this.
- **From your noctalia list, three toggles** in Settings → Appearance: Glow effects, Morph animations, Autoplay video
  thumbnails (at most 4 play at once). Defaults keep today's look. Settings 131/0, IT 389/0. Full matrix 823 pass, 7
  failed under load and passed when rerun alone. The off states were checked by computed style, not by eye.
- **Three bugs from your noctalia list fixed:** a wallpaper started from nothing just appears (no fade from black); a
  right-click no longer stops an mp4 hover preview; under Shuffle the bar marks the item that really plays. Merged with
  the toggles: IT 389/0, player lib 325/0 and program 69/0, full matrix 834/0. TODO F6 filed (a timer firing early once).
- **Auto-mute now runs in the player** (Task 14 done): its Signal is on by default (`LIASCAPE_PLAYER_AUTOMUTE=0` turns
  it off), `monitor-daemon` is retired under liascape-player (a leftover one is stopped), no `pactl`/`parec` run. IT
  400/0 (389/0 with the old engine), settings 131/0, full matrix 834/0, cargo all ok. Your backend and player run it now.
- **F7 fixed:** "Start over" + shuffle no longer begins every boot on the same wallpaper (the shuffle's state is kept
  in the snapshot). **F6 fixed:** playing a playlist again no longer switches at once when its saved countdown came
  from other timing settings. **F5 partly:** the flaky stall test was mostly CPU contention (now measured as the
  player's own time); a rarer real ~3 ms block under GPU load is being traced tonight with bpftrace.
- Tonight (2026-11-02 → 03): one agent on F4 (`--debug` dropout probe causing silence), one on F5's open block.
- **F4 fixed:** `--debug`'s dropout analysis forked the whole player for each ffmpeg decode, and the fork cost the
  audio whole cycles of silence. It now spawns without forking. Battery re-run on your machine (your player was off
  ~50 min while you slept, then restored): 0 drops; the same 3 `frozen` micro-gap FAILs as before (handoff work).
- **F5 settled:** the rare real stall was the NVIDIA driver's global lock (other GPU processes allocating); our image
  frees now happen off the player's loop, imports are documented as a driver limit. 3 full suites green.
- **Phase 2 VT/suspend check done** (your player off ~3 min): a scene through a VT switch, a suspend and two suspends
  within a minute — no restart, never broken, PASS 12/12. The machine suspended 3 times around 23:48.
- **Health panel:** it now reports the player's PipeWire audio bus (down = a warning; audio then falls back to mpv's
  default device), and the playlist modal's Transitions field shows the same warning icon as Settings. IT 404/0.
- **Scenes, batch B2 (scene-engine fork patches 0022–0023, pin `ccb545d`, pushed to your fork):** layer alpha/colour
  reach the shader live and keyframe animations play (179 animated values in 26 scenes). Corpus ok 92 → 93, nothing
  newly broken; e.g. Kimi's clouds now blend instead of drawing as opaque puffs. Your player runs it. B3 (particles)
  is in progress.
- A 7 h headless soak (glibc free-heap question) runs until ~07:00.
- **The PC crashed ~01:10** (not ours; the journal just stops). It killed the soak and two agents; both were redone.
  Soak answer from the 95 min it ran: glibc's free heap is flat now (was +4.1 MiB/min) — no change needed.
- **Scenes, batch B3 (fork patches 0024–0028, pin `4c75eae`):** particle systems behave like WE — prewarmed to their
  `starttime` (snow covers the screen at +1 s, not after a minute), one shared colour random, `count`/`rate` as WE
  means them, HSV tints, sprite-sheet cross-fades, live overrides. Corpus still 93 ok, nothing newly broken. Live.
- **Scene switch under load fixed:** on a busy machine a heavy scene could take 13–28 s to load and the switch to
  it failed at 10 s. A scene that is still loading (its worker still getting CPU) is now waited for up to 50 s
  while the old wallpaper plays on; a stuck load still fails/restarts. What's playing isn't slowed. Live.
- **Scenes, batch B5 (fork patch 0029, pin `d7a9f34`):** parallax follows the mouse the way WE does (delay
  smoothing — 14 of 25 parallax scenes were frozen), plus camera shake, `general.zoom` and camera-object zoom.
  Corpus unchanged (93 ok). **Please look at 3516174947** in WE vs here: its camera "Lens size" 0.75 now zooms
  its layers out (32 % black) per the decoded formula — a WE capture would settle whether that's right. Live.
- **Command-queue fix (backend):** a live speed storm on your session (wallpaper speed jumping ~03:59–04:25, audio
  muted, settings restored) filled the backend's player queue twice. Cause: setting 315 items' speed overrides in a
  row queued one un-mergeable command each, and the 256th dropped one (could be the playing item's speed). They now
  batch into one pass; a cap hit logs what was pending. The stall breaker never tripped in 25 min (still open).
- **Scenes, E41 (fork patch 0037, pin `3eaac6e`):** an effect switched by a wallpaper setting (or by its script)
  now turns on and off live, the way WE does. Before, it changed only after a reload. 33 scenes have such
  switches, e.g. Bunk's "lights on", Retro Room's pulse, the "ts" overlay of 3163060610. On the 28 of them that
  load and draw, flipping a setting live gives the same frame as setting it before load. Not done: script
  `getEffect()` and the media-event scripts (batch B10).
- **Scenes, batch B10 (fork patches 0038–0044, pin `c60fd2e`):** wallpaper scripts now get most of Wallpaper
  Engine's API: clicks and hovers work (2325974975's "Mute/Time/Date/Hide/Bloom" buttons light up and "Hide" hides
  the text box), layers can be found by number, sounds can be played/paused from scripts, settings reach scripts
  when you change them, and scripts' saved data survives a restart (`~/.local/state/liascape/scene-storage`).
  **"Now playing" widgets** read your MPRIS player (whichever is playing; Spotify's cover is downloaded once with
  curl): e.g. 2134765860's shelf poster shows the album art. Script errors over 20 scripted scenes dropped from 867
  to 183; most of what's left is audio-reactive scripts (batch B8). 3414858021's date text now moves off-screen
  because text layers don't follow their parent yet (batch B4).

- **Scenes, batch B8 (fork patch 0045, pin `592fdff`):** audio-reactive wallpapers now use Wallpaper Engine's own
  spectrum (decoded from wallpaper64.exe): its bands, smoothing and auto-gain, `engine.registerAudioBuffers` for
  scripts, and particle emitters whose rate follows the music. With a synthetic tone, 22 of the 39 audio scenes that
  load visibly react (2542468435, 3029971128, 2890767643, 1556245028 the most). Left and right are still the same:
  the player feeds one mono mix; stereo is a TODO. The agent doing this hit the weekly usage limit mid-way; the
  rest was finished in the main session.

- **Scenes, batch B7 (fork patches 0046–0047, pin `c4eea29`):** blend modes and compose layers now work the way
  Wallpaper Engine does them (decoded from wallpaper64.exe):
  - Layers that blend with the scene read a copy of it instead of the image they're drawing into.
  - "Add" (mode 31) is plain additive blending: 2883756643's bokeh and 3184155462 are brighter.
  - Effects no longer pull in the opposite edge of a layer (WE clamps by default).
  - Compose layers draw their child layers through their own effects: 3490034653's light shafts are now masked the
    way the author set them up.
  - A B8 bug was fixed on the way.
  - All 88 scenes that load still load, and frame time is unchanged. 3426575339, 3432876246 and 3556794116 render
    blank on every core, including the previous one, so that is a separate fault to look at.


- **The "blank" scenes weren't broken.** 3426575339, 3432876246 and 3556794116 were blank only in the test
  renderer (`--lwe-smoke`), and on every core going back to before E41, so nothing in B10/B8 broke them. Their
  picture is a video, which plays in real time, and the test ran 3 s of the scene in a fraction of a second, so the
  video never got its first frame. Your player was never affected. The test now runs in real time: all three
  render, and so do 3046119914 and 3432999904 (the two "black" ones). 93 of 96 scenes pass; the 3 left are the known
  3D scenes. Earlier test numbers for the 12 video scenes were taken with the video black.

- **Scenes, batch B4 (fork patches 0048–0050, pin `e372e44`):** text in scenes now works the way Wallpaper Engine
  does it (decoded from wallpaper64.exe).
  - Clocks, dates, song titles and labels are drawn as image layers. They take their effects (glow, shake, tint),
    follow their parent, turn, and move with parallax. 3414858021's date block is back on screen.
  - They are sized as WE sizes them (300 dpi), wrap at their width limit, stop at their row limit with "…", align
    left/right/centre, and do multi-line and Chinese/accented text.
  - System fonts (`systemfont_arial` etc.) come through fontconfig. Here that's Arimo, Comic Neue and Inconsolata;
    before, the text vanished on NixOS.
  - Two bugs found on the way: a text of 2–4 words ("Sinner #8") vanished, and a colour setting written "1 1 1" was
    black (117 colour settings in your scenes are written that way; e.g. 2134765860's clock).
  - Compared with the sizes WE's editor saved, 44 of 50 texts match in height within 2 px.
  - Also re-checked B7's blend modes on 2883756643 now that its video shows: still right.
