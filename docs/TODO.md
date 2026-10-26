# livepaper — TODO

Running list of things found while working that aren't done yet. Newest context first within each section.
Tick items off in the commit that does them. Design for the new player: `docs/superpowers/specs/2026-10-20-utopia-player-design.md`.

## Waiting on owner
- [x] **Pause × a user switch** — owner (2026-10-25): an Advanced toggle, resume by default →
      `KeepPauseOnSwitch` (Settings → Playback "Stay paused when switching"). Was: (UI × player-state matrix,
      `KNOWN` cells). Paused, then next/previous/random:
      a single wallpaper **unpauses** and switches (`TryStepLibrary` → `Apply` = a new session, I1); a playlist
      **keeps** the pause but its tick holds the action until the resume and switches then (the player clock is
      frozen, so a transition couldn't run anyway). The documented contract (I1) says next/prev keep the pause.
      Options: (a) every user switch resumes playback (the legacy single-item feel; the playlist consumes the
      action at once and unpauses); (b) every user switch keeps the pause and shows B paused (a cut while
      paused, or the effect on the unpaused clock with both sides frozen); (c) leave it.
- [x] **Approve the lp-player design** (`docs/superpowers/specs/2026-10-20-utopia-player-design.md`). Check the
      "Calls made by the designer" list at the end. Next step after approval: write the implementation plan.
      — approved 2026-10-20 (`TransitionMethod` kept, per the spec's own status line); implementation plan:
      `docs/superpowers/plans/2026-10-20-lp-player-phase0-1.md`.
- [x] **Auto-mute, legacy quick win**: add `--latency-msec=10` to the `parec` spawn in `AudioMonitor.MonitorStreamAsync`.
      Measured: first data 2020 ms → ~780 ms. The rest is the per-stream process spawn, fully fixed in lp-player.
      — done 2026-10-25: re-measured on a synthetic silent stream in a private null sink
      (`scripts/measure-automute-latency.py`, 6 trials each): first byte 2023 ms → 65 ms, first 20 ms chunk → 76 ms.
- [ ] **LICENSE** for the repo. There is none today. lp-player will be GPL-3.0 (mpvpaper + LWE are GPL-3.0).

## Legacy player (current app) — small fixes
- [ ] **Reveal/frozen don't match the intended semantics** (owner, 2026-10-20: "audio follows the picture"):
      - **Video-end advances** with reveal/frozen fire ~effect + warmup *before* A's end (`DoVideoEndWait` leads by
        `duration + coverMs` for every method; `--align-a-end` only exists for full-live). So A freezes several
        seconds early instead of on its **last** frame. They should fire at A's end.
      - **Reveal** hard-cuts A's audio at the freeze (possible click) and starts B's audio at full. It should get a
        ≤ 30 ms anti-click fade on A, and B rising with the reveal (or full from the start, if the owner prefers).
      - **Frozen** is already silent through the effect, which is correct; it needs only the ≤ 30 ms anti-click ramps.
- [ ] `nix flake update` → mpvpaper **1.9** (PR #132 `glFenceSync` leak fix; flake.lock still pins 1.8). Owner's
      `RestartIntervalSeconds` is **0**, so it's leaking now (1.66 GB RSS after 42 min on 1.8). After the bump, soak and
      check RSS; if flat, the restart daemon's default can go to 0.
- [ ] Push `transitions-reveal`: `6f0433a` (cubic volume), `04533a8` (silence flicker) and the design + this TODO are
      not pushed. The `fork` remote is SSH and there's no key on this box; push via `gh auth git-credential` over HTTPS,
      or run `gh auth setup-git`.
- [ ] Measure the scene legs (V→S, S→V, S→S) of the cubic-volume crossfade fix (`6f0433a`). Only V→V is measured.
- [x] Commit the reference-based audio monitor (`lp_audiowatch.py`, currently in a session scratchpad) into `scripts/`.
      It captures the sink, rebuilds the expected mix from the source files at the logged positions, aligns latency,
      and flags dropouts and 1 ms micro-gaps. Make the ffmpeg path come from PATH.
      — done in Task 15 (`scripts/lp_audiowatch.py`, lane B); not yet merged into this branch's history.
- [ ] Dev unit `~/.config/systemd/user/livepaper-watch.service`: drop `Environment=DISPLAY=:0` (wrong: the session is
      `:1`) and add `HYPRLAND_INSTANCE_SIGNATURE` to `PassEnvironment`. Also (2026-10-26):
      - **`dotnet watch --no-hot-reload`** — a hot-reload delta never runs a NEW static field's initializer: the
        merge that added `SettingsService`'s static `Fields`/`WebJson` maps was "applied" in place, leaving
        `POST /settings` on a null map until a full restart (and a 2026-09 delta with a new static crashed the
        process). Every .cs change becoming a restart is the owner's stated preference anyway.
      - **The player must not die with the unit**: `systemctl --user restart livepaper-watch` kills the whole
        cgroup — the backend-spawned lp-player with it (`setsid` doesn't leave the cgroup) → no wallpaper for
        ~17 s until the new backend built and replayed. `dotnet watch`'s own restarts don't (same cgroup lives
        on). Either spawn the player out of the unit's cgroup when `INVOCATION_ID` is set
        (`systemd-run --user --scope`), or don't restart the unit by hand.
- [x] `POST /settings` replaces the whole `AppSettings` — a partial body resets every other field to its C# default
      (bit an agent on 2026-10-22: ~15 fields incl. LweMonitors). Make it merge (PATCH semantics) or reject partial bodies.
      — done 2026-10-26: it merges (`SettingsService.Patch` → `Merge`, `web-backend.md`): keys in the body overwrite
      the saved values, the rest are kept; an array or object replaces its field whole, an explicit null sets null,
      unknown keys are ignored, a bad value is a 400 that saves nothing; one poster at a time. RED before: a partial
      `{"Theme":"Nord"}` reset 26 other fields incl. `PlayerEngine` (→ the engine switched to legacy).
      `scripts/test-settings-merge.sh` (hermetic): partial / full / null / unknown key / 400 / parallel bodies, and a
      partial body applying live (Volume, Speed, NoAudio, VideoScale, override ?? global, rotation interval, engine).
- [ ] `POST /playlist/state` binds its whole `CustomPlaylist` (`videoPaths` + `settings` + `name`), same hazard as
      `/settings` had: a body without `videoPaths` saves an empty strip (a running rotation keeps its own list — the
      live reorder skips an empty one), a partial `settings` resets the rest to their defaults (override off →
      the rotation follows the globals live, transitions off). The UI always posts the whole strip; decide merge vs
      reject (`/playlist/play`'s `settings` is per-play by design — defaults intended there).
- [x] Remove the dead `LweSilent` setting (no consumers).
      — done 2026-10-26: gone from `AppSettings` and `session.md` (nothing in src/, app/, scripts/ read it). A
      settings.json that still has it loads (unknown keys are ignored) and the next save drops it.
- [ ] Harden `AUDIO_SETTLE` in `lp-transition`: pin `audio-buffer=0.2` on the overlay decoders, and derive the settle
      from audio-buffer + 2× PipeWire quantum. Only worth it if legacy stays the default for long.
- [ ] First transition after backend start can fire late (lead estimate unmeasured). Gone in lp-player.
- [ ] Delete stale branches: `transitions-full-live` (ancestor of current), `merge-fix/*`, `pr/*-temp`, `ui/compact-cards`.
- [ ] Optional: reword the stale "WIP" commit titles `161bf0f` / `8c5c0e6`. They're pushed, so this needs a force-push;
      owner's call.

## lp-player (after design approval)
- [x] Write the implementation plan (Phase 0 spikes first: LWE `next-v2` core renders offscreen; worker → compositor
      dmabuf sharing on NVIDIA proprietary; libmpv core-profile GL + `volume-gain` crossfade).
      `docs/superpowers/plans/2026-10-20-lp-player-phase0-1.md`.
- [x] **Phase 0 spikes** (Tasks 1–2): LWE `next-v2` core renders offscreen; dmabuf worker→compositor sharing on
      NVIDIA proprietary with correct sync. `docs/player/spikes/{lwe-core,dmabuf}.md`.
- [x] **Phase 1 core** (Tasks 3–18, plus mini-tasks 16b "player-level pause" and 16c "onset-gated anticlick
      ramps"): the compositor (graph, animator, clocks, EGL/GL, the gl-transitions catalogue, composition),
      video/image/colour sources, all three transition methods (full-live/reveal/frozen) with align/interrupt,
      the runtime + headless mode, the Command API + `ctl`, Wayland outputs, the player audio bus, the
      supervisor + state snapshot/restore, the C# backend adapter behind `PlayerEngine`, and packaging
      (flake + `install.sh`). Default engine stays `legacy`; `lp-player` is opt-in/experimental.
      `docs/player/architecture.md`, `.claude/rules/player-core.md` / `player-adapter.md`.
- [x] **Phase 1 on-machine battery + report** (Task 20): ≥ 50 switches × {method} × {mode} on the owner's
      machine, a 1 h soak, the per-monitor isolation check. `docs/player/reports/phase1.md` — done: dropout
      0/0 everywhere, frame pacing/outputs/permonitor PASS, 4 product findings fixed (Tasks 20b–20e), final
      soak PASS (0.31 MiB/min).
- [ ] Phases 2–6 per design §12 (scene worker; Programs/Signals in-process incl. auto-mute ≤ 100 ms; the web
      worker; the switch-over bar per §11; the ongoing scene-compatibility programme). Roadmap summary:
      `docs/player/architecture.md` § 6.
- [x] AI docs + debug mode per §8/§9; `UPSTREAM.md`; per-component Claude rules — `docs/player/architecture.md`,
      `docs/player/invariants.md`, `UPSTREAM.md`, `CREDITS.md` (generated, `scripts/gen-credits.py`),
      `.claude/rules/player-core.md` / `player-adapter.md` (Task 19), `docs/player/debugging.md` (Tasks 15/16c/d).
- [x] **Final-review fixes**: GainHistory bounded (C1), pause lifetime (I1/I3), the pause gate on its own slot
      (I2), switches with no output (I4), async mpv core open (I5), one onset helper (I6), bus reconnect (I7).
- [ ] **Phase 2: render worker** — move every `MpvSource` render context (creation + first render, the
      residual ~6–25 ms per switch on the loop after I5) to a worker thread with a shared EGL context;
      `.claude/rules/player-core.md` § Runtime "Switch cost and the Phase 2 render worker".
- [x] **`/next`/`/prev`/`/random` crash on a scene under `PlayerEngine=lp-player`** (Task 20 battery,
      `docs/player/reports/phase1.md` §1.3) — fixed in Task 20c: `TryStepLibrary` steps past unplayable scenes,
      `ApplyRandom`/timed random drop them from the pool; an all-scene library → 409 (CLI: stderr + exit 1).
- [x] **The owner's installed `livepaper` (NixOS package) predates lp-player entirely** — done 2026-10-25: `/etc/nixos/livepaper.nix` re-pinned to the local `lp-player` commit for testing (re-pin to the GitHub commit after the merge/push) (Task 20 battery,
      `docs/player/reports/phase1.md` §1.4): confirmed via `strings -el` on the installed `livepaper.dll` —
      zero occurrences of `PlayerEngine`/`LP_PLAYER_BIN` anywhere, while the current dev build has both. So
      every one-shot CLI flag (`--restore`, `--random`, `--kill`, `--action=*`) silently runs legacy whenever
      `lp-player` is selected, even though the long-running `--serve` backend (what the UI talks to) is fine.
      Needs an actual rebuild from this branch, not a code change — **owner action:**
      `sudo nixos-rebuild switch --impure` (the module builds from the local flake, `git+file`).
- [x] **No explicit cap on concurrent `lp-open` worker threads** (final review I5's async mpv-core-open
      mechanism, `.claude/rules/player-core.md` § Sources "Async opens") — a burst of near-simultaneous
      switches/creates has no ceiling on how many `lp-open` threads it can spin up at once. Not exercised by
      anything in Task 20's battery (every cell opens sources well below any plausible concurrency ceiling);
      worth a bound + a test before Phase 2 leans on this path harder.
      — done: `host::OpenPool`, a FIFO queue on ≤ `MAX_OPEN_WORKERS` (2) on-demand `lp-open` threads; a job
      queued for a node destroyed meanwhile is skipped (no core made). Burst of 16 paused 1080p creates: all
      made + opened 61–80 ms (uncapped 23–70, cap 4 58–71), all ready ~0.5 s either way, the loop's longest
      open share 2–8 ms (uncapped 13–29). `tests/api.rs::i5_open_burst_is_capped_and_none_lost` (RED: 16 at
      once; GREEN: peak 2, the 3 destroyed while queued skipped, quit with a queued burst 40 ms, no straggler).
- [x] **`LP_REQUIRE_GPU` test mode** — every GPU-dependent test (`tests/common::headless_gl` et al.)
      currently just prints `"SKIP: no EGL device"` and returns on a GPU-less machine; there's no way to make
      a CI run that's *supposed* to have a GPU fail loudly instead of silently skipping everything. Not
      exercised in Task 20 (every run there had a real GPU) — worth adding before relying on CI coverage of
      this crate's GPU paths.
      — done: `LP_REQUIRE_GPU=1` (anything but empty/`0`) turns every GPU-test skip into a failure via one
      helper, `tests/common::skip_gpu` (`headless_gl`, `catalogue_dir` — the "no catalogue" skips too, since
      nearly every GPU test needs it — and the inline lib unit test); opt-in/non-GPU skips (Wayland, private
      PipeWire, credits) stay skips. GPU-less machine simulated (`__EGL_VENDOR_LIBRARY_FILENAMES` naming no
      file): the suite passed in ~3 s with 133 SKIPs; with `LP_REQUIRE_GPU=1` those 133 fail.
      `tests/gfx_basic.rs::require_gpu_turns_a_missing_gpu_into_a_failure` (RED: the old binary passed).
      `player-core.md` § GFX / EGL.
- [ ] **Zero-copy hwdec back (Phase 2 render worker)** — Task 20d runs every mpv core with
      `gpu-hwdec-interop=no` and maps `hwdec` to copy modes (`auto` → `nvdec-copy,vaapi-copy,auto-copy`),
      because interop init (a CUDA context per render context, 65–90 ms) and `vulkan-copy`'s device creation
      (230–320 ms without an X server) ran on the loop at every switch. Cost: 4K60 nvdec interop ~11 % of a
      core → nvdec-copy ~56 % (flake build); the copy upload also runs on the loop (8–13 ms at 4K60). Once
      render contexts live on the render worker, re-enable interop there. `player-core.md` § Sources
      "Hardware decoding".
- [ ] **8 h soak: does glibc's free heap plateau?** The final 1 h live soak (Task 20, `phase1.md` § 4)
      passed on RSS (0.31 MiB/min) but malloc's free bytes — already trimmed, not resident — grew ~4.1 MiB/min
      (arena address space +4.6 MiB/min, ~5.7 MiB per switch). Costs no RAM; the reaper's `malloc_trim` walks it
      (1.7 ms max now). Run `battery.sh soak --minutes 480`; if it doesn't plateau, consider fewer per-core
      threads or reusing cores across switches (the Lua scripts are gone since — 6 fewer threads and their
      Lua VMs per core; re-measure the free-heap growth first).
- [ ] **Explicit sync back on NVIDIA once egl-wayland2 > 1.0.2 ships** — Task 20e: 1.0.2 leaks one queued
      `wl_buffer.release` (~224 B) per present with explicit sync (upstream fix 6235dd8, 2026-09-09, unreleased),
      so `serve` defaults `__NV_DISABLE_EXPLICIT_SYNC=1` (cost: 240 Hz interval p95 ~4.7 → ~5.2 ms, loop tick
      p99 ~0.3 → 1.6 ms, 0 missed) and drains libwayland's default queue every iteration. With a fixed driver
      the drain alone is leak-free: drop the env default (keep the drain). `player-core.md` § Wayland NVIDIA notes.
- [x] **mpv's built-in Lua scripts per core** (console, stats, auto_profiles, commands, select) start threads
      for every new source — `load-scripts`/`load-*=no`-style options would trim per-switch CPU (Task 20d note).
      — done: `sources::mpv::SCRIPT_TRIMS` (`load-scripts`/`osc`/`load-stats-overlay`/`load-console`/
      `load-auto-profiles`/`load-select`/`load-commands`/`load-positioning`/`load-context-menu`/
      `input-builtin-bindings` = `no`, best-effort — an unknown name is skipped and logged once). A playing
      1080p core 28 → 22 threads (6 Lua script threads gone); a core's create + initialize + destroy
      37–47 → 3.7–5.7 ms CPU; ~1.3 MiB less RSS per live core; the loop's open share 3.6–7.5 → 0.8–3.9 ms.
      `tests/sources.rs::builtin_scripts_are_not_loaded` (RED: `load-scripts` `yes`, 6 script threads).
- [x] **Reaper trim at shutdown** — the reaper's `PENDING` drops after the batch's `malloc_trim`, so a trim
      slower than `REAPER_WAIT` during `quit` is reported as `mpv.reaper_stragglers`; skip the trim once
      shutdown has started (Task 20b review, cosmetic).
      — done: no batch is trimmed once `reaper::shutdown` started, and `shutdown` reports cores not yet
      destroyed (`undestroyed`), never a trim in flight; `pending()` keeps its "destroyed and trimmed" meaning.
      Unit tests on the now generic `Reaper<T>` with slow fakes: a 400 ms trim in flight at a 50 ms wait →
      0 stragglers (RED: 1); a 200 ms destroy at shutdown → done after ~180 ms, no trim (RED: 580 ms, 1 trim).
- [x] **`transition.onset_timeout` on audio-less videos** — a B whose `aid` hasn't resolved yet (`has_audio`
      unknown → treated as audible) waits the full 150 ms `ONSET_TIMEOUT` before its (silent) ramp; 85 such
      timeouts in the Task 20 re-run. Harmless (nothing to hear) but noisy; resolve `has_audio` from the
      file's track list before scheduling the onset, or don't warn for a source that never reports audio.
      — done: a B with no audio stream at all didn't reproduce it (R92's `has_audio` resolves in time in
      every method × align, and a switch storm); a selected track that ENDS (30 ms of audio on a 4 s
      video) timed out in all 6 cells. The source now confirms `AudioFlowing` when `audio-pts` is
      unavailable while the picture plays on (no audio playing: track ended or `aid` unresolved), and its
      40 ms margin on real time, not on a later `audio-pts` change (`MpvSource::confirm_flowing_by_time`).
- [ ] **Load-sensitive test flakes** (seen once each under a busy desktop, never reproduced unloaded):
      `stepped_align_end_reveal`, `bus_down_falls_back_to_default_device`, `supervise::crash_restores` (clip
      wrap under load). Watch; harden their timing margins if they recur.
      Not a margin: `i2_switch_while_gated_never_leaves_a_playing_source_silent` (~1 in 8 under CPU load) was
      a real bug — a resuming pause gate was dropped on a second clock read after its last `ramp_db`, so
      `gain.pause` stayed a hair under 0 dB for good (−0.0003 measured; −0.04…−0.56 dB with a 2 ms stall
      injected, 4/4 RED). The drop now writes the exact 0 dB.
      Adapter IT (`scripts/test-lp-player-adapter.sh`), once at load avg ~10 (another lane's 4K decoder tests,
      2026-10-26 08:0x, merge 48959da): 111/5 — `after SIGCONT` (read a pending B's override), `speed drop: E1
      was cut early`, `after resume: handoff=1`, `volume-only (global) drag` (A already gone: `null dB`). The
      rerun minutes later at load ~7: 115/0. Its real-clock fades (300–600 ms) have no slack for a stalled
      backend; if these recur, stretch the fades the drag/pause sections act inside rather than retrying.
- [ ] **UI × player-state matrix** (`scripts/test-ui-matrix.sh`, driver `app/shell/probe-matrix.js`: every
      playback control of the real UI + every `--action` keybind × idle / single / playlist / effect running /
      align:end pending / paused / paused mid-effect / no output / muted, hermetic). Fixed from its first run:
      trash left items in the playlist (a rotation played the missing file; an armed switch still fired to
      it), trashing an item whose switch was requested but not yet running kept it playing, undo didn't put
      it back; keybind next/prev/random on a single wallpaper switched behind the UI (now forwarded to the
      running backend); keybind volume reverted by the next UI save; play-from saved the strip reordered; Play
      / play-from while paused stayed paused; `previous` at the first item with an armed advance relaunched
      the current one; mute while paused never reached a source (setting ramps on the frozen clock); the
      installed app got no WS events and lost its localStorage prefs every launch (random port = new origin).
      **Round 2** (2026-10-25 night): `--jobs N` runs N hermetic stacks in parallel (default 6; full run
      40 min serial → 14.5 min at 4 → 10 min at 6 → 8.3 min at 8 but 13 cells timed out entering their state
      (all passed alone); ~0.8 GB each, capped by MemAvailable, the run stops under a 3 GB floor;
      `LP_MATRIX_NICE=1` + `--jobs 2` next to someone working — 4 stacks lag the desktop); the window is
      SHOWN on the private Xvfb — hidden it rendered no frames (rAF never ran: framer-motion/WAAPI exits never finished, dnd-kit's rAF-aligned pointermoves coalesced so a drop
      saw a stale target, gifs/the live bg sat paused unfocused). ~90 new cells, each only in the states its
      halves share: strip drag-reorder through real input events (`sendInputEvent`), remove (X / context
      menu) of the shown / incoming / other item, Save / Load modals, the playlist-settings modal (interval,
      0 s on the way, wait-for-end, shuffle, transition off / duration / effect), the global Rotation section
      + transition method + global interval vs a playlist following the globals (opt-in states
      `pendingGlobal` / `playlistGlobal`) and one with its own override, multi-select (Ctrl+click: trash,
      trash + undo, toggle add / remove, the settings modal on both live sides; Shift+click range + the
      Delete key; Ctrl+A + Delete + Undo), the card's own toggle, a
      saved playlist overwritten, two controls in a row (slider drag → next, pause → play-from, mute →
      next, a global setting → next, next+next, next+prev, preview drag → close → reopen, remove / drag /
      load / transition change → next, two card applies / strip clicks in quick succession, two trashes + two
      undos, pause → interval change: the rotation holds until the resume, a slider drag closed with Escape
      at once), a settings save/load race. Fixed: settings.json was written in
      place — a read mid-write got the C# defaults, applied live and saved back over everything (/settings'
      own `prev` → an engine flip, the Steam tokens gone); an armed align:end switch kept the transition it
      was armed with (playlist + global transitions, method) — it fired the old effect at A's end; removing
      the playing item from the strip restarted the rotation from the top (now: from its place).
      `LP_MATRIX_DLL=<older build>` / `--ui-dir` show a fix RED.
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
      Sequential again = the strip's order). Seven chains of three or more controls. The volume keybinds with
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
      Then the LOST update (the likely cause of the merged run's `paused × itemVol|stripVol:other` — "k3
      volumeOverride null" under load, both passed alone 3/3; inferred, not reproduced in those cells): trash,
      undo, the WE sync and the direct-download reconcile loaded index.json, worked, and saved their copy back
      outside `LibraryStore`'s lock — over an override saved meanwhile. `race:indexLostUpdate` (40 k1 volume saves
      while k4 is trashed + undone ×15): RED 3/40 and 2/40 lost; every index write now goes through
      `SetMeta`/`Remove`/`UpdateIndex` under the one lock (`SaveIndex` private) — GREEN 3/3 runs.
      **Not covered yet:** the legacy engine (mpvpaper needs a real Wayland output), scenes (lp-player skips
      them), Browse/download/Steam (network + accounts), per-monitor content (no per-output wallpapers in the
      backend yet), auto-mute's "Only if MPRIS player active" (needs an MPRIS player on a session bus — a
      private dbus-daemon + a fake player would make it hermetic; not built), Settings → Player engine (to
      legacy) / Clear settings / Autostart / Resume from last / Debug mode, a shuffle with advance-on-end (the
      same `AdvanceToNext`; 12 plays of ≥ 10 s clips is too slow for a cell), deleting a saved playlist (no
      UI for it).
- [x] **Stale player after a rebuild/reinstall** — the player outlives the backend, so fixes "persisted" (a
      13:26 build ran at 19:00): the backend now restarts a stale player onto its binary with `--restore`
      (before a switch, or from a 10 s check while nothing is armed — player-adapter.md § Lifecycle).
- [x] **Two timer owners across a backend restart** (dotnet watch, app relaunch): switch storm every 1–16 s;
      the stopping backend now releases the timer first, a backend yields to a newer one, a superseded
      aligned switch re-arms instead of switching now (player.md § One timer owner).
- [x] **`bin/Debug/livepaper.runtimeconfig.json` vanished once** after the adapter IT's `dotnet build` ran
      next to the owner's `dotnet watch` (same `obj/`) — the next watch restart (`dotnet run --no-build`)
      can't start without it. A plain `dotnet build` brought it back; cause not pinned down.
      — root cause: `/home/kryxzort/Projects` is a symlink to `/mnt/CachyOS/@home/kryxzort/Projects`, and
      MSBuild's IncrementalClean compares `obj/…/FileListAbsolute.txt` by path STRING — a build through one
      spelling deletes the other spelling's entries, i.e. its own fresh outputs. Every script now roots at
      `pwd -P` and the test scripts run their backend from a verified snapshot of `bin/Debug` (d767c59).
- [ ] **Speed storm leftovers** (`src/player/tests/onmachine/speedstorm.py` — live, bus muted; fixed in the same
      round: the adapter's aligned-switch backstop, the 1× tempo-filter rebuild holes, the align:end estimate):
  - [ ] **Stall breaker trips without a slow player** — 6 trips in ~25 min of storm (the request after a trip
        and the R81 reapply then reset a drag), while every verb answered in < 3 ms and 6860 direct pings never
        took > 50 ms; one trip put the queue at its 256 cap (new sets dropped) and failed the storm's own
        restore sets. Not reproduced in a 4 min re-run once the trip got its own log line (`no reply to …
        (waited …; gen2 GCs …, thread-pool queue …)`) and the `loop` probe got `max_request_ms/cmd` (handler
        time used to be outside `max_busy_ms`). Next trip: read that line first.
  - [x] **Queue cap drops the NEWEST set** (`MaxQueueDepth`): for coalescible sets (`/preview`, a slider) the
        latest value is the one that matters — coalesce per target instead of refusing admission.
        — done: the queue is a pending list; a `QueueSet(key)` (target + property) replaces a still-pending one
        of its key since the last essential command (switch/stop/toggle = barriers, never dropped), so a burst
        holds one command per key and the newest always lands (self-test: 317 sets → depth 2, RED: 256 + the
        last ~60 dropped). Also fixed: `SwitchAndWait`'s own switch went through the droppable queue.
  - [x] **`/preview` costs three round trips** (`get cur:*.path`, a full `state` for `SourcesFor`, the `set`)
        — fine at the UI's ~11/s, saturates the one worker at ~50/s. Cache the path → source ids per switch.
        — done: `SourceMap`, invalidated by our switches/stops/cancels and by the subscribed `transition.`/
        `player.stopped`/`source.retire` events (a foreign switch too), trusted only while events flow;
        1.0 request per preview value (self-test over 20; RED: 2.0).
  - [x] **A speed-up inside the last D of an `align:end` wait** ends the effect after A (A holds its last
        frame, up to 0.5 s seen under random 0.25–4× drags): a fixed-length effect can't make up a start
        instant that moved into the past. Compress the effect's remaining progress to A's new end instead?
        Same for a global speed change mid-effect (it reaches A through `srcs:*`).
        — done: full-live `align:end` keeps ending with A (`Transitions::follow_a_end`): a speed-up before or
        during the effect compresses its remaining progress and both xfade ramps to A's new end
        (`Animator::compress_to`, continuous, same curves; ≥ 100 ms left; never stretched on a slow-down;
        an A already shorter than D keeps its designed hold). Drag storm −4.6…+10.8 ms vs A (RED ≤ +391);
        real libmpv `srcs:*.speed` 4× mid-effect: RED +892 ms → on A's end.
  - [ ] **Shared looping A on `align:end`** caches its boundary (`target_end`, from the drop + k·length at the
        old speed) — a speed change doesn't move it. Unused by the backend today (same wallpaper on every
        output = never shared); re-anchor at the next wrap when per-monitor wallpapers land.
  - [ ] **Missed frames scale with content fps**: steady 2× → 0.0/s, 2× ±0.05 every 90 ms → 0.65/s on the
        240 Hz output; random 0.25–4× (up to 240 fps content) 1–1.4/s vs 0.16/s at 1×. Phase 2 render worker.
  - [x] **Global speed slider has no live drag preview** (UI debounces `/settings` 250 ms; the per-item modal
        previews) and a no-op `POST /settings` costs ~150 ms in the backend — profile it.
        — done: the cost was the loudness backfill's library scan running synchronously on the request thread
        (and parsing index.json twice per item): 330–550 ms → median 8 ms with 300 items
        (`scripts/test-settings-latency.sh`); the global Volume/Speed sliders preview through a throttled
        `/preview {global:true}` (only wallpapers without their own override move; matrix `globalDrag*`).

## Follow-up projects (each gets its own brainstorm)
- [ ] **Per-monitor wallpapers, user-facing**: UI assignment, per-output rotation, which monitor actions target,
      `/current` + preview per output, `--restore`, hotplug defaults. The player supports it from Phase 1.
- [ ] **Per-monitor audio mixing policy**: with different wallpapers on two monitors, both are audible at once
      (audio follows the picture). Decide: primary output only / loudest / all / user choice. lp-player keeps a
      shared wallpaper playing and audible while it's still on another monitor; reveal/frozen hold a snapshot.
- [ ] Rebuild `scripts/PKGBUILD` + `scripts/build-appimage.sh` for the Electron + lp-player world (both still build the
      pre-rewrite Avalonia app).
- [ ] Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#692, #625, #677, #631,
      #694 …) as labelled patches; scene corpus runner over the `431960` workshop folder.
- [ ] Optionally offer our LWE patches upstream as PRs, with AI assistance disclosed. Upstream merged nothing since
      2026-06-20.
