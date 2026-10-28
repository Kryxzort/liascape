---
paths:
  - "src/livepaper/Player/**"
---

# lp-player adapter (`PlayerEngine` setting, Task 17)

`src/livepaper/Player/` lets the C# backend drive the Rust `lp-player` (`.claude/rules/player-core.md`)
instead of mpvpaper + lp-transition + LWE. `AppSettings.PlayerEngine` = `"legacy"` (default) |
`"lp-player"` (experimental; Phase 1 = videos/images, **scenes are skipped exactly like
`AllowScenes=false`**). Settings → Advanced → "Player engine". The switch is live.

## Files
- **`PlayerEngine.cs`** — `IsLpPlayer` (cached; lazy from settings.json, refreshed by `/settings`
  via `PlayerHelper.SwitchEngineLive`, loaded at `--serve` start so a change compares against what
  actually runs), `WouldBeLpPlayer(s)`, `ScenesPlayable(s) = AllowScenes && IsLweAvailable() &&
  !IsLpPlayer`, `ResolveBinary()`, `Status()` (→ `GET /player-engine`).
- **`LpPlayerClient.cs`** — the Command API client (JSON Lines on the unix socket): `Call(cmd, args,
  timeoutMs=2000)` throws `LpPlayerException {Code, Message, Hint}` (the player's error object, or
  `io`/`timeout` with a hint); `TryCall` logs instead. One persistent request connection (serialized,
  reconnects after any error/timeout; a stale reply is skipped by `id`) + one subscribed event
  connection on a background thread — **only the kinds it consumes** (final review M11):
  `transition.` (a switch's terminal outcome — handoff/cancelled/failed — and, for the source
  map's invalidation, every other transition kind), `player.stopped`, `source.retire` — a handful
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
- **`LpPlayerMedia.cs`** — the media primitives PlayerHelper dispatches to (below).
- **`MpvPropertyMap.cs`** — mpv IPC property sets → lp-player properties.
- **`LpPlayerSelfTest.cs`** — `livepaper --lp-player-selftest`.
- **`scripts/test-lp-player-adapter.sh`** — the hermetic HTTP integration test (§ Integration test).

## Threading: nothing waits on the player under PlayerHelper's `_lock`
PlayerHelper calls its primitives while holding `_lock` (Stop/KillAll, Apply, the tick, the
video-end lock block…). A stalled player must never stall volume/speed/pause/tick, so:
- **Every mutation is queued** — `LpPlayerMedia.Queue(…)`: ONE ordered worker (FIFO task chain on the
  thread pool, never faults). `SwitchToFile`/`Launch` → `QueueSwitch`, `KillCurrentProcess` →
  `QueueStop`, every `SendCommand`/`TrySendCommand` property set and `cycle pause`, every resolver pass
  (`/settings`, `ApplyOverrideLive`, normalization, `/preview`, mute — § Targeting) — all return at once. `SwitchAndWait` switches through
  the same queue (ordered after a queued stop/set) and `WaitLastHandoff` first drains it (a still-queued
  switch is "the last switch").
- **Queries stay synchronous but quick**: `LpPlayerClient.QuickMs` = 300 ms (`cur:*` gets, `IsPlaying`,
  time-pos/remaining) — the only player I/O that may still happen inside `_lock`
  (`AppendToActivePlaylist`, `SwitchFromAdvanceOnEndToTimed`, the non-timed reorder paths).
- **The request connection is waited for with the call's own timeout** (`Monitor.TryEnter`), so a
  query never sits behind a queued switch that waits out its 2 s on a stalled player.
- **Stall breaker**: a request that times out opens a 3 s window in which every request fails fast
  (`timeout`, "lp-player is not responding") — a SIGSTOPped player costs one 300 ms timeout, not one per
  caller. The trip itself is logged with its cause (`no reply to `<cmd>` within N ms (waited …; gen2 GCs
  meanwhile …, thread-pool queue …, threads …)`) — the requests after it only say "not responding" and
  most callers swallow those. The speed storm tripped it 6× in ~25 min with the player answering < 3 ms
  per request and never > 50 ms in 6860 direct pings; cause not reproduced since the log line went in
  (docs/TODO.md). The first request after the window tries for real. `EnsureRunning` never spawns a second
  `serve` over a stalled (alive) one. Mutations queued while it was stalled are dropped (logged) — and
  **R81** catches up: the breaker closing fires `LpPlayerClient.Recovered` → `LpPlayerMedia.OnRecovered`
  → `ReapplyAll()` (below), so a dropped set isn't lost for good.
- **Every queued command's own `Call` uses `LpPlayerClient.QuickMs`** (item 6) — a queued property set
  (or a `transition`'s `fit` pre-assertion, or a per-item `set`) is never worth the 2000 ms default; a
  backlog behind a stalled player then drains in ≤ 300 ms per item instead of up to 2000 ms. `Switch`'s
  own `transition`/`cancel` request keeps the default (opening a new source is itself ms-scale under
  `player-core.md` § Runtime, but a switch is a heavier, rarer operation than a plain set — no reason to
  shave its margin).
- **The queue coalesces; its depth is capped** (`LpPlayerMedia.MaxQueueDepth` = 256, `QueueDepth`,
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
  and talks to lp-player only AFTER releasing it: `StopAndQuit()` (drain the queue ≤ 3 s, `stop`, `quit`,
  then escalate against the **supervisor** — SIGCONT+SIGTERM, then SIGKILL, each waiting ≤ 1.5 s for the
  process to go; see `LpPlayerClient.QuitOrKill` below) runs synchronously before the new engine starts,
  so legacy and lp-player are never both on screen.

## Binary resolution (`PlayerEngine.ResolveBinary`)
env `LP_PLAYER_BIN` → next to the running livepaper executable (`Environment.ProcessPath` dir, then
`AppContext.BaseDirectory`) → the repo dev tree `src/player/target/{release,debug}/lp-player` (walk up
from the assembly; **release first** — debug is `opt-level 0` and the player mixes audio itself, so a
player change reaches the dev session only once `cargo build --release` ran) → `PATH`. **Missing → `IsLpPlayer` is false** (legacy keeps working), one log line,
and `/player-engine` reports `available:false` + the reason → the UI row is disabled with it (switching
back to Legacy always stays possible).

## Lifecycle
- `EnsureRunning()` (only a **switch** calls it — queries/sets never spawn): connect, else
  `setsid sh -c 'exec lp-player serve …'` (no `--headless`; session env inherited — `WAYLAND_DISPLAY`
  etc.; stdio → `~/.cache/livepaper/lp-player-serve.log`, never a pipe: the player outlives the
  backend) and wait ≤ 3 s for the socket. **Arguments:** the first start runs `serve` (`--socket` when not
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
- **In-place upgrade** (`LpPlayerClient.StaleReason` / `UpgradeInPlace`, `LpPlayerMedia.StartUpgradeWatch`).
  The player outlives the backend and the app on purpose, so a rebuilt or reinstalled binary never reached
  a running one: fixes "persisted" for hours (a 13:26 build still running at 19:00). **Stale** = the
  running compositor isn't the build this backend starts — compared as FILES, never path strings (one
  checkout is `/home/…` and `/mnt/…/@home/…`): size + mtime through open handles, `/proc/<pid>/exe`
  opening the running binary even after a rebuild replaced it (`… (deleted)`); Nix by store root
  (`/nix/store/<hash>-name` — every store file has mtime 1, and `LP_PLAYER_BIN` is the `wrapProgram`
  wrapper while the process runs `.lp-player-wrapped`); a binary written < 2 s ago isn't started yet.
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
  `EnsureRunning`), and from a 10 s check in `--serve` only while **no transition is pending** — an
  armed align:end switch would be dropped by the restart and the rotation would switch early (failure
  path), so an advance-on-end playlist upgrades at its next switch. `AutoSpawn=false` (self-test) never
  upgrades. `/player-engine` → `running {pid, supervisor, exe, started, stale}`.
- Socket: `$LP_PLAYER_SOCKET` → `$XDG_RUNTIME_DIR/livepaper/lp-player.sock` (mirrors `paths.rs`).
- `Stop()` = a queued `stop` (the process stays up); switching the engine AWAY from lp-player =
  `StopAndQuit` (stop → quit → TERM → KILL, synchronous, outside `_lock`).
- **`LpPlayerClient.QuitOrKill` targets the SUPERVISOR, never the compositor alone.** Order: `quit`
  over the socket (the compositor exits 0 → the supervisor classifies that as a clean exit and exits
  too — no restart) → else SIGCONT+SIGTERM the **supervisor pid** (`SupervisorPid ?? PlayerPid` —
  unsupervised falls back to the compositor, same as before Task 16) → else SIGKILL the supervisor
  (its child dies via `PR_SET_PDEATHSIG`; if the compositor pid is somehow still alive a moment later,
  SIGKILL it directly too). **Never SIGTERM/SIGKILL the compositor pid while its supervisor is still
  alive** — the supervisor treats a dead/signalled child as a crash and restarts it with `--restore`,
  which is exactly what an engine switch away from lp-player must not leave running.
- `SwitchEngineLive(prev, cur)`: `IsPlaying` (outside `_lock`); under `_lock` — `SaveTimedState`,
  `TeardownTimer` (state only), and for a LEGACY old engine `KillCurrentProcess` (process kills only);
  after `_lock` — for an lp-player old engine `StopAndQuit`; then `Refresh`, then replay on the new
  engine: a running timed playlist via `RestoreTimedPlaylist` (resumes at the item it was on), else
  `LastSession` (timed / playlist / single). Nothing playing → nothing started.

## Dispatch points (`PlayerHelper`, each `if (PlayerEngine.IsLpPlayer) { … }` at the top; legacy
code below it is unchanged)

| method | under lp-player |
|---|---|
| `SwitchToFile` | `LpPlayerMedia.QueueSwitch(path, settings, cfg.Enabled ? cfg : null, alignEnd:false)` → `Switch` = `transition {outputs:"out:*", to:{path, props}, effect_id/params/duration_ms/method from TransitionService.Pick or effect_id:null (cut), align:"now"}`; scene path → `KillCurrentProcess` (AllowScenes=false parity) |
| `Launch` | a queued cut (`tcfg:null`) — whatever was on screen was just stopped |
| `DoVideoEndWait` (both V→V branches: transitions on AND the transitions-off gapless append) | `WaitLastHandoff` (the previous switch's `transition.handoff` — a new request would SUPERSEDE a pre-Running one), then `SwitchAndWait(next, …, tcfg: on ? cfg : null, alignEnd:true, ct)`; then the existing `lock { …; PostSwitch(next) }`. Not handed off (failed / unreachable / cancelled by someone else / timed out) → **a growing back-off** (I4: 1 s, 2 s, 4 s … ≤ 30 s while consecutive switches keep failing, `LpPlayerMedia.NextFailureBackoff`; a handoff resets it), then `SwitchToFile(next)` now — a player refusing for any reason can never spin the playlist. The aligned wait itself is **bounded** (M2: A's remaining time + `AlignBackstopSlackSec` 15 s, behind the player's own 10 s `align_fallback`; on timeout the corr is cancelled) — **re-derived each time it runs out** (`AlignedWaitCheck`, speed storm): while the player has **no output** (`state.outputs` empty — monitors off: it holds the aligned switch until an output shows it, player-core.md § Runtime, I4) or is **paused** (its clock and the switch stand still) it keeps waiting; otherwise it waits A's remaining time at its *current* speed + slack again as long as A's `time_pos` moved since the last check (first baseline: A's position when armed), and only gives up when A stopped moving (a stall). Before, the bound read at arming was final: a slow-down after arming (4× → 0.5×) or a pause longer than remaining + 15 s cancelled the switch and cut A long before its end — switching *while paused*. `LP_TEST_ALIGN_BACKSTOP_SLACK_SEC` shortens the slack for the IT only. `ct` cancel → `cancel {corr}`. **B becomes the session's current item when its effect STARTS** (`transition.started` → `SwitchAndWait`'s `onStarted` → `Commit` under `_lock`: `_waitingForVideoEnd` off, `wallpaper-changed`, `PostSwitch` — the next pre-fetch + its waiter, which first waits for this one's handoff), not at its handoff: from Running the player shows B (`cur:*` = B) and a new request commits it (→ `handoff {committed}`), a cancel would snap back to A. Counted at the handoff, a next in that window (the effect's duration) cancelled the running switch and switched now to the same pre-fetched B — the user's next did nothing (IT "/next mid-wait" flaked ~1 in 6 /next, `cur a.mp4 → a.mp4`); a prev went to the item before A. Legacy commits at its overlay's start the same way. Whichever comes first commits (a `committed` flag under `_lock` + `_waitCts.Token == ct`): the started callback, or the handoff when the event was missed; a committed switch's own wait is never cancelled again (a next cancels only the following, not-yet-requested one) and a non-handoff end after it is only logged. Guard: IT "/next during the aligned switch's EFFECT". The `_lastSwitchTarget` settle gate and the playtime polling are legacy-only |
| `RearmAlignedSwitch` (from `/playlist/state` when the playlist's transitions change, `/settings` when the global ones or `TransitionMethod` do) | the armed aligned switch was **requested at arm time** with the effect + duration of then (the player times it for A's end — legacy picks its effect when the overlay starts, near A's end), so a transition change while one is armed (advance-on-end: for the whole clip) ran the OLD effect at A's end: cancel the wait and re-arm it to the same `next` (`CancelVideoEndWait` + `ArmVideoEndWait`) → a fresh request with the new config. No-op under legacy / with nothing armed. Guard: matrix `pending × plTrOff/plTrDuration/plTrEffect` |
| `SendCommand` / `TrySendCommand` | `LpPlayerMedia.Mpv(args)`, queued: property sets → `MpvPropertyMap` → a volume/speed literal (`/volume {value}`) = a resolver pass with it as the PLAYING item's transient value (every other source keeps its own), `mute` (SetMute / SetUserMute) = a forced resolver pass of `gain.mute` from `PlayerHelper.IsMuted`, the rest → `Set` (layer props → `lay:*:main`, `pause` → `player.paused`, else `srcs:*`); `cycle pause` → `TogglePause` (so PlayerHelper's `TogglePause` needs no change of its own; § Pause); `loadfile`/`playlist-*`/`loop-file`/`loop-playlist` are mpv-playlist plumbing → acknowledged and dropped (the timed machinery owns rotation, the recipe owns A's loop) |
| `TryQueryCurrentPath` / `TryQueryTimePos` / `TryQueryProperty` / `TryQueryTimeRemaining` | `get cur:*.path` / `.time_pos` / mpv-name map / `(duration − time_pos)/speed` (ambiguous across outputs → the first output's `cur:`) |
| `KillCurrentProcess` (→ `KillAll`, `Stop`) | a queued `stop` (callers hold `_lock`) |
| `IsPlaying` | something is on screen (`cur:*.path`) |
| `/settings` (ServerHost) | `PlayerHelper.ApplyEffectiveLive(prev, cur, playing)` instead of SetVolume/SetSpeed/SetVideoScale/ApplyNormalizationLive/ApplyPlaybackSettingsLive: ONE resolver pass (`ApplyEffective`, Fresh — every live source its own value of every resolved setting + the layer fit, diffed against one `state` read: a no-op save, e.g. a theme change, sends nothing), Loop via `SetLoop` (`srcs:*`) only when it changed and the wallpaper is a single non-timed one (the legacy guard: under rotation the recipe owns A's loop), and the timed tick's speed factor (`_currentSpeed`) = the playing item's effective speed |
| `ApplyPlaybackSettingsLive` | legacy only (`/settings` → `ApplyEffectiveLive` under lp-player) |
| `AdjustVolume` (the volume keys) | on an item's own volume → `ApplyOverrideLive` (below); on the global → `ApplyEffective` (every source its own effective volume — an overridden one keeps it) |
| `ApplyOverrideLive` | `ApplyOverride(path)`: a resolver pass on that item's own source(s) (may be a pending B) — `gain.user` + `speed`, diffed against the cached values; reports the effective speed back when it's what `cur:*` shows (`_currentSpeed`) |
| `ApplyNormalizationLive` / `PlayerHelper.OnLoudnessMeasured` (from `LibraryService.EnsureLoudnessAsync`, once a measurement is stored) | `ApplyEffective` → **every** live media source gets ITS OWN item's `af` (`NormalizeAf(its path)`: loudnorm at the target, "" when off / NoAudio / unmeasured — that one kicks a measure), diffed. It used to set `cur:*`'s item only: an effect's outgoing A, a pending B (armed for A's end — it then played its whole clip with the old filter) and every source while no output shows one (no `cur:*`) kept the old `af`; and an item that started unmeasured (or was playing when normalization was switched on) played un-normalized until its next switch — now it gets its loudnorm the moment it's measured (normalization on). Legacy: `set af` when it's mpv's current file. Guard: matrix `set:normalizeOn/Off/Target/Fresh` × effect / pending / pausedEffect / noOutput |
| `/preview` (ServerHost) | `LpPlayerMedia.Preview(volume, speed, paths)` → a resolver pass on the source(s) of `paths` only (the modal's edited item(s) — on screen, either side of an effect, a pending B), the dragged value as their transient (nothing persisted), the dragged prop only, diffed against the cached values: ONE `set` per source per value, no `state` read while the map is cached; queued coalescible per selection + property; no `paths` → the playing item (`cur:*`, mid-transition the INCOMING side — why the modal always sends paths). Legacy: applied only when the current file is in `paths`. **`global: true`** (the Settings page's sliders) → `PreviewGlobal`: a pass over every source with the dragged value as the transient GLOBAL — an item with its own override for that field keeps it (override ?? global, R61) — coalescible per property (`preview-global:<prop>`) |
| scene checks (`ApplyPlaylist`, scene launch, `IsSkippedPath`) | `PlayerEngine.ScenesPlayable(s)`; the V→S lead in `Tick` gets `!IsLpPlayer` |
| `Apply(scene)` | **throws "Scenes need the Legacy player engine…" directly** — the one scene check NOT routed through `ScenesPlayable` (it keeps legacy's own AllowScenes / LWE-missing messages for legacy, and tells an lp-player user what to do instead of "enable scene support") |
| `/next` `/prev` `/random` (+ `--action=next-wallpaper\|previous-wallpaper\|random`, `--random`) | `TryStepLibrary` steps past `IsSkippedPath` items (bounded to one library pass), `ApplyRandom`/`RandomAndLaunch` drop them from the pool — so the picker never hands `Apply` a scene. An all-unplayable library throws `InvalidOperationException("No playable wallpaper…")` → the routes return **409** `{error}` (never a 500) and the CLI prints it + exits 1; the playing wallpaper is untouched. Same rule under legacy + `AllowScenes=false` (it 500'd there too). |
| `ApplyTimedPlaylist` (Play / play-from / a timed restore) | `QueueNewSession` before its first switch (I1 — it was missing: Play and play-from while paused stayed paused; Apply/Launch already had it) |
| `StepBackAndLaunch` (timed `prev`) | the item before `PlayingHistoryIndex`; none (a fresh session's first item) → nothing at all. With an advance-on-end pre-fetch it used to undo only the pre-fetch and relaunch the playing item — restarted, its armed switch cancelled |
| `AppOps.Trash` | `LpPlayerMedia.ShownOrIncomingPaths()` (one `state` read after a bounded `Drain`): every layer's content (an effect's `to`, never its leaving `from`) + each requested switch's B unless it's an aligned one in `waiting_start` — so trashing an item whose switch was requested but not yet running still stops/advances (web-backend.md § Trash) |
| restart daemon / timer (`UpdateRestartTimer`, `SpawnRestartDaemon`, `RunRestartDaemon`, `RestartCurrentAndLaunch`) | no-op — the leak-restart is an mpvpaper workaround |

`AudioMonitor.GetNonMpvStreamIdsAsync` (legacy auto-mute, still used in Phase 1): under lp-player
`LpPlayerMedia.OwnStreamFilter()` excludes the player's own streams **by ownership (R69)** —
`application.process.id` == `PlayerPid`, the **compositor's** pid (from `hello.pid` — libmpv runs
in-process inside the compositor, never the supervisor, so this is the right pid unchanged by Task 16),
`node.name` starting `lp-player-bus`,
`target.object`/`Sink:` = the `lp-player-bus` sink (index via `pactl list short sinks`), or
`application.name == "lp-player"` (an extra match, not the only one). Legacy: unchanged.

## Targeting (R61): ONE effective-settings resolver
Every setting reaches the live sources through **`LpPlayerMedia.ResolveNow`** (design note at the top of
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
  off / NoAudio / unmeasured — that kicks a measure), `no_audio`/`hwdec`/`fps_cap`/`cache`/
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
  | an mpv volume/speed literal (`/volume {value}`) → `Mpv` | `set:<prop>` | all | that one | the value, for the playing item | cached |
  | a mute change (SetMute / SetUserMute → mpv `mute`) → `Mpv` | `set:gain.mute` | all | gain.mute | — | Force |

  So a drag value is ONE `set` per source (no `state` while the map is cached, nothing persisted) and a
  no-op `/settings` save sends nothing but its one `state` read.
- **The live-source cache** (`LpPlayerMedia.CachedLive`/`ReadLive`, speed storm: every
  `/preview` cost a full `state` + the `set`s — 2 round trips per value with paths, 3 without — and
  saturated the one worker at ~50/s). One `state` read builds `full path → [ids]` for every live media
  source (no snapshot/colour), each source's values and the main layers' `fit`; it's reused until the graph's SOURCES change. Ids are never reused within
  a player process and a source's path never changes, so only these change it, and each **invalidates**
  it (`InvalidateSources`): our own `Switch` (finally), `Stop`, `StopAndQuit`, a `cancel`, the in-place
  upgrade — synchronously, on the queue's worker where every reader runs; the player's own changes and
  other clients' through the subscribed events (`LpPlayerClient.Topics` = `transition.` — scheduled
  creates a B, handoff drops A, cancelled/failed drop B, output_adopted/done — + `player.stopped` +
  `source.retire`, a handful per switch; `source.position` is still never subscribed); a new compositor
  (`Generation`, `OnRestarted`). It is **only trusted while the event connection is live**
  (`EventsLive`; every (re)subscription invalidates — a reconnect gap loses events), a map read while an
  invalidation happened is never stored (epoch), and a pass that hits `no_such_node` (an id retired
  meanwhile) invalidates and re-reads once. Self-test evidence:
  `SourceMapReads`, `SourceEpoch`, `LpPlayerClient.RequestCount`.
- **Layer settings** (`fit` ← VideoScale) → `lay:*:main` (the resolver's Fresh passes; also re-asserted
  on every switch, so a hotplugged output matches).
- **Mute** (`gain.mute`, user + auto combined like legacy `_isMuted`) → the resolver: `animate
  <id>.gain.mute` over 30 ms per source, never a step (a setting slot: it ramps on the player's unpaused
  clock, so it lands while paused too — player-core.md § Runtime).
- **Pause — the contract (final review I1/I3).** The PLAYER owns pause: `player.paused`, persisted
  in its snapshot and restored with it across a crash restart. The backend keeps **no copy**:
  `TogglePause` reads `get player.paused` and sets the opposite (so a keybind's one-shot
  `--action=toggle-pause` CLI process and the serve backend always agree), and R81's reapply
  reads it (logged) but never re-asserts it. A pause belongs to its **session**: `stop` clears it
  on the player side, and a new session — `Apply`, `ApplyPlaylist`, a cold `Launch` — queues `set
  player.paused false` (`LpPlayerMedia.QueueNewSession`) ahead of its switch, as legacy starts a
  fresh, playing mpvpaper; a rotation keeps it. **A user switch while paused** (next / previous /
  random — keybind, CLI, `/next` `/prev` `/random`; owner's call 2026-10-25): `KeepPauseOnSwitch` off
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
- New sources (`SourceProps`) carry every setting at creation: path, kind (image by extension, else
  video), loop + the resolver's own per-source values (`Desired`: speed, `gain.user`, `gain.mute`,
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
playing didn't change. Two triggers, both `LpPlayerMedia.ReapplyAll()` (fire-and-forget `Queue(...)` —
never `Drain().Wait()` inside the handler, which runs on the client's own callback):
- **`LpPlayerClient.Restarted`** (`OnRestarted`) — the compositor pid changed.
- **`LpPlayerClient.Recovered`** (`OnRecovered`) — the stall breaker just closed (a mutation made while
  it was open was dropped, never replayed on its own otherwise — the "New concern" from the first
  review round).

`ReapplyAllNow` runs, through the SAME queue as every other mutation (ordered, never races a
concurrent switch/set), the resolver's full Fresh pass (§ Targeting): every live source — a pending B
included — its own effective `gain.user`/`speed`/`af`/`no_audio`/`hwdec`/`fps_cap`/`cache`/
`demuxer_max_mib`/`demuxer_back_mib`/`gain.mute`, and the layer `fit`, diffed against a fresh `state`
(after a restart: what the snapshot restored; after a stall: what the dropped mutations left) — and **not** `player.paused` (I3: the player is its
authority and restores it from its snapshot; re-asserting a backend copy flipped the pause after a
crash/stall when the toggle came from a keybind's CLI process or a restarted backend). The reapply
logs the player's value (`… (player.paused = true, kept)`). `LpPlayerMedia.ReapplyCount` counts how many times it's
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
- Adapter log: `~/.cache/livepaper/lp-player-adapter.log` (+ stderr → the serve unit's journal),
  rate-limited (an identical line ≤ once / 10 s): every refused request with its **hint**, start
  failures, untranslated mpv commands, engine switches, in-place upgrades (`out of date (…)` → `upgraded
  in place: pid A → B`). Player stdout/stderr: `~/.cache/livepaper/lp-player-serve.log`.
  `GET /player-engine` = `{engine, active, available, binary, reason, running}` — `running.stale` names
  why the running player is out of date (null = current).
- `lp-player ctl state` — what each output shows (`lay:<c>:main.content`, `cur:`), every source's
  `path/ready/paused/gain/gain_effective_db`, live `transitions` (phase, held).
- `lp-player ctl logs '{"corr":"tr-12"}'` — one switch's whole story (scheduled → started → handoff →
  done, or cancelled/failed + reason); `LpPlayerMedia.LastCorr` / the adapter log name the corr.
  `ctl logs '{"min_level":"warn"}'` for everything that went wrong.
- `lp-player ctl probe '{"name":"sources"}'` — what each source really runs (mpv volume-gain, pause, …).
- **Never print or log settings.json wholesale** — it holds `SteamRefreshToken`.

## Integration test (`scripts/test-lp-player-adapter.sh`)
`scripts/test-lp-player-adapter.sh [--no-build]` (needs `dotnet` or `DOTNET=…`, ffmpeg, jq, curl,
python3; builds lp-player via the flake devShell + `dotnet build` unless `--no-build`; ~50 s; last line
`RESULT pass=N fail=M`, exit 0 = all pass; `LP_IT_KEEP=1` keeps its temp dir). **Load-proof by construction
(2026-10-27):** a converging state is polled to a real deadline (`waitfor <ms> <cond>`), never read after a fixed
sleep; a window is measured from the clip's own position; "what had happened by t" is judged by the events'
own `t_mono_ms`/`t_wall` (reads after a window took seconds under load); fixed windows remain only where the
window is the check (no switch in N s) and the latency bounds (< 500 ms SIGSTOPped, < 100 ms) keep theirs —
docs/TODO.md "Load-sensitive test flakes". The REAL `livepaper --serve` (from this tree's
`bin/Debug`) against a private `lp-player serve --headless --outputs 640x360@60,320x180@60 --clock real
--ao null`, all over HTTP, checked with `lp-player ctl`. **Hermetic**: temp HOME + every XDG dir (own
settings.json with `PlayerEngine=lp-player`, own library, own lp-player socket + event log), its own
random backend port, display/compositor env unset; it aborts before any playback call unless
`/player-engine` says `active: lp-player`, so it can't start or kill mpvpaper; an EXIT/INT/TERM/HUP trap
SIGCONTs + stops the player and the backend and removes the temp dir. Covers: `/apply` + fade
full-live, `/current`; every live setting (Volume −18.06, Speed, VideoScale → layer fit, VideoFps,
HwDec, DisableCache, Demuxer, NoAudio, Loop); mute; pause; `/volume`; `/preview`; timed rotation
(interval 20 s + Wait + Advance, 2 s clips → align:end advances); `/next` mid-wait; `/next` during an aligned switch's running effect (1.5 s fade on a 4 s clip: → the item AFTER its B, the running one committed — handoff, not cancelled; RED before: → the same B, cancelled); `/stop`;
`/library/volume|speed` on the playing item; **final review**: a CLI `--action=toggle-pause` (a
separate process) surviving a compositor kill -9 + the backend's reapply (I3), pause → `/stop` →
`/apply` and pause → `/apply` both playing (I1), all outputs removed during an advance-on-end
rotation → no switch storm (≤ 2 requests in 8 s), the last target parked and shown on replug,
rotation resuming (I4); a pending B getting its OWN override while the global
changes; **speed storm**: an aligned switch armed at 4× survives a drop to 0.5× and an aligned switch
survives an 8 s pause (no cancel, no forced switch, no backstop log line), each then handing off at A's
end; `/preview {paths:[A]}` during a running 8 s fade moves A only and `{paths:[B]}` B only (RED before:
A's values landed on B); `/preview {global:true}` during a running 8 s fade from a library item that
follows the global to one with its own override 30 / 0.8× moves A only, persists nothing, answers < 100 ms
and a volume-only drag keeps A's speed (RED before: `global` was ignored → `cur:*` = the overridden B moved); **backend restarts** (`LP_PLAYER_BIN` is a link into `$T/bin`, replaced by a
copy to stand in for a rebuild): a backend TERMed while a WebSocket client holds it open (like the UI) +
a new one started → no failed/superseded switch, no align:now, one advance at A's end, the new backend
owns `gui_timer.pid`, no `--timer-daemon` left (RED before: 7 superseded switches); a second backend
started while the first runs → the first yields ("stops ticking"); **a crash while an aligned switch is
armed** (E1 → E2): E1 comes back at its position (not E2), the switch is re-armed `align:end`, no `align:now`,
one handoff at E1's end (RED before: E2 restored at once + an `align:now` switch after the 1 s back-off); **a crash
whose snapshot lags the last switch** (a player restarted with `LP_PLAYER_TEST_SNAPSHOT_WRITE_MS=4000` — every
write takes 4 s, an fsync under I/O load; precondition: the snapshot still shows a after the switch to c) → c on
screen again, `/current` c (RED before: a stayed); a rebuilt binary → an idle paused
player — its old player restarted with 4 s snapshot writes, so its clean quit takes seconds — is upgraded within
~60 s (new compositor + supervisor, the new build, same wallpaper, still paused, `snapshot.restored`,
`/player-engine` current, **never signalled** (no "did not quit" line), the old supervisor's arguments +
`--restore`; RED before: SIGTERM at 1.5 s, SIGKILL at 3 s, the final snapshot lost), **the supervisor killed** → the
next switch starts the player again with its own arguments + `--restore` and shows (RED before: a plain `serve`,
no Wayland here → never came up), and an advance-on-end playlist is **not**
upgraded while its switch is armed (stale > 15 s) but at its next switch, the following switch armed
on the new player (`LP_TEST_ALIGN_BACKSTOP_SLACK_SEC=2`; RED before the fix: both cancelled + switched, the paused one
while paused); pause during an in-flight transition (R75 final: ONE `player.paused`, checked via `ctl get
'{"path":"player.paused"}'` + `ctl probe '{"name":"sources"}'`'s `effective_paused` for A AND the
pending B — `cur:*.paused`/a source's own raw `paused` never changes, by design); a SIGSTOPped player
(`/settings` Volume, `/pause`, `/volume` each answer < 500 ms; recovery after SIGCONT) — **SIGSTOP/
SIGCONT target the COMPOSITOR pid (`ctl hello | jq .pid`), never the spawned supervisor**, which would
feel nothing and prove nothing; a `kill -9` + restart **of the compositor pid** (the supervisor stays
up throughout, `SP` unchanged — this is the supervised-restart path, not a brand-new `serve`; rotation
resumes, no switch storm) — **R81**: a distinctive Volume set just before the kill is still in effect
after the restart, and the adapter log shows a reapply; lp-player → legacy with nothing playing (the
player quits — **cleanup kills the supervisor `SP` / uses `ctl quit`, never just the old compositor
pid**, so nothing restarts after the test — no mpvpaper started/killed); no settings dump in the logs.

## Self-test
`LP_PLAYER_BIN=<repo>/src/player/target/debug/lp-player dotnet run --project src/livepaper --
--lp-player-selftest` → `PASS` / `FAIL <reasons>`, exit 0/1: MpvPropertyMap assertions, R69 ownership
assertions on synthetic `pactl` blocks, **item 6's queue-depth-cap assertions** (needs no player at
all — a single artificially slow `Queue(...)` item clogs the one-worker FIFO deterministically, so a
burst of `MaxQueueDepth + 60` enqueued right behind it piles up instead of racing the drain: enqueueing
all of them must stay fast (≤ 500 ms, never blocking the caller) and `QueueDepth` must never exceed the
cap; draining afterward must bring it back to 0) **+ the coalescing assertions** (behind a clog: a
newer `QueueSet` of a key replaces the pending one and the rest keep their order — `b1 a2 E1 a4`;
nothing merges across an essential command; at the cap a pending key's newest set still lands, an
essential command is admitted and runs last, a new key is refused), then a round-trip against a **private, supervised**
`lp-player serve --headless --outputs 640x360@60 --clock stepped --ao null` (temp
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
`LpPlayerMedia.ReapplyCount` (waited for via `Drain()` before checking, since `Queue(...)` from an
event handler is fire-and-forget by design); a SIGKILLed **compositor** yields a NEW `hello.pid`
within 1.5 s with the SAME `supervisor_pid` (the supervised restart, Task 16 § Supervisor; polled with
a FRESH client per attempt — a hello reaching the new compositor before it serves times out, and the
shared client's breaker then failed every later attempt for 3 s: under load that alone failed the
check; the shared client must then see the new pid within 4 s) — **R81**
again: `OnRestarted` must also have bumped `ReapplyCount`; **I3**: a pause set just before by a
second, independent client (another process's toggle) is still on after the restart + reapply,
and one `TogglePause` then resumes; then `LpPlayerMedia.StopAndQuit()` must
leave NO lp-player process — neither the new compositor nor the supervisor (the regression this fixes:
killing only the compositor while its supervisor lived just made the supervisor restart it again). A
pump steps the stepped clock (40 ms) on its own connection. ~16 s.
