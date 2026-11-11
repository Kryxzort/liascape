# liascape-player adapter (C# side)

Covers `src/backend/Player/` (`PlayerEngine.cs`, `LiascapePlayerClient.cs`, `LiascapePlayerMedia.cs`,
`LiascapePlayerProgram.cs`, `MpvPropertyMap.cs`, `LiascapePlayerSelfTest.cs`), the dispatch in
`src/backend/Helpers/PlayerHelper.cs` and `scripts/test-liascape-player-adapter.sh`. Rules (threading, lifecycle,
targeting, pause, rotation, scenes, auto-mute): `.claude/rules/backend/player-adapter.md`.

## The client (`LiascapePlayerClient`)

- One persistent request connection (serialized; reconnects after any error; a stale reply is skipped by `id`) and
  one subscribed event connection, reconnecting with backoff 250 ms → 5 s, subscribed only to `Topics`.
- **Two pids from `hello`:** `PlayerPid` = the compositor (what every source and stream-ownership question is about),
  `SupervisorPid` = `hello.supervisor_pid` (null unsupervised). `Generation` bumps when `PlayerPid` changes (corr ids
  restart at `tr-1`). A new pid under the same supervisor is a supervised restart, logged with `hello.restart`'s
  fields — the restart event was emitted before any client could subscribe — before `Restarted` fires. `Recovered`
  fires on the first successful reply after the stall breaker was open.
- **`ProcIdentity`:** `/proc/<pid>/exe`'s target plus the start time (field 22 of `stat`), captured at `hello` and
  re-checked before every signal, so a recycled pid is never signalled as ours. A cmdline substring is third-party
  text and never used.
