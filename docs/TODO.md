# liascape — TODO

Running list of things found while working that aren't done yet. Newest context first within each section.
Delete an item in the commit that does it (the commit message is the record). Product work only — the repo is public;
one person's own reminders go in their gitignored `CLAUDE.local.md` / `docs/NIGHT-NOTES.md`. Design for the new player: `docs/superpowers/specs/2026-10-20-utopia-player-design.md`.

## Queued (in order — the next thing to pick up)
1. [x] **UI performance** (done df573913; follow-ups 10–11): playlist-bar hover (`useDockLift` forced layout per frame, per-item
       re-renders) and tab switch + sidebar long tasks (100–250 ms). After they hand back: review, build + lint, matrix
       `--changed`, then re-measure the owner's live app with the same synthetic traces and commit.
23. [ ] GIF previews freeze on the frame they're showing while the window is unfocused (today they swap to the
       still, usually frame 0): at blur, draw each on-screen gif's current frame to a canvas over it (one drawImage
       each, then nothing decodes); on focus the gif continues on its own clock. Exact resume at the frozen frame needs
       our own decoder (~2x CPU, +400 MB for 40 gifs: docs/decisions.md § "Let a hidden gif preview keep its own
       clock") — not unless the owner asks.

## On a real desktop session (not hermetic)
- [ ] Battery rerun: `programs.sh dropout` with `P3_RECORD` on the real session (Phase 3 findings, below). It plays
      test tones on the real output, so mute the sink first: PipeWire's monitor taps before the sink volume, so the
      recording still gets the full signal (check that before trusting the run). Hold new agents while it runs.
      Headless run 2026-11-12: 79/80, 0 drops; its one `frozen` micro-gap was a real click (a frozen transition
      committed by a mid-effect `next` started B at full level), fixed — the real-session rerun is still to do.
- [ ] Compare `docs/player/reports/we-ref/compare/` side-by-sides against WE on Windows (a human's eyes are the final word).
- [ ] Decide: UI-matrix randomized runs (optional).

## Upstream PRs (once the project is done)
- [ ] Draft PRs offering the LWE fork's patches upstream (Almamu/linux-wallpaperengine), several small focused ones.
      Drafts only: opening them publishes under the owner's name, so the owner approves each before it's sent.
- [ ] Optional: auto-mute flapped 6× in 16 s on 2026-11-06 (Spotify + a notification, 500 ms unmute delay) — a longer
      unmute delay stops it.

## Switch-over bar
- [ ] Resume the switch-over check (design §11: liascape-player becomes the default and the legacy path goes only when
      the bar holds on the owner's machine). The stopped 2026-11-05 draft is committed as WIP on local branch
      `switchover` (cce3d982, worktree `.claude/worktrees/switchover`): the seam probe, test hardening, and the
      checklist report `docs/player/reports/switch-over.md` with placeholder results. Rebase onto lp-player, measure,
      fill the report; owner-only rows go to "Waiting on owner".
      **2026-11-11 measured, report filled** (`docs/player/reports/switch-over.md`): C1 pass bar the `frozen` onset
      micro-gaps (1075 switches, 15 modes, 0 real drops, 0 seams in 475 with the probe; 16 micro-gaps of 2–10 ms, all
      at a frozen B's onset, the sink recording can't tell them from unflagged ones); C2 pass (11-10 runs); C3 pass on
      pre-WE-port code; C4 never run at 8 h; C5 pass. Recommendation: not yet — the report's "Waiting on owner" list:
      watch switches (a late heavy scene makes the old clip hold its last frame up to ~2.5 s), listen to frozen onsets,
      every setting by eye, the 8 h soak (`scenes.sh soak --minutes 480`), crash isolation re-run (`scenes.sh crash`,
      `programs.sh crash`), and the owner's calls in § 5 (count frozen onsets? start-up seam? Phase 4 vs 5?).
      Fixed on the way: the battery's late-B "handoff" check (the test) and the dropout probe's ended-A snapshot
      (`started_snapshot_of_a_long_ended_a_is_past_its_end`).
- [ ] Kimi (2371103399) builds in ~2.5 s since the WE port (warm `--lwe-smoke` build_ms; 11-03 pin 0.86–1.13 s, 10-28
      0.69 s): profile LWE's build and bring it back.
- [ ] Seam probe at start-up: the restored wallpaper's layer points at its source before its first frame (4 frames per
      output on the owner's player at 04:49). Owner's call (switch-over.md § 5): wait for `Ready` or exempt start-up.

## UI
- [ ] Red on HEAD, cause not yet found (rerun alone, `--jobs 1`): matrix `single × playlistBarPlay` ("expected k1 on screen,
      /current says k3 — no switch to k1 was requested").
- [ ] Scripting for advanced users, as part of the macro feature = the rules system (triggers → actions with exceptions;
      research in `docs/superpowers/specs/2026-10-29-rules-recon.md`): an advanced tier where users write scripts.
      Owner 2026-11-10: it should be general-purpose enough to build intricate setups that the built-in
      triggers/actions can't express (the escape hatch, not just one more action type).

## Legacy player (current app) — small fixes
- [ ] **Reveal/frozen don't match the intended semantics** (owner, 2026-10-20: "audio follows the picture"):
      - **Video-end advances** with reveal/frozen fire ~effect + warmup *before* A's end (`DoVideoEndWait` leads by
        `duration + coverMs` for every method; `--align-a-end` only exists for full-live). So A freezes several
        seconds early instead of on its **last** frame. They should fire at A's end.
      - **Reveal** hard-cuts A's audio at the freeze (possible click) and starts B's audio at full. It should get a
        ≤ 30 ms anti-click fade on A, and B rising with the reveal (or full from the start, if the owner prefers).
      - **Frozen** is already silent through the effect, which is correct; it needs only the ≤ 30 ms anti-click ramps.
- [x] `nix flake update` → mpvpaper **1.9** (PR #132 `glFenceSync` leak fix). Done 2026-11-06: `nix flake update
      nixpkgs` → `1d06008` (2026-11-03); the review is the commit message. Headless soak (a private headless sway,
      synthetic 1080p60 loop, 4 min each): 1.8 grows linearly ~19 MB/min (553 → 626 MB), 1.9 is flat (664 → 668 MB,
      no growth after 90 s).
      - [x] Soak 1.9 on the real desktop (Owner's `RestartMpvpaperEverySeconds` is **0**; 1.8 reached 1.66 GB RSS in
            42 min). Run 2026-11-11 01:42–04:42, 180 min, both monitors, workshop 2546567838 `Walk.mp4` (4K60,
            nvdec, `no-audio loop`), sampled each minute (`.mpvpaper-wrapp` RSS + `nvidia-smi` per-process memory).
            **GPU memory flat**: 1143 MB from minute 8 to 178 (1125 at the end), so the 1.8 GPU-side leak is fixed.
            **RSS still grows**: 281 MB (0) → 243 (30) → 345 (80) → 413 (120) → 451 (140) → 489 (170) → 511 (180).
            Growth is steady, in ~16–20 MB steps every ~10–20 min (~1.7 MB/min, ~100 MB/h), with no plateau by
            minute 180; it is not the 8-min loop (steps don't line up with it). ~11× slower than 1.8 (~19 MB/min),
            but not flat, so the restart default (600 s) **stays**. Open: find the RSS growth (mpv demuxer/hwdec
            pool? try `demuxer-max-bytes`, `hwdec=no` A/B, a 1080p file) before relaxing it; a 1 h restart would
            cap it at ~100 MB.
      - [ ] Electron 42 is EOL: nixpkgs marks `electron_42` insecure, so the flake lets electron 42.x only through
            (`allowInsecurePredicate`). Move the flake, `app/shell/package.json` (+ its `allowScripts` key) and the
            AppImage to a supported major together (43 in nixpkgs now); check the NVIDIA GPU-process crash-loop first.
      - [ ] `scripts/lwe.sh --nix` loses the caller's `LIASCAPE_LWE_CORE_DIR`: the devShell sets it to the store core,
            so `build` tries to install into the read-only store. Workaround: `nix develop -c env
            LIASCAPE_LWE_CORE_DIR=<dir> bash scripts/lwe.sh build …`. Fix: carry the caller's value (or the
            `build/lwe-core` default) across the re-exec.
- [ ] Measure the scene legs (V→S, S→V, S→S) of the cubic-volume crossfade fix (`6f0433a`). Only V→V is measured.
- [ ] Harden `AUDIO_SETTLE` in `liascape-transition`: pin `audio-buffer=0.2` on the overlay decoders, and derive the settle
      from audio-buffer + 2× PipeWire quantum. Only worth it if legacy stays the default for long.
- [ ] First transition after backend start can fire late (lead estimate unmeasured). Gone in liascape-player.
- [ ] Optional: reword the stale "WIP" commit titles `161bf0f` / `8c5c0e6`. They're pushed, so this needs a force-push;
      owner's call.

## liascape-player (after design approval)
- [x] **Advance-on-end play-time limits** (owner, 2026-10-28: "maximum minimum when end on wallpaper"): a minimum
      (a shorter clip loops and advances at the end of the loop that reaches it — never mid-loop; a still image shows
      for it) and a maximum (a longer clip, and a scene, advances once it played that long — now, with its transition),
      wall-clock seconds, 0 = off by default, global + per-playlist override, live, kept across a backend restart.
      `player-adapter.md` § Rotation (was § Play-time limits; the minimum merged into the interval field since), UI `PlayTimeInput`. Guards: IT §
      "advance-on-end play-time limits" (RED on the base backend), self-test `PlayLimitAssertions`, settings-merge,
      matrix `playlist|global:minPlay|maxPlay`, `global:maxPlay:own`.
  - [ ] Legacy engine: the maximum works (shared tick); the minimum hold is liascape-player-only (legacy's video-end
        polling path untouched — owner: liascape-player only).
- [x] **Rotation redesign** (owner-approved, 2026-10-28): "Switch when video ends" off → "Switch every" (a plain
      timer, unchanged); on → the SAME interval field is "Minimum play time" (play at least this long, then switch at
      the next video end; a shorter clip loops to a loop's end; an image / a scene shows this long) with "Maximum play
      time" right below (switch even mid-video). "Wait for video to end after interval" and the separate minimum are
      gone (no in-app migration — a one-off jq script converted the owner's settings / playlists / session files).
      Same in the playlist modal. `player-adapter.md` § Rotation. Guards: IT § "advance-on-end play-time limits" + scene
      + backend-restart (RED on the base backend: 26 fails incl. every new check), settings-merge (RED 6), self-test
      `PlayLimitAssertions`, matrix `plAdvanceRelabel` / `gAdvanceRelabel` / `gAdvanceOn` / `playlist|global:minPlay|maxPlay`.
  - [ ] A later task renames code identifiers to the UI labels (`IntervalSeconds` → switch-every / minimum, …).
- [ ] Health follow-ups (2 of 3 done 2026-11-02): ~~the playlist modal's Transitions field had no health icon (the global row
      has)~~ — it has the same warning icon now (`components/FeatureWarn.tsx`, `useFeatureWarnings`; probe-health cells);
      ~~the PipeWire bus being down isn't reported~~ — `hello.health.bus` → the `audio-bus` row of `/health/features` (ok /
      reason "sources play on mpv's default device" / unknown; summary only, no setting row), adapter IT + self-test +
      probe-health guard it. **Still open:** Intel GPUs have no VRAM probe at all (an Intel-specific one would make the VRAM
      rules work there).
- [ ] Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signal shipped in Phase 3 Task 14; the web
      worker; the switch-over bar per §11; the ongoing scene-compatibility programme). Roadmap summary:
      `docs/player/architecture.md` § 6.
  - Phase 3 Programs and Signals (rotation, history, restore, pause-when-covered in the player; daemons retired): plan `docs/superpowers/plans/2026-10-29-liascape-player-phase3-programs.md` — Tasks 1–14 done; on-machine numbers and findings in `docs/player/reports/phase3.md`. Task 14 (in-player auto-mute): **flipped 2026-11-02** after the on-machine parity run (§ 7, owner-approved; criterion 9 read as "reasonable"): the player's Signal is on by default (`LIASCAPE_PLAYER_AUTOMUTE=0` = off), `AudioMonitor.AutoMuteParityPassed` is gone, `monitor-daemon` is retired under liascape-player, `FeatureHealth` reports the Signal's needs. Still open: criterion 3 for a new stream under full CPU saturation (harness only, `lia-sysmon` lag, not traced); MPRIS through the backend with a Playing player and a Flatpak player untested; a player without the capability has no auto-mute with the app closed (accepted: the escape hatch / a bus-down player).
  - Phase 2 scene worker (`docs/superpowers/plans/2026-10-27-liascape-player-phase2-scene-worker.md`): **all tasks
    done** (Tasks 1–15, the Task 8 backend wiring, the properties editor and loudness learning). Task 14 — the
    on-machine battery — ran 2026-10-29: `docs/player/reports/phase2.md` (`src/player/tests/onmachine/scenes.sh`,
    also `battery.sh scenes`); bar the owner's VT-switch/suspend check (Waiting on owner) only the findings below
    are open.
  - **Phase 2 battery findings (Task 14, `docs/player/reports/phase2.md` § 10).** Fixed with tests: F1 scenes at
    the refresh paced by frame callbacks, F2 the dropout detector's ramp-edge bins + meter gaps (`unmeasured`), F3
    the bus meter on the RT data thread, F5a the GPU budget reads every output, F6a the source mirror writes only
    changed values. Open:
    - [ ] **F6b** (on-machine 2026-10-29, `phase2-20261029T202428/workers.json`: 4 workers mid-fade **2.45 %** per
          worker vs the 0.6 % bound — still FAIL; 2 workers steady within noise, PASS) — compositor CPU per scene worker mid-transition 2.75–4.05 %** (steady state 0.1 % after F6a):
          during an S→S fade the runtime recomputes `srcs:` / the scene demand on every sync (`Graph::get`,
          `srcs_for_connector`, `format!` of paths at the top of the profile). Cache per `picture_rev` / transition
          change. `perf`: `nix shell nixpkgs#perf -c perf record -g -p <compositor>`.
          **Root cause fixed (2026-10-29, "Cache Each Scene's Demand Per Routing Change"):** `SourceHost::sync`
          (once per worker frame) recomputed every scene's `outputs_of` — 17.7 % of the main thread mid-fade; now
          cached per `Graph::demand_rev` (2.4 %). Headless A/B (`scenes.sh transport`, 144 + 240 Hz, 4 synthetic
          workers mid-fade): excess user instructions 0.85 → 0.33 G/s, CPU 2.6 → 1.2–1.6 % per worker (headless
          CPU is ±1 %). What's left is the per-frame transport (latch, fences, the `time_pos` mirror) and the
          transition's 1 kHz gain timer. **Owner:** re-run `scenes.sh workers` on the real outputs for the 0.6 %
          bound (it can only be judged there).
          **Round 2 (2026-10-29, "Update Only The Source A Wake Was For", "Drop The Scene Transport's Idle
          Syscalls", "Stop Allocating On Every Graph Write"):** each worker frame is a loop wake (~1.5 with the fence
          wake), and every wake updated *every* source, re-synced every source, re-derived each output's routing
          from the graph, read every worker's socket/pipe + `waitpid`ed it, `eglWaitSync`ed the already-signalled
          acquire fence (~10 syscalls + an ioctl on NVIDIA) and pushed 1 kHz gain steps to soundless workers. Now a
          wake updates only its source, `sync_sources` runs only when due, routing is cached per `demand_rev`, reads
          follow epoll readiness, no wait on a signalled fence, soundless scenes only fold their gain (details
          `phase2.md` § 10 F6b round 2). Headless A/B (3 rounds each, isolated builds): mid-fade excess user+kernel
          instructions **0.40–0.42 → 0.14–0.21 G/s**, main-thread syscalls per worker frame ~56 → ~29. On the real
          outputs (`f6b-20261029/om-*`, machine loaded by another agent): mid-fade compositor instructions
          1.05 / 1.45 → 0.77 / 0.74 G/s; the CPU check **PASS 2/2** (−0.25 / −0.3 % per worker; HEAD in the same
          session 2.25 / −0.05 %) — CPU % there is noise-dominated (baselines 23–37 %). **Open:** confirm on a quiet
          machine. What's left per frame is the transport floor (`recvmsg` Frame, `sendmsg` Tick + Release, the release
          fence — NVIDIA's `eglCreateSync` + dup alone is ~12 syscalls). Next lever if needed: reuse one release fence
          for every slot not sampled since it was made (one per compose instead of one per latch, ~halves the fence
          syscalls). Tried and dropped: a worker thread that sends each `Frame` after its fence (1 compositor wake per
          frame) — no compositor gain once a wake was cheap, +2 worker context switches per frame.
    - [ ] **F1 follow-up — tick scenes from the frame callbacks / the exact refresh** instead of a rounded-Hz grid,
          so a scene at the refresh never beats against the vblank (F1 fixed the presents, not the content clock).
- [ ] **Explicit sync back on NVIDIA once egl-wayland2 > 1.0.2 ships** — Task 20e: 1.0.2 leaks one queued
      `wl_buffer.release` (~224 B) per present with explicit sync (upstream fix 6235dd8, 2026-09-09, unreleased),
      so `serve` defaults `__NV_DISABLE_EXPLICIT_SYNC=1` (cost: 240 Hz interval p95 ~4.7 → ~5.2 ms, loop tick
      p99 ~0.3 → 1.6 ms, 0 missed) and drains libwayland's default queue every iteration. With a fixed driver
      the drain alone is leak-free: drop the env default (keep the drain). `docs/player/modules/wayland.md` § Wayland NVIDIA notes.
- [ ] **Load-sensitive test flakes** (seen once each under a busy desktop, never reproduced unloaded):
      `stepped_align_end_reveal`, `bus_down_falls_back_to_default_device`, `supervise::crash_restores` (clip
      wrap under load). Watch; harden their timing margins if they recur.
      Not a margin: `i2_switch_while_gated_never_leaves_a_playing_source_silent` (~1 in 8 under CPU load) was
      a real bug — a resuming pause gate was dropped on a second clock read after its last `ramp_db`, so
      `gain.pause` stayed a hair under 0 dB for good (−0.0003 measured; −0.04…−0.56 dB with a 2 ms stall
      injected, 4/4 RED). The drop now writes the exact 0 dB.
      **Adapter IT (`scripts/test-liascape-player-adapter.sh`) — fixed (2026-10-27).** Reproduced with the IT and 16
      CPU burners pinned to 8 cores (`taskset`): 3, 1, 1 and 2 failures in 4 runs (16 unpinned burners at load 26:
      0). Causes, none a margin: fixed sleeps before reading a state that converges (the first `/apply` not on
      screen after 1 s; a setting not landed after 0.3 s); the pending B of the R61 section (dee, 10 s at 1.25×)
      handing off to bee (its own 40 %) before the SIGSTOP section's last read (`after SIGCONT → −23.88 dB`);
      the speed-drop check looking a fixed 9 s after the drop, past E1's REAL end when the drop landed late;
      the drag sections' 8 s fades running out (`null dB`); a python spawn per poll missing L1's 0.7 s window
      (and a stale E2 corr from an earlier section arming it at once); `/playlist/play` once taking its full
      10 s curl timeout, so "handoffs in 9 s" counted 17 s; reads after a window taking seconds (3.4 s for
      four), so "what was on screen at t" read a later state; an import past `post`'s 10 s; the WebSocket
      client not up 0.5 s later. Now: `waitfor` condition waits on a real deadline for every converging state,
      the pending B cancelled once its part is done, windows measured from the clip's own position (the old
      backstop bound + 3 s ≤ the check ≤ E1's end − 1 s; the restart windows close 6 s after E1's end), rates
      and "at t" judged by the events' own `t_mono_ms`/`t_wall`, 60 s fades, a 60 s import timeout. Fixed
      windows stay only where the window is the check (no switch in N s) and the latency bounds keep theirs
      (< 500 ms SIGSTOPped, < 100 ms `/preview global`: those two DID fail once at load ~45–50 with other
      agents' builds on top — load genuinely breaks them there; left alone). After: 115/0 in 2 pinned runs at
      external load ≤ 22 (+ runs at 33–50 whose remaining failures were the next items). R81's "reapply after
      the restart" check used to match ANY earlier reapply line; it now needs one after the kill — or the
      identical line < 10 s before (the adapter log drops repeats: see the stale snapshot below).
      **Product, seen under IO load, not fixed (reported):** (a) the snapshot lagged a switch by 2.4 s (fsync on
      a busy disk), so a supervised restart brought back the PREVIOUS wallpaper (dee instead of a) and R81
      re-applies settings, never the wallpaper; (b) an in-place upgrade failed: the old compositor's clean
      quit took 3.1–3.3 s (`player.quitting` → `player.exit`), `QuitOrKill` escalated to SIGKILL, the new
      player didn't answer within `UpgradeInPlace`'s fixed 3 s, and the backend fell back to a plain
      `serve` (no `--restore`, no `--headless`).
      **Stepped `step` timeouts — a real bug, fixed (2026-10-27).** With 16 burners pinned to the test's 8
      cores, `settings_reach_pending_b` + `stepped_align_end_reveal` failed EVERY run (8/8, also once
      `hotplug_added_before_running_joins_transition`): `no frame within 2 s from src1 (t=2.5–2.8 s, waiting
      for frame)`. Instrumented: mpv queues each step's NEW frame to the VO in the playloop iteration that then
      emits PLAYBACK_RESTART, so the loop rendered it before pumping the event (every step under load); the
      step then only completed on mpv's REDRAW after the restart (`next_frame_is_redraw` = true), which didn't
      come at 2.8 s of a 3 s clip with its loop off. `StepSeek::target_frame` now counts a non-redraw frame
      rendered after the seek's reply, before or after the restart (a redraw before the restart is the
      previous step's frame and never counts); completing on it, the step reads `time-pos` once (stepped
      only) so it still returns a settled state (`player_pause_freezes_*` saw the frame's `time-pos` arrive a
      step later otherwise). The `t=0.000s, waiting for seek reply` variant (1 in the 8 before-runs, 1 in 11
      after): the source's OPEN took the whole 2 s (`source.ready` at the deadline), the seek it then sent
      timed out at once — a source that had to open now gets a fresh `STEP_TIMEOUT` for its seek once ready
      (one not ready by the first deadline still times out). After both: 0/10 loaded runs of 7 tests, full
      `api`/`sources`/`supervise` green.
      **`tests/supervise.rs` — fixed (2026-10-27).** CPU burners alone: 0/43. With 4 of the 16 writing +
      fsync-ing 32 MiB files and 4 copying 256 MiB buffers: 11/14 runs failed — `wait_snapshot` (300 ms / 1 s:
      the snapshot is fsync'ed twice) and `supervisor_sigkill_reaps_child_fast`. Measured there: the child's
      PDEATHSIG SIGTERM (`player.quitting {why: signal}`) 3.5–10.3 ms after SIGKILLing the supervisor (57 runs),
      but its clean exit (final snapshot fsync'ed) 0.1–11.8 s. The test now asserts the signal ≤ 300 ms (the
      point) and the exit on its own within 30 s; snapshot waits are `SNAPSHOT_WAIT` 20 s. After: those 0/19;
      `crash_restores` still fails 6/19 there on its 1.5 s `RESTART_BUDGET` (hello 1.5–3.6 s after a SIGSEGV
      under IO load) — a stated latency budget, kept; measured, not fixed.
- [ ] **UI × player-state matrix** (`scripts/test-ui-matrix.sh`, driver `app/shell/probe-matrix.js`: every
      playback control of the real UI + every keybind command × idle / single / playlist / effect running /
      align:end pending / paused / paused mid-effect / no output / muted, hermetic). Fixed from its first run:
      trash left items in the playlist (a rotation played the missing file; an armed switch still fired to
      it), trashing an item whose switch was requested but not yet running kept it playing, undo didn't put
      it back; keybind next/prev/random on a single wallpaper switched behind the UI (now forwarded to the
      running backend); keybind volume reverted by the next UI save; play-from saved the playlist bar reordered; Play
      / play-from while paused stayed paused; `previous` at the first item with an armed advance relaunched
      the current one; mute while paused never reached a source (setting ramps on the frozen clock); the
      installed app got no WS events and lost its localStorage prefs every launch (random port = new origin).
      **Round 2** (2026-10-25 night): `--jobs N` runs N hermetic stacks in parallel (default 6; full run
      40 min serial → 14.5 min at 4 → 10 min at 6 → 8.3 min at 8 but 13 cells timed out entering their state
      (all passed alone); ~0.8 GB each, capped by MemAvailable, the run stops under a 3 GB floor;
      `LIASCAPE_MATRIX_NICE=1` + `--jobs 2` next to someone working — 4 stacks lag the desktop); the window is
      SHOWN on the private Xvfb — hidden it rendered no frames (rAF never ran: framer-motion/WAAPI exits never finished, dnd-kit's rAF-aligned pointermoves coalesced so a drop
      saw a stale target, gifs/the live bg sat paused unfocused). ~90 new cells, each only in the states its
      halves share: playlist bar drag-reorder through real input events (`sendInputEvent`), remove (X / context
      menu) of the shown / incoming / other item, Save / Load modals, the playlist-settings modal (interval,
      0 s on the way, wait-for-end, shuffle, transition off / duration / effect), the global Rotation section
      + transition method + global interval vs a playlist following the globals (opt-in states
      `pendingGlobal` / `playlistGlobal`) and one with its own override, multi-select (Ctrl+click: trash,
      trash + undo, toggle add / remove, the settings modal on both live sides; Shift+click range + the
      Delete key; Ctrl+A + Delete + Undo), the card's own toggle, a
      saved playlist overwritten, two controls in a row (slider drag → next, pause → play-from, mute →
      next, a global setting → next, next+next, next+prev, preview drag → close → reopen, remove / drag /
      load / transition change → next, two card applies / playlist bar clicks in quick succession, two trashes + two
      undos, pause → interval change: the rotation holds until the resume, a slider drag closed with Escape
      at once), a settings save/load race. Fixed: settings.json was written in
      place — a read mid-write got the C# defaults, applied live and saved back over everything (/settings'
      own `prev` → an engine flip, the Steam tokens gone); an armed align:end switch kept the transition it
      was armed with (playlist + global transitions, method) — it fired the old effect at A's end; removing
      the playing item from the playlist bar restarted the rotation from the top (now: from its place).
      `LIASCAPE_MATRIX_DLL=<older build>` / `--ui-dir` show a fix RED.
      **Round 3** (2026-10-26): 42 controls / 112 cells (full run now 709 cells: 681 pass, 28 structural skips,
      20m48s at `--jobs 4`). The rest of the global Settings page: Rotation
      wait-for-end / advance-on-end vs a playlist following the globals (`playlistGlobal` / `pendingGlobal`)
      and one with its own override, the playlist's "Override global rotation" both ways while armed;
      Normalize audio (on / off / target preset / switched on unmeasured / then next / across a NoAudio round
      trip — the oracle now checks every live source runs ITS OWN item's loudnorm); appearance (theme, aspect,
      card size, gifs, live bg) and the legacy-only leak-restart, every source sampled back to back while the
      change saves (nothing may move, even for a moment); auto-mute against a PRIVATE PulseAudio the script
      starts (own socket under the stack's runtime dir, one null sink, no device / D-Bus / autospawn — the
      session's audio server is never seen; no pulseaudio → the cells SKIP): a synthetic stream mutes every
      live source in every state and unmutes after the delay, B comes up muted, toggle-mute around it, off
      while muted, mpv's own stream and one under the level threshold never mute, mute / unmute delays. The
      order a shuffle plays (the backend's contract: each cycle one pass in a fresh order, no repeat across
      cycles, shuffle on mid-session plays the rest once first, previous walks back through what played,
      Sequential again = the playlist bar's order). Seven chains of three or more controls. The volume keybinds with
      overridden items. Read-while-save races on playlist_state.json and index.json. Fixed: normalization reached `cur:*` only — an effect's A, a pending B and every
      source while no output shows one kept the old `af` (RED 9 of 20); a loudness measurement landing while
      its item played was never applied, it played un-normalized until its next switch (RED 3 of 3); every
      settings save (a theme change too: the UI posts the whole object) set `srcs:*` to the playing item's
      volume + speed and fixed the others up after — for one round trip an effect's other side / a pending B
      ran the playing item's (RED 12 of 20, deterministic with back-to-back sampling); the volume keybind
      pushed the new global onto a playing item with its own volume — it jumped off its override until the
      next settings save snapped it back (RED 10 of 10). Decided: the keybind is the keyboard twin of the global
      slider, so an overridden item keeps its volume (option: make it bump the playing item's override).
      playlist_state.json and the library's index.json were written in place: a read mid-save got a null
      playlist (the UI's init then held the DEFAULT playlist settings — the full run's pending × plAdvanceOff
      failed that way) or an empty index (every override read "follows the global") — RED 3–12 of 240 / 7–13
      of 360 reads per run; now atomic (`AtomicFile`, temp + rename) with a retried parse. Still in place:
      `SaveTimedState`'s timed_state.json (its other two writers already rename) and legacy's
      playlist_observer_paths.json — no cell reaches them (read by the daemons / the next process).
      Then the LOST update (the likely cause of the merged run's `paused × itemVol|playlistBarVol:other` — "k3
      volumeOverride null" under load, both passed alone 3/3; inferred, not reproduced in those cells): trash,
      undo, the WE sync and the direct-download reconcile loaded index.json, worked, and saved their copy back
      outside `LibraryStore`'s lock — over an override saved meanwhile. `race:indexLostUpdate` (40 k1 volume saves
      while k4 is trashed + undone ×15): RED 3/40 and 2/40 lost; every index write now goes through
      `SetMeta`/`Remove`/`UpdateIndex` under the one lock (`SaveIndex` private) — GREEN 3/3 runs.
      **Not covered yet:** the legacy engine (mpvpaper needs a real Wayland output), scenes (liascape-player plays
      them since Phase 2 Task 11 — the matrix cells are Task 12), Browse/download/Steam (network + accounts), per-monitor content (no per-output wallpapers in the
      backend yet), auto-mute's "Only if MPRIS player active" (needs an MPRIS player on a session bus — a
      private dbus-daemon + a fake player would make it hermetic; not built), Settings → Player engine (to
      legacy) / Clear settings / Autostart / Resume from last / Debug mode, a shuffle with advance-on-end (the
      same `AdvanceToNext`; 12 plays of ≥ 10 s clips is too slow for a cell), deleting a saved playlist (no
      UI for it).
- [ ] **Speed storm leftovers** (`src/player/tests/onmachine/speedstorm.py` — live, bus muted; fixed in the same
      round: the adapter's aligned-switch backstop, the 1× tempo-filter rebuild holes, the align:end estimate):
  - [ ] **Stall breaker trips without a slow player** — 6 trips in ~25 min of storm (the request after a trip
        and the R81 reapply then reset a drag), while every verb answered in < 3 ms and 6860 direct pings never
        took > 50 ms; one trip put the queue at its 256 cap (new sets dropped) and failed the storm's own
        restore sets. Not reproduced in a 4 min re-run once the trip got its own log line (`no reply to …
        (waited …; gen2 GCs …, thread-pool queue …)`) and the `loop` probe got `max_request_ms/cmd` (handler
        time used to be outside `max_busy_ms`). Next trip: read that line first.
        **Re-run 2026-11-03 03:59–04:25** (`speedstorm.py`, drag 540 s / global 540 s / flood 420 s, live, 315
        items): **no trip** (no `no reply to` line) — not reproduced in 25 min either. But the command queue hit its
        256 cap twice (04:08:45 at the drag → global edge, 04:24:57 in the 50/s flood) and dropped one queued
        command each time, despite the per-key coalescing — so ≥ 256 non-coalesced commands were pending: find
        which (switches/barriers from `/next` every 8 s? keys that differ per value?) before trusting the cap.
        — **cap hits explained + fixed (2026-11-03, `queue-cap`)**: both hits were the storm's own loops over
        every item's `/library/speed` (04:08:45 = drag → global edge, which clears all 315 overrides; 04:24:57 =
        the restore after flood 420 s + settle 10 s, which re-sets them), not the drag/flood/`/next`: each
        `ApplyOverride` was its own `override:<path>` key → 315 distinct keys, and the worker (each pass + the
        `program:items` push of 315 items it triggers) is slower than the loop. The dropped one was some item's
        override pass — the playing item's possible (its speed then stays wrong). Now per-item passes are a
        **batch** (`QueueBatch`: `override`, `sceneloudness` — one pending pass over every item since it ran),
        and a cap drop logs the pending kinds (`dropping <kind>; pending N: <kind> ×n (k keys), …; running …`).
        Self-test "per-item override burst": 317 overrides behind a clog, the playing one last → depth 3 (the clog + the batch + the items push), its
        speed lands (RED: depth 256, dropped, speed stuck at the preview's). The stall-breaker trips above stay open.
  - [ ] **Shared looping A on `align:end`** caches its boundary (`target_end`, from the drop + k·length at the
        old speed) — a speed change doesn't move it. Unused by the backend today (same wallpaper on every
        output = never shared); re-anchor at the next wrap when per-monitor wallpapers land.
  - [ ] **Missed frames scale with content fps** (render worker: 2.2–3.3 → 1.8–2.5/s at 2× 1080p120 — better, not
        gone; what's left is the loop's own compose/present): steady 2× → 0.0/s, 2× ±0.05 every 90 ms → 0.65/s on the
        240 Hz output; random 0.25–4× (up to 240 fps content) 1–1.4/s vs 0.16/s at 1×. Phase 2 render worker.

- [ ] Not ported (found in the C6 decode): WE's `g_PointerPositionLast` starts at 0 0, so a freshly loaded scene's first
      frame sees a move from the top-left corner to the cursor; ours places the first position as a jump (0106).
      Single frame, likely invisible — check against a WE reference before porting.
- [ ] Desktop pointer on Sway/other compositors: no global cursor source (Sway's IPC has none) → surface pointer.

## Backend structure
Two bug classes kept recurring; fix the class, not the instance:

## Older backlog
- [ ] **Scene A's sound warbles during a transition** (owner 2026-11-06, not always; maybe headphone-specific — they
      changed headphones recently): when the outgoing wallpaper A is a scene, the transition sometimes plays "loud quiet
      loud quiet", "like audio in reverse or some ghost". **Not reproduced (2026-11-06 night, 39 recorded transitions)**
      on a private PipeWire at the owner's quantum (64, real-time) with a private headless player (two outputs at
      144/240 Hz): scene→video, scene→scene (incl. both with sound), scene→synthetic; fade, rotateTransition,
      parametric_glitch, static_wipe, splitSlideOutVertical, DirectionalScaled, GlitchDisplace, VerticalClose,
      TilesWave, randomNoisex, angular, x_axis_translation; full-live, reveal, frozen; A at 0.8×/1×/1.25× (WSOLA on);
      the compositor SIGSTOPped 4–8× mid-fade (the owner's 13–34 s `worker.host_stalled` gaps, in small); and the
      owner's own pairs from their 2026-11-06 log (Workshop copies: 3432999904→MIKU_MK2, 2783122117→壁纸循环,
      2672425887→EP05_01m, 1864677589→Miku Miku, 3243449890→3432999904, 3593587273→3419466417). Each trial recorded
      the sink AND A's own stream (`pw-record` on `liascape-player-scene.<id>`). **A's stream is the scene's own sound
      × the equal-power fade, to the dB:** decoding the scene's sound file and aligning it, A − source − cos-fade
      stays within p95 0.18–0.44 dB, max ≤ 1.03 dB over the fade (13 trials whose scene has one sound file and
      aligned; the compositor-stall one 1.63 / 2.97 dB — the fade held while stopped, as designed). The "loud quiet"
      dips seen in 2672425887's fade are in the music itself: the source has them at the same ms.
      A synthetic tone A under heavy real B scenes: no phase jump or hole on the sink. The debug dropout detector:
      fit ok, 0 drops on all. Ruled out with that: the WSOLA stretch (owner's A speeds were all 1.0, nothing in a
      transition changes a speed — `compress_to` only rescales progress/gain), the worker's gain path, gate and
      clip, a stalled loop, the auto-mute (by-pid ownership of worker streams), scene loudness reports. Not covered:
      the owner's real output chain (EasyEffects convolver + EQ on the HDB 630, quantum 64 set by another client),
      a real compositor stall of seconds. Tools for the next try (or the owner's own machine):
      `src/player/tests/onmachine/transition_audio/` (`rig.sh up`, `record.py`, `srccmp.py`, `afade.py`,
      `sine.py`). Next step: when it happens, note the time and whether A's sound or B's is the one warbling (most
      of the owner's 2026-11-06 scene A's had no sound at all — 3042492564, 2638125030, 3419466417, 3104056709 —
      so the warble may be B's video fading in).
- [ ] Randomized matrix sequences (5–20 random controls, the oracle after each) — optional, owner to decide.

- [ ] **Matrix shard hung in `scene × sceneProp:restart`** (2026-10-28, the `--changed liascape-player --jobs 2` run for the
      fix above): shard 0 stopped after `sceneProp:set` for 30 min (stack healthy — backend `/health` 200, the player's
      `state` fine, the scene's worker running; the probe idle), killed by hand; the cell and every scene cell after it
      passed on a rerun (31/31). The probe has no per-cell deadline and two waits without one: `ctlClient`'s
      `connect()` (its timeout only starts after the connection) and `js()` / `executeJavaScript`. Give a cell a
      deadline (→ ERROR + the stack's state) and `connect()` its own timeout. Electron ignores SIGUSR1 here (no
      inspector), so the next one needs that deadline to say where it waits.
- [ ] Optional: a backend instance id in a WS hello (the page could tell a restart from a dropped socket). Not needed
      while every reopen re-reads; only worth it if `resync` ever gets expensive.

## Follow-up projects (each gets its own brainstorm)
- [ ] **Experimental: render a scene with real Wallpaper Engine** (owner, 2026-11-06: "maybe as a future
      experimental feature"; after the port, not instead of it). An opt-in per-scene backend that runs WE itself under
      Proton and imports its frames as a graph source (dmabuf, like the scene worker), for scenes our port still gets
      wrong. Watch [wallpiper](https://github.com/ejalxndr/wallpiper) (MIT, early: runs WE under Proton, patches the PE
      APIs WE needs, pipes frames as zero-copy dmabuf to a desktop portal) — borrow or integrate once it matures. Open
      questions: Steam running/logged in (DRM), cost per instance (RAM/VRAM/start-up), bridging pause/transitions/
      audio bus/pointer/properties/per-monitor, a clean WE install. The reference-capture setup
      (`scripts/dev/we-ref-capture.sh`, `docs/player/spikes/we-proton.md`) is its first half. wallpiper reviewed
      and run headless 2026-11-06 (`docs/player/spikes/wallpiper-ref.md`): borrow its Vulkan dmabuf capture layer
      and `GetCursorPos`/Progman shim, not the daemon (global `wallpaper64.exe` kill, Steam-client registration via
      Proton's steam.exe, one session per user, upside-down frame grabs). Steam is not needed: WE ran as app 0.
- [ ] **Deferred (owner, 2026-10-29: "overengineering at this time"): the app's background vs the desktop for
      scenes** — `WallpaperBg` can only play a video, so with a scene on the desktop the app shows the last video /
      a random one (a different wallpaper entirely). Options: a transparent Electron window over the real desktop,
      or the player streaming its output frames to the UI. A gif preview was rejected (360p).
- [ ] **Draft: "Game running" signal** (mute / pause while a game runs) —
      `docs/superpowers/plans/2026-10-29-game-running-signal-DRAFT.md`.
- [ ] **Deferred from Phase 2** (not Phase 2 work): web wallpapers — WE `web` items via CEF / LWE's `webhelper`,
      an optional build module, **Phase 4**, gated on the NVIDIA LINEAR-dmabuf external-only risk (spec §12); the
      `g_Daytime` uniform (LWE's core never updates it, it stays 0 — spike `lwe-core.md` §4.2; needs a host-side
      clock-of-day feed); scene-compatibility patches from the corpus (**Phase 6**, below).
- [ ] **Per-monitor wallpapers, user-facing**: UI assignment, per-output rotation, which monitor actions target,
      `/current` + preview per output, `--restore`, hotplug defaults. The player supports it from Phase 1.
- [ ] **Per-monitor audio mixing policy**: with different wallpapers on two monitors, both are audible at once
      (audio follows the picture). Decide: primary output only / loudest / all / user choice. liascape-player keeps a
      shared wallpaper playing and audible while it's still on another monitor; reveal/frozen hold a snapshot.
- [ ] Rebuild `scripts/PKGBUILD` + `scripts/build-appimage.sh` for the Electron + liascape-player world (both still build the
      pre-rewrite Avalonia app).
- [ ] Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#625 — closed unmerged, gap audit G06 —, #631, #694 …;
      #692, #677 and upstream `main`'s other fixes up to `38a5d60` are in since 2026-10-28 — UPSTREAM.md) as
      labelled patches. The corpus runner exists (Phase 2 Task 13:
      `src/player/tests/onmachine/scene_corpus.sh`, report `docs/player/reports/scene-corpus.md` — 92 ok, 1 static
      by design, 3 load_failed (3D) of 96 with LWE `bab619b`; it was 86 ok, 1 blank, 4 load_failed, 4 broken with
      `c902d06`); rerun it after every LWE patch. Its findings, each one an
      LWE (fork) patch, none in the player — every one reproduces with `liascape-scene-worker --lwe-smoke`, i.e. LWE's
      core alone; the report has each one's log tail + backtrace:
  - [x] **Real-WE references (goal pictures)** — done 2026-11-06, `docs/player/spikes/we-proton.md`. The real
        Wallpaper Engine 2.8.485 runs headless under Proton Experimental (umu, own prefix, own config, in
        `gamescope --backend headless`, no audio device, Steam not needed): `scripts/dev/we-ref-capture.sh <id>
        [--times …] [--prop k=v] [--pointer X0,Y0:X1,Y1 --pointer-time A-B] [--fps N] [--desktop]`, `--batch` over
        the Workshop folder. Every library scene has frames at 0.5 / 2 / 5 s in `docs/player/reports/we-ref/<id>/`;
        `src/player/tests/onmachine/scene_we_compare.sh` renders ours at the same times and ranks the differences
        (`docs/player/reports/scene-we-ref.md`). Rerun the compare after every LWE patch; recapture after a WE update.
    - [ ] Work down `scene-we-ref.md` (the fixes are follow-ups; this only measured). Since the scene clock
          (2026-11-06) the "time" rows are gone. Since the 2D round (2026-11-06 night, pin `92c1ada`) the top is 3D
          (3276522107: the 3D agent's), then the parallax scenes' 0.5 s frames (the late pointer, below), random
          particles / shafts (3490034653, 3478602089, 2561227934, 3363252053, 2511663284), random text (2951169110)
          and the open ones below (3463520581 and 3042492564 fixed 2026-11-11, fork 0123–0125; 3013489778 fixed 2026-11-10, fork 0118). Explained so far: each ranked scene's note (`scene_we_notes.json`).
    - [ ] 3042492564's clock (left after the 2026-11-11 fix): a faint dark rim where its `shine` rays raise the alpha
          outside the glyphs; WE shows none. The text's picture is premultiplied as WE's font pass leaves it (that part
          is measured), so how WE's shine combine keeps the rim light is open (its `BlendGlow` with the rays' alpha).
    - [ ] A compose (passthrough) layer named in another object's `dependencies` (3243449890's 16613, read by four
          clipping masks) keeps LWE's handling; WE sets flag 0x1010 on it too (the 2D round ported it for image and
          text layers only). 3243449890 has no WE reference yet.
    - [ ] The 0.5 s frames of parallax scenes (3233141951, 3219908811, 3363252053, 3354740764, 2951169110,
          3289734539): WE's pointer arrives with the capture's xdotool nudge after load and its parallax eases in
          from there; wallpiper (GetCursorPos hook) has it from the first frame. Nudge earlier, or take the 0.5 s
          frame from wallpiper.
    - [ ] The compare gives ours the Windows install's fonts (the faces WE drew with); the owner's player uses
          fontconfig's, so 19 scenes naming `systemfont_*` draw with stand-ins (3354740764's Consolas → Inconsolata
          wraps after 24 characters, not 21). Owner's call: a "Windows fonts folder" setting (auto-found on a
          mounted Windows install) for the player.
    - [ ] 3184155462's cursor ripple vs the owner's Windows: WE's ripple force scales with the frame time (≈10× weaker
          at 120 fps than at 30); at a matched 30 fps ours is WE's strength. The owner's Windows WE (main profile,
          `/mnt/Windows/…/wallpaper_engine/config.json`) runs at **240 fps** (Ultra, MSAA x8; the Linux library's
          `config.json` copy is stale: 30 fps, x2 — don't read that one), so on Windows the ripple is very weak, while
          ours runs scenes at 15 fps by default → much stronger, as the owner reported. Faithful behaviour is already
          in (the effect follows the scene fps); to look like their Windows, Liascape's scene fps has to be 240 too
          (GPU cost). Open: whether Liascape should offer WE's fps presets / a per-scene "match WE fps" option.
          Refs: `we-ref/3184155462/ripple-*`.
    - [ ] A 2D layer of a WE flag-0x100 image (unknown meaning) gets no last draw in ours (the genericimage3 /
          genericimage4 half of this item is closed: the same pixels for every library layer).
    - [ ] A 3D scene's CursorEvent `worldPosition` (ours: scene pixels) and WE's type-5 hit branch (GH 0x1401b5600).
          The hit test itself is WE's since 2026-11-10 (the cursor's ray against the layer's quad; 3509243656's planet
          rings). Gap audit "3D scenes against WE, part 3".
    - [ ] Video-texture scenes (13) crash WE under Proton (`mfmediaengine`): a reference for them needs Windows'
          own Media Foundation in the prefix (from the owner's install) or a Windows capture.
    - [ ] Music-reactive references (3445973124 "with music"): a private PipeWire instance with a null sink as
          WE's default output, winepulse pointed at it, a track played into it (the spike's "Blockers").
  - [ ] **WE ↔ LWE gap audit → porting batches** (2026-10-29,
        `docs/player/spikes/we-lwe-gap-audit.md`). It has 185 rows: what WE 2.8.485 scenes do (decompiled, or from
        assets/docs) that the fork doesn't, each with the number of the owner's 96 scenes that use it. Port it in
        the batches below, highest usage × impact first. After each batch, rerun the corpus and the batch's own
        smoke/capture check. The WE captures the owner can take on Windows are listed in the doc's "Needs the
        owner".
    - [x] **B4 Text renderer.** UTF-8, multi-line, alignment/limits, a fontconfig `systemfont_*` (text vanishes on
          NixOS today), drawn as an image so effects/parent/rotation/parallax apply (T1–T8, E34, G13, G30). 45
          scenes. L. **Done 2026-11-04** (fork patches 0048 text layers are image layers + 0049 text strings and
          `"1 1 1"` colour properties + 0050 wrap/rows/spacing/script alignment, pin `6bc301c`). Decoded: text
          extends image, 300 dpi, WE's layout, placement and padding, the systemfont table. fontconfig finds
          Arimo / Comic Neue / Inconsolata here. host_api_test 58/58 (5 new, all failing on 5a365d4); 44 of 50 literal
          texts match the editor's saved height within 2 px. See the audit's "B4 result".
          - [ ] WE captures of two clock scenes (1884904087, 2134765860) for size and line layout (T10 is decoded;
                this checks it).
          - [ ] Cursor hit tests now reach text layers (they are CImages); check 2325974975's buttons still behave.
    - [x] **B7 Blend modes / framebuffer.** Copy the scene FBO before sampling `_rt_FullFrameBuffer` (a feedback
          loop today), `clampuvs`, `copybackground` (E27, E28, E30, E31, E33). 28 scenes. M.
          **Done 2026-11-04** (patch 0047, pin `5a365d4`; 0046 fixes B8's registerAudioBuffers scope check). All
          decoded from wallpaper64.exe: copy before a pass samples its own target, mode 31 = additive, clampuvs
          (default true) on the composite FBOs, compose layers draw their subtree, `_a`/`_b` parity. See the
          audit's "B7 result".
          - [ ] WE captures of 2883756643 and 3414858021 / 3432999904 to confirm the inferred parts.
    - [x] **B11 Particles, extended.** Child systems, the missing initializers/operators, control points, rope/trail
          combos (P2, P10, P15, P22–P35). 29 scenes. L; first read the operator interpreter from asm. **Done
          2026-11-04** (fork patches 0051 operators as WE's interpreter runs them + 0052 child systems + 0053 control
          points, pin `a209070`): P2, P10, P15, P22, P28, P31–P35. GH 0x140265800 decompiled in REA (no decompile
          timeout); opcodes, record layouts and the forms of movement, the ramps, oscillate*, attract, vortex and
          turbulence are in the audit's "B11 result". host_api_test 61/61 (3 new, failing on 6bc301c); corpus 93 ok
          on both cores, none newly blank; player tests 737/0/3.
          - [ ] WE captures of 3174556087 (rain splash children), 2288455459 (firefly trails) and an oscillating
                scene to confirm the decoded forms against WE itself.
          - [ ] P27 non-default bounds / limitbehavior / axis semantics (decode the spawn interpreter's case; 0
                scenes).
          - [ ] `controlpointangle0-7`, vortex_v2 (case 0x10), P24 cone, P25/P26: 0 library users and unread —
                listed in the audit's "Leftovers result".
    - [x] **B12 Puppet warp.** MDLV 0013–0023, skinning, layer mixing, attachments (G06–G09; PR #625 is closed,
          unmerged). 14 scenes. L. **Done 2026-11-04** (fork patch 0054, pin `1eb795e`): WE's MDL loader (GH
          0x1402873f0: the vertex layout from the mesh's format word, every MDLV ≤ 0023, MDLS/MDLA/MDAT by section),
          CPU skinning, the layer clock/weight/normal and additive mixing, attachments, and puppets without effects
          drawn in place. All in the audit's "B12 result". host_api_test 62/62 (1 new, failing on a209070); corpus 93
          ok on both cores, none newly blank.
          - [ ] A WE capture of 3463520581 or 3233141951 to check poses and the attachment's (inferred) form.
          - [ ] Physics bones (none enabled in the library; WE's simulation is on an unread rigid-body helper family
                reached from the mixer GH 0x140228470); root motion (MDLA flags bit 0, 18 bytes, undecoded);
                `autosort`/`index` layer order (0 users, not in the exe's strings).
          - [ ] The scripted layer API (`getAnimationLayer`, `playSingleAnimation`; S26).
          - [ ] B14 builds its static MDL meshes on `Render/Objects/Puppet.{h,cpp}` (normals/tangents are parsed for
                the layout but not kept yet).
    - [x] **B13 HDR bloom + FBO formats** (E35, E23). 5 scenes. M. **Done 2026-11-04** (fork patch 0055, pin
          `0d66ae8`): a `general.hdr` scene renders into half float targets and blooms with WE's HDR chain
          (hdr_downsample_bloom → hdr_downsample levels → hdr_upsample(_cubic) back up → combine, decoded GH
          0x1401afbf0 / 0x1401b3b10 / 0x1401b42b0); effect FBOs take the format they name (rg88, r8, the f formats,
          rgba_backbuffer half float with HDR); WE's LDR bloom defaults 2 / 0.65. host_api_test 64/64 (2 new); corpus 93/96
          on both cores, none newly blank. Result: the audit's "B13 result" (§ 5). Left:
          - [ ] `combine_dhdr_upsample` (HDR displays) and `combine_video_hdr` (not ported).
    - [x] **B14 3D scenes.** Perspective camera, 3D image layers, MDL meshes + `generic4`, lights/fog (G20–G29, E13,
          E14, E43). The 3 load_failed scenes below. L. **Done 2026-11-04** (fork patch 0056, pin `40f2b85`, which
          also carries B13's 0055): G24, G22, G25, G26 point/spot (E13), G28 (E14), `transparentsorting`, camera
          objects and the 3D shake; decoded addresses in the audit's "B14 result". host_api_test 68/68 (4 new,
          failing on 1eb795e); corpus 93 → 96 ok, none newly blank; player tests 737/0/3.
          - [ ] Left: directional shadow cascades, light clusters, volumetrics' SHADOW / COOKIE / fog / directional (point and spot volumetrics and shape objects: done in F2, 0086 and 0088); skinned/morphed models, PBR-mask component combos, REFLECTION; fog on image and
                particle shaders; the 3D camera's parallax and zoom (WE's 3D projection doesn't read the zoom; its
                other reader and the 3D parallax block weren't read — 0 3D scenes use either); E43 text `depthtest`
                (no-op in 2D, not ported); customsortorder's reader; hit-testing world-placed layers; an
                output-sized 3D target; WE captures of the three scenes.
    - [x] **3414858021 (owner report): head gone, cursor trail y-inverted.** **Done 2026-11-04** (fork patches
          0057–0060, pin `e814c25`): SceneScript `angles` are degrees (scripts turned the body 55°, the head and arm
          left the screen); a pointer-linked particle control point was y up in a y-down space (trail mirrored);
          the compose layer holding the head didn't compile (line continuation, a written varying, a vec4×vec2
          truncation, a stray `#endif` — all accepted now as WE does); a failed parent orphaned its children. The
          bright band across the lower screen went with the compose layer. Result: the audit's "3414858021
          result". Smoke: `--pointer X0,Y0:X1,Y1`.
          - [ ] `auto_sway` (3235948233, 3414858021's hair/cloth sway): `M_PI` from `common.h` used above where LWE
                pastes includes; hoisting the include's `#define`s builds it but the left cloth then vanishes — read
                the effect before enabling it.
          - [x] 3414858021's "WEDNESDAY" reaches the right edge (group x = user `x8` 0.967 × canvas) — WE's does too
                (the Wednesday capture, 2026-11-11).
          - [ ] Flag 4's reader (2026-11-05, audit "Attachment result"): not in the exe nor found in scenescript64.dll;
                flag 4 also marks shader constants annotated `"conversion":"rad2deg"` (GH 0x140192430), which a script
                would see in degrees in WE and radians in LWE — 0 library scenes script or bind one.
    - [ ] **Scene health report — pick fixes from it** (2026-11-04, fork patches 0061–0062 `WPENGINE_HEALTH`, runner
          `src/player/tests/onmachine/scene_health.sh`): [`docs/player/reports/scene-health.md`](player/reports/scene-health.md)
          — every library scene's silent losses (layers/effects left out, shader/script/asset errors, unsupported
          features, off-canvas layers). First run: 75 clean, 21 degraded, 0 failed of 96; after the shader rules (0064):
          79 clean, 17 degraded; after the coverage batch (0065–0070, pin `cbe4445`): 86 clean, 10 degraded, 0 failed —
          script errors 38 → 11, layers dropped 3 → 0, none worse. Batched by cause:
    - [ ] **Scene preview compare — every scene against its author's preview** (2026-11-05, runner
          `src/player/tests/onmachine/scene_preview_compare.sh`, notes `scene_preview_notes.json`):
          [`docs/player/reports/scene-preview.md`](player/reports/scene-preview.md) — a ranked "look here first" list
          (SSIM + colour histogram + edges + the worst local cells, the crop found by correlation; 3414858021 scores
          0.665 before its head fix, 0.32 after). Result: the audit's "Preview compare result".
          - [ ] camera zoom direction contested: 3516174947 letterboxed at its default "Lens size" 0.75, 3042492564's
                preview = our zoom 1; the decode (B5) and 3490034653's "Panorama" say zoom < 1 shows more — needs an
                owner's WE capture of 3516174947.
    - [ ] **WE coverage — the master gap list** (2026-11-04, fork patches 0065–0070):
          [`docs/player/spikes/we-coverage.md`](player/spikes/we-coverage.md) — everything WE supports vs our fork,
          item by item (SceneScript d.ts 2.8: 421 / 453 implemented, was 329; keys, blend modes, formats, object
          types, pass options) with library / stock usage and sizes. Pick work from its "Future batches":
          - [x] **F1 shadows + light cookies — done 2026-11-04** (fork patch 0071): the shadow pass and atlas (spot and
                point lights, the stock casters), spot cookies, tube and directional lights; result in the audit's "F1
                result". No library scene uses them (synthetic check). host_api_test +4 (RED on `cbe4445`).
                - [ ] Left: directional cascades (`g_LFeature_Shadow*`), WE's light clusters, 2.8.485's PCSS (quality
                      4), the `shadows` quality as a setting (medium now), `lightconfig`. (Skinned/morphed casters: done in F4, 0078/0080.)
          - [x] **F3 blend shapes + bone alpha, F4 skinned / morphed models + createModelData — done 2026-11-04**
                (fork patches 0078–0081, pin `00d7760`): the casters' SKINNING / MORPHING combos compile (sweep: the
                10 caster checks pass), MDMP blend shapes with their MDLA weight tracks and bone alpha on puppets
                (+ get/setBlendShapeWeight), skinned and morphed 3D models posed by their animation layers,
                createModelData / IModelData / createLayer ({ model }). Result in the audit's "F3/F4 result".
                host_api_test +4 (RED on bdafdde).
                - [ ] Left: bone physics (+ applyBonePhysicsImpulse, gravity/wind; IK done in F2), root motion /
                      `rootmotion`, MORPHING_MODIFIERS, IModelLayer's animation-layer API on models, `perspective`
                      model layers, MDLA v6's per-bone float track.
          - [x] **F5 perspective layers + F6 the stock-only particle operators — done 2026-11-04** (fork patches
                0082–0085): an orthographic scene's perspective camera (`perspectiveoverridefov`, GH 0x1401b4fd0) for
                `perspective` layers and perspective particles (35 scenes' systems now WE's size and depth), camera
                paths + camerafade, `sortorder` in WE's transparent sort; 20 stock-only operators/initializers (WE's
                form where decoded, else inferred and marked). Result in the audit's "F5/F6 result". host_api_test +6
                (RED on `bdafdde`).
                - [ ] Left: the `layerimage` emitter (CPU pixels of the layer), collisionmodel, the inferred F6 parts
                      (boids' forces, remap's function shapes, the initializers' runtime: an asm read of case 0x11 /
                      0x13 and the spawn interpreter GH 0x140260d80), vortex_v2, a camera object's own `path`/`queuemode`
                      (all empty in the library), text `depthtest`, customsortorder, the 3D zoom/parallax, WE captures
                      of the element previews (`assets/scenes/particleelementpreviews`).
          - [x] **F2 shape objects + volumetric lights, F3's puppet IK — done 2026-11-05** (fork patches 0086–0090,
                pin `127d63b`): the "VolumeLight" is WE's shape class (3319542538's light shafts now draw), point and
                spot `castvolumetrics` with WE's volumetrics pass and shaders (synthetic check; 0 library users), puppet
                IK chains (3042492564's arm follows its hand target; solver inferred). Result in the audit's "F2
                result". host_api_test +3 (RED on `5e65da4`).
                - [ ] Left: volumetrics with SHADOW / COOKIE / fog, directional volumetrics, the `volumetrics` quality
                      setting (medium); bone physics + applyBonePhysicsImpulse + gravity/wind (0 users); IK limits
                      (`ikce`, `ikrmin/max`); root motion; MORPHING_MODIFIERS.
          - [ ] F7 puppet hit boxes (S–M).
          - [ ] F7 CursorEvent.hitBox: decode where WE keeps a puppet's hit boxes (not MDLE/MDMP; likely the rest
                of MDLS, which LWE skips) — 0 library readers.
          - [ ] ITextLayer writes (font, padding, anchor, limitrows, limitwidth, backgroundcolor) re-laying the text
                (0 library writers); IEffectLayer.transformAttachmentToTexture; .tex flag 64 (a slice count, 0 users).
                .tex flags 2²⁰–2²³ done 2026-11-05 (0099): channel-built-from-a-component bits that define a
                sampler's `components` combos (PBRMASKS: 3477054430, 3509243656).
