---
paths:
  - "src/backend/Player/**"
  - "src/backend/Helpers/PlayerHelper.cs"
  - "scripts/test-liascape-player-adapter.sh"
---

# liascape-player adapter (C# side) and rotation

`src/backend/Player/` drives the Rust player (`.claude/rules/player/core.md`) when `AppSettings.PlayerEngine` is
`liascape-player`; `PlayerHelper` dispatches to it with `if (PlayerEngine.IsLiascapePlayer) { … }` at the top of each
primitive, the legacy code below it unchanged (`.claude/rules/backend/legacy-engine.md`). Walkthrough, history and the
full IT coverage list: `docs/player/adapter.md`.

## Threading: nothing waits on the player under `PlayerHelper._lock`
- Queue every mutation through `LiascapePlayerMedia` (one ordered worker): switches, stops, property sets, resolver passes. Never call the player synchronously inside `_lock` except the quick queries (`LiascapePlayerClient.QuickMs`, 300 ms).
- Queue kinds: `QueueEssential` (switch, stop, new session, toggle pause, upgrade — never dropped, a barrier), `QueueSet(key, …)` (coalesces: a newer set of the same key replaces the pending one), `QueueBatch(key, member, …)` (one pass over every member — use it for any per-item burst), plain `Queue` (barrier, refused at the cap). Never coalesce across a barrier.
- A per-item pass gets a batch key, not a key per item: 315 distinct `override:<path>` keys filled the 256 cap and dropped the playing item's pass. Guard: self-test "per-item override burst".
- Queued commands call with `QuickMs`; only `Switch`'s own `transition`/`cancel` keeps the 2 s default.
- The stall breaker opens for 3 s after a timeout. A STARTING player is not stalled: until it answered once, a request waits up to `StartGraceMs` (5 s after the socket's bind). Guard: self-test `StartupGraceAssertions`.
- `SwitchEngineLive` talks to the player only after releasing `_lock`; `StopAndQuit` runs synchronously before the new engine starts, so both engines are never on screen.

## Process lifecycle
- Only a switch spawns the player (`EnsureRunning`); queries and sets never do. It runs detached (`setsid`), stdio to `~/.cache/liascape/liascape-player-serve.log` — the player outlives the backend on purpose.
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
- Not resolved: `loop` (`SetLoop`, single non-timed wallpaper only) and `player.paused`.

## Pause
- The player owns pause (`player.paused`, kept in its snapshot). Keep no copy: `TogglePause` reads `get player.paused` and sets the opposite; R81 never re-asserts it.
- A new session (`Apply`, `ApplyPlaylist`, cold `Launch`) queues `set player.paused false` (`QueueNewSession`); a rotation keeps the pause.
- A user next/prev/random while paused resumes first (`StayPausedWhenSwitching` off, the default), except a `previous` that can't happen (`LiascapePlayerProgram.PrevIsNoOp`). With the setting on: the pause stays and the switch is a cut.

## Reconnection (R81) and switches the player missed
- `Restarted` (new compositor pid) and `Recovered` (breaker closed) both queue `ReapplyAll` — a Fresh resolver pass — fire-and-forget; never `Drain().Wait()` inside the client's callback.
- `ReconcileShown` (essential, before failing pending waits): if the screen lacks `_intent`'s path, cut to it; after our own `stop`, stop again. `_intent` is unknown after a failed/cancelled switch or a `transition.scheduled` for a path we didn't request (another client).
- A switch or stop lost to a stall becomes `_intent` and is put on screen when the player answers (`ProbeUntilAnswered` → `ReconcileAfterStall`). Aligned switches are retried by their caller instead.
- `DoVideoEndWait` on `failed:player restarted` re-arms for A's end; it never switches now.

## Events and the outbox
- Subscribe only to the kinds consumed (`LiascapePlayerClient.Topics`); never `source.` as a whole (it streams `source.position`).
- `WaitCorr` checks the outcome map first (the event can beat the reply) and polls `logs {corr}` every 2 s as a safety net.
- Our latest switch failing → re-broadcast `wallpaper-changed` with the real current path. Matrix `apply:broken`.
- Drain the player's outbox on every subscribe ack; ack only after the handler stored synchronously; handlers must be idempotent (`OnOutboxEvent`). Self-test `OutboxAckAssertions`.

## Rotation (the one home of its semantics)
Under liascape-player every rule runs in the player's program `prog:main` (`.claude/rules/player/runtime-api.md`); the
backend half is `Player/LiascapePlayerProgram.cs`. Under legacy the same rules run in `PlayerHelper`'s tick.
- Rotation per playlist = the globals, or its own when `OverrideGlobalSettings` (`PlayerHelper.EffectiveRotation`).
- "Switch when video ends" OFF: `IntervalSeconds` is "Switch every", a plain timer (switches mid-video); the maximum doesn't apply.
- ON: the same field is the "Minimum play time" and `MaxPlaySeconds` the maximum. Both wall-clock seconds, 0 = off strictly (minimum 0: switch at every end; maximum 0: never cut).
- A video plays at least the minimum, then switches at its next end (`align:end`). A clip shorter than the minimum loops and advances at the end of the loop that reaches it, never mid-loop (`HoldForMinPlay`, turns `Loop` on while held).
- The maximum switches now, mid-video, with the transition. For a video or still image a maximum below the minimum wins.
- "Separate timing for scenes" ON: scenes AND still images switch after "Switch scenes after" (0 = they stay); the minimum/maximum apply to videos only.
- Toggle OFF: a scene's minimum reached is its end; no minimum → the maximum moves it; neither → it stays. Both set → the minimum wins for a scene even when the maximum is shorter.
- `PlayerHelper.ItemPlayRule(kind, min, max, separate, scenesAfter)` is the whole table. Guards: `rule.rs` `item_rule_table`, self-test `PlayLimitAssertions` / `ItemPlayRule`.
- Play time counts wall clock (never speed-scaled), not while paused, resets on every switch (an aligned B from its effect's start), never on an edit.
- A 1-item playlist never switches by itself (`CanRotate`), but takes a user next/random.
- Live edits (`/settings` for a playlist following globals, `/playlist/state` diffed prev → now) never reset the countdown or play time; a new minimum re-arms the armed end switch to the same B; a transition change re-arms it (`RearmAlignedSwitch`).
- B becomes the session's current item when its effect STARTS (`transition.started`), not at the handoff.
- "Keep playing this one" (`liascape loop-current`) toggles `prog:main.keep`; it lives in the player only (kept across player restarts, never carried by `Reapply`); a Play / play-from clears it.
- Removed and gone: "Wait for video to end after interval", `GlobalMinPlaySeconds`, `ResumeFromLast`. Old files' keys load as unknown ones; no in-app migration.

## Program wiring (liascape-player)
- Load via `BuildSpec` + `Load` (essential); reuse an existing `prog:main` (`set key` first, so the old playlist keeps its resume point). A single `Apply` destroys `prog:main` first.
- Verbs: next/prev/random → `program.next|prev|random`; never write `pending_action.txt`.
- Never start `timer-daemon`, `restart-daemon` or `monitor-daemon`, and never write `timer.pid`, `gui_timer.pid`, `restart.pid`, `pending_action.txt`, `timed_state.json` under liascape-player (`PlayerHelper.RetiredUnderPlayer`); stop a leftover legacy daemon (`KillLegacyDaemons`). A legacy `timed_state.json` is read once as the program to load, then removed.
- Restore (`liascape restore`, `play`, `toggle-play` from stopped): start `serve --restore --session-start`; replay `LastSession` only when the player shows nothing.
- Trash of the shown/incoming item: `SetItems` with the bar's survivors, then `program.next`.

## Scenes and loudness (adapter side)
- `ScenesPlayable(s)` = `AllowScenes` && the running player's `scene` capability (else `liascape-player scene-check`, cached 30 s). A non-playable or crashed-and-not-whitelisted scene is skipped everywhere (`IsSkippedPath`); an all-unplayable library answers 409, never 500.
- `source.broken` → `MarkCrashed` + WS `scene-crashed` + advance if it was playing. `scene.vram_exceeded` → WS `scene-vram-stopped` + advance, never `MarkCrashed`.
- Scene normalization is set once per play: each source keeps a pin (`NormalizePin`); re-pin only on the first complete 60 s window, a normalization-setting change, or a new audio configuration (`loudness_key`). Self-test `SceneLoudnessAssertions`.
- Send `loudness_key` only to a player whose `hello.capabilities` has `scene_loudness_key`.
- A scene props commit must leave `scene_props` out of its pass when a preview of the item was queued meanwhile (it would revert the preview).

## Auto-mute under liascape-player
- The player's own Signal is the auto-mute (`AudioMonitor.AutoMuteInPlayer` = the `automute` capability); `AudioMonitor` runs only while `serve` runs and the player lacks it. It mutes `gain.automute`, so `gain.mute` and `PlayerHelper.IsMuted` stay the user's.
- `AudioMonitor` must classify a stream before counting its level and skip the player's own streams by ownership (`OwnStreamFilter`: compositor pid, `node.name` prefix `liascape-player-`, the bus sink). Guard: IT § "auto-mute never hears our own switches".

## Verify
- `bash scripts/test-liascape-player-adapter.sh [--no-build]` — hermetic; never touches the owner's player. `LIASCAPE_IT_ONLY=automute` runs one section.
- `LIASCAPE_PLAYER_BIN=src/player/target/debug/liascape-player dotnet run --project src/backend -- player-selftest`.
- In tests SIGSTOP/SIGKILL the COMPOSITOR pid (`ctl hello | jq .pid`), never the supervisor; clean up through the supervisor or `ctl quit`.
