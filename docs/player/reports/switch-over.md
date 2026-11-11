# Switch-over checklist — the design's §11 bar, measured

The design (`docs/superpowers/specs/2026-10-20-utopia-player-design.md` §11) says `PlayerEngine`'s default flips to
`liascape-player` and the legacy path is deleted (Phase 5) only when all of its criteria hold **on the owner's
machine**. This report turns each criterion into rows that can be checked, says how each is measured, and gives the
latest measured result with its evidence. Status: **pass** (measured, meets the bound), **fail** (measured, misses it
— with the fix or the plan), **owner-only** (needs the owner at the machine or their real outputs; the exact command
is in § 4).

Measured 2026-11-11 on the switch-over branch (lp-player `53859848` + the seam probe, the test hardening and the
fixes of § 3), release build, LWE pin `5cb69c7`. Machine: i9-12900K, RTX 3070 Ti (NVIDIA 595.84), Hyprland, DP-1
143.98 Hz + DP-2 239.76 Hz. The dropout runs drew on the **real outputs** through their own player (the owner's player
and backend stopped for each run and restored right after it) with the audio on a **private PipeWire** (own runtime
dir, one null sink): nothing reached the speakers. Two batches: the night battery (00:49–01:37, every cell, lp-player
`abdd0c60` — before the seam probe, with an independent recording of the sink) and three re-runs in the morning
(08:57–09:34, the cells it failed or never ran, with the seam probe) while the owner used the PC (load 12–25, one
I/O stall) — timing numbers are upper bounds. Raw results: `src/player/tests/onmachine/results/phase3-20261111T004919/`
and `results/switchover-1111/` (gitignored).

## 1. Summary

