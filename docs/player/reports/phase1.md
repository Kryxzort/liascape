# liascape-player Phase 1 — on-machine battery report (Task 20)

Branch `liascape-player`. Battery run on `0569d28`; the four product fixes it found (§ 5) are on top —
final code `53c4ea8`, re-verified live: the 12 scene-skip cells (§ 1.3) and the 1 h soak (§ 4).
Battery script: `src/player/tests/onmachine/battery.sh`. Results:
`src/player/tests/onmachine/results/task20-final-run/` (main matrix + realism + extremes,
overnight 2026-10-23/24) + `task20-rerun-script-fixes/` (targeted re-run of `wait-for-end`/
`restore-replay` after the first round of script fixes) + `task20-rerun-restore-fix/`
(`restore-replay` re-run after the dev-build fix) + `20261024T102839-permonitor/` (after both
permonitor fixes) + the `outputs.sh` run (its own private session, no results dir) + the soak
run in §4.

## Pass criteria (brief)

- 0 drops and 0 micro_gaps (dropout detector), except silence the method itself intends.
- Frame present intervals within ±0.5 ms of refresh on both outputs.
- No `transition.failed` except injected ones (none were injected).
- Soak slope < 1 MiB/min after the first 5 min.

## Summary verdict

**Dropout / audio: PASS everywhere it was measured.** 0 drops, 0 micro_gaps in every one of the
43 overnight cells plus every re-run cell, including the per-monitor isolation check
(`dropout_available: true` throughout — lane B's detector is merged on this build). **No
unexpected `transition.failed`** anywhere, including the extremes block and realism cell.

**Frame pacing: PASS, via `outputs.sh` (§3) — matches `player-core.md`'s own measured numbers
exactly** (6.94/4.17 ms mean on DP-1/DP-2 for display-rate content, correct content-pacing for
ordinary video). `battery.sh`'s own per-switch frame check had two bugs (fixed, §1.1) and, even
fixed, cannot meaningfully re-validate this bar against arbitrary real video content —
`outputs.sh` is the authority for the brief's literal "±0.5 ms of refresh" criterion.

**Per-monitor isolation: PASS** (§2, two script bugs found + fixed first). **`outputs.sh`:
PASS** (§3, `RESULT: PASS`, incl. hotplug + crash→restart). **Soak: PASS** (§ 4, after the fixes).

**6 of 7 failure/bug families were battery-script bugs, now fixed and re-verified live:** the
frame check (§1.1, two bugs), `wait-for-end`'s timeout (§1.2), `restore-replay`'s binary
(§1.4), and permonitor's socket-priming + `cur:` query (§2, two bugs).

**4 real Phase-1 product findings — all fixed, reviewed and re-verified live (§ 5):** the
soak's RSS growth (§ 4, two causes: glibc arena retention, Task 20b; an NVIDIA egl-wayland2
event-queue leak, Task 20e), `/next`/`/prev`/`/random` crashing on a scene under `liascape-player`
(§ 1.3, Task 20c), and a 65–320 ms loop stall per switch from hwdec interop/`vulkan-copy` init
(Task 20d). **Final soak: PASS (0.31 MiB/min).** One deployment item for the owner: the
installed `liascape` NixOS package predates liascape-player entirely (§ 1.4) — rebuild with
`sudo nixos-rebuild switch --impure`.

## 1. Method × mode matrix

43 of 48 cells ran to completion in the overnight run (`task20-final-run/summary.json`); 18
cell-failure entries were recorded across 5 distinct mode families. Every failure was
individually investigated (live reproduction, `events.jsonl`/adapter-log evidence, `strace`, or
direct code reading) and falls into exactly one of these buckets.

### 1.1 `frame_violations` — two SCRIPT bugs, fixed

Every single switch in every cell of the overnight run showed `frames_ok: false`
(`frame_violations == switches` in all 43 reported cells). Two independent `evaluate_frames()`
bugs in `battery.sh` compounded into this:

