# livepaper — TODO

Running list of things found while working that aren't done yet. Newest context first within each section.
Tick items off in the commit that does them. Design for the new player: `docs/superpowers/specs/2026-10-20-utopia-player-design.md`.

## Waiting on owner
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
- [ ] **Phase 1 on-machine battery + report** (Task 20): ≥ 50 switches × {method} × {mode} on the owner's
      machine, a 1 h soak, the per-monitor isolation check. `docs/player/reports/phase1.md` (not written yet).
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
