---
paths:
  - "src/backend/Player/**"
---

# liascape-player adapter (`PlayerEngine` setting, Task 17)

`src/backend/Player/` lets the C# backend drive the Rust `liascape-player` (`.claude/rules/player-core.md`)
instead of mpvpaper + liascape-transition + LWE. `AppSettings.PlayerEngine` = `"legacy"` (default) |
`"liascape-player"` (experimental; videos/images/colours, and since Phase 2 Task 11 **WE scenes** when the
player can play them — § Scenes). Settings → Advanced → "Player engine". The switch is live.

## Files
- **`PlayerEngine.cs`** — `IsLiascapePlayer` (cached; lazy from settings.json, refreshed by `/settings`
  via `PlayerHelper.SwitchEngineLive`, loaded at `serve` start so a change compares against what
  actually runs), `WouldBeLiascapePlayer(s)`, `ScenesPlayable(s) = AllowScenes && (IsLiascapePlayer ?
  LiascapePlayerClient.Shared.ScenesAvailable : IsLweAvailable())` (the pure rule `ScenesPlayableFor`, lazy —
  only the running engine is asked), `SceneStatus(s)` / `SceneUnavailableReason(s)` (§ Scenes),
  `ResolveBinary()`, `Status()` (→ `GET /player-engine`, + `scenes`).
- **`LiascapePlayerClient.cs`** — the Command API client (JSON Lines on the unix socket): `Call(cmd, args,
  timeoutMs=2000)` throws `LiascapePlayerException {Code, Message, Hint}` (the player's error object, or
  `io`/`timeout` with a hint); `TryCall` logs instead. One persistent request connection (serialized,
  reconnects after any error/timeout; a stale reply is skipped by `id`) + one subscribed event
  connection on a background thread — **only the kinds it consumes** (final review M11):
  `transition.` (a switch's terminal outcome — handoff/cancelled/failed — and, for the source
  map's invalidation, every other transition kind), `player.stopped`, `source.retire`, `source.broken`,
  `scene.vram_exceeded`, `scene.loudness` (Phase 2, § Scenes — the last one never invalidates the source
  map: no source changed) — a handful
  per switch; `source.` as a whole used to stream every debug `source.position` (~10 Hz per source)
  only to be discarded, and restarts are detected by `hello.pid`, not events — reconnect with backoff
  250 ms → 5 s; each (re)subscription fires `Subscribed` (`EventsLive` = subscribed now).
  `RequestCount` = requests sent so far (round-trip evidence).
  **Two pids from `hello`** (player-core.md § Supervisor / § Command API `hello`): `PlayerPid` = the
  COMPOSITOR (`hello.pid`, what every `cur:`/`srcs:`/mpv-ownership query is really about) and
  `SupervisorPid` = `hello.supervisor_pid` (null = unsupervised, `--no-supervise`). `Generation` bumps
  whenever `PlayerPid` changes (= the compositor restarted, supervised or not — corr ids reset to
  `tr-1`). **Restart awareness**: when the pid changes AND `supervisor_pid` stayed the same as before,
  that's a *supervised* restart (a crash, not a fresh process) — logged with `hello.restart`'s fields
  (the restart event itself was emitted before any client could subscribe, so this is the only way to
  see it) before the existing `Restarted` event fires. `EnsureRunning()`.
  **`Recovered` event** (round 2): fires when a reply answers successfully AFTER the stall breaker had
  been open (`MarkAnswered` — called on every successful reply, ok or error) — "the player answered
  again". **PID identity (`ProcIdentity`, item 5)**: `/proc/<pid>/exe`'s link target (never a cmdline
  substring, which is attacker/third-party-controlled text) + `/proc/<pid>/stat`'s start-time field
  (22nd), captured once per pid at `hello` time and re-checked (`StillIs`) before every signal in
  `QuitOrKill` — a recycled pid (the process died and the kernel handed its number to something
  unrelated) is never signalled as if it were still ours.
  **`Capabilities`** = the last `hello.capabilities` (§ Scenes: `ScenesAvailable`, `SceneStatus`).
  **`Health()`** (`/health/features`, `Helpers/FeatureHealth.cs`): the running player's `hello.health` (one quick
  `hello`, never spawns; `FromRunning`), else `liascape-player health` in the backend's environment (cached 30 s) — a
  player older than this build has no `health` and falls back to the CLI of the new binary.
- **`LiascapePlayerMedia.cs`** — the media primitives PlayerHelper dispatches to (below).
- **`MpvPropertyMap.cs`** — mpv IPC property sets → liascape-player properties.
- **`LiascapePlayerSelfTest.cs`** — `liascape player-selftest`.
- **`scripts/test-liascape-player-adapter.sh`** — the hermetic HTTP integration test (§ Integration test).

## Threading: nothing waits on the player under PlayerHelper's `_lock`
PlayerHelper calls its primitives while holding `_lock` (Stop/KillAll, Apply, the tick, the
video-end lock block…). A stalled player must never stall volume/speed/pause/tick, so:
- **Every mutation is queued** — `LiascapePlayerMedia.Queue(…)`: ONE ordered worker (FIFO task chain on the
  thread pool, never faults). `SwitchToFile`/`Launch` → `QueueSwitch`, `KillCurrentProcess` →
  `QueueStop`, every `SendCommand`/`TrySendCommand` property set and `cycle pause`, every resolver pass
  (`/settings`, `ApplyOverrideLive`, normalization, `/preview`, mute — § Targeting) — all return at once. `SwitchAndWait` switches through
  the same queue (ordered after a queued stop/set) and `WaitLastHandoff` first drains it (a still-queued
  switch is "the last switch").
- **Queries stay synchronous but quick**: `LiascapePlayerClient.QuickMs` = 300 ms (`cur:*` gets, `IsPlaying`,
  time-pos/remaining) — the only player I/O that may still happen inside `_lock`
  (`AppendToActivePlaylist`, `SwitchFromAdvanceOnEndToTimed`, the non-timed reorder paths).
- **The request connection is waited for with the call's own timeout** (`Monitor.TryEnter`), so a
  query never sits behind a queued switch that waits out its 2 s on a stalled player.
- **Stall breaker**: a request that times out opens a 3 s window in which every request fails fast
  (`timeout`, "liascape-player is not responding") — a SIGSTOPped player costs one 300 ms timeout, not one per
  caller. The trip itself is logged with its cause (`no reply to `<cmd>` within N ms (waited …; gen2 GCs
  meanwhile …, thread-pool queue …, threads …)`) — the requests after it only say "not responding" and
  most callers swallow those. The speed storm tripped it 6× in ~25 min with the player answering < 3 ms
  per request and never > 50 ms in 6860 direct pings; cause not reproduced since the log line went in
  (docs/TODO.md). The first request after the window tries for real. **A STARTING player is not a stalled one
  (2026-10-29 cold boot)**: the player binds its socket first and answers ~1 s later (PipeWire bus ≤ 500 ms, EGL,
  CUDA); the restore's `monitor-daemon` (another process — its `IsPlaying`, a 300 ms `get`) connected in that window,
  its greeting `hello` timed out, the breaker opened on the player the restore had just spawned (and the `get` was
  still sent into it and timed out again — 2 × 300 ms). Now, until a player on that socket answered this client once
  (`_answeredBorn` = the socket file's mtime = its bind time; a supervised restart's child binds anew), a request
  waits for its first answer up to **`StartGraceMs` = 5 s after the bind** (`StartingMs`), and for the request
  connection's lock as long — so a parallel caller waits behind it instead of failing "busy"; only a timeout past
  that trips the breaker. A player that answered once gets QuickMs as before (the SIGSTOP checks unchanged). While
  THIS process starts one (`EnsureRunning`'s spawn, `UpgradeInPlace`'s new player: `BeginStarting`/`EndStarting`), a
  request also waits ≤ 5 s for the socket to appear instead of failing "no player". A greeting that times out ends
  its request (`Greet`) — never sent into a player that just tripped the breaker. Guard: self-test
  `StartupGraceAssertions` (a fake player that binds and answers 1 s later: a QuickMs `get` + a parallel `hello`
  both answered, no breaker; then a stall still fails in ≤ 450 ms and opens it; a request during our own start waits
  for the socket — RED before: 635 ms, two timeouts, the breaker open, "busy", "no player"). `EnsureRunning` never spawns a second
  `serve` over a stalled (alive) one. Mutations queued while it was stalled are dropped (logged) — and
  **R81** catches up: the breaker closing fires `LiascapePlayerClient.Recovered` → `LiascapePlayerMedia.OnRecovered`
  → `ReapplyAll()` (below), so a dropped set isn't lost for good.