**Bug A — `missed` required to be 0.** `ok` required BOTH the paced mean within ±0.5 ms of the
output's refresh period AND `missed == 0` for the `frames` probe's rolling 2 s window. Opening a
new source costs the loop ~1-26 ms synchronously (final-review I5 / `player-core.md` § Runtime
"Switch cost and the Phase 2 render worker": "one to five missed frames at 240 Hz on every
output per switch... Task 20's pacing criterion should exclude the switch frame") — the
`missed` count right after a switch is a *documented, accepted* cost, not a pacing defect.
Fix: `ok` no longer requires `missed == 0`; `missed` is still captured/reported per switch.

**Bug B — `.paced.mean_ms` read as a literal `0` instead of "no data yet".**
`probe_frames_raw()` is called the instant a switch reaches its terminal event — for most modes
(manual-next, timed-interval, every `fast-*`/`long-*` extremes cell...) that's *before* the
output has presented 2 consecutive frames within the probe's own 2 s window (`paced` =
"intervals between presents made back to back"), so `.paced` is `null`/absent and the script's
`// 0` fallback silently turned "no data" into "paced at 0 ms" — which then failed `within_tol`
by the *entire* expected refresh period, every time. Confirmed post-hoc: every non-
`wait-for-end` switch record checked in `task20-final-run/switches.jsonl` has `mean_ms: 0`
exactly (not some small-but-wrong value) — the signature of "no samples", not "bad pacing".
Fix: a `paced_count` field (`.paced.count // 0`) distinguishes the two; `within_tol` is now
vacuously true (not a violation) when there weren't enough samples to judge, flagged separately
as `insufficient` for visibility.

