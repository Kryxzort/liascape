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
  connection on a background thread (`transition.`, `source.`, `supervisor.` — the last arrives with
  Task 16, absence is fine), reconnect with backoff 250 ms → 5 s.
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
  `QueueStop`, every `SendCommand`/`TrySendCommand` property set and `cycle pause`, `ApplySettingsLive`,
  `ApplyOverrideLive`, normalization, `/preview` — all return at once. `SwitchAndWait` switches through
  the same queue (ordered after a queued stop/set) and `WaitLastHandoff` first drains it (a still-queued
  switch is "the last switch").
- **Queries stay synchronous but quick**: `LpPlayerClient.QuickMs` = 300 ms (`cur:*` gets, `IsPlaying`,
  time-pos/remaining) — the only player I/O that may still happen inside `_lock`
  (`AppendToActivePlaylist`, `SwitchFromAdvanceOnEndToTimed`, the non-timed reorder paths).
- **The request connection is waited for with the call's own timeout** (`Monitor.TryEnter`), so a
  query never sits behind a queued switch that waits out its 2 s on a stalled player.
- **Stall breaker**: a request that times out opens a 3 s window in which every request fails fast
  (`timeout`, "lp-player is not responding") — a SIGSTOPped player costs one 300 ms timeout, not one per
  caller. The first request after the window tries for real. `EnsureRunning` never spawns a second
  `serve` over a stalled (alive) one. Mutations queued while it was stalled are dropped (logged) — and
  **R81** catches up: the breaker closing fires `LpPlayerClient.Recovered` → `LpPlayerMedia.OnRecovered`
  → `ReapplyAll()` (below), so a dropped set isn't lost for good.