| Criterion | Status | In one line |
|---|---|---|
| 1 zero dropouts / seams, ≥ 50 switches per mode | **pass bar the frozen onsets** | 1075 switches over 15 cell × method modes (≥ 50 each): 0 real drops (the night's one was the detector — fixed), 0 seams in the 475 measured with the probe; 16 `frozen` micro-gaps of 2–10 ms, every one at B's onset after the effect's designed silence, which the sink recording can't tell apart from the unflagged onsets — whether they count is the owner's call (§ 5) |
| 2 full parity, every setting live | **pass** (2026-11-10) | adapter IT 415 / 0, UI matrix 832 + 6 load flakes that pass alone, backend self-test PASS; the by-eye pass is the owner's (§ 4) |
| 3 crash isolation + recovery | **pass, on older code** | 56 / 56 (Phase 2, 10-29) + 19 / 19 (Phase 3, 11-02); the scene worker changed a lot since (the WE port) — re-run before the flip (§ 4) |
| 4 8 h soak, flat RSS / VRAM | **not run** | longest so far 2 h (RSS +0.065 MiB/min, VRAM flat) and 1 h with scenes; needs an 8 h window (§ 4) |
| 4b auto-mute ≤ 100 ms | parked | not part of the bar (owner, 10-28) |
| 5 scene corpus no worse than LWE | **pass** | all 96 scenes build and draw on pin `5cb69c7` (89 clean / 7 degraded / 0 failed); legacy LWE starts 54 of 96, none that we don't |

**Recommendation: not yet.** Criterion 4 has never run at its length, criterion 3 was last measured before the WE
port, and the owner hasn't ruled on the frozen onsets. Nothing found tonight argues against the switch: no real
dropout, no seam, the one "late handoff" failure was the test.

## 2. The checklist

### Criterion 1 — zero dropouts and zero visible seams across the compose matrix (≥ 50 consecutive switches per mode)

"Dropout" = the built-in detector (`probe.dropout`, debug mode: the bus monitor against the gain schedule × the
decoded content; drops ≥ 35 dB under for ≥ 2 ms, 10 ms bins ≥ 15 dB under = `micro_gaps`). "Seam" = **the seam
probe**, new in this round (§ 3.1): a composed frame in which a source the visible layer points at had no texture
and was drawn transparent. Before it there was no on-machine seam measurement at all — only the headless invariant
test `handoff_no_seam`.

50 switches per cell and method, both outputs at once, the program choosing every switch (`programs.sh dropout`;
`manual` = the user's next / prev / random with a second next 0.4 s into every fifth effect). Seams: the morning
re-runs only (the night binary had no probe).

| Cell | Method | Done | Drops | Micro-gaps | Seams (runs / frames) | Handoff (full-live, `align: end`) |
|---|---|---:|---:|---:|---|---|
| timer 6 s (night) | full-live / reveal / frozen | 50 / 50 / 50 | 0 / 0 / 0 | 0 / 0 / 0 | — | — |
| on end, 4 s clips (night) | full-live / reveal / frozen | 50 / 50 / 50 | 0 / 0 / 0 | 0 / 0 / 0 | — | vs A's end ≤ 32.68 ms; vs A's last frame −0.65…+6.45 ms |
| on end + 3 s max (morning) | full-live / reveal / frozen | 50 / 50 / 50 | 0 / 0 / 0 | 0 / 0 / **1** | 0 / 0 / 0 | — (every switch is the maximum) |
| scenes S↔V (morning) | full-live / reveal / frozen | 50 / 50 / 50 | 0 / 0 / 0 | 0 / 0 / **3** | 0 / 0 / 0 | 13 on time: ≤ 32.75 ms, −0.13…+3.46 ms; 12 late B (≤ 577 ms late) started 0.0–3.5 ms after B's ready |
| manual next / prev / random + next mid-effect (morning) | full-live / reveal / frozen | 58 / 58 / 59 (+ 2 / 2 / 1 superseded, by design) | 0 / 0 / 0 | 0 / 0 / **3** | 0 / 0 / 0 | — (I↔V, S↔V, V→V, S→I, S→S) |

The 3 manual frozen micro-gaps are the same thing as the others: each sits at the previous switch's frozen
handoff (B's onset after the effect's silence), inside the next switch's pre-roll.

The night battery's scenes and maximum cells failed four checks; what they were:

- **scenes × full-live "handoff 971 ms late" — the test, not the player.** Every late one was a switch onto the
  3840×1080 Kimi scene (2371103399), which now takes ~2.5 s to build (warm `--lwe-smoke`: 2.35–2.78 s on every pin
  from 7bbd6de to 5cb69c7; the 11-03 pin 0.86–1.13 s, 10-28's 0.69 s — a real slowdown of the WE port, § 5). The cell
  gives B ~2 s (a 4 s clip minus the previous 1 s effect minus this 1 s effect). A B that isn't ready by the planned
  start starts at once and A holds its last frame for the difference — the design (`docs/player/modules/transitions.md` § Align). The
  report now tells such a switch apart (`b_late_*`) and checks it against that design; on the night's own events: 13 on
  time (≤ 32.64 ms, +0.7…+3.48 ms), 12 late started 0.0–3.9 ms after B's ready.
- **scenes × reveal, 1 drop — the detector.** tr-754 was the only end-aligned start more than 40 ms after A's
  `Ended` (88 ms: it waited for Kimi). The probe took the ended A's `time_pos` (its last frame) as "now" and expected
  its last sound inside the pre-roll. Fixed: `transition.started` places a long-ended A past its end
  (`recipes::transition` unit `started_snapshot_of_a_long_ended_a_is_past_its_end`, RED: 9.967 vs 10.150). In the
  morning run the case came back bigger (tr-102, B 2.46 s late): snapshot 6.46 s for the 4 s clip, 0 drops.
- **frozen micro-gaps (night: maximum 4, scenes 5; morning: 1 + 3).** All at B's onset, 1508–1514 ms into the window
  (the end of the 1 s effect's designed silence), 2–10 ms, 58–66 dB under. The night's independent recording of the
  sink shows the flagged onsets entering their 30 ms ramp no later than the unflagged ones: maximum cell, flagged
  −22.6 / −20.6 dB in the first 0.5 ms against an unflagged median of −18.1 (26 of 33 unflagged louder); scenes S→V
  −15.9 / −15.8 against −15.1 (7 of 15 louder). Every frozen onset starts a few ms into its ramp (B's sound reaches
  the bus a little after its gain starts rising); the detector flags the ones where that exceeds what its one
  whole-window lag absorbs. Phase 3 found the same (`phase3.md` § 1). Not an audible difference from the ~250
  frozen onsets it passed; the strict bound fails on them.

### Criterion 2 — full parity (design §10), every setting verified live on a playing wallpaper

Measured by the adapter IT (`scripts/test-liascape-player-adapter.sh`: the real backend over HTTP against a private
headless player, every check against the player's own state), the UI × player-state matrix
(`scripts/test-ui-matrix.sh`: the real UI in a headless Electron, every control × every player state, the oracle
reading every live source) and the backend self-test. Web wallpapers are not a parity item: **the legacy app never
plays them** — both scrapers drop `web` items (`WallpaperEngineScraper.cs:25`, `SteamWorkshopScraper.cs:205`), so
"web items stay hidden as today" (design §3) holds; Phase 4 (the web worker) is additive and the order of Phase 4 vs
Phase 5 is the owner's call (§ 5).

| Row | Result | When / evidence |
|---|---|---|
| backend adapter IT against a private headless player | **415 pass / 0 fail** | 2026-11-10 |
| UI × player-state matrix | **832 pass + 6 load flakes**, each passing alone | 2026-11-10, same run |
| backend self-test (`player-selftest`) | PASS | 2026-11-10 |
| web wallpapers | not a parity item | the legacy app never plays them (above) |
| every setting by eye on a playing wallpaper | owner-only | § 4 |

Not re-run on this branch: it changes no backend or UI code (the player side adds the seam probe and the snapshot fix,
both covered by the player suite).

### Criterion 3 — crash isolation proven (probe-verified), recovery works

| Row | Result | When / evidence |
|---|---|---|
| a crashing / hanging scene worker never changes the other output | **PASS 56 / 56** — 5 SIGKILLs + 2 hangs per scene, crash loop → broken; the other output's frame pacing p95 7.87–8.35 ms vs baseline 8.10–8.17, its tone 0 drops, the crashed side held its frame; recovery 0.12–0.25 s | `scenes.sh crash`, `phase2.md` § 3, 2026-10-29 |
| the compositor crashing mid-rotation comes back at its item | **PASS 19 / 19** — 5 SIGSEGVs, each back in ~1.1 s, all 3 start modes | `programs.sh crash`, `phase3.md` § 3, 2026-11-02 |
| the player suite's crash guards | pass (`program_survives_a_crash`, the worker-crash tests in `tests/scene.rs`) | this branch, 2026-11-11 |

Both on-machine runs predate the WE port of the scene worker (11-03 → 11-11); re-run them before the flip (§ 4).

### Criterion 4 — 8 h soak, flat RSS/VRAM, no stuck states (retires the restart daemon)

| Row | Result | When / evidence |
|---|---|---|
| 8 h mixed playlist, flat RSS / VRAM, no stuck state | **not run** | — |
| 2 h, videos + stills, the app closed | PASS 5 / 5: 238 switches, RSS +0.065 MiB/min, VRAM flat | `phase3.md` § 5, 2026-11-02 |
| 1 h with scenes | PASS 5 / 5: 116 switches, RSS +0.174 MiB/min after 10 min, ≤ 2 workers, per-worker VRAM identical over 19 plays | `phase2.md` § 7, 2026-10-29 |
| the legacy side it would retire | mpvpaper 1.9 on the desktop, 180 min: GPU memory flat, RSS ~+100 MB/h — the restart daemon (600 s) stays for legacy | `docs/TODO.md` "Legacy player", 2026-11-11 |

### Criterion 4b — auto-mute ≤ 100 ms

**Parked by the owner (2026-10-28)** — not part of the bar. (The in-player Signal shipped anyway, Phase 3 Task 14,
on-machine parity run `phase3.md` § 7.)

### Criterion 5 — scene corpus no worse than current LWE (same scenes start, none newly blank)

| Row | Result | When / evidence |
|---|---|---|
| every corpus scene builds and draws | **96 / 96** (89 clean, 7 degraded, 0 failed) | `scene-health.md`, pin `5cb69c7`, 2026-11-11 |
| none newly blank vs the legacy `linux-wallpaperengine` | **0 regressions**: legacy starts 54 of 96, none starts there but not here | `phase2.md` § 9, 2026-10-29 (legacy binary unchanged; the 3 scenes that failed here then build now) |

## 3. What this round changed

- **The seam probe** (new): `Composer::last_missing` → `frames` probe `totals.seam_frames` / `seam_runs` / `last_seam`,
  events `output.seam` / `output.seam_end`; per-cell `seams` in `programs.sh dropout`. Guards
  `tests/compose.rs::last_missing_names_every_hole_in_a_visible_layer`, `tests/api.rs::switches_never_compose_a_hole`.
- **Test hardening** for a loaded machine (14 files, 2026-11-05): waits that converge instead of racing, hang
  timeouts above a CPU-starved frame, diagnostics printed on a stalled rotation.
- **Late B is not a precision sample** (`programs_report.py` `b_late_*`, `programs_steps.sh` "late B: the effect
  starts as B becomes ready"); a video's path is classified before the folder test (a results dir named `scenes`
  made every clip a scene).
- **The dropout probe's ended A** (`Transitions::begin_running`): see C1.
- Player suite on the merge: 759 / 759 before the snapshot fix; with it 751 / 760 under load 12–25 (the owner at the
  PC, an I/O stall) — all 9 failures are timing tests and pass re-run alone at load 3 (two of them also flapped on the
  branch without the fix under the same load).

## 4. Owner-only runs — exact commands

**Waiting on owner** — what only you can judge or schedule:

1. **By eye: the switches on your outputs.** Play a mixed playlist with "Switch when video ends" and watch a few
   switches per method. In particular a short clip followed by a heavy scene: the clip holds its last frame until the
   scene is ready (up to ~2.5 s for Kimi now), then fades. Is that hold acceptable, or should the player prepare the
   next scene earlier / shorten the fade?
2. **By ear: the frozen onsets.** Switch with the "frozen" method a few times with sound on; the detector's
   micro-gaps sit in the first few ms of the new wallpaper's 30 ms fade-in from silence. If you hear nothing odd, the bar
   can treat them as passing (§ 5).
3. **Every setting live, by eye** (C2's last row): change volume, speed, mute, loop, fit and the rotation settings on
   a playing video and a playing scene from the app.
4. **The 8 h soak** (C4) — the PC is taken over for 8 h (the app closed, your player and backend stopped):
   `env -u LD_LIBRARY_PATH nix develop -c bash src/player/tests/onmachine/scenes.sh soak --minutes 480` (scenes in
   the mix), or `programs.sh soak --soak-minutes 480` (videos + stills). Overnight is the natural slot.
5. **Crash isolation on today's worker** (C3): `scenes.sh crash` (puts its surfaces on the overlay layer for a few
   seconds for its pixel checks) and `programs.sh crash` (~10 min together).

## 5. Decisions made here, and the owner's calls

Made here:
- A late B is judged against its design (start as it becomes ready, A holds) instead of the on-time bound.
- The ended-A snapshot is fixed in the player (`transition.started`), not worked around in the report.
- The frozen micro-gaps were not "fixed" by loosening the detector: the evidence is written up and the call is yours.

Yours:
- Count frozen-onset micro-gaps of ≤ 10 ms after the effect's silence as dropouts, or not (or ask for a per-onset lag
  in the detector, which would stop flagging them).
- The start-up seam: the seam probe's first live reading (your player, 04:49) counted 4 frames per output at start-up
  — the restored wallpaper's layer pointed at its source before its first frame. Nothing was on screen before it. Make
  the restore wait for the first frame like a switch's B does, or leave start-up out of the probe?
- Phase 4 (web wallpapers) before or after Phase 5 (the switch-over).
- Kimi's 0.7 s → 2.5 s build since the WE port: a profile and fix first, or later.
