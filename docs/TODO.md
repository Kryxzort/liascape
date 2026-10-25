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
- [ ] **Auto-mute, legacy quick win**: add `--latency-msec=10` to the `parec` spawn in `AudioMonitor.MonitorStreamAsync`.
      Measured: first data 2020 ms → ~780 ms. The rest is the per-stream process spawn, fully fixed in lp-player.
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
      `:1`) and add `HYPRLAND_INSTANCE_SIGNATURE` to `PassEnvironment`.
- [ ] `POST /settings` replaces the whole `AppSettings` — a partial body resets every other field to its C# default
      (bit an agent on 2026-10-22: ~15 fields incl. LweMonitors). Make it merge (PATCH semantics) or reject partial bodies.
- [ ] Remove the dead `LweSilent` setting (no consumers).
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
- [ ] **No explicit cap on concurrent `lp-open` worker threads** (final review I5's async mpv-core-open
      mechanism, `.claude/rules/player-core.md` § Sources "Async opens") — a burst of near-simultaneous
      switches/creates has no ceiling on how many `lp-open` threads it can spin up at once. Not exercised by
      anything in Task 20's battery (every cell opens sources well below any plausible concurrency ceiling);
      worth a bound + a test before Phase 2 leans on this path harder.
- [ ] **`LP_REQUIRE_GPU` test mode** — every GPU-dependent test (`tests/common::headless_gl` et al.)
      currently just prints `"SKIP: no EGL device"` and returns on a GPU-less machine; there's no way to make
      a CI run that's *supposed* to have a GPU fail loudly instead of silently skipping everything. Not
      exercised in Task 20 (every run there had a real GPU) — worth adding before relying on CI coverage of
      this crate's GPU paths.
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
      threads (mpv's Lua scripts) or reusing cores across switches.
- [ ] **Explicit sync back on NVIDIA once egl-wayland2 > 1.0.2 ships** — Task 20e: 1.0.2 leaks one queued
      `wl_buffer.release` (~224 B) per present with explicit sync (upstream fix 6235dd8, 2026-09-09, unreleased),
      so `serve` defaults `__NV_DISABLE_EXPLICIT_SYNC=1` (cost: 240 Hz interval p95 ~4.7 → ~5.2 ms, loop tick
      p99 ~0.3 → 1.6 ms, 0 missed) and drains libwayland's default queue every iteration. With a fixed driver
      the drain alone is leak-free: drop the env default (keep the drain). `player-core.md` § Wayland NVIDIA notes.
- [ ] **mpv's built-in Lua scripts per core** (console, stats, auto_profiles, commands, select) start threads
      for every new source — `load-scripts`/`load-*=no`-style options would trim per-switch CPU (Task 20d note).
- [ ] **Reaper trim at shutdown** — the reaper's `PENDING` drops after the batch's `malloc_trim`, so a trim
      slower than `REAPER_WAIT` during `quit` is reported as `mpv.reaper_stragglers`; skip the trim once
      shutdown has started (Task 20b review, cosmetic).
- [ ] **`transition.onset_timeout` on audio-less videos** — a B whose `aid` hasn't resolved yet (`has_audio`
      unknown → treated as audible) waits the full 150 ms `ONSET_TIMEOUT` before its (silent) ramp; 85 such
      timeouts in the Task 20 re-run. Harmless (nothing to hear) but noisy; resolve `has_audio` from the
      file's track list before scheduling the onset, or don't warn for a source that never reports audio.
- [ ] **Load-sensitive test flakes** (seen once each under a busy desktop, never reproduced unloaded):
      `stepped_align_end_reveal`, `bus_down_falls_back_to_default_device`, `supervise::crash_restores` (clip
      wrap under load). Watch; harden their timing margins if they recur.
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
      trash + undo, toggle add / remove, the settings modal on both live sides), the card's own toggle, a
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
      **Not covered yet:** the legacy engine, scenes, Browse/download/Steam, per-monitor content, the rest of
      the global Settings page (auto-mute, normalization, appearance, global wait-for-end), Shift+click range
      selection + Delete/Ctrl+A keys, which order a shuffle actually plays, deleting a saved playlist (no UI
      for it), three or more controls in a row.
- [x] **Stale player after a rebuild/reinstall** — the player outlives the backend, so fixes "persisted" (a
      13:26 build ran at 19:00): the backend now restarts a stale player onto its binary with `--restore`
      (before a switch, or from a 10 s check while nothing is armed — player-adapter.md § Lifecycle).
- [x] **Two timer owners across a backend restart** (dotnet watch, app relaunch): switch storm every 1–16 s;
      the stopping backend now releases the timer first, a backend yields to a newer one, a superseded
      aligned switch re-arms instead of switching now (player.md § One timer owner).
- [ ] **`bin/Debug/livepaper.runtimeconfig.json` vanished once** after the adapter IT's `dotnet build` ran
      next to the owner's `dotnet watch` (same `obj/`) — the next watch restart (`dotnet run --no-build`)
      can't start without it. A plain `dotnet build` brought it back; cause not pinned down.
- [ ] **Speed storm leftovers** (`src/player/tests/onmachine/speedstorm.py` — live, bus muted; fixed in the same
      round: the adapter's aligned-switch backstop, the 1× tempo-filter rebuild holes, the align:end estimate):
  - [ ] **Stall breaker trips without a slow player** — 6 trips in ~25 min of storm (the request after a trip
        and the R81 reapply then reset a drag), while every verb answered in < 3 ms and 6860 direct pings never
        took > 50 ms; one trip put the queue at its 256 cap (new sets dropped) and failed the storm's own
        restore sets. Not reproduced in a 4 min re-run once the trip got its own log line (`no reply to …
        (waited …; gen2 GCs …, thread-pool queue …)`) and the `loop` probe got `max_request_ms/cmd` (handler
        time used to be outside `max_busy_ms`). Next trip: read that line first.
  - [ ] **Queue cap drops the NEWEST set** (`MaxQueueDepth`): for coalescible sets (`/preview`, a slider) the
        latest value is the one that matters — coalesce per target instead of refusing admission.
  - [ ] **`/preview` costs three round trips** (`get cur:*.path`, a full `state` for `SourcesFor`, the `set`)
        — fine at the UI's ~11/s, saturates the one worker at ~50/s. Cache the path → source ids per switch.
  - [ ] **A speed-up inside the last D of an `align:end` wait** ends the effect after A (A holds its last
        frame, up to 0.5 s seen under random 0.25–4× drags): a fixed-length effect can't make up a start
        instant that moved into the past. Compress the effect's remaining progress to A's new end instead?
        Same for a global speed change mid-effect (it reaches A through `srcs:*`).
  - [ ] **Shared looping A on `align:end`** caches its boundary (`target_end`, from the drop + k·length at the
        old speed) — a speed change doesn't move it. Unused by the backend today (same wallpaper on every
        output = never shared); re-anchor at the next wrap when per-monitor wallpapers land.
  - [ ] **Missed frames scale with content fps**: steady 2× → 0.0/s, 2× ±0.05 every 90 ms → 0.65/s on the
        240 Hz output; random 0.25–4× (up to 240 fps content) 1–1.4/s vs 0.16/s at 1×. Phase 2 render worker.
  - [ ] **Global speed slider has no live drag preview** (UI debounces `/settings` 250 ms; the per-item modal
        previews) and a no-op `POST /settings` costs ~150 ms in the backend — profile it.

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