- **Every queued command's own `Call` uses `LpPlayerClient.QuickMs`** (item 6) — a queued property set
  (or a `transition`'s `fit` pre-assertion, or a per-item `set`) is never worth the 2000 ms default; a
  backlog behind a stalled player then drains in ≤ 300 ms per item instead of up to 2000 ms. `Switch`'s
  own `transition`/`cancel` request keeps the default (opening a new source is itself ms-scale under
  `player-core.md` § Runtime, but a switch is a heavier, rarer operation than a plain set — no reason to
  shave its margin).
- **Queue depth is capped** (`LpPlayerMedia.MaxQueueDepth` = 256, `QueueDepth`): once at the cap, a NEW
  command is logged and dropped **without being enqueued at all** — never the oldest one evicted (that
  would need the chain to support mid-list removal; a continuation chain doesn't, so admission is
  refused instead) — so a caller is never blocked and the chain never grows past this regardless of how
  long a stall lasts.
- `SwitchEngineLive` reads `IsPlaying` before taking `_lock`, tears the session state down under it,
  and talks to lp-player only AFTER releasing it: `StopAndQuit()` (drain the queue ≤ 3 s, `stop`, `quit`,
  then escalate against the **supervisor** — SIGCONT+SIGTERM, then SIGKILL, each waiting ≤ 1.5 s for the
  process to go; see `LpPlayerClient.QuitOrKill` below) runs synchronously before the new engine starts,
  so legacy and lp-player are never both on screen.

## Binary resolution (`PlayerEngine.ResolveBinary`)
env `LP_PLAYER_BIN` → next to the running livepaper executable (`Environment.ProcessPath` dir, then
`AppContext.BaseDirectory`) → the repo dev tree `src/player/target/{release,debug}/lp-player` (walk up
from the assembly) → `PATH`. **Missing → `IsLpPlayer` is false** (legacy keeps working), one log line,
and `/player-engine` reports `available:false` + the reason → the UI row is disabled with it (switching
back to Legacy always stays possible).

## Lifecycle
- `EnsureRunning()` (only a **switch** calls it — queries/sets never spawn): connect, else
  `setsid sh -c 'exec lp-player serve …'` (no `--headless`; session env inherited — `WAYLAND_DISPLAY`
  etc.; stdio → `~/.cache/livepaper/lp-player-serve.log`, never a pipe: the player outlives the
  backend) and wait ≤ 3 s for the socket. Exit 1 ("already running" on the instance lock) keeps
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
| `DoVideoEndWait` (both V→V branches: transitions on AND the transitions-off gapless append) | `WaitLastHandoff` (the previous switch's `transition.handoff` — a new request would SUPERSEDE a pre-Running one), then `SwitchAndWait(next, …, tcfg: on ? cfg : null, alignEnd:true, ct)`; then the existing `lock { …; PostSwitch(next) }`. Not handed off (failed / unreachable / cancelled by someone else) → 1 s back-off, then `SwitchToFile(next)` now. `ct` cancel → `cancel {corr}`. The `_lastSwitchTarget` settle gate and the playtime polling are legacy-only |
| `SendCommand` / `TrySendCommand` | `LpPlayerMedia.Mpv(args)`, queued: property sets → `MpvPropertyMap` → `Set`; `cycle pause` → `TogglePause` (so PlayerHelper's `TogglePause` needs no change of its own; § Pause); `loadfile`/`playlist-*`/`loop-file`/`loop-playlist` are mpv-playlist plumbing → acknowledged and dropped (the timed machinery owns rotation, the recipe owns A's loop) |
| `TryQueryCurrentPath` / `TryQueryTimePos` / `TryQueryProperty` / `TryQueryTimeRemaining` | `get cur:*.path` / `.time_pos` / mpv-name map / `(duration − time_pos)/speed` (ambiguous across outputs → the first output's `cur:`) |
| `KillCurrentProcess` (→ `KillAll`, `Stop`) | a queued `stop` (callers hold `_lock`) |
| `IsPlaying` | something is on screen (`cur:*.path`) |
| `ApplyPlaybackSettingsLive` | `ApplySettingsLive`: NoAudio/VideoFps/DisableCache/Demuxer*/HwDec → `srcs:*`; Loop only for a single non-timed video (the legacy guard) |
| `ApplyOverrideLive` | the item's own source(s) by path (may be a pending B) |
| `ApplyNormalizationLive` | `af` on the item's source(s) |
| `/preview` (ServerHost) | `LpPlayerMedia.Preview` → the playing item's source(s), literal values |
| scene checks (`ApplyPlaylist`, scene launch, `IsSkippedPath`) | `PlayerEngine.ScenesPlayable(s)`; the V→S lead in `Tick` gets `!IsLpPlayer` |
| `Apply(scene)` | **throws "Scenes need the Legacy player engine…" directly** — the one scene check NOT routed through `ScenesPlayable` (it keeps legacy's own AllowScenes / LWE-missing messages for legacy, and tells an lp-player user what to do instead of "enable scene support") |
| restart daemon / timer (`UpdateRestartTimer`, `SpawnRestartDaemon`, `RunRestartDaemon`, `RestartCurrentAndLaunch`) | no-op — the leak-restart is an mpvpaper workaround |

`AudioMonitor.GetNonMpvStreamIdsAsync` (legacy auto-mute, still used in Phase 1): under lp-player
`LpPlayerMedia.OwnStreamFilter()` excludes the player's own streams **by ownership (R69)** —
`application.process.id` == `PlayerPid`, the **compositor's** pid (from `hello.pid` — libmpv runs
in-process inside the compositor, never the supervisor, so this is the right pid unchanged by Task 16),
`node.name` starting `lp-player-bus`,
`target.object`/`Sink:` = the `lp-player-bus` sink (index via `pactl list short sinks`), or
`application.name == "lp-player"` (an extra match, not the only one). Legacy: unchanged.

## Targeting (R61)
- **Global settings → `srcs:*`** (on-screen sources + an in-flight transition's pending B, so a setting
  changed while a transition waits still reaches the incoming wallpaper). `/settings` passes the
  effective (`override ?? global`) value of the playing item; for `gain.user`/`speed`, any OTHER source
  in the targets then gets its own `override ?? global` (`FixupPerItem` — one `state` read, skipped when
  the only target is what's on screen).
- **Per-item overrides** (`ApplyOverrideLive`, `/library/volume|speed`, `/preview`, normalization `af`)
  → the source(s) whose `path` is that item (`state` graph; may be the pending B).
- **Layer settings** (`fit` ← VideoScale) → `lay:*:main` (also re-asserted on every switch, so a
  hotplugged output matches).
- **Mute** (`gain.mute`, user + auto combined like legacy `_isMuted`) → `animate srcs:*.gain.mute` over
  30 ms, never a step.
- **Pause (R75, final)**: ONE `set player.paused` — the Player node's `paused` (player-core.md §
  Graph & properties "Player node paused", Task 16b) freezes every source's EFFECTIVE pause
  (`node.paused || player.paused`, never the node's own raw value — a recipe-held side, e.g. reveal's
  held A, stays exactly as the recipe left it) AND the recipe's own clock (`Runtime::now()` excises
  paused time), so a pending B and an in-flight effect freeze too, not just `cur:*`. Direction comes
  from `get player.paused` (not `cur:*.paused` any more — the node's raw value is never touched by the
  override, so it wouldn't reflect the current pause state). `TogglePause` tracks what it last set
  (`_wantPaused`) so R81 (below) can re-assert it after a restart whose snapshot wasn't restored/was
  stale. The interim R75a ruling (write every `srcs:*.paused` directly) is gone.
- New sources (`SourceProps`) carry every setting at creation: path, kind (image by extension, else
  video), loop, speed, `gain.user`, `gain.mute`, no_audio, hwdec, fps_cap, cache, demuxer_*, af.

## Property map (`MpvPropertyMap.Translate(object[] mpvArgs) → (prop, value)?`)
`["set_property", name, v]` / `["set", name, "v"]`:
volume N → `gain.user` = **60·log10(N/100) dB** (the cubic curve users know: 50 → −18.06), N ≤ 0 → −96 ·
speed → `speed` · mute → `gain.mute` −96 / 0 · pause → `paused` · loop-file inf/yes/no → `loop` ·
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

`ReapplyAllNow` pushes, through the SAME queue as every other mutation (ordered, never races a
concurrent switch/set): the playing item's effective `gain.user`/`speed` (→ `srcs:*`, with `Set`'s own
`FixupPerItem` then giving a pending B its own effective value, same split as a live `/settings`
change, R61), `no_audio`/`hwdec`/`fps_cap`/`cache`/`demuxer_max_mib`/`demuxer_back_mib`, `gain.mute`,
the layer `fit`, the playing item's `af`, and `player.paused` (from `_wantPaused` — the one thing with
no OTHER authority to re-derive from; volume/speed/etc. come from settings.json/the library index,
pause has only "what we last told the player"). `LpPlayerMedia.ReapplyCount` counts how many times it's
actually run (self-test/IT evidence).

## Event flow
`Switch` → `transition` reply `{corr, to}` → `LastCorr`. The event thread records each corr's terminal
outcome — `transition.handoff` → "handoff", `.cancelled {reason}` → "cancelled:<reason>", `.failed
{reason}` → "failed:<reason>" — in a recent-outcomes map and completes its waiter. `WaitCorr(corr, ct,
timeout)` checks the map first (the event can beat the reply — different connections), and every 2 s
asks `logs {corr, kind_prefix:"transition."}` as a safety net (a reconnect gap can't hang a wait); a new
player pid (`Generation`) ends it as "failed:player restarted". `SwitchAndWait` waits for the event
subscription ack before requesting, and returns "handoff" | "cancelled:…" | "failed:…" | "unreachable"
| "caller-cancelled" (→ `cancel {corr}`; `unsupported` = it had already handed off).

## Debugging
- Adapter log: `~/.cache/livepaper/lp-player-adapter.log` (+ stderr → the serve unit's journal),
  rate-limited (an identical line ≤ once / 10 s): every refused request with its **hint**, start
  failures, untranslated mpv commands, engine switches. Player stdout/stderr:
  `~/.cache/livepaper/lp-player-serve.log`. `GET /player-engine` = `{engine, active, available,
  binary, reason}`.
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
`RESULT pass=N fail=M`, exit 0 = all pass). The REAL `livepaper --serve` (from this tree's
`bin/Debug`) against a private `lp-player serve --headless --outputs 640x360@60,320x180@60 --clock real
--ao null`, all over HTTP, checked with `lp-player ctl`. **Hermetic**: temp HOME + every XDG dir (own
settings.json with `PlayerEngine=lp-player`, own library, own lp-player socket + event log), its own
random backend port, display/compositor env unset; it aborts before any playback call unless
`/player-engine` says `active: lp-player`, so it can't start or kill mpvpaper; an EXIT/INT/TERM/HUP trap
SIGCONTs + stops the player and the backend and removes the temp dir. Covers: `/apply` + fade
full-live, `/current`; every live setting (Volume −18.06, Speed, VideoScale → layer fit, VideoFps,
HwDec, DisableCache, Demuxer, NoAudio, Loop); mute; pause; `/volume`; `/preview`; timed rotation
(interval 20 s + Wait + Advance, 2 s clips → align:end advances); `/next` mid-wait; `/stop`;
`/library/volume|speed` on the playing item; a pending B getting its OWN override while the global
changes; pause during an in-flight transition (R75 final: ONE `player.paused`, checked via `ctl get
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
cap; draining afterward must bring it back to 0), then a round-trip against a **private, supervised**
`lp-player serve --headless --outputs 640x360@60 --clock stepped --ao null` (temp
`XDG_RUNTIME_DIR`/`XDG_STATE_HOME` under `/tmp` — a unix socket path must be < 108 bytes — own
`--socket`, `LD_LIBRARY_PATH` removed, `quit` + kill at the end; the shared client is swapped to it
with `AutoSpawn=false`, so a real player is never touched). **The spawned `.NET Process` is the
SUPERVISOR** (serve forks its compositor child before anything else runs) — `hello.pid` (→
`client.PlayerPid`) is the compositor, a different pid; `hello.supervisor_pid` (→
`client.SupervisorPid`) is the spawned pid. Covers: `hello` asserts both pids against the spawned
process + each other; colour → clip with `align:now` + `fade` gets `transition.handoff` **as a
subscribed event**; mpv `volume 50` via `Mpv()` → `gain.user` −18.06; a cut with `align:end` hands off
at A's end; a cancelled aligned switch → `cancel {corr}` → `transition.cancelled`, A stays; a
SIGSTOPped **compositor** (never the supervisor — it would feel nothing): the first query returns in
≤ 450 ms (QuickMs), the next in ≤ 50 ms (stall breaker), a property set returns at once (queued), and
it recovers after SIGCONT — **R81**: that recovery (`Recovered`) must have bumped
`LpPlayerMedia.ReapplyCount` (waited for via `Drain()` before checking, since `Queue(...)` from an
event handler is fire-and-forget by design); a SIGKILLed **compositor** yields a NEW `hello.pid`
within 1.5 s with the SAME `supervisor_pid` (the supervised restart, Task 16 § Supervisor) — **R81**
again: `OnRestarted` must also have bumped `ReapplyCount`; then `LpPlayerMedia.StopAndQuit()` must
leave NO lp-player process — neither the new compositor nor the supervisor (the regression this fixes:
killing only the compositor while its supervisor lived just made the supervisor restart it again). A
pump steps the stepped clock (40 ms) on its own connection. ~16 s.