- **Start grace.** The player binds its socket first and answers ~1 s later (bus wait, EGL, CUDA). Until a player on
  that socket answered this client once (`_answeredBorn` = the socket's mtime = its bind), a request waits up to
  `StartGraceMs` (5 s after the bind) for its first answer and for the connection lock — so a parallel caller waits
  behind it instead of failing "busy" — and only a timeout past that trips the breaker. While this process starts
  a player, a request also waits ≤ 5 s for the socket to appear.
- `Health()` (`/health/features`): the running player's `hello.health`, else `liascape-player health` (cached 30 s).

## The media queue (`LiascapePlayerMedia`)

One ordered worker (a `LinkedList` of pending commands on the thread pool, so a pending one can be replaced). The
kinds and the cap (`MaxQueueDepth` 256) are rules. A coalesced command is admitted even at the cap and the replaced
one's task completes with its replacement, so `Drain` stays correct. At the cap the drop logs what filled the queue
(≤ every 5 s): `dropping <kind>; pending N: <kind> ×n (k keys), …; running <kind> for M ms` — a barrier's kind is
`essential:`/`barrier:` + its caller (`CallerMemberName`). `CapDrops` / `LastCapHistogram` are the self-test's
evidence.

## Binary, start, upgrade

- **Binary** (`PlayerEngine.ResolveBinary`): `LIASCAPE_PLAYER_BIN` → next to the running liascape executable → the
  dev tree `src/player/target/{release,debug}/liascape-player` (release first: debug is `opt-level 0` and the player
  mixes audio itself) → `PATH`. Missing → the engine reads as unavailable, `/player-engine` says why, legacy works.
- **Start** (`EnsureRunning`, only from a switch): `setsid sh -c 'exec liascape-player serve …'` with the session's
  environment, waiting ≤ 3 s for the socket. Once this client has talked to a player it restarts with that player's
  own arguments + `--restore` (`UserServeArgs`, from the supervisor's cmdline minus `--supervised`, `--restore`,
  `--restarted`, `--session-start`), so a player that went away comes back with the same outputs, socket and AO.
  `Restore` starts a first player with `serve --restore --session-start` and waits ≤ 30 s (a restore creates a
  source per output first). A failed start isn't retried for 10 s. Exit 5 seen here means the supervisor's own
  compositor backoff hasn't succeeded within our wait, not that it gave up.
- **Stale** (`StaleReason`): files compared, never path strings (one checkout is reachable as `/home/…` and
  `/mnt/…/@home/…`): size + mtime through open handles (`/proc/<pid>/exe` opens the running binary even after a
  rebuild replaced it), Nix by store root (every store file has mtime 1). Both sides resolve to the file the binary
  really runs (`RunsFile`: symlinks, then a `wrapProgram` wrapper's `.<name>-wrapped` sibling) — in the Nix layout
  `LIASCAPE_PLAYER_BIN` is a symlink into the `liascape-player` package's wrapper. A binary written < 2 s ago isn't
  started yet.
- **Upgrade** (`UpgradeInPlace`): `QuitOrKill` (the player writes its final snapshot) → the same arguments +
  `--restore` → the same wallpaper at the same place, ~0.2 s. Every wait is on the real condition: the old
  supervisor's exit within 10 s + 3 × the player's last snapshot write time (≤ 120 s: a final `fsync` took up to
  11.8 s under I/O load), then the new player's `hello` (≤ 30 s). Never twice onto the same build. It runs before
  every switch, after a program's own commit (`UpgradeAfterCommit`), and from a 10 s check only while nothing is
  pending.
- **`QuitOrKill`:** `quit` → SIGCONT+SIGTERM the supervisor → SIGKILL the supervisor (its child dies by
  PDEATHSIG; a compositor still alive after that is SIGKILLed too). `/player-engine` → `running {pid, supervisor, exe,
  started, stale}`.

## Dispatch (`PlayerHelper`, `if (PlayerEngine.IsLiascapePlayer)` at the top of each primitive)

| primitive | under liascape-player |
|---|---|
| `SwitchToFile` / `Launch` | `QueueSwitch` → `transition {outputs: "out:*", to: {path, props}, effect from `TransitionService.Pick` or null, align}`; a picked duration 0 = a cut (`effect_id: null`), never a 0 ms effect |
| `SendCommand` / `TrySendCommand` | `Mpv(args)` → `MpvPropertyMap` → a resolver pass (volume/speed literal, mute) or a `Set` |
| `KillCurrentProcess`, `Stop` | a queued `stop` (the process stays up) |
| `AppOps.Trash` | `ShownOrIncomingPaths()`: every layer's content (an effect's `to`) + each requested switch's B unless aligned and still waiting |
| restart daemon, timer daemon, `pending_action.txt`, `timed_state.json` | no-op, logged once (`RetiredUnderPlayer`) — the player's program rotates |

## Rotation wiring (`LiascapePlayerProgram`)

The semantics are the rule's; the player's `recipes/program/` runs them (`docs/player/modules/programs.md`).

- **Load** (`BuildSpec` + `Load`): items in the playlist bar's order (the player shuffles), `defaults` =
  `LiascapePlayerMedia.DesiredGlobal`, each item's props = `DesiredItem` minus what equals the defaults, `skip` =
  `IsSkippedPath`, rotation from `EffectiveRotation`, `transition` from `TransitionService.Effective`, `key` =
  `name:<saved name>` | `bar`, `while_parked` from `RotateWhileParked`.
- **Live edits** are coalescible sets diffed prev → now (`SetRotation`, `SetLimits`, `SetTransition`, `SetOrder`,
  `SetStartMode`, `SetItems`). Every resolver pass feeds the next B (`PushDefaults`, `PushItems`; per item
  `PushItem`, one coalesced push, nothing sent when nothing changed).
- **Mirror:** `program.` events → `IsActive`, `CurrentPath`; seeded by `Sync` at serve start and after a restart,
  or on the queue's worker before a one-shot CLI process's first push (`Unseeded`).

## Targeting (`ResolveNow`)

Per live source: `gain.user` = VolumeDb(transient item ?? override ?? transient global ?? `Volume`), `speed` =
clamp(the same chain, 0.1, 4), `af` = its own item's loudnorm ("" off / `NoAudio` / unmeasured, which kicks a
measure), a scene's `gain.normalize`, `scene_props`, `loudness_key`, the globals (`no_audio`, `hwdec`, `fps_cap`,
`cache`, `demuxer_*`), `gain.mute` = −96 when `PlayerHelper.IsMuted`; plus `lay:*:main.fit` from `VideoScale`.
Numbers diff within 1e-4; a cached pass diffs against the last read plus every successful `set` since.