**What's left after both fixes is not a bug.** Once a switch *does* have enough real paced
samples — `wait-for-end`'s own clips, which keep playing 10-30 s between switches — `mean_ms`
correctly reflects the real SFW clips' own frame rate (24-25 fps measured, ~40 ms apart), not
the display's 144/240 Hz refresh, so those cells still show `frame_violations == switches` even
after the fix (§1.2's re-run: 8/8 on all three methods). `player-core.md`'s own "Frame pacing"
section documents this as *correct*, by-design content-paced behaviour (its measured "60 fps
test clip" row: "60.0 presents/s (content-paced, idle between frames)" — not a defect). The
brief's "±0.5 ms of refresh" bar is only meaningful for genuinely display-rate content (an
opacity/gain animation, or a high-fps clip), which is exactly what §3's `outputs.sh` checks with
its own dedicated synthetic 240 fps clip + opacity animation — `battery.sh`'s per-switch probe
on arbitrary real video content cannot re-validate that bar; `outputs.sh` is the authority for it.

Re-verified hermetically (`--hermetic --smoke`) after both fixes: `paced_count` now shows real
sample counts (84-116 in a 2 s window) instead of the phantom `mean_ms: 0`. Re-verified live on
the `wait-for-end` re-run (§1.2): `paced_count` 98-116 per switch, real `mean_ms` 17-57 ms
against a 6.9/4.2 ms expectation — the low-fps-content case above, not a regression.

Not re-run at full scale (48 cells) purely to refresh the `frame_violations` column — it never
gated cell pass/fail (R99's own criteria are the switch *outcome* — `handoff`/`cancelled`/
`failed`/`timeout` — never `frames_ok`), so the original matrix's pass/fail verdicts (§1.2-1.4)
are unaffected; only the `frame_violations` numbers in `task20-final-run/summary.json` should be
read as "not meaningful" rather than as 43 real pacing failures.

### 1.2 `wait-for-end` (full-live/reveal/frozen) — SCRIPT bug, fixed + re-verified

All three methods' `wait-for-end` cell failed their very first switch: `tr-136`/`tr-324`/
`tr-515`, "transition did not reach a terminal state". `events.jsonl` (state dir
`~/.local/state/liascape/liascape-player/events.jsonl`, which survives past the run since it isn't
rotated) shows what actually happened to all three:

```
transition.scheduled {align:"end", duration_ms:0, method:"full-live", ...}   -- at t0
transition.cancelled {reason:"cancelled"}                                     -- at t0 + ~15.5-16 s
```

— i.e. the switch was genuinely still in flight, correctly waiting on A's natural end
(`align:"end"`), when **the C# adapter's own backstop cancelled it** —
`LiascapePlayerMedia.SwitchAndWait`'s `AlignBackstopSlackSec` = 15 s (`.claude/rules/player-adapter.md`
§ `DoVideoEndWait`: "the aligned wait itself is bounded... behind the player's own 10 s
`align_fallback`"). The battery's own `term_timeout()` is `EFFECT_DURATION_MS/1000 + 10`
(12 s at the `--effect-ms 2000` the main matrix ran at) — correct for a plain cut/effect switch,
but irrelevant to how long a `wait-for-end` switch can legitimately take, which is bounded by
the real clip's own remaining play time, not the configured effect duration. The script simply
stopped watching (12 s) before either the player's own 10 s `align_fallback` or the adapter's
15 s backstop had a chance to resolve the transition — a SCRIPT bug, not a product one.

**Fix** (`battery.sh`): a `wait-for-end`-only `term_this` = `MAX_SHORT_VIDEO_MS/1000 + 30` (the
longest of the 3 real short clips this run picked, past both the player's and the adapter's own
bounds), used instead of `term_timeout()` for this mode only (`advance-on-end` keeps the plain
`term_timeout()` — its own interval always wins first, see §1.2a).

**Re-run** (`task20-rerun-script-fixes/`, `--switches 8 --effect-ms 2000`): **all three methods,
8/8 `handoff`, 0 cancellations, 0 drops, 0 micro_gaps.**

| cell | switches | handoff | cancelled | failed | drops | micro_gaps |
|---|---|---|---|---|---|---|
| full-live/wait-for-end | 8 | 8 | 0 | 0 | 0 | 0 |
| reveal/wait-for-end | 8 | 8 | 0 | 0 | 0 | 0 |
| frozen/wait-for-end | 8 | 8 | 0 | 0 | 0 | 0 |

The real mechanism resolves comfortably inside the corrected timeout once the script actually
waits for it — no product bug here at all, purely a script-side observation window that was
sized for the wrong quantity (effect duration instead of clip duration).

#### 1.2a Why `advance-on-end` (same code path) didn't show this

`advance-on-end` (`AdvanceOnVideoEnd=true`, `WaitForVideoEnd=false`, interval 8 s) arms the
*same* liascape-player `DoVideoEndWait`/`SwitchAndWait(alignEnd:true)` path — there's no
`liascape-player`-side branch on `WaitForVideoEnd` at all (`PlayerHelper.cs` ~line 1961). The
difference is `PlayerHelper.cs`'s playlist tick (~line 1032): with `_waitingForVideoEnd &&
!_waitForVideoEnd`, the tick's own interval elapsing calls `AdvanceAndLaunch()` directly,
superseding the pending aligned wait every time well before 12 s — which is exactly why
`task20-final-run`'s `advance-on-end` cells show a clean, consistent 25 handoff / 25 cancelled
split (every other switch cancelled by the *next* tick's own supersede, not a bug) and never
hit the term_timeout boundary at all.

### 1.3 `manual-next` / `manual-prev` / `random` / `next-mid-transition` — PRODUCT bug

12 cells across all 3 methods failed with "no new transition corr observed" (`manual-next`
idx 1 or 25, `manual-prev` idx 26 in every method, `random` idx 1 or 4, `next-mid-transition`
idx 13 in every method — no corr exists for any of these, so there's nothing for `ctl logs` to
show for the failure itself; the HTTP exchange below is the evidence of record instead).

**Root cause, reproduced live** (against the owner's real library, `PlayerEngine` switched to
`liascape-player`, `liascape-player-bus.playback` muted, legacy stopped first, state snapshotted and fully
restored and verified afterward — `playerEngine`/`autoMute` back to `legacy`/`true`, no
`liascape-player`/`mpvpaper` process left, default sink `easyeffects_sink` unchanged):

```
POST /apply {path: <workshop path for id 1098847996>}   -> 200
POST /next                                                -> 200  (landed on library[0], a video)
POST /next                                                -> 500  (landed on library[1] -- a SCENE)
POST /next                                                -> 500
POST /next                                                -> 500
```

`PlayerHelper.TryStepLibrary` (`src/backend/Helpers/PlayerHelper.cs:2378-2404`, used by
`/next`/`/prev`) and `ApplyRandom` (`:2547-2563`, used by `/random`) both step/pick from
`LibraryService.LoadAll()` **unfiltered** — scenes included — and call `Apply(pickPath, ...)`
(`:703`) unconditionally. `Apply()`'s own scene check (`:707-716`) is exactly right for a direct
`/apply` call from the UI: `if (IsScenePath(videoPath)) { if (PlayerEngine.IsLiascapePlayer) throw new
InvalidOperationException("Scenes need the Legacy player engine for now..."); ... }` — Phase 1's
documented design (`global-constraints.md`: "Under liascape-player in Phase 1, scene items are skipped
exactly like `AllowScenes=false`"). But `/next`, `/prev` and `/random`'s own route handlers
(`Web/ServerHost.cs:536-538`, thin wrappers with no try/catch) never catch this exception — it
propagates out of the ASP.NET minimal-API lambda as an unhandled 500, with **no transition ever
requested of liascape-player**. The owner's real library (300 items at the time of this investigation)
has scenes scattered roughly every 3-10 items (8 of the first 35 are scenes), so hitting one
within a few navigations is close to certain over 25-50 switches of `/next`/`/prev`/`/random`,
and `next-mid-transition` (two `/next` calls per logical switch) hits it at roughly half the
switch count of plain `manual-next` — consistent with its idx-13-vs-idx-25 boundary.

**This was a real Phase-1 gap, not a battery-script artifact**: `/next`/`/prev`/`/random` must
**skip** scene items under `liascape-player` (the same "skipped exactly like `AllowScenes=false`"
contract `Apply()` itself already half-implements for a *direct* apply), not crash the whole
switch.

**Fixed (Task 20c, `6eedd0c` "Backend: Skip Unplayable Scenes In Next/Prev/Random Under
liascape-player"):** `TryStepLibrary` steps past unplayable scenes in the same direction (bounded to
one library pass); `ApplyRandom` and the timed `RandomAndLaunch` drop them from the pool; an
all-scene library → HTTP 409 `{error: "No playable wallpaper…"}` (CLI: stderr + exit 1), the
playing wallpaper untouched. Legacy + `AllowScenes=false` 500'd the same way and is fixed too.
Hermetic IT `RESULT pass=77 fail=0` (20× each route over a mixed video/scene library + the
all-scene 409 path), self-test PASS.

**Live re-run** (`results/task20-rerun-scene-skip/`, `--effect-ms 2000`, the owner's real
library with its scenes, 2026-10-25 00:5x–01:5x): all 12 cells
{full-live, reveal, frozen} × {manual-next, manual-prev, random, next-mid-transition} —
**600 switches, 0 cells failed, 50/50 handoffs in every cell, 0 drops / 0 micro_gaps** in every
cell. `frame_violations` 0–25 per cell (switch-frame stalls — § 1.1; a concurrent hermetic
test lane loaded the machine during this run).

### 1.4 `restore-replay` — PACKAGING/DEPLOYMENT gap, script fixed to work around it

All 3 methods failed idx 1, "no new transition corr observed", every time — including on a
first re-run (`task20-rerun-script-fixes/`) after a first hypothesis turned out incomplete.
**Two-step live investigation, both via `strace -f -e trace=execve,...`:**

1. `restore_cli_invoke()` always used `command -v liascape` (`/usr/bin/liascape`, the owner's
   installed NixOS package). `strace`'d it directly: it execs through 4 wrapper layers down to
   `.../liascape-backend-0.1.0/lib/liascape-backend/liascape`, which then runs `setsid
   mpvpaper ...` — the **legacy** path — even though the already-running `serve` backend's own
   `PlayerEngine` is `liascape-player`. First hypothesis: a binary-resolution gap (the wrapper exports
   `LIASCAPE_TRANSITION_BIN`/`LIASCAPE_AUDIO_BIN` but not `LIASCAPE_PLAYER_BIN`, and doesn't bundle `liascape-player`
   next to itself) — tried exporting `LIASCAPE_PLAYER_BIN` into the one-shot process and `strace -v`
   confirmed the variable genuinely reached that exact process's own `execve` environment. **It
   made no difference — mpvpaper still launched.**
2. That ruled out binary resolution, so: `strings -el` (UTF-16, how .NET stores string literals)
   on the installed package's `liascape-backend.dll` for `"LIASCAPE_PLAYER_BIN"` / `"PlayerEngine"` —
   **zero matches, anywhere in the derivation.** The same search on this worktree's own dev build
   (`src/backend/bin/Debug/net10.0/liascape-backend.dll`, what `liascape-watch`/`dotnet watch`
   actually runs) finds both immediately. **The owner's installed `liascape` package is a stale
   build that predates `PlayerEngine`/liascape-player existing in the C# source at all** — not a
   resolvable-binary gap `LIASCAPE_PLAYER_BIN` could ever have fixed; the feature simply isn't compiled
   into that binary.

**Confirmed fix, live:** priming the session (`POST /apply`) then running
`$DOTNET $DLL restore` (the current dev build — the exact DLL `liascape-watch` already runs)
instead of the installed CLI produced a real `transition.scheduled`/`.handoff` immediately.

**Fix applied** (`battery.sh`, `restore_cli_invoke()`, live branch): use `"$DOTNET" "$DLL"
restore` (the dev build already resolved at the top of the script) instead of `command -v
liascape`. This is a battery-script workaround for testing purposes only — it does **not** fix
the underlying gap, which is that the owner's actually-installed `liascape` (what runs for
real, outside this test harness, for every one-shot CLI flag) has no liascape-player code in it at
all.

**Re-run** (`task20-rerun-restore-fix/`, `--switches 8 --effect-ms 2000`): **all three methods,
8/8 `handoff`, 0 cancelled/failed/timeout, 0 drops, 0 micro_gaps.**

| cell | switches | handoff | cancelled | failed | drops | micro_gaps |
|---|---|---|---|---|---|---|
| full-live/restore-replay | 8 | 8 | 0 | 0 | 0 | 0 |
| reveal/restore-replay | 8 | 8 | 0 | 0 | 0 | 0 |
| frozen/restore-replay | 8 | 8 | 0 | 0 | 0 | 0 |

(frame_violations after both §1.1 fixes: 0, 0, 3/8 — the last is real low-fps-content pacing,
§1.1's "what's left is not a bug".)

**Severity note for the owner:** while `liascape-player` is selected, the installed `liascape`
binary's one-shot commands (`restore`, `random`, `kill`, a keybind action) all silently run
legacy instead — including `restore` itself, used on every boot/session-resume. The
long-running `serve` backend (what the Electron UI actually talks to) is unaffected (it
resolves `liascape-player` fine via its own dev-tree path walk) — but the owner should rebuild/
reinstall the NixOS `liascape` package from this branch before relying on `liascape-player` day to
day, tracked in `docs/TODO.md`.

## 2. Per-monitor isolation (`permonitor`)

**Two script bugs found and fixed, then PASS on every check.**

- **Bug (socket never existed).** `run_permonitor()`'s `setup_live_backend()` only flips the
  `PlayerEngine` setting — `player-adapter.md`'s `EnsureRunning()` is explicit that "only a
  switch calls it — queries/sets never spawn." Without an actual HTTP switch first, no
  `liascape-player serve` process (and no socket) exists when the raw `ctl` calls that follow run, so
  every one of them failed with `io`/"can't connect to .../liascape-player.sock: No such file or
  directory". (`run_battery`'s own cells never hit this — every cell starts with a real
  `/apply`/`/playlist/play` HTTP call before touching `ctl`.) First attempt at a fix (prime with
  `/apply`, wait for the socket) surfaced a **second** bug: the priming apply is itself a
  `out:*` full-live transition at the live effect duration (15 s here) — without waiting for
  *that* transition to hand off too, the next step's raw `ctl create`/`ctl set
  lay:<out>:main.content` calls raced it and landed on the still-in-flight effect node (`fx1`
  on both outputs) instead of the two distinct per-output sources the check wants. Fixed:
  prime with `/apply`, wait for the socket, then wait for the priming transition's own
  `handoff`/terminal state before touching `ctl` at all.
- **Bug (`cur:<output>` queried bare).** The independent-sources and span checks read back
  `ctl get {"path":"cur:$OUT"}` with no property — `cur:` is a **node alias**, only valid as the
  node-id half of a `<node>.<prop>` path (e.g. `cur:DP-1.time_pos`); queried bare it's
  `no_such_prop` ("has no '.' separating node id from property name"), read back as `null` by
  the script's own `// empty` fallback, so both checks always "failed" regardless of what was
  actually on screen. Fixed: read `lay:<out>:main.content` directly instead (what the layer
  itself shows — exactly the node id these checks want to compare).

**Re-run, live, after both fixes** (`20261024T102839-permonitor/permonitor.json`):

- `OK: independent sources on DP-1 (src2) and DP-2 (src3)`
- `OK: out:DP-1-only transition (tr-3) handed off`
- `OK: DP-2 frames.missed unchanged (0) while DP-1 transitioned` — a transition confined to
  `out:DP-1` alone left DP-2's own frame pacing completely untouched.
- `OK: one source (src5) spans DP-1+DP-2` (complementary viewports).
- Bus meter (DP-2, the untouched side) stayed real and non-silent throughout (−40.8 dBFS median
  before the DP-1-only transition, −24.3 dBFS after, both well above the detector's −60 dBFS
  floor) — confirming the per-output isolation check wasn't just reading silence on both sides.

## 3. `outputs.sh`

**PASS** (`RESULT: PASS`, exit 0), release build, real DP-1 (144 Hz)/DP-2 (240 Hz), screens on
throughout (no DPMS handling needed, per this task's brief). Matches `player-core.md`'s own
measured "Frame pacing" table closely:

| check | DP-1 (144 Hz, want 6.9 ± 0.5 ms) | DP-2 (240 Hz, want 4.2 ± 0.5 ms) |
|---|---|---|
| opacity animation | mean 6.943, p95 7.599, max 8.276, count 288, missed 0 | mean 4.169, p95 4.518, max 5.365, count 480, missed 0 |
| 240 fps test clip | mean 6.945, p95 7.772, max 8.839, count 289, missed 0 | mean 4.169, p95 4.540, max 6.361, count 479, missed 1 |
| 60 fps test clip | 60.0 presents/s, content-paced | 60.0 presents/s, content-paced |
| static colour | idle, 0 presents/s | idle, 0 presents/s |
| mixed (60 fps clip on DP-1, colour on DP-2) | 64 presents/s | idle, 0 presents |
| mixed + opacity anim on DP-1's layer only | mean 6.943 (as above) | idle, 0 presents in 2 s |

Also verified: `hello.backend == wayland`; our namespace on the background layer; red/blue
centre pixels on `overlay`; pointer enter/motion/leave (`[960,540,0]` → `[100,200,0]`, 3
`input.pointer` events) then cursor/layer restored exactly; **hotplug** — `DP-1` disabled via
`hyprctl eval`, player stayed alive on `DP-2` alone, replugged with its exact recorded mode/
position/scale, `out:DP-1` back showing `cur:DP-2`'s content with its remembered `layer`
(`bottom`), pixel-verified, layout identical to the record; **crash → restart** — `kill -SEGV`
the compositor child, new compositor answered `hello` **152 ms** later, both outputs restored
(pixels verified, one covered by a notification popup — fell back to the documented ¼w/¾h
pixel), background layer re-verified. Final cleanup: monitor layout and workspaces restored
exactly, no `liascape-player` layer/process left, legacy `pgrep -x mpvpaper` empty throughout,
default sink (`easyeffects_sink`) unchanged. This run used its own private `liascape-player serve`
instance (own `XDG_RUNTIME_DIR`) and never touched the `serve` backend's `PlayerEngine`
setting at all.

## 4. Soak (1 h)

`battery.sh soak --minutes 60`, live: the owner's timed playlist `dp` (2 videos, wait-for-end,
transitions on), both outputs (DP-1 144 Hz, DP-2 240 Hz), the PipeWire bus on (the bus playback
muted), `HwDec=auto`, RSS/VRAM + malloc split sampled every 60 s; pass = slope < 1 MiB/min after
the first 5 min.

| run | code | switches | RSS slope | VRAM slope | verdict |
|---|---|---|---|---|---|
| 1 (`20261024T103029-soak`) | `0569d28` | — | **6.39 MiB/min** | 0.0006 | FAIL |
| 2 (`task20-final-soak-live`) | + Task 20b (`5e15356`) | 42 (0.71/min) | **1.61 MiB/min** | 0.08 | FAIL |
| 3 (`task20-final-soak-live2`) | + 20c/20d/20e (`53c4ea8`) | 42 (0.71/min) | **0.31 MiB/min** | 0.0 | **PASS** |

- **Run 1 → Task 20b:** glibc retention, not a leak — glibc raises its mmap threshold once the
  first mpv core frees its ~3 MiB frame buffers, so every later core's frame pools land in one
  of ~57 per-thread arenas, each keeping its freed peak (hermetic: RSS 159 → 922 MiB over 200
  switches with in-use flat at ~300). Fix: fixed `M_MMAP_THRESHOLD` 128 KiB + `malloc_trim(0)` on
  the reaper thread after each batch (`mem::apply_policy`, `memory` probe).
- **Run 2 → Task 20e:** the remaining growth was real in-use heap (72 → 165 MiB), per *present*
  not per switch (minutes without a switch grew as fast): NVIDIA egl-wayland2 1.0.2 queues one
  `wl_buffer.release` (~224 B) per present on a queue it never dispatches when explicit sync is
  on (fixed upstream after 1.0.2, unreleased). Fix: `__NV_DISABLE_EXPLICIT_SYNC=1` by default
  (caller's value wins) + dispatch libwayland's default queue every iteration
  (`player-core.md` § Wayland NVIDIA notes; cost: 240 Hz interval p95 ~4.7 → ~5.2 ms, 0 missed).
- **Run 3 (final, 2026-10-25 06:53–07:54):** RSS 424 → ~590 MiB in the first 5 min (warm-up:
  two 1080p60 decoders, 15 s effects), then flat 588–606 MiB for 55 min — slope **0.31 MiB/min**;
  malloc in-use (live) slope 0.05 MiB/min; `trim_ms_max` 1.74 ms; live hwdec `nvdec-copy`,
  `explicit_sync: policy, 1`. **Watch item:** glibc's *free* (already trimmed, not resident) heap
  still grows ~4.1 MiB/min (54 → 244 MiB; arena address space +4.6 MiB/min) — fragmentation
  of the per-thread arenas; it costs no RAM (RSS flat) but the reaper's trim walks it. An 8 h
  soak should show whether it plateaus (`docs/TODO.md`).

## 5. Product fixes found by this battery (Tasks 20b–20e)

| task | finding | fix | commit |
|---|---|---|---|
| 20b | soak RSS +6.4 MiB/min — glibc arena retention of freed mpv frame buffers | fixed mmap threshold + `malloc_trim` on the reaper; `memory` probe | `5e15356` |
| 20c | `/next` `/prev` `/random` HTTP 500 when the step lands on a scene under liascape-player (12 cells) | skip unplayable scenes; all-scene library → 409 | `6eedd0c` |
| 20d | `hwdec=auto` → `vulkan-copy` stalls the loop 230–320 ms per switch without an X server; a loadable libcuda → CUDA interop init 65–90 ms per switch even with `hwdec=no` | `gpu-hwdec-interop=no` + copy modes (`auto` → `nvdec-copy,vaapi-copy,auto-copy`); live now `nvdec-copy` | `68200f7` |
| 20e | live-only in-use heap +2 MiB/min — undispatched Wayland event queue (NVIDIA egl-wayland2 1.0.2, explicit sync) | explicit sync off by default + default-queue drain | `53c4ea8` |

Each was reviewed (20b: one fix round + scoped re-review; 20c/20d/20e: review fixes applied by
the controller) and its regression test added (`t20b_switch_loop_rss_stays_flat`,
`t20d_hwdec_switch_never_stalls_the_loop`, `t20e_wayland_present_heap_stays_flat` (opt-in),
the adapter IT's scene-skip block). **Trade-offs to know:** 20d gives up zero-copy decoding
until the Phase 2 render worker (4K60 nvdec interop ~11 % of a core → nvdec-copy ~56 %; the
dev build improves, vulkan-copy was ~80 %); 20e trades a little frame-time jitter for no leak
until egl-wayland2 > 1.0.2 ships. Both are in `docs/TODO.md`.

## Concerns / follow-ups

- **§1.4's packaging gap** means every one-shot CLI flag run via the *installed* `liascape`
  silently falls back to legacy whenever `liascape-player` is configured, because that package
  predates liascape-player's existence in the source entirely — not merely a missing env var. Needs a
  real rebuild/reinstall of the NixOS package from this branch (`docs/TODO.md`), not a flake
  code fix.
- **§1.3's scene-skip gap** needs a product fix (`TryStepLibrary`/`ApplyRandom` should filter
  `IsScene` items under `liascape-player`, or the routes should catch+retry past the `Apply()`
  exception) — tracked in `docs/TODO.md`.
- `docs/player/debugging.md`'s existing symptom table is audio-dropout-focused; neither §1.3 nor
  §1.4 fits that table's scope (they're backend/adapter/deployment issues, not audio glitches) —
  reported here and in `docs/TODO.md` instead of forced into that table.
- No explicit cap exists on concurrent `lia-open` worker threads (async mpv core opens, final
  review I5) — noted as a TODO item for a future hardening pass, not exercised by anything in
  this battery (every cell here opens sources well below any plausible concurrency ceiling).
- No `LIASCAPE_REQUIRE_GPU` test mode exists to make a GPU-less CI run fail loudly instead of silently
  skipping every GPU-dependent test (`tests/common::headless_gl` et al. already print `"SKIP: no
  EGL device"` and return) — noted as a TODO item; every run in this report had a real GPU, so it
  wasn't exercised either way.
- `check_mute_does_not_blind_meter()`'s warning ("meter median <= -60 dBFS while muted") fired on
  every live run in this report. Not a real issue: it runs right after the engine switch, before
  anything has actually been applied yet, so "nothing is playing" and "the mute is blinding the
  detector" are indistinguishable from that one early check alone. The permonitor run's own later
  meter readings (§2: −40.8 dBFS → −24.3 dBFS median across a real transition) directly prove the
  meter sees real, non-silent audio once something is actually playing — the dropout detector's 0
  drops/0 micro_gaps results throughout this report are genuine passes, not false ones from a
  blinded meter. Worth tightening the check's timing (run it after the first real `/apply`, not
  before) so it stops crying wolf, but not urgent enough to track as its own TODO item.
