# liascape-player — Phase 3 (Programs and Signals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rotation runs inside `liascape-player`, with the same rules users see today: timed playlists, "Switch when video ends" with a minimum and maximum play time, "Separate timing for scenes", shuffle, history (next/previous), random and restore. When a playlist starts again it either resumes where it left off or starts over (a new per-playlist setting). A new Signal pauses the wallpaper when a fullscreen or maximized window covers it (on by default). The backend no longer needs its timer daemon, restart daemon, `pending_action.txt` or the `timer.pid`/`gui_timer.pid` ownership: under `PlayerEngine=liascape-player` it starts none of them. Rotation keeps going with the app closed, survives a player crash, and stays the same for the UI.

**Architecture:** A rotation is a graph node, `prog:<name>` (kind `program`). Its settings are ordinary live properties, so a `set` reaches the running rotation the same way every other setting does. Its items carry their source create props. A recipe next to the transition recipe, `recipes/program/`, reads the node and the events. On the player clock it decides when to request a `transition` on the program's outputs, and with which item and effect. It never renders and never touches a source. The backend keeps the library, the settings and the R61 resolver. It turns a playlist into a program spec, sends user switches as four thin verbs, and mirrors what plays from the program's events. Pause-when-covered is a Signal: `out:<c>.covered` is observed from wlr-foreign-toplevel. A rule turns it into a player-level hold, composed the same way as the Phase 2 low-VRAM hold, so invariant #7's pause machinery covers it unchanged.

**Tech Stack:** Rust 1.96 (edition 2024, the `liascape-player` crate) · smithay-client-toolkit 0.21 (+ `wayland-protocols-wlr` `zwlr_foreign_toplevel_manager_v1` v3) · C# .NET 10 (adapter) · React (one Settings row) · the existing hermetic scripts.