- [ ] Optionally offer our LWE patches upstream as PRs, with AI assistance disclosed. Upstream merged nothing since
      2026-06-20.
- [ ] Player: with loop off, an item resumed while on its last frame comes back at position 0.0 and stays there (loop on
      restores correctly). Found by Phase 3 Task 8's restore probes.
- [ ] Legacy: a forwarded `play` spawns `monitor-daemon` next to the backend's own monitor (fixed for liascape-player
      only, Phase 3 Task 8).
- [ ] Phase 3 battery findings (`docs/player/reports/phase3.md`):
  - F1: `frozen`: B's ramp-in starts 2–5 ms late in about 1 of 15 onsets (recorded on the sink; mostly S→V). At most a
    faint tick. Probably the same graph change as "F7 residual".
    **Closed 2026-11-04 with the F7 residual:** it is that lost cycle landing on B's first ramp samples — in frozen
    S→V, A's worker quits at the handoff and its stream's deactivation (1.5–6 ms later) raced the graph exactly as B
    (mpv, already flowing) ramped in; one quantum of zeros at the ramp's start reads as a 2–5 ms late onset. Async
    producers lose no cycle (0 of 60, two profiler runs); the owner's battery re-run (`programs.sh dropout` with
    `P3_RECORD`, real session) is the remaining confirmation on the real outputs.
  - F2: pause when covered takes 374–401 ms against the plan's 350 ms (300 ms debounce + 30 ms batch + the rest).
    Closed 2026-11-02: the bound is now 450 ms; the debounce stays.
  - F3: the plan's "handoff vs A's end ≤ 1 frame": measured 33 ms against the nominal end, 19.7 ms against
    `source.ended`. Passes as one 30 fps clip frame, fails as one output frame. **Owner:** which was meant?
    **Fixed 2026-11-04 ("Hand Off When A's Last Frame Has Had Its Time") as "one output frame":** `source.ended`
    fires as A's *last frame is presented*, so a handoff 7–20 ms after it (the battery) cut that 33 ms frame short
    by 13–26 ms — B drawn over a frame the clip still owned. Cause: the full-live `align: end` aim subtracted half a
    clip frame from its end estimate "to centre the error", but `time_pos` is mirrored every tick, so the minimum
    already sits within a tick of the true end. Now aimed at the raw minimum. `tests/api.rs::
    align_end_hands_off_as_a_last_frame_ends` (144 Hz headless, real libmpv, 6 switches, handoff vs `Ended` + one
    clip frame): before −9.8…−13.7 ms (cut), after **+0.7…+7.3 ms** (held ≤ one output frame; bound −3…+2 output
    frames). The report's "nominal end" column (`start_ms` + remaining from a rate-limited `position`) over-estimates
    by up to 100 ms — not a reference.
  - F4: `--debug` only: the dropout probe costs 161 whole graph cycles of full-level silence in 460 s, right after each
    analysis; 0 without it. Find the cause before trusting a recording taken under `--debug`.
    **Fixed 2026-11-02 ("Spawn Dropout Decodes Without Forking The Player").** Cause: each analysis's ffmpeg
    decode had a `pre_exec` hook (for `PR_SET_PDEATHSIG`), which makes std `fork()` the whole compositor instead
    of `posix_spawn`ing (vfork). bpftrace on a private PipeWire: 48 forks for 12 analyses, 1.9–10.5 ms each
    (median ~2.4); while the address space is copied (and its pages turn copy-on-write) the in-process bus
    loopback and mpv's AO miss their graph cycles → 28 and 44 runs of exact silence (64–576 frames) per 12
    analyses on the recorded sink. Fix: no `pre_exec`; the death signal comes from `setpriv --pdeathsig KILL`
    in front of ffmpeg (util-linux; without it ffmpeg runs bare — SIGPIPE on its closed stdout + the 20 s
    timeout bound an orphan). After: 0 forks, 0 runs in 5 of 5 runs. Guard
    `tests/api.rs::dropout_analysis_never_skips_bus_cycles` (RED before: 28 / 44 runs). The probe no longer
    touches the audio it measures, so `--debug` recordings are trustworthy again. Only the battery's own
    re-run (`programs_steps.sh` with `P3_RECORD`, on the owner's machine) is left to confirm the 161 → 0.
    **Battery re-run 2026-11-02 23:00 (owner's machine, `programs.sh dropout`, `P3_RECORD`, release player,
    another agent's test suites loading the machine):** 47/50 — the same 3 `frozen` micro-gap FAILs as the first
    battery (1 + 1 + 4, the handoff work), 0 drops. The sink recording (2874 s): 23 exact-zero runs of 64–1023
    frames inside sound, every one exactly 64 frames; ~15 at the tone's full level (before: 161 whole cycles in
    460 s, 64–576 frames, right after each analysis — ~67× rarer per second now). The player's meter counted none
    of them as a micro-gap and they are one fixed 64-frame size, so most likely the recorder/sink side (under
    load), not the player's output — unproven. More likely still: the same single-cycle loss as "F7 residual" below (a
    stream's deactivation through the bus loopback, 64 frames each, invisible to the meter) — for the handoff work. Recording kept out of the repo (1.1 GB).
    **Settled 2026-11-04:** they were the F7 residual at mpv's streams (its AO deactivates on every pause and is
    destroyed at each teardown — the same race, Phase 2 § F7 residual), fixed by the async streams; the meter can't
    see them because its own capture sat in the same stalled cycle.
  - F5: `tests/api.rs` is flaky under the full suite. `scene_create_and_destroy_never_stall_the_loop` (destroy max busy
    3.25–3.56 ms against its 3 ms bound) failed 3 of 9 runs on `58eb5ec` and 4 of 10 on Task 14's branch; alone it passes.
    `scene_fps_change_is_live_same_pid` also failed once on `58eb5ec`. Not caused by Task 14.
    **Settled 2026-11-02 ("Measure Loop Stalls Without Waiting For A Core", then "Free Imported Frames Off The Loop");
    one driver limit remains, excluded by name.** (1) The 3.25–3.56 ms readings were the loop thread waiting for a core, not loop work: the `loop`
    probe now has opt-in scheduler accounting (`{"account": true}`: per stretch the thread's CPU clock,
    schedstat run delay and voluntary/involuntary switches → `max_busy_own_ms` = wall − run delay,
    `max_busy_at` / `max_busy_own_at` name the stretch). With the test pinned to two CPUs and four busy
    loops it reproduces: wall 3.4 ms = 0.75 ms own + 2.7 ms runnable, the stretch the test's own `probe`
    (the scene's `destroy` handler is 0.03 ms); idle, 0.5–1.4 ms. The test now bounds `max_busy_own_ms`
    ≤ 3 ms; RED with 5 ms of CPU or a 5 ms sleep injected into a scene's `begin_teardown`, idle (5.76 /
    5.52 ms) and under the hog (5.53–5.57 own at 5.6–16.8 wall). (2) **Caught 2026-11-02 ("Free Imported Frames Off The Loop"): NVIDIA's global driver lock.**
    Off-CPU stacks of the loop thread (`perf record -e sched:sched_switch` filtered to the player,
    DWARF call graphs, + `sched_wakeup`; ~100 recorded runs of the test, under the scene
    harness's `gpu_work` 4000 loop and under a pinned CPU hog): every sleep ≥ 0.2 ms the loop took
    in a measured window was in the NVIDIA kernel driver's resource manager, state D, in
    `nvidia_unlocked_ioctl` → `RmIoctl` → `rmapi{Alloc,Free,Control,Map,DupObject}WithSecInfo` →
    `serverTopLock_Prologue` → `rmapiLockAcquire` → `rwsem_down_{read,write}_slowpath` — one
    rwsem for every process on the GPU, held by another process's allocation/free (the harness
    loop starts and ends GL contexts every ~1.5 s; the owner's player and other tests too).
    Our call sites: **(a) destroy** — the dying `SceneSource` dropped in `SourceHost::sync` →
    `ImportedTex::drop` → `eglDestroyImage` (`rmapiFree`/`rmapiUnmap`, 0.2–1.4 ms per image,
    3–6 images); **(b) create/resize** — `ImportedRing::import` → `import_dmabuf` →
    `eglCreateImage` (`rmapiControl`) and `glEGLImageTargetTexture2DOES` (`rmapiFree`), 0.2–4 ms
    per slot (one create: 3.99 + 2.43 + 2.09 + 0.77 ms → 11 ms own); (c) the first composite of a
    fresh texture in a process (`BlitProgram::draw` → `rmapiMap`/`rmapiDupObject`, up to 26 ms)
    and `clear_transparent` (`rmapiAlloc`) — seen only in the warm-up scene, outside the
    windows. "Between the meter and the latch" was never seen; the earlier per-segment
    attribution most likely caught an import's sleep. **Fixes:** (a) moved off the loop — the
    image goes to one `lia-egl-free` thread (`dmabuf::free_image_off_thread`; the texture is
    still deleted on its context first; under the display lifecycle lock, skipped after a
    terminate via `DISPLAY_EPOCH`); 15 recorded runs after: no free on the loop, destroy
    windows 0.2–1.6 ms. (b) stays on the loop — a **driver limit** at this design: the import
    runs in `runtime::driver_call`, the `loop` probe reports its sleeps (`driver_blocked_ms`)
    and `max_busy_self_ms` = own minus them; the test bounds that. **Follow-up:** an async
    import (`eglCreateImage` on a helper thread, the ring's frames deferred until it lands;
    `glEGLImageTargetTexture2DOES` still on the loop) would take most of it off. Also found:
    the destroy window held the test's own `probe workers` (1.5–2.1 ms of CPU, 2.8–3.4 ms
    with its stretch under the GPU loop — 18 of 20 unrecorded runs near the bound, several
    over): now read before a second reset. Spawn (`posix_spawn` vfork) on the loop: 0.2–0.7 ms
    per spawn (bpftrace on `clone`), kept — a spawner thread delays the pid every
    kill/waitpid/reap path needs; not done. RED still: a 5 ms sleep (5.96 ms self) or a 5 ms
    spin (5.82) in a scene's `begin_teardown`, a 5 ms sleep next to (not inside) each import
    (15.5 ms self on create). One open trace: a single 1.8 ms voluntary sleep in a create
    dispatch stretch (fix-12, perf recording, not driver-attributed, not caught as a stack —
    most likely the spawn's vfork while the child waited for a core).
    `scene_fps_change_is_live_same_pid` (+ `per_output_scene_fps_gates_presents`): the failure was
    `VIRTUAL-2 at its refresh` (60/0 step); not reproduced (CPU hogs, 7 runs: 59.4–60.5). Both now judge
    presents against `min(gate, frames the scene latched in the same window)` (latched ≥ ½ the scene's
    rate) — cause unproven, the new check prints the baseline; RED with the gate bypassed (59.95 vs 15
    and vs 30).
  - F6: once under load (UI matrix `paused × playlistBarPlay`), a program loaded with "play resume → k1.mp4 (resumed)"
    and its timer switched to k2 357 ms later with a 600 s interval; rerun alone it passed 3 of 3. **Closed
    2026-11-02 ("Retime A Resumed Countdown To The Current Interval"):** a resume point (`resume.json`, key `bar`
    for the playlist bar) kept the timer's raw `remaining_ms` but not the interval it counted down from, and the
    resume committed it as is. An earlier matrix cell had played the bar playlist under "switch when video ends"
    with minimum 0 (remaining 0 — no countdown runs under `on_end`) or a short timer (`plInterval` 8 s); this
    cell loaded it with 600 s and resumed with that stale 0 / few seconds → the timer fired on the first tick
    after the commit (357 ms = the tick + B's load). Alone, no such point existed. Now the point saves
    `countdown_ms` (the timer interval; none under `on_end`) and the resume re-times it like a live interval
    edit (`resume::resumed_remaining` → `retime_remaining`; no countdown ran → a full interval). Guards
    `tests/program.rs::resume_retimes_a_countdown_saved_under_other_settings` (RED: on_end → switched one tick
    after the resume; 8 s timer → remaining 0 and a timer switch pending), unit
    `resumed_remaining_retimes_to_the_current_interval`.
  - F7: "Start over" + shuffle restarts every boot on the same item (138 on two boots, 2026-11-02). The program's
    `seed` is saved (`program/store.rs`) but its RNG state isn't, and `Prog::new` makes `Rng::new(seed)` each process,
    so a session start's "fresh shuffle" (`session_start` → `plan_start`) and every later random / effect pick replay
    the same sequence after each restart. Fix: reseed from the seed and something per process (or save the state).
    Closed 2026-11-02: the snapshot keeps each program's RNG state (`ProgramSnap.rng`), restored before
    `restore` / `session_start` (`Programs::restore_rng`), so the sequence goes on across processes; a
    snapshot from before it repeats once. `tests/program.rs::session_start_start_over_shuffles_anew_each_boot`
    (RED: three boots, one order).
