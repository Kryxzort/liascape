# Phase 3 on-machine battery

Run 2026-11-01 to 02 on the owner's machine: Hyprland 0.57 (Lua config), NVIDIA, DP-1 143.98 Hz + DP-2 239.76 Hz,
the release build of `26efde8`. Script: `src/player/tests/onmachine/programs.sh` (+ `programs_steps.sh`,
`programs_report.py`). Every number comes from the player's own event file. Audio went to a private PipeWire, so
nothing reached the speakers.

Raw results: `src/player/tests/onmachine/results/phase3-night/` (gitignored).

## Summary

| Step | Result | Numbers |
|---|---|---|
| 1 dropout | **FAIL on micro-gaps only** (47/50) | 600 switches, 0 drops, 6 micro-gaps of 2–4 ms, all `frozen` (§ 1) |
| 2 app closed | PASS (14/14) | 1 h, 118 of 118 switches, no backend process, every keybind works |
| 3 crash and restore | PASS (19/19) | 5 SIGSEGVs, all back at their item in ~1.1 s; all 3 start modes correct |
| 4 cover | **FAIL on latency only** (21/24) | paused in 374–401 ms against a 350 ms bound; everything else correct (§ 4) |
| 4b no monitor | see § 4b | |
| 5 soak | PASS (5/5) | 2 h, 238 switches, RSS 0.065 MiB/min, VRAM flat |
| 6 owner checklist | **not run** | needs the owner (§ 6) |

## 1. Dropout across program switches

50 switches per cell on both outputs at once, the program choosing every switch (`origin: program:prog:main`).

| Cell | Method | Done | Analysed | Drops | Micro-gaps | Unmeasured |
|---|---|---|---|---|---:|---:|
| timer 6 s | full-live | 50 | 50 | 0 | 0 | 7 |
| timer 6 s | reveal | 50 | 50 | 0 | 0 | 3 |
| timer 6 s | frozen | 50 | 50 | 0 | 0 | 3 |
| on end, 4 s clips | full-live | 50 | 50 | 0 | 0 | 6 |
| on end, 4 s clips | reveal | 50 | 50 | 0 | 0 | 0 |
| on end, 4 s clips | frozen | 50 | 50 | 0 | **1** | 0 |
| on end + max 3 s, 10 s clips | full-live | 50 | 50 | 0 | 0 | 2 |
| on end + max 3 s, 10 s clips | reveal | 50 | 50 | 0 | 0 | 3 |
| on end + max 3 s, 10 s clips | frozen | 50 | 50 | 0 | **1** | 5 |
| separate timing 6 s, SFW scenes | full-live | 50 | 50 | 0 | 0 | 1 |
| separate timing 6 s, SFW scenes | reveal | 50 | 50 | 0 | 0 | 0 |
| separate timing 6 s, SFW scenes | frozen | 50 | 50 | 0 | **4** | 0 |

Worst model fit 1.53 dB (no cell with an insufficient fit). In the maximum cells each switch also shows one armed end
switch cancelled `superseded`, which is the designed path.

**Micro-gaps.** All 6 are `frozen`, 2–4 ms, 58–61 dB under, at `at_ms` 1506–1509, right at the handoff. 4 of them are
one direction, S→V from Emilia (4 of the 25 such switches). This matches Phase 2's finding F7, whose residual was
left open (`phase2.md` § F7). See `docs/TODO.md`.

**Handoff against A's end** (`align: end`, full-live; the plan's bound is "≤ 1 frame"):

| Cell | vs the nominal end (max / p95) | vs `source.ended` (max / p95) |
|---|---|---|
| on end | 33.0 / 32.9 ms | 19.7 / 18.4 ms |
| scenes | 32.9 / 32.8 ms | 19.2 / 18.3 ms |

The handoff lands about one **clip** frame (33.4 ms at 30 fps) before the nominal duration, which passes if "frame"
means a frame of the clip. It would fail if it means an output frame (6.95 ms at 144 Hz). The script checks the clip
reading, and I chose that reading: a clip's end is only known to its last frame. The owner can tighten it.
Under `reveal` and `frozen` the same numbers read ~971 ms, which is not an error: A's end is where those effects
*start*, so the handoff comes one 1 s effect later.

## 2. App closed

A 30 s timer over 3 clips + 1 image, backend gone before the hour began. 118 switches in 3600 s, spacing 30.26–30.41 s,
every origin the program's, 0 failed, 0 player restarts, no `liascape-backend` process. With no app, `next`, `previous`,
`random`, `toggle-pause` (both ways) and `volume down` all reached the player and each CLI exited.

