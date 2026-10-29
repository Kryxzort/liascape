# liascape-player — Phase 3 (Programs and Signals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rotation runs inside `liascape-player`, with the same rules users see today: timed playlists, "Switch when video ends" with a minimum and maximum play time, "Separate timing for scenes", shuffle, history (next/previous), random and restore. A new Signal pauses the wallpaper when a window covers it. The backend no longer needs its timer daemon, restart daemon, `pending_action.txt` or the `timer.pid`/`gui_timer.pid` ownership: under `PlayerEngine=liascape-player` it starts none of them. Rotation keeps going with the app closed, survives a player crash, and stays the same for the UI.

**Architecture:** A rotation is a graph node, `prog:<name>` (kind `program`). Its settings are ordinary live properties, so a `set` reaches the running rotation the same way every other setting does. Its items carry their source create props. A recipe next to the transition recipe, `recipes/program/`, reads the node and the events. On the player clock it decides when to request a `transition` on the program's outputs, and with which item and effect. It never renders and never touches a source. The backend keeps the library, the settings and the R61 resolver. It turns a playlist into a program spec, sends user switches as four thin verbs, and mirrors what plays from the program's events. Pause-when-covered is a Signal: `out:<c>.covered` is observed from wlr-foreign-toplevel. A rule turns it into a player-level hold, composed the same way as the Phase 2 low-VRAM hold, so invariant #7's pause machinery covers it unchanged.

**Tech Stack:** Rust 1.96 (edition 2024, the `liascape-player` crate) · smithay-client-toolkit 0.21 (+ `wayland-protocols-wlr` `zwlr_foreign_toplevel_manager_v1` v3) · C# .NET 10 (adapter) · React (one Settings row) · the existing hermetic scripts.

**Spec:** `docs/superpowers/specs/2026-10-20-utopia-player-design.md`: §4.2 Program/Signal/Clock rows, §4.3 recipes ("Video-end-aligned advance", "Pause when fullscreen"), §4.4 (the backend's role), §10 parity (modes, keybinds, compose matrix), §11 bar, §12 item 3. What exists already: `.claude/rules/player-core.md` (§ Graph, § Transition recipe, § Runtime, § Command API, § Supervisor, § Snapshot), `.claude/rules/player-adapter.md` (§ Dispatch points, § Rotation, § Reconnection, § Lifecycle), `.claude/rules/session.md` § Timed Playlist, `.claude/rules/player.md` § Centralized Helpers / § One timer owner / § Restart Daemon. Executors read all of these. The C# code being ported is the reference for every rule this plan names: `src/backend/Helpers/PlayerHelper.cs` (`Tick`, `ItemPlayRule`, `HoldForMinPlay`, `AdvanceToNext`, `RandomAndLaunch`, `StepBackAndLaunch`, `ReorderPlaylist`, `UpdateTimedSettings`, `PostSwitch`, `DispatchPendingAction`) and `TransitionService.PickEffect/PickDuration/Pick`.

---

## Decisions

**Owner decisions this plan rests on** (stated before 2026-10-29):
- Phase 3 scope is spec §12 item 3. **The in-player auto-mute Signal is PARKED** (2026-10-28): `AudioMonitor` stays as it is, for both engines.
- The owner uses the `liascape-player` engine only. The legacy engine may break, and no work goes into it. Phase 5 deletes it, this phase does not.
- The rotation model (2026-10-28, `player-adapter.md` § Rotation) is the contract, kept exactly. It is listed verbatim under Global Constraints.
- `StayPausedWhenSwitching` (2026-10-25). Off: a user switch while paused resumes and then switches. On: the pause stays and the switch is a cut to B's first frame, paused.
- A broken scene playing in a rotation advances to the next item at once (Phase 2, round 2). A crashed scene is skipped unless whitelisted (D6).
- No migration code (the owner is the only user). Settings apply live. Features must compose.

**Designer calls (my call; the owner can override any of them):**
1. **One node, one recipe.** `prog:<name>` holds every setting as a live property. `create`/`set`/`get`/`destroy` are the generic verbs. `program.play|next|prev|random` are thin recipes over `transition` (spec §4.2). The backend uses one program, `prog:main` on `out:*`, for every rotation session: timed, advance-on-end, and Play All with more than one item. **A single applied wallpaper stays a plain `transition`.** Next/previous/random on a single wallpaper stay the backend's library step (`TryStepLibrary`, `ApplyRandomNow`), because they need the library order.
2. **Settings stay the backend's.** The program holds `defaults` (the globals' desired source props) and per-item `props` (only where an item differs: overrides, `af`, `gain.normalize`, `scene_props`, `kind`, `preview`, `loudness_seed`). B's create props = `defaults` with the item's `props` merged over them, shallowly. That merge *is* "override ?? global", and the player does not know it: R61 (`LiascapePlayerMedia.Desired`) stays the one authority, and it now also writes `defaults` and the item props.
3. **The rotation's clock is the player clock** (`Runtime::now`, pause-excised). Play time and the countdown stop when the picture stops: during a user pause, the low-VRAM hold, the cover hold, and while no output shows the program's item (parked). The last one changes today's behaviour: the backend's tick kept rotating invisibly while every output was gone. See Q2.
4. **The program persists across player restarts.** Its configuration and order go in `<state>/program.json`, written only when they change. Its dynamic state (cursor, history, play time, countdown) goes in `snapshot.json`. A restarted player resumes the program and re-arms an end-of-video switch by itself. `liascape restore` with `ResumeFromLast` on starts `serve --restore`: the same item, at the saved position and play time (see Q4). With it off, or with no saved state, it replays `LastSession` from the top, as today.
5. **The daemons, under `liascape-player`:** `timer-daemon`, `restart-daemon`, `pending_action.txt`, `timer.pid`, `gui_timer.pid` and `timed_state.json` are never started, written or read. Their code stays for legacy until Phase 5 deletes it. Every `PlayerHelper` entry point that reaches them gets an `IsLiascapePlayer` dispatch at the top, the existing pattern. **`monitor-daemon` stays**: it *is* the parked auto-mute (`AudioMonitor` running with the app closed). See Q3.
6. **What the backend must persist while it is away goes into a player outbox.** These are facts that the timer daemon stored as a backend process: `source.broken` (→ `MarkCrashed`), `scene.loudness` (→ the index), `scene.vram_exceeded` (UI text only). `<state>/outbox.jsonl` is append-only, bounded and acked. The backend drains it on every (re)subscription.
7. **The effect pick moves into the player** (`recipes/program/pick.rs`) with today's rules. Sequential cycles through the enabled set; shuffle never repeats the last effect. The duration is uniform in `[duration_ms, duration_max_ms]`, and 0 ms is a cut. The method comes from the program's `transition.method`, and the params are the catalogue's uniform defaults (as `TransitionService.Pick` sends them).
8. **Failures never spin.** A switch that fails (B errors, or is not ready in 10 s) backs off 1 s, 2 s, 4 s … up to 30 s while failures continue in a row; a handoff resets the backoff. After the backoff the program switches, `align: now`, to the next playable item after the failed one. When nothing is playable it logs `program.empty` once and holds what is shown.
9. **Pause-when-covered:** a toplevel that is activated, not minimized, and in the fullscreen state (or maximized, depending on the mode) on an output covers that output. The hold engages when *every* output showing the program's content (or, with no program, any content) is covered for `COVER_ENGAGE_MS` = 300 ms, and releases at once. With the same wallpaper on every output, a game fullscreen on one monitor leaves the wallpaper playing on the other (it is still visible, and audio follows the picture). New setting `PauseWhenCovered` = `off` | `fullscreen` | `maximized`, default `off` (Q1).
10. **Engine switch away from `liascape-player`** replays `LastSession` from the top on legacy. Nothing more is spent there. Legacy → `liascape-player` loads the program from `timed_state.json` at the item it was on (a cheap read of a file legacy already writes).

---

## Open questions for the owner

Each has a recommendation. The tasks implement the recommendation, and changing an answer changes only the task named.

- **Q1 — Pause when covered: default and scope.** *Recommend:* default **Off**. Today the app never pauses for a window: it launches LWE with `--no-fullscreen-pause` and mpvpaper without `-p`. Options: Off / "a fullscreen window" / "a fullscreen or maximized window". The wallpaper pauses only when every monitor showing it is covered. *Alternative:* pause when any monitor is covered. That would stop a wallpaper you can still see on the other screen; it changes Task 6's rule to "any" (one line).
- **Q2 — Rotation while no monitor shows the wallpaper** (every output unplugged or KVM-switched away). *Recommend:* **hold**. The item and its remaining time wait until a monitor comes back, and nothing is decoded for nobody. *Alternative:* keep rotating invisibly (today). Task 5 then counts play time while parked and keeps `transition_parked`'s replace-the-parked-wallpaper path.
- **Q3 — Auto-mute with the app closed.** The spec lists the monitor daemon for retirement, but it is the parked auto-mute's only way to run without the app. *Recommend:* **keep `monitor-daemon`** in Phase 3 and retire it with the Signal when that is un-parked. *Alternative:* retire it now; auto-mute then works only while the app is open. Task 8 deletes `SpawnDetachedMonitor`'s callers under `liascape-player`.
- **Q4 — "Resume from last on launch": where to resume.** *Recommend:* **the exact position** (the item, its time, its play time — the snapshot). Today a timed restore restarts the item from 0, and a single wallpaper restarts from 0. *Alternative:* the item's start. Task 8 then sends `program.play {index}` instead of `serve --restore`.

---

## Global Constraints

