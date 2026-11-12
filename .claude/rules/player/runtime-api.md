---
paths:
  - "src/player/src/runtime.rs"
  - "src/player/src/headless.rs"
  - "src/player/src/onset.rs"
  - "src/player/src/paths.rs"
  - "src/player/src/ctl.rs"
  - "src/player/src/api/**"
  - "src/player/src/probe/**"
  - "src/player/src/recipes/**"
  - "src/player/src/signal/**"
  - "src/player/src/audio/foreign.rs"
  - "src/player/src/audio/sysmon.rs"
  - "src/player/tests/api.rs"
  - "src/player/tests/transition.rs"
  - "src/player/tests/program.rs"
  - "src/player/tests/automute.rs"
---

# liascape-player: runtime, transitions, programs, signals, command API

Crate-wide rules (core invariant, event log, snapshot, supervisor, units) live in [core.md](core.md); scene
specifics in [scenes.md](scenes.md); the backend's rotation contract in
[player-adapter.md](../backend/player-adapter.md). Walkthroughs: `docs/player/modules/runtime.md`,
`docs/player/modules/transitions.md`, `docs/player/modules/programs.md`, `docs/player/modules/signals.md`,
`docs/player/modules/command-api.md`. Audio symptom → probe recipes: `docs/player/debugging.md`.

## Runtime loop (`runtime.rs`)
- Run time-driven work (animator, recipes, programs, compose) only on the timer tick. A wake (mpv eventfd,
  worker fd) only flags; after a dispatch the loop syncs graph changes and updates sources, never animates
  or ticks recipes — ticking on wakes self-sustains because every gain push's reply wakes the fd.
- Request handlers change only the graph/animator/recipe; their effects reach sources in the same
  iteration's post-dispatch `sync_sources`.
- Register a `dup` (`F_DUPFD_CLOEXEC`) of every source wake fd, never the fd itself: a dropped source closing
  its fd must not leave a dangling or reused registration.
- Keep the 1 ms gain timer (`GAIN_TICK_PERIOD`) armed only while a `gain.*` ramp is actually moving
  (`gain_work_pending`), disarming itself from its own callback; never arm it on the stepped clock.
  `gain_fast_tick` calls `update_player_paused()` first because it can fire in the same dispatch batch as
  the request that paused. Guard: `tests/api.rs::gain_fast_timer_paused_makes_no_progress`.
- The fast tick must remove what it pushed from the pending changes (`Graph::drain_gain_changes`) so the next
  `sync_sources` doesn't replay every value.
