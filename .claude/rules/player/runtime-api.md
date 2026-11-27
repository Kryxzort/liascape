---
paths:
  - "src/player/src/runtime.rs"
  - "src/player/src/headless.rs"
  - "src/player/src/onset.rs"
  - "src/player/src/paths.rs"
  - "src/player/src/ctl.rs"
  - "src/player/src/api/**"
  - "src/player/src/probe/**"
  - "src/player/src/signal/**"
  - "src/player/src/audio/foreign.rs"
  - "src/player/src/audio/sysmon.rs"
  - "src/player/tests/api.rs"
  - "src/player/tests/automute.rs"
---

# liascape-player: runtime loop, outputs, signals, command API

Crate-wide rules (core invariant, event log, units, graph) live in [core.md](core.md); the transition recipe and
programs in [recipes.md](recipes.md); snapshot and supervisor in [persistence.md](persistence.md); scene specifics in
[scenes.md](scenes.md). Walkthroughs: `docs/player/modules/runtime.md`, `docs/player/modules/signals.md`,
`docs/player/modules/command-api.md`. Debugging a running player: the `player-debug` skill.

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
- A transition requested in a user pause with `align: now` plays on still frames (`Tr::still`): thaw only
  the play clock (`Runtime::now`) while `Transitions::plays_on_still_frames` and no rule holds the player;
  never unpause a source for it. Programs read `Runtime::rotation_now`, frozen through it. Guards:
  `tests/api.rs::paused_switch_plays_its_effect_on_still_frames`, `paused_switch_waits_out_a_cover_hold`,
  `tests/program.rs::paused_next_plays_its_effect_on_still_frames`.
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
  `gain_effective_db`.

## Outputs, hotplug, parking
- On output add: re-apply its remembered `out:` props first, then a parked wallpaper parked for that
  connector, else join the live transition covering another output (`Transitions::adopt_output`), else
  show `cur:` of the first output, else the parked wallpaper — a source not yet `Ready` at its `Ready`
  (`show_when_ready`; a scene a VRAM stop blanks on purpose shows at once). Guards:
  `tests/supervise.rs::output_props_survive_replug`, `tests/api.rs::hotplug_mid_transition`,
  `restore_pending_layer_counts_as_shown`, `output_added_while_a_vram_stop_shows_nothing_keeps_the_scene`.
- On output removal: drop it from every transition (`drop_output`; a transition left with no output is
  committed via `commit_unseen`), then retire whatever only it showed. With no output left, park the last
  current wallpaper (ramped to −96, paused, still in `srcs:*`). Guards: `tests/api.rs::remove_output_retires_what_only_it_showed`,
  `remove_all_outputs_parks_and_readd_resumes`, `remove_all_outputs_mid_transition_commits_and_parks_b`.
- With no output, accept `transition` via `Runtime::transition_parked`: B replaces the parked wallpaper; an
  `align: end` request waits for an output unless the parked A `never_ends` (still or scene) — then it hands
  off at once. Guards: `tests/api.rs::i4_transitions_while_no_output_replace_the_parked_wallpaper`,
  `parked_scene_align_end_hands_off_at_once`.

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
- A `set`/`animate` on a broadcast alias (`srcs:*`) matching nothing is still type-checked and succeeds with `targets: []` — only an unknown connector or concrete id is `no_such_node`.
- Keep client isolation: per-wake read/request caps, oversized lines → `bad_request` + close, slow
  subscribers dropped. Guard: `tests/api.rs::bad_client_isolated`.
- A new probe = a file in `src/player/src/probe/` + one `PROBES` entry. Keep `mpv_*` synchronous reads
  probe-only.
- Spawn dropout ffmpeg decodes without `pre_exec` (it forks the whole compositor and costs bus cycles):
  `setpriv --pdeathsig KILL -- ffmpeg`. Guard: `tests/api.rs::dropout_analysis_never_skips_bus_cycles`.
- `LIASCAPE_PLAYER_MPV_LOG=v` prints each mpv core's log (timestamps are when the loop pumped it); replay a bug on
  `serve --headless --clock stepped --ao null`.