The live-source cache (`CachedLive`/`ReadLive`, path → source ids) exists because a `state` read per `/preview`
drag value saturated the worker at ~50/s. Ids are never reused within a player process and a source's path never
changes, so only source creation/destruction invalidates it (the rule lists the triggers); a map read while an
invalidation happened is never stored (epoch).

| caller | queue key | sources | props |
|---|---|---|---|
| `/settings`, global volume key, normalization → `ApplyEffective` | `resolve` | all | all + fit (Fresh) |
| reconnection → `ReapplyAll` | `reapply` | all | all + fit (Fresh) |
| `/library/volume\|speed`, item volume key → `ApplyOverride` | batch `override` | those items' | `gain.user`, `speed` |
| `/preview {paths}` / `{global}` | `preview:<prop>:<paths>` / `preview-global:<prop>` | those items' / all | the dragged one, as a transient |
| `/library/scene-props` → `ApplySceneProps` | `sceneprops:<path>` | that item's | `scene_props`, `loudness_key` (+ seed), `gain.normalize` |
| scene estimate landing → `ApplySceneLoudness` | batch `sceneloudness` | those items' | `loudness_key` (+ seed), `gain.normalize` |
| mute change | `set:gain.mute` | all | `gain.mute` (forced: mid-ramp it can read as its old value) |

## Scenes

- `ScenesPlayable` reads the `scene` capability of the current connection's `hello` (a dropped connection forgets
  it), else `liascape-player scene-check` cached 30 s. `/player-engine` → `scenes {available, reason, assets_dir}`.
- Create props: `kind: scene`, `preview` (`LibraryService.PreviewImageOf`), `scene_props`, `loudness_key`,
  `loudness_seed`; `af` is always "" (a scene normalizes through `gain.normalize`).
- `scene_props` diff as JSON (numbers within 1e-6). A key the overrides dropped is sent as its project.json default
  (`WithResets`): LWE has no reset.
