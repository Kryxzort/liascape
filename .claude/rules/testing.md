---
paths:
  - "scripts/test-*.sh"
  - "scripts/test-fixtures/**"
  - "scripts/matrix-cells-for.sh"
  - "app/shell/probe-*.js"
  - "src/player/tests/**"
  - "src/backend/Player/LiascapePlayerSelfTest.cs"
  - "src/backend/Web/SteamSelfTest.cs"
---

# Writing, changing and fixing tests

Which suite covers what: `CLAUDE.md` § Verify your work. Probe and UI-matrix mechanics: `.claude/rules/ui/shell-and-probes.md`.
Hermetic setup (own HOME, backend, player, audio): `CLAUDE.md` § Hard rules.

## A check must be able to fail
- Show a new check RED before trusting it GREEN: run it on the code before the fix (`--ui-dir <older build>`, the
  previous commit in a `git worktree`, or the fix reverted locally). A check that never failed proves nothing.
- Guard against vacuous passes: when a cell can pass without exercising the behaviour (nothing switched, every random
  pick the same, the element off screen), detect it and fail with "… proved nothing". Make that guard right for every
  variant the cell runs (a resume-mode Play legitimately repeats the same item).
- Every new behaviour gets a guard; name it in the code comment above that behaviour (`Guard: <suite> <cell>`).

## Measure what the user sees
- Check the outcome, not a proxy: the arrow against the ring the eye compares, not the layout box; the frame count
  Chromium produced, not a timer's guess. A proxy drifts away from the look while the check stays green.
- When a visual's implementation changes (filter → box-shadow, an element becomes a pseudo-element), update its probe in
  the same commit; a probe still reading the old property fails for the wrong reason, or worse, passes.
- Set tolerances above the measurement's resolution: pixel reads are ±0.5 css px at any fractional position, timers jitter
  by a frame. Below that, the check fails or passes by where the layout happened to land.
- Express a smoothness budget in frames of the measured refresh rate, never a fixed 16 ms: the matrix's Xvfb runs at
  60 Hz, real monitors at 144–240 Hz (4.2 ms a frame). Sample the refresh first (a short rAF count), then judge.
- Measuring must not cause what it measures: a `requestAnimationFrame` meter forces a frame every refresh. Sample on
  demand, count callbacks, or read Chromium's own metrics (`Performance.getMetrics`, a trace).

## Performance: counts in the matrix, time on real hardware
- Gate performance in the UI matrix with refresh- and GPU-independent COUNTS (layers, forced layouts per frame, renders per
  interaction, rAF callbacks when idle): software GL on a 60 Hz Xvfb makes its milliseconds meaningless.
- Judge real smoothness with `scripts/bench-live-ui.mjs` on the running app: before and after a change, same scenario,
  same refresh rate, same build (Vite dev vs packaged), same tab. Report `overBudget` / `over2Frames`, not averages.
- Run both profiles: `--profile high` (this machine, its measured refresh) and `--profile typical` (CPU slowed 4×, judged at
  60 Hz — most users' screens on a weaker PC). A change that only helps one of them isn't done.

## Changing behaviour changes the test
- A deliberate behaviour change rewrites the old assertion to the new behaviour in the same commit; never delete it or
  loosen it into something that passes either way.
- Before changing a user-facing string, an error hint or a log line, grep the tests and probes for it: they assert on
  text (`tests/api.rs` hints, probe labels, `test-*.sh` output). Never trust "no test reads this" without the grep.
- A refactor must keep what an effect did on mount (an initial value, a first fetch); a test that only covers updates misses it.

## One heavy run at a time
- Every `scripts/test-*.sh` and `scripts/bench-live-ui.mjs` take the machine's test lock (`scripts/test-lock.sh`): a second
  run waits its turn and says who holds it. Run anything else heavy through it too: `bash scripts/test-lock.sh <command>`
  (`cargo test`, the on-machine batteries). Never work around it: overlapping runs make every count and timing meaningless.
- Give every one-off script you run under the lock (a CDP driver, a bench) its own overall timeout that exits the process:
  a page replaced by hot reload leaves its promises pending forever, and it holds the lock (the wrapper's ceiling is 90 min).
- A perf or count failure seen while the machine was loaded (`uptime`'s load above the core count) proves nothing: rerun it
  under the lock before reporting it.

## A red result
- Re-run only the failed cells, alone, on this tree AND on the previous build before deciding anything: fails on both =
  older than your change; fails only on yours = yours; passes alone = load flake (the matrix runs 6 shards).
- Find the cause before touching a threshold or a timeout. Never skip, delete or disable a failing check to get green.
- A failure that's real but not yours goes in `docs/TODO.md` with its cell name and cause; a cell whose expectation waits on
  an owner decision goes in `KNOWN` (`app/shell/probe-matrix.js`) with the reason, never silently.
- A mechanical change (comments, renames, moves) is proven by a mechanical check, not by tests alone: compare the
  comment-stripped code or the token stream before and after.
