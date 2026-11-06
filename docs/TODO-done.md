# liascape — TODO, finished items

Finished items moved out of `docs/TODO.md` (2026-11-06), under the same section headings. A finished sub-item of an
item that is still open names its open parent ("Under …"). Rules docs that cite `docs/TODO.md "<title>"` for a
finished item mean this file. When you finish an item in `docs/TODO.md`, tick it and move it here.

## Waiting on owner
- [x] **Pause × a user switch** — owner (2026-10-25): an Advanced toggle, resume by default →
      `StayPausedWhenSwitching` (Settings → Playback "Stay paused when switching"). Was: (UI × player-state matrix,
      `KNOWN` cells). Paused, then next/previous/random:
      a single wallpaper **unpauses** and switches (`TryStepLibrary` → `Apply` = a new session, I1); a playlist
      **keeps** the pause but its tick holds the action until the resume and switches then (the player clock is
      frozen, so a transition couldn't run anyway). The documented contract (I1) says next/prev keep the pause.
      Options: (a) every user switch resumes playback (the legacy single-item feel; the playlist consumes the
      action at once and unpauses); (b) every user switch keeps the pause and shows B paused (a cut while
      paused, or the effect on the unpaused clock with both sides frozen); (c) leave it.
- [x] **Approve the liascape-player design** (`docs/superpowers/specs/2026-10-20-utopia-player-design.md`). Check the
      "Calls made by the designer" list at the end. Next step after approval: write the implementation plan.
      — approved 2026-10-20 (`TransitionMethod` kept, per the spec's own status line); implementation plan:
      `docs/superpowers/plans/2026-10-20-liascape-player-phase0-1.md`.
- [x] **Auto-mute, legacy quick win**: add `--latency-msec=10` to the `parec` spawn in `AudioMonitor.MonitorStreamAsync`.
      Measured: first data 2020 ms → ~780 ms. The rest is the per-stream process spawn, fully fixed in liascape-player.
      — done 2026-10-25: re-measured on a synthetic silent stream in a private null sink
      (`scripts/measure-automute-latency.py`, 6 trials each): first byte 2023 ms → 65 ms, first 20 ms chunk → 76 ms.
- [x] **LICENSE** for the repo — done in `5a97418` (GPL-3.0, with `LICENSE.upstream-MIT` for the livepaper portions). Was: There is none today. liascape-player will be GPL-3.0 (mpvpaper + LWE are GPL-3.0).
- [x] **Phase 2 VT switch / suspend check** (needs you at the machine; the battery never suspends): the checklist in
      `docs/player/reports/phase2.md` § 8 — a scene on each output through a VT switch and a suspend/resume: it
      comes back within ~2 s (a GL context loss is one worker restart), never `source.broken`, sound fades back in.
      **Done 2026-11-02** (`programs.sh sceneaway`, `phase2.md` § 8): VT + suspend + two suspends — 0 restarts, PASS 12/12.

## Legacy player (current app) — small fixes
- [x] Commit the reference-based audio monitor (`liascape_audiowatch.py`, currently in a session scratchpad) into `scripts/`.
      It captures the sink, rebuilds the expected mix from the source files at the logged positions, aligns latency,
      and flags dropouts and 1 ms micro-gaps. Make the ffmpeg path come from PATH.
      — done in Task 15 (`scripts/liascape_audiowatch.py`, lane B); not yet merged into this branch's history.
- [x] Dev unit `~/.config/systemd/user/liascape-watch.service`: drop `Environment=DISPLAY=:0` (wrong: the session is
      `:1`) and add `HYPRLAND_INSTANCE_SIGNATURE` to `PassEnvironment`. Also (2026-10-26):
      - **`dotnet watch --no-hot-reload`** — a hot-reload delta never runs a NEW static field's initializer: the
        merge that added `SettingsService`'s static `Fields`/`WebJson` maps was "applied" in place, leaving
        `POST /settings` on a null map until a full restart (and a 2026-09 delta with a new static crashed the
        process). Every .cs change becoming a restart is the owner's stated preference anyway.
      - **The player must not die with the unit**: `systemctl --user restart liascape-watch` kills the whole
        cgroup — the backend-spawned liascape-player with it (`setsid` doesn't leave the cgroup) → no wallpaper for
        ~17 s until the new backend built and replayed. `dotnet watch`'s own restarts don't (same cgroup lives
        on). Either spawn the player out of the unit's cgroup when `INVOCATION_ID` is set
        (`systemd-run --user --scope`), or don't restart the unit by hand.
- [x] `POST /settings` replaces the whole `AppSettings` — a partial body resets every other field to its C# default
      (bit an agent on 2026-10-22: ~15 fields incl. SceneMonitors). Make it merge (PATCH semantics) or reject partial bodies.
      — done 2026-10-26: it merges (`SettingsService.Patch` → `Merge`, `web-backend.md`): keys in the body overwrite
      the saved values, the rest are kept; an array or object replaces its field whole, an explicit null sets null,
      unknown keys are ignored, a bad value is a 400 that saves nothing; one poster at a time. RED before: a partial
      `{"Theme":"Nord"}` reset 26 other fields incl. `PlayerEngine` (→ the engine switched to legacy).
      `scripts/test-settings-merge.sh` (hermetic): partial / full / null / unknown key / 400 / parallel bodies, and a
      partial body applying live (Volume, Speed, NoAudio, VideoScale, override ?? global, rotation interval, engine).
- [x] `POST /playlist/state` binds its whole `CustomPlaylist` (`videoPaths` + `settings` + `name`), same hazard as
      `/settings` had: a body without `videoPaths` saves an empty playlist bar (a running rotation keeps its own list — the
      live reorder skips an empty one), a partial `settings` resets the rest to their defaults (override off →
      the rotation follows the globals live, transitions off). The UI always posts the whole playlist bar; decide merge vs
      reject (`/playlist/play`'s `settings` is per-play by design — defaults intended there).
- [x] Remove the dead `LweSilent` setting (no consumers).
      — done 2026-10-26: gone from `AppSettings` and `session.md` (nothing in src/, app/, scripts/ read it). A
      settings.json that still has it loads (unknown keys are ignored) and the next save drops it.
- [x] Delete stale branches (2026-11-06: those were already gone; the remote has only `lp-player` + `main`; 50 merged local agent branches + their worktrees cleaned up the same day): `transitions-full-live` (ancestor of current), `merge-fix/*`, `pr/*-temp`, `ui/compact-cards`.

## liascape-player (after design approval)
- [x] **Settings levels + a wording pass** (owner 2026-11-06: "simple/standard/advanced/expert … the forever final 4
      levels", "Simple" then renamed "Basic"; Standard the default): one saved `settingsLevel` (basic | standard | advanced |
      expert, `AppSettings.SettingsLevel`) replaces "Advanced settings" + "Show expert options" (the owner's both-on became
      Expert); a pill row in the top bar beside the tabs while Settings is open; each level shows its own rows and every
      row below; a non-default setting a level hides puts a "tucked away" note with Show (no bulk reset: in the first probe
      run it also flipped the player engine). Sections regrouped (Sound, Auto-mute, Playback, Playlist & rotation, Video, GPU
      & memory, Look & feel, Wallpaper Engine, Scene monitors, Getting Workshop wallpapers, Under the hood, the raw commands,
      Keyboard shortcuts, Housekeeping) and rows renamed plainly ("Even out loudness", "Hush when other audio plays", "Pause
      behind windows", "Ease off heavy scenes", "Play scenes", …); the rotation labels kept (the playlist modal shares them).
      web-ui.md § "Settings levels". Tests: probe-expert 6/0 (levels), probe-health 9/0, settings-merge 135/0, the matrix's
      affected cells 784 + the 47 load-hit ones rerun 46/1 → `parked:hold` (its 3 s interval had run out during the slower UI
      steps before parking — the cell now sets the interval from what the held item already played) 2/2 twice.
- [x] **Cold boot: the player blocked 10 s on PipeWire and then had no bus for good** (owner's machine, 2026-10-29
      05:59): Hyprland's `liascape restore` started `serve` before WirePlumber was up; `Bus::create` waited 10 s for
      the loopback to link with the socket bound but the loop not running (every `hello` timed out → the backend
      failed requests fast → the restore's switch failed, no wallpaper), and the first session's failure was final.
      Now the bus thread starts right after the bind + compositor connection and never blocks `serve` (a bounded
      500 ms wait from that start, overlapped with EGL — a normal start's bus is up inside it; the worst case stays under the backend's
      1 s spawn-probe `hello`, whose timeout opens its 3 s stall breaker), a failed or late first session goes into
      the I7 reconnect backoff, and sources/scene workers/the meter move onto the bus when it comes up
      (`audio.bus.up {reconnected: true}`); the `bus` probe says `down`, `connecting: true` and what it waits for.
      Measured: `hello` 5212 ms → 644–707 ms after spawn with a daemon but no WirePlumber (210–247 ms with no audio
      server). `player-core.md` § Audio bus → Fallback. Guards `tests/api.rs::bus_comes_up_when_pipewire_starts_after_the_player`,
      `serve_answers_at_once_while_wireplumber_isnt_up_yet`, `scene_moves_onto_a_bus_that_comes_up_late`,
      `quit_while_the_bus_waits_for_wireplumber_is_prompt`.
- [x] **Cold boot (2026-10-29 08:34): a starting player tripped the stall breaker, and the restore "upgraded" the player
      it had just started.** (1) The player binds its socket first and answers ~0.9 s later; the restore's
      `monitor-daemon` (its `IsPlaying`, a 300 ms `get`) connected in between → its greeting `hello` timed out, the
      breaker opened for 3 s and the `get` was still sent and timed out again. Now a player that hasn't answered this
      client yet gets a 5 s startup grace from its socket's bind (requests and the lock wait for its first answer; a
      timeout past it still trips the breaker; one that answered once keeps QuickMs), requests during our own spawn
      wait for the socket, and a timed-out greeting ends its request. (2) `StaleReason` compared the store root of
      `liascape`'s libexec SYMLINK with the running `liascape-player` package's `.liascape-player-wrapped` → "out of
      date" → restarted onto the same build. Now it compares the file the binary really runs (symlinks + the
      wrapProgram wrapper's `.<name>-wrapped`); a different build (another wrapped binary, the dev tree) stays stale.
      `player-adapter.md` § Threading "A STARTING player" + § Lifecycle "In-place upgrade". Guards: self-test
      `StartupGraceAssertions`, `StaleThroughWrapperAssertions` (incl. the installed `/nix/store/*-liascape-0.1.0`).
- Under "Advance-on-end play-time limits":
  - [x] Unify `PlayTimeInput` with the shared `NumInput` — now a thin h/m/s wrapper over it (rotation redesign below).
- [x] **0 = off + "Separate timing for scenes"** (owner, 2026-10-28 evening): minimum / maximum 0 = off strictly
      (min 0 → a video switches at its end however short; max 0 → never cut, a 10 h video plays to its end), and a
      toggle under them (global + playlist override, only with "Switch when video ends") → "Switch scenes after": a
      scene / still image switches after it (0 = it stays), the min / max then apply to videos only; off = the old
      rules. Defaults now max 0 (was 30 min) + toggle on, 30 min. Live (diffed), across a backend restart, 1-item never
      self-switches. `player-adapter.md` § Rotation (`ItemPlayRule`). One-off migration v2
      (`/tmp/rot-kryxzort/migrate-once.sh` + `test-migrate.sh`, 109 checks; RED on v1: 26): adv+wait → exactly the old
      behaviour (min = old min, max = old max, toggle on, scenes after = the old interval). **Owner action:** run it on
      a copy of `~/.config/liascape` + `~/.local/share/liascape/playlists` (the app stopped), check the printed
      rotations, copy `out/` over the originals.
  - [x] **An fps cap stalls a still image** (found 2026-10-28 by `test-settings-merge.sh`; fixed 2026-10-28): with
        `VideoFpsCap` > 0 (`fps_cap` 98) a `kind: image` source stayed `ready: false` (width 0) and its switch sat in
        `waiting_ready` — nothing showed. Root cause: mpv's `fps` vf never emits the one frame of a still shown
        with `image-display-duration=inf` (`filter input EOF` → `filter output EOF`). The player now never sends
        the `vf` to a still (the extension's guess, corrected by mpv's image flag); the node keeps `fps_cap`.
        Scenes/colours only store it. `player-core.md` § Sources "An fps cap never reaches a still"; guards
        `tests/sources.rs::fps_cap_never_stalls_an_image`, `tests/api.rs::fps_cap_never_stalls_a_still_any_kind`,
        the adapter IT's "VideoFpsCap 30 × an image"; `test-settings-merge.sh` runs its image check with a cap again.
- [x] **Missing libraries fail loudly** (owner todo, 2026-10-28): `GET /health/features` (FeatureHealth.cs; the
      table in web-backend.md — liascape-player, scenes, transitions, VRAM probe, hwdec interop, auto-mute pactl/parec,
      MPRIS playerctl, ffmpeg/ffprobe, steamcmd), fed by the player's new `hello.health` / `liascape-player health`; a warning
      icon with the reason on every affected Settings row (control kept), a summary of what's broken and in use.
      Guards: `--probe probe-health.js` (RED on the base UI), adapter IT (`LIASCAPE_SCENE_WORKER_BIN=/nonexistent`), self-test.
- [x] **Transition duration below 50 ms + free typing in every number field** (owner todo + follow-up, 2026-10-28):
      the floor is 0 ms (0 = a cut, 1–49 ms = that fast an effect; UI, `TransitionService.PickDuration`); every numeric
      settings field is `NumInput` — empty / out-of-range while focused, nothing saved until a valid value or the blur,
      clamped to min/max on blur/Enter. Guards: matrix `num:*`, `plTrShort`/`plTrZero` (RED 12/12). The other agent's
      new min/max play-time inputs (rotation) adopted `NumInput` (PlayTimeInput = an h/m/s wrapper over it).
- [x] **F / any key while holding a slider** (owner todo, 2026-10-28: "make F not do yellow outline when holding
      slider"): no app shortcut is bound to F — any key flipped the held (mouse-focused) slider to keyboard focus →
      Chromium's focus ring. `hooks/rangeDrag.ts` swallows keys during a range drag (shortcuts, Escape, arrows) and
      blurs a keyed slider on release; ranges show the accent glow for keyboard focus, never the system ring.
      Guard: matrix `keys:sliderHeld` (RED: outline `auto`, Escape closed the modal).
- [x] **Slow down morph** (owner todo, 2026-10-28): the card settings modal's card → modal flight (and back) is
      `SETTINGS_MORPH` (open 620 ms with an ease that spreads the travel, close 500 ms) instead of the Browse
      preview's 430 / 340 ms; the Browse preview is unchanged. Guard: `--probe probe-morph.js` (moving time ≥ 520 /
      420 ms; RED before 353–384 / 315–317). Not added: a reduced-motion branch (the app has none anywhere).
- [x] **Auto-mute muted the wallpaper on our own switches** (owner, 2026-10-28: "auto mute is muting itself when
      transition is playing audio" — with both delays 0 a hitch, with a non-zero "unmute after" muted that long).
      Not a missing identity: every own stream (each switch's incoming mpv `liascape-player` / scene worker
      `liascape-player-scene.<id>` stream, the bus playback) carries `node.name`/`target.object`/`application.name` from its
      first `new` event, and R69's filter said "ours" every time. `AudioMonitor` counted a stream's level BEFORE that
      verdict (checked 100 ms + a listing later) and every `change` (the uncork) re-added an excluded stream → B's
      ramp-in at ≈ −62 dB beat the −70 dB threshold. Fix: classify-then-count (parec warms up, the level counts once
      the stream is classified foreign; own ids remembered until `remove`). RED on the base backend: 10/12 method ×
      V/S-combo cells muted (frozen V→S / S→S happened not to), a foreign `paplay` muted in 54 ms; GREEN: 12/12 clean,
      the foreign stream as fast. Guard: adapter IT § "auto-mute never hears our own switches" (a private PipeWire +
      pipewire-pulse). Legacy shares `AudioMonitor` and gets the same classify-then-count (not separately tested — owner:
      liascape-player only). The in-player auto-mute Signal was PARKED then (since shipped: Phase 3 Task 14, 2026-11-02).
- [x] Write the implementation plan (Phase 0 spikes first: LWE `next-v2` core renders offscreen; worker → compositor
      dmabuf sharing on NVIDIA proprietary; libmpv core-profile GL + `volume-gain` crossfade).
      `docs/superpowers/plans/2026-10-20-liascape-player-phase0-1.md`.
- [x] **Phase 0 spikes** (Tasks 1–2): LWE `next-v2` core renders offscreen; dmabuf worker→compositor sharing on
      NVIDIA proprietary with correct sync. `docs/player/spikes/{lwe-core,dmabuf}.md`.
- [x] **Phase 1 core** (Tasks 3–18, plus mini-tasks 16b "player-level pause" and 16c "onset-gated anticlick
      ramps"): the compositor (graph, animator, clocks, EGL/GL, the gl-transitions catalogue, composition),
      video/image/colour sources, all three transition methods (full-live/reveal/frozen) with align/interrupt,
      the runtime + headless mode, the Command API + `ctl`, Wayland outputs, the player audio bus, the
      supervisor + state snapshot/restore, the C# backend adapter behind `PlayerEngine`, and packaging
      (flake + `install.sh`). Default engine stays `legacy`; `liascape-player` is opt-in/experimental.
      `docs/player/architecture.md`, `.claude/rules/player-core.md` / `player-adapter.md`.
- [x] **Phase 1 on-machine battery + report** (Task 20): ≥ 50 switches × {method} × {mode} on the owner's
      machine, a 1 h soak, the per-monitor isolation check. `docs/player/reports/phase1.md` — done: dropout
      0/0 everywhere, frame pacing/outputs/permonitor PASS, 4 product findings fixed (Tasks 20b–20e), final
      soak PASS (0.31 MiB/min).
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **F4 — real scenes' worker CPU over the plan's 5 %**: per frame the worker costs what LWE costs (Kimi/Bunk
        ≈ 1.07 ms CPU per frame at 240 fps; legacy LWE 1.04 at 144); at the default 30 fps Kimi 10.2 % (its sound),
        Bunk 6.6 % (visualiser), Emilia 2.2 %. Profile the scene-audio path at 1× (LWE decode + resample + our
        stream), add the worker's own CPU to the `workers` probe, re-state the bound per scene class.
        **Done 2026-10-29 — a hard limit (LWE's own per-frame cost), restated per class ("Report A Scene
        Worker's Own CPU"):** the `workers` probe now has `cpu {total_ms, threads}`. Release, headless @144,
        `scene_fps` 30: Kimi (sound) 6.0 % (renderer 3.5, PipeWire data loop 2.2), Bunk 2.6 %, Emilia 1.2 %.
        `perf` of Kimi: the render thread 66 % of samples (NVIDIA GL driver + LWE), the audio path ~1/5 —
        LWE's mp3 decode ~5 % of the worker, PipeWire's plumbing ~3 %, ours (Dsp, loudness meter, envelope)
        ~3.5 % ≈ 0.2 % of a core. **Bound per class:** synthetic / light scenes < 5 % at 30 fps (PASS); heavy
        scenes cost ≈ 0.8–1.1 ms CPU per frame (= legacy LWE), so < 5 % only up to ~30–45 fps — not a
        compositor bug. Open idea: a `no_audio` / paused stream still runs its callbacks (1.2 %); deactivating
        it costs a bus cycle sometimes (F7 residual) — only once that's solved.
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **F5b — a heavy single-draw worker still costs a 240 Hz output frames** — **DECIDED 2026-10-29 (owner):
        keep the 400 ms/s guard** (on-machine `phase2-20261029T202428/budget.json`: ~3.7 ms/frame → DP-2 p95 7.24 ms,
        39 missed, capped at 65 fps; ~6.2 ms → throttled to 50 fps in 1.4 s, still 80 missed — the throttle can't
        save the 240 Hz output, so it isn't lowered). Revisit only with explicit sync / egl-wayland2 6235dd8.: at 220–260 ms/s of worker GPU,
        DP-2's 240 Hz clip missed 33–38 frames / 2 s (p95 6.9–9.1 ms); the throttle stops at its GPU-load guard
        (400 ms/s). NVIDIA doesn't preempt the low-priority context mid-draw and with explicit sync off each swap
        waits for the GPU on the loop. Options: a lower guard when another output misses, splitting LWE's frame
        (not ours to split), or explicit sync back once egl-wayland2 ships 6235dd8. Re-measure on a quiet machine
        with the GPU clocks up (the run's card sat in P3, 1140/2100 MHz, with another process on it).
        **Re-analysed 2026-10-29 (`phase2.md` § 10 F5b): a hardware/driver limit at this policy** — no mid-draw
        preemption, so misses ∝ heavy frames/s × draw length (measured ≈ one miss per 3–4 worker frames at
        ~4 ms/frame). A lower guard would floor such a scene at 10 fps and still leave ~4 % misses at 240 Hz, and
        throttle scenes for misses a game caused. **Waiting on owner:** keep the 400 ms/s guard, or trade a
        very heavy scene's fps for the 240 Hz output? Re-measure: `systemctl --user stop liascape-watch; bash
        src/player/tests/onmachine/scenes.sh budget` on a quiet machine.
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **Corpus under load**: at load 12–14 two scenes needed 18.7 s / > 20 s to Ready (1.5 s / 6.1 s on a quiet
        machine), and a transition waits only 10 s for its B. **Done 2026-11-03** (player-core.md § Scene worker →
        "Real scenes" LoadGate, § "Transitions with scenes"): a heavy scene's build is ONE CPU-bound thread
        (3.5–4.9 s of CPU) that waits in the run queue on a busy CPU — re-measured 7.1 s quiet, 13.1 s with 24
        busy threads + 3 scenes playing, 16.4–19.8 s with 48. A scene B whose worker is alive and loading (new
        observed `loading`) is now waited for up to 50 s (under the backend's 60 s), A untouched meanwhile (end to
        end at 48 busy threads: failed at 10.2 / 10.3 s before, started at 17.3 / 17.6 s after); the
        worker's load cover (30 s) stays on past its bound while the load still gets CPU time (cap 120 s), so a
        starved load (28 s for LWE's core alone at 5 runnable threads per CPU) is no longer killed as hung. No
        nice/`SCHED_IDLE`: B's load didn't cost the playing scenes a frame (71–77 vs 72–73 frames/s), and a
        deprioritised build would only stretch it ~10× under load. Not reproduced: 2890767643's 18.7 s (CPU, GPU,
        cold cache and I/O load gave ≤ 3.6 s — VRAM pressure is the remaining suspect).
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **F7 — one 3 ms micro-gap at a frozen S→S handoff at 240 Hz** (1/20 in the final run, 2/20 in run 2).
        **Fixed 2026-10-29 ("Leave The Graph Before A Scene Worker Exits"):** a REAL hole — the new
        `scenes.sh onsetrec` records the sink independently: a worker exited with its stream active in the graph
        and the bus lost whole graph cycles (exact silence, 64–384 samples) in *every* S→S switch, in B's sound
        (frozen 60/61, full-live 30/30 at full level). The detector saw ~1 in 20 because the meter's capture lost
        the same cycles (`unmeasured`). The worker now deactivates, settles 20 ms and disconnects (roundtrips)
        before exiting: frozen 0/121, full-live 2–5/60, reveal 4–8/60 — single 64-frame cycles, see below.
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **F7 residual — a single graph cycle lost at a stream's deactivation** in ~1 of 15 full-live/reveal
        switches (0 frozen): at the worker's `set_active(false)` (moved with it when the disconnect was delayed
        150 ms), through the in-process bus loopback (a `pw-play` killed into the bus: 1/10, straight into the
        sink: 0/10). `target.delay.sec` on the loopback didn't help (5/60).
        **Root cause found and fixed 2026-11-04 ("Make Every Bus Stream An Async Node"; player-core.md § Audio
        bus → "Async streams").** The private server's profiler (`scenes.sh onsetrec`, `ONSET_PROFILE=1`,
        release, 240 Hz, full-live S→S) showed every lost cycle: the bus `not-triggered`, A's stream gone, B's
        stream `finished` a whole cycle late, position jump 128 — 7 of 7 in 60 switches, each 1.5–6 ms after A's
        `worker.stopped`. A libpipewire race on a *synchronous* link: `pw_stream_set_active(false)` marks the
        client's activation INACTIVE at once, the server drops the stream from the bus's dependency count only
        after a protocol roundtrip, and a driver cycle starting in between skips the stream yet the bus still waits
        for it → the graph xruns, the sink gets one quantum of zeros. The loopback's capture *asked* to be async
        (`PW_STREAM_FLAG_ASYNC`) but only the `node.async` property reaches the server, so every link into the bus
        was synchronous. Fix: the scene worker's stream carries `node.async = true`, and the compositor sets
        `PIPEWIRE_PROPS={ node.async = true }` for itself (mpv's AOs have no other way; the loopback halves, the
        meter and the probes go async with it) — no consumer waits for a producer inside a cycle any more.
        Before/after (release, 60 full-live switches): 6–7 → **0** zero runs, 7–8 → **0** xrun cycles (two runs
        each); `latency_ms` 0 → 2.67 (the two async hops, `ASYNC_HOPS`, compensated through `audio_delay_bias`;
        `bus.sh` gate ≤ 2 hops + 1 quantum + 5 ms). Tests: `tests/api.rs::bus_producers_link_asynchronously`
        (`pw-dump`: every link into the bus `link.async`), `scene_worker_exit_never_skips_bus_cycles` (now
        full-live, 20 switches, 0 runs), `mpv_source_teardown_never_skips_bus_cycles` (V→V; RED 1/20 before).
        Both recordings judge their runs against the event log: a run in the race window after a
        `worker.stopped` / `source.drop` fails; a debug build under the full suite can still lose a cycle to
        plain lateness (seen at B's first render, 128–192 samples, no event near) — printed, tolerated up to 1 in
        10 switches; release on a quiet machine: none.
        The one-off "A audible again 90 ms after its anti-click" (once in 300+ frozen switches) was never
        reproduced; `scenes.sh onsetrec` still dumps the event log for it.
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] ~~**The bus meter's capture misses 1–5 ms when another stream leaves the graph** (proven
        measurement-only)~~ — **wrong (2026-10-29):** those were the real lost cycles of F7 (the earlier
        `pw-record` check looked for a phase step, which a cycle of zeros in place doesn't make); with F7 fixed,
        switches with an `unmeasured` stretch fell 60/60 → 5/60 (frozen) and 30/30 → 2/60 (full-live).
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **A suspend no longer kills the scene worker as "hung"** (2026-10-29; `phase2.md` § 8, player-core.md §
        Scene worker → WorkerHost → Heartbeat). Both on-machine suspends SIGKILLed a live worker: after the resume
        the compositor held every slot of its ring (fences not signalled yet) and the idle worker waited for a
        `Release` (08:16, `waited_ms 2001`), and the VRAM save blocked the compositor's own loop ~6.4 s (08:35,
        `waited_ms 6438`). The heartbeat now skips a starved worker's tick age (pinged instead; bounded at 5 × the
        timeout) and the time of a host stall (a poll gap > half the timeout); a real hang keeps its bound.
        Tests `tests/worker.rs::starved_*`, `host_stall_is_not_a_hang`, `worker_freeze_while_the_host_polls_is_hung`,
        `tests/scene.rs::gpu_stall_that_starves_the_worker_is_not_a_hang`.
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **Phase 2 Task 15 — docs sweep** (2026-10-28): `docs/player/architecture.md` (process model with
        `liascape-scene-worker`, §4 rows, §6 roadmap, invariants 9–11), `docs/player/invariants.md` #10 (a worker frame
        never blocks the compositor) + #11 (a worker's audio is a gain on a stream that keeps running),
        `docs/player/debugging.md` § Scenes (black / frozen / silent / crash loop / throttled / VRAM / loudness,
        `probe workers {"log_tail":true}`), `.claude/rules/player-core.md` + `CLAUDE.md` consistency.
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **Scene loudness learned on first play** (2026-10-28, player-core.md § Scene worker → "Scene loudness",
        player-adapter.md § Scenes → "Loudness", library.md § Loudness): the worker K-weights what the scene really
        plays (pre-gain; paused / `no_audio` / fallback excluded) into 100 ms segments (`PROTOCOL` 3), the compositor
        gates + integrates them (BS.1770-4) over 60 s of AUDIBLE play → `scene.loudness` once (a partial from 20 s
        when switched away early); the backend stores it in the index (learned once; a partial until a complete
        one) and applies it as the scene's `gain.normalize` (target − I, sample peak ≤ −1.5 dBFS, ramped 500 ms
        live, set at create). Silent scenes: never stored/normalized. Legacy LWE scenes: not normalized (unchanged).
        Open: a matrix cell (the matrix player would need the short window knob — covered by the adapter IT
        instead); the true peak isn't measured (sample peak, ≤ true peak by < 1 dB for most content); a scene
        whose sound depends on its user properties keeps the loudness of the properties it was first learned with.
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **Scene loudness refined on every play, capped** (2026-10-28, owner: "60s to normalize for rest of scene, keep
        measuring … when the scene is played in future (probably add a max cap …)"; same three docs): the compositor
        keeps the BS.1770 blocks as a 0.1 LU histogram (−70…+5 LUFS — the relative gate recomputed over every play),
        reports it (`state`) at the window, after each further 60 s of audible play, at the end of a play (≥ 5 s new)
        and once at the cap (`LIASCAPE_PLAYER_LOUDNESS_CAP_S`, 30 min of audible play over every play — then the worker
        stops metering: `ToWorker::LoudnessMeter`, `PROTOCOL` 4); the backend stores the longest report
        (`loudnessState`), seeds every new source with it (`loudness_seed`, create only) and moves the applied
        `loudnessI`/`loudnessTP` → `gain.normalize` (500 ms ramp) only by ≥ 0.5 LU. Entries learned before: applied
        as is, re-learned by the next complete report (no migration). Open: a compositor crash loses what the live
        source measured since its last report (≤ 60 s; the snapshot restores it with its create-time seed); two
        sources of one scene at once keep only the longer one's contribution (since 2026-10-29: the newer continues the
        older's live measurement — the entry below); a `path` change on a live scene source
        drops the seed but the graph/snapshot still carry the old one (the backend never path-changes a scene).
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **A reopen right after a stop can seed with the previous report, not the end-of-play one** (found 2026-10-28
        by the fps-cap fix's adapter-IT runs, 2 of 3 runs, on both the fixed and the pre-fix player — unrelated to
        that fix): IT § scene loudness "reopened: seeded with the stored measurement" read `loudness_seed` 3.0 / 6.0 s
        while the index already held 5.8 / 6.3 s. `stop_now` → `/apply` the same scene: the stopped source's
        end-of-play `scene.loudness` (`finish`, ≥ 5 s new) is stored off the event thread AFTER the new source's
        `SourceProps` read the index — the new source continued the older seed, the stretch between the two reports
        lost (and a rest < 5 s at the end never reached the index at all). **Fixed 2026-10-29 in the player**
        (player-core.md § "Scene loudness" → "One measurement per path", player-adapter.md § Scenes → "Loudness"):
        the compositor keeps one measurement per scene path (`audio::loudness::Book`, owned by `SourceHost`); a new
        source continues it — the last one left (a reopen) or the live one (a transition A → A' of one scene: only
        the newest source of a path measures from then on) — unless its `loudness_seed` covers more (adopted then:
        one of the two kept, never added — no double count). No wait anywhere: 0 ms added to a switch; the
        backend's seed stays the fallback after a compositor restart (behaviour there unchanged). Tests: units
        `book_*` (3), api `scene_reopen_continues_the_end_of_play_measurement` (RED before: the reopen continued
        the window's 2.0 s for the end's 3.0 s); the IT check now reads what the player continues (`workers` probe
        `seed_s` ≥ play 1's last report and ≈ its play time: the end report + a rest < window/12, or — a reopen during
        the stop's fade-out, seen in 1 of 4 runs — play 1's live measurement handed over), then the index catching up.
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **Offline scene loudness estimate — the player half** (2026-10-29, player-core.md § "Scene loudness" →
        "Offline estimate"): `scene::loudness_estimate` + `scene::pkg` + `liascape-player scene-loudness <dir>
        [--props '<scene_props>'] [--model lwe|we]` — a scene's sound objects → a play plan → each audio file decoded
        once (ffmpeg) to per-100 ms K-weighted powers (cached per file, `~/.cache/liascape/scene-loudness`) → mixed as
        a power sum → the live `Learner` itself, so the estimate is the learner's own `state` (a seed it continues) +
        `seed.state` scaled to 10 s, a `fingerprint` of the audio configuration and a `confidence`. **Validated**
        against LWE's real output (`--lwe-smoke --audio-dump 45`, 53 scenes with sound of the owner's library): the
        first 45 s estimated within ±0.10 LU in 46, ±0.25 in 51, median −0.03; outliers are flagged `low` and
        bracketed (`lufs_if_coherent`): 3289734539 −2.6 (a vocal and an instrumental version of one song playing at
        once — they add partly coherently), 3174556087 −0.75 (11 tracks at once). Against the live learner's stored
        state (all three measured scenes): −16.59 vs −16.58, −5.11 vs −5.12, −14.57 vs −15.18 (that one's plays
        were mostly shorter than its 167 s track, so the live histogram over-weights its quiet intro). The full-track
        estimate differs from a scene's first minute by a median 1.1 LU (up to 10.7): an estimated seed is a better
        start than the first 60 s report. **Found:** LWE plays every file of a sound object at once at unity gain and
        ignores `volume` — 57 of the library's 79 sound objects carry a volume it drops (32 bound to a user property,
        25 a literal ≠ 1), so no property changes a scene's sound under liascape-player today (next entry).
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **LWE ignores a sound object's `volume` (and its user property), `startsilent` and the playlist modes**
        (found 2026-10-29 with the estimate). **Fixed 2026-10-29 by fork patch 0018** (player-core.md § "LWE core";
        spec `docs/player/spikes/we-sound-semantics.md` § 4): `sound` string or list, ONE random file per start,
        `volume²` per stream as a live `DynamicValue` (unclamped), `loop` back to back / `random` + a
        `mintime`..`maxtime` gap / `single` once, on the host clock; a rise from 0 restarts a stopped non-`single`
        object. Checked on real scenes: 3289734539 plays one version (0.49 × the instrumental), 2951169110's
        orchestral silent until its slider moves (then live), 3276522107's train music 0 at its default (its sound
        objects in a bare scene: LWE can't load the scene itself — corpus `load_failed`), 2375914945
        `musicvolume` 0.8 → 2 = +15.92 dB, 2886313155 `random` gaps 1.98 / 4.85 s. The estimator's `lwe` model now
        equals `we` (kept the default; 20 scenes re-validated: ±0.10 LU in 17, the 2 off ones are random picks).
        `SOUND_SEMANTICS` 2 is hashed into every fingerprint. **Open:** spatialization (WE pans a 2D scene's sound
        by the object's x when `spatialization` is set) not done; `startsilent` sounds never play (LWE's SceneScript
        has no sound methods — `CSound::play()` is the hook); a start opens the picked file on the render thread
        (22 ms for a 40 MB WAV in a `scene.pkg`, every few minutes). The fork commit `c3a7d68` is local only until
        the owner pushes `livepaper/next-v2` (this machine's store holds its source, so the flake builds here).
        **One-off (owner, no migration code):** the index's flat `loudnessState` isn't keyed by the fingerprint, so
        a stored measurement of the OLD sound is continued by the next play: stale for 8 of the 10 measured items
        (3289734539, 3023509773, 3013489778, 2511663284, 2371103399, 2375914945, 2288455459, 3219908811 — volume ≠
        1 or several files; 3363252053 and 3422085307 play as before). With the backend stopped, drop their
        `loudnessI`/`loudnessTP`/`loudnessSeconds`/`loudnessPartial`/`loudnessState` in
        `~/.local/share/liascape/library/local/index.json` (or the whole loudness block of every scene: the 2
        unaffected relearn too), then they relearn on their next play (and the player restarted, so its `Book`
        holds no old measurement).
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **Offline scene loudness → integration** (design 2026-10-29; **built 2026-10-29** — player-core.md § "Scene
        loudness" → "Per audio configuration", player-adapter.md § Scenes → "Loudness", web-backend.md § Scene loudness,
        library.md § Loudness, web-ui.md; owner decisions folded in: estimate on import + a "recalculate all" button;
        property-aware loudness). **As built:** backend `Helpers/SceneLoudnessPlanner.cs` (the CLI run + store) +
        `Web/SceneLoudnessOps.cs` (the queue, endpoints, WS); `LibMeta.SceneLoudness` / `SceneLoudnessFp` replaced the
        flat `loudnessState/Seconds/Partial`; the player's `loudness_key` prop + `Book` per (path, key) + 0.5 s settle;
        Settings → Playback → "Scene loudness" (under "Normalize audio", liascape-player only); the card modal's
        loudness line. The owner's library: 96 scenes estimated at the first start in 9.8 s (warm per-file cache;
        55 with sound, 1 `low`), 0 failed. **Choices where the design was open:** (a) the estimate stores the CLI's
        `seed.state` (the 10 s seed) as `estimate.seed`, not the full-weight `state` — nothing reads the full one;
        (b) a report without a key (a source created before the item had a fingerprint, or by a player without the
        prop) goes to the item's CURRENT configuration, else `""`; an item's first estimate adopts a `""` live
        measurement (it was measured with the props it has now); (c) on a property commit the re-plan runs FIRST
        and `scene_props` goes in the same pass as the key (a few ms later than before) — so the new mix never
        lands in the old key; the drag twin (`/preview`) still applies at once and its segments count for the
        configuration the source is keyed to (no settle on a preview), and a preview queued while a commit re-plans
        makes that commit's pass leave `scene_props` alone (it would revert the preview — the preview's pass carries
        every saved property anyway); (d) the backend sends `loudness_key` only to
        a player whose `hello.capabilities` has `scene_loudness_key` (an older player rejects the prop at create);
        (e) the settle is wall-clock 500 ms from the `set`, not a segment count; (f) the startup pass and every sync
        queue every library scene WITHOUT an estimate for its stored configuration (a folder that's not a scene
        fails again in ms each time — not remembered); (g) a property commit under the legacy engine re-plans too
        (nothing live), so the stored configuration follows the props whichever engine plays; (h) the Settings row
        shows whenever liascape-player is the engine (not only with normalization on). **One-off (no migration
        code):** the 13 flat measurements (all post-0018; the 8 stale ones were already gone) were moved to
        `sceneLoudness[<fingerprint of their current props>].live` by a script with the backend stopped
        (`migrate_scene_loudness.py` in the session scratch dir: flock + atomic write, live `lufs` re-integrated
        from the histogram, applied `loudnessI/TP` untouched). An installed (older) backend writing the index drops
        the new fields — reinstall. **Open:** a committed property's pass waits for the re-plan + its index write: measured 0.3–1.0 s on the
        owner's machine under load (the CLI 40–60 ms; the rest `SetMeta`'s write — ~290 ms for ANY index size here, the
        143 KB one before this change too), so a committed toggle shows that much later than before (a drag preview is
        still immediate) — if it's noticeable, send `scene_props` at once and accept the gap's segments in the old key.
        A configuration's live measurement is never pruned (a slider dragged
        through many values leaves an estimate entry per committed value — ~1 KB each).
    - **When the backend runs it.** (1) **On import**: every scene that enters the library (WE local import,
          Workshop download, the auto-add sync) is queued once its folder is complete (`project.json` + `scene.pkg`/
          `scene.json` present — a half-downloaded item fails `SceneDir::open` and is retried by the next sync).
          (2) **Settings → Audio, under "Normalize audio"** (not Library's Clear Cache/Clear Settings rows: those are
          destructive maintenance; this is a loudness action and only means something with normalization — shown
          when the engine is liascape-player): a row "Scene loudness — estimate all" with **Estimate** (skips scenes
          already estimated for their current fingerprint) and **Recalculate all** (force) + Cancel while running. The
          owner's one-off backfill is simply that button. One `ScenePlanner` queue in the backend: one
          `liascape-player scene-loudness <dir> --props '<item scene_props>'` child at a time under `nice -n 19
          ionice -c3` (the per-file cache makes a repeat a re-mix, ~1 ms), never on a request thread, never touching
          playback (the live player is not involved at all). **Cancel-safe**: each scene's result is written to its
          index entry atomically (`SetMeta`) only when its child succeeded; cancel kills the running child and drops
          the queue; a restart re-queues what has no estimate for its current fingerprint.
    - **API + progress.** `POST /library/scene-loudness/estimate {paths?: [...], force?: bool}` → `{queued}`
          (no paths = every scene); `POST /library/scene-loudness/cancel`; `GET /library/scene-loudness/status` →
          `{running, done, total, current, failed: [{path, error}]}`. Event **`scene-loudness-progress {done, total,
          currentId, finished?, cancelled?}`** (shaped like `unsub-progress`) → the topbar status (`s.status`, App.tsx:
          "Estimating scene loudness 12 / 96…", cleared on `finished`); `library-item-changed` per stored scene so the
          card's loudness line updates.
    - **Storage per item** (`LibMeta`): `SceneLoudness {<fingerprint>: {estimate: {lufs, peak_dbfs, state (full),
          confidence, model, v}, live: {state, seconds, lufs, peak_dbfs, partial}}}` + `SceneLoudnessFp` (the current
          configuration's). The applied `LoudnessI`/`LoudnessTP` keep their meaning (the CURRENT fingerprint's value,
          0.5 LU hysteresis): **live** once it has a report (≥ 20 s audible), else the **estimate**. Toggling a sound
          off and back on returns to the measurement that configuration already had; a never-played combination
          starts from its estimate at once (a re-mix — no decode). The existing flat `loudnessState`/`Seconds` of
          the three measured scenes go to the fingerprint of their current props by a one-off script (no migration
          code). A missing/failed estimate = today's behaviour (learn on first play).
    - **Weighting.** The source's `loudness_seed` = the fingerprint's live `state` if any, else the estimate's
          `seed.state` — the estimated histogram scaled to **10 s** of audible play (`--seed-seconds`): the first live
          report (window 60 s) weighs it 1:6, the cap (1800 s) 1:180. An estimate never displaces live data (the
          player's `Book` adopts a seed only when it covers more audible play — 10 s never does past the first 10 s),
          and the backend never stores a report over a longer one (unchanged `MergeSceneLoudness`).
    - **Property changes while playing** (`/library/scene-props` commit; the drag twin `/preview` changes nothing
          here): the backend re-plans (`scene-loudness --props`, cached: ~1 ms + spawn) → the new fingerprint →
          its target (live, else estimate) → one batch to the item's sources: `set <src>.scene_props`, `set
          <src>.loudness_key <fp>` + `set <src>.loudness_seed <its state>`, `animate <src>.gain.normalize` 500 ms
          (a ramp, never a jump). **Player half (to build):** a `loudness_key` source prop; the `Book` keyed by
          (path, key); a key change on a live source = `leave` the old key (its rest reported with that key) +
          `join` the new one (seeded), segments for 0.5 s after the change dropped (the worker applies the property
          within a frame; the stream's buffers still carry the old mix) — so two configurations never share a
          histogram; `scene.loudness` carries `key`, and the backend stores each report under it. Since fork patch
          0018 a property that changes a sound changes the fingerprint (the entry above), so this flow is live as
          soon as it's built.
    - **UI.** The card settings modal's loudness line / tooltip: "≈ −14.6 LUFS (estimated)" vs "−15.2 LUFS
          (measured, 30 min)"; a `low` confidence adds its first note ("two versions of one song play at once — may be
          up to +4.7 LU louder"); `/library` items gain `loudnessEstimated`.
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **Scene normalization set once per play** (2026-11-06, owner: "make scene audio normalization not do the real-time
        normalization where it just changes every second and just make it how you said where it checks for 60s and
        calculates rest of the scene for future"; player-adapter.md § Scenes → "Loudness" → "Set once per play",
        library.md § Loudness, player-core.md § "Scene loudness" → "Applying it"). **What moved the gain:** the backend,
        on every `scene.loudness` report whose applied value moved ≥ 0.5 LU (`OnLoudnessMeasured` → `ApplyEffective` → a
        500 ms `gain.normalize` ramp) — reports come at the window and after each further 60 s of audible play, so a first
        play moved at ~50/60 s, ~120 s, ~180 s… (the owner's adapter log: 209 such live moves since 05:50, 2951169110 and
        1884904087 three times in one play). Nothing in the worker moves it (no AGC/limiter: a ±1 clip after the gain
        only); the player itself never touches `gain.normalize`. **Measured before** (private backend + headless player,
        `--ao null`, 2951169110 from its estimate): play 1 (200 s) = 3 ramps — 52 s 11.10 → 13.01 dB, 96 s → 12.04, 170 s
        → 13.01; play 2 (130 s, already measured) = 1 ramp at 115 s, 12.11 → 13.01. **Now:** each live scene source keeps
        a pin (`LiascapePlayerMedia.NormalizePin`); the only automatic move is the window landing (`WindowReached`: the
        report that first completes the current configuration's measurement) — once, for a play that started from an
        estimate / a partial / nothing (until then it plays at its estimate, else unity); further reports refine the
        stored value for the next play only; the user's normalization settings and a property commit's new configuration
        still apply live. **Measured after** (same run): play 1 = 1 ramp, at 54 s (11.10 → 13.01: the window landing),
        then nothing through 3 further reports (the stored value moved twice, "applied from its next play"); play 2 = 0
        ramps — it opened at the refined 12.81 dB and kept it while the stored value moved twice more. **Decided:** the
        window still counts the estimate's 10 s seed (an estimated scene lands after ~50 s of audible play — the
        measurement then is 50 s measured + the estimate at 1/6 weight); a backend restart mid-play pins what each source
        runs (a landing missed while away isn't replayed); an estimate landing mid-play changes the stored value only (a
        never-estimated scene stays at unity until its window). **Seen meanwhile:** the owner's player log has auto-mute
        flapping in bursts (12:14:30–:46: 6 mute/unmute pairs in 16 s, kded6 + Spotify, the 500 ms unmute delay) — a mute
        every second or two sounds like "changing every second" too; not touched here. The stream's summed gain is capped
        at +12 dB by the player (`units::MAX_DB`) while `SceneNormalizeDb` allows +24: a very quiet scene's normalization
        stops at +12 (2951169110's 13.01 played as 12.0).
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **Scene properties editor** (2026-10-28, library.md § "Scene properties", player-adapter.md § Scenes,
        web-ui.md): a WE scene's `project.json` `general.properties` in the card settings modal (bool / slider / colour /
        combo / text input; labels; JS-ish `condition` visibility), saved per item (`LibMeta.SceneProps`), live on
        the scene's source(s) (`scene_props`, the resolver — at every open, R81, a reset sends the default), a
        no-persist drag twin; legacy: LWE `--set-property` at launch only. **Open:** `scenetexture` / `file` /
        `directory` properties (a user-picked image/video — needs a file picker + the path reaching the worker) and
        `usershortcut` (Windows app launchers) are listed but not editable; a refused property (`scene.property`
        ok:false — LWE's "Property not found") only logs, the modal doesn't say so; a scene's own JS that reads
        `engine.userProperties` reacts through LWE (nothing of ours). Noticed, not checked: LWE's parser keeps a
        `textinput` default as its JSON dump (`"YOURNAME"` with the quotes, `PropertyParser::parseTextInput`) while a
        set value has none — a Phase 6 corpus item if a scene shows the quotes.
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **Task 13 — scene corpus runner + first report** (2026-10-28): `docs/player/reports/scene-corpus.md`
        (86/96 ok; every non-ok one fails in LWE alone); its LWE findings are Phase 6 items under "Scene
        compatibility programme" below.
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] `tests/scene.rs::transport_meets_the_spike_budget` red in most full-suite runs (2026-10-28, player-core.md
        § Frame transport → "What the worker's CPU figure is"): **the machine, not the work** — a constant 175–178 k
        user instructions + 4 wake-ups per frame read 2.1–25 % CPU with core type (P/E +30 %), clock (`powersave`
        cores at 0.8–1.4 GHz) and memory contention (7×). The features cost ≤ 0.15 % (GPU timer 7 k instructions;
        reset status 0; the idle audio thread 0.06 % — removed: a soundless scene starts none). The test now pins
        to the P-cores, takes the median of 1 s windows, and asserts the work (instructions, wake-ups) + the CPU
        budget, reporting an over-budget CPU figure with the work in budget as the machine.
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **Phase 2 Task 11 — scenes playable under liascape-player in the backend** (2026-10-28,
        `.claude/rules/player-adapter.md` § Scenes): `ScenesPlayable` = AllowScenes && the player's `scene`
        capability (else `liascape-player scene-check`, cached 30 s); a scene item → `kind: scene` + its preview;
        `SceneMonitors` fps live (`out:<c>.scene_fps`); `source.broken` → marked crashed (D6: skipped unless
        whitelisted), WS `scene-crashed`, a rotation playing it advances at once; `/player-engine.scenes`;
        Settings hides the scene delay + primary radio under liascape-player. The player emits `source.broken` now
        (the event half of Task 10). **Follow-ups:** Task 10's rest (preview while no frame / broken, a broken
        scene in the snapshot); ~~Task 12 (matrix scene cells)~~ (done 2026-10-28, web-ui.md § Scene cells); ~~the Task 8 settings' backend wiring~~ (done
        2026-10-28, below); `player.scene_assets` has no
        setting yet (auto-resolve only); ~~the scene properties editor (`scene_props`) is its own task~~ (done
        2026-10-28, below); a
        hotplugged output that's in `SceneMonitors` gets its fps only at the next player process or `/settings`
        change (the player remembers connectors it saw).
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **Phase 2 Task 8's settings wired in the backend** (2026-10-28, player-adapter.md § Scenes → "GPU / VRAM
        settings"): `AutoThrottleScenes`, `LimitVramPerScene` + `SceneVramLimitMib`, `VramLowMode` → the player
        props, live and re-asserted per player process; `scene.vram_exceeded` → WS `scene-vram-stopped` + the
        rotation advances, never marked crashed; `/player-engine.vram`; Settings → "GPU / VRAM". **Open:** a scene
        pending B (armed for A's end) stopped by the guard fails that switch and the fallback switches to it now —
        it plays ~2 s before it's stopped again (bounded, but visible); decide whether a VRAM-stopped scene should be
        skipped for a while (it isn't broken). The low-VRAM hold has only a Settings status line (no tray/toast).
- Under "Phases 2–6 per design §12 (scene worker; Programs/Signals in-process — the auto-mute Signa":
  - [x] **A VRAM-stopped scene kept its imported ring** (~3 × its export size of GPU memory, the Task 8 gap;
        2026-10-28, player-core.md § GPU budget and VRAM → per-scene guard): only the shown slot stays imported.
- [x] AI docs + debug mode per §8/§9; `UPSTREAM.md`; per-component Claude rules — `docs/player/architecture.md`,
      `docs/player/invariants.md`, `UPSTREAM.md`, `CREDITS.md` (generated, `scripts/gen-credits.py`),
      `.claude/rules/player-core.md` / `player-adapter.md` (Task 19), `docs/player/debugging.md` (Tasks 15/16c/d).
- [x] **Final-review fixes**: GainHistory bounded (C1), pause lifetime (I1/I3), the pause gate on its own slot
      (I2), switches with no output (I4), async mpv core open (I5), one onset helper (I6), bus reconnect (I7).
- [x] **Phase 2: render worker** — move every `MpvSource` render context (creation + first render, the
      residual ~6–25 ms per switch on the loop after I5) to a worker thread with a shared EGL context;
      `.claude/rules/player-core.md` § Runtime "Switch cost and the Phase 2 render worker".
      — done 2026-10-26 (`sources/render_worker.rs`, § Sources "Render worker"), **default on**
      (`--render-worker off` / `LIASCAPE_PLAYER_RENDER_WORKER=off` = the loop renderer): the switch loop's warm median
      max_busy 16.3 → 1.3–3.6 ms; missed frames at 2× 1080p120 on a 240 Hz content-paced output 2.2/3.3/3.2 →
      1.8/2.0/2.5 per s (steady / ±0.05 / random 1.6–2.4×); full suite green with it on and off; UI matrix
      682/0 with it on (an `lia-render` thread verified in the matrix's player); a nested sway on NVIDIA 595
      green both ways. Guards: torn-frame (RED with `publish-early`: 42/196 bad captures), switch-busy, death
      → exit 3 → supervisor restart, no-context → loop fallback, bounded quit. Bench:
      `cargo test --release --test api -- --ignored bench_render_worker_ab --nocapture`.
- [x] **`/next`/`/prev`/`/random` crash on a scene under `PlayerEngine=liascape-player`** (Task 20 battery,
      `docs/player/reports/phase1.md` §1.3) — fixed in Task 20c: `TryStepLibrary` steps past unplayable scenes,
      `ApplyRandom`/timed random drop them from the pool; an all-scene library → 409 (CLI: stderr + exit 1).
- [x] **The owner's installed `liascape` (NixOS package) predates liascape-player entirely** — done 2026-10-25: `/etc/nixos/liascape.nix` re-pinned to the local `liascape-player` commit for testing (re-pin to the GitHub commit after the merge/push) (Task 20 battery,
      `docs/player/reports/phase1.md` §1.4): confirmed via `strings -el` on the installed `liascape-backend.dll` —
      zero occurrences of `PlayerEngine`/`LIASCAPE_PLAYER_BIN` anywhere, while the current dev build has both. So
      every one-shot CLI command (`restore`, `random`, `kill`, a keybind action) silently runs legacy whenever
      `liascape-player` is selected, even though the long-running `serve` backend (what the UI talks to) is fine.
      Needs an actual rebuild from this branch, not a code change — **owner action:**
      `sudo nixos-rebuild switch --impure` (the module builds from the local flake, `git+file`).
- [x] **No explicit cap on concurrent `lia-open` worker threads** (final review I5's async mpv-core-open
      mechanism, `.claude/rules/player-core.md` § Sources "Async opens") — a burst of near-simultaneous
      switches/creates has no ceiling on how many `lia-open` threads it can spin up at once. Not exercised by
      anything in Task 20's battery (every cell opens sources well below any plausible concurrency ceiling);
      worth a bound + a test before Phase 2 leans on this path harder.
      — done: `host::OpenPool`, a FIFO queue on ≤ `MAX_OPEN_WORKERS` (2) on-demand `lia-open` threads; a job
      queued for a node destroyed meanwhile is skipped (no core made). Burst of 16 paused 1080p creates: all
      made + opened 61–80 ms (uncapped 23–70, cap 4 58–71), all ready ~0.5 s either way, the loop's longest
      open share 2–8 ms (uncapped 13–29). `tests/api.rs::i5_open_burst_is_capped_and_none_lost` (RED: 16 at
      once; GREEN: peak 2, the 3 destroyed while queued skipped, quit with a queued burst 40 ms, no straggler).
- [x] **`LIASCAPE_REQUIRE_GPU` test mode** — every GPU-dependent test (`tests/common::headless_gl` et al.)
      currently just prints `"SKIP: no EGL device"` and returns on a GPU-less machine; there's no way to make
      a CI run that's *supposed* to have a GPU fail loudly instead of silently skipping everything. Not
      exercised in Task 20 (every run there had a real GPU) — worth adding before relying on CI coverage of
      this crate's GPU paths.
      — done: `LIASCAPE_REQUIRE_GPU=1` (anything but empty/`0`) turns every GPU-test skip into a failure via one
      helper, `tests/common::skip_gpu` (`headless_gl`, `catalogue_dir` — the "no catalogue" skips too, since
      nearly every GPU test needs it — and the inline lib unit test); opt-in/non-GPU skips (Wayland, private
      PipeWire, credits) stay skips. GPU-less machine simulated (`__EGL_VENDOR_LIBRARY_FILENAMES` naming no
      file): the suite passed in ~3 s with 133 SKIPs; with `LIASCAPE_REQUIRE_GPU=1` those 133 fail.
      `tests/gfx_basic.rs::require_gpu_turns_a_missing_gpu_into_a_failure` (RED: the old binary passed).
      `player-core.md` § GFX / EGL.
- [x] **Zero-copy hwdec back (Phase 2 render worker)** — Task 20d runs every mpv core with
      `gpu-hwdec-interop=no` and maps `hwdec` to copy modes (`auto` → `nvdec-copy,vaapi-copy,auto-copy`),
      because interop init (a CUDA context per render context, 65–90 ms) and `vulkan-copy`'s device creation
      (230–320 ms without an X server) ran on the loop at every switch. Cost: 4K60 nvdec interop ~11 % of a
      core → nvdec-copy ~56 % (flake build); the copy upload also runs on the loop (8–13 ms at 4K60). Once
      render contexts live on the render worker, re-enable interop there. `player-core.md` § Sources
      "Hardware decoding".
      — done (2026-10-27): a worker render context loads the GPU's interop (`cuda` on NVIDIA, `vaapi` on
      AMD/Intel; libcuda preloaded for the dev binary) for a source whose `hwdec` would use it, `hwdec` maps to
      the zero-copy decoder + its copy twin; loop-rendered sources keep the copy modes. The init blocks its
      `lia-render` thread, so the worker runs three lanes (one froze the playing wallpaper 66–74 ms per switch).
      Measured (A/B interleaved, medians): 4K60 49.4 → 6.8 % of a core, 1080p30 7.8 → 3.2 %; loop busy per
      switch 0.7 → 0.3 ms, first frame 330 → 326 ms, A's longest frame interval 34.8 → 34.3 ms; +60 MiB VRAM per
      source. `LIASCAPE_PLAYER_HWDEC_INTEROP=off` = the old behaviour. Vulkan stays copy (no GL interop; the
      X-less driver lock is process-wide).
- [x] **8 h soak: does glibc's free heap plateau?** The final 1 h live soak (Task 20, `phase1.md` § 4)
      passed on RSS (0.31 MiB/min) but malloc's free bytes — already trimmed, not resident — grew ~4.1 MiB/min
      (arena address space +4.6 MiB/min, ~5.7 MiB per switch). Costs no RAM; the reaper's `malloc_trim` walks it
      (1.7 ms max now). Run `battery.sh soak --minutes 480`; if it doesn't plateau, consider fewer per-core
      threads or reusing cores across switches (the Lua scripts are gone since — 6 fewer threads and their
      Lua VMs per core; re-measure the free-heap growth first).
      **Answered 2026-11-03 — it plateaus** (`battery.sh soak --hermetic --minutes 420`, release; the PC crashed at
      ~01:10 for an unrelated reason, so 94 min / 95 samples, results `results/20261102T235106-soak-hermetic/`):
      malloc free bytes −0.03 MiB/min over min 5–95 (38.4 → 40.1 MiB, flat both halves; was +4.1 MiB/min),
      arena +0.04 MiB/min (100 → 107 MiB, 30 arenas), in use +0.07, RSS −0.5 (wobbling 300–545), VRAM back to its
      start (524 MiB). The Lua scripts' removal is the likely reason. No change needed; an 8 h run would only
      confirm.
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
- [x] **Adapter IT: the private-PipeWire auto-mute section flakes under load** (2026-11-03, 3 of ~8 runs while other
      agents' suites ran; each passed on a rerun) — **fixed (2026-11-03), harness only, no product bug.**
      Reproduced with `LIASCAPE_IT_ONLY=automute` (new: only this section, from the state the sections before leave)
      + `stress-ng --cpu 24` (load 23–37): **5 of 8 failed** before, **0 of 8** after. Causes:
      (a)+(b) one cause: the section's players ran `"$B"` (target/debug) while the backend starts `$T/bin/liascape-player`
      — a COPY since the upgrade test — so the (fresh, Task 8) backend read each as out of date and upgraded it in
      place within seconds (its 10 s check / the next switch: quit + its own `serve --restore`). `$SP` then named a
      supervisor long gone: the next `player_with_audio` "waited" on nothing, its `serve` met the upgraded player still
      quitting ("already running (pid …)" = the backend's), and `ctl` reached the dying one, then nobody (`bus:
      {state:null}`; 4 of 8). It also made the "env gate off" checks run on the upgraded player — without
      `LIASCAPE_PLAYER_AUTOMUTE=0`, the Signal on (they passed only because the backend's AudioMonitor lagged). The
      end-of-section `start_player am2` was upgraded the same way (so the engine-switch section's `$SP`/`$CP` checks
      looked at dead pids). Now every player the IT starts runs `$PBIN` (= `LIASCAPE_PLAYER_BIN`, current for the
      backend); `quit_player` quits whatever answers the socket, waits (≤ 60 s) for the supervisor `hello` names AND
      `$SP` to exit and the socket to answer nobody; `serve_player` waits (≤ 30 s) for a `hello` from ITS supervisor.
      (c) the daemons: a fixed 5 s for pipewire-0 / pulse/native socket FILES — now each daemon waits (≤ 30 s) on what
      the next needs (pipewire's core answers `pw-cli info 0`, WirePlumber's client is connected, `pactl info` answers),
      a daemon that exited says so; the bus waits ≤ 30 s. The `armed upgrade` precondition ("stale only 5 s", an
      earlier section): the 128 MB binary copy, a slow `/playlist/play` and four reads ran before L1's position read,
      L1 was 13 s into its 20 — now the copy is made before the play (`rebuild_prep`), the stale moment is the `mv`
      right after ONE position read, and the section plays a 30 s clip (LU; ≤ 13 s in is enough).
      A 4th, seen in the loop (1 of 8): "the app opened: leftover … alive=n, monitor.pid still there" — `serve` stops a
      leftover monitor-daemon after writing its port (a whole-tree kill, then the pid file), past a 5 s bound under load;
      now ≤ 30 s on all three. A 5th (1 of 8 before, 1 of 8 after the first fix): "a switch while auto-muted: … a:0" —
      the foreign paplay's audio stopped ARRIVING for > 300 ms mid-switch (`automute.unmuted` reason silence, 1.2 s into
      a 20 s stream), so the Signal rightly unmuted on the section's 300 ms unmute delay; that subsection (criterion 7:
      B's own gain when created) now runs with a 3 s unmute delay. Not a product bug (a starved stream IS silent), but
      the criterion-6 checks that hold a release across a playing stream could meet the same dropout — watch.
      Re-verified before commit: `LIASCAPE_IT_ONLY=automute` under `stress-ng --cpu 24` (load 22–28) 6 of 6 pass
      (64/0 each); one full run unloaded 404/0.
- [x] **Stale player after a rebuild/reinstall** — the player outlives the backend, so fixes "persisted" (a
      13:26 build ran at 19:00): the backend now restarts a stale player onto its binary with `--restore`
      (before a switch, or from a 10 s check while nothing is armed — player-adapter.md § Lifecycle).
- [x] **Two timer owners across a backend restart** (dotnet watch, app relaunch): switch storm every 1–16 s;
      the stopping backend now releases the timer first, a backend yields to a newer one, a superseded
      aligned switch re-arms instead of switching now (player.md § One timer owner).
- [x] **`bin/Debug/liascape-backend.runtimeconfig.json` vanished once** after the adapter IT's `dotnet build` ran
      next to the owner's `dotnet watch` (same `obj/`) — the next watch restart (`dotnet run --no-build`)
      can't start without it. A plain `dotnet build` brought it back; cause not pinned down.
      — root cause: `/home/kryxzort/Projects` is a symlink to `/mnt/CachyOS/@home/kryxzort/Projects`, and
      MSBuild's IncrementalClean compares `obj/…/FileListAbsolute.txt` by path STRING — a build through one
      spelling deletes the other spelling's entries, i.e. its own fresh outputs. Every script now roots at
      `pwd -P` and the test scripts run their backend from a verified snapshot of `bin/Debug` (c961518).
- Under "Speed storm leftovers":
  - [x] **Queue cap drops the NEWEST set** (`MaxQueueDepth`): for coalescible sets (`/preview`, a slider) the
        latest value is the one that matters — coalesce per target instead of refusing admission.
        — done: the queue is a pending list; a `QueueSet(key)` (target + property) replaces a still-pending one
        of its key since the last essential command (switch/stop/toggle = barriers, never dropped), so a burst
        holds one command per key and the newest always lands (self-test: 317 sets → depth 2, RED: 256 + the
        last ~60 dropped). Also fixed: `SwitchAndWait`'s own switch went through the droppable queue.
- Under "Speed storm leftovers":
  - [x] **`/preview` costs three round trips** (`get cur:*.path`, a full `state` for `SourcesFor`, the `set`)
        — fine at the UI's ~11/s, saturates the one worker at ~50/s. Cache the path → source ids per switch.
        — done: `SourceMap`, invalidated by our switches/stops/cancels and by the subscribed `transition.`/
        `player.stopped`/`source.retire` events (a foreign switch too), trusted only while events flow;
        1.0 request per preview value (self-test over 20; RED: 2.0).
- Under "Speed storm leftovers":
  - [x] **A speed-up inside the last D of an `align:end` wait** ends the effect after A (A holds its last
        frame, up to 0.5 s seen under random 0.25–4× drags): a fixed-length effect can't make up a start
        instant that moved into the past. Compress the effect's remaining progress to A's new end instead?
        Same for a global speed change mid-effect (it reaches A through `srcs:*`).
        — done: full-live `align:end` keeps ending with A (`Transitions::follow_a_end`): a speed-up before or
        during the effect compresses its remaining progress and both xfade ramps to A's new end
        (`Animator::compress_to`, continuous, same curves; ≥ 100 ms left; never stretched on a slow-down;
        an A already shorter than D keeps its designed hold). Drag storm −4.6…+10.8 ms vs A (RED ≤ +391);
        real libmpv `srcs:*.speed` 4× mid-effect: RED +892 ms → on A's end.
- Under "Speed storm leftovers":
  - [x] **Global speed slider has no live drag preview** (UI debounces `/settings` 250 ms; the per-card settings modal
        previews) and a no-op `POST /settings` costs ~150 ms in the backend — profile it.
        — done: the cost was the loudness backfill's library scan running synchronously on the request thread
        (and parsing index.json twice per item): 330–550 ms → median 8 ms with 300 items
        (`scripts/test-settings-latency.sh`); the global Volume/Speed sliders preview through a throttled
        `/preview {global:true}` (only wallpapers without their own override move; matrix `globalDrag*`).
- [x] **3184155462's mouse water much stronger than WE** (owner, 2026-11-06): cursorripple's force and decay count per
      frame, so its strength follows the frame rate (in WE too: refs at 30 vs 120 fps). The worker ran it once per tick
      — a throttled or late tick pushed several frames' force — and a pointer entering the output stroked a saturated
      line from where it left. Fork 0105 (`wp_project_set_frame_rate`: a simulation effect steps at the scene's rate,
      `ToWorker::Rate` = the outputs' demand, never the budget's cap) and 0106 (`wp_project_pointer_jump`, Wayland
      `enter` → `Pointer {jump}`); pin 1273652. Audit "Cursor ripple result". Guards host_api
      `simulation_steps_at_the_frame_rate`, `pointer_jump_is_no_move`, api `pointer_enter_is_a_jump_and_rate_is_the_demand`.
- [x] **WE's frame limiter, decoded** (2026-11-06): FUN_14006dd90's `clamp(round(1000/fps)·0.5, 6, 100)` is the audio
      capture thread's `Sleep`, not the limiter. The render loop (FUN_140141520) sleeps to `fps` frames a second and
      presents with `Present1(0, ALLOW_TEARING)` — no vsync — so WE runs at `fps` even above the refresh; default 15.
      Ours now ticks (and steps simulations) at `scene_fps` uncapped (`scene_rate`); default 15 in the player, backend
      and UI. Audit "Frame limiter and desktop pointer result". Guard api `scene_fps_is_wes_rate_above_the_refresh`.
- [x] **Pointer under windows** (audit C6, 2026-11-06): on Hyprland the player polls `cursorpos` (`lia-cursor`, at the
      scenes' rate, parked without scenes) and maps the desktop point into every scene like WE's `ScreenToClient`
      (unclamped, no jumps); elsewhere / on failure the surface pointer as before. Guard api
      `desktop_pointer_from_a_fake_hyprland`.

## Backend structure (2026-10-26, after the matrix's ~19 seam bugs)
- [x] **Shared state files written in place** (settings, playlist_state, index — torn reads, lost updates).
      — done: every shared state file goes through `AtomicFile` (temp + rename): settings, playlist state,
      saved playlists, every library index (+ one lock for every index read-modify-write, `UpdateIndex`), the
      timed-playlist state, `workshop_unsub.json`, legacy's `playlist_observer_paths.json`, the gui-timer /
      timer-daemon / restart-daemon / monitor pid files (a torn read = "no owner" → two timers) and
      `serve.port` (Electron reads it at launch). Left: `user_mute.state` (presence-only), the trash
      `.meta.json` (written once, read on undo), logs (append).
- [x] **Cross-process writers.** The locks are per process; the CLI (`--restore`'s WE sync, keybinds run locally
      when no backend answers) and the daemons can still race the backend on a read-modify-write. Either a
      file lock (`flock` on a sidecar) in `AtomicFile`/`LibraryStore`/`SettingsService`, or route every
      write through the running backend (keybinds already forward). Phase 3 retires the daemons.
      — done: `FileLock` (`<file>.lock` flock, inside the in-process locks) on settings + every index; every
      settings write is a field-level `Update`/`Patch` (`Save` private — 10 load→save sites converted). RED
      `scripts/test-cross-process.sh`: 16 concurrent local volume-ups → 5 (the step was computed from a load
      outside the lock) → 80, 3/3.
- [x] **One effective-settings resolver.** Each path picks its targets itself: `/settings` (`Set` +
      `SetPerItem`), keybinds (`AdjustVolume`), `/preview`, the per-switch reapply, normalization
      (`ApplyNormalizationAll`). Bugs from it: normalization on `cur:*` only, the srcs:* broadcast blip, the
      keybind override, mute while paused. Make one function: live sources (source map) × (global, item
      override) → each source's desired `gain.user`/`speed`/`af`/…, diffed against what it runs; every path
      calls it. Matrix cells to keep green: `set:*`, `appear:*`, `cli:volume-*`, `globalDrag*`, `itemVol*`.
      — done: `LiascapePlayerMedia.ResolveNow` (design note at the top of its code; player-adapter.md § Targeting):
      the live sources (cached map: source id → item path) × (global, item overrides + loudness, mute, a
      request's transient values) → each source's `gain.user`/`speed`/`af`/`no_audio`/`hwdec`/`fps_cap`/
      `cache`/`demuxer_*`/`gain.mute` (+ the layer `fit`), diffed against a fresh `state` (full passes) or the
      value cache (previews, overrides, mpv literals, mute), only what differs sent, per source. Every path
      goes through it: `/settings` (one pass for all of it), the volume keys, `/preview` (+ global),
      `ApplyOverrideLive`, normalization + a loudness landing, R81, mute; `SourceProps` uses the same
      `Desired`. Removed `SetPerItem`/`FixupPerItem`/`SetForPath`/`PreviewNow`/`PreviewGlobalNow`/
      `ApplySettingsLive`/`ApplyNormalizationAll`/`SourceMap`/`SourcesFor`/`SetEach` and `Set`'s gain branches.
      Adapter IT 115/0, settings-merge 53/0, self-test PASS (+ a no-op full pass = 1 request, another client's
      value put back), matrix targeted 343 pass / 9 fail+error+setup, all in two load clusters (load avg 50+:
      "UI marks [] as playing", a player `stop` timeout) — each passed alone 2× (one UI-not-found error on the
      second rerun passed a third time). Full matrix (`--jobs 2`, 30 min): pass=705 fail=2 (`single × itemVol:off`
      override not saved, `pending × seq:next+next` landed one item short) — both passed alone 2×.

## Next up (handoff 2026-10-26, weekly limit)
- [x] **Trash during a volume change** — a slider's persist (250 ms after release) or an `item`-mode volume key landing
      right AFTER the item is trashed: `SetMeta` creates the entry if missing → a ghost index entry for a trashed item
      (a later download with that key inherits it), and Undo restores the pre-drag volume. Add a matrix cell (RED
      first), then drop a save for an item that's gone (or write it into its trash record).
      — done: `race:saveAfterTrash` RED (a ghost `{"volume":55}` for the trashed k4) → `SetMeta` creates no entry for an
      item whose folder is gone; Undo restores its trashed entry. Affected cells (`--changed`) green; 4 transient
      fails (3× `paused × cli:volume-up*` with a blank UI page, 1× `muted × itemSpd:off`) passed 8/8 on rerun.
- [x] **`/playlist/state` binds the whole `CustomPlaylist`** — same hazard `/settings` had; merge like `SettingsService.Patch`.
      — done: `JsonMerge.Over` (nested `settings` merge by key). `plState:partial` RED (paths-only → settings at the C#
      defaults; settings-only → no paths) → GREEN; playlist families 173/0.
- [x] **The UI isn't told about another client's playlist edits** (a script/agent POSTs /playlist/state: the playlist bar
      stays stale and its next save writes itself back). Broadcast `playlist-changed` → `syncPlaylist()`.
      — done: `playlist-changed {client}` + `X-Liascape-Client` (own echo skipped); `plState:partial` RED (stale playlist bar) →
      GREEN, playlist families 196/0.
- [x] Zero-copy hwdec on the render worker (TODO item above) — optional. — done 2026-10-27.
- [x] Remove the leftover worktree `.claude/worktrees/agent-a2f6c6e0846e73e15` (only a node_modules symlink) — done.
- [x] **Rapid switches: "no first frame within 10 s"** (2026-10-27) — a paused B's only frame went unrendered
      past mpv's 200 ms VO flip timeout (loop busy: 8 switches + live sets in 300 ms, debug build) and mpv dropped
      it; a paused source has no next frame. `MpvSource::refetch_lost_frame` re-seeks to where it is after 300 ms
      (player-core.md § Sources). Matrix `race:settingsDuringApply` RED 4/4 → GREEN; repro 3/8 → 0/10.
- [x] **A crash restart can bring back the previous wallpaper** (found 2026-10-27 by the flake-hardening agent under
      IO load): the snapshot lagged a switch by 2.4 s (fsync under load), the supervised restart restored dee instead
      of `a`, and R81 re-applies only settings, never the wallpaper — the backend's model and the screen disagree.
      Fix idea: on `Restarted`, the adapter compares `cur:*.path` with what it switched to last and re-switches.
      — done 2026-10-28: `LiascapePlayerMedia.ReconcileShown` (queued by `OnRestarted` before the waits fail) cuts back to
      the backend's last shown switch (`_intent`; unknown after another client's switch → nothing); an armed aligned
      switch is saved by the snapshot as A where it plays and re-armed by `DoVideoEndWait` (it switched NOW before).
      Player-side ordering considered: a switch's reply can't wait for an fsync, so the backend closes the window.
      IT RED 5 → GREEN (a lagging snapshot via `LIASCAPE_PLAYER_TEST_SNAPSHOT_WRITE_MS`; a crash while armed).
- [x] **In-place upgrade fails under IO load**: the old compositor's clean quit took 3.1–3.3 s, `UpgradeInPlace`'s fixed
      3 s wait gave up, and the backend fell back to a plain `serve` without `--restore`/`--headless`. Wait on the
      supervisor's exit / socket instead of a fixed 3 s, and keep the args on the fallback.
      — done 2026-10-28: the old supervisor's exit for 10 s + 3 × its last snapshot write time (≤ 120 s) before any
      signal, the new pid's hello ≤ 30 s while it lives; `EnsureRunning` starts the last player's own arguments +
      `--restore`. IT RED 3 → GREEN (4 s snapshot writes; the supervisor killed).
- [x] **A 1-item timed session has no tick** (2026-10-27, from the fuzz-bug fix): `EnsureTimedTick` starts one only for
      > 1 item, so a next/prev/random queued in a 1-item session (or the restart daemon's "restart") is never taken —
      the tick discards it once one starts. Decide: tick for 1 item too (cheap), or consume the queue elsewhere.
      — done 2026-10-28: a tick for every timed session (the tick is the queue's one consumer — only the timer owner
      may switch; a second consumer would race it across processes); a 1-item session takes next/random (a switch to
      its one item) and `restart`, and never rotates by itself (`CanRotate`). Shared with legacy (its leak restart is
      now taken). Matrix `seq:plPlayOne+next|random` RED 2/2 → GREEN (session.md § Timed Playlist).
- [x] **"Library is empty" after a backend restart under the open app** (owner, 2026-10-28 13:11): a cherry-pick
      changed `api/client.ts` + the backend → Vite's HMR re-created the store and re-ran `init` while `dotnet watch`
      had the backend down; `init` failed (the library read became `[]`) and nothing ever re-read it. A plain restart
      under a production page left the library / playlist bar / settings stale too (whatever changed in the gap).
      — done 2026-10-28: `store.resync()` (one read of everything mirrored, each piece applied only when its read
      succeeded), `init` retries it while the backend is unreachable, every WS reopen re-runs it (`web-ui.md`).
      Matrix `restart:backend` (idle/playlist), `restart:midLibrary`, `restart:initDown` RED 4/4 → GREEN; the HMR
      incident itself (a scratch Vite probe: HMR during the restart → 0 cards before, 7 after).
- [x] **A rejected `af` silences the video** (owner 2026-11-06 21:35: "why is my current wallpaper silent" — right after
      setting the normalization target to 0): Settings let the target go −100…0 LUFS, but ffmpeg's `loudnorm` takes
      `I` in −70…−5 only, so `LoudnormAf` built a filter mpv rejected, and mpv then ran the video with **no audio at
      all** (`sources[].mpv_current_ao` null, no mpv stream on `liascape-player-bus`), not just un-normalized. A player
      restart (with the target back at −14) brought it back. Fixed the input: the UI bounds the target to −70…−5 and
      `LibraryService.LoudnormAf` clamps a stored value (2026-11-06). Left: the player should survive any bad `af`
      — on mpv refusing it, fall back to `""` (sound un-normalized), log a warning and report it (no silent
      no-AO state); add an IT check with an out-of-range target. (The bus bounce at 20:33 in the same evidence,
      `/tmp/claude-1000/-home-kryxzort/0bd18ed6-6839-4f58-85bd-fda200306755/scratchpad/silent-2137/`, was unrelated —
      audio worked after it.)
      — done 2026-11-06 night: the player survives any `af` mpv can't build. Root cause (reproduced on mpv 0.41): a
      filter mpv knows with an argument ffmpeg refuses passes mpv's option check, so the `af` set succeeds and only
      building the chain fails ("Audio filter initialized failed!"); at a file's audio init mpv then deselects the
      track ("Audio: no audio": `aid` reads `no`, `current-ao` unset) — the owner's silent video; on a live change it
      keeps the old chain but the bad value stays its `af` for the next rebuild (a re-route after a bus bounce). The
      mpv source now catches that log line, falls back to its chain without the user's filters (sound un-normalized),
      re-selects the track (`aid` no → auto: a plain `auto` is a no-op then) and reports a `Rejected` `af` with
      ffmpeg's reason → `source.rejected` (+ the path), `af_refused` in the `sources` probe, subscribed and logged by
      the backend ("player refused af on src…"). `read("af")` keeps the requested value and the same value again
      sends nothing (no rebuild per settings pass). Tests: `tests/sources.rs` `unbuildable_af_at_open_falls_back_with_audio`
      / `…_live_…` (RED without the fallback: ao None, aid "no"); adapter IT section "normalization: …" (a target of
      0 written into settings.json → loudnorm I=-5; an unbuildable af on the live source and on a new one → audio up,
      refused, logged by player and backend).

## Follow-up projects (each gets its own brainstorm)
- [x] **In-player auto-mute rework** — un-parked 2026-10-29 as Phase 3's optional last Task 14 (only if a strict
      upgrade; plus MPRIS mode hearing only the MPRIS player's own streams). Passed on the owner's machine and
      flipped 2026-11-02: the shipped auto-mute under liascape-player; `AudioMonitor` stays for legacy.
- [x] **Scene sound peaks (owner 2026-10-29, for a later REA batch):** WE's sound `volume²` is unclamped, so a slider
      above 1 pushes peaks over 0 dBFS (2375914945 at `musicvolume` 2 peaks at 2.04). Find out with REA what WE does at
      its output — clip, soft-clip or limit (`we-sound-semantics.md` only infers a clip at ±1; no master limiter was
      seen) — then decide: match it, or add a soft limiter on the player bus (normalisation lowers the level but can't
      undo a clipped peak). Loudness normalisation itself is unaffected by the squared curve: the learner and the
      estimator measure the real output. **Done 2026-11-05 (Leftovers batch):** WE hard-clips — mediaextensions64.dll's
      miniaudio runs its f32 clip loop (0x180029cb0, `noClip` off) over the summed output, after `volume²` and the
      wallpaper's level. Matched: the scene worker clamps its output to ±1 after the stream's own gain (WE's order, so a
      lower user gain or the normalization still leaves peaks whole). Audit "Leftovers result".
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "Real-WE references (goal pictures)" → "Work down `scene-we-ref.md` (the fixes are follow-ups; this only measured). The top real d":
  - [x] 3354740764's box and light shafts — done 2026-11-06 (fork `7797317`, `317bb73`). The box: an
        `alphatocoverage` layer with effects drew its last pass unblended; the mode is now its own, blended by
        alpha (WE's coverage at MSAA). The shafts: every particle sprite was drawn upside down (LWE's y-flipped
        particle space took WE's up as is), so asymmetric sprites — light shafts, here and in 1726902114 /
        2561227934 — rose from the ground instead of hanging from the sky. Fork tests
        `alphatocoverage_layer_with_effects`, `sprite_texture_stands_as_we`.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "Real-WE references (goal pictures)" → "Work down `scene-we-ref.md` (the fixes are follow-ups; this only measured). The top real d":
  - [x] 3354740764 "black at 0.5 s" and 2672425887 "intro 3 s slower" — not ours: the capture's time base.
        3354740764 opens with a black `fadeout` layer (0.6–1.6 s) WE draws too; the probe's t = 0 lands inside
        it. 2672425887's demon fades in at 2.07–2.6 s in both; WE's clock is 0.2–1.1 s ahead of t = 0, a different
        amount each run (4 runs; the 3D agent measured 0.25–0.9 s on 3276522107 / 3509243656). Ours at 2 s is
        0.07 s before the fade starts, which made it look like a 2 s vs 5 s gap at the 0.5 / 2 / 5 s samples.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "Real-WE references (goal pictures)" → "Work down `scene-we-ref.md` (the fixes are follow-ups; this only measured). The top real d":
  - [x] **The 3D scenes** — done 2026-11-06 (fork `867a5e7`, `5a42e7e`, patches 0108–0109; gap audit "3D scenes
        against WE"). 3276522107 isn't a lighting difference. Its lit train layer flashes on a 2 s alpha loop, and
        WE's scene clock is already 0.25–0.9 s along at its first frame (4 runs; seats match once aligned, rms ~2 of
        19). 3509243656's darkness was the FP16 swap chain capture; against the re-encoded reference only the same
        clock head start is left. 3477054430: a 3D scene's fog now reaches its image layers (WE's image flag 0x10 →
        a last `effectpassthrough_4` draw with FOG_COMPUTED; the moon 149 → 129.6, WE 129.5), 0.085 → 0.058. Found
        with it: a colour-blend layer took its colour and alpha twice (base and BLENDMODE draw; WE only the last).
        2371103399 0.071 → 0.013, 3309103316 0.141 → 0.136. Fork tests `fog_reaches_world_layers`,
        `blend_mode_layer_takes_its_colour_once`.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "Real-WE references (goal pictures)" → "The WE-reference time base: WE's scene clock is already 0.2–1.1 s along at the first frame":
  - [x] The "HDR at Ultra" look (3019192537, 3395587987; also 2542468435, 3509243656) — done 2026-11-06: the
        **references** were wrong, not ours. At Ultra WE presents those scenes through an FP16 (scRGB) swap
        chain holding lin () of the picture (decoded, GH 0x14015a0f0 / 0x140141520 / 0x1401afbf0). Windows
        sRGB-encodes it for an SDR display; DXVK on a surface without HDR colour spaces (gamescope's and
        wallpiper's alike) shows it raw, so too dark. `we-ref-capture.sh` re-encodes those frames
        (`we_ref_tool.py scrgb`, raw kept in `fp16-raw/`) and the 4 were recaptured: 3019192537 0.60 → 0.12,
        3395587987 0.48 → 0.08. `we-proton.md` "The FP16 swap chain". Ours at Ultra (default) matches the
        re-encoded Ultra frames, and ours with `WPENGINE_HDR=0` matches WE at `postprocessing=enabled`
        (0.5–0.8 / 255).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "Real-WE references (goal pictures)" → "The WE-reference time base: WE's scene clock is already 0.2–1.1 s along at the first frame":
  - [x] 2542468435 — done 2026-11-06 (fork "an HDR scene's image brightness scales its draw colour"): WE's
        draw colour is colour × brightness when the renderer runs HDR (GH 0x1402321d0); its layer's 1.15 never
        showed (gap audit E42). 0.48 → 0.09 from the re-encoded reference, → 0.02 with the fix.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "Real-WE references (goal pictures)":
  - [x] **Second reference via wallpiper** — done 2026-11-06, `docs/player/spikes/wallpiper-ref.md`. WE run
        as a desktop wallpaper by [wallpiper](https://github.com/ejalxndr/wallpiper) (pinned `6319fe3` + the
        `scripts/dev/wallpiper-scope-pids.patch`) in a headless sway, frames straight from WE's swapchain
        (`scripts/dev/we-ref-wallpiper.sh`, frames `docs/player/reports/we-ref-wallpiper/`, cross-check
        `scene_we_crosscheck.py`). 20 scenes: it agrees with the first set wherever nothing moves fast,
        including the Ultra HDR look; disagreements are timing, the clock, unseeded randomness, and the first
        set's pointer still easing in at 0.5 s. Video scenes crash the same way (`wallpaper64.exe+0x121a8d`).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "Real-WE references (goal pictures)":
  - [x] ~~Owner: which post-processing does Windows WE really use for 3019192537 / 3395587987?~~ Not needed
        (2026-11-06): neither tier is dark on Windows. Both Proton references are dark because DXVK shows WE's
        FP16 Ultra swap chain raw (wallpiper's layer reads DXVK's blit output too); re-encoded, Ultra matches ours
        by default and `enabled` matches ours with `WPENGINE_HDR=0` (see the HDR item above, `we-proton.md`).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches":
  - [x] **B1 Property scripts run.** quickjs-ng module namespace, not the Promise. Skip undefined returns,
        `init`, `thisLayer` per call. Load WE's `baseclasses.js` + jsmodules (S1–S7, S9, S33–S35, S38). 40 scenes,
        25 visibly broken today. M. **Done 2026-10-29:** fork patches 0019 (solid layers' uninitialised debug
        switch) + 0020 + 0021, pin `8902c4a`; WE's JS read at run time from the user's assets (never copied). Also S8,
        S22 done; S15, S24, S25, S29, S30 partly. Result + corpus delta: the audit's "B1 result" (§ 5).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches":
  - [x] **B2 Layer alpha/colour live + keyframe animations.** `g_Color4.w` = alpha, per-draw uniforms, a
        `c0..c2` bezier evaluator (E2, E3, G01, G02). ~50 scenes. M. **Done 2026-11-02:** fork patches 0022
        (live object uniforms, `g_Color4` = (colour, alpha)) + 0023 (keyframe animations, decoded from
        wallpaper64.exe), pin `d4969e4`. Left: `timeofday` (0 users), shared `parent`/`children` timelines (done 2026-11-05,
        0095: a child runs on its parent's clock, 5 scenes), events and the
        SceneScript animation API (`getAnimation`, play/stop — B10), G05. Result + corpus delta: the audit's
        "B2 result" (§ 5).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches":
  - [x] **B3 Particle core semantics.** `starttime` prewarm, shared colorrandom `t`, `exponent`, `rate`/`count`
        meaning, HSV `colorn`, sprite-sheet blend, live overrides (P1, P3–P8, P13, P14, P18, P19, P38). 61 scenes.
        M. **Done 2026-11-03:** fork patches 0024 (one scene RNG) + 0025 (initializers) + 0026 (prewarm, rate,
        count, live overrides, shared emitter timer — also P16, hide = reset) + 0027 (HSV `colorn`) + 0028
        (`SPRITESHEETBLEND`), pin `93438d4`. Smoke: particles at +1 s / +60 s went from 0.07–0.48 to 0.79–1.00 in
        8 of 10 scenes (the other 2 have a `starttime` shorter than their lifetimes, as in WE). Corpus ok 93 as
        B2 (2 load timeouts under another run's load, ok alone). Left: `SPRITESHEETBLENDNPOT`, the WE captures
        of 1797172968/1155728109. Result: the audit's "B3 result" (§ 5).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B4 Text renderer.":
  - [x] HarfBuzz shaping (ligatures, GPOS kerning; most of the width misses) and WE's own font fallback
        chain — done 2026-11-05 (fork patch 0091, pin `be51bf7`: WE's run split GH 0x1401da3c0, its 8-font chain
        0x1404c5030; 22 of 66 literal texts match the editor's saved size exactly, was 4). Left: T6/T7
        (background, outline, shadow, MSDF; 0 scenes); `anchor` for crop/letterbox (G32/C5).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches":
  - [x] **B5 Parallax + camera.** Delay smoothing (read as a bool → 14 of 25 frozen), a centred target,
        `g_ParallaxPosition`, `general.zoom`/fov, camera objects, shake (G10–G19, E1). 25 + 8 scenes. M. **Done
        2026-11-03:** fork patch 0029 (decoded camera update, per-object offset by the root's depth, zoom × the
        active camera object's, shake), pin `9f64193`; the worker keeps the pointer centred until the host sends
        one. Headless pointer: 3289734539 moves against the pointer and returns. Corpus ok 93 as B3. Left: E6 (the
        effect projection matrix), the camera-object pan and paths, text parallax (B4), WE captures (3516174947's
        zoom 0.75 now shows borders, per the decoded formula). Result: the audit's "B5 result" (§ 5).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches":
  - [x] **B6 Hierarchy.** A hidden parent hides its children; particle/text parent transforms (G03, G04, P36,
        G31). 12 + 19 scenes. S. **Done 2026-11-03:** fork patch 0030 (decoded "effectively visible", particle
        systems resolved under their parents every frame, aligned layers turn about their origin; also: an image
        hidden at load now shows when turned on), pin `602de79`. Corpus ok 93 as B5. Left: text parent transforms (B4), a
        sound under a hidden parent, G05; WE captures of 3243449890 (its "simple" character variant, drawn before
        under a hidden group, is gone) and 3490034653 (parented light beams now show). Result: the audit's "B6
        result" (§ 5).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B7 Blend modes / framebuffer.":
  - [x] 3426575339, 3432876246, 3556794116 smoke blank on every core incl. f383c4a. **Not a regression**
        (blank on d29b73c, 94cfc2e and in B5's smoke too): their main layer is a video texture, libmpv
        decodes it in real time, and the smoke ran 3 s of scene time in ~30 ms. The smoke now paces
        frames to the wall clock (`--unpaced` for the old run); all three render. The player was never
        affected. 3046119914 / 3432999904 ("black") were the same thing and render too. See the
        audit's "Blank-scene result".
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B7 Blend modes / framebuffer.":
  - [x] Re-check B7's 2883756643 blend modes now that its video layer shows in the smoke. **Done 2026-11-04**
        (paced, 5a365d4 vs f383c4a, two runs each): the cores differ on 81–83 % of pixels (run-to-run 0.4–0.9 %),
        the frame is brighter (pixels over 200: 30.6 → 35.6 %), the bokeh adds instead of tinting and the
        rim light glows; no seams or black blocks. Still looks right; a WE capture stays the check.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches":
  - [x] **B8 Audio response.** f32 stereo input, WE's band mapping, separate Left/Right,
        `engine.registerAudioBuffers`, audio-driven emitters (A1–A5, E8, S17, P20, P21). 41 scenes. M.
        **Done 2026-11-03 on the fork side** (patch 0045, pin `f383c4a`): 22 of 39 loading scenes respond to a
        synthetic tone; see the audit's "B8 result".
        - [x] Feed stereo — done 2026-11-05 (Leftovers batch, player side): SysMon mixes in stereo on the graph clock,
              each scene gets every frame in order (`Tick.input` = 48 kHz s16 stereo, protocol 5) and the worker
              pushes it through `wp_context_audio_input_push`; Left ≠ Right.
        - [x] Re-check the 17 audio scenes that didn't change with a 110 Hz tone — done 2026-11-05: with the stereo
              feed 37 of 41 react to a 110 Hz tone or white noise (the old snapshots spliced each analysis window);
              2290002190's audio was an instanceoverride script that never ran (fixed, 0094); 2388299037 and
              3509243656 have every default audio effect off (content); 3445973124's left-channel pulse doesn't move
              and isn't explained (a WE capture with music). Audit "Leftovers result".
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches":
  - [x] **B9 Small uniform/property/shader fixes.** `g_Frametime`, `g_PointerState`, `g_Daytime` (0 scenes read it),
        time wrap, annotation defaults, the foliagesway varying, live bloom, textinput quotes, usertextures (E4,
        E5, E9, E11, E17–E20, E36–E41, C1, C3, U1, U2, S18). ≤ 10 scenes each. S.
        **Done 2026-11-03** (all but E9, E11, E20, E38, E41): fork patches 0031 (engine uniforms) + 0032 (live,
        tinted bloom) + 0033 (annotation defaults; E18 is parity: WE skips malformed combos too) + 0034 (varyings:
        2189783622's foliagesway is back) + 0035 (textinput/combo values, the listing) + 0036 (usertexture →
        its scenetexture property), pin `94cfc2e`. Corpus ok 93 as B6. Left: E9 (its +0x74 writer still not found, also not via the RSSetViewports sites — 2026-11-05; E11 done 2026-11-05 in 0100, E20 in 0075, E38 in 0067), loading a user-picked picture, 3414858021's vertex units that
        don't write `gl_Position`. Result: the audit's "B9 result" (§ 5).
        **E41 done 2026-11-03** (fork patch 0037, pin `d29b73c`): an effect's `visible` (user property or script)
        turns it on/off live — built when it can be visible, the pass chain re-picked and retargeted on a change.
        Smoke: live flip = flip at load (0.00 % of pixels) on all 28 of the 33 scenes that load and draw; on
        94cfc2e the live flip did nothing. Left: `getEffect()` and media events for effect scripts (B10), the
        black 3046119914/3432999904. Result: the audit's "E41 result" (§ 5).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches":
  - [x] **B10 SceneScript API.** Cursor events, media events (MPRIS), `applyUserProperties`/`userProperties`,
        ISoundLayer `play()` (unblocks `startsilent`), `localStorage`, layer writes, missing engine/scene members
        (S8, S10–S37). 1–28 scenes each. M–L; needs B1.
        **Done 2026-11-03** (fork patches 0038–0044, pin `fd2fc72`): the layer/scene/engine API (getLayer by
        index for every type, getEffect, getTextureAnimation, getAnimation, sounds' play/stop/pause, sortLayer,
        canvasSize, userProperties, applyUserProperties on change, text scripts on the real layer), media events
        in full with the worker reading MPRIS (`media.rs`; the playing player, else the first paused one; https
        art via curl), cursor events (enter/leave/move to every solid image layer under the cursor, clicks to
        shown ones), persistent localStorage (`~/.local/state/liascape/scene-storage`). host_api_test 45/45;
        script errors over 20 scripted scenes 867 → 183. Left: S16 resize/animation events, S26 getVideoTexture /
        puppet layers / IMaterial, S37 createLayer/destroyLayer, cursor hit tests for text/particles and the
        camera zoom, S4's instanceoverride/maxwidth/brightness scripts; S17 registerAudioBuffers (B8) is now the
        commonest script error. 3414858021's date texts now leave the screen until text parents (G04, B4).
        Result: the audit's "B10 result" (§ 5).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B11 Particles, extended.":
  - [x] P29 sprite `orientation` — done 2026-11-04 (fork patch 0072: WE's g_Orientation* from
        GH 0x14024fd30; 3174556087's splashes follow WE's axes).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B11 Particles, extended.":
  - [x] P30 rope/trail combos — done 2026-11-05 as far as the library goes (0097): a segment is subdivision + 1
        pieces (WE's TRAILSUBDIVISION in genericropeparticle.geom); every library rope is ORIENTATION 0 and
        sets no TRAILSCROLL/FADE key. The CPU spline buffer is read too (2026-11-05, GH 0x140255e50): CP0 / CP1
        are the neighbouring particles, clamped to the segment's own ends, as in LWE's Catmull-Rom.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B11 Particles, extended.":
  - [x] P30 tangent factor — done 2026-11-05 (0102): a rope segment is WE's bezier with inner points 0.15 along
        the neighbours' chord (LWE's Catmull-Rom had 1/6). Rig + test: host_api_test
        `rope_spline_tangent_factor` (one fixed-origin emitter per particle).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B11 Particles, extended.":
  - [x] P27 mapsequencearoundcontrolpoint `bounds`/`limitbehavior`/`axis` — the 3 scenes use WE's defaults
        (GH 0x1401e8c90), which is what LWE does; other values are reported to the health report (0072).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B11 Particles, extended.":
  - [x] System flags bit 0 (world space, 16 scenes) — done 2026-11-05 (0092; "Worldspace" in the editor's
        strings, the carry inferred). WE's simplex (GH 0x14012c280) is Gustavson's on Perlin's permutation, the
        tables equal LWE's: nothing to port (0096 notes it).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B11 Particles, extended.":
  - [x] Read the fdt frame-time source (host +0x14c) and the child-instance alive test (GH 0x1402524c0) —
        done 2026-11-05, both confirm LWE's inference: the host is the render context, +0x14c its
        g_Frametime; alive = particles, live emitters or a live child (audit "Decode leftovers result").
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B12 Puppet warp.":
  - [x] Bone alpha (SKINNING_ALPHA), blend shapes (MDMP; MDLE turned out to be a copy of the bones' local
        matrices) — done in F3 (0079); GPU skinning for 3D models in F4 (0080; puppets stay CPU-posed);
        animation events in F7 (0077).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B12 Puppet warp.":
  - [x] IK (3042492564's arm, one bone) — done in F2 (0087): MDLS v2 targets + MDLA v2 target tracks decoded,
        the solver inferred (not found in the mixer).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B12 Puppet warp.":
  - [x] Read the attachment builder (the puppet image's vtable +0x78) and the additive scale — done
        2026-11-05: the additive scale is the position's rule (confirmed); the attachment is (bone matrix ·
        MDAT) · local (GH 0x14024b530).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B12 Puppet warp.":
  - [x] The whole attachment matrix — done 2026-11-05 (fork patch 0101, pin `5de0663`): the animator's +0x30
        is the posed bone world (GH 0x140243600), and LWE now applies bone · MDAT whole (2D: offset, z turn and
        the axes' scale; worldMatrixOf and the script matrices: the whole matrix). No library scene changes
        (every library bone / MDAT is unit scale). Audit "Attachment result".
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B13 HDR bloom + FBO formats":
  - [x] Find how `general.hdr` gates WE's renderer HDR flag 0x2000 — done 2026-11-05 (0098): `bloom` and
        `hdr` both literal JSON true in scene.json, then "postprocessing" `ultra` (GH 0x14013f860).
        2511663284 (hdr, no bloom) is LDR now, as in WE.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B13 HDR bloom + FBO formats":
  - [x] Why LWE's combine skips `lin ()` — settled 2026-11-06: WE's swap chain at Ultra is FP16 (scRGB),
        so its `lin ()` round-trips on Windows; LWE writing the composed picture into 8 bits is the same.
        Not an sRGB view (that was the inference). `we-proton.md` "The FP16 swap chain".
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B14 3D scenes.":
  - [x] Shadows (`_rt_shadowAtlas`), light cookies, tube and directional lights — done in F1 (fork patch
        0071, below).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "B14 3D scenes.":
  - [x] G20 perspectiveoverridefov, G21 `perspective` layers, G23 camerafade, camera paths, sortorder and WE's
        transparent sort key — done in F5 (fork patches 0082–0083, below).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "3414858021 (owner report): head gone, cursor trail y-inverted.":
  - [x] Locate WE's SceneScript angles binding — done 2026-11-05 as far as it goes: `angles` is the one
        script property with descriptor flag 4 (GH 0x14020dcc0), getAttachmentAngles returns degrees
        (GH 0x14020db20; constants at 0x1404d4460 / 0x1404d411c), WE's baseclasses.js is degrees throughout.
        The bridge's use of flag 4 itself wasn't located.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "Scene health report — pick fixes from it":
  - [x] script `thisLayer.getTransformMatrix()` not a function (5 scenes; + the `.x of undefined` that follows
        it, 7) — a missing ILayer API. Done in the coverage batch (0065, below).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "Scene health report — pick fixes from it":
  - [x] **Shaders WE accepts — done (2026-11-04, fork patches 0063–0064, pin `cbdf2fb`)**: WE's own shader path
        ported (includes in place, declarations hoisted as its cbuffers, fragment varyings typed by the vertex
        unit, its header macros) plus HLSL's conversions from glslang's errors; the earlier `auto_sway` / 左白巾
        vanish was the writable-varying copy filled only in the first of three `main`s. Cleared every shader
        row (C7011, M_PI, DOT, LEFT_PAREN, input, non-constant initializer, no return, l-value, boolean
        expression, #if tokens). Health: 75 → 79 clean, 21 → 17 degraded, 0 shader errors left, none worse.
        Shader sweep (`src/player/tests/onmachine/shader_sweep.py`, 4085 compiles of 124 stock + 272 library
        shaders): 313 → 47 failures, each explained in the audit's "Shader preprocessing result".
        WE's own `TEX<n>FORMAT` per bound texture: done 2026-11-04 (fork patch 0075,
        GH 0x1401d2a20). The stock shadow casters' `gl_ViewportIndex` write: done in F1 (one draw per
        viewport; sweep 47 → 16, the 10 caster checks left are SKINNING / MORPHING combos: fixed in F4, 0078).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "Scene health report — pick fixes from it":
  - [x] scripts: `getVideoTexture()` not a function (2), `.split()` on a non-string (2), `cannot set alignment /
        parallaxDepth of undefined` (2 each: createLayer), `.copy of undefined` (3), RegExp.$1 (1) — done in
        the coverage batch. Left (11), failing in WE too (content): see `we-coverage.md` § 1.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "Scene health report — pick fixes from it":
  - [x] user property type `Text` unsupported (3319542538) — done 2026-11-05 (0093: a value-less label like
        `text`). Also 0093: 3516106265's 24 `usershortcut` usertextures and 3042865984's `"default": ""` sampler
        are no missing assets (WE keeps the slot's texture). Health 86 → 89 clean, 10 → 7 degraded (the 7: the
        content script errors, re-checked against WE in the audit's "Leftovers result").
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "Scene preview compare — every scene against its author's preview":
  - [x] culling puppets culled whole (3490034653's, 3363252053's characters) — fork 0103.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "Scene preview compare — every scene against its author's preview":
  - [x] `thisLayer` / `thisObject` are the running script, as WE's accessors (3163060610's clocks) — fork 0104.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "Scene preview compare — every scene against its author's preview":
  - [x] 3163060610's clock text colour: by design — the preview's is auto-picked from a playing track's
        cover; without media the script uses `m_text_color` (ours).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "Scene preview compare — every scene against its author's preview":
  - [x] every row above 0.115 looked at (57 / 96, pin 77b9df7): no new render bug; the 39 unexamined score
        ≤ 0.115 (the clean band). See the audit's "The list worked down".
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "Scene preview compare — every scene against its author's preview":
  - [x] `mpv_source_teardown_never_skips_bus_cycles` fails alone on 3b17f00 and 7373be0 alike (2026-11-05,
        3 / 3 runs: a 64–256-sample exact-silence run as a V→V stream leaves) — re-check on a quiet machine.
        **Done 2026-11-05: the test's own PipeWire, not the player.** Not a regression (b94a111, the commit
        that added it, fails 3 / 8 alternated with 847bba4's 0 / 8; 5 / 26 unfixed runs overall, quiet).
        `pw-profiler` on the private server: every lost cycle was its *driver* skipping a period (position
        +128, `Dummy-Driver` + bus playback xrun) — `tests/common/pw.rs`'s daemon had no `module-rt`, so
        its data thread ran SCHED_OTHER nice 5 at the 1.33 ms quantum `/etc/pipewire/client.conf.d/
        99-lowlatency.conf` asks for. Fixed: module-rt (rtkit, `support.dbus = true`), as `scenes.sh`
        already had. After: 0 / 20 quiet, no exact-silence run at all; under 20 busy threads 38–90 runs
        per test unfixed vs 0–1 fixed. `LIASCAPE_TEST_PW_PROFILE=<dir>` on that test saves the profile.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "WE ↔ LWE gap audit → porting batches" → "WE coverage — the master gap list":
  - [x] F8 `resizeScreen` + `engine.screenResolution` + `cursorScreenPosition` in screen pixels (0076; the
        worker hints `max_size`), F9 (0072–0075: `alphawriting`, `fbos.fit/width/height/uvs`, `command: swap`,
        sprite `orientation`, mapsequence defaults, `TEX<n>FORMAT`), F7's MDLA animation events (0077) —
        done 2026-11-04, `we-coverage.md` "Implemented (0072–0077)".
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6":
  - [x] **Owner-run `--ab-legacy`** — DONE in the 2026-10-29 02:24 run (`scene-corpus.md` § A/B): legacy started 54/96, **0 start under legacy but not here**, 37 start here but not under legacy. (draws on a real output): `bash src/player/tests/onmachine/scene_corpus.sh
        --ab-legacy --legacy-output DP-1 --reuse /tmp/liascape-scene-corpus-<stamp>` (after `liascape kill`). Lists the
        scenes that start under the installed `linux-wallpaperengine` but not here (§11.5: newly failing vs legacy
        = 0, or each one below). Until then every non-ok scene counts as possibly newly failing.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6":
  - [x] **LWE: catch exceptions at the wp_* C API** (2026-10-28, fork patch 0015) — the C entry points already
        `try`/`catch`; the SIGABRT came from `JsonExtensions::optional`, which is `noexcept` and threw inside →
        `terminate`. A wrong-typed optional value is now absent/default + a log line. Corpus: 3233141951,
        3326873240 (broken → ok).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6":
  - [x] **LWE: text `padding` as a vec2 string** (2026-10-28) — upstream `main` #652, cherry-picked (0012):
        `padding` is a `vec2`, a number broadcasts. Corpus: 3233141951, 3326873240.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6":
  - [x] **LWE: CParticle segfault on embedded leaves presets** (2026-10-28) — not the leaves: both scenes' clock
        text objects carry `"particle": null`, dispatched to `parseParticle` → a particle without a material →
        null deref in `CParticle::CParticle`. Upstream `main` #692, cherry-picked (0014). Corpus: 1884904087,
        2047150134 (broken → ok, leaves and clock both drawn).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6":
  - [x] **LWE: 3D / perspective scenes** (2026-11-04, B14, fork patch 0056) — `Projection must have a width. Contents: null`: `general.
        orthogonalprojection` null + a perspective `camera {eye, center, up}`; next-v2 parses only 2D scenes.
        Corpus: 3276522107, 3477054430, 3509243656. Likely the biggest item (upstream may have work in flight).
        Gap audit B14 / G24 gives what each one needs (3276522107 has no meshes, so it is the cheapest).
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6":
  - [x] **LWE: case-insensitive asset lookup** (2026-10-28, fork patch 0016) — no exact match on any mountpoint →
        a case-insensitive one (pkg entries, a directory walked per component), logged `Found X as Y (case
        differs)`. Corpus: 3354740764 (load_failed → ok). Still open: log *which* file wasn't found on a real miss.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6":
  - [x] **LWE: an object whose effect fails to compile disappears** (2026-10-28, fork patch 0017) — the effect is
        left out (`Leaving out effect …`), the image renders. Corpus: 2189783622 (blank → ok); the same drops
        happened (unnoticed — other layers drew) in 3233141951, 3326873240, 3354740764. A passthrough/fullscreen
        layer (pure post-processing) still goes whole: rendering part of its chain blacked out 3432999904.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6":
  - [x] **LWE: the packaged shader that drops an effect in 2189783622** (2026-11-03, fork patch 0034) — it is **foliagesway**, not godrays
        (gap audit E19): its fragment reads `v_Bounds`, which only the vertex unit declares (under `MODE == 0`)
        (`'v_Bounds' : undeclared identifier`, `missing #endif`). WE compiles it, so it probably builds the
        fragment's inputs from the vertex unit's varyings. Fix: add the missing varying declarations to the fragment.
        This is batch B9 of the gap audit above.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6":
  - [x] **`ctl capture` still encodes on the loop** (2026-10-28, player-core.md § GFX / EGL "`capture` never
        stalls the loop"): the loop starts a PBO readback (~0.1 ms), `lia-capture` maps → encodes → writes, the
        reply is deferred until written (like `step`'s). Loop max busy around a 3840×1080 capture 810 ms (debug)
        → 0.07–0.10 ms per repeat (4.5–5 ms the first at a size: the driver pins the buffer); guard
        `tests/api.rs::capture_encodes_off_the_loop`.

## Closed during the split (2026-11-06)
- [x] Push `transitions-reveal`: `6f0433a` (cubic volume), `04533a8` (silence flicker) and the design + this TODO are
      not pushed. The `fork` remote is SSH and there's no key on this box; push via `gh auth git-credential` over HTTPS,
      or run `gh auth setup-git`.
      — done: both landed on lp-player rebased (`3e56063`, `ab8a40e`); closed 2026-11-06.
- [x] A player setting for WE's post-processing tier (`ultra` = today's default, `enabled` = LWE's
      `WPENGINE_HDR=0`, `disabled` = no bloom, not in LWE). Ours has no quality setting that maps to WE's
      presets, so scenes render as WE at Ultra; the owner's two main Windows profiles are
      Ultra. Only the 4 `bloom` + `hdr` scenes differ between `ultra` and `enabled` (their bloom chain).
      — not needed (2026-11-06): the owner's Windows WE runs its main profile at Ultra = our default.
- [x] WE capture of 3395587987 or 3019192537 at post-processing **Ultra** (owner).
      — done 2026-11-06: the HDR look was DXVK showing WE's FP16 swap chain raw; re-encoded references match ours (`fa67738`).
- [x] The references are MSAA x8 — the owner's main Windows profile is x8 too (an earlier note said x2, read from the
      Linux library's stale config copy); nothing to recapture. Closed 2026-11-06.
- Under "Scene compatibility programme (design §12 phase 6): import worthwhile upstream LWE PRs (#6" → "Real-WE references (goal pictures)":
  - [x] The WE-reference time base — done 2026-11-06 (`we-proton.md` "The scene clock"). Each frame's real scene
        time comes from WE itself: the capture opens a private copy of the scene with one more layer, a strip along
        the bottom edge that draws `g_Time` (ms, 24 bits) in clip space; `we_ref_tool.py clock-read` decodes it into
        each shot's `scene_time`. A capture-only test scene proved `g_Time` = `engine.runtime` = the frame's clock
        and that it runs at wall-clock rate; our worker draws the same strip at exactly the shot time. The compare
        renders ours at that time, crops the strip, runs ours at the capture's wall time (libfaketime) and with the
        Windows fonts. Whole corpus recaptured: mean score 0.119 → 0.072; 3509243656 0.261 → 0.053, 2783122117 0.562 → 0.014, 3593587273 0.499
        → 0.023, 2134765860 0.46 → 0.005, 2672425887 0.427 → 0.136, 3354740764 0.523 → 0.330, 3419466417 0.336 →
        0.077, 3490034653 0.414 → 0.289. 3354740764's notepad wrapping was the font (Inconsolata for Consolas).