- Per-monitor `SceneMonitors[].Fps` → `set out:<name>.scene_fps`, the name mapped like the player's
  `output_name`. GPU settings (`GpuProps`): `AutoThrottleScenes` → `scene_throttle`; `LimitVramPerScene` +
  `SceneVramLimitMib` → `scene_vram_limit_mib` (0 when off); `VramLowMode` → `vram_low_mode`. Cover
  (`PauseWhenCovered` → `pause_when_covered`; the player's own default is `off`) and auto-mute settings go with them.
  `AssertSceneFps` re-asserts all of these once per player process, since a fresh player has its own defaults.
- **Loudness storage** (`MergeSceneLoudness`, per audio configuration): a report replaces the stored measurement
  only if it covers more audible seconds; the applied `loudnessI`/`loudnessTP` move only by ≥ `ApplyHysteresisLu`
  (0.5) from the applied value. `SceneNormalizeDb` = `NormalizeTargetLufs − loudnessI`, never boosting the sample
  peak past −1.5 dBFS (a plain gain has no limiter), clamped −60…+24 dB; 0 when off or unlearned. At create it is
  set directly; live it goes as a 500 ms `animate`.
- **Set once per play** (`NormalizePin`, by source id): a pin is made at a source's first sight from what it runs
  (not the index, which may have moved since), and re-made only when its configuration's first window completes
  (`WindowReached` → `LandSceneNormalize`), the normalization settings change, or a property commit sends a new
  `loudness_key`. A backend restart mid-play pins what each source runs.

## Reconnection and missed switches

`ReconcileShown` (queued essential on `Restarted`, before pending waits fail so a re-armed aligned switch is requested
after it) compares the screen (every layer's content, an effect's `to`, a requested non-waiting B, the parked
wallpaper) with `_intent`: an align:now switch's B from its reply, an aligned switch's B from its
`transition.started`/`.handoff` (until then it is only armed — `_alignedCorrs`), nothing after `Stop()`. The intent
is unknown before our first switch, after `StopAndQuit`, after our switch failed or was cancelled, and after a
`transition.scheduled` for a path we didn't request (`_requesting` covers our own event beating its reply).

A switch or stop lost to a stall (`LostToStall`) becomes the intent, logged, and `ProbeUntilAnswered` sends a quick
`hello` every 500 ms (≤ 30 min) so the stall's end is noticed with no UI open; the answer runs
`ReconcileAfterStall`. A newer click while stalled only moves the intent.

## Events and the outbox

`WaitCorr` checks the recent-outcomes map first (the event can beat the reply: different connections) and asks
`logs {corr, kind_prefix: "transition."}` every 2 s; a new `Generation` ends it as `failed:player restarted`.
`SwitchAndWait` returns `handoff` | `cancelled:…` | `failed:…` | `unreachable` | `caller-cancelled`.

Outbox drain (`DrainOutbox`, on every subscribe ack, one at a time): `outbox.read` page by page, each entry to
`OutboxEvent` in seq order, then `outbox.ack` once every handler returned — a handler that throws stops the drain and
the next subscription retries from there. Live events are acked only as an unbroken run after the last ack
(`AdvanceAcked`), so a store still running holds later acks back. No handler hooked → no drain (an ack would lose
them), which is why `Sync` calls `Hook()` first. An older player (`no_such_verb`) is skipped.

## Auto-mute

`AudioMonitor.ReconcileEngine` (serve start, an AutoMute setting, every 10 s) asks the player for the `automute`
capability on a client of its own (`AudioMonitor._probe`, `AutoSpawn = false`): on the shared client its `hello` was
what discovered a new player process from the timer thread, racing the restart's reapply, and its timeout on a player
busy quitting opened the shared breaker. Capable → the monitor stops and settings go to the player; otherwise
`AudioMonitor` runs while `serve` does. `monitor-daemon` is retired under liascape-player; a leftover one is stopped
by `KillLegacyDaemons`. `toggle-mute` while auto-muted sends `automute.release`.

`OwnStreamFilter` matches our streams from their first event; the switches that once muted themselves came from
counting a stream's level before classifying it, hence "classify, then count".

## Debugging

Adapter log `~/.cache/liascape/liascape-player-adapter.log` (identical lines ≤ once per 10 s); player output
`~/.cache/liascape/liascape-player-serve.log`; `GET /player-engine`; then `liascape-player ctl state|logs|probe`
(skill `player-debug`).

## Tests

- **Integration test** (`scripts/test-liascape-player-adapter.sh [--no-build]`, `RESULT pass=N fail=M`): the real
  backend over HTTP against a private headless player (`--clock real --ao null`), hermetic (temp HOME and XDG dirs,
  own socket and port, display env unset; it aborts unless `/player-engine` says `active: liascape-player`). Every
  player it starts runs the backend's own binary path, so the upgrade check never replaces it under the script.
  Converging state is polled to a deadline, never read after a fixed sleep. `LIASCAPE_IT_KEEP=1` keeps its temp
  dir; `LIASCAPE_IT_AUTOMUTE_ENGINE=audiomonitor` runs the auto-mute section on the old engine.
- **Self-test** (`player-selftest`): pure tables, the queue behind a deliberately slow command, then a round trip
  against a private supervised player — the spawned process is the supervisor, so `hello.pid` differs from it.
