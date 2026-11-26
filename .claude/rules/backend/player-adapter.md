---
paths:
  - "src/backend/Player/**"
  - "src/backend/Helpers/PlayerHelper.cs"
  - "scripts/test-liascape-player-adapter.sh"
---

# liascape-player adapter (C# side) and rotation

`src/backend/Player/` drives the Rust player (`.claude/rules/player/core.md`), the only engine; `PlayerHelper`'s
primitives (apply, next / previous / random, stop, restore, pause, mute, volume, live settings) are requests to it,
and `Player/PlayerStatus.cs` says where its binary is and why nothing or no scene can play. How the adapter works
(client, queue, upgrade, resolver, scenes, outbox): `docs/player/adapter.md`.

## Threading: nothing waits on the player under `PlayerHelper._lock`
- Queue every mutation through `LiascapePlayerMedia` (one ordered worker): switches, stops, property sets, resolver passes. Never call the player synchronously inside `_lock` except the quick queries (`LiascapePlayerClient.QuickMs`, 300 ms).
- Queue kinds: `QueueEssential` (switch, stop, new session, toggle pause, upgrade — never dropped, a barrier), `QueueSet(key, …)` (coalesces: a newer set of the same key replaces the pending one), `QueueBatch(key, member, …)` (one pass over every member — use it for any per-item burst), plain `Queue` (barrier, refused at the cap). Never coalesce across a barrier.
- A per-item pass gets a batch key, not a key per item: 315 distinct `override:<path>` keys filled the 256 cap and dropped the playing item's pass. Guard: self-test "per-item override burst".
- Queued commands call with `QuickMs`; only `Switch`'s own `transition`/`cancel` keeps the 2 s default.
- The stall breaker opens for 3 s after a timeout. A STARTING player is not stalled: until it answered once, a request waits up to `StartGraceMs` (5 s after the socket's bind). Guard: self-test `StartupGraceAssertions`.

## Process lifecycle
- A session an older build left running (its wallpaper processes, matched by name and this HOME, never another session's; its `timer-daemon` / `restart-daemon` / `monitor-daemon`, verified by command line) is stopped at `serve` start and `restore`, the daemons at `stop` too, its wallpaper at `kill` (`src/backend/Helpers/LegacyTakeover.cs`): SIGTERM with its process tree, then SIGKILL after 2 s, each process known by its pid + start time and signalled through a pidfd; `serve` then replays the session on the player (`Restore`) when it stopped anything, a timer-daemon alone included. Guard: `scripts/test-player-binary.sh` § a legacy settings file, § a timer-daemon alone, § kill.
- A missing binary: every switch looks for it again (`PlayerStatus.MissingReason`; a path found before counts only while its file is there) and refuses with the reason; the log says why once per reason, not once per attempt. Guard: `scripts/test-player-binary.sh` § missing, § removed again.
- Only a switch spawns the player (`EnsureRunning`); queries and sets never do. It runs detached (`setsid`), stdio to `~/.cache/liascape/liascape-player-serve.log` — the player outlives the backend on purpose.
- `setsid` doesn't leave the backend's cgroup: when the user manager of `$XDG_RUNTIME_DIR` answers, the player starts in its own transient scope (`src/backend/Helpers/UserScope.cs`: `setsid systemd-run --user --scope --collect --unit=liascape-player-<random>.scope -- sh -c 'exec …'`), so stopping a unit the backend runs in (KillMode=control-group) leaves it playing. Every wrapper execs: the spawned pid is the supervisor's. Decided once per process by a real probe scope; no manager, no `systemd-run` or a refusal → started as before, logged once. Never via the session bus's manager (a test's private runtime dir must not reach the desktop's). Adoption is unchanged (the socket). Guard: `scripts/test-backend-stop.sh` § unit.
- Restart with the running player's own `serve` arguments + `--restore` (`UserServeArgs`); `--session-start` only on a first `restore`-style start, never in an upgrade's or restart's arguments (it would start a playlist over). Self-test `StartArgsAssertions`.
- If the last supervisor pid is still alive, wait ≤ 2 s for its socket instead of spawning a second `serve` into a supervised restart's gap.
- Kill through the SUPERVISOR (`QuitOrKill`: `quit` → SIGCONT+SIGTERM supervisor → SIGKILL supervisor). Never signal the compositor pid while its supervisor lives — it restarts it with `--restore`.
- Identify pids by `/proc/<pid>/exe` + start time (`ProcIdentity`), never by a cmdline substring.
- In-place upgrade (`StaleReason` / `UpgradeInPlace`): compare the file the binary really runs (`RunsFile`: symlinks + `.<name>-wrapped`), by size+mtime, Nix by store root. Never upgrade while a transition or an armed program switch is pending; wait on the old supervisor's exit with a deadline scaled by the player's snapshot write time. Guard: self-test `StaleThroughWrapperAssertions`.
- Exit codes 1–5 surface via `LastError` → `GET /player-engine` `reason`; `EnsureRunning` never throws on them.

## Targeting: ONE effective-settings resolver (`LiascapePlayerMedia.ResolveNow`)
- Every live-apply (`/settings`, `/library/volume|speed`, `/preview`, volume keys, normalization, mute, scene props, R81 reapply) is a pass of the resolver: each live source (on screen, either side of an effect, a pending B, a parked one) gets ITS OWN item's value (`override ?? global`, plus a request's transient), diffed against what it runs, one `set` per source. Never broadcast `srcs:*`, never compute a value "for the playing item" ahead of time.
- New sources get the same computation at create (`SourceProps` → `Desired`); never a second copy of it.
- `/preview` names the edited items' paths and moves only their sources (mid-transition "the playing item" is B). `{global: true}` moves every source WITHOUT its own override.
- The source-map cache is trusted only while the event connection is live (`EventsLive`); invalidate it on our own switch/stop/cancel/upgrade and on `transition.*`, `player.stopped`, `source.retire` events.
- `gain.mute` goes as a 30 ms `animate`, always sent on change (`Force`); `gain.normalize` as a 500 ms `animate`.
- Not resolved: `loop` (a single wallpaper's source is created with `loop: true`; under a rotation the program owns it) and `player.paused`.

## Pause
- The player owns pause (`player.paused`, kept in its snapshot). Keep no copy: `TogglePause` reads `get player.paused` and sets the opposite; R81 never re-asserts it.
- A new session (`Apply`, a restore's replay) queues `set player.paused false` (`QueueNewSession`), a Play of a playlist loads its program unpaused (`keepPause: false`); a rotation keeps the pause.
- A user next/prev/random while paused resumes first (`StayPausedWhenSwitching` off, the default), except a `previous` that can't happen (`LiascapePlayerProgram.PrevIsNoOp`) or one with nothing to switch to (409); the keep-pause decision is an argument of its own switch, never shared state. With the setting on: the pause stays and the switch goes with its transition, which the player plays on the still frames (`.claude/rules/player/runtime-api.md` § Runtime loop); never send it as a cut. Guard: matrix `paused × cli:next-keep`.

## Reconnection (R81) and switches the player missed
- `Restarted` (new compositor pid) and `Recovered` (breaker closed) both queue `ReapplyAll` — a Fresh resolver pass — fire-and-forget; never `Drain().Wait()` inside the client's callback.
- `ReconcileShown` (essential, before failing pending waits): if the screen lacks `_intent`'s path, cut to it; after our own `stop`, stop again. `_intent` is unknown after a failed/cancelled switch or a `transition.scheduled` for a path we didn't request (another client).
- A switch or stop lost to a stall becomes `_intent` and is put on screen when the player answers (`ProbeUntilAnswered` → `ReconcileAfterStall`). A rotation's aligned switches are the player's program's to recover.

## Events and the outbox
- Subscribe only to the kinds consumed (`LiascapePlayerClient.Topics`); never `source.` as a whole (it streams `source.position`).
- `WaitCorr` checks the outcome map first (the event can beat the reply) and polls `logs {corr}` every 2 s as a safety net.
- Our latest switch failing → re-broadcast `wallpaper-changed` with the real current path. Matrix `apply:broken`.
- Every `transition.started` → broadcast `wallpaper-changed` with the event's `b.path`, from the event thread: `/current` names B only from then, so a page that loaded after `/apply`'s announcement learns it here. Matrix `load:afterApply:wsEarly`.
- `/current` (and the failed-switch re-broadcast) read `CurrentPathOrLast`: a player that doesn't answer (code `timeout`: no reply, the stall breaker) names the path it last reported, never "nothing plays" (a page loaded then has no event to correct it). `CurrentPath()` itself stays null without an answer (self-test "a stopped player still answered"). Matrix `load:duringStall`.
- A restarted player (`OnRestarted`) → after `ReconcileShown`, broadcast `wallpaper-changed` with what it shows (`AnnounceShownAfterRestart`), unless a switch of ours was requested since (its start announces it): in the restart's gap `/current` says nothing plays (no player; never a guess — a snapshot can be behind or not restored), and the resumed item sends no `transition.started`. Matrix `load:duringRestart`.
- The low-VRAM hold: `hello.vram_hold`, then `vram.held` / `vram.released` live → `LiascapePlayerClient.VramHold` → WS `vram-hold {message}` and `/current.vramHold` (`PlayerHelper.VramHoldMessage`), which the now-playing line leads with while it holds. Guards: adapter IT § "the low-VRAM hold is visible", probe-matrix `vram:held`.
- Drain the player's outbox on every subscribe ack; ack only after the handler stored synchronously; handlers must be idempotent (`OnOutboxEvent`). Self-test `OutboxAckAssertions`.

## Rotation (the one home of its semantics)
Every rule runs in the player's program `prog:main` (`.claude/rules/player/runtime-api.md`); the backend half is
`Player/LiascapePlayerProgram.cs`.
- Rotation per playlist = the globals, or its own when `OverrideGlobalSettings` (`PlayerHelper.EffectiveRotation`).
- "Switch when video ends" OFF: `IntervalSeconds` is "Switch every", a plain timer (switches mid-video); the maximum doesn't apply.
- ON: the same field is the "Minimum play time" and `MaxPlaySeconds` the maximum. Both wall-clock seconds, 0 = off strictly (minimum 0: switch at every end; maximum 0: never cut).
- The maximum is 0 or at least the minimum (`AppSettings.RotationMax`, ON only): every settings / playlist save stores a smaller one as the minimum and `EffectiveRotation` reads it so, so a raised minimum carries the maximum up (never back down) and the program gets it live; the UI does the same as you type (`store` `maxOverMin`; a shorter maximum typed is a draft, leaving saves the minimum). Guards: `test-settings-merge.sh` § "0 (off) or at least the minimum", probe-settings `playtime:maxFloor:*`.
- A video plays at least the minimum, then switches at its next end (`align:end`). A clip shorter than the minimum loops and advances at the end of the loop that reaches it, never mid-loop (the program's hold, `program.held`, turns `loop` on while held).
- The maximum switches now, mid-video, with the transition.
- "Separate timing for scenes" ON: scenes AND still images switch after "Switch scenes after", never 0 (`AppSettings.SceneTime`: 1 s floor; the player's `scenes_after_ms` range starts at 1000); the minimum/maximum apply to videos only.
- Toggle OFF: a scene's minimum reached is its end; no minimum → the maximum moves it; neither → it stays. Both set → the minimum.
- `rule.rs` `item_rule(kind, min, max, separate, scenes_after)` is the whole table. Guard: `rule.rs` `item_rule_table`.
- Play time counts wall clock (never speed-scaled), not while paused, resets on every switch (an aligned B from its effect's start), never on an edit.
- A 1-item playlist never switches by itself (`can_rotate` in `src/player/src/recipes/program/mod.rs`), but takes a user next/random.
- Live edits (`/settings` for a playlist following globals, `/playlist/state` diffed prev → now) never reset the countdown or play time; a new minimum re-arms the armed end switch to the same B; a transition change re-arms it (`RearmAlignedSwitch`).
- B becomes the session's current item when its effect STARTS (`transition.started`), not at the handoff.
- "Keep playing this one" (`liascape toggle-loop-current`) toggles `prog:main.keep`; it lives in the player only (kept across player restarts, never carried by `Reapply`); a Play / play-from clears it.
- Removed and gone: "Wait for video to end after interval", `GlobalMinPlaySeconds`, `ResumeFromLast`. Old files' keys load as unknown ones; no in-app migration.

## Program wiring (liascape-player)
- Load via `BuildSpec` + `Load` (essential); reuse an existing `prog:main` (`set key` first, so the old playlist keeps its resume point). A single `Apply` destroys `prog:main` first.
- Verbs: next/prev/random → `program.next|prev|random`.
- A `timed_state.json` or `pending_action.txt` an older build left in the config dir is never read. Guard: adapter IT § "a legacy rotation's files".
- Restore (`liascape restore`, `play`, `toggle-play` from stopped): start `serve --restore --session-start`; replay `LastSession` only when the player shows nothing. A layer waiting for its restored source's `Ready` (`state.outputs[].pending`) shows something (`ShownOrIncoming`). Guard: adapter IT § "restore during the wait". A `stop` saves an empty snapshot and no program, so a session start after it replays `LastSession` (adapter IT § "stop → player quit → restore"). A replay that doesn't happen (nothing in it can play, the load or switch refused or unanswered) throws with why: the CLI exits 1.
- Trash of the shown/incoming item: `SetItems` with the bar's survivors, then `program.next`.

## Scenes and loudness (adapter side)
- `ScenesPlayable(s)` = `AllowScenes` && the running player's `scene` capability (else `liascape-player scene-check`, cached 30 s). A non-playable scene is skipped everywhere; a crashed-and-not-whitelisted one by every picker and rotation (`IsSkippedPath`) while a user's apply still plays it (`Apply`); an all-unplayable library answers 409, never 500.
- A preset plays as its own source: `path` = its folder, `scene_dir` = its base's (`SourceProps`, create-only: never sent to a live source, a base found elsewhere waits for the next play; a running rotation's items follow a base that comes, goes or moves: `PresetDownloads.cs` `PresetBases`, a pass after the library's index writes settle); gates read `Presets.StatusOf` (`PlayerHelper.PresetUnplayableReason`: `Apply` and play-from on one refuse with its reason, a playlist of only such presets too; both `IsSkippedPath` overloads skip it). Trashing a base takes its presets off screen like trashed items (advance / stop) but keeps them in the playlist; trash and Undo push the items' `skip` and send `library-synced`. A preset image that doesn't load is logged with why, the rest plays. Guard: adapter IT § presets.
- `source.broken` → `MarkCrashed` + WS `scene-crashed` + advance if it was playing. `scene.vram_exceeded` → WS `scene-vram-stopped` + advance, never `MarkCrashed`. A scene worker that couldn't load the scene renderer (the install's fault, not the scene's) is never `MarkCrashed`: latch the player's word (`hello.scene_renderer_missing`; scene-check's `renderer_missing` only while no player answers and none greeted during the check, `NoPlayerCheck`) in `LiascapePlayerClient.RendererMissing`, re-read on every `scene.renderer_*` fact, live or drained; a change → WS `scenes-blocked {reason}` + `PushItems`, and `/current.scenesBlocked` (never waits: `KickSceneWord`) → the UI greys every scene and preset with it (store `unplayableReasonOf`). The player drops its `scene` capability meanwhile, so the gates skip scenes. Guards: adapter IT § "a scene worker that can't load the scene renderer", self-test `RendererLatchAssertions`, probe-sidebar `lib:scenesBlocked`.
- `scene.fonts` (each scene load) → `LibraryService.StoreFontStandIns` (written only when it changed, an empty list clears) + `library-item-changed {fontStandIns}`; a live fact only, never the outbox (the next load reports again). Guard: self-test "scene.fonts reaches the backend".
- Scene normalization is set once per play: each source keeps a pin (`NormalizePin`); re-pin only on the first complete 60 s window, a normalization-setting change, or a new audio configuration (`loudness_key`). Self-test `SceneLoudnessAssertions`.
- Send `loudness_key` only to a player whose `hello.capabilities` has `scene_loudness_key`.
- A scene props commit must leave `scene_props` out of its pass when a preview of the item was queued meanwhile (it would revert the preview).

## Auto-mute
- The player's own Signal is the auto-mute (`AudioMonitor.AutoMuteInPlayer` = the `automute` capability); `AudioMonitor` runs only while `serve` runs and the player lacks it. It mutes `gain.automute`, so `gain.mute` and `PlayerHelper.IsMuted` stay the user's.
- Ask for the `automute` capability on `AudioMonitor._probe` (its own client, `AutoSpawn = false`), never the shared
  client: a `hello` there discovers a new player from the timer thread and races the restart's reapply, and its
  timeout opens the shared stall breaker.
- `AudioMonitor` must classify a stream before counting its level and skip the player's own streams by ownership (`OwnStreamFilter`: compositor pid, `node.name` prefix `liascape-player-`, the bus sink); remember our ids until their `remove`. Guard: IT § "auto-mute never hears our own switches".
- `AudioMonitor` hears each stream with `parec --monitor-stream=<id>`, never `@DEFAULT_MONITOR@` (it hears our own audio → mute/unmute oscillation). Keep `--latency-msec=10` (parec's default buffering delays the first data ~2 s). Why: `docs/decisions.md` § "Monitor auto-mute per stream with a 10 ms parec latency".
- Reset `_aboveThresholdCount` at the top of `WatchStreamsAsync`, not in `Stop()`.
- `SetMute` (auto) never unmutes while the user muted (`_userMuted` or `user_mute.state`); `toggle-mute` uses `SetUserMute`.

## Verify
- `bash scripts/test-liascape-player-adapter.sh [--no-build]` — hermetic; never touches the owner's player. `LIASCAPE_IT_ONLY=automute` (or `presets`) runs one section.
- `LIASCAPE_PLAYER_BIN=src/player/target/debug/liascape-player dotnet run --project src/backend -- player-selftest`.
- In tests SIGSTOP/SIGKILL the COMPOSITOR pid (`ctl hello | jq .pid`), never the supervisor; clean up through the supervisor or `ctl quit`.