- **Invariant:** never hand an audible or visible stream between owners; only ramp gains/opacities on streams that keep running. Programs only *request* transitions; the recipe (`player-core.md` § Transition recipe) stays the one place a switch happens. Invariants #1–#11 (`docs/player/invariants.md`) hold unchanged.
- Gains are dB; silent = −96 dB; ≤ 30 ms anti-click ramps; audio follows the picture; equal-power crossfades.
- **Rotation contract (verbatim from `player-adapter.md` § Rotation, owner-approved 2026-10-28):**
  - "Switch when video ends" off → `interval` is "Switch every": a plain timer, speed-scaled by the playing item's speed (scenes included), switching `align:now` even mid-video. The maximum does not apply.
  - On → the same field is the **minimum play time**, and the **maximum** sits below it. Both are wall-clock seconds (never speed-scaled), not counted while paused, and **0 = off, strictly**.
  - Video: it plays at least the minimum, then switches at its next end (`align:end`). A clip shorter than the minimum loops on and advances at the end of the loop that reaches it, never mid-loop. The request goes in once `played + remaining + 150 ms ≥ min`.
  - Maximum: once the item has played that long, the rotation advances **now** with its transition, even mid-video. An armed end-of-video switch is cancelled and its B is taken. **A cap beats the minimum.**
  - **Separate timing for scenes** on: a scene **and a still image** switch after "Switch scenes after" (0 = they stay until a user switch); min/max apply to videos only. Off: a scene's minimum reached IS its end (no minimum → the maximum moves it; neither → a user switch); an image shows for the minimum (0 → it moves on at once).
  - `ItemPlayRule(kind, min, max, separate, scenesAfter)` is the whole table: video `(min, max)`; separate on → scene/image `(after or NEVER, 0)`; off → scene `(min or NEVER, max)`, image `(min, max)`.
  - Play time is reset by every switch (B counts from its effect's **start**), by a play and by a restore start. **It is never reset by an edit.**
  - A **1-item** session never switches by itself; next/random switch to its one item with its transition; previous steps back through its history.
  - A timer interval change keeps the proportional remaining exactly as `UpdateTimedSettings` computes it: `elapsed = max(0, old − remaining)`; `remaining = elapsed ≥ new ? new : new − elapsed`.
  - A new minimum re-arms an armed or held switch to the same B. A new maximum, or new scene timing, is read at the next tick.
- **Shuffle and history contract** (session.md, UI matrix `shuffle:*`):
  - Each cycle is one pass in a fresh order; the new cycle's first item ≠ the old cycle's last.
  - Turning shuffle on mid-session plays the rest once first.
  - Sequential = the playlist bar's order.
  - History ≤ 100 entries. Previous walks back through what played; next after a previous walks forward through it. Previous at the session's first item does nothing (and leaves an armed switch alone).
  - Random picks uniformly from the playable items except the current one, re-seats the cursor at the pick, and drops the forward history.
  - An item list edit keeps the current item (or, if it was removed, lets it finish without replaying it, and plays the item after its old place next). It resets the history to `[current]` and never resets the countdown or the play time (`ReorderPlaylist`).
  - Skipped items (`skip` true, broken, or unplayable) are passed over by next/random/rotation.
- **Never block the loop:** a program's per-tick work is O(1); O(items) only on an edit, a cycle reshuffle or a random pick. `program.json` is written on the snapshot thread (`lia-snapshot`), atomically (temp + fsync + rename).
- **Settings apply live** for every program property (`set prog:main.<prop>`). Nothing needs a replay. A per-item override reaches a pending B through the resolver as today.
- Global settings still go to `srcs:*` for live sources. `defaults` covers the B's not created yet.
- `PlayerEngine` stays `legacy` by default. Legacy code is not changed except for the `IsLiascapePlayer` dispatches at the top of shared entry points; a legacy regression found along the way goes into `docs/TODO.md`, unfixed.
- **Test media:** ffmpeg clips (`tests/common::ensure_clip`), `solid_png`, synthetic scenes (`synthetic_scene`, `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1`), or the SFW Workshop folder `~/.local/share/Steam/steamapps/workshop/content/431960`. **Never** the steamcmd cache. Every hermetic test uses `--ao null` or a private PipeWire, and temp `XDG_*` dirs.
- The owner approved taking over the live wallpaper session for on-machine batteries. Never restart or kill their Electron UI or backend; leave the session as the tests end it; never print `/settings` (Steam token). Use `claude-reboot` only after telling the owner.
- Build natives with `env -u LD_LIBRARY_PATH nix develop -c …` from `pwd -P` paths. Delete with `trash`, never `rm`; no `git stash`; never `git commit -a`.
- Commits: short, Title Case, no trailing period, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and the executing session's `Claude-Session:` trailer. Docs ship in the same commit as the behaviour they describe.

**Verification commands used by every task** (from the repo root, `pwd -P`):
- Crate, both render modes:
  - `cd src/player && env -u LD_LIBRARY_PATH nix develop -c cargo test -q`
  - `cd src/player && env -u LD_LIBRARY_PATH LIASCAPE_PLAYER_RENDER_WORKER=off nix develop -c cargo test -q`

  Both end with every `test result: ok`. A known load-sensitive test (`transport_meets_the_spike_budget`) that passes alone is not a failure.
- Backend: `dotnet build src/backend` → `0 Error(s)`. Then `LIASCAPE_PLAYER_BIN=$(pwd -P)/src/player/target/debug/liascape-player dotnet run --project src/backend -- player-selftest` → `PASS`.
- Adapter IT: `bash scripts/test-liascape-player-adapter.sh` → last line `RESULT pass=N fail=0`. For RED runs on the base commit's backend: `LIASCAPE_IT_DLL=<base>/bin/Debug/net10.0/liascape-backend.dll`.
- Settings merge: `bash scripts/test-settings-merge.sh` → all pass, 0 fail.
- UI matrix: `bash scripts/test-ui-matrix.sh --changed --jobs 2` before a commit, and the full `--jobs 2` run at Task 11 → `MATRIX … fail=0 error=0`. UI build: `cd app/ui && npm run build`.

## Review Focus

1. **Keybind auto-repeat with the app closed** (`liascape next` ×10 in ~1 s, each a separate CLI process). Each process sends one `program.next`. The rotation lands exactly ten items on, there are never more than 2 unpaused sources per output, and every superseded B is destroyed. → Task 4 `next_storm_lands_on_the_last`, Task 8 IT step "CLI storm, no backend".
2. **Restore of a program saved mid-wait** (a crash, `quit` or reboot while an end-of-video switch is armed). A comes back where it played, the switch is re-armed `align:end`, there is no `align:now` and B is not shown early. → Task 5 `restored_armed_program_rearms_at_a_end`.
3. **Every item unplayable** (all files deleted, all scenes broken, while the app is closed). `program.empty` is logged once, the last frame is held, and there are at most 6 requests in 60 s (the backoff ladder). → Task 3 `all_items_unplayable_stops_without_spinning`.
4. **An edit that removes the armed or incoming B** (trash, playlist bar remove, a reorder while armed). The armed transition is cancelled cleanly (A keeps playing, its loop restored), the next playable item is re-armed, and the play time is kept. → Task 4 `removing_the_armed_b_rearms_to_the_new_next`.
5. **Suspend/resume during a timer rotation.** `Instant` is `CLOCK_MONOTONIC`, which excludes suspend, so the countdown resumes where it stopped and there is no catch-up switch on wake. A worker restarted by the resume (Phase 2's suspend findings) is not counted as a switch. → Task 3 `countdown_uses_the_monotonic_player_clock` (unit, a fake clock that jumps wall time but not monotonic time) + Task 12 owner-run step.

---

## File map

```text
src/player/src/recipes/program/mod.rs     Programs: the recipe (configure, tick, user verbs, commit, failure ladder)
src/player/src/recipes/program/rule.rs    ItemRule table + min/max/scene predicates, retime_remaining (pure)
src/player/src/recipes/program/order.rs   Order: play order, shuffle cycles, history, random, reorder (pure, seeded)
src/player/src/recipes/program/pick.rs    TransitionCfg + effect/duration/method pick (pure, seeded)
src/player/src/recipes/program/store.rs   program.json (config + order) read/write; snapshot half (cursor/history/clock)
src/player/src/signal/{mod,covered}.rs    the covered Signal: Toplevels tracker, CoverState, the cover rule
src/player/src/outbox.rs                  <state>/outbox.jsonl: append, read, ack, bound
src/player/src/graph/{mod,props}.rs       NodeKind::Program, PropValue::Items, schema; out:<c>.covered; player.pause_when_covered
src/player/src/runtime.rs                 Programs + cover hold in the tick (R47 order), update_player_paused, park/unpark hooks
src/player/src/snapshot.rs                `programs` (dynamic state), restore order
src/player/src/api/handlers.rs            program.* verbs, headless.cover, outbox.read/ack, state.programs, hello caps
src/player/src/probe/programs.rs          `programs` probe
src/player/src/wl.rs                      zwlr_foreign_toplevel_manager_v1 binding → Toplevels
src/player/tests/program.rs               new test target (stepped headless, clips + synthetic scenes)
src/backend/Player/LiascapePlayerProgram.cs  the adapter's program half (spec builder, verbs, mirror, R81, outbox)
src/backend/Helpers/PlayerHelper.cs, Web/{ServerHost,AppOps}.cs, Program.cs   dispatches + lifecycle
src/backend/Models/AppSettings.cs, app/ui/src/views/Settings.tsx   PauseWhenCovered
scripts/test-liascape-player-adapter.sh, scripts/test-settings-merge.sh, scripts/test-ui-matrix.sh, app/shell/probe-matrix.js
```

**Order:** 1 → 2 → 3 → 4 → 5 → 7 → 8 → 11 → 12 → 13. Task 6 (cover) and Task 9 (outbox) need only Task 2 and can run beside 3–5, but no more than 2 agents at once (memory "Subagent cap"). Task 10 follows 6.

**Sizes:** S ≤ ½ day, M ½–1½ days, L 1½–3 days of focused agent work. Total ≈ 16–22 days, plus whatever Task 12 finds.

---

### Task 1: Pure rotation rules — item rule, order/shuffle/history, effect pick

**Files:**
- Create: `src/player/src/recipes/program/{mod.rs (module wiring only for now), rule.rs, order.rs, pick.rs}`
- Modify: `src/player/src/recipes/mod.rs` (`pub mod program;`), `src/player/Cargo.toml` (`rand_pcg` or `rand` with a seedable small RNG, if no seedable RNG is in the tree yet; check `Cargo.lock` first)

**Interfaces (produced, used by Tasks 3–5):**
```rust
// rule.rs — a port of PlayerHelper's ItemPlayRule / *Reached / PlayLimits / UpdateTimedSettings arithmetic
pub enum PlayKind { Video, Image, Scene }
pub const NEVER_MS: u64 = u64::MAX / 4;          // never reached, never overflows played + remaining
pub const MIN_SLACK_MS: u64 = 150;
#[derive(Clone, Copy, PartialEq, Debug)] pub struct ItemRule { pub min_ms: u64, pub max_ms: u64 }
pub fn item_rule(kind: PlayKind, min_ms: u64, max_ms: u64, separate: bool, scenes_after_ms: u64) -> ItemRule;
pub fn max_reached(on_end: bool, can_rotate: bool, played_ms: u64, max_ms: u64) -> bool;          // on_end && can_rotate && max > 0 && played ≥ max
pub fn still_min_reached(on_end: bool, can_rotate: bool, kind: PlayKind, played_ms: u64, min_ms: u64) -> bool; // image/scene: played ≥ min (min NEVER → false)
pub fn min_reached(played_ms: u64, loop_remaining_ms: Option<u64>, min_ms: u64) -> bool;          // played + remaining + MIN_SLACK ≥ min; None remaining → played ≥ min
pub fn retime_remaining(old_interval_ms: u64, remaining_ms: u64, new_interval_ms: u64) -> u64;   // UpdateTimedSettings, both branches

// order.rs — the play order, independent of transitions: a planned step is committed only when its B starts
pub struct Order { /* items (paths in play order), idx, shuffle, history (≤ 100), hist_idx */ }
#[derive(Clone)] pub struct Step { pub path: String, pub why: StepWhy, state: OrderState }   // the cursor state after it
pub enum StepWhy { Forward, HistoryForward, Back, Random, Play }
impl Order {
  pub fn new(paths: Vec<String>, first: usize, shuffle: bool) -> Order;
  pub fn current(&self) -> Option<&str>;
  pub fn plan_next(&self, skip: &dyn Fn(&str) -> bool, rng: &mut impl Rng) -> Option<Step>;   // history forward first, then idx+1; cycle end: reshuffle (first ≠ last) when shuffle; skips skipped; None = nothing playable
  pub fn plan_back(&self) -> Option<Step>;                                                      // None at the session's first item
  pub fn plan_random(&self, skip: &dyn Fn(&str) -> bool, rng: &mut impl Rng) -> Option<Step>;  // uniform excluding current; re-seats idx; drops forward history
  pub fn plan_play(&self, index: usize) -> Step;
  pub fn commit(&mut self, step: Step);
  pub fn reorder(&mut self, new: &[String], shuffle: bool, rng: &mut impl Rng);                  // ReorderPlaylist (timed branch) exactly
  pub fn items(&self) -> &[String]; pub fn history(&self) -> (&[String], usize);
}

// pick.rs
pub struct TransitionCfg { pub enabled: bool, pub effects: Vec<String>, pub shuffle: bool,
                           pub duration_ms: u32, pub duration_max_ms: u32, pub method: Method }
impl TransitionCfg { pub fn from_map(m: &Map<String, Value>) -> Result<TransitionCfg, ApiError>; }   // durations clamped 0–10000
pub struct Pick { pub effect_id: Option<String>, pub params: Map<String, Value>, pub duration_ms: u32, pub method: Method }
pub fn pick(cfg: &TransitionCfg, last_effect: Option<&str>, defaults_of: &dyn Fn(&str) -> Option<Map<String, Value>>,
            rng: &mut impl Rng) -> Pick;                                                        // disabled / no known effect / duration 0 → effect_id None (a cut)
```

- [ ] **Step 1: Write the failing unit tests** (in each file's `#[cfg(test)]`; the C# self-test's `PlayLimitAssertions` tables are the oracle):
  - `rule::item_rule_table` — every row of the contract: video (5000, 9000) → (5000, 9000); separate on → scene/image (3000, 0) with after 3000, (NEVER, 0) with after 0; separate off → scene (NEVER, 9000) with min 0 and (5000, 9000) with min 5000, image (0, 9000) with min 0.
  - `rule::max_and_min_predicates`:
    - `max_reached(true, true, 3000, 3000)`
    - `!max_reached(true, true, 2999, 3000)`
    - `!max_reached(false, true, 9e6, 3000)`
    - `!max_reached(true, false, 9e6, 3000)`
    - `!max_reached(true, true, 9e6, 0)`
    - `min_reached(4000, Some(850), 5000)`
    - `!min_reached(4000, Some(849), 5000)`
    - `still_min_reached(true, true, Scene, 3000, 3000)`
    - `!still_min_reached(true, true, Scene, u64::MAX / 8, NEVER_MS)`
  - `rule::retime_remaining_both_branches`: `(10000, 4000, 20000) → 14000` (elapsed 6000 < new) and `(10000, 4000, 5000) → 5000` (elapsed ≥ new → a full new interval, as today).
  - `order::sequential_wraps`: `[a, b, c]`, the next steps from a → b, c, a.
  - `order::shuffle_cycle_never_repeats_across_the_boundary`: seeded, 200 cycles of 5 items. Each cycle is a permutation, and each cycle's first ≠ the previous cycle's last.
  - `order::back_then_forward_walks_history`: play a, b, c; back → b, back → a, back → None, next → b (HistoryForward), next → c, next → the order's next.
  - `order::random_reseats_and_drops_forward_history`: a, b, c, back → b; random (seeded → e) → history `[a, b, e]`, plan_next follows e's order position.
  - `order::skip_is_passed_over` (also history forward past a skipped item) and `order::all_skipped_is_none`.
  - `order::reorder_keeps_current_and_resets_history`: playing b of `[a, b, c]`; new `[c, b, a]` → items `[b, a, c]`, idx 0, history `[b]`.
  - `order::reorder_removed_current_plays_successor_next`: playing b; new `[a, c]`, previous `[a, b, c]` → next = c.
  - `order::shuffle_on_mid_session_plays_rest_first`: the rest is permuted once before b repeats.
  - `order::history_bounded_100`.
  - `pick::sequential_and_shuffle`: sequential `[fade, wipe]` → fade, wipe, fade; shuffle never returns `last_effect` when ≥ 2 effects; unknown ids dropped; `duration_ms 0` → `effect_id None`; range `[500, 900]` is uniform within it over 1000 seeded picks; params = `defaults_of(id)`.
- [ ] **Step 2:** `cd src/player && env -u LD_LIBRARY_PATH nix develop -c cargo test -q --lib recipes::program` → FAIL (does not compile).
- [ ] **Step 3: Implement** the four files. Port each function from the C# named in its doc comment and cite that C# function in the comment (e.g. `/// PlayerHelper.ReorderPlaylist, timed branch`).
- [ ] **Step 4:** same command → PASS. Then the full crate suite in both render modes.
- [ ] **Step 5:** Commit `Add The Program Rotation Rules`.

**Size: M.**

### Task 2: The `program` node, its verbs and events

**Files:**
- Modify: `src/player/src/graph/{mod.rs, props.rs}`, `src/player/src/api/{handlers.rs, proto.rs}`, `src/player/src/recipes/transition.rs` (`origin` on `TransitionReq` and in `transition.scheduled`), `src/player/src/runtime.rs` (a `programs: Programs` field; verbs dispatch to it), `src/player/src/probe/mod.rs`
- Create: `src/player/src/probe/programs.rs`, `src/player/tests/program.rs` (API-shape tests here; behaviour comes in Task 3)

**Interfaces:**
- `NodeKind::Program`, created by `create {kind: "program", id?: "prog:<name>", props}`. Auto-id `prog<n>`. An id with `.` is refused (the path split rule). `destroy {id}` stops the rotation and leaves what plays on screen.
- `PropValue::Items(Vec<ProgramItem>)`, with `#[derive(Serialize, Deserialize)] pub struct ProgramItem { pub path: String, #[serde(default)] pub props: Map<String, Value>, #[serde(default)] pub skip: bool }`. It is validated at `set`: ≤ 10 000 items, non-empty paths, and `props` keys valid **Source** schema props (type-checked as a Source create would be). `bad_type`/`out_of_range` name the item index.
- **Program schema** (settable): `outputs` Str default `out:*` (read-only after create), `items` Items (`[]`), `defaults` Map (`{}`, keys checked like item props), `order` `sequential|shuffle`, `mode` `timer|on_end` (default `on_end`), `interval_ms` F64 0–359 999 000 (0), `max_ms` F64 0–359 999 000 (0), `separate_scenes` Bool (true), `scenes_after_ms` F64 0–359 999 000 (1 800 000), `transition` Map validated by `TransitionCfg::from_map` (default `{enabled: false}`), `seed` I64 (default: wall-clock nanos at create; tests pin it).
- **Program schema** (observed, read-only, `set_observed`): `phase` Str (`idle|playing|holding|armed|switching|backoff|parked|empty`), `index` I64 (−1), `path` Str, `next_path` Str, `played_ms` F64, `remaining_ms` F64.
- **Verbs** (thin recipes; each returns at once and resolves through `transition`):
  - `program.play {id, index?: 0, keep_pause?: false}` → `{corr, path, index}`
  - `program.next | program.prev | program.random {id, keep_pause?: false}` → `{corr: str|null, path: str|null}`. Null = nothing to do: previous at the start, or nothing playable.
  - Errors: `no_such_node`, `unsupported` ("empty program", hint `ctl probe '{"name":"programs"}'`).
- `state` gains `programs: [ProgramStatus]`:
  `{id, phase, path, index, next, corr, armed_align, items, order, history, history_index, played_ms, remaining_ms, backoff_ms, failures, last_effect, broken: [paths]}`.
  The `programs` probe returns the same, plus each item's `skip|broken|failed` flags.
- **Events** (`program.*`, info unless noted):
  - `created {id}`, `destroyed {id}`
  - `current {id, index, path, from, reason, corr}`, where reason ∈ `play|timer|end|max|scenes_after|next|prev|random|broken|vram|failed_skip|items`
  - `armed {id, next, corr, align}`, `held {id, path, until_played_ms}` (debug)
  - `failed {id, path, reason, backoff_ms}` (warn), `skipped {id, path, why}`, `empty {id}` (warn)
- `transition.scheduled` gains `origin: "api" | "program:<id>"`.
- `hello.capabilities` + `program`.

- [ ] **Step 1: Write failing tests** (`tests/program.rs`, stepped headless, `--ao null`):
  - `program_node_roundtrips`: create with every prop → `get` each prop back; `state.graph["prog:main"].kind == "program"`; `state.programs[0].phase == "idle"`.
  - `items_are_validated`: a bad `props` key → `no_such_prop`, naming the index; 10 001 items → `out_of_range`; an empty path → `bad_type`; nothing changed after any failure.
  - `observed_props_are_read_only`: `set prog:main.index` → `read_only`.
  - `verbs_on_missing_or_empty_program`: `program.next {id:"prog:x"}` → `no_such_node`; on an empty program → `unsupported` with a hint.
  - `transition_events_carry_origin`: a plain `transition` → `origin: "api"`.
  - `destroy_program_leaves_the_picture`: a source shown before `destroy prog:main` is still `cur:*` after.
- [ ] **Step 2:** `cargo test -q --test program` → FAIL.
- [ ] **Step 3: Implement.** The verbs can return `unsupported` ("not yet") for a non-empty program until Task 3. The graph `Items` type gets its `to_json`/`from_json` arms. `schema_for_kind(Program)`.
- [ ] **Step 4:** `--test program` PASS; the full crate suite in both modes PASS.
- [ ] **Step 5:** Commit `Add The Program Node To The Player Graph`.

**Size: M.**

### Task 3: The rotation engine — timer, advance-on-end, limits, scenes, failures

**Files:**
- Modify: `src/player/src/recipes/program/mod.rs` (`Programs`), `src/player/src/runtime.rs` (tick order, executing program actions), `src/player/src/api/handlers.rs` (`program.play` real), `src/player/tests/program.rs`

**Interfaces:**
```rust
pub struct Programs { /* id → Prog { cfg, order: Order, rng, pending: Option<Pending>, armed: Option<CorrId>,
                         clock: PlayClock, remaining_ms, last_effect, failures, backoff_until, broken: BTreeSet<String> } */ }
pub enum ProgramAction {
  Start { id: String, req: TransitionReq, step: Step, reason: Reason },   // the runtime: tr.start(...) → on_requested(id, corr)
  Cancel { corr: CorrId },                                                // a pre-Running armed switch (abort restores A's loop)
}
impl Programs {
  pub fn configure(&mut self, id: &str, g: &Graph);                                   // after create / any drained change on prog:* (live)
  pub fn play(&mut self, id: &str, index: usize, keep_pause: bool, g: &Graph) -> Result<Vec<ProgramAction>, ApiError>;
  pub fn on_requested(&mut self, id: &str, corr: CorrId, step: Step, reason: Reason);
  pub fn tick(&mut self, g: &mut Graph, tr_events: &[TransitionEvent], src_events: &[(String, SourceEvent)],
              player_now: Duration, parked: bool) -> Vec<ProgramAction>;            // after Transitions::tick, before refresh_srcs (R47)
  pub fn status(&self) -> Vec<ProgramStatus>;
}
pub enum Reason { Play, Timer, End, Max, ScenesAfter, Next, Prev, Random, Broken, Vram, FailedSkip, Items } // = program.current.reason (snake_case)
pub struct PlayClock { /* accumulates player-clock deltas while the item is shown (not parked) */ }
pub const BACKOFF_MS: [u64; 6] = [1000, 2000, 4000, 8000, 16000, 30000];   // then 30000 for as long as failures continue
```
- **B's create props:** `defaults` ∪ `item.props` (item wins), plus `path`, plus `loop: true` while a min-hold needs A to loop. `kind` comes from the item props, else from the extension the backend sends; the player's own image flag corrects it as today.
- **Commit:** at `transition.started` for the program's corr (B becomes current: `Order::commit(step)`, play time → 0, emit `program.current`, then arm the next per the rule). `handoff {committed: true}` also commits a step not yet committed (a missed `started`). A `cancelled {superseded}` caused by the program's own next request is ignored. A `cancelled` by another client (`origin: api`) drops the pending step, and the program follows what `cur:` now shows (its path, if it is an item, becomes current with reason `items`; else the program goes `idle` until the next verb).
- **On end:** with a video current and `CanRotate`, `plan_next` happens right after commit. If `min_reached` (with A's loop remaining = (duration − time_pos)/speed) → `Start align:end` now. Else `held`, with A's `loop` set true, and the request goes in during the loop that reaches the minimum. The maximum runs on the tick. A still (image/scene) uses `still_min_reached` on the tick (`align:now`).
- **Timer:** `remaining_ms -= Δplayer × speed(cur source)` while not parked; at ≤ 0 with `interval_ms > 0` → `Start align:now`. A 1-item program resets to the interval.
- **Failure ladder** (designer call 8) and **broken/vram:** `source.broken` / `scene.vram_exceeded` for the current item's source → an immediate `Start align:now` to the next playable item (`broken` marks the path; `vram` does not).

- [ ] **Step 1: Write failing tests** (`tests/program.rs`, stepped clock, `seed` pinned, clips from `ensure_clip` — 2 s / 4 s / 10 s FrameIndex clips; `solid_png`; `synthetic_scene`):
  - `timer_mode_switches_every_interval`: 3 clips, timer 3000, `fade` 500 → `program.current` at player t = 3000, 6000, 9000 (± one 16 ms step), paths a → b → c → a, each `transition.scheduled` with `origin: "program:prog:main"`, `align: "now"`.
  - `timer_countdown_scales_with_speed`: `defaults.speed` 2 → the first switch at t ≈ 1500.
  - `countdown_uses_the_monotonic_player_clock` (unit, in `mod.rs`): a `PlayClock` fed a fake clock whose wall time jumps 8 h while the monotonic delta is 10 ms → remaining drops by 10 ms only.
  - `timer_one_item_never_switches`: 1 item, timer 1000 → no `transition.scheduled` in 10 s after its play.
  - `on_end_switches_at_each_end_aligned`: two 2 s clips, min 0, `fade` 500 full-live → armed `align: "end"` right after each commit; each handoff ≤ 1 frame from A's `source.ended`; 4 consecutive switches.
  - `min_hold_loops_short_clip_to_the_reaching_loop_end`: a 2 s clip, min 5000 → `program.held`, A's `loop == true`; no `transition.scheduled` before played ≥ 4000 − 150; handoff at A's 3rd loop end (t ≈ 6000).
  - `max_cuts_mid_video_now`: a 10 s clip, max 3000 → `align: "now"` at played 3000 with its `fade`; the armed end switch `cancelled {superseded}`; the same B path.
  - `max_beats_min`: min 8000 + max 3000 → at 3000.
  - `zero_means_off_for_both`: min 0, max 0, a 4 s then a 10 s clip → each plays to its end, no `align: "now"`.
  - `scene_switches_after_scenes_after`: separate on, after 3000 → scene → `align: "now"` at played 3000; a following 4 s video ignores 3000 and switches at its end.
  - `separate_off_scene_follows_min_then_max`: min 3000 → at 3000; min 0 + max 2000 → at 2000; both 0 → no switch in 8 s.
  - `image_follows_scene_rule_with_toggle_on` (after 3000) and `image_min_with_toggle_off` (min 0 → its switch is requested within one tick of its commit).
  - `b_commits_at_effect_start`: `program.current` is logged at the same `at_ms` as `transition.started`, before `handoff`; `get prog:main.path` = B during the effect.
  - `transition_off_on_end_is_a_gapless_cut_at_a_end`: `transition.enabled false` → `effect_id null`, `align "end"`.
  - `effect_pick_reaches_the_request`: sequential `[fade, wipe]` → the requests carry fade, wipe, fade with the catalogue's default params; duration range `[400, 600]` → each `duration_ms` within it.
  - `failed_item_backs_off_and_skips`: `[a, garbage.mp4, c]` → `program.failed {backoff_ms: 1000}`, then c (`reason: "failed_skip"`); a second consecutive failure → 2000; a handoff resets.
  - `all_items_unplayable_stops_without_spinning` (Review Focus 3): 3 garbage files → ≤ 6 `transition.scheduled` in 60 s of stepped time, one `program.empty`, the colour shown before held.
  - `skip_flag_is_respected`: a `skip: true` item is never requested over 2 cycles.
  - `broken_scene_advances_now`: a synthetic scene with `crash_after_ms: 50` (it reaches broken through 3 restarts) → `program.current {reason: "broken"}` ≤ 1 tick after `source.broken`; `state.programs[0].broken` holds it; skipped on the next cycle.
  - `vram_stopped_scene_advances_without_broken_flag` (`LIASCAPE_PLAYER_VRAM_PROBE=fake:<file>` + short `LIASCAPE_PLAYER_VRAM_TIMING`) → reason `vram`, not in `broken`, played again next cycle.
  - `every_switch_combo`: V→V, V→S, S→V, S→S × {full-live, reveal, frozen} under timer 2000 → every handoff, at most 2 unpaused sources per output at each step.
- [ ] **Step 2:** `cargo test -q --test program` → the new tests FAIL.
- [ ] **Step 3: Implement.** The tick hook goes after `Transitions::tick` in `Runtime::tick` and after `begin_step`'s recipe tick in stepped mode. Actions run through the same `Transitions::start` the `transition` verb uses (no second code path).
- [ ] **Step 4:** `--test program` PASS; `--test transition`, `--test api` and the full suite in both modes PASS.
- [ ] **Step 5:** Commit `Run Rotation Inside The Player`.

**Size: L** (≈ 2½ days; the align:end interplay is the risk — Risk 1).

### Task 4: User switches and live edits

**Files:**
- Modify: `src/player/src/recipes/program/mod.rs`, `src/player/src/api/handlers.rs` (`program.next|prev|random`), `src/player/tests/program.rs`

**Rules:**
- A user switch (`next`/`prev`/`random`/`play`) always requests `align: now` with the program's pick, which supersedes an armed one (the recipe aborts it). `next` while armed takes the armed B (`AdvanceAndLaunch`'s pre-fetch). `next` during a running effect commits it (B becomes current) and goes to the item after B.
- `keep_pause: true` while `player.paused` → `effect_id: null` (a cut; B shows its first frame paused). The rotation clock stays frozen.
- **Live edits** (each from `configure`, diffed against the previous cfg):
  - `interval_ms` → `retime_remaining` (timer). In on_end, a changed minimum re-arms an armed or held switch to the same B.
  - `max_ms` / `separate_scenes` / `scenes_after_ms` → read at the next tick.
  - `mode`: timer → on_end arms per the rule; on_end → timer cancels the armed switch and starts the countdown at the full interval. Play time is kept.
  - `transition` → an armed (pre-Running) switch is cancelled and re-requested to the same B with the new pick.
  - `order` → `Order::reorder(items, shuffle)` (shuffle on plays the rest once first).
  - `items` → `Order::reorder`. If the armed B is no longer an item, cancel and re-plan. If the current item was removed, it finishes without a replay. A 1-item program that grows arms as `CanRotate` turns true.
  - `defaults` / item `props` → used by the next B only (live sources are the resolver's job).

- [ ] **Step 1: Write failing tests** (`tests/program.rs`):
  - `next_prev_random_follow_the_history_contract`: the same sequences as `order::back_then_forward_walks_history` and `random_reseats…`, through the verbs, with `program.current` reasons `next|prev|random`.
  - `prev_at_session_start_does_nothing`: `{corr: null}`; an armed switch keeps its corr.
  - `next_during_armed_wait_takes_the_armed_b`: the path = the armed `next_path`; the old corr `cancelled {superseded}`.
  - `next_during_running_effect_goes_past_b`: `handoff {committed: true}` for B, then the item after B.
  - `next_storm_lands_on_the_last` (Review Focus 1): 10 `program.next` within 3 steps → the final `path` = items[(k + 10) % n] on a 12-item program; at every step ≤ 2 unpaused sources per output (`probe sources`); every superseded B gone ≤ 2 steps after.
  - `keep_pause_next_is_a_cut_paused`: `player.paused` + `keep_pause` → `effect_id: null`, B `effective_paused`; `remaining_ms` unchanged over 2 s.
  - `one_item_next_and_random_switch_to_itself`: a new source of the same path, with its transition.
  - `live_interval_change_keeps_proportional_remaining`: both `retime_remaining` branches through `set`.
  - `live_min_change_rearms_same_b`: new corr, same `next_path`, `played_ms` kept.
  - `live_max_change_applies_next_tick`: played 5000, max set to 4000 → `align: now` within one tick.
  - `live_mode_toggle_keeps_played_time`: timer → on_end → timer.
  - `live_transition_change_rearms_armed_switch`: fade → wipe while armed → the new corr carries `wipe`.
  - `live_order_change_plays_rest_once_first`.
  - `items_edit_keeps_current_and_played_time`: a reorder and an append while playing → same `path`, `played_ms` monotone.
  - `removing_current_lets_it_finish_without_replay`.
  - `removing_the_armed_b_rearms_to_the_new_next` (Review Focus 4): A's `loop` is restored by the abort; the new `next_path` ≠ the removed one; `played_ms` kept.
  - `undo_regrows_a_one_item_session`: 1 → 3 items under on_end → armed.
  - `defaults_and_item_props_reach_the_next_b`: `defaults.gain.user` −10, item 2 `props.gain.user` −3 → B1's `gain.user` −10, B2's −3; a `defaults` change between them reaches only later B's.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** `--test program` + the full suite in both modes PASS.
- [ ] **Step 5:** Commit `Add Program User Switches And Live Edits`.

**Size: L.**

### Task 5: Programs × pause, VRAM hold, parking, hotplug, crash and restore

**Files:**
- Create: `src/player/src/recipes/program/store.rs`
- Modify: `src/player/src/snapshot.rs` (`#[serde(default)] programs: Vec<ProgramSnap>`; `VERSION` stays 1 — additive), `src/player/src/runtime.rs` (park/unpark → `parked` flag; the restore order: outputs → sources → programs), `src/player/tests/{program.rs, supervise.rs}`

**Interfaces:**
- `<state>/program.json` = `{version: 1, rev, programs: [{id, props (settable), order: {items, idx, shuffle}}]}`. It is written on `lia-snapshot` after a config/order change (debounced 250 ms like the snapshot), and never by the 2 s position refresh.
- The snapshot's `ProgramSnap = {id, rev, history, history_index, current_path, played_ms, remaining_ms, last_effect, failures, broken}`. A `rev` mismatch (one file lagging the other) → keep `program.json`'s order and re-anchor the cursor on `current_path`.
- **Restore:** the program is created after the snapshot's sources. Current = the restored shown source when its path is the saved `current_path`, else the program goes `idle` and logs `program.restore_mismatch`. Then the first tick arms per the rule (an on_end program with a video current re-arms `align:end` — the snapshot already saves an armed pre-Running switch as A where it plays).
- `stop` destroys every program. `quit` writes both files before `stop_all`.

- [ ] **Step 1: Write failing tests:**
  - `pause_freezes_the_rotation` (`program.rs`): timer 3000, `player.paused` for 5000 at played 1000 → the switch at t ≈ 8000; `remaining_ms` constant while paused.
  - `vram_hold_freezes_the_rotation`: the fake VRAM probe low → hold → no switch while held; resumes after the release.
  - `no_output_holds_the_rotation_and_resumes_on_replug` (Q2, recommended): `headless.remove_output` ×2 → `phase: "parked"`, no `transition.scheduled` for 10 s; re-add → the same item shown, and the switch comes at the remaining time.
  - `hotplug_mid_program_switch_adopts`: an output added during a program effect is adopted (`transition.output_adopted`) and the program commits normally.
  - `program_survives_a_crash` (`supervise.rs`, supervised headless, real clock): a timer rotation of 3 clips; `kill -SEGV` the compositor after 2 switches → the new pid's `state.programs[0]` has the same order and history, `played_ms` within 2.5 s of before, and the rotation goes on (the next switch to the next item, origin program).
  - `restored_armed_program_rearms_at_a_end` (Review Focus 2): on_end with a 6 s clip, crashed 2 s in while armed → A restored at ≈ 2 s, a new `transition.scheduled {align: "end"}`, no `align: "now"`, handoff at A's end.
  - `quit_then_restore_resumes_the_program`: `ctl quit`, then `serve --restore` → same item, position ± 2 s, the rotation continues.
  - `fourth_restart_in_a_minute_starts_without_program`: `LIASCAPE_PLAYER_TEST_CRASH` pattern → the 4th child has no program (no `--restore`) — documented; the backend reconciles (Task 7).
  - `stop_destroys_the_program`: `stop` → `programs: []`; the next snapshot has none.
  - `program_json_written_only_on_config_change`: 10 s of playback → `snapshot.saved` ≥ 4, `program.json` mtime unchanged; a `set prog:main.order` → written once.
  - unit `snapshot_without_programs_still_parses` and `program_json_rev_mismatch_reanchors`.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** `--test program --test supervise` + the full suite in both modes PASS.
- [ ] **Step 5:** Commit `Persist Programs Across Player Restarts`.

**Size: M–L.**

### Task 6: The covered Signal — pause when a window covers the wallpaper

**Files:**
- Create: `src/player/src/signal/{mod.rs, covered.rs}`, `docs/player/spikes/foreign-toplevel.md`
- Modify: `src/player/src/wl.rs` (bind `zwlr_foreign_toplevel_manager_v1` v3 when advertised; map each handle's `output_enter/leave` `wl_output` → connector name; `state`/`done`/`closed` → `Toplevels`), `src/player/src/headless.rs` (`OutputBackend::take_cover_changes() -> Vec<(String, CoverState)>`, default empty; headless keeps a settable map), `src/player/src/graph/props.rs` (observed `out:<c>.covered` Str `none|maximized|fullscreen`; Player `pause_when_covered` `off|fullscreen|maximized` default `off`; observed `cover_hold_active` Bool), `src/player/src/runtime.rs` (`cover_hold` composed in `update_player_paused` beside `self.vram.hold`), `src/player/src/api/handlers.rs` (`headless.cover {output, state}`; `hello.capabilities` + `cover` when the manager is bound, or headless), `src/player/src/health.rs` (`cover {ok, reason}`)

**Interfaces:**
```rust
pub enum CoverState { None, Maximized, Fullscreen }
pub struct Toplevels { /* handle → {fullscreen, maximized, activated, minimized, outputs: BTreeSet<String>} */ }
impl Toplevels { pub fn covered(&self, connector: &str) -> CoverState; }   // max over handles with activated && !minimized && on that output
pub const COVER_ENGAGE_MS: u64 = 300;
pub fn cover_rule(mode: &str, showing: &[(String, CoverState)]) -> bool;  // mode != off, non-empty, every output that shows content ≥ the mode's threshold
```
Events: `cover.engaged {outputs, mode}`, `cover.released {held_ms}`. The hold engages after `COVER_ENGAGE_MS` (base clock) and releases at once. `player.paused` (the user's) is never written.

- [ ] **Step 1 — spike (on the owner's Hyprland, real `serve`, no tests yet).** Add a debug probe `toplevels` (handles with states, outputs and app_id). Record in `docs/player/spikes/foreign-toplevel.md`, for each of these, what Hyprland reports:
  - (a) a kitty fullscreen on DP-1 (`hyprctl dispatch fullscreen 0`)
  - (b) a fullscreen window on another workspace of DP-1 while workspace 1 is shown
  - (c) a maximized window (`fullscreen 1`)
  - (d) focus moved to DP-2
  - (e) a minimized/special-workspace window

  The decision follows the record. If (b) reports `activated` (a hidden fullscreen window would pause the wallpaper), the rule adds Hyprland's `activewindowv2`/`workspace` socket2 events behind a `HYPRLAND_INSTANCE_SIGNATURE` check — note it in the spike and in Risk 2 — or the setting ships fullscreen-only.
- [ ] **Step 2: Write failing tests:**
  - unit `covered_requires_activated_fullscreen_on_that_output`, `maximized_mode_counts_maximized_and_fullscreen`, `minimized_or_inactive_never_covers`, `cover_rule_needs_every_showing_output`.
  - api (`tests/api.rs`):
    - `cover_hold_pauses_when_every_output_is_covered`: both virtual outputs `fullscreen`, mode `fullscreen` → `cover.engaged` ≥ 300 ms after; `player.cover_hold_active` true; every source `effective_paused`; `player.paused` false; the `gain.pause` ramp ≤ 30 ms. Uncover → `cover.released`, a ramp-in after `AudioFlowing`.
    - `cover_on_one_output_of_two_keeps_playing`.
    - `cover_hold_mid_transition_freezes_and_resumes_exactly`: `fx.progress` is equal before and after a 2 s hold.
    - `cover_hold_composes_with_user_pause`: a user pause during the hold, then a release → still paused; a resume → plays.
    - `cover_off_mode_ignores_signal`.
    - `cover_flap_is_debounced`: 5 × 100 ms fullscreen on/off → no engage.
    - `cover_hold_freezes_a_program`: a timer rotation doesn't switch while held.
- [ ] **Step 3:** `cargo test -q --test api cover` and `--lib signal` → FAIL. **Step 4:** implement. **Step 5:** PASS; the full suite in both modes PASS.
- [ ] **Step 6 (on-machine):** with a real fullscreen kitty over both outputs, mode `fullscreen`: `cover.engaged`, `probe sources` all `effective_paused`, the grim pixels unchanged for 3 s; leave fullscreen → playing within 50 ms of `cover.released`. Record it in the spike doc.
- [ ] **Step 7:** Commit `Pause The Wallpaper When A Window Covers It`.

**Size: M** (+ the spike; L if Hyprland needs its IPC fallback).

### Task 7: Backend adapter — rotation sessions become a player program

**Files:**
- Create: `src/backend/Player/LiascapePlayerProgram.cs`
- Modify: `src/backend/Helpers/PlayerHelper.cs` (dispatches below), `src/backend/Player/LiascapePlayerMedia.cs` (`Desired` split into `DesiredGlobal()` + `DesiredItem(path)`; every resolver pass that changes a global also queues `LiascapePlayerProgram.PushDefaults()`; per-item changes queue `PushItem(path)`; `ReconcileShown` skips while a program is active — the player owns the intent; event subscription + `program.`), `src/backend/Player/LiascapePlayerClient.cs` (`Topics` + `program.`), `src/backend/Web/{AppOps.cs, ServerHost.cs}` (route through the dispatches), `src/backend/Player/LiascapePlayerSelfTest.cs`, `scripts/test-liascape-player-adapter.sh`, `.claude/rules/player-adapter.md` (§ Rotation rewritten: where each rule now lives)

**Interfaces:**
```csharp
public static class LiascapePlayerProgram {
  public const string Id = "prog:main";
  public sealed record Item(string Path, Dictionary<string, object?> Props, bool Skip);
  public sealed record Spec(List<Item> Items, Dictionary<string, object?> Defaults, string Order /*sequential|shuffle*/,
      string Mode /*timer|on_end*/, long IntervalMs, long MaxMs, bool SeparateScenes, long ScenesAfterMs,
      Dictionary<string, object?> Transition /*enabled, effects, shuffle, duration_ms, duration_max_ms, method*/);
  public static Spec BuildSpec(IReadOnlyList<string> paths, AppSettings s, PlaylistSettings? p, bool shuffle, int intervalSeconds, bool advance);
      // EffectiveRotation for max / scene timing; TransitionService.Effective + s.TransitionMethod; Defaults = DesiredGlobal();
      // Item.Props = SourceProps(path) minus the entries equal to Defaults; Skip = IsSkippedPath(path)
  public static void Load(Spec spec, int startIndex, bool keepPause);   // essential: destroy prog:main if present, create, program.play
  public static void Next(bool keepPause); public static void Prev(bool keepPause); public static void Random(bool keepPause);
  public static void SetRotation(int intervalSeconds, bool advance);                // coalescible "program:rotation"
  public static void SetLimits(int maxSeconds, bool separate, int scenesAfterSeconds); // "program:limits"
  public static void SetTransition(); public static void SetOrder(bool shuffle);
  public static void SetItems(IReadOnlyList<string> paths);                         // "program:items" (rebuilt from the playlist + skip flags)
  public static void PushDefaults(); public static void PushItem(string path);
  public static bool IsActive { get; }  public static string? CurrentPath { get; }  public static int CurrentIndex { get; }
  internal static void OnEvent(string kind, JsonElement e);   // program.current → PlayerHelper.OnProgramSwitched(path)
  internal static void Reapply();                              // R81: absent while our model is active → Load at CurrentIndex; else diff props → set
  public static void Sync();                                   // serve start / reconnect: seed the mirror from state.programs (no writes)
}
```
**Dispatch table** (each an `if (PlayerEngine.IsLiascapePlayer)` at the top; legacy below unchanged):

| PlayerHelper / AppOps | under liascape-player |
|---|---|
| `ApplyTimedPlaylist`, `ApplyPlaylist` (> 1 item or any scene), `AppOps.PlayPlaylist/PlayFrom` | `Load(BuildSpec(…), first playable or startIndex, keep)`; `_history`/`_timedPaths` not kept; `QueueNewSession` (I1) as today |
| `NextWallpaper` / `PreviousWallpaper` / `ApplyRandom` (session active) | `BeforeUserSwitch` as today, then `Next/Prev/Random(keep)` — never `WritePendingAction` |
| `UpdateTimedSettings`, `ApplyRotationLive`, `ApplyPlayLimitsLive`, `RearmAlignedSwitch`, `SetPlaylistShuffle` | `SetRotation` / `SetLimits` / `SetTransition` / `SetOrder` |
| `ReorderPlaylist`, `SyncAdvanceOnEndPlaylist`, `AppendToActivePlaylist`, trash/undo of a listed item | `SetItems(paths)`; a trashed shown/incoming item then `Next(false)` (web-backend.md § Trash) |
| `OnSceneBroken`, `OnSceneVramStopped` | persistence + WS only (`MarkCrashed`, `scene-crashed` / `scene-vram-stopped`) — the player already advanced; whitelisting → `PushItem` (skip false) |
| `Stop`, `Apply` (single) | `stop` / a plain switch; both end the program (`stop` destroys it; `Apply` sends `destroy prog:main` first) |
| `TogglePause` | `TogglePause` only (no `UpdateTimerPaused` / timed-state write) |
| `IsTimedPlaylistActive`, `/current.timed` | `LiascapePlayerProgram.IsActive` |
| `EnsureTimedTick`, `StartTimedTimer`, `DoVideoEndWait`, `HoldForMinPlay`, `Tick` | never reached: a guard logs `legacy rotation path reached under liascape-player` and returns |
| `OnProgramSwitched(path)` (new, from `program.current`) | `OnWallpaperChanged` (WS `wallpaper-changed`), `_currentSpeed`, the normalization kick for the NEXT unmeasured items (`EnsureLoudnessAsync` for every unmeasured video item at `Load`/`SetItems`, so the app-closed gap is only an item never measured before) |

- [ ] **Step 1: Write failing checks:**
  - Self-test `ProgramSpecAssertions` (no player):
    - `BuildSpec` mapping table: timer vs on_end; interval → `interval_ms`; max/separate/after from `EffectiveRotation` (override and follows); transition off / 0 ms / range / method.
    - `Defaults` = `DesiredGlobal`; an item with a volume override carries only `gain.user`; a scene carries `kind`, `preview`, `gain.normalize`, `scene_props`; a crashed non-whitelisted scene `Skip`.
    - `ReconcileShown` is a no-op while `IsActive`.
  - Adapter IT § "programs in the player" (RED on the base backend):
    - `/playlist/play` 3 clips, timer 4 s → `ctl state` has `prog:main`; three `program.current`, every `transition.scheduled` origin `program:prog:main`, **no** origin `api` after the first load; `/current` = the program's path each time; WS `wallpaper-changed` per switch.
    - Advance-on-end with min 0 / min 5 s on a 2 s clip / max 3 s / separate timing with a synthetic scene and an image — each check of today's § "advance-on-end play-time limits" and § "0 = off for both limits", now passing through the player.
    - `/next` `/prev` `/random` mid-wait and mid-effect (the existing checks unchanged).
    - Every live edit through `/settings` and `/playlist/state` (interval, min, max, scene timing, transitions, order, reorder, trash of the playing and of the armed item, undo) → `get prog:main.<prop>` live, the same corr unless the rule re-arms, `played_ms` monotone.
    - The volume/override/normalization passes reach `prog:main.defaults` / the item props and the next B's create props.
    - A crashing synthetic scene → index `crashed: true`, the rotation advanced by the player (no backend request).
    - The engine switch: liascape-player → legacy replays `LastSession`; legacy → liascape-player loads from `timed_state.json` at its item.
- [ ] **Step 2:** `bash scripts/test-liascape-player-adapter.sh` → the new checks FAIL (and with `LIASCAPE_IT_DLL=<base>` too).
- [ ] **Step 3: Implement.** Port nothing: the C# rotation stays for legacy; this task routes around it.
- [ ] **Step 4:** IT `RESULT pass=N fail=0`; `player-selftest` PASS; `test-settings-merge.sh` all pass; `cd app/ui && npm run build` ok.
- [ ] **Step 5:** Commit `Drive Rotation Through The Player Program`.

**Size: L** (≈ 2½ days incl. the IT).

### Task 8: Retire the timer and restart daemons, the pending file and pid ownership

**Files:**
- Modify: `src/backend/Web/ServerHost.cs` (startup / `ApplicationStopping`), `src/backend/Program.cs` (`restore`, `kill`, the keybind path), `src/backend/Helpers/PlayerHelper.cs` (`Restore`, `SpawnTimerDaemon`, `SpawnRestartDaemon`, `UpdateRestartTimer`, `WriteGuiTimerPid`, `ReleaseTimer`, `SignalTimerStop` — no-ops under liascape-player, logged once), `src/backend/Player/LiascapePlayerClient.cs` (`EnsureRunning(restore: bool)` — the FIRST start may pass `--restore`), `scripts/test-liascape-player-adapter.sh`, `.claude/rules/{session.md, player.md}`, `CLAUDE.md` (CLI: `timer-daemon` / `restart-daemon` legacy-only)

**Behaviour under liascape-player:**
- **serve startup:** kill a leftover `timer-daemon` / `restart-daemon` (from a legacy session or an older build: `KillTimerDaemon`, `KillRestartDaemon`). Do not write `gui_timer.pid`, do not call `ResumeTimedTimer`; `LiascapePlayerProgram.Sync()` reads `state.programs` to seed the mirror.
- **serve shutdown:** no `ReleaseTimer` / `SpawnTimerDaemon`. The `AudioMonitor` hand-off to `monitor-daemon` is unchanged (Q3).
- **`liascape restore`:** with `ResumeFromLast` on → `EnsureRunning(restore: true)`; once `hello` answers, `state` shows a wallpaper or a program → done. Otherwise, or with it off → replay `LastSession` (`Load` for timed/playlist sessions, `Apply` for a single one, shuffled anew when `Shuffle`). `AudioMonitor.SpawnDetachedMonitor` when AutoMute (unchanged); never `SpawnTimerDaemon` / `SpawnRestartDaemon`.
- **`play` / `toggle-play`:** a program already active → nothing (as today's resume). Else `Restore`.
- **CLI keybinds with no app:** `ActionForward` fails → `AppOps.RunAction` → the program verbs straight to the player (`DrainLiascapePlayerBeforeExit` as today).
- **Files never touched:** `pending_action.txt`, `timer.pid`, `gui_timer.pid`, `restart.pid`, `timed_state.json`, `playlist_observer_paths.json` are never written. A stale one from a legacy run is ignored.

- [ ] **Step 1: Write failing IT checks:**
  - **App closed:** the backend TERMed mid-rotation → `program.current` events continue (≥ 2 in 10 s with no backend process: `pgrep -f liascape-backend` empty), and no `timer-daemon` / `restart-daemon` process appears. A restarted backend → `/current` = `ctl get prog:main.path` within 1 s, and no `transition.scheduled` origin `api` within 5 s.
  - **Files:** across the whole IT, under liascape-player, none of `pending_action.txt` / `timer.pid` / `gui_timer.pid` / `restart.pid` / `timed_state.json` exists.
  - **CLI storm, no backend** (Review Focus 1): 10 × `liascape next` in parallel → the program lands ten items on, ≤ 2 unpaused sources per output sampled every 100 ms.
  - **CLI with the app closed:** `liascape previous` / `random` / `toggle-pause` / `volume up` (the global and an overridden item) / `stop` / `play` → each reaches the player (`ctl` checks); `volume up` changes `prog:main.defaults.gain.user`.
  - **Restore:** `restore` with `ResumeFromLast` on after `ctl quit` → the same item at the saved position (± 2 s), still a program. With it off → `LastSession`'s first item at 0. With no snapshot (`trash` it first) → `LastSession`. `stop`, then `play` → `LastSession`.
  - **Two backends:** a second `serve` started while one runs → still one switch per interval (origin program), no supersedes.
  - The upgrade watch: a stale player with an armed program → upgraded at the next commit only (the existing "no upgrade while armed" rule now reads `state.programs[*].phase == "armed"`).
- [ ] **Step 2:** IT → the new checks FAIL. **Step 3:** implement. **Step 4:** IT `fail=0`; `player-selftest` PASS.
- [ ] **Step 5:** Commit `Retire The Timer And Restart Daemons Under liascape-player`.

**Size: M.**

### Task 9: The player outbox — what the backend must store while it is away

**Files:**
- Create: `src/player/src/outbox.rs`
- Modify: `src/player/src/runtime.rs` + `src/player/src/sources/scene.rs` (append at the points that log `source.broken`, `scene.loudness`, `scene.vram_exceeded`; the live events gain `outbox_seq`), `src/player/src/api/handlers.rs` (`outbox.read`, `outbox.ack`), `src/backend/Player/LiascapePlayerClient.cs` (on every `Subscribed`: drain, then ack), `src/backend/Player/LiascapePlayerMedia.cs` (the existing handlers are idempotent: `MarkCrashed`, `MergeSceneLoudness` keeps the longest; a drained `scene.vram_exceeded` only logs)

**Interfaces:** `<state>/outbox.jsonl`, one line `{seq, t_wall, kind, fields}`. `seq` is monotonic across restarts (read from the last line at start). Lines are appended `O_APPEND`, one write per line; at most `OUTBOX_MAX` = 2000 lines (the oldest dropped at compaction, `outbox.dropped {n}`). `outbox.read {after?: u64, limit?: 500}` → `{events, last_seq, dropped_before: u64|null}`; `outbox.ack {seq}` → `{}` (compacts everything ≤ seq on `lia-snapshot`).

- [ ] **Step 1: Write failing tests:**
  - api:
    - `outbox_persists_across_restart_and_acks`: a broken synthetic scene and a `scene.loudness` (short window env) → 2 entries; `quit` + `serve` → `outbox.read` returns them; ack → empty; seq continues.
    - `outbox_is_bounded`: 2500 appends → 2000 kept, `dropped_before` set.
    - `live_events_carry_outbox_seq`.
  - IT: with the backend TERMed, a scene breaks and another learns its loudness → backend start → index `crashed: true` + `loudnessI` stored ≤ 2 s after `Subscribed`; the outbox is empty after the ack.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** crate suite (both modes) + IT PASS.
- [ ] **Step 5:** Commit `Keep A Player Outbox For The Backend`.

**Size: M.**

### Task 10: The Pause-when-covered setting

**Files:** `src/backend/Models/AppSettings.cs` (`PauseWhenCovered` = `"off"`, normalized to off|fullscreen|maximized), `src/backend/Web/ServerHost.cs` (`/settings` diff → `LiascapePlayerMedia.ApplyCoverSetting` — coalescible `player:pause_when_covered`, re-asserted per player process with the GPU settings), `src/backend/Helpers/FeatureHealth.cs` (`cover` row from `hello.health`), `app/ui/src/views/Settings.tsx` (Playback, liascape-player only: "Pause when covered" — Off / A fullscreen window / A fullscreen or maximized window; hint "Pauses picture and sound while every monitor showing the wallpaper is covered"; the health icon when `cover` is unavailable), `scripts/test-settings-merge.sh`, `.claude/rules/{session.md, web-ui.md}`

- [ ] **Step 1: Write failing checks:**
  - `test-settings-merge.sh`: the default `off` on a file without the key; a partial body keeps it; a bad value → `off`; a live change → `ctl get player.pause_when_covered`.
  - IT: a set → live on the player; a fresh player (not restored) → re-applied.
  - Matrix cell `cover:fullscreen` (Task 11).
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** merge + IT PASS; `npm run build` ok.
- [ ] **Step 5:** Commit `Add The Pause When Covered Setting`.

**Size: S.**

### Task 11: UI × player-state matrix — programs at the seams

**Files:** `app/shell/probe-matrix.js` (the step wait for "a queued keybind (`pending_action.txt`)" becomes "the program took it": a `program.current` after the step, or `prog:main.path` moved; the fuzz rule follows), `scripts/test-ui-matrix.sh` (opt-in states `programArmed`, `programHeld`, `coverHeld`; `headless.cover` driver), `scripts/matrix-cells-for.sh` (`recipes/program` → FULL), `.claude/rules/web-ui.md` § the matrix

- [ ] **Step 1: Add cells** (each RED first, against the base commit's backend via `LIASCAPE_MATRIX_DLL`, where the behaviour is new):
  - `programHeld × next|prev|random|plMinPlay|plMaxPlay|trash:shown`
  - `programArmed × plTrEffect|plOrder|playlistBarRemove:incoming`
  - `coverHeld × pause|next|volume|mute` (user pause and mute through the cover hold)
  - `restart:backend × programArmed` (no switch by the new backend; UI resyncs to `prog:main.path`)
  - `cli:next` with the backend down × playlist (via `liascape next` in the stack's env)
  - `cover:fullscreen` × playing/playlist/effect/pending
- [ ] **Step 2:** `bash scripts/test-ui-matrix.sh --only 'program|cover|restart:backend|cli:' --jobs 2` → the new cells fail on the base, pass on the branch.
- [ ] **Step 3:** The full run: `bash scripts/test-ui-matrix.sh --jobs 2` → `fail=0 error=0`. A cell failing under load reruns 2×; it is recorded as load only if it passes alone both times.
- [ ] **Step 4:** Commit `Cover Programs In The UI Matrix`.

**Size: M.**

### Task 12: On-machine battery and Phase 3 report

**Files:** `src/player/tests/onmachine/programs.sh` (+ `battery.sh programs`), `docs/player/reports/phase3.md`

- [ ] **Step 1 — dropout across program switches:** for each method (full-live, reveal, frozen) × {timer 6 s, on_end 4 s clips, on_end + max 3 s on 10 s clips, separate timing with SFW 431960 scenes}, 50 consecutive switches each, on DP-1 (144 Hz) and DP-2 (240 Hz). Expected: the detector `drops 0`, `micro_gaps 0`, handoff vs A's end ≤ 1 frame for full-live align:end.
- [ ] **Step 2 — app closed:** `liascape kill`, start the program through the app, close the app (Electron; the backend exits). Run a 1 h rotation: no `liascape-backend` process, every expected switch present (`ctl logs '{"kind_prefix":"program."}'`), CLI keybinds work (next/prev/random/toggle-pause/volume).
- [ ] **Step 3 — crash and restore:** 5 × `kill -SEGV` of the compositor mid-rotation (2 while armed) → each comes back at its item, armed ones re-armed, 0 `align:now` origins after a restart. Then `ctl quit` + `liascape restore` → resumed (Q4).
- [ ] **Step 4 — cover:** a fullscreen game-like window (kitty fullscreen, then a real fullscreen app if one is installed) over both outputs → paused ≤ 350 ms, `probe sources` all paused, CPU/GPU of the compositor drop; a rotation does not advance meanwhile; uncover → resumes. One output covered → keeps playing.
- [ ] **Step 5 — soak:** 2 h of a mixed program (videos, images, SFW scenes; timer 30 s; methods rotating) with the app closed. Expected: compositor RSS slope ≤ 0.5 MiB/min, worker count ≤ 2 + dying, VRAM flat ± 10 %, `programs` probe bounded (history ≤ 100). (The §11 8 h soak stays the switch-over bar's.)
- [ ] **Step 6 — owner-run checklist** (documented, not automated): a cold boot via `claude-reboot` (tell the owner first) with a timer program → restored at its item and rotating, before and without opening the app; a suspend/resume during a timer rotation → no catch-up switch (Review Focus 5); a VT switch.
- [ ] **Step 7:** Write `docs/player/reports/phase3.md` (every number, RED→GREEN for anything fixed). File each product finding as a follow-up in `docs/TODO.md`. Commit `Report Phase 3 On-Machine Battery`.

**Size: L.**

### Task 13: Docs sweep

**Files:**
- `docs/player/architecture.md`: §2 block model, with Program and Signal implemented; §3 a rotation switch end to end; §6 roadmap (Phase 3 done, the auto-mute Signal still PARKED).
- `docs/player/invariants.md`:
  - **#12** "A rotation's clock is the player's: it never advances while the picture is paused, held or parked" — enforced by `pause_freezes_the_rotation`, `cover_hold_freezes_a_program`, `no_output_holds_the_rotation…`.
  - **#13** "One owner of a session's schedule — the player; the backend only requests" — enforced by the IT's origin check and the `legacy rotation path reached` guard.
- `docs/player/debugging.md`: rows for "didn't switch" → `probe programs` phase/played/remaining; "switched early" → `program.current.reason`; "stuck after failures" → `backoff_ms`; "paused by itself" → `cover.engaged` / `player.cover_hold_active`.
- `.claude/rules/player-core.md`: § Program, § Signals, § Outbox, the Snapshot/Command API rows.
- `.claude/rules/player-adapter.md`: § Rotation now says where each rule lives; § Dispatch points; § Reconnection (`Reapply` program).
- `.claude/rules/{session.md, player.md, web-backend.md}`: the daemons and pending IPC are legacy-only.
- `CLAUDE.md`: the CLI section, the architecture note.
- `docs/TODO.md`: tick Phase 3; add the deferred items below.

- [ ] **Step 1:** Update; `cargo test -q --test credits` PASS. **Step 2:** Commit `Document Programs And Signals`.

**Size: S.**

---

## Composition coverage ("Features must compose")

| composition | how it is tested |
|---|---|
| pure-timed (timer) | T3 `timer_mode_switches_every_interval`, `timer_countdown_scales_with_speed`, `timer_one_item_never_switches`; T7 IT; T12 step 1 |
| advance-on-end, min / max / 0 = off | T3 `on_end_*`, `min_hold_*`, `max_*`, `zero_means_off_for_both`; T7 IT (today's § play-time limits); matrix `playlist:minPlay\|maxPlay` |
| separate scene timing (+ images) | T3 `scene_switches_after_*`, `separate_off_*`, `image_*`; T7 IT; matrix `playlist\|global:sceneTiming` |
| manual next / prev / random (+ mid-wait, mid-effect, storm, 1-item, at start) | T4; T7 IT; T8 CLI storm; matrix `seq:*`, `programHeld\|Armed × next…` |
| restore (ResumeFromLast on/off, no snapshot, stop→play) | T5 `quit_then_restore_*`; T8 IT; T12 step 3/6 |
| V→V / V→S / S→V / S→S × methods | T3 `every_switch_combo`; T12 step 1 |
| pause (user, keep_pause cut, StayPausedWhenSwitching) | T4 `keep_pause_*`; T5 `pause_freezes_the_rotation`; matrix `paused × *` |
| low-VRAM hold, VRAM-stopped scene, broken scene | T3 `vram_stopped_*`, `broken_scene_*`; T5 `vram_hold_*`; T9 IT |
| transitions in flight (edits, next, cover, crash) | T4 `next_during_running_*`, `live_transition_change_*`; T6 `cover_hold_mid_transition_*`; T5 `program_survives_a_crash` |
| hotplug / no-output parking | T5 `no_output_holds_*`, `hotplug_mid_program_switch_adopts` |
| player crash / restart / upgrade (snapshot lag, 4th restart) | T5; T7 `Reapply`; T8 upgrade check |
| app closed vs open, backend restart, two backends | T8 IT; T9 IT; matrix `restart:backend × programArmed`; T12 step 2 |
| keybind actions from the CLI (app open / closed) | T8 IT; matrix `cli:*`; T12 step 2 |
| settings live (interval, min, max, scene timing, transitions, method, order, items, volume/speed/override/normalization/NoAudio/mute) | T4 `live_*`; T7 IT; `test-settings-merge.sh`; matrix `set:*`, `pl*`, `g*` |
| list edits (reorder, add, trash shown / armed, undo) | T4 `items_*`, `removing_*`, `undo_*`; matrix `trash*`, `playlistBar*` |
| auto-mute (parked, backend) × program B's | T7 IT: a B created while auto-muted comes up muted (`defaults.gain.mute`); matrix `autoMute*` unchanged |
| failures (garbage file, all unplayable) | T3 `failed_item_*`, `all_items_unplayable_*` |
| pause-when-covered × pause / mute / next / rotation / one of two outputs | T6; T11 `coverHeld × …` |

---

## Risks and fallbacks

1. **Porting the rotation loses an edge case.** The C# encodes ~20 matrix-found fixes (commit at effect start, re-arm on a minimum change, the pre-fetch taken by max/next, history after random, 1-item ticks). *Fallback:* the adapter IT and the UI matrix check HTTP/UI-level behaviour regardless of engine, and they are the oracle. Each RED → GREEN run uses the base backend (`LIASCAPE_IT_DLL` / `LIASCAPE_MATRIX_DLL`). Each Rust function names the C# function it ports.
2. **Hyprland's foreign-toplevel reports a fullscreen window on a hidden workspace as activated** (or misses states). *Fallback:* Task 6's spike decides before any rule ships. Use Hyprland socket2 (`activewindowv2`, `fullscreen`, `workspace`) behind an instance check, or ship fullscreen-only. The setting stays Off by default either way (Q1).
3. **Snapshot I/O grows with the program** (300 items × props, fsync'ed). *Fallback (built in):* `program.json` is written only on a config change; the snapshot carries only the cursor, history and clocks (history ≤ 100 paths).
4. **A legacy rotation path still runs under liascape-player** (a missed dispatch → two schedulers, the old "two timer owners" storm). *Fallback:* the guard log line + the IT's "no origin `api` switch during a rotation" check + the files-never-written check.
5. **Unmeasured videos play un-normalized while the app is closed** (the loudness measure is a backend job). *Mitigation:* `Load`/`SetItems` kick `EnsureLoudnessAsync` for every unmeasured item, so only an item never measured before the app closed is affected. Measuring in the player is a later option, not Phase 3.
6. **The CLI keybind latency stays .NET's startup** (~150–300 ms) with the app closed. Not a regression; noted. A `liascape` launcher fast path (`ctl` straight to `program.next`) is possible later.

## Deferred (not Phase 3)

The in-player auto-mute Signal and `monitor-daemon`'s retirement (PARKED, Q3). Per-monitor programs (the node supports one per output alias; the user-facing feature is its own follow-up project). Deleting the legacy rotation and daemon code (Phase 5). Renaming `IntervalSeconds` to the UI labels (docs/TODO.md). Mute/stop variants of the cover action (WE's "Mute"/"Stop"). Loudness measurement of videos in the player.