The spacing is 30 s + ~0.3 s, because the timer counts from the commit and the commit waits for B to be ready.

## 3. Crash and restore

`kill -SEGV` of the compositor while the private backend stayed up:

| Crash | Back in | Item | Played before → after | Next |
|---|---|---|---|---|
| timer 1 | 1.12 s | same | 2266 → 1873 ms | timer commit, no re-play |
| timer 2 | 1.12 s | same | 2196 → 1874 ms | timer commit, no re-play |
| timer 3 | 1.14 s | same | 2275 → 1860 ms | timer commit, no re-play |
| armed 1 | 1.15 s | same | 1733 → 1871 ms | re-armed, 0 `align: now`, ended at the clip's end |
| armed 2 | 1.12 s | same | 1746 → 1859 ms | re-armed, 0 `align: now`, ended at the clip's end |

Play time after a restart reads ~1.87 s in all five, including where it had been ~2.2 s. The kills came ~2 s after a
commit, so this is probably the first 2 s snapshot being the saved value. It loses at most the 2 s refresh, within the
design.

`ctl quit` + `liascape restore`:

| Start mode | Result |
|---|---|
| Start over, sequential | index 0 (was on 2); the old item's source never created |
| Start over, shuffle | a different first item; the old item's source never created |
| Resume | same item, `resumed: true`, position 2.33 → 3.63 s (read ~1 s after the restore) |

## 4. Cover

8 s timer, default settings (no `PauseWhenCovered` key, so `player.pause_when_covered` reads `maximized`).

| Window on both outputs | Paused after mapped | Compositor CPU | Rotation while covered |
|---|---|---|---|
| kitty fullscreen | **401 ms** | 18.4 → 7.4 % | 0 commits in 12 s, remaining unchanged |
| mpv fullscreen | **386 ms** | 18.4 → 9.4 % | 0 commits in 12 s, remaining unchanged |
| kitty maximized (default) | **374 ms** | 18.4 → 6.8 % | 0 commits in 12 s, remaining unchanged |

Compositor GPU 4.4 → 0.0 % in all three. Every source paused with its `time_pos` still, all released on uncover and
the rotation went on. One output covered: no hold, keeps playing and rotating.

**Latency miss.** All three miss the 350 ms bound by 24–51 ms; a dry run read 364–400 ms. `COVER_ENGAGE_MS` is 300 ms
on its own and the event batch waits 30 ms, leaving 20 ms for Hyprland's event, the query and a tick. The time is
measured from when the script saw the second window mapped, so it can read up to 25 ms short, not long. Not fixed:
this is a deliberate debounce, and a pause 50 ms later is not visible. The owner decides between 250 ms of debounce
and a 400 ms bound (`docs/TODO.md`).

**Test script bugs fixed before the run:** the private runtime path made Hyprland's socket path longer than a Unix
socket allows, so the cover source was unavailable. The player reported this correctly (`cover.ok: false` with the
reason), and a shorter scratch path fixed it. A `jq` `// true` default also treated `false` as missing.

## 4b. No monitor

NOMONITOR_RESULTS

## 5. Soak

2 h, app closed: 3 clips, 2 images, 2 SFW scenes, 30 s timer, the method rotating through all three.

| Check | Value | Bound |
|---|---|---|
| Compositor RSS slope (after 15 min) | 0.065 MiB/min (331 → 357 MiB) | ≤ 0.5 |
| VRAM, median at start → end | 169 → 170.5 MiB (range 115–677 with what plays) | ± 10 % |
| Workers | max 1 at the per-minute samples | ≤ 2 + dying |
| `programs` history | max 100 | ≤ 100 |
| Rotation | 238 commits, 0 failed, 0 restarts | ≥ 233 |

Spacing 30.23–31.17 s, median 30.29 s. The worker count is sampled once a minute, so it says little about the moment
of a switch.

## 6. Owner checklist, not automated

1. Cold boot via `claude-reboot` with a timer program: restored at its item per its start mode and rotating, before
   and without opening the app.
2. Suspend and resume during a timer rotation: no catch-up switch (plan Review Focus 5).
3. A VT switch.

## Findings

Fixed: none in the player or backend; only the two script bugs above.

Open, in `docs/TODO.md`:

- F1: `frozen` micro-gaps at the handoff, 6 in 150 frozen switches (§ 1).
- F2: pause when covered takes 374–401 ms against 350 ms (§ 4).
- F3: the "≤ 1 frame" handoff bound is ambiguous (§ 1).