- Destroy a retired source one tick after its ramp ends (that tick's sync carries the final −96 dB);
  destroying in the same tick tears it down audible. Parking pauses one tick after its ramp for the same
  reason. Guard: `tests/api.rs::destroy_ramps_audible_source_out`.
- Run `retire`/`park` ramps on `teardown_anim` and user-setting gain ramps (`GainSlot::is_setting`) on
  `setting_anim` — both on the unpaused base clock — so a destroy, `stop` or mute completes while the player
  is paused. One writer per path: adding to one animator cancels the other's ramp. The recipe's slots
  (`xfade`/`anticlick`) and all non-gain animation stay on the player clock.
  Guard: `tests/api.rs::setting_gain_ramp_lands_while_paused`.
- A cut while paused swaps at once (an already-silent A's anticlick is set, not ramped on the frozen
  clock). Guard: `tests/api.rs::cut_while_paused_swaps_at_once`.
- `stop` clears `player.paused` after retiring (a stop ends the session). On `quit`, if an mpv core is
  still being destroyed after the reaper wait, leave with `_exit(0)` after removing socket + lock, so
  libmpv/EGL destructors never run under the straggler. Guard: `tests/api.rs::sigterm_is_a_clean_exit`.
- Keep every per-source collection bounded and listed in `probe loop` → `bounds`; a new collection gets an
  entry there. Guard: `tests/api.rs::c1_long_run_switches_stay_bounded`.
- Log rate-limited warnings (`compose.failed`, `api.tap_overflow`) from the loop, never from inside the tap.

## Single instance and paths (`paths.rs`)
- Single instance = `flock` on `<socket>.lock`; the loser exits 1 without touching the socket. The winner
  unlinks an existing path only if it is a socket. Guard: `tests/api.rs::concurrent_starts_one_serves`.
- chmod the socket dir only if we created it or it is the default `…/liascape`; never chmod a directory
  named by `--socket`/`LIASCAPE_PLAYER_SOCKET`.
- Unix socket paths must be < 108 bytes: tests put sockets under `std::env::temp_dir()`, not `target/`.

## Stepped clock and headless
- `step` must not block the loop: defer it (`PendingStep`), bounded by `STEP_TIMEOUT`, and read nothing more
  from that client until it replies (per-client FIFO; ≤ `STEP_QUEUE_MAX` queued, then `busy`).
  Guards: `tests/api.rs::pipelined_step_then_capture`, `half_closed_client_gets_step_reply`.
- Stepped captures must stay byte-identical for the same script. Guard: `tests/api.rs::stepped_is_deterministic`.
- Run every test server with `--ao null` and temp `XDG_RUNTIME_DIR`/`XDG_STATE_HOME`; spawned `serve`/`ctl`
  children get `PR_SET_PDEATHSIG(SIGKILL)` (`die_with_parent`). Test servers run
  `LIASCAPE_PLAYER_VRAM_PROBE=none` unless they set a fake.
- In `state.graph` a source node's `kind` is its Source kind (`video`/`scene`/…): recognise sources by
  `gain_effective_db`. A log `fields` key named like a fixed key (`kind`, `corr`) overwrites it — use
  `source_kind`.

## Outputs, hotplug, parking
- On output add: re-apply its remembered `out:` props first, then a parked wallpaper parked for that
  connector, else join the live transition covering another output (`Transitions::adopt_output`), else
  show `cur:` of the first output, else the parked wallpaper. Guards: `tests/supervise.rs::output_props_survive_replug`,
  `tests/api.rs::hotplug_mid_transition`.
- On output removal: drop it from every transition (`drop_output`; a transition left with no output is
  committed via `commit_unseen`), then retire whatever only it showed. With no output left, park the last
  current wallpaper (ramped to −96, paused, still in `srcs:*`). Guards: `tests/api.rs::remove_output_retires_what_only_it_showed`,
  `remove_all_outputs_parks_and_readd_resumes`, `remove_all_outputs_mid_transition_commits_and_parks_b`.
- With no output, accept `transition` via `Runtime::transition_parked`: B replaces the parked wallpaper; an
  `align: end` request waits for an output unless the parked A `never_ends` (still or scene) — then it hands
  off at once. Guards: `tests/api.rs::i4_transitions_while_no_output_replace_the_parked_wallpaper`,
  `parked_scene_align_end_hands_off_at_once`.

## Transition recipe (`recipes/transition.rs`)
- Keep the recipe kind-agnostic: it issues only graph `create`/`set`/`destroy` and `Animator` calls — no
  rendering, no source access, no per-kind branches beyond `is_still`/`never_ends`/`b_has_audio`.
- `start` creates B first (a bad request changes nothing), then resolves overlapping transitions:
  pre-Running → abort (A's loop restored without a rewind); Running → commit; Handoff → left to settle.
  Only then capture A.
- With no A on any requested output, run the request as a cut (`effect_id: null`); an A on any one output
  keeps the effect. Guards: `effect_from_nothing_is_a_cut`, `effect_stays_with_any_a_and_superseding_from_nothing_stays_a_cut`.
- Never run a gain animation shorter than 30 ms, whatever `duration_ms`. Guard: `tests/transition.rs::zero_duration_gains_still_ramp_30ms`.
- Hold B's onset ramp until its `AudioFlowing` (≤ `ONSET_TIMEOUT`), started at the confirmation instant,
  never backdated; route every call site through `schedule_onset`. `b_has_audio` skips the wait for
  color/image/snapshot or a muted B. A cut's B is never held.
- Write `settle_until` with `.max()` downstream of a scheduled onset, never plain assignment, so a later
  recompute can't shorten a still-ramping onset (`commit_unseen` drops a pending onset instead).
- `begin_running` force-starts another transition's pending onset on its A's, never `start` (a committed frozen B
  is the new A before its audio flows). Guard: `frozen_commit_holds_b_silent_until_audio_flows`.
- Pause a held A at `t0 + ANTICLICK + AUDIO_SETTLE_TAIL`, not `t0 + ANTICLICK`: mpv's gain lags the graph.
- Record gains for restore with `Animator::live_target_of`, never `target_of` (a finished ramp's stale
  target would undo a later `set`). Guard: `restore_uses_live_target_not_a_stale_finished_one`.
- Ignore B's `Rejected` events; only `Error` fails B. Ignore A's errors (its texture holds its last frame).
- `align: end`: aim at the raw end minimum (no half-frame centring); rescale it on a speed change rather than
  restart from a stale `time_pos`; `follow_a_end` compresses the remaining effect when A's end moves earlier
  (≥ `COMPRESS_FLOOR` left, never stretched). A lead A that `never_ends` → start now. An A that never reaches
  its end falls back after its remaining time + `ALIGN_SLACK`. Guards:
  `tests/api.rs::align_end_hands_off_as_a_last_frame_ends`, `align_end_speed_up_mid_effect_hands_off_at_a_end`,
  `align_end_tracks_a_speed_dragged_continuously`, `align_end_compression_keeps_the_hold_and_never_stretches`,
  `anim::compress_to_keeps_value_and_shape`.
- reveal/frozen snapshot only an A whose picture can still change: a still (by kind) or an ended A is held
  as itself. A video is never a still, even with no known duration.
- Never pause, ramp, loop-change or destroy an A shown by a layer outside the request (shared A).
- Process the graveyard at the top of `tick` so a source's final −96 dB reaches it before its node goes; a
  transition can't enter Running while a grave on its outputs is pending (≤ 2 streams per output).
- A B with observed `loading` true waits up to `LOADING_READY_TIMEOUT` instead of `READY_TIMEOUT`; keep it
  under the backend's own 60 s switch wait. Guard: `loading_b_is_waited_for_past_the_ready_timeout`.
- Stamp transition events with the pause-excised player clock (`Runtime::now`), not `t_mono_ms`.
- Tests: one harness at a time (process-wide lock) — parallel 1080p decoders starve each other.
  Pure state-machine rules are unit-tested graph-only in `recipes/transition.rs`.

## Programs (`recipes/program/`)
- A program is a graph node `prog:<name>` that only issues `transition` requests through
  `Transitions::start` (or `transition_parked`); never add a second switch path, never render, never touch
  a source. Rotation semantics port the C# contract in [player-adapter.md](../backend/player-adapter.md).
- Program create/destroy never moves `picture_rev`/`demand_rev`.
- Stash the transition outbox (`Runtime::stash_tr_events`) in the `transition`/`cancel` verbs and output
  removal instead of dropping it: programs read those events on the next tick.
- Commit a step at its `transition.started` (a `handoff` commits one whose `started` was missed); plan a
  step, never pre-fetch.
- Drive play time and countdown from `Runtime::now` (pause-excised; play time wall-rate, countdown scaled
  by the current source's `speed`); no rule starts a switch under a hold (user pause, VRAM, cover).
  Guards: `tests/program.rs::cover_hold_freezes_a_program`, `live_max_edit_while_paused_waits_for_the_resume`.
- Arm an `on_end` switch only after the current effect's handoff and never while parked: a request during a
  Running effect would commit it early.
- Failures never spin: back off on `BACKOFF_MS`, mark the path failed, move on; when every item failed,
  retry at the ladder's pace.
- Parked under `while_parked: rotate`, switch no sooner than `PARKED_MIN_PLAY_MS` after the last commit.
- `keep` stops every rotation rule and keeps a video looping; user verbs still switch; lifting it resets
  play time and countdown. Guards: `tests/program.rs::keep_holds_the_current_item_and_loops_it`,
  `keep_stops_the_timer_and_resets_it_when_lifted`.
- A live edit never resets play time; an edit to only items' `props`/`skip` never reorders.
- Write `program.json` only when a definition changed (`def_dirty`), never on the 2 s snapshot refresh.
  A crash restart restores exactly; only `--session-start` applies `start_mode`.
  Guard: `tests/program.rs::resume_retimes_a_countdown_saved_under_other_settings`.

## Signals (`signal/`)
- "Covered" means visible, never focused: never read wlr-ft `activated`, Hyprland client `visible`, or
  `activewindow` title churn (`hypr::Relevance`). Always read state back after `fullscreen` (it names no window).
- Compose the cover hold (and the low-VRAM hold) into the effective pause in `update_player_paused`; never
  write `player.paused`, so a user pause survives the release. `cover_tick` runs before it each tick.
- The hold engages only when every output showing content is covered for `COVER_ENGAGE_MS`.
- Auto-mute: classify streams by ownership (pid tree, bus target, link into the bus), never by name; never
  read `pipewire.sec.pid`. A stream counts only once its node's and client's full props arrived. Guards:
  `foreign_streams_are_classified_by_ownership`, `pipewire_sec_pid_is_never_read_as_the_process`,
  `a_stream_counts_only_once_it_is_identified`.
- Apply a registry batch's removals before its additions (ids are reused). Guard:
  `tests/automute.rs::automute_mutes_on_a_foreign_stream`.
- Unmute only after silence proven by delivered data, not a timer alone. A user release holds until the
  rule's own unmute condition. Guard: `tests/automute.rs::automute_release_holds_until_silence`.
- While muted, new sources come up at `gain.automute = −96`. Spawn no process per stream. Guard:
  `tests/automute.rs::automute_spawns_no_processes`.

## Command API (`src/player/src/api/`, `src/player/src/ctl.rs`)
- Every error reply carries a `hint` saying what to do next.
- Flush the event tap before every reply: events a command causes arrive before its reply.
- Global settings go to `srcs:*` (core.md § Graph); a `set`/`animate` on a broadcast alias matching nothing is
  still type-checked and succeeds with `targets: []` — only an unknown connector or concrete id is `no_such_node`.
- Keep client isolation: per-wake read/request caps, oversized lines → `bad_request` + close, slow
  subscribers dropped. Guard: `tests/api.rs::bad_client_isolated`.
- A new probe = a file in `src/player/src/probe/` + one `PROBES` entry. Keep `mpv_*` synchronous reads
  probe-only.
- Spawn dropout ffmpeg decodes without `pre_exec` (it forks the whole compositor and costs bus cycles):
  `setpriv --pdeathsig KILL -- ffmpeg`. Guard: `tests/api.rs::dropout_analysis_never_skips_bus_cycles`.
- Debug order: `ctl state` → `ctl logs '{"corr":…}'` → `ctl probe` (`sources`, `loop`) → `ctl capture` →
  replay on `serve --headless --clock stepped --ao null`. `LIASCAPE_PLAYER_MPV_LOG=v` prints each mpv core's
  log (timestamps are when the loop pumped it).