**Spec:** `docs/superpowers/specs/2026-10-20-utopia-player-design.md`: §4.2 Program/Signal/Clock rows, §4.3 recipes ("Video-end-aligned advance", "Pause when fullscreen"), §4.4 (the backend's role), §10 parity (modes, keybinds, compose matrix), §11 bar, §12 item 3. What exists already: `.claude/rules/player-core.md` (§ Graph, § Transition recipe, § Runtime, § Command API, § Supervisor, § Snapshot), `.claude/rules/player-adapter.md` (§ Dispatch points, § Rotation, § Reconnection, § Lifecycle), `.claude/rules/session.md` § Timed Playlist, `.claude/rules/player.md` § Centralized Helpers / § One timer owner / § Restart Daemon. Executors read all of these. The C# code being ported is the reference for every rule this plan names: `src/backend/Helpers/PlayerHelper.cs` (`Tick`, `ItemPlayRule`, `HoldForMinPlay`, `AdvanceToNext`, `RandomAndLaunch`, `StepBackAndLaunch`, `ReorderPlaylist`, `UpdateTimedSettings`, `PostSwitch`, `DispatchPendingAction`) and `TransitionService.PickEffect/PickDuration/Pick`.

---

## Decisions

**Owner decisions this plan rests on** (stated before 2026-10-29):
- Phase 3 scope is spec §12 item 3. The in-player auto-mute Signal was PARKED (2026-10-28); on 2026-10-29 the owner allowed it back **as an optional last task, only if it is a strict upgrade** (O5, Task 14). Until it passes, `AudioMonitor` stays as it is, for both engines.
- The owner uses the `liascape-player` engine only. The legacy engine may break, and no work goes into it. Phase 5 deletes it, this phase does not.
- The rotation model (2026-10-28, `player-adapter.md` § Rotation) is the contract, kept exactly. It is listed verbatim under Global Constraints.
- `StayPausedWhenSwitching` (2026-10-25). Off: a user switch while paused resumes and then switches. On: the pause stays and the switch is a cut to B's first frame, paused.
- A broken scene playing in a rotation advances to the next item at once (Phase 2, round 2). A crashed scene is skipped unless whitelisted (D6).
- No migration code (the owner is the only user). Settings apply live. Features must compose.

**Owner decisions, 2026-10-29** (answers to this plan's open questions):
- **O1 — Pause when covered: on by default**, mode "a fullscreen or maximized window". The wallpaper pauses only when every monitor showing it is covered. Off and fullscreen-only stay selectable (designer call 9, Task 6, Task 10).
- **O2 — Rotation while no monitor shows the wallpaper: keep rotating invisibly by default** (today's behaviour). A setting holds it until a monitor returns instead. That setting lives in a **new "Expert" settings group**, hidden unless a new **"Show expert options"** toggle is on; future expert-only settings use the same mechanism (designer calls 3 and 12, Tasks 3, 5, 10).
- **O3 — Keep `monitor-daemon`** until Task 14 passes its parity bar (designer call 5).
- **O4 — Where a playlist resumes is a playlist setting.** Owner: "checkbox in playlist setting, 'always start with the first wallpaper': sequential = always first to last, shuffle = play first and then shuffle as normal; another toggle for toggling between exact spot and normal shuffle/sequential … probably make changing this setting smarter". Revised by the owner the same day: **one choice only**, "When the playlist starts again" = **Start over** (default; sequential from the first wallpaper, shuffle reshuffles) | **Resume where it left off** (exact item, time and play time). The "always start with the first wallpaper" checkbox is **dropped** (no real use-case). It has a global default and a per-playlist override like the other rotation settings (§ Playlist start, designer call 11, Task 5b).
- **O5 — Auto-mute:** the current one works fine. The in-player rework may be done **if it is a strict upgrade**: an optional last task (Task 14) with explicit parity criteria against today's `AudioMonitor`. Only when it meets every one does it replace `AudioMonitor` and retire `monitor-daemon`; otherwise the current one stays.

**Designer calls (my call; the owner can override any of them):**
1. **One node, one recipe.** `prog:<name>` holds every setting as a live property. `create`/`set`/`get`/`destroy` are the generic verbs. `program.play|next|prev|random` are thin recipes over `transition` (spec §4.2). The backend uses one program, `prog:main` on `out:*`, for every rotation session: timed, advance-on-end, and Play All with more than one item. **A single applied wallpaper stays a plain `transition`.** Next/previous/random on a single wallpaper stay the backend's library step (`TryStepLibrary`, `ApplyRandomNow`), because they need the library order.
2. **Settings stay the backend's.** The program holds `defaults` (the globals' desired source props) and per-item `props` (only where an item differs: overrides, `af`, `gain.normalize`, `scene_props`, `kind`, `preview`, `loudness_seed`). B's create props = `defaults` with the item's `props` merged over them, shallowly. That merge *is* "override ?? global", and the player does not know it: R61 (`LiascapePlayerMedia.Desired`) stays the one authority, and it now also writes `defaults` and the item props.
3. **The rotation's clock is the player clock** (`Runtime::now`, pause-excised). Play time and the countdown stop when the picture stops: during a user pause, the low-VRAM hold and the cover hold. **While no output shows the program's item (parked)**, the program follows `while_parked` (O2):
   - `rotate` (default) is today's behaviour exactly. Play time and the countdown keep counting. Timer, maximum and "Switch scenes after" switches go through `transition_parked` (each replaces the parked wallpaper, invisibly). An end-of-video switch waits, because the parked A is paused and never ends — as the backend's `AlignedWaitCheck` waits today.
   - `hold` stops both clocks until an output shows the item again.
4. **The program persists across player restarts.** Its configuration and order go in `<state>/program.json`, written only when they change. Its dynamic state (cursor, history, play time, countdown) goes in `snapshot.json`. A crash restart or an in-place upgrade always resumes the program exactly and re-arms an end-of-video switch by itself. What a *start* does — boot, Play, coming back to a playlist — is § Playlist start.
5. **The daemons, under `liascape-player`:** `timer-daemon`, `restart-daemon`, `pending_action.txt`, `timer.pid`, `gui_timer.pid` and `timed_state.json` are never started, written or read. Their code stays for legacy until Phase 5 deletes it. Every `PlayerHelper` entry point that reaches them gets an `IsLiascapePlayer` dispatch at the top, the existing pattern. **`monitor-daemon` stays** (O3): it *is* `AudioMonitor` running with the app closed, until Task 14 passes its parity bar.
6. **What the backend must persist while it is away goes into a player outbox.** These are facts that the timer daemon stored as a backend process: `source.broken` (→ `MarkCrashed`), `scene.loudness` (→ the index), `scene.vram_exceeded` (UI text only). `<state>/outbox.jsonl` is append-only, bounded and acked. The backend drains it on every (re)subscription.
7. **The effect pick moves into the player** (`recipes/program/pick.rs`) with today's rules. Sequential cycles through the enabled set; shuffle never repeats the last effect. The duration is uniform in `[duration_ms, duration_max_ms]`, and 0 ms is a cut. The method comes from the program's `transition.method`, and the params are the catalogue's uniform defaults (as `TransitionService.Pick` sends them).
8. **Failures never spin.** A switch that fails (B errors, or is not ready in 10 s) backs off 1 s, 2 s, 4 s … up to 30 s while failures continue in a row; a handoff resets the backoff. After the backoff the program switches, `align: now`, to the next playable item after the failed one. When nothing is playable it logs `program.empty` once and holds what is shown.
9. **Pause-when-covered** (⚠ revise before Task 6 — rules recon 2026-10-29, `docs/superpowers/specs/2026-10-29-rules-recon.md` §1: `activated` = keyboard focus, so a fullscreen game on DP-1 stops covering the moment the user clicks DP-2. "Covered" must mean *visible*: on Hyprland a monitor's active/special workspace holds a client with `fullscreen` ≥ the mode — re-query `j/monitors` + `j/clients` on socket2 events, since the `fullscreen` event carries no window; Hyprland's `visible` field is not on-screen; Sway's `visible` is reliable; elsewhere fall back to fullscreen-on-that-output regardless of focus): a toplevel that is activated, not minimized, and fullscreen (or maximized, depending on the mode) on an output covers that output. The hold engages when *every* output showing content is covered for `COVER_ENGAGE_MS` = 300 ms, and releases at once. With the same wallpaper on every output, a game fullscreen on one monitor leaves the wallpaper playing on the other (it is still visible, and audio follows the picture). New setting `PauseWhenCovered` = `off` | `fullscreen` | `maximized` ("fullscreen or maximized"), **default `maximized`** (O1). The player prop's own default stays `off`, so a raw `ctl`/test player never pauses by itself; the backend asserts the setting on every player process, as it does the GPU settings, and a crash restart keeps it through the snapshot's player props.
10. **Engine switch away from `liascape-player`** replays `LastSession` from the top on legacy. Nothing more is spent there. Legacy → `liascape-player` loads the program from `timed_state.json` at the item it was on (a cheap read of a file legacy already writes).
11. **Playlist start is decided in the player** (O4, § Playlist start). Each program carries its playlist's identity (`key`) and `start_mode`. The player keeps a resume point per key in `<state>/resume.json`: it is written whenever a keyed program is stopped, replaced or destroyed, and kept whatever the setting, so switching from Start over to Resume later still finds a point. `program.play {from: "start" | "resume" | "index"}` applies the rules. Boot passes `--session-start` so the snapshot's program starts per its mode with no flash of the old item; a crash restart or upgrade never passes it.
12. **Expert options** (O2) are a UI tier, not a backend concept.
    - `AppSettings.ShowExpertOptions` (default false, in settings.json — per user, like `AdvancedSettings`) is a checkbox row "Show expert options" in Settings → Advanced, directly under "Advanced settings", always visible.
    - `Row` gains an `expert` prop: an expert row renders nothing unless the toggle is on. An `<ExpertSection>` (Settings → "Expert", last on the page) renders only while the toggle is on.
    - Each expert row carries a small "Expert" tag, so a screenshot shows where a setting lives.
    - Expert settings are ordinary settings: saved and applied live whether or not the group is shown. Hiding a row never resets its value, and a non-default expert value shows the existing "deviated" marker on the "Show expert options" row while the group is hidden, so a setting changed and then hidden is never forgotten.
    - The first expert setting is `RotateWhileParked` ("When no monitor shows the wallpaper": Keep rotating — default | Hold until a monitor returns), global only.
13. **`ResumeFromLast` ("Resume from last on launch") is folded into the playlist start setting.** Its row goes. A single wallpaper always comes back at its position on boot (the snapshot), and a playlist follows its "When the playlist starts again". No migration and no script: an old file's `ResumeFromLast` loads as an unknown key, and the new default (Start over) applies; the owner picks Resume in Settings if they want it.

---

## Playlist start — start over or resume (O4)

**The setting:** "When the playlist starts again" = `GlobalPlaylistStart` / `PlaylistSettings.PlaylistStart`, `start_over` (**default**) | `resume`. It has a global default and a per-playlist override under the existing "Override global rotation", like every other rotation setting; `EffectiveRotation` gains it. Nothing else — the owner dropped the "always start with the first wallpaper" checkbox (no real use).
- **Start over:** sequential → the playlist bar's first playable wallpaper; shuffle → a new shuffle (its first ≠ the last one played, so a restart never repeats what was just on).
- **Resume where it left off:** the exact item, its time and its play time (and the timer's remaining). A shuffle continues its own order.

**What counts as "starts again", and what the setting does** (Task 5b tests the player rows; Tasks 7–8 the backend rows through the IT):

| event | Start over (default), sequential | Start over, shuffle | Resume | test |
|---|---|---|---|---|
| boot / `liascape restore` (player not running; `serve --restore --session-start`) | item 1 at 0 | a fresh shuffle | exact item, time, play time | T5b `session_start_*`; T8 IT `restore × mode`; T12 step 6 |
| app restart (Electron/backend), player still running | untouched: it never stopped | untouched | untouched | T8 IT "app closed" (no `transition.scheduled` origin `api`, `played_ms` monotone) |
| player crash / supervised restart / in-place upgrade | exact, always (recovery, not a start) | exact | exact | T5 `program_survives_a_crash`; T5b `crash_restore_ignores_start_mode` |
| Play on the playlist that is playing now | restarts at item 1 | a fresh shuffle | keeps playing where it is (a pause is lifted, I1) | T5b `play_same_key_*`; T7 IT |
| Play after `stop`, the `play` keybind, `toggle-play` | item 1 | a fresh shuffle | its resume point | T5b `play_after_stop_*`; T8 IT |
| another playlist (or a single wallpaper) played, then this one again | item 1 | a fresh shuffle | its own resume point, kept per playlist | T5b `switching_playlists_and_back_*`; T7 IT |
| Resume, but the resume item was removed / the list edited meanwhile | — | — | the item after its old place, at 0 (the reorder rule); order re-anchored | T5b `resume_after_edit_reanchors` |
| Resume, nothing to resume (first play, point aged out) | — | — | as Start over | T5b `resume_without_point_starts_over` |
| play-from (a specific card or playlist-bar item clicked) | that item at 0 — every column: an explicit choice beats the setting | | | T5b `play_index_beats_start_mode`; matrix `seq:*` |

- **The playlist's identity (`key`)** = `name:<saved name>` for a loaded/saved playlist, else `bar` (the unsaved playlist bar). "Save as" makes a new key; the old point ages out.
- **Resume points** are kept in `<state>/resume.json` whatever the setting, so switching to Resume later still finds one. At most 50 keys, least recently used dropped. Each entry: `{order, idx, history, hist_idx, path, time_pos, played_ms, remaining_ms, last_effect, saved_unix_ms}`.
- **Live** (settings apply live): a change while a playlist plays is a `set prog:main.start_mode`. It takes effect at the **next start** and never jumps the current play (T5b `start_setting_change_never_jumps_the_current_play`). The row's hint says so while a playlist plays: "Takes effect the next time this playlist starts — what's playing now carries on".
- **Single wallpaper:** on boot it comes back at its position (the snapshot). There is nothing to start over.

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
- **Playlist start contract:** § Playlist start's table, verbatim. A crash restart, an upgrade and an app restart never count as a start. An explicit play-from beats the setting. A setting change applies at the next start only.
- **Parked:** `while_parked` = `rotate` (default) reproduces today's backend exactly: play time and the countdown count; timer/max/scenes-after switches replace the parked wallpaper (`transition_parked`); an end-of-video switch waits. `hold` stops both clocks.
- **Cover:** `PauseWhenCovered` defaults to `maximized` (fullscreen or maximized) in AppSettings; it engages only when every output showing content is covered.
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
src/player/src/recipes/program/resume.rs  resume.json (per-playlist resume points, LRU 50) + the start rules (§ Playlist start)
src/player/src/signal/{mod,covered}.rs    the covered Signal: Toplevels tracker, CoverState, the cover rule
src/player/src/outbox.rs                  <state>/outbox.jsonl: append, read, ack, bound
src/player/src/signal/automute.rs, audio/foreign.rs   optional Task 14: the in-player auto-mute Signal
src/player/src/graph/{mod,props}.rs       NodeKind::Program, PropValue::Items, schema; out:<c>.covered; player.pause_when_covered
src/player/src/runtime.rs                 Programs + cover hold in the tick (R47 order), update_player_paused, park/unpark hooks
src/player/src/snapshot.rs                `programs` (dynamic state), restore order
src/player/src/api/handlers.rs            program.* verbs, headless.cover, outbox.read/ack, state.programs, hello caps
src/player/src/probe/programs.rs          `programs` probe
src/player/src/wl.rs                      zwlr_foreign_toplevel_manager_v1 binding → Toplevels
src/player/tests/program.rs               new test target (stepped headless, clips + synthetic scenes)
src/backend/Player/LiascapePlayerProgram.cs  the adapter's program half (spec builder, verbs, mirror, R81, outbox)
src/backend/Helpers/PlayerHelper.cs, Web/{ServerHost,AppOps}.cs, Program.cs   dispatches + lifecycle
src/backend/Models/{AppSettings,CustomPlaylist}.cs   PauseWhenCovered, RotateWhileParked, ShowExpertOptions, (Global)PlaylistStart
app/ui/src/views/Settings.tsx, app/ui/src/components/PlaylistSettingsModal.tsx   the rows, the Expert group + `Row expert`
scripts/test-liascape-player-adapter.sh, scripts/test-settings-merge.sh, scripts/test-ui-matrix.sh, app/shell/probe-matrix.js
```

**Order:** 1 → 2 → 3 → 4 → 5 → 5b → 7 → 8 → 10 → 11 → 12 → 13 → (optional) 14. Task 6 (cover) and Task 9 (outbox) need only Task 2 and can run beside 3–5, but no more than 2 agents at once (memory "Subagent cap"). Task 10 follows 6, 5b and 7.

**Sizes:** S ≤ ½ day, M ½–1½ days, L 1½–3 days of focused agent work. Total ≈ 19–25 days for Tasks 1–13 (the owner's answers added ≈ 3: Task 5b, the parked mode, the Expert tier, the start-mode rows), plus whatever Task 12 finds; optional Task 14 ≈ 2½–3½ more.

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

> **Implementer note 2026-10-29 (Task 1):**
> - No seedable RNG was in the tree; rather than add `rand`/`rand_pcg` (a new crate in `Cargo.lock` and the flake's vendored deps) `recipes/program/mod.rs` has a 30-line SplitMix64 `Rng` (`new(seed)`, `below(n)`, `shuffle`). Signatures take `rng: &mut Rng` instead of `impl Rng`.
> - `Order::plan_play` returns `Option<Step>` (`None` for an empty order; the index is clamped), not `Step`.
> - `min_reached(played, None, min)` is `played ≥ min` as specified here; the C# added the 150 ms slack there too (its ≤ 1 s poll's tolerance) — at most 150 ms later for a still image.
> - `still_min_reached`: a scene needs `min > 0` (`SceneMinReached`); an image with min 0 is reached at once (`HoldForMinPlay`).
> - `Order` keeps the last item list it was given (`bar`) as `ReorderPlaylist`'s `previousPaths`; a step planned before a reorder and committed after it re-seats the cursor at its path.
> - `Pick` gains `picked: Option<String>` — the program's next `last_effect` (`PickEffect` moves the cycle even when the duration then makes it a cut; a single effect is not recorded, as in C#).

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

> **Implementer note 2026-10-29 (Task 2):**
> - Verb replies always carry `index` (−1 with nothing to do); `program.play` with an index past the end is `out_of_range`. `state.programs[].items` is the item count, `order` the play order; the probe adds `item_flags`.
> - A program node never moves `picture_rev`/`demand_rev` on create/destroy; a `set` on it still does (the `Graph::apply_set` lines are mid-edit by F6b — left alone).
> - The `transition`/`cancel` verbs and an output removal used to drain-and-drop the transition outbox; they now stash it (`Runtime::stash_tr_events`) so the programs see every event with the next tick.
> - No event field may be called `kind`: it overwrites the log record's own `kind` (the event name).
> - The Task 2 docs (`player-core.md` § Programs + Command API rows) landed inside commit 7528abf — another agent committed the whole working-tree file.

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
              player_now: Duration, parked: bool) -> Vec<ProgramAction>;  // parked → per `while_parked`            // after Transitions::tick, before refresh_srcs (R47)
  pub fn status(&self) -> Vec<ProgramStatus>;
}
pub enum Reason { Play, Timer, End, Max, ScenesAfter, Next, Prev, Random, Broken, Vram, FailedSkip, Items } // = program.current.reason (snake_case)
pub struct PlayClock { /* accumulates player-clock deltas; while parked only under while_parked = rotate */ }
pub const BACKOFF_MS: [u64; 6] = [1000, 2000, 4000, 8000, 16000, 30000];   // then 30000 for as long as failures continue
```
- **B's create props:** `defaults` ∪ `item.props` (item wins), plus `path`, plus `loop: true` while a min-hold needs A to loop. `kind` comes from the item props, else from the extension the backend sends; the player's own image flag corrects it as today.
- **Commit:** at `transition.started` for the program's corr (B becomes current: `Order::commit(step)`, play time → 0, emit `program.current`, then arm the next per the rule). `handoff {committed: true}` also commits a step not yet committed (a missed `started`). A `cancelled {superseded}` caused by the program's own next request is ignored. A `cancelled` by another client (`origin: api`) drops the pending step, and the program follows what `cur:` now shows (its path, if it is an item, becomes current with reason `items`; else the program goes `idle` until the next verb).
- **On end:** with a video current and `CanRotate`, `plan_next` happens right after commit. If `min_reached` (with A's loop remaining = (duration − time_pos)/speed) → `Start align:end` now. Else `held`, with A's `loop` set true, and the request goes in during the loop that reaches the minimum. The maximum runs on the tick. A still (image/scene) uses `still_min_reached` on the tick (`align:now`).
- **Timer:** `remaining_ms -= Δplayer × speed(cur source)` (while parked only under `rotate`); at ≤ 0 with `interval_ms > 0` → `Start align:now`. A 1-item program resets to the interval.
- **Parked** (`while_parked`, Program prop `rotate|hold`, default `rotate`): under `rotate` a timer/max/scenes-after `Start` while no output exists goes through the runtime's `transition_parked` (it replaces the parked wallpaper; `transition.scheduled {parked: true}`), and an armed end-of-video switch waits (`parked_req`) as today; under `hold` the PlayClock and the countdown stop.
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

> **Implementer note 2026-10-29 (Task 3):**
> - **End switches are armed after the current effect's handoff**, not "right after commit": a request while the effect is Running commits it early (invariant #6 — a 500 ms fade would be cut at once). The C# `DoVideoEndWait` waited for the overlay too. `on_end_switches_at_each_end_aligned` asserts the arm lands well before A's end and the commits are clip − fade apart (full-live ends at A's end).
> - `max_beats_min`: a 10 s clip already reaches an 8 s minimum in its first loop, so its end is armed at once (as in C#); the 3 s cap then supersedes it and takes its B. The test asserts that, not "no arm".
> - Failures: the failed path is marked and passed over until the items change; when every playable item has failed, `program.empty` is logged once, the marks are cleared and the ladder retries them (≤ 6 requests in 60 s with 3 garbage files). Only skip/broken items → `empty` and nothing more until an edit.
> - Any `Error` from the current item's source other than a VRAM stop counts as `broken` (a video that dies mid-play too) and is marked.
> - While another client's transition is in flight the program requests nothing by itself; afterwards it follows `cur:` (an item → reason `items`, anything else → `idle`).
> - B gets `loop: true` under `on_end` with a minimum and > 1 item (so a short clip loops until the reaching loop even if its hold starts late).
> - `while_parked` is Task 5's prop: only `rotate` exists so far (timer/max/scenes-after go through `transition_parked` and commit at once; end switches wait).
> - `program.next|prev|random` already run (Task 4 owns their tests and the armed-B / running-effect rules); `keep_pause` while paused is a cut.
> - `every_switch_combo` counts playing sources — a live `video`/`scene` not ramped to −96 — not reveal's snapshot or a grave waiting to be destroyed. `countdown_survives_player_pause` was added (the pause half of Review Focus 5); the suspend half stays `countdown_uses_the_monotonic_player_clock`.

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

> **Implementer note 2026-10-30 (Task 4):**
> - A user verb while the program's own `align: now` request has not started yet goes on from *that* step (`Order::plan_after` commits it on a clone): `next` ×10 lands ten items on and the history holds each, as `AdvanceAndLaunch` advanced its cursor per request. `prev`/`random` chain the same way. Only an armed (`align: end`) switch is "taken" by `next`.
> - A live minimum/transition change cancels the armed switch at once (`program.disarmed`, debug) and keeps its step in `rearm`; the next tick re-arms it (or holds, if the new minimum isn't reached) to the same B. `rearm` is dropped when its item is removed or a commit/verb happens.
> - `items` edits cancel an armed B that is gone *or now skipped*; a pending `align: now` switch is left to finish.
> - `live_mode_toggle_keeps_played_time` also covers the `on_end → timer` cancel of an armed switch.

**Size: L.**

### Task 5: Programs × pause, VRAM hold, parking, hotplug, crash and restore

**Files:**
- Create: `src/player/src/recipes/program/store.rs`
- Modify: `src/player/src/graph/props.rs` (Program `while_parked` `rotate|hold`, default `rotate`), `src/player/src/snapshot.rs` (`#[serde(default)] programs: Vec<ProgramSnap>`; `VERSION` stays 1 — additive), `src/player/src/runtime.rs` (park/unpark → `parked` flag; the restore order: outputs → sources → programs), `src/player/tests/{program.rs, supervise.rs}`

**Interfaces:**
- `<state>/program.json` = `{version: 1, rev, programs: [{id, props (settable), order: {items, idx, shuffle}}]}`. It is written on `lia-snapshot` after a config/order change (debounced 250 ms like the snapshot), and never by the 2 s position refresh.
- The snapshot's `ProgramSnap = {id, rev, history, history_index, current_path, played_ms, remaining_ms, last_effect, failures, broken}`. A `rev` mismatch (one file lagging the other) → keep `program.json`'s order and re-anchor the cursor on `current_path`.
- **Restore:** the program is created after the snapshot's sources. Current = the restored shown source when its path is the saved `current_path`, else the program goes `idle` and logs `program.restore_mismatch`. Then the first tick arms per the rule (an on_end program with a video current re-arms `align:end` — the snapshot already saves an armed pre-Running switch as A where it plays).
- `stop` destroys every program. `quit` writes both files before `stop_all`.

- [ ] **Step 1: Write failing tests:**
  - `pause_freezes_the_rotation` (`program.rs`): timer 3000, `player.paused` for 5000 at played 1000 → the switch at t ≈ 8000; `remaining_ms` constant while paused.
  - `vram_hold_freezes_the_rotation`: the fake VRAM probe low → hold → no switch while held; resumes after the release.
  - `parked_keeps_rotating_invisibly_by_default` (O2): timer 3000, `headless.remove_output` ×2 → `phase: "parked"`; `transition.scheduled {parked: true}` every 3000 (± 1 step), exactly one per interval (no storm); an on_end video A parked → no request until an output returns; re-add → the LAST target shown, the rotation continuing.
  - `parked_hold_mode_holds_and_resumes` (`while_parked: hold`): no `transition.scheduled` for 10 s parked, `played_ms`/`remaining_ms` constant; re-add → the same item, the switch at the remaining time.
  - `parked_mode_is_live`: `rotate` → `hold` while parked stops the clocks at once; back to `rotate` resumes them.
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

### Task 5b: Playlist start — resume points and start modes (player side)

**Files:**
- Create: `src/player/src/recipes/program/resume.rs`
- Modify: `src/player/src/graph/props.rs` (Program `key` Str default `""`, `start_mode` `start_over|resume` default `start_over`), `src/player/src/recipes/program/{mod.rs, order.rs}` (`Order::new_start(paths, shuffle, avoid_first: Option<&str>, rng)` — a fresh shuffle whose first ≠ the last played), `src/player/src/api/handlers.rs` (`program.play {from}`), `src/player/src/main.rs` + `snapshot.rs` (`serve --session-start`: only meaningful with `--restore`; the supervisor never forwards it to a restarted child), `src/player/tests/program.rs`

**Interfaces:**
```rust
// resume.rs
pub struct ResumePoint { pub order: Vec<String>, pub idx: usize, pub history: Vec<String>, pub hist_idx: usize, pub path: String,
                         pub time_pos: f64, pub played_ms: u64, pub remaining_ms: u64, pub last_effect: Option<String>, pub saved_unix_ms: u64 }
pub struct ResumeStore { /* <state>/resume.json, ≤ RESUME_MAX_KEYS = 50, LRU; written on lia-snapshot */ }
impl ResumeStore { pub fn get(&self, key: &str) -> Option<&ResumePoint>; pub fn put(&mut self, key: &str, p: ResumePoint); }
pub enum StartFrom { Start, Resume, Index(usize) }
pub fn plan_start(items: &[String], skip: &dyn Fn(&str) -> bool, shuffle: bool, from: StartFrom,
                  point: Option<&ResumePoint>, rng: &mut impl Rng) -> StartPlan;   // the whole § Playlist start table, pure
pub struct StartPlan { pub order: Order, pub position: f64, pub played_ms: u64, pub remaining_ms: Option<u64>, pub resumed: bool }
```
- `program.play {id, from: "start" | "resume" | "index", index?, keep_pause?}`. A missing `from` = `index` with an index, else `start`. `from: "resume"` while the same key's program already plays → `{corr: null, resumed: true}`, nothing switched.
- A keyed program `put`s its point on destroy, `stop`, replacement and `quit`. `program.current` gains `resumed: bool`.
- `--session-start --restore`: each restored program with `start_mode: start_over` starts per `plan_start(Start)` instead of its saved item. The restore creates that item directly, so the old one is never shown.

- [ ] **Step 1: Write failing tests** (unit `resume::plan_start_*` for the pure table, plus `tests/program.rs` through the verbs, one per table row):
  - unit `plan_start_sequential_is_item_one`, `plan_start_shuffle_is_a_new_permutation` (seeded, ≠ the stored order, its first ≠ the point's last played), `plan_start_skips_a_skipped_first`.
  - `session_start_resume_is_exact`: `serve --restore --session-start` after `quit` → the same item, `time_pos` ± 2 s, `played_ms` kept, `program.current {resumed: true}`.
  - `session_start_start_over_never_shows_the_old_item` (the default): `start_mode: start_over` sequential → `cur:*` = item 1 at 0 from the first `state` that shows anything; no source of the saved item is ever created (`source.open` log).
  - `crash_restore_ignores_start_mode`: `start_over`, `kill -SEGV` → the same item and position (supervise.rs).
  - `play_same_key_resume_keeps_playing` / `play_same_key_start_over_restarts`: `program.play {from}` on the playing key → `{corr: null}` for resume (a paused player stays paused here: the backend lifts it, I1), a switch to item 1 for start_over.
  - `play_after_stop_resumes_its_point`: `stop`, then `create` + `program.play {from: "resume"}` with the same key → the saved item at its time.
  - `switching_playlists_and_back_resumes_each`: key A to its 3rd item, key B played, A again (resume) → A's 3rd item at its time; B again → B's point.
  - `resume_after_edit_reanchors`: A's point on item c, A's items now without c → the item after c's old place, at 0.
  - `resume_without_point_starts_over`.
  - `play_index_beats_start_mode`: `from: "index", index: 4` under either mode → item 4 at 0.
  - `start_setting_change_never_jumps_the_current_play`: `set start_mode resume` (and back) mid-play → no `transition.scheduled` within 5 s, `played_ms` monotone; the next `play {from:"start"}` follows it.
  - `resume_store_is_bounded`: 60 keys → 50, the least recently used gone.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** `--test program --test supervise` + the full suite in both modes PASS.
- [ ] **Step 5:** Commit `Resume Or Start Over When A Playlist Starts Again`.

**Size: M.**

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
      Dictionary<string, object?> Transition /*enabled, effects, shuffle, duration_ms, duration_max_ms, method*/,
      string Key /*name:<saved> | bar*/, string StartMode /*start_over|resume*/, string WhileParked /*rotate|hold*/);
  public static Spec BuildSpec(IReadOnlyList<string> paths, AppSettings s, PlaylistSettings? p, bool shuffle, int intervalSeconds, bool advance);
      // EffectiveRotation for max / scene timing; TransitionService.Effective + s.TransitionMethod; Defaults = DesiredGlobal();
      // Item.Props = SourceProps(path) minus the entries equal to Defaults; Skip = IsSkippedPath(path)
  public static void Load(Spec spec, string from /*start|resume|index*/, int index, bool keepPause);   // essential: destroy prog:main if present
      // (the player stores its resume point), create, program.play {from}; the same key already playing + resume → only the I1 unpause
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
| `ApplyTimedPlaylist`, `ApplyPlaylist` (> 1 item or any scene), `AppOps.PlayPlaylist/PlayFrom` | `Load(BuildSpec(…), from, index, keep)` — Play → `from` = the effective start mode (§ Playlist start), play-from → `index`; `_history`/`_timedPaths` not kept; `QueueNewSession` (I1) as today |
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
    - Playlist start through the HTTP routes: Play on the playing playlist, stop → Play, and A → B → A (saved playlists through `/playlist/load`), each under Start over (default) and Resume, per the § Playlist start table; `prog:main.key` = `name:<A>` / `bar`.
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
- **serve shutdown:** no `ReleaseTimer` / `SpawnTimerDaemon`. The `AudioMonitor` hand-off to `monitor-daemon` is unchanged (O3).
- **`liascape restore`:** `EnsureRunning(restore: true, sessionStart: true)` (`serve --restore --session-start`); the player applies each program's start mode itself (§ Playlist start). Once `hello` answers, if `state` shows a wallpaper or a program → done. With no snapshot content (first boot, after `stop`) → replay `LastSession`: `Load` with `from` = its effective start mode (a Resume finds its point in `resume.json`), `Apply` for a single one. `AudioMonitor.SpawnDetachedMonitor` when AutoMute (unchanged); never `SpawnTimerDaemon` / `SpawnRestartDaemon`.
- **`play` / `toggle-play`:** a program already active → nothing (as today's resume). Else `Restore`.
- **CLI keybinds with no app:** `ActionForward` fails → `AppOps.RunAction` → the program verbs straight to the player (`DrainLiascapePlayerBeforeExit` as today).
- **Files never touched:** `pending_action.txt`, `timer.pid`, `gui_timer.pid`, `restart.pid`, `timed_state.json`, `playlist_observer_paths.json` are never written. A stale one from a legacy run is ignored.

- [ ] **Step 1: Write failing IT checks:**
  - **App closed:** the backend TERMed mid-rotation → `program.current` events continue (≥ 2 in 10 s with no backend process: `pgrep -f liascape-backend` empty), and no `timer-daemon` / `restart-daemon` process appears. A restarted backend → `/current` = `ctl get prog:main.path` within 1 s, and no `transition.scheduled` origin `api` within 5 s.
  - **Files:** across the whole IT, under liascape-player, none of `pending_action.txt` / `timer.pid` / `gui_timer.pid` / `restart.pid` / `timed_state.json` exists.
  - **CLI storm, no backend** (Review Focus 1): 10 × `liascape next` in parallel → the program lands ten items on, ≤ 2 unpaused sources per output sampled every 100 ms.
  - **CLI with the app closed:** `liascape previous` / `random` / `toggle-pause` / `volume up` (the global and an overridden item) / `stop` / `play` → each reaches the player (`ctl` checks); `volume up` changes `prog:main.defaults.gain.user`.
  - **Restore** (one check per table row): after `ctl quit`, `restore` under Start over (default) → item 1 at 0 (sequential) / a new order (shuffle), the old item never shown; under Resume → the same item at its position (± 2 s), still a program. With no snapshot (`trash` it first) → `LastSession` per its mode. `stop`, then `play` → the same per its mode. Play on the playing playlist, and A → B → A, per the table.
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

### Task 10: Settings and UI — pause when covered, playlist start, the Expert tier

**Files:**
- `src/backend/Models/AppSettings.cs`:
  - `PauseWhenCovered` = `"maximized"` (O1), normalized to off|fullscreen|maximized.
  - `GlobalPlaylistStart` = `"start_over"`, normalized to start_over|resume.
  - `RotateWhileParked` = true.
  - `ShowExpertOptions` = false.
  - `ResumeFromLast` removed (designer call 13).
- `src/backend/Models/CustomPlaylist.cs` (`PlaylistSettings.PlaylistStart`, used with `OverrideGlobalSettings`).
- `src/backend/Helpers/PlayerHelper.cs` (`EffectiveRotation` gains `Start`).
- `src/backend/Web/{ServerHost.cs, AppOps.cs}` — every value goes out coalescible and re-asserted per player process, like the GPU settings:
  - `/settings` diffs → `LiascapePlayerMedia.ApplyCoverSetting` (`player:pause_when_covered`), `LiascapePlayerProgram.SetStartMode` / `SetWhileParked` (`program:start` / `program:parked`).
  - `/playlist/state` → `SetStartMode` for a playlist that overrides.
- `src/backend/Helpers/FeatureHealth.cs` (`cover` row from `hello.health`).
- `app/ui/src/views/Settings.tsx`:
  - Playback, liascape-player only: "Pause when covered" — Off / A fullscreen window / A fullscreen or maximized window (default); hint "Pauses picture and sound while every monitor showing the wallpaper is covered"; the health icon when `cover` is unavailable.
  - Rotation: "When the playlist starts again" — Start over / Resume where it left off; hint per value ("Sequential starts from the first wallpaper, shuffle shuffles anew" / "The same wallpaper, at the same moment"), plus "Takes effect the next time the playlist starts — what's playing now carries on" while a playlist plays.
  - The "Resume from last on launch" row removed.
  - Advanced: "Show expert options" under "Advanced settings".
  - Expert section (last): "When no monitor shows the wallpaper" — Keep rotating / Hold until a monitor returns.
- `app/ui/src/components/PlaylistSettingsModal.tsx` ("When the playlist starts again" under its override, showing the global value it overrides).
- `app/ui/src/components/` (the `Row` `expert` prop + `ExpertSection`, its deviated marker — designer call 12).
- `app/ui/src/{store/index.ts, api/client.ts}` (the new keys).
- `scripts/test-settings-merge.sh`, `.claude/rules/{session.md, web-ui.md}` (§ "Expert options": how to mark a row expert, for future settings).

- [ ] **Step 1: Write failing checks:**
  - `test-settings-merge.sh`:
    - the defaults (`maximized`, `start_over`, `RotateWhileParked` true, `ShowExpertOptions` false) on a file without the keys; partial bodies keep them; bad values normalized;
    - an old file's `ResumeFromLast` loads and is gone from GET and the next save;
    - live: `ctl get player.pause_when_covered`, `prog:main.start_mode`, `prog:main.while_parked`;
    - a playlist's own `PlaylistStart` beats the global one only with its override on.
  - IT: each set → live on the player, the current play untouched (`played_ms` monotone, no `transition.scheduled`); a fresh player (not restored) → re-applied.
  - UI probe (`--probe` or matrix cells, Task 11):
    - the Expert section and every `expert` row absent with the toggle off; present with it on; the toggle persists across a reload;
    - a non-default expert value with the toggle off → the deviated marker on the Advanced "Show expert options" row;
    - hiding never changes the value;
    - the start choice and its hint in Settings and in the playlist modal.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** merge + IT PASS; `npm run build` ok.
- [ ] **Step 5:** Commit `Add Cover, Playlist Start And Expert Settings`.

**Size: M.**

### Task 11: UI × player-state matrix — programs at the seams

**Files:** `app/shell/probe-matrix.js` (the step wait for "a queued keybind (`pending_action.txt`)" becomes "the program took it": a `program.current` after the step, or `prog:main.path` moved; the fuzz rule follows), `scripts/test-ui-matrix.sh` (opt-in states `programArmed`, `programHeld`, `coverHeld`; `headless.cover` driver), `scripts/matrix-cells-for.sh` (`recipes/program` → FULL), `.claude/rules/web-ui.md` § the matrix

- [ ] **Step 1: Add cells** (each RED first, against the base commit's backend via `LIASCAPE_MATRIX_DLL`, where the behaviour is new):
  - `programHeld × next|prev|random|plMinPlay|plMaxPlay|trash:shown`
  - `programArmed × plTrEffect|plOrder|playlistBarRemove:incoming`
  - `coverHeld × pause|next|volume|mute` (user pause and mute through the cover hold)
  - `restart:backend × programArmed` (no switch by the new backend; UI resyncs to `prog:main.path`)
  - `cli:next` with the backend down × playlist (via `liascape next` in the stack's env)
  - `cover:fullscreen` × playing/playlist/effect/pending (+ `cover:default` — a fresh settings file pauses on a maximized cover)
  - `plStart:startOver|resume` × playlist/pending (Play again, stop → play, A → B → A through the Load/Save modals, per § Playlist start; the current play never jumps when the choice changes)
  - `parked:rotate|hold` × playlist (outputs removed: rotating invisibly by default, held in the expert mode)
  - `expert:toggle` (the Expert section hidden by default, shown when on, the value kept while hidden, the deviated marker)
- [ ] **Step 2:** `bash scripts/test-ui-matrix.sh --only 'program|cover|plStart|parked|expert|restart:backend|cli:' --jobs 2` → the new cells fail on the base, pass on the branch.
- [ ] **Step 3:** The full run: `bash scripts/test-ui-matrix.sh --jobs 2` → `fail=0 error=0`. A cell failing under load reruns 2×; it is recorded as load only if it passes alone both times.
- [ ] **Step 4:** Commit `Cover Programs In The UI Matrix`.

**Size: M.**

### Task 12: On-machine battery and Phase 3 report

**Files:** `src/player/tests/onmachine/programs.sh` (+ `battery.sh programs`), `docs/player/reports/phase3.md`

- [ ] **Step 1 — dropout across program switches:** for each method (full-live, reveal, frozen) × {timer 6 s, on_end 4 s clips, on_end + max 3 s on 10 s clips, separate timing with SFW 431960 scenes}, 50 consecutive switches each, on DP-1 (144 Hz) and DP-2 (240 Hz). Expected: the detector `drops 0`, `micro_gaps 0`, handoff vs A's end ≤ 1 frame for full-live align:end.
- [ ] **Step 2 — app closed:** `liascape kill`, start the program through the app, close the app (Electron; the backend exits). Run a 1 h rotation: no `liascape-backend` process, every expected switch present (`ctl logs '{"kind_prefix":"program."}'`), CLI keybinds work (next/prev/random/toggle-pause/volume).
- [ ] **Step 3 — crash and restore:** 5 × `kill -SEGV` of the compositor mid-rotation (2 while armed) → each comes back at its item, armed ones re-armed, 0 `align:now` origins after a restart. Then, for each start mode (Start over sequential / Start over shuffle / Resume), `ctl quit` + `liascape restore` → the § Playlist start row "boot".
- [ ] **Step 4 — cover:** a fullscreen game-like window (kitty fullscreen, then a real fullscreen app if one is installed) over both outputs → paused ≤ 350 ms, `probe sources` all paused, CPU/GPU of the compositor drop; a rotation does not advance meanwhile; uncover → resumes. One output covered → keeps playing. Default settings (no `PauseWhenCovered` key) pause on a maximized window too (O1).
- [ ] **Step 4b — no monitor:** both outputs disabled (`hyprctl keyword monitor DP-1,disable`, then DP-2; re-enabled after) during a timer rotation → it keeps rotating invisibly (one `transition.scheduled {parked: true}` per interval) and the last target shows on re-enable; with the Expert "Hold until a monitor returns" → nothing switches, and the same item resumes.
- [ ] **Step 5 — soak:** 2 h of a mixed program (videos, images, SFW scenes; timer 30 s; methods rotating) with the app closed. Expected: compositor RSS slope ≤ 0.5 MiB/min, worker count ≤ 2 + dying, VRAM flat ± 10 %, `programs` probe bounded (history ≤ 100). (The §11 8 h soak stays the switch-over bar's.)
- [ ] **Step 6 — owner-run checklist** (documented, not automated): a cold boot via `claude-reboot` (tell the owner first) with a timer program → restored at its item and rotating, before and without opening the app; a suspend/resume during a timer rotation → no catch-up switch (Review Focus 5); a VT switch.
- [ ] **Step 7:** Write `docs/player/reports/phase3.md` (every number, RED→GREEN for anything fixed). File each product finding as a follow-up in `docs/TODO.md`. Commit `Report Phase 3 On-Machine Battery`.

**Size: L.**

### Task 13: Docs sweep

**Files:**
- `docs/player/architecture.md`: §2 block model, with Program and Signal implemented; §3 a rotation switch end to end; §6 roadmap (Phase 3 done; the auto-mute Signal per Task 14's outcome).
- `docs/player/invariants.md`:
  - **#12** "A rotation's clock is the player's: it never advances while the picture is paused or held; while no output shows it, it does exactly what `while_parked` says" — enforced by `pause_freezes_the_rotation`, `cover_hold_freezes_a_program`, `parked_keeps_rotating_invisibly_by_default`, `parked_hold_mode_holds_and_resumes`.
  - **#13** "One owner of a session's schedule — the player; the backend only requests" — enforced by the IT's origin check and the `legacy rotation path reached` guard.
- `docs/player/debugging.md`: rows for "didn't switch" → `probe programs` phase/played/remaining; "switched early" → `program.current.reason`; "stuck after failures" → `backoff_ms`; "paused by itself" → `cover.engaged` / `player.cover_hold_active`.
- `.claude/rules/player-core.md`: § Program, § Signals, § Outbox, the Snapshot/Command API rows.
- `.claude/rules/player-adapter.md`: § Rotation now says where each rule lives; § Dispatch points; § Reconnection (`Reapply` program).
- `.claude/rules/{session.md, player.md, web-backend.md}`: the daemons and pending IPC are legacy-only.
- `CLAUDE.md`: the CLI section, the architecture note.
- `docs/TODO.md`: tick Phase 3; add the deferred items below.

- [ ] **Step 1:** Update; `cargo test -q --test credits` PASS. **Step 2:** Commit `Document Programs And Signals`.

**Size: S.**

### Task 14 (optional, last): The in-player auto-mute Signal — replaces AudioMonitor only if it is a strict upgrade

Owner (2026-10-29): the current auto-mute works fine; the rework may be done **if it is a strict upgrade**. This task runs after Tasks 1–13 are green. It lands **switched off** unless every parity criterion below passes on the owner's machine. Only then does the adapter stop starting `AudioMonitor` and spawning `monitor-daemon` under `liascape-player`. If any criterion fails, the code stays behind `LIASCAPE_PLAYER_AUTOMUTE=1`, `AudioMonitor` + `monitor-daemon` stay as they are, and `docs/TODO.md` records which criterion failed and by how much.

**Design (spec §4.4):**
- In-process, on the player's persistent PipeWire connection (`audio/`, pipewire-rs — the bus already holds one). No process per stream.
- A peak meter with 10 ms fragments is attached the instant a stream node appears. Every foreign stream is metered individually, never the mix.
- Own streams are excluded **by ownership**: nodes the player created, nodes of its scene workers' pids, and anything targeting `liascape-player-bus`. Never by name.
- A Signal `audio.foreign_level` feeds a rule that moves `gain.automute` on every source. A new source gets the current value at create, so a B comes up muted.
- MPRIS-only: a `lia-mpris` thread reads `org.mpris.MediaPlayer2.*` `PlaybackStatus` over the session bus (zbus, blocking, off the loop). With no session bus it reports `unavailable` instead of passing.
- **MPRIS-only hears only the MPRIS player's own audio** (owner, 2026-10-29: today it mutes on *any* sound while some player reports Playing — a muted song + a notification still mutes). `lia-mpris` resolves each Playing player's bus name → pid (`org.freedesktop.DBus.GetConnectionUnixProcessID`) and keeps its `DesktopEntry` / `Identity`; a foreign stream counts only when it **belongs** to a Playing player:
  - its `application.process.id` is that pid or a descendant of it (`/proc/<pid>/stat` ppid walk — a browser's audio comes from a child process of the one that owns the MPRIS name);
  - else its `pipewire.access.portal.app_id` / Flatpak app id matches the player's `DesktopEntry` (sandboxed pids don't match the host's);
  - else `application.process.binary` / `application.name` matches `DesktopEntry` / `Identity` (case-insensitive) — the fallback for pids that don't line up (pipewire-pulse clients through a wrapper).
  - A muted stream or one at volume 0 (its node `Props` `mute` / `channelVolumes`) is silent; the meter reads post-volume, so a song turned down below the threshold doesn't mute either.
  - Several streams of one browser: any of them audible while its player is Playing counts (a tab's stream can't be told from another tab's reliably; `media.name` ≈ the MPRIS `xesam:title` is used only to rank the probe's report, never to drop a stream).
  - A Playing player with no stream matched → it doesn't mute, and the probe says `mpris.unmatched:<identity>` so a mismatch is visible, not a silent no-op.
  - **Measured on the owner's machine 2026-10-29** (`scripts/probe-mpris-streams.py`): mpv + `mpv-mpris` and Opera (its audio service is a direct child of the MPRIS pid) both match by the pid tree; `paplay` matches nothing. Inputs the matcher must use: a **native** PipeWire stream node carries no pid — join `client.id` → the Client object's `application.process.id`; **never `pipewire.sec.pid`** (for pulse clients it is pipewire-pulse's own pid); `DesktopEntry` may be absent (Chromium errors on it) → the name rule compares the binary with `Identity` too. Mute/volume are live in the node's `Props` (`mute`, `channelVolumes` — cubic: 0.4 reads 0.064); an empty `channelVolumes` = unknown, not silent. Browser tabs and Flatpak are untested.

**Files:**
- Create: `src/player/src/signal/automute.rs`, `src/player/src/audio/foreign.rs`
- Modify: `src/player/src/graph/props.rs`:
  - Player `automute` Bool (false), `automute_delay_ms` F64 (500), `autounmute_delay_ms` F64 (2000), `automute_min_level_db` F64 (−70), `automute_only_if_mpris` Bool (false).
  - Observed `automute_active` Bool.
- Modify: `hello.capabilities` + `automute` (bus up). Probe `automute`: the streams it meters with their verdicts and levels, the MPRIS state, decisions with timestamps.
- Modify: `src/backend/Player/LiascapePlayerMedia.cs` (`ApplyAutoMuteSettings`, coalescible, re-asserted per process), `src/backend/Helpers/{AudioMonitor.cs, PlayerHelper.cs}` (the engine gate `AutoMuteInPlayer` = liascape-player && capability && the parity flag `AutoMuteParityPassed`, a constant flipped in this task's last commit only if step 4 passes; the user-mute vs auto-mute logic reads `player.automute_active`), `src/backend/Web/ServerHost.cs` (no `AudioMonitor.Start` / `SpawnDetachedMonitor` while the gate is on), `scripts/measure-automute-latency.py` (both engines, same harness), `scripts/test-liascape-player-adapter.sh` § auto-mute (run once per engine).

**Parity criteria** — each measured side by side against today's `AudioMonitor` in the same private PipeWire + pipewire-pulse harness, then on the owner's machine:
1. **Every setting behaves the same**, live: AutoMute on/off, mute delay, unmute delay, the minimum level (threshold), "Only if MPRIS player active". Today's IT § "auto-mute" checks and the matrix `autoMute*` cells pass unchanged with the Signal as the engine.
   - Intended difference #2 (owner, 2026-10-29): with "Only if MPRIS player active", only the Playing player's own streams count — a muted song + another app's sound → no mute; the song audible → mute. Measured with a browser tab (child-process audio), `mpv --input-ipc…` with `mpv-mpris`, and a Flatpak player if installed.
2. **The exclusions:** there is no user-editable ignore list today; the built-in exclusions are its own streams and LWE's.
   - It never hears the player's own audio: V→V/V→S/S→V/S→S × full-live/reveal/frozen → 0 mutes (today's "auto-mute never hears our own switches" section).
   - An `mpv` the user runs **is** heard (today's `application.name = "mpv"` filter ignores it — the spec calls that a bug). This is the one intended difference — **confirmed by the owner 2026-10-29** ("new behaviour ofc, current is just a flaw").
3. **Mute latency as good or lower** (owner 2026-10-29: "should react as good or lower"): first audible foreign sample → every source at −96 dB, with delay 0. p50 and p95 over 30 trials **≤ today's (65–76 ms measured)** — a hard bar, not a target of 100 ms. Aim far lower: the floor is one PipeWire quantum to see the sample plus the anti-click ramp (sub-1 ms is not physically reachable — audio arrives in quanta of ~1–21 ms); report where the time goes.
   - **The user's delay must be what they get** (owner 2026-10-29: "aim as low as possible so the delay people set is actually accurate"): measure the overhead = actual mute time − configured `automute_delay_ms`, at 0 / 500 / 2000 ms; report p50/p95; minimise it (target: a few ms). Same for the unmute delay (criterion 4). Default mute delay is now **500 ms** (owner: "something reasonable like 500ms or 1000ms"; was 200), unmute 2000 ms.
   - **Default exclusions: none** (owner 2026-10-29: "make it not ignore anything by default"). Auto-mute hears every foreign stream, voice chat and notifications included, by default; only the player's own streams are excluded (by ownership). Per-app / per-role exceptions belong to the rules feature, whose shipped default may exclude notifications only (`media.role=Notification`) — the owner's Wallpaper Engine rule list was personal taste, not a default (most users won't want wallpaper audio during calls).
4. **Unmute timing at least as accurate:** silence → unmute at the configured delay ± 20 ms (± today's measured error, whichever is larger).
5. **Works with the app closed** (no backend process) and across a player crash restart (the settings are in the snapshot's player props).
6. **User mute vs auto-mute semantics unchanged:** `toggle-mute` while auto-muted unmutes; a user mute survives an auto-unmute; the CLI keybind with the app closed.
7. **A B created while auto-muted comes up muted** (every program switch; matrix `autoMute × pending`).
8. **No per-stream processes:** with 20 foreign streams, 0 child processes spawned.
9. **CPU:** the player's added CPU ≤ today's `parec` total with 5 foreign streams.
10. **No silent degrade:** with the bus down, `automute` capability absent → the backend keeps `AudioMonitor`.

- [ ] **Step 1: Write failing tests:**
  - unit `foreign_streams_are_classified_by_ownership` (synthetic node props: own pid, a worker pid, the bus target → own; a `paplay`, an `mpv` → foreign).
  - unit `mpris_streams_match_by_pid_tree_then_app_id_then_name` (child pid of the player → match; Flatpak app id = `DesktopEntry` → match; unrelated `paplay` → no match; a matched stream muted / volume 0 → silent).
  - api (private PipeWire, `tests/common/pw.rs`): `automute_mutes_on_a_foreign_stream`, `automute_ignores_own_switches_every_combo`, `automute_delays_and_threshold`, `automute_new_source_comes_up_muted`, `automute_survives_a_crash_restart`, `automute_spawns_no_processes`.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** The crate suite in both modes PASS; the adapter IT § auto-mute PASS on both engines; `measure-automute-latency.py --engine both` → criterion 3/4 numbers.
- [ ] **Step 5 (on-machine):** criteria 1–10 on the owner's session (a real browser video, a real `mpv`, Spotify via MPRIS if installed). Write them as a section of `docs/player/reports/phase3.md`.
- [ ] **Step 6:** All ten pass → flip `AutoMuteParityPassed`, retire `monitor-daemon` under liascape-player (not spawned; a leftover one killed at serve start), update `player.md` § Auto-Mute + `player-adapter.md`. Any fails → leave the flag off and file the TODO.
- [ ] **Step 7:** Commit `Add The In-Player Auto-Mute Signal` (+ `Replace AudioMonitor Under liascape-player` only when step 6 flips it).

**Size: L** (2½–3½ days; optional — Phase 3 is complete without it).

---

## Composition coverage ("Features must compose")

| composition | how it is tested |
|---|---|
| pure-timed (timer) | T3 `timer_mode_switches_every_interval`, `timer_countdown_scales_with_speed`, `timer_one_item_never_switches`; T7 IT; T12 step 1 |
| advance-on-end, min / max / 0 = off | T3 `on_end_*`, `min_hold_*`, `max_*`, `zero_means_off_for_both`; T7 IT (today's § play-time limits); matrix `playlist:minPlay\|maxPlay` |
| separate scene timing (+ images) | T3 `scene_switches_after_*`, `separate_off_*`, `image_*`; T7 IT; matrix `playlist\|global:sceneTiming` |
| manual next / prev / random (+ mid-wait, mid-effect, storm, 1-item, at start) | T4; T7 IT; T8 CLI storm; matrix `seq:*`, `programHeld\|Armed × next…` |
| playlist start: boot, app restart, crash, Play again, stop→play, A→B→A, edited resume item, play-from × Start over / Resume | § Playlist start table (one test per row: T5b, T7/T8 IT); matrix `plStart:*`; T12 step 3/6 |
| single-wallpaper restore, no snapshot | T5 `quit_then_restore_*`; T8 IT |
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
| auto-mute (backend `AudioMonitor`) × program B's | T7 IT: a B created while auto-muted comes up muted (`defaults.gain.mute`); matrix `autoMute*` unchanged |
| in-player auto-mute (optional) vs `AudioMonitor` | T14 parity criteria 1–10, both engines in one harness + on-machine |
| parked: rotate (default) / hold | T5 `parked_*`; matrix `parked:*` |
| cover default on (maximized) | T10 merge defaults; matrix `cover:default` |
| Expert tier (hidden by default, values kept, deviated marker) | T10 UI probe; matrix `expert:toggle` |
| failures (garbage file, all unplayable) | T3 `failed_item_*`, `all_items_unplayable_*` |
| pause-when-covered × pause / mute / next / rotation / one of two outputs | T6; T11 `coverHeld × …` |

---

## Risks and fallbacks

1. **Porting the rotation loses an edge case.** The C# encodes ~20 matrix-found fixes (commit at effect start, re-arm on a minimum change, the pre-fetch taken by max/next, history after random, 1-item ticks). *Fallback:* the adapter IT and the UI matrix check HTTP/UI-level behaviour regardless of engine, and they are the oracle. Each RED → GREEN run uses the base backend (`LIASCAPE_IT_DLL` / `LIASCAPE_MATRIX_DLL`). Each Rust function names the C# function it ports.
2. **Hyprland's foreign-toplevel reports a fullscreen window on a hidden workspace as activated** (or misses states). *Fallback:* Task 6's spike decides before any rule ships. Use Hyprland socket2 (`activewindowv2`, `fullscreen`, `workspace`) behind an instance check, or ship fullscreen-only. If no reliable maximized/fullscreen signal exists, the setting ships fullscreen-only and the default becomes `fullscreen` (a deviation from O1, reported to the owner).
3. **Snapshot I/O grows with the program** (300 items × props, fsync'ed). *Fallback (built in):* `program.json` is written only on a config change; the snapshot carries only the cursor, history and clocks (history ≤ 100 paths).
4. **A legacy rotation path still runs under liascape-player** (a missed dispatch → two schedulers, the old "two timer owners" storm). *Fallback:* the guard log line + the IT's "no origin `api` switch during a rotation" check + the files-never-written check.
5. **Unmeasured videos play un-normalized while the app is closed** (the loudness measure is a backend job). *Mitigation:* `Load`/`SetItems` kick `EnsureLoudnessAsync` for every unmeasured item, so only an item never measured before the app closed is affected. Measuring in the player is a later option, not Phase 3.
6. **The CLI keybind latency stays .NET's startup** (~150–300 ms) with the app closed. Not a regression; noted. A `liascape` launcher fast path (`ctl` straight to `program.next`) is possible later.
7. **Start over is now the default, and `ResumeFromLast` is gone** (O4 + designer call 13): the owner's next boot starts their playlist over unless they pick Resume. That is the owner's choice, called out in the report so it isn't a surprise.
8. **The in-player auto-mute misses a parity criterion** (Task 14). *Fallback (built in):* it stays behind `LIASCAPE_PLAYER_AUTOMUTE=1`; `AudioMonitor` + `monitor-daemon` keep working unchanged.

## Deferred (not Phase 3)

The in-player auto-mute Signal if Task 14 doesn't pass its parity bar (then `AudioMonitor` + `monitor-daemon` stay, O3). Per-monitor programs (the node supports one per output alias; the user-facing feature is its own follow-up project). Deleting the legacy rotation and daemon code (Phase 5). Renaming `IntervalSeconds` to the UI labels (docs/TODO.md). Mute/stop variants of the cover action (WE's "Mute"/"Stop"). Loudness measurement of videos in the player.