- **Every queued command's own `Call` uses `LiascapePlayerClient.QuickMs`** (item 6) — a queued property set
  (or a `transition`'s `fit` pre-assertion, or a per-item `set`) is never worth the 2000 ms default; a
  backlog behind a stalled player then drains in ≤ 300 ms per item instead of up to 2000 ms. `Switch`'s
  own `transition`/`cancel` request keeps the default (opening a new source is itself ms-scale under
  `player-core.md` § Runtime, but a switch is a heavier, rarer operation than a plain set — no reason to
  shave its margin).
- **The queue coalesces; its depth is capped** (`LiascapePlayerMedia.MaxQueueDepth` = 256, `QueueDepth`,
  `Coalesced`). The worker is a pending list (`LinkedList`) + one worker loop on the thread pool, so a
  pending command can be removed. Three kinds:
  - **essential** (`QueueEssential` — switch, stop, `QueueNewSession`, `cycle pause` → `TogglePause`,
    the in-place upgrade, `SwitchAndWait`'s own switch): never dropped (bypasses the cap, still counts
    toward the depth) and a **barrier** — nothing coalesces across it, so a set is never reordered
    across a switch/stop.
  - **coalescible** (`QueueSet(key, …)`, key = target + property): `Mpv()`'s property sets
    (`set:<prop>` — a volume/speed literal and a mute change are resolver passes, the rest `Set`, which
    always targets the same alias for a prop) and every resolver pass (§ Targeting — each reads all its
    inputs when it runs, so the newest pending one covers older ones): `resolve` (`ApplyEffective` —
    `/settings`, the volume key on the global, normalization, a loudness measurement landing),
    `override:<path>` (`ApplyOverride`), `preview:<prop>:<sorted full paths>` (or `<playing>` without
    paths), `preview-global:<prop>`, `reapply` (`ReapplyAll`); plus `set:loop` (`SetLoop`). A new one **removes** a
    still-pending command with its key enqueued since the last barrier and goes to the tail: every
    other command keeps its order and only a write that a later write of the same targets overwrites
    anyway is lost — the final state is what the whole sequence would leave, and a burst (a slider
    behind a stalled player) holds ONE pending command per key. A coalesced command is admitted even
    at the cap (it doesn't grow the queue); the replaced one's task completes with its replacement
    (`Drain` stays correct).
  - anything else (`Queue(…)`): a barrier, refused at the cap.

  At the cap a command that can't coalesce and isn't essential is logged and dropped (R81 catches up
  after a stall). Before (speed storm): admission was refused for every set past 256, the NEWEST
  included — the storm's own final restore sets were dropped.
- `SwitchEngineLive` reads `IsPlaying` before taking `_lock`, tears the session state down under it,
  and talks to liascape-player only AFTER releasing it: `StopAndQuit()` (drain the queue ≤ 3 s, `stop`, `quit`,
  then escalate against the **supervisor** — SIGCONT+SIGTERM, then SIGKILL, each waiting ≤ 1.5 s for the
  process to go; see `LiascapePlayerClient.QuitOrKill` below) runs synchronously before the new engine starts,
  so legacy and liascape-player are never both on screen.

## Binary resolution (`PlayerEngine.ResolveBinary`)
env `LIASCAPE_PLAYER_BIN` → next to the running liascape executable (`Environment.ProcessPath` dir, then
`AppContext.BaseDirectory`) → the repo dev tree `src/player/target/{release,debug}/liascape-player` (walk up
from the assembly; **release first** — debug is `opt-level 0` and the player mixes audio itself, so a
player change reaches the dev session only once `cargo build --release` ran) → `PATH`. **Missing → `IsLiascapePlayer` is false** (legacy keeps working), one log line,
and `/player-engine` reports `available:false` + the reason → the UI row is disabled with it (switching
back to Legacy always stays possible).

## Lifecycle
- `EnsureRunning()` (only a **switch** calls it — queries/sets never spawn): connect, else
  `setsid sh -c 'exec liascape-player serve …'` (no `--headless`; session env inherited — `WAYLAND_DISPLAY`
  etc.; stdio → `~/.cache/liascape/liascape-player-serve.log`, never a pipe: the player outlives the
  backend) and wait ≤ 3 s for the socket (its first `hello` may wait the startup grace, ≤ 5 s after the bind —
  § Threading "A STARTING player"). **Arguments:** the first start runs `serve` (`--socket` when not
  the default); once this client has talked to a player, it runs **that player's own arguments + `--restore`**
  (`_serveArgs`, read from its supervisor's cmdline when a new player pid answers `hello`, minus
  `--supervised/--restore/--restarted`) — a player that went away (a failed upgrade, a killed or given-up
  supervisor) comes back with the same `--headless/--outputs/--socket/--ao`, showing what it showed. Before
  (2026-10-28), a failed upgrade under I/O load fell back to a plain `serve`: no `--headless`, no `--restore`. Exit 1 ("already running" on the instance lock) keeps
  connecting to the winner. A failed start isn't retried for 10 s (`LastError` → `/player-engine`).
  **Item 4, before any of that**: if the last-known supervisor pid is still alive (`ProcIdentity`-
  checked), a switch landing mid-supervised-restart must NOT race it to spawn a second `serve` into the
  ~150-260 ms gap where the socket/instance-lock are briefly unheld (the dying child's bind goes with
  it; the replacement rebinds moments later) — wait ≤ 2 s for the socket instead, and only fall back to
  spawning if that truly times out (a stuck supervisor, not a normal restart).
  **Item 3, exit codes** (player-core.md § Supervisor / § Runtime, `ExitHint`): 1 already-
  running/unusable socket (never retried), 2 usage, 3 compositor connection lost mid-run, 4 the
  supervisor gave up (crash budget or `EXIT_NO_COMPOSITOR`'s own budget exhausted), 5
  `EXIT_NO_COMPOSITOR` (not available *yet* — its own supervisor retries this with backoff; seeing it
  from EnsureRunning means that backoff hasn't succeeded within our 3 s wait, not that it gave up) — all
  surfaced via `LastError` → `/player-engine` `reason` + one log line; EnsureRunning never crashes on any
  of them, only reports `false`.
- **In-place upgrade** (`LiascapePlayerClient.StaleReason` / `UpgradeInPlace`, `LiascapePlayerMedia.StartUpgradeWatch`).
  The player outlives the backend and the app on purpose, so a rebuilt or reinstalled binary never reached
  a running one: fixes "persisted" for hours (a 13:26 build still running at 19:00). **Stale** = the
  running compositor isn't the build this backend starts — compared as FILES, never path strings (one
  checkout is `/home/…` and `/mnt/…/@home/…`): size + mtime through open handles, `/proc/<pid>/exe`
  opening the running binary even after a rebuild replaced it (`… (deleted)`); Nix by store root
  (`/nix/store/<hash>-name` — every store file has mtime 1). Both compare the file the binary **really runs**
  (`RunsFile`: symlinks resolved, then a `wrapProgram` wrapper's `.<name>-wrapped` sibling): in the Nix layout
  `LIASCAPE_PLAYER_BIN` = `liascape`'s `libexec/liascape/liascape-player`, a symlink into the **`liascape-player`
  package** (another store path) — its wrapper, while the process runs that package's `.liascape-player-wrapped`.
  Compared by the symlink's own store root (before 2026-10-29), the player the cold boot's restore had just started
  read as "out of date" and was restarted at once. A different build stays stale (another wrapped binary, another
  store root, the dev tree's plain binary vs a Nix one). Guard: self-test `StaleThroughWrapperAssertions` (pkg-a's
  libexec symlink → pkg-b's wrapper script → `exec` its `.liascape-player-wrapped`, a real running process; plus the
  installed `/nix/store/*-liascape-0.1.0` layouts when present); a binary written < 2 s ago isn't started yet.
  **Upgrade** = `QuitOrKill` (the player writes its final snapshot) → the supervisor's own `serve`
  arguments (from its cmdline, minus `--supervised/--restore/--restarted`) + `--restore` → the same
  wallpaper at the same place, paused stays paused, ~0.2 s; then events resubscribe and the `Restarted`
  handler re-applies settings (R81). **Every wait is on the real condition with a deadline that scales**
  (2026-10-28 — under I/O load the old player's clean quit took 3.1–3.3 s: its final snapshot is fsync'ed,
  0.1–11.8 s measured; the fixed 1.5 + 1.5 s SIGTERMed and SIGKILLed it mid-snapshot, the new player's
  fixed 3 s wait gave up and the next switch fell back to a plain `serve`): the old **supervisor's exit**
  for `QuitWaitMs` = 10 s + 3 × the player's own last snapshot write time (`probe snapshot`
  `last_write_ms`: the write in flight + the final one), ≤ 120 s, before any signal (then SIGTERM → the
  supervisor's own 10 s stop wait → SIGKILL, 12 s each); then the **new player's `hello` from a new pid**
  while the process we started lives, ≤ 30 s (it exiting ends the wait, with its exit hint). A failure
  keeps `_serveArgs`, so the fallback (`EnsureRunning`) starts the same arguments + `--restore`. Never twice onto the same build (a check that can't see through
  some wrapper must not restart the player every 10 s). **When**: before every switch (`Switch`, after
  `EnsureRunning`), and from a 10 s check in `serve` only while **no transition is pending** — an
  armed align:end switch would be dropped by the restart and the rotation would switch early (failure
  path), so an advance-on-end playlist upgrades at its next switch. `AutoSpawn=false` (self-test) never
  upgrades. `/player-engine` → `running {pid, supervisor, exe, started, stale}`.
- Socket: `$LIASCAPE_PLAYER_SOCKET` → `$XDG_RUNTIME_DIR/liascape/liascape-player.sock` (mirrors `paths.rs`).
- `Stop()` = a queued `stop` (the process stays up); switching the engine AWAY from liascape-player =
  `StopAndQuit` (stop → quit → TERM → KILL, synchronous, outside `_lock`).
- **`LiascapePlayerClient.QuitOrKill` targets the SUPERVISOR, never the compositor alone.** Order: `quit`
  over the socket (the compositor exits 0 → the supervisor classifies that as a clean exit and exits
  too — no restart) → else SIGCONT+SIGTERM the **supervisor pid** (`SupervisorPid ?? PlayerPid` —
  unsupervised falls back to the compositor, same as before Task 16) → else SIGKILL the supervisor
  (its child dies via `PR_SET_PDEATHSIG`; if the compositor pid is somehow still alive a moment later,
  SIGKILL it directly too). **Never SIGTERM/SIGKILL the compositor pid while its supervisor is still
  alive** — the supervisor treats a dead/signalled child as a crash and restarts it with `--restore`,
  which is exactly what an engine switch away from liascape-player must not leave running.
- `SwitchEngineLive(prev, cur)`: `IsPlaying` (outside `_lock`); under `_lock` — `SaveTimedState`,
  `TeardownTimer` (state only), and for a LEGACY old engine `KillCurrentProcess` (process kills only);
  after `_lock` — for an liascape-player old engine `StopAndQuit`; then `Refresh`, then replay on the new
  engine: a running timed playlist via `RestoreTimedPlaylist` (resumes at the item it was on), else
  `LastSession` (timed / playlist / single). Nothing playing → nothing started.

## Dispatch points (`PlayerHelper`, each `if (PlayerEngine.IsLiascapePlayer) { … }` at the top; legacy
code below it is unchanged)

| method | under liascape-player |
|---|---|
| `SwitchToFile` | `LiascapePlayerMedia.QueueSwitch(path, settings, cfg.Enabled ? cfg : null, alignEnd:false)` → `Switch` = `transition {outputs:"out:*", to:{path, props}, effect_id/params/duration_ms/method from TransitionService.Pick or effect_id:null (cut), align:"now"}` — a scene folder too (`kind: scene`, § Scenes); a scene when `!ScenesPlayable` → `KillCurrentProcess` (AllowScenes=false parity; the pickers never hand one over) |
| (duration) | `TransitionService.PickDuration` clamps 0–10000 ms (the floor was 50; owner QOL 2026-10-28); a picked **0 = a cut** — `Pick` returns null, so the request carries `effect_id: null` (the player's 30 ms anticlick swap), never a 0 ms effect; 1–49 ms go as that `duration_ms` (gains still ≥ 30 ms, R42). Self-test `TransitionDurationAssertions`; matrix `plTrShort` / `plTrZero` |
| `Launch` | a queued cut (`tcfg:null`) — whatever was on screen was just stopped |
| `DoVideoEndWait` (both V→V branches: transitions on AND the transitions-off gapless append; since Phase 2 any switch incl. a scene side — a scene A never ends, so with A a scene (a restore re-arming onto one; the tick moves scenes on itself) it is `align:"now"`, legacy's "prevIsScene → switch now"; the failure fallback switches to the item AFTER a B that is skipped by then, e.g. a scene that broke before its handoff) | `WaitLastHandoff` (the previous switch's `transition.handoff` — a new request would SUPERSEDE a pre-Running one), then `SwitchAndWait(next, …, tcfg: on ? cfg : null, alignEnd:true, ct)`; then the existing `lock { …; PostSwitch(next) }`. Not handed off (failed / unreachable / cancelled by someone else / timed out) → **a growing back-off** (I4: 1 s, 2 s, 4 s … ≤ 30 s while consecutive switches keep failing, `LiascapePlayerMedia.NextFailureBackoff`; a handoff resets it), then `SwitchToFile(next)` now — a player refusing for any reason can never spin the playlist. The aligned wait itself is **bounded** (M2: A's remaining time + `AlignBackstopSlackSec` 15 s, behind the player's own 10 s `align_fallback`; on timeout the corr is cancelled) — **re-derived each time it runs out** (`AlignedWaitCheck`, speed storm): while the player has **no output** (`state.outputs` empty — monitors off: it holds the aligned switch until an output shows it, player-core.md § Runtime, I4) or is **paused** (its clock and the switch stand still) it keeps waiting; otherwise it waits A's remaining time at its *current* speed + slack again as long as A's `time_pos` moved since the last check (first baseline: A's position when armed), and only gives up when A stopped moving (a stall). Before, the bound read at arming was final: a slow-down after arming (4× → 0.5×) or a pause longer than remaining + 15 s cancelled the switch and cut A long before its end — switching *while paused*. `LIASCAPE_TEST_ALIGN_BACKSTOP_SLACK_SEC` shortens the slack for the IT only. `ct` cancel → `cancel {corr}`. **B becomes the session's current item when its effect STARTS** (`transition.started` → `SwitchAndWait`'s `onStarted` → `Commit` under `_lock`: `_waitingForVideoEnd` off, `wallpaper-changed`, `PostSwitch` — the next pre-fetch + its waiter, which first waits for this one's handoff), not at its handoff: from Running the player shows B (`cur:*` = B) and a new request commits it (→ `handoff {committed}`), a cancel would snap back to A. Counted at the handoff, a next in that window (the effect's duration) cancelled the running switch and switched now to the same pre-fetched B — the user's next did nothing (IT "/next mid-wait" flaked ~1 in 6 /next, `cur a.mp4 → a.mp4`); a prev went to the item before A. Legacy commits at its overlay's start the same way. Whichever comes first commits (a `committed` flag under `_lock` + `_waitCts.Token == ct`): the started callback, or the handoff when the event was missed; a committed switch's own wait is never cancelled again (a next cancels only the following, not-yet-requested one) and a non-handoff end after it is only logged. Guard: IT "/next during the aligned switch's EFFECT". The `_lastSwitchTarget` settle gate and the playtime polling are legacy-only |
| `RearmAlignedSwitch` (from `/playlist/state` when the playlist's transitions change, `/settings` when the global ones or `TransitionMethod` do) | the armed aligned switch was **requested at arm time** with the effect + duration of then (the player times it for A's end — legacy picks its effect when the overlay starts, near A's end), so a transition change while one is armed (advance-on-end: for the whole clip) ran the OLD effect at A's end: cancel the wait and re-arm it to the same `next` (`CancelVideoEndWait` + `ArmVideoEndWait`) → a fresh request with the new config. No-op under legacy / with nothing armed. Guard: matrix `pending × plTrOff/plTrDuration/plTrEffect` |
| `SendCommand` / `TrySendCommand` | `LiascapePlayerMedia.Mpv(args)`, queued: property sets → `MpvPropertyMap` → a volume/speed literal (`/volume {value}`) = a resolver pass with it as the PLAYING item's transient value (every other source keeps its own), `mute` (SetMute / SetUserMute) = a forced resolver pass of `gain.mute` from `PlayerHelper.IsMuted`, the rest → `Set` (layer props → `lay:*:main`, `pause` → `player.paused`, else `srcs:*`); `cycle pause` → `TogglePause` (so PlayerHelper's `TogglePause` needs no change of its own; § Pause); `loadfile`/`playlist-*`/`loop-file`/`loop-playlist` are mpv-playlist plumbing → acknowledged and dropped (the timed machinery owns rotation, the recipe owns A's loop) |
| `TryQueryCurrentPath` / `TryQueryTimePos` / `TryQueryProperty` / `TryQueryTimeRemaining` | `get cur:*.path` / `.time_pos` / mpv-name map / `(duration − time_pos)/speed` (ambiguous across outputs → the first output's `cur:`) |
| `KillCurrentProcess` (→ `KillAll`, `Stop`) | a queued `stop` (callers hold `_lock`) |
| `IsPlaying` | something is on screen (`cur:*.path`) |
| `/settings` (ServerHost) | `PlayerHelper.ApplyEffectiveLive(prev, cur, playing)` instead of SetVolume/SetSpeed/SetVideoScale/ApplyNormalizationLive/ApplyPlaybackSettingsLive: ONE resolver pass (`ApplyEffective`, Fresh — every live source its own value of every resolved setting + the layer fit, diffed against one `state` read: a no-op save, e.g. a theme change, sends nothing), Loop via `SetLoop` (`srcs:*`) only when it changed and the wallpaper is a single non-timed one (the legacy guard: under rotation the recipe owns A's loop), and the timed tick's speed factor (`_currentSpeed`) = the playing item's effective speed |
| `ApplyPlaybackSettingsLive` | legacy only (`/settings` → `ApplyEffectiveLive` under liascape-player) |
| `AdjustVolume` (the volume keys) | on an item's own volume → `ApplyOverrideLive` (below); on the global → `ApplyEffective` (every source its own effective volume — an overridden one keeps it) |
| `ApplyOverrideLive` | `ApplyOverride(path)`: a resolver pass on that item's own source(s) (may be a pending B) — `gain.user` + `speed`, diffed against the cached values; reports the effective speed back when it's what `cur:*` shows (`_currentSpeed`) |
| `ApplyNormalizationLive` / `PlayerHelper.OnLoudnessMeasured` (from `LibraryService.EnsureLoudnessAsync`, once a measurement is stored) | `ApplyEffective` → **every** live media source gets ITS OWN item's `af` (`NormalizeAf(its path)`: loudnorm at the target, "" when off / NoAudio / unmeasured — that one kicks a measure), diffed. It used to set `cur:*`'s item only: an effect's outgoing A, a pending B (armed for A's end — it then played its whole clip with the old filter) and every source while no output shows one (no `cur:*`) kept the old `af`; and an item that started unmeasured (or was playing when normalization was switched on) played un-normalized until its next switch — now it gets its loudnorm the moment it's measured (normalization on). Legacy: `set af` when it's mpv's current file. Guard: matrix `set:normalizeOn/Off/Target/Fresh` × effect / pending / pausedEffect / noOutput |
| `/preview` (ServerHost) | `LiascapePlayerMedia.Preview(volume, speed, paths)` → a resolver pass on the source(s) of `paths` only (the modal's edited item(s) — on screen, either side of an effect, a pending B), the dragged value as their transient (nothing persisted), the dragged prop only, diffed against the cached values: ONE `set` per source per value, no `state` read while the map is cached; queued coalescible per selection + property; no `paths` → the playing item (`cur:*`, mid-transition the INCOMING side — why the modal always sends paths). Legacy: applied only when the current file is in `paths`. **`global: true`** (the Settings page's sliders) → `PreviewGlobal`: a pass over every source with the dragged value as the transient GLOBAL — an item with its own override for that field keeps it (override ?? global, R61) — coalescible per property (`preview-global:<prop>`) |
| scene checks (`ApplyPlaylist`, scene launch, `IsSkippedPath`) | `PlayerEngine.ScenesPlayable(s)` (§ Scenes); `IsSkippedPath` = scene && (!playable \|\| (crashed && !whitelisted)) — D6, `PlayerHelper.SkipScene`; the V→S lead in `Tick` and the tick's LWE crash branch (`!IsLweRunning`) get `!IsLiascapePlayer`; `UpdateTimedSettings`'s "a scene plays" = `ScenePlaying` (liascape-player: the playing history item is a scene folder) |
| `Apply(scene)` | liascape-player: `SceneUnavailableReason(s)` → its message (scene support off / the player can't: no worker, built `--no-scenes`, no WE assets — `scene-check`'s reason), a crashed non-whitelisted scene → "This scene crashed and won't be played — tick Whitelist…"; legacy's own AllowScenes / LWE-missing messages unchanged |
| `ApplyTimedPlaylist` (liascape-player) | starts at the first item that isn't skipped (a crashed scene first in the list used to stop playback in `SwitchToFile`); `AdvanceToNext`'s history walk (a next after a previous) steps past a skipped one too |
| `OnSceneBroken(path)` (from `source.broken`) | § Scenes |
| `/next` `/prev` `/random` (+ `liascape next\|previous\|random`, `random`) | `TryStepLibrary` steps past `IsSkippedPath` items (bounded to one library pass), `ApplyRandom`/`RandomAndLaunch` drop them from the pool — so the picker never hands `Apply` a scene. An all-unplayable library throws `InvalidOperationException("No playable wallpaper…")` → the routes return **409** `{error}` (never a 500) and the CLI prints it + exits 1; the playing wallpaper is untouched. Same rule under legacy + `AllowScenes=false` (it 500'd there too). |
| `ApplyTimedPlaylist` (Play / play-from / a timed restore) | `QueueNewSession` before its first switch (I1 — it was missing: Play and play-from while paused stayed paused; Apply/Launch already had it) |
| `StepBackAndLaunch` (timed `prev`) | the item before `PlayingHistoryIndex`; none (a fresh session's first item) → nothing at all. With an advance-on-end pre-fetch it used to undo only the pre-fetch and relaunch the playing item — restarted, its armed switch cancelled |
| `AppOps.Trash` | `LiascapePlayerMedia.ShownOrIncomingPaths()` (one `state` read after a bounded `Drain`): every layer's content (an effect's `to`, never its leaving `from`) + each requested switch's B unless it's an aligned one in `waiting_start` — so trashing an item whose switch was requested but not yet running still stops/advances (web-backend.md § Trash) |
| restart daemon / timer (`UpdateRestartTimer`, `SpawnRestartDaemon`, `RunRestartDaemon`, `RestartCurrentAndLaunch`) | no-op — the leak-restart is an mpvpaper workaround |

`AudioMonitor.GetNonMpvStreamIdsAsync` (legacy auto-mute, still used in Phase 1): under liascape-player
`LiascapePlayerMedia.OwnStreamFilter()` excludes the player's own streams **by ownership (R69)** —
`application.process.id` == `PlayerPid`, the **compositor's** pid (from `hello.pid` — libmpv runs
in-process inside the compositor, never the supervisor, so this is the right pid unchanged by Task 16),
`node.name` starting `liascape-player-` (the bus `liascape-player-bus*`, and Phase 2's scene worker streams
`liascape-player-scene.<source id>` — their own process, so the pid check misses them),
`target.object`/`Sink:` = the `liascape-player-bus` sink (index via `pactl list short sinks`), or
`application.name == "liascape-player"` (an extra match, not the only one). Legacy: unchanged.
**Timing, not just identity (owner report 2026-10-28: "auto mute is muting itself when a transition plays").**
Every own stream carries those properties from its first `new` event on (measured on a private PipeWire: mpv's
`node.name = "liascape-player"`, `application.name = "liascape-player"`, `target.object = "liascape-player-bus"`, pid = the
compositor; a scene worker's `liascape-player-scene.<id>`; the bus playback; no event ever lacked them) — the filter
was right every time, but `AudioMonitor` COUNTED a new stream's level at once and classified it ~120 ms later
(100 ms delay + the listing), and every `change` event (the uncork ~200 ms after `new`) re-added an already-
excluded stream for another window. Each switch's incoming B (a video's mpv stream, or a scene's worker stream —
every method, every V/S combo, the first `/apply` too) ramps in at ≈ −62 dB, over the −70 dB default threshold →
with a 0 ms mute delay `gain.mute` −96 on every source for a hitch (~20–60 ms), and for the whole unmute delay
when that's > 0. Fix: **classify, then count** (`AudioMonitor.WatchStreamsAsync`, player.md § Auto-Mute): parec
starts at once (warm-up) but its level counts only once the stream is classified foreign (one listing, ~25 ms,
inside parec's own ~65–76 ms to first data — a foreign stream mutes as fast as before), and an id classified ours
is never re-watched until its `remove`. Guard: IT § "auto-mute never hears our own switches" — a private
PipeWire + pipewire-pulse + WirePlumber, the player on its real bus, AutoMute 0/0 ms at −70 dB, V→V/V→S/S→S/S→V ×
full-live/reveal/frozen → no `gain.mute` −96 ramp; a foreign `paplay` still mutes (latency printed, ≤ 1 s) and
unmutes when it ends.

## Rotation (advance-on-end minimum / maximum / separate scene timing; redesigned 2026-10-28)
Owner-approved model (the play-time limits added the same day were folded into it; "Separate timing for scenes" + 0 =
off everywhere added the same evening — owner: "minimum and maximum should both support '0' which then just turns them
off … a toggle which … lets you configure differently for scenes"). Per rotation (the globals, or a playlist's own when
`OverrideGlobalSettings` — `PlayerHelper.EffectiveRotation` → `(Interval, Advance, Max, SeparateScenes, ScenesAfter)`):
- **"Switch when video ends" OFF** (`SwitchWhenVideoEnds` false): `IntervalSeconds` is **"Switch every"** — a plain timer
  (the tick's countdown, speed-scaled as before, switches `align:now`, mid-video). Unchanged; the maximum doesn't apply.
- **ON**: the SAME field is the **"Minimum play time"** (`IntervalSeconds`, relabelled in the UI — one value: toggling
  shows it under the other label), and **"Maximum play time"** (`MaxPlaySeconds`, clamped 0…359999 in the setters) sits
  below it. Both **wall-clock seconds, 0 = off** (`PlayerHelper.PlayLimits`; `MinPlayMs` = the interval while advance is on).
  The tick has **no countdown** under advance-on-end.
  - **Video**: plays at least the minimum, then switches at its next end (align:end). A clip shorter than the minimum
    loops on and advances at the end of the loop that reaches it, never mid-loop: `DoVideoEndWait` (liascape-player) runs
    `HoldForMinPlay` before it requests the aligned switch — every ≤ 1 s and right after each loop's wrap it reads A's
    remaining time (`LiascapePlayerMedia.TimeRemaining`, wall clock at A's speed) and requests only once
    `played + remaining + 150 ms ≥ min` (`MinPlayReached`). The player's `align:end` makes A's CURRENT loop its last
    (player-core.md § Align), so a request ~0.1 s into the crossing loop ends exactly there, with B given that whole
    loop to get ready. A must loop meanwhile: with `Loop` off the hold turns A's loop on (`SetLoop(true)`; align:end
    turns it off again). While held, the player has **no** armed switch (nothing is requested until that loop) — a
    clip already ≥ the minimum is never held. Minimum 0 = switch at every end.
  - **Still image** (it never ends — `align:end` on a still is `Now`): shows for the minimum (0 → it flashes by) —
    with "Separate timing for scenes" off; on, see below.
  - **Scene** (never ends), toggle off: **the minimum reached IS its end** — the tick's `SceneMinReached` advances it then
    (align:now, its transition), the same moment a still image moves on. No minimum → the maximum moves it; neither →
    it plays until a user switch (the Settings hint says so). Judgement call: "minimum then the next end" with no end
    to wait for = the minimum; holding a scene to the maximum instead would make the minimum meaningless for scenes.
    `ApplyPlaylist`'s old fallback (scenes + no interval → `GlobalIntervalSeconds`) is gone, and a playlist play under
    advance-on-end (`AppOps.PlayPlaylist`) always goes through `ApplyTimedPlaylist`, minimum 0 included (it used to
    take `ApplyPlaylist` there, where ONE item — a trash leaving one survivor — became a plain non-timed launch an Undo
    could never re-arm; matrix `pending × selTrashUndo:shown+other`, `seq:trash×2+undo×2`, `seq3:playlistBarRemove+…`).
  - **Maximum**: once the playing item played that long the rotation advances **now** with its transition, even
    mid-video (align:now; an armed end-of-video switch is cancelled and its pre-fetched B taken — `AdvanceAndLaunch`):
    the tick's `MaxPlayReached(advance-on-end, CanRotate, played, max)`. **A cap beats the minimum** (max < min → the
    max fires; documented, not enforced).
  - **0 = off, strictly, for both** (global + playlist): minimum 0 → a video switches at its first end however short
    (a 1 s clip at 1 s); maximum 0 → never cut — a 10 h video plays to its end. IT § "0 = off for both limits".
  - **"Separate timing for scenes"** (`GlobalSeparateSceneTiming` / `PlaylistSettings.SeparateSceneTiming`, the row
    under the two fields, only with "Switch when video ends" on) + **"Switch scenes after"**
    (`GlobalSwitchScenesAfterSeconds` / `SwitchScenesAfterSeconds`, wall-clock s, clamped 0…359999 like the max; its
    own row only while the toggle is on). **On**: a scene AND a still image (neither ever ends) switch once they played
    that long (align:now, their transition) — 0 = off: they stay until a user switch; the minimum / maximum apply to
    videos only. **Off**: the rules above (scenes / images follow the video fields). Judgement calls: ONE field, not a
    scene min/max — "at least … then at the next end" and "at most" mean nothing without an end, a single "after"
    explains itself in one hint line; **images follow the scene rule** while it's on (they never end either — with a
    minimum 0, the owner's model for videos, an image would otherwise flash by). A video is never touched by it.
    `PlayerHelper.ItemPlayRule(kind, min, max, separate, scenesAfter)` → `(MinMs, MaxMs)` is the whole table (pure,
    self-test): video `(min, max)`; toggle on → scene / image `(after or NeverMs, 0)`; off → scene `(min or NeverMs,
    max)`, image `(min, max)`. `NeverMs` (= long.MaxValue/4) is never reached and never overflows the hold's
    arithmetic. The tick reads the playing item's rule (`PlayingRule`, `PlayKindOf` — `LiascapePlayerMedia.IsImagePath`)
    for its maximum and a scene's end (`SceneMinReached` with the rule's minimum); a still image's time is
    `HoldForMinPlay` (its rule's minimum; NeverMs → held until a user switch or a live edit — it re-reads ≤ 1 s apart;
    no loop toggling for a still).
  - **Defaults** (2026-10-28, "off unless set"): minimum 0, **maximum 0** (was 1800 — a 30-min cut the owner would
    not expect), **separate timing ON, scenes after 1800** — a video plays to its end, a scene / image switches after
    30 min (with the toggle off and both 0 a scene would never move and an image would flash by). Only a file without
    the keys sees them: the one-off migration writes them for every combo.
- **Removed**: "Wait for video to end after interval" (`GlobalWaitForVideoEnd` / `PlaylistWaitForVideoEnd` /
  `PlaylistSettings.WaitForVideoEnd` / `LastSession.WaitForVideoEnd` / `TimedState.WaitForVideoEnd`, `_waitForVideoEnd`
  and its tick branches) and the separate `GlobalMinPlaySeconds` / `PlaylistSettings.MinPlaySeconds` (merged into the
  interval field). An old settings.json / playlist / session file's keys load as unknown ones — **no in-app
  migration** (owner: nobody else uses the app); a one-off jq script (v2, `/tmp/rot-kryxzort/migrate-once.sh`, never in
  place) converts the owner's files: adv+wait → EXACTLY the old behaviour: min = the old min (0: every video end),
  max = old max, separate scene timing ON with scenes after = the old interval (∧ the old max when both are set — the
  old max moved scenes too); adv, no wait → min = old min, max = the old interval cap ∧ old max, separate off; timer +
  wait → advance-on-end with min = interval, separate off; timer → unchanged, separate off; a v1-migrated file → + the
  scene keys, off (= what it did). Dead `SwitchFromTimedToAdvanceOnEnd` / `SwitchFromAdvanceOnEndToTimed` removed.
- **Play time** (`_itemPlayedMs`): counted by the tick in wall clock (never scaled by speed — a 2× clip with max 60 s
  plays 60 real seconds) and **not while paused** (the paused tick returns before it); reset by `PostSwitch` (every
  switch — under liascape-player an aligned switch's B from its effect's start), `ApplyTimedPlaylist`, `RestoreTimedPlaylist`
  (the item restarts, like the countdown). **Never reset by an edit.** Persisted in `timed_state.json`
  (`ItemPlayedMs` + `PlayedSavedAtMs`); `LoadTimedState` adds the time since that save unless paused
  (`PlayedAfterLoad`) — the player outlives the backend and played on while no process counted (a backend restart,
  the `timer-daemon` hand-over, which is SIGKILLed without saving).
- **1-item playlist**: never switches itself (`CanRotate`; no aligned switch is armed, no limit fires — the scene
  timing neither).
- **User switches** (next / prev / random / restore / play-from): the new item's play time starts at 0.
- **Live**: `/settings` (the global max / scene toggle / scenes-after changed → `ApplyPlayLimitsLive` with the
  EFFECTIVE values, before the rotation's own live-apply; interval / advance → `ApplyRotationLive` when the playlist
  follows the globals) and `/playlist/state` (`AppOps.SavePlaylistState`: the effective rotation diffed prev → now, so a
  reorder / unrelated save does nothing). A new maximum / scene timing is read by the next tick (already played past it
  → advances now; a held image within 1 s); a new minimum (`UpdateTimedSettings`, advance unchanged) re-arms
  an aligned switch already armed or held (`CancelVideoEndWait` + `ArmVideoEndWait`, same B). A session (re)start /
  restore / resume reads the maximum + the scene timing from the config (`RefreshPlayLimits`: the current playlist
  state + settings) — the minimum is the session's own interval (`ApplyTimedPlaylist`'s,
  `LastSession.TimedIntervalSeconds`, `timed_state`).
- Tests: self-test `PlayLimitAssertions` (`EffectiveRotation` override/follows incl. the scene timing, `PlayLimits`,
  the defaults (0, on, 0, on, 1800) + a file without the scene keys, the removed properties gone + an old-model JSON
  loads, the max / scenes-after clamps, the `ItemPlayRule` table (video / image / scene × toggle × 0-values),
  `PlayKindOf`, `NeverMs` never reached, `SceneMinReached`, `MinPlayReached`, `MaxPlayReached`, `PlayedAfterLoad`); IT §
  "0 = off for both limits" (p1 4 s then e1 12 s each to its end, align:end, no cut) + "separate timing for scenes ON"
  (an image shows its 3 s at minimum 0; 0 = off + a 2 s max → it stays) + the scene section's "separate timing for
  scenes" (3 s beats a 6 s minimum; a 3 s max still cuts e1 while s1 plays its own 5 s; 0 = off + max 2 → stays;
  1-item; toggle off → the minimum again; OFF → ON live + a volume edit keep the play time; a playlist's own 0 → 4 s via
  `/playlist/state` beats the globals' 2 s) + the restart section's scene-after-6 s across a backend restart (RED on the
  base backend: 8 fails — every scene / image check; settings-merge RED 5; matrix RED on the base UI: both cells); IT § "advance-on-end play-time limits" (min = the interval:
  a 2 s clip loops to its 3rd loop end, set live while armed, a playlist's own, an image, pure timed ignores max + an
  old wait key, max mid-video / live / × pause / × speed / 1-item / override) + the scene (min 3 s moves it, none
  doesn't) and backend-restart (max and min across it) checks; `test-settings-merge.sh` (an old-model file loads, the
  removed keys gone from GET and the next save, partial / clamped max bodies, a live max; the scene keys' defaults on a
  file without them, partial / clamped bodies, a live "Switch scenes after" on a held image); matrix `playlist:minPlay|
  maxPlay`, `global:minPlay|maxPlay` (pendingGlobal), `global:maxPlay:own`, `plAdvanceRelabel`, `gAdvanceRelabel`,
  `gAdvanceOn` (the 600 s interval becomes a minimum that holds, then 0 arms), `playlist:sceneTiming` (sceneS: the
  toggle hidden under the timer, shown with advance on, 4 s → s1 moves on now with its fade) and `global:sceneTiming`
  (the opt-in `sceneSGlobal`: the scene playlist following globals with no limits — the scene holds; the toggle row
  shown, the seconds row only once it's on; 4 s → s1 moves on).

## Scenes (Phase 2 Task 11; plan `docs/superpowers/plans/2026-10-27-liascape-player-phase2-scene-worker.md`)
A WE scene item's play path is its **folder** (`IsScenePath`, library.md); liascape-player plays it as a `kind:
"scene"` source (player-core.md § Scene worker — one `liascape-scene-worker` per scene, shared by every output).
Everything kind-agnostic stays so: the resolver (§ Targeting) gives a scene the same per-source values as a
video — `gain.user`/`gain.mute`/`no_audio`/`speed` drive its worker's stream and clock live (`speed` scales a
scene's animation AND its pitch-kept sound, owner decision), the video-only props (`hwdec`, `fps_cap`,
`cache`, `demuxer_*`, `loop`) are stored, no effect, and `af` is always "" (no loudnorm on a scene — a scene
normalizes through `gain.normalize`, "Loudness" below). Pause,
transitions (every method, every switch combo), the snapshot/restore and R81 need nothing scene-specific.
- **Can a scene play?** `ScenesPlayable(s)` = `AllowScenes` && `LiascapePlayerClient.ScenesAvailable`: the running
  player's `scene` capability (its worker AND WE's assets dir resolve — or synthetic scenes are allowed) from
  the current request connection's `hello` (a dropped connection forgets it: the next ask greets whatever
  answers — twice, the first request after a quit fails on the dead connection; a stalled player → its last
  word); no player on the socket → `liascape-player scene-check` in the backend's environment (`{worker, features,
  assets_dir, ok, reason}`), cached 30 s. Hot path: `IsSkippedPath` per next/prev/random (once per pass in a
  library scan). `GET /player-engine` → `scenes {available, reason, assets_dir}` (`SceneStatus`: scene support
  off → that; the player without the capability → `scene-check`'s reason, else a hint at `ctl get
  player.scene_assets_resolved`; `assets_dir` from the running player's `player.scene_assets_resolved`).
- **Create props** (`SourceProps`): `kind: "scene"`, `preview` = the item's preview image
  (`LibraryService.PreviewImageOf`: `preview.jpg|png|jpeg`, else `preview.gif|webp`) — what the player shows
  while no worker frame exists (Task 10), and `scene_props` (below).
- **Scene user properties (the card settings modal's editor; library.md § "Scene properties").** `scene_props` is one more
  per-source value of the resolver (`Desired`, scene paths only): `SceneProperties.PlayerMap(path, its index
  overrides, a drag's transient values)` — so a new source opens with them (`SourceProps`; the worker applies them
  after the load, before the first frame) and every Fresh pass (`/settings`, R81's reapply after a player restart)
  re-asserts them. Diffed as JSON (`JsonSame`: numbers within 1e-6, objects by key set — `ValuesOf` keeps a Map prop
  as a cloned `JsonElement`). **A reset sends the default** (`WithResets`): the player keeps a removed key's value
  until the next open (LWE has no reset), so a key the source still runs that the overrides dropped goes out as its
  project.json default. Callers: `/library/scene-props` (saved first) → `PlayerHelper.ApplyScenePropsLive(path)` →
  `ApplySceneProps` — queue key `sceneprops:<path>`, that item's sources only, `scene_props` only, cached;
  `/library/scene-props/preview` (the drag twin) → `PreviewSceneProps(path, {name: value})` — key
  `preview:scene_props:<path>:<names>`, the value as the item's transient, nothing saved. The worker's answer
  (`PropertySet`) is the player's `scene.property` event / `workers.properties` (not subscribed — a refused name only
  logs there). Legacy: launch-only (`--set-property`). Live on the same worker, every switch combo, across a
  switch-away-and-back and a player restart (IT + matrix `sceneProp:*`).
- **Per-monitor scene fps — live** (`LiascapePlayerMedia.ApplySceneFps(prev, cur)`): `SceneMonitors[].Fps` →
  `set out:<name>.scene_fps` (name mapped like the player's `output_name`: `.`/`:`/`*`/whitespace → `-`;
  0–480, 0 = the output's refresh), queued coalescible per output (`scene_fps:<name>`); `/settings` diffs prev
  → cur (a removed entry → back to the default 30, D5). Every entry is re-asserted once per player process
  (`Switch` when `Generation` moved, and R81's `ReapplyAllNow`). An entry naming no output is a logged
  `no_such_node`. `IsPrimary` has no liascape-player meaning (one worker, its sound one stream on the bus), and the
  V→S lead / `SceneTransitionDelayMs` stay legacy-only (the player switches once B's first frame is in) —
  Settings hides both under liascape-player and labels the fps "fps (live)". Under liascape-player `SceneMonitors` is no
  longer the launch-only exception.
- **Broken scenes (D6 + the owner's call).** The player logs `source.broken {id, path, scene_id, reason,
  signal|code, restarts, record}` once when a scene's worker crashed past its budget (3 restarts in 60 s;
  player-core.md § Scene worker → Errors). `LiascapePlayerMedia.OnEvent` → `PlayerHelper.OnSceneBroken(path)` off
  the event thread: `LibraryService.MarkCrashed` (the index's `crashed: true` — the card settings modal's "Scene
  crashed — won't be played" + whitelist box, which nothing set before), WS `scene-crashed {path}`
  (`OnSceneCrashed`), and if it's the **playing item of a timed playlist** (`PlayingHistoryIndex`, no wait in
  flight) the rotation **advances at once**: a timer rotation (advance-on-end off) → `_timedRemainingMs = 0` + the
  tick fired now (its owner/pause/mode rules apply), an advance-on-end one (no countdown) → `AdvanceAndLaunch`. A single wallpaper keeps what the player shows (its last frame /
  the preview, silent). A scene that breaks as a pending B is that switch's `transition.failed`; the
  DoVideoEndWait fallback then skips it (row above). From then on `IsSkippedPath` skips it — unless
  whitelisted (`/library/whitelist`) — and `Apply` refuses it. A missing / half-downloaded folder is a load
  error (`transition.failed`), never marked.
- **GPU / VRAM settings (Phase 2 Task 8, wired 2026-10-28; player side: player-core.md § Scene worker → "GPU budget
  and VRAM").** Three `AppSettings` → three player props, all live: `AutoThrottleScenes` (bool, default true) →
  `player.scene_throttle`; `LimitVramPerScene` (default false) + `SceneVramLimitMib` (default 1536, clamped
  64–1048576, kept while the toggle is off) → `player.scene_vram_limit_mib` = the MiB while enabled, else **0 = off**;
  `VramLowMode` `stop` (default) | `pause` | `off` (an unknown value reads as `stop`) → `player.vram_low_mode`.
  `LiascapePlayerMedia.GpuProps(s)` is the mapping (self-test table), `ApplyGpuSettings(prev, cur)` the `/settings` diff
  (coalescible per prop, `player:<prop>`), and `AssertSceneFps` — once per player process (`Switch` when
  `Generation` moved, R81's `ReapplyAllNow`) — asserts them with the scene fps, so a fresh or restarted player (its own
  defaults) gets them back. **`scene.vram_exceeded {id, path, pid, used_mib, limit_mib}`** (subscribed, `Topics`) →
  `PlayerHelper.OnSceneVramStopped(path, used, limit)` off the event thread: WS `scene-vram-stopped {path, usedMib,
  limitMib, message: "stopped: used X MiB > limit Y MiB of VRAM"}` (the UI's status bar) and the same advance as a broken
  scene (`AdvanceIfPlaying`: the playing item of a running timed playlist → advance now; a single wallpaper keeps the
  player's last frame) — but **never `MarkCrashed`**: it stays playable (next / a later rotation pass plays it again,
  and is stopped again 2 s later while it still uses too much). The low-VRAM hold is the player's own pause composition
  (`player.paused` stays false — nothing here mirrors it into the UI's pause state, nothing re-asserts anything when it
  ends); `GET /player-engine` → `vram {low_active, mode}` (`player.vram_low_active`, null = no player) for a status
  line. Settings → "GPU / VRAM" (liascape-player only). Known edge: a scene **pending B** (armed for A's end) stopped by the
  guard is that switch's `transition.failed`; the `DoVideoEndWait` fallback then switches to it now (it isn't
  skipped), it plays ~2 s and is stopped again → the rotation advances (bounded by the guard's hold, never a loop).
- **Loudness (learned on first play, refined on every play; owner decisions, plan "Loudness: learn on first play" +
  2026-10-28 "keep measuring … a max cap").** The player measures (player-core.md § Scene worker → "Scene loudness":
  BS.1770, AUDIBLE play, pre-gain — the first report after ~60 s, then each further 60 s, at the end of a play, and
  once at its 30 min cap) and logs **`scene.loudness {id, path, lufs, peak_dbfs, seconds, session_s, seed_s,
  played_s, complete, capped, window_s, cap_s, state}`** (subscribed, `Topics`; each report cumulative over every
  play) → `LiascapePlayerMedia.OnSceneLoudness` off the event thread → `LibraryService.StoreSceneLoudness` →
  `MergeSceneLoudness` (pure): the index's `loudnessState` (the player's `state`: its block-loudness histogram +
  peak, opaque here), `loudnessSeconds`, `loudnessPartial` and the APPLIED `loudnessI` (LUFS) / `loudnessTP` (the
  SAMPLE peak, dBFS) (library.md). **The measurement** is replaced by any report covering MORE audible seconds (a
  lost report is made up by the next; two sources of one scene at once — the longer stays; a duplicate is ignored);
  **the applied value moves only by ≥ `ApplyHysteresisLu` (0.5 LU / dB)** — `loudnessI`/`loudnessTP` stay put
  through a refinement smaller than that, so `gain.normalize` never twitches by tenths (drift accumulates: it's
  compared with the APPLIED value). A scene outside the library or trashed meanwhile stores nothing. **Each new
  source continues it:** `SourceProps` (create only) carries `loudness_seed` = the stored `loudnessState`
  (`SceneLoudnessSeed`) — never a resolver value (a live source already holds that measurement plus its own play
  since; re-seeding it would drop the latter). **Entries learned before 2026-10-28** (no `loudnessState`, decided —
  no migration): applied as they are and never a seed; the next play measures from nothing and its first COMPLETE
  report re-learns the entry (a partial doesn't replace it; the 0.5 LU rule applies against the old value).
  Applied changed → `PlayerHelper.OnLoudnessMeasured` → with normalization on `ApplyEffective` (one Fresh resolver
  pass); stored but not applied → nothing sent (adapter log `stored (< 0.5 LU: not applied)`). **Applied as
  the scene source's `gain.normalize`** (`LiascapePlayerMedia.SceneNormalizeDb(meta, s)`, a per-source value of the
  resolver for scene paths only): `NormalizeTargetLufs − loudnessI`, never boosting the sample peak past
  `NormalizePeakCeilingDb` −1.5 dBFS (a plain gain has no limiter — the video loudnorm's TP −1.5), clamped −60…+24
  dB, rounded to 0.001; **0** while normalization is off or nothing is learned. NoAudio doesn't zero it (silent
  anyway; un-muting comes back at the right level). At **create** (`SourceProps`) the value is set directly — a
  reopened scene plays normalized from its first frame; **live** it goes as `animate` over `NormalizeRampMs` (500
  ms; a setting slot, so it lands while paused too) — the moment it's learned, a target change, normalization on/off:
  a ramp on the same source and worker, never a step. It stacks with `gain.user` (the per-item / global volume) and
  `gain.mute` like the video `af` + `volume-gain`. A silent scene (no sound, or digital silence) never reports
  → never stored, never normalized. **Legacy engine:** unchanged — LWE scenes aren't normalized (the stored value
  is unused there; `OnLoudnessMeasured` returns for a scene path), and nothing learns under legacy.
- **Tests:** self-test `SceneAdapterAssertions` (the `ScenesPlayable` truth table — AllowScenes × engine ×
  capability × LWE —, D6's `SkipScene` table, a scene folder's `SourceProps` — kind, preview, `af` "",
  Volume —, gain.normalize 0 unlearned / absent on a video, `SceneLoudnessAssertions`: the `MergeSceneLoudness`
  rules — the longer report replaces the measurement (state, seconds, partial), a shorter or duplicate one is ignored, the applied I/TP move only by ≥ 0.5, drift accumulates, a state-less (pre-2026-10-28) entry is applied, never a seed, re-learned by a complete report — and the `SceneNormalizeDb` table — peak cap, clamps, off,
  unlearned, NoAudio —, the ownership filter on a `liascape-player-scene.src4` block, the `GpuProps` table) + the round trip (its
  private player runs `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1`: `Capabilities`/`ScenesAvailable` from `hello`, a clip →
  synthetic scene fade lands `kind: scene`, ready, its preview; `ApplySceneFps` 45 then back to 30;
  `ApplyGpuSettings` there and back; scene → clip cut); the IT's § "Phase 2: scenes" (Integration test, below); the UI matrix's scene cells (`scripts/test-ui-matrix.sh`, web-ui.md).

## Targeting (R61): ONE effective-settings resolver
Every setting reaches the live sources through **`LiascapePlayerMedia.ResolveNow`** (design note at the top of
its code): the live sources (the cached source map: source id → item path — every live media source: on
screen, either side of an effect, a pending B, a parked one) × (the global settings, each item's overrides
+ loudness, the mute, a request's transient values) → each source's desired values, **diffed against what
it runs**, and only the differing ones sent — `set <id>.<prop>`, one per source, never a broadcast. A new
source's create props (`SourceProps`) are the same per-source computation (`Desired`). Before, each path
picked its targets and values itself and they disagreed: normalization reached `cur:*` only; `/settings`
`set srcs:*` the playing item's volume + speed and fixed the others up after (`FixupPerItem`) — for one
round trip on EVERY save (a theme change too) an effect's other side / a pending B ran the playing item's
values (matrix `appear:*`); the volume key pushed the new global over a playing override; a literal
computed for the playing item at request time landed on whatever played when it ran.
- **Per source**: `gain.user` = VolumeDb(transient item ?? its override ?? transient global ?? `Volume`),
  `speed` = clamp(the same chain over `Speed`, 0.1, 4), `af` = its OWN item's loudnorm at the target (""
  off / NoAudio / unmeasured — that kicks a measure), a scene's `gain.normalize` = `SceneNormalizeDb` (its
  learned loudness; § Scenes → "Loudness"; sent as `animate` over 500 ms), `no_audio`/`hwdec`/`fps_cap`/`cache`/
  `demuxer_max_mib`/`demuxer_back_mib` = the global settings, `gain.mute` = −96 when `PlayerHelper.IsMuted`
  (user + auto) else 0; and the layer: `lay:*:main.fit` = VideoScale (Fresh passes, one `set` when any
  main layer differs). Every input is read when the pass RUNS (a coalesced pass applies the newest state).
  Not resolved: `loop` (`SetLoop`, the legacy guard) and `player.paused` (§ Pause).
- **Diff**: numbers within 1e-4, strings/bools exact. A **Fresh** pass reads `state` (and refreshes the
  cache); a cached pass diffs against the **value cache** (that read's values + every value a pass `set`
  since — only on success; dropped with the map). `gain.mute` goes as `animate` over 30 ms; mid-ramp it can
  read as its old value, so a mute CHANGE always sends (`Force`). A source gone (`no_such_node`) → the map
  is re-read once; no answer / a stalled player → the pass gives up (R81 re-applies when it answers).
- **Callers** (queue key → scope / props / transient / diff):

  | caller | key | sources | props | transient | diff |
  |---|---|---|---|---|---|
  | `/settings` (`ApplyEffectiveLive`), volume key on the global, normalization, a loudness landing → `ApplyEffective` | `resolve` | all | all + fit | — | Fresh |
  | R81 → `ReapplyAll` | `reapply` | all | all + fit | — | Fresh |
  | `/library/volume\|speed`, volume key on an item → `ApplyOverride(path)` | `override:<path>` | that item's | gain.user, speed | — | cached |
  | `/preview {paths}` → `Preview` | `preview:<prop>:<paths>` | those items' (none → the playing item's) | the dragged one | the value, for those items | cached |
  | `/preview {global}` → `PreviewGlobal` | `preview-global:<prop>` | all | the dragged one | the value, as the global | cached |
  | `/library/scene-props` → `ApplySceneProps(path)` | `sceneprops:<path>` | that item's | scene_props | — | cached |
  | `/library/scene-props/preview` → `PreviewSceneProps` | `preview:scene_props:<path>:<names>` | that item's | scene_props | the dragged values | cached |
  | an mpv volume/speed literal (`/volume {value}`) → `Mpv` | `set:<prop>` | all | that one | the value, for the playing item | cached |
  | a mute change (SetMute / SetUserMute → mpv `mute`) → `Mpv` | `set:gain.mute` | all | gain.mute | — | Force |

  So a drag value is ONE `set` per source (no `state` while the map is cached, nothing persisted) and a
  no-op `/settings` save sends nothing but its one `state` read.
- **The live-source cache** (`LiascapePlayerMedia.CachedLive`/`ReadLive`, speed storm: every
  `/preview` cost a full `state` + the `set`s — 2 round trips per value with paths, 3 without — and
  saturated the one worker at ~50/s). One `state` read builds `full path → [ids]` for every live media
  source (no snapshot/colour), each source's values and the main layers' `fit`; it's reused until the graph's SOURCES change. Ids are never reused within
  a player process and a source's path never changes, so only these change it, and each **invalidates**
  it (`InvalidateSources`): our own `Switch` (finally), `Stop`, `StopAndQuit`, a `cancel`, the in-place
  upgrade — synchronously, on the queue's worker where every reader runs; the player's own changes and
  other clients' through the subscribed events (`LiascapePlayerClient.Topics` = `transition.` — scheduled
  creates a B, handoff drops A, cancelled/failed drop B, output_adopted/done — + `player.stopped` +
  `source.retire`, a handful per switch; `source.position` is still never subscribed); a new compositor
  (`Generation`, `OnRestarted`). It is **only trusted while the event connection is live**
  (`EventsLive`; every (re)subscription invalidates — a reconnect gap loses events), a map read while an
  invalidation happened is never stored (epoch), and a pass that hits `no_such_node` (an id retired
  meanwhile) invalidates and re-reads once. Self-test evidence:
  `SourceMapReads`, `SourceEpoch`, `LiascapePlayerClient.RequestCount`.
- **Layer settings** (`fit` ← VideoScale) → `lay:*:main` (the resolver's Fresh passes; also re-asserted
  on every switch, so a hotplugged output matches).
- **Mute** (`gain.mute`, user + auto combined like legacy `_isMuted`) → the resolver: `animate
  <id>.gain.mute` over 30 ms per source, never a step (a setting slot: it ramps on the player's unpaused
  clock, so it lands while paused too — player-core.md § Runtime).
- **Pause — the contract (final review I1/I3).** The PLAYER owns pause: `player.paused`, persisted
  in its snapshot and restored with it across a crash restart. The backend keeps **no copy**:
  `TogglePause` reads `get player.paused` and sets the opposite (so a keybind's one-shot
  `liascape toggle-pause` CLI process and the serve backend always agree), and R81's reapply
  reads it (logged) but never re-asserts it. A pause belongs to its **session**: `stop` clears it
  on the player side, and a new session — `Apply`, `ApplyPlaylist`, a cold `Launch` — queues `set
  player.paused false` (`LiascapePlayerMedia.QueueNewSession`) ahead of its switch, as legacy starts a
  fresh, playing mpvpaper; a rotation keeps it. **A user switch while paused** (next / previous /
  random — keybind, CLI, `/next` `/prev` `/random`; owner's call 2026-10-25): `StayPausedWhenSwitching` off
  (default) → `BeforeUserSwitch` resumes first (`QueueNewSession` + the timed countdown via
  `SetTimerPaused`), so it switches with its transition and plays — a paused playlist's tick used to
  hold the action until the resume, a single one already unpaused (`Apply`); on → the pause stays, the
  switch is a **cut** (`_keepPauseNextSwitch`, consumed by `SwitchToFile`; `Apply` then skips
  `QueueNewSession`) to B's first frame, paused, and the paused tick runs a pending
  next/prev/random at once (its countdown stays paused). Decided where the switch runs (the tick
  owner, `DispatchPendingAction`), since the action may come from another process. Legacy: the same
  (resume = `set_property pause false`; keep = no overlay, the IPC `loadfile` keeps mpv's pause).
  mpv's `pause` property maps to `player.paused` too (M7).
- **Pause (R75, final)**: ONE `set player.paused` — the Player node's `paused` (player-core.md §
  Graph & properties "Player node paused", Task 16b) freezes every source's EFFECTIVE pause
  (`node.paused || player.paused`, never the node's own raw value — a recipe-held side, e.g. reveal's
  held A, stays exactly as the recipe left it) AND the recipe's own clock (`Runtime::now()` excises
  paused time), so a pending B and an in-flight effect freeze too, not just `cur:*`. Direction comes
  from `get player.paused` (not `cur:*.paused` any more — the node's raw value is never touched by the
  override, so it wouldn't reflect the current pause state). The interim R75a ruling (write every
  `srcs:*.paused` directly) is gone.
- New sources (`SourceProps`) carry every setting at creation: path, kind (a folder → scene + its `preview`,
  § Scenes; image by extension, else video), loop + the resolver's own per-source values (`Desired`: speed, `gain.user`, `gain.mute`,
  no_audio, hwdec, fps_cap, cache, demuxer_*, af) — never a second copy of that computation.

## Property map (`MpvPropertyMap.Translate(object[] mpvArgs) → (prop, value)?`)
`["set_property", name, v]` / `["set", name, "v"]`:
volume N → `gain.user` = **60·log10(N/100) dB** (the cubic curve users know: 50 → −18.06), N ≤ 0 → −96 ·
speed → `speed` · mute → `gain.mute` −96 / 0 · pause → **`player.paused`** (M7: the player-level
pause; `Set` sends it as `set player.paused`, never `srcs:*.paused`) · loop-file inf/yes/no → `loop` ·
panscan ≥ 0.5 → layer `fit:"fill"`, else `"fit"` · vf `fps=N` / "" → `fps_cap` N / 0 · hwdec → `hwdec` ·
cache no → `cache:false`, else true · demuxer-max-bytes / -back-bytes ("20MiB", KiB/GiB/bytes) →
`demuxer_max_mib` / `demuxer_back_mib` · af → `af` · aid no → `no_audio:true`, else false.
Anything else → `null` + a log line.

## Reconnection (R81): re-applying effective settings
A fresh graph (a new compositor pid, supervised or not; a snapshot that wasn't restored — from the
4th restart in a 60 s window, player-core.md § Supervisor "Budget" — or was stale, saved before the
crash caught up) must not show stale values just because the backend's MODEL of what should be
playing didn't change. Two triggers, both `LiascapePlayerMedia.ReapplyAll()` (fire-and-forget `Queue(...)` —
never `Drain().Wait()` inside the handler, which runs on the client's own callback):
- **`LiascapePlayerClient.Restarted`** (`OnRestarted`) — the compositor pid changed.
- **`LiascapePlayerClient.Recovered`** (`OnRecovered`) — the stall breaker just closed (a mutation made while
  it was open was dropped, never replayed on its own otherwise — the "New concern" from the first
  review round).

`ReapplyAllNow` runs, through the SAME queue as every other mutation (ordered, never races a
concurrent switch/set), the resolver's full Fresh pass (§ Targeting): every live source — a pending B
included — its own effective `gain.user`/`speed`/`af`/`no_audio`/`hwdec`/`fps_cap`/`cache`/
`demuxer_max_mib`/`demuxer_back_mib`/`gain.mute`, and the layer `fit`, diffed against a fresh `state`
(after a restart: what the snapshot restored; after a stall: what the dropped mutations left) — and **not** `player.paused` (I3: the player is its
authority and restores it from its snapshot; re-asserting a backend copy flipped the pause after a
crash/stall when the toggle came from a keybind's CLI process or a restarted backend). The reapply
logs the player's value (`… (player.paused = true, kept)`). `LiascapePlayerMedia.ReapplyCount` counts how many times it's
actually run (self-test/IT evidence).

**The wallpaper too (`ReconcileShown`, 2026-10-28).** A restarted player shows what its snapshot holds, and every
write is fsync'ed — 2.4 s behind a switch once under I/O load: the crash restored the wallpaper BEFORE it and the
screen kept it while the backend and every UI said the new one (a switch's reply can't wait for an fsync, so the
player can't close that window itself). `OnRestarted` queues `ReconcileShown` (essential, **before** it fails the
pending waits — so a re-armed aligned switch is requested after it): if the screen (every layer's content, an
effect's `to`, a requested non-waiting switch's B, the parked wallpaper) lacks `_intent`'s path → a **cut** to it
(`Reconciles` counts them); after our own `stop` and something shows → `stop`. `_intent` = what this backend last
put on screen: an align:now switch's B from its request's reply, an aligned switch's B from its
`transition.started`/`.handoff` (until then A shows and the switch is only armed — `_alignedCorrs`), nothing after
`Stop()`. **Unknown (no reconcile)** before our first switch, after `StopAndQuit`, when our switch failed or was
cancelled, and when a `transition.scheduled` names a path we didn't request (another client switched — a second
backend, `ctl`; `_requesting` covers our own event beating its reply). **An armed aligned switch** dies with the
process: the player's snapshot saves it as A where it plays (player-core.md § Snapshot), and `DoVideoEndWait` on
`failed:player restarted` **re-arms** it for A's end (it used to back off 1 s and switch NOW — A cut short; with the
old snapshot rule B showed at once, then again).

## Event flow
`Switch` → `transition` reply `{corr, to}` → `LastCorr`. The event thread records each corr's terminal
outcome — `transition.handoff` → "handoff", `.cancelled {reason}` → "cancelled:<reason>", `.failed
{reason}` → "failed:<reason>" — in a recent-outcomes map and completes its waiter. `WaitCorr(corr, ct,
timeout)` checks the map first (the event can beat the reply — different connections), and every 2 s
asks `logs {corr, kind_prefix:"transition."}` as a safety net (a reconnect gap can't hang a wait); a new
player pid (`Generation`) ends it as "failed:player restarted". `SwitchAndWait` waits for the event
subscription ack before requesting, and returns "handoff" | "cancelled:…" | "failed:…" | "unreachable"
| "caller-cancelled" (→ `cancel {corr}`; `unsupported` = it had already handed off).
**Our latest switch failing** (`transition.failed` for `LastCorr` — a file mpv can't play, B never
ready) leaves A on screen, but every client was told B when it was requested (`wallpaper-changed`):
`OnEvent` re-broadcasts `wallpaper-changed` with `CurrentPath()` (off the event thread). Matrix
`apply:broken` (a garbage `.mp4`; RED: the UI kept marking the file that never showed).

## Debugging
- Adapter log: `~/.cache/liascape/liascape-player-adapter.log` (+ stderr → the serve unit's journal),
  rate-limited (an identical line ≤ once / 10 s): every refused request with its **hint**, start
  failures, untranslated mpv commands, engine switches, in-place upgrades (`out of date (…)` → `upgraded
  in place: pid A → B`). Player stdout/stderr: `~/.cache/liascape/liascape-player-serve.log`.
  `GET /player-engine` = `{engine, active, available, binary, reason, running}` — `running.stale` names
  why the running player is out of date (null = current).
- `liascape-player ctl state` — what each output shows (`lay:<c>:main.content`, `cur:`), every source's
  `path/ready/paused/gain/gain_effective_db`, live `transitions` (phase, held).
- `liascape-player ctl logs '{"corr":"tr-12"}'` — one switch's whole story (scheduled → started → handoff →
  done, or cancelled/failed + reason); `LiascapePlayerMedia.LastCorr` / the adapter log name the corr.
  `ctl logs '{"min_level":"warn"}'` for everything that went wrong.
- `liascape-player ctl probe '{"name":"sources"}'` — what each source really runs (mpv volume-gain, pause, …).
- **Never print or log settings.json wholesale** — it holds `SteamRefreshToken`.

## Integration test (`scripts/test-liascape-player-adapter.sh`)
`scripts/test-liascape-player-adapter.sh [--no-build]` (needs `dotnet` or `DOTNET=…`, ffmpeg, jq, curl,
python3; builds liascape-player via the flake devShell + `dotnet build` unless `--no-build`; ~50 s; last line
`RESULT pass=N fail=M`, exit 0 = all pass; `LIASCAPE_IT_KEEP=1` keeps its temp dir). **Load-proof by construction
(2026-10-27):** a converging state is polled to a real deadline (`waitfor <ms> <cond>`), never read after a fixed
sleep; a window is measured from the clip's own position; "what had happened by t" is judged by the events'
own `t_mono_ms`/`t_wall` (reads after a window took seconds under load); fixed windows remain only where the
window is the check (no switch in N s) and the latency bounds (< 500 ms SIGSTOPped, < 100 ms) keep theirs —
docs/TODO.md "Load-sensitive test flakes". The REAL `liascape serve` (from this tree's
`bin/Debug`) against a private `liascape-player serve --headless --outputs 640x360@60,320x180@60 --clock real
--ao null`, all over HTTP, checked with `liascape-player ctl`. **Hermetic**: temp HOME + every XDG dir (own
settings.json with `PlayerEngine=liascape-player`, own library, own liascape-player socket + event log), its own
random backend port, display/compositor env unset; it aborts before any playback call unless
`/player-engine` says `active: liascape-player`, so it can't start or kill mpvpaper; an EXIT/INT/TERM/HUP trap
SIGCONTs + stops the player and the backend and removes the temp dir. Covers: `/apply` + fade
full-live, `/current`; every live setting (Volume −18.06, Speed, VideoScale → layer fit, VideoFpsCap
(+ VideoFpsCap 30 × an image item: it plays — the player never caps a still, player-core.md § Sources), HwDec, DisableCache, Demuxer, NoAudio, Loop); mute; pause; `/volume`; `/preview`; timed rotation
(interval 20 s + Wait + Advance, 2 s clips → align:end advances); `/next` mid-wait; `/next` during an aligned switch's running effect (1.5 s fade on a 4 s clip: → the item AFTER its B, the running one committed — handoff, not cancelled; RED before: → the same B, cancelled); `/stop`;
`/library/volume|speed` on the playing item; **final review**: a CLI `liascape toggle-pause` (a
separate process) surviving a compositor kill -9 + the backend's reapply (I3), pause → `/stop` →
`/apply` and pause → `/apply` both playing (I1), all outputs removed during an advance-on-end
rotation → no switch storm (≤ 2 requests in 8 s), the last target parked and shown on replug,
rotation resuming (I4); a pending B getting its OWN override while the global
changes; **speed storm**: an aligned switch armed at 4× survives a drop to 0.5× and an aligned switch
survives an 8 s pause (no cancel, no forced switch, no backstop log line), each then handing off at A's
end; `/preview {paths:[A]}` during a running 8 s fade moves A only and `{paths:[B]}` B only (RED before:
A's values landed on B); `/preview {global:true}` during a running 8 s fade from a library item that
follows the global to one with its own override 30 / 0.8× moves A only, persists nothing, answers < 100 ms
and a volume-only drag keeps A's speed (RED before: `global` was ignored → `cur:*` = the overridden B moved); **backend restarts** (`LIASCAPE_PLAYER_BIN` is a link into `$T/bin`, replaced by a
copy to stand in for a rebuild): a backend TERMed while a WebSocket client holds it open (like the UI) +
a new one started → no failed/superseded switch, no align:now, one advance at A's end, the new backend
owns `gui_timer.pid`, no `timer-daemon` left (RED before: 7 superseded switches); a second backend
started while the first runs → the first yields ("stops ticking"); **a crash while an aligned switch is
armed** (E1 → E2): E1 comes back at its position (not E2), the switch is re-armed `align:end`, no `align:now`,
one handoff at E1's end (RED before: E2 restored at once + an `align:now` switch after the 1 s back-off); **a crash
whose snapshot lags the last switch** (a player restarted with `LIASCAPE_PLAYER_TEST_SNAPSHOT_WRITE_MS=4000` — every
write takes 4 s, an fsync under I/O load; precondition: the snapshot still shows a after the switch to c) → c on
screen again, `/current` c (RED before: a stayed); a rebuilt binary → an idle paused
player — its old player restarted with 4 s snapshot writes, so its clean quit takes seconds — is upgraded within
~60 s (new compositor + supervisor, the new build, same wallpaper, still paused, `snapshot.restored`,
`/player-engine` current, **never signalled** (no "did not quit" line), the old supervisor's arguments +
`--restore`; RED before: SIGTERM at 1.5 s, SIGKILL at 3 s, the final snapshot lost), **the supervisor killed** → the
next switch starts the player again with its own arguments + `--restore` and shows (RED before: a plain `serve`,
no Wayland here → never came up), and an advance-on-end playlist is **not**
upgraded while its switch is armed (stale > 15 s) but at its next switch, the following switch armed
on the new player (`LIASCAPE_TEST_ALIGN_BACKSTOP_SLACK_SEC=2`; RED before the fix: both cancelled + switched, the paused one
while paused); pause during an in-flight transition (R75 final: ONE `player.paused`, checked via `ctl get
'{"path":"player.paused"}'` + `ctl probe '{"name":"sources"}'`'s `effective_paused` for A AND the
pending B — `cur:*.paused`/a source's own raw `paused` never changes, by design); a SIGSTOPped player
(`/settings` Volume, `/pause`, `/volume` each answer < 500 ms; recovery after SIGCONT) — **SIGSTOP/
SIGCONT target the COMPOSITOR pid (`ctl hello | jq .pid`), never the spawned supervisor**, which would
feel nothing and prove nothing; a `kill -9` + restart **of the compositor pid** (the supervisor stays
up throughout, `SP` unchanged — this is the supervised-restart path, not a brand-new `serve`; rotation
resumes, no switch storm) — **R81**: a distinctive Volume set just before the kill is still in effect
after the restart, and the adapter log shows a reapply; liascape-player → legacy with nothing playing (the
player quits — **cleanup kills the supervisor `SP` / uses `ctl quit`, never just the old compositor
pid**, so nothing restarts after the test — no mpvpaper started/killed); no settings dump in the logs.
**Phase 2 scenes** (every player it runs or the backend starts has `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1` +
`LIASCAPE_SCENE_WORKER_BIN` = this build's worker — the upgrade test's copied binary has none next to it; synthetic
scene items `library/workshop/90000000{1..4}`): `/player-engine.scenes.available`; `/apply` a scene →
`cur:*.kind == scene`, ready ≤ 3 s, its preview; Volume 50 → the scene's `gain.user` −18.06 and the worker's
stream gain; NoAudio on/off live on the source and the worker, same worker pid; `SceneMonitors` fps 45 →
`out:VIRTUAL-1.scene_fps` 45 + the worker's `fps_target`, same pid, `[]` → 30; `/library/volume` on scene 1
during a 6 s fade to scene 2 moves scene 1's source only; **scene loudness** (a player with
`LIASCAPE_PLAYER_LOUDNESS_WINDOW_S=3`, NormalizeAudio on, target −14; synthetic 1 kHz scenes at −20 / −26 dBFS + one
without sound): an unlearned scene at `gain.normalize` 0 → after 3 s of play the index gains `loudnessI` −20 ± 1
(complete, ≥ 3 s) and `gain.normalize` ramps (`anim.start` ≥ 300 ms) to +6 live — same source, same worker — and
reaches the worker's stream; target −23 → −3, normalization off → 0, on → 6, all live; a per-item volume stacks
on it; reopened → +6 from the first frame, its `loudness_seed` = the stored measurement, its report covers both plays (`seed_s` + `session_s`), the index refines (`loudnessSeconds` grows) while `loudnessI` stays and `gain.normalize` isn't ramped again (< 0.5 LU); a third play of the folder at −10 dBFS moves `loudnessI` ≥ 0.5 LU → `gain.normalize` ramps (≥ 300 ms) to its new value on the same source and worker; the
soundless scene → no event, nothing stored, 0; switched away after ~1.2 s → a partial (`loudnessPartial`) stored,
the next open plays at its +12, and that play's complete measurement replaces it (RED on the base backend); `/stop` → the worker gone ≤ 1 s; `/next` V→S, S→S,
S→V in a playlist — each `fade full-live` handed off — and an aligned V→S at a 2 s clip's end; a scene crashing
every 400 ms in a timed playlist → one `source.broken`, WS `scene-crashed`, index `crashed: true`, the rotation
advanced ≤ 2 s after the break (event clocks), `/next` ×3 skips it, whitelisted → `/next` plays it again; a
missing scene folder → `transition.failed`, not marked crashed; `AllowScenes=false` → 8 × `/next` never a
scene; a player restarted with `LIASCAPE_SCENE_WORKER_BIN=/nonexistent` → no `scene` capability,
`/player-engine.scenes` unavailable with a reason, 8 × `/next` never a scene. **Task 8 settings** (a player with
`LIASCAPE_PLAYER_VRAM_PROBE=fake:$T/vram.json` + short `LIASCAPE_PLAYER_VRAM_TIMING` — the probe file the test writes, never this
machine's GPU): a fresh player's defaults; `AutoThrottleScenes` / the VRAM limit toggle + MiB / `VramLowMode` each →
`get player.<prop>` live, the playing scene on the same worker, `player.paused` untouched; set, then a fresh player
(not restored) → all re-applied; a scene whose worker the fake reports at 2000 MiB > 1536 in a timed playlist →
`scene.vram_exceeded`, the rotation advanced ≤ 2 s after it (event clocks), WS `scene-vram-stopped` with the text,
not marked crashed (no `source.broken`), `/next` plays it again; a single scene over the limit → no switch in 2 s, still
shown, not marked (RED on the base backend: 12 checks failing — every prop at its default, no stop, no WS event).
**Scene properties** (scene 1's project.json gets `color` — the synthetic renderer's WE-encoded colour, red by
default —, a bool, a dependent combo/slider, text, a label and a usershortcut): `GET /library/scene-props` (order,
types, labels, defaults, condition visibility, the usershortcut not editable); set `color` → the scene's pixel
green live on the same worker, `workers.properties.color.ok`, the index `sceneProps`; a bool hides its dependants;
a slider clamps; a bad combo value / a usershortcut / an unknown name → 400; the preview twin → live, nothing saved;
switched away and back → a new source opens green; a compositor `kill -9` → the restored scene green; reset one → red
live (the default sent), dropped from the index, same worker; reset all → no `sceneProps`. RED on the base backend.
**Auto-mute vs our own audio** (near the end, before the engine switch; SKIPs without pipewire / pipewire-pulse /
wireplumber / pactl / paplay / parec): the only section with real audio — a private PipeWire + WirePlumber (`policy`,
one null sink, no D-Bus, own config/state dirs) + pipewire-pulse, sockets in the IT's `$XDG_RUNTIME_DIR`; the whole IT
exports `PULSE_SERVER` at that socket (libpulse can't fall back to another server or autospawn one); a player WITHOUT
`--ao null` (its bus on the private PipeWire), then back to the `--ao null` one. Checks § Auto-mute above.
`LIASCAPE_IT_DLL=<liascape-backend.dll>` runs another backend build against it (a RED run of new checks on an older commit).

## Self-test
`LIASCAPE_PLAYER_BIN=<repo>/src/player/target/debug/liascape-player dotnet run --project src/backend --
player-selftest` → `PASS` / `FAIL <reasons>`, exit 0/1: MpvPropertyMap assertions, R69 ownership
assertions on synthetic `pactl` blocks, **`ScenePropertyAssertions`** (a project.json with the corpus's odd cases —
BOM, untyped / `"Text"` HTML labels, `ui_*` keys, numeric combo values, `fraction: false`, a 0–255 colour, conditions
with `|| ( ) !` and a stray `=`, usershortcut / scenetexture, `order` vs `index` —: order, types, labels, defaults;
`Coerce` / `ToPlayer` / `ToCli` tables; `Visible` over JS-ish conditions; `CliArgs` / `PlayerMap`; then, when
`~/.local/share/Steam/steamapps/workshop/content/431960` exists, every real scene's properties: no throw, every
default round-trips, every condition parses — 96 files, 2066 properties, 868 conditions), **item 6's queue-depth-cap assertions** (needs no player at
all — a single artificially slow `Queue(...)` item clogs the one-worker FIFO deterministically, so a
burst of `MaxQueueDepth + 60` enqueued right behind it piles up instead of racing the drain: enqueueing
all of them must stay fast (≤ 500 ms, never blocking the caller) and `QueueDepth` must never exceed the
cap; draining afterward must bring it back to 0) **+ the coalescing assertions** (behind a clog: a
newer `QueueSet` of a key replaces the pending one and the rest keep their order — `b1 a2 E1 a4`;
nothing merges across an essential command; at the cap a pending key's newest set still lands, an
essential command is admitted and runs last, a new key is refused), then a round-trip against a **private, supervised**
`liascape-player serve --headless --outputs 640x360@60 --clock stepped --ao null` (temp
`XDG_RUNTIME_DIR`/`XDG_STATE_HOME` under `/tmp` — a unix socket path must be < 108 bytes — own
`--socket`, `LD_LIBRARY_PATH` removed, `quit` + kill at the end; the shared client is swapped to it
with `AutoSpawn=false`, so a real player is never touched). **The spawned `.NET Process` is the
SUPERVISOR** (serve forks its compositor child before anything else runs) — `hello.pid` (→
`client.PlayerPid`) is the compositor, a different pid; `hello.supervisor_pid` (→
`client.SupervisorPid`) is the spawned pid. Covers: `hello` asserts both pids against the spawned
process + each other; colour → clip with `align:now` + `fade` gets `transition.handoff` **as a
subscribed event**; mpv `volume 50` via `Mpv()` → `gain.user` −18.06; **a slider burst past the cap**
(`MaxQueueDepth + 61` volume sets behind a 600 ms clog) lands its NEWEST value and queues ≤ 3 commands
(RED before: depth 256, the last ~60 dropped, gain.user stuck at the 255th value); **20 `/preview`s
on A cost 1 request each** (`client.RequestCount`; RED before: 2 — `state` + `set`) and the last lands;
**the resolver's diff**: a full pass (`ApplyEffective`) over a source that already runs every effective value
costs exactly 1 request (its `state` read, no `set`), and a speed another client set behind our back is put
back by the next full pass;
a cut with `align:end` hands off at A's end, then a preview on B reaches B's NEW source (the map was
invalidated by the switch), and a pending B requested by ANOTHER client (raw `transition`) gets a
preview once its `transition.scheduled` event bumped `SourceEpoch`; a cancelled aligned switch → `cancel {corr}` → `transition.cancelled`, A stays; a
SIGSTOPped **compositor** (never the supervisor — it would feel nothing): the first query returns in
≤ 450 ms (QuickMs), the next in ≤ 50 ms (stall breaker), a property set returns at once (queued), and
it recovers after SIGCONT — **R81**: that recovery (`Recovered`) must have bumped
`LiascapePlayerMedia.ReapplyCount` (waited for via `Drain()` before checking, since `Queue(...)` from an
event handler is fire-and-forget by design); a SIGKILLed **compositor** yields a NEW `hello.pid`
within 1.5 s with the SAME `supervisor_pid` (the supervised restart, Task 16 § Supervisor; polled with
a FRESH client per attempt — a hello reaching the new compositor before it serves times out, and the
shared client's breaker then failed every later attempt for 3 s: under load that alone failed the
check; the shared client must then see the new pid within 4 s) — **R81**
again: `OnRestarted` must also have bumped `ReapplyCount`; **I3**: a pause set just before by a
second, independent client (another process's toggle) is still on after the restart + reapply,
and one `TogglePause` then resumes; then `LiascapePlayerMedia.StopAndQuit()` must
leave NO liascape-player process — neither the new compositor nor the supervisor (the regression this fixes:
killing only the compositor while its supervisor lived just made the supervisor restart it again). A
pump steps the stepped clock (40 ms) on its own connection. ~16 s.
