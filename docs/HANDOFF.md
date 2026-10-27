# Handoff — 2026-10-27 ~16:30 (5-hour window at ~90 %, reset ≈ 19:30)

Parked so the next session starts cold-cache without re-deriving anything. Delete this file once acted on.

## State of `lp-player` (all committed, live player on the newest release build)
This session, oldest first: `b26bb00` cross-process FileLock + field-level settings writes (`Save` private) ·
`b766e04` UI told what plays after a failed switch · `19bbbc9` mpv's dropped first frame re-requested
(`refetch_lost_frame`, paused/image) · `dadc48c` TODO ticks · `86449e3` matrix Xvfb on :90+ (it was taking the
session's :1) · `fe2ac90` mpv clipboard off in every core (an X server loss made mpv `exit()` → player SIGSEGV) ·
`86787d8` Phase 2 plan · `3d8dc61`/`563211a`/`e5cdf7e` owner's Phase 2 decisions · `12ad3ce` Ended held until Ready in
both renderers + ended clip refetched · `03d860a` matrix fuzz mode (`--fuzz N [--seed S] [--fuzz-runs K]`,
`--fuzz-replay 'state:c1,c2'`).

Not done: no full-matrix gate since `5b470c7` on a quiet machine (every run today was under load 20–60 from agents).
Do one (`scripts/test-ui-matrix.sh --jobs 4`) once the agent branches below are merged. `.envrc` (`use flake`) +
`.gitignore` `.direnv/` in the main tree are the owner's (16:08) — leave them.

## Agent worktrees (`.claude/worktrees/agent-*`, branch `worktree-agent-*`) — what to do with each
After the reset the prompt cache is gone: don't resume a big transcript — inspect the worktree (`git log
lp-player..HEAD`, `git diff`), then finish it yourself or brief a FRESH agent with this file + the diff.

| worktree | task | state at handoff | next |
|---|---|---|---|
| agent-a188cae2ad32c1aa0 | one effective-settings resolver (C#, `LpPlayerMedia`) | committed `9378cf6` "Resolve Effective Settings In One Place" (+ a cherry-pick of the Xvfb fix), was verifying | check its report/diff, run adapter IT + settings-merge + matrix `--changed`/targeted, cherry-pick `9378cf6` |
| agent-ac179389bd2b843aa | zero-copy hwdec (interop) on the render worker | 11 files dirty, uncommitted (sources/mpv.rs, render_worker.rs, host.rs, probe, tests) | finish A/B measurements (CPU 4K60/1080p30, loop busy per switch, `t20d_*` must pass); keep copy modes if interop stalls the loop |
| agent-af7cc29c7e5948e17 | load-sensitive test flakes (adapter IT, stepped step-timeout, supervise.rs 300 ms / snapshot waits) | 2 files dirty (adapter script) | finish: condition waits, never loosen a bound that is the test's point; before/after under artificial load |
| agent-aeb0ab56b10b5644b | Phase 2 Track B: Tasks 3–4 (worker protocol + lifecycle, dmabuf transport, synthetic renderer); `lwe` feature default OFF until Track A | 3 files dirty, just started | continue per the plan; high effort recommended |
| agent-a2e2f4…, a456b9…, a7a65d… | crash hunt / plan / fuzz | done + merged | `git worktree remove` them |
| agent-aaf1fbade6b857fd0 | fuzz bugs | STOPPED before any change (owner: park it) | brief below |

## Parked brief — the two fuzz-found playlist bugs (not started)
Both reproduce through the real UI on a hermetic stack via `scripts/test-ui-matrix.sh --fuzz-replay '…'`:
1. `pending:cli:random,cli:next-wallpaper` — advance-on-end playlist [k4,k1,k2] with an aligned switch armed; when
   random lands on k2, every re-arm targets k2 itself, so next-wallpaper stays on k2 (2/3 replays; passes when random
   picks k1). Expected: next = the item after k2 in playlist order.
2. `playlist:stripRemove:other,trashUndo:shown,cli:next-wallpaper` — 2-item timed playlist; trash the playing item
   (plays on with 1 item), Undo puts it back → the tick is dead: `pending_action.txt` ("next") never consumed while
   `/current` says `timed=true`. Every time; without trash+undo next works. Suspect (unverified): a 1-item session
   starts no tick and Undo never restarts it.
Process: systematic-debugging → root cause in PlayerHelper timed machinery / AppOps.Trash/Undo / SavePlaylistState /
RunAction random (history, pre-fetch index, `PlayingHistoryIndex`, `ArmVideoEndWait`) → turn each replay into a
permanent matrix cell (RED first) → fix → GREEN → `--changed` + `--only '× (cli:|trash|strip|pl[A-Z]|shuffle|seq)'`
+ adapter IT → a short hunt `--fuzz 12 --fuzz-runs 6 --seed 4242 --jobs 2`. Check whether legacy shares the bug.

## Phase 2 (scenes) — plan `docs/superpowers/plans/2026-10-27-lp-player-phase2-scene-worker.md`
All decisions recorded at its top (D1 shared worker, D2 Rust, D3 fork, D4 like WE + stream mix for a future per-app
filter, D5 30 fps, D6 skip unless whitelisted, D7 synthetic + real SFW 431960 scenes; speed = animation + pitch-
corrected audio; mouse on; properties editor IN Phase 2; install hard-fails; GPU budget setting default throttle;
VRAM-low rule Pause/Stop/Off default Stop + per-scene limit off by default; loudness learned on first play; broken
scene advances).
- **Track A (Tasks 1–2, LWE build + patches): the fork exists** — `Kryxzort/linux-wallpaperengine` (public, created
  2026-10-27 with the owner's OK). Put our patches on a branch there; pin by hash. Not started.
- Track B running (above). Task 5 (`scene` Source kind) after Track B's interfaces land.

## Owner answers (2026-10-27)
1. Fork: OK — done.
2. Model/effort: "whatever you think is best balance" → hard work (Phase 2 tracks, hunts) Opus high effort;
   chores (flakes, docs, merges, gate runs) Sonnet.
3. Push/merge + re-pin: OK. `lp-player` is PUSHED to `Kryxzort/livepaper-pro` (remote `fork`; SSH has no key in the
   agent shell → push with `git -c credential.helper= -c credential.helper='!gh auth git-credential' push
   https://github.com/Kryxzort/livepaper-pro.git lp-player`). **Merge into `main` only after a quiet full-matrix
   gate** (finishing-a-development-branch), push main, then give the owner the `/etc/nixos/livepaper.nix` re-pin to
   GitHub (never commit in /etc/nixos; the owner runs `nixos-rebuild`).

## Night run 2026-10-27 (owner asleep, "don't stop for questions"; cap 2 big agents)
Merged into `lp-player` since the handoff: zero-copy hwdec on the render worker (`bafb818`; 4K60 49 → 7 % of a core),
the effective-settings resolver (`9835f8b`, `a43fb81`), Phase 2 Tasks 3–4 (`a5fbc30`, `5936046`: worker protocol +
lifecycle, dmabuf transport, synthetic renderer; `lwe` feature default off), test-flake hardening incl. a real
stepped-mode fix (`eb2b251`), the two fuzz playlist bugs (`8c83331` random re-seats the rotation, `90caefe`
`EnsureTimedTick`). Worktrees of finished agents can be removed. Running: Phase 2 Track A (LWE fork build + patches,
pushes a branch to `Kryxzort/linux-wallpaperengine`). Gate for `main`: full matrix + adapter + settings-merge on the
merged tree (then merge `lp-player` → `main`, push, re-pin instructions below).

## `main` merged (2026-10-27 night)
`main` fast-forwarded to `b33eec9` and pushed to `Kryxzort/livepaper-pro` after a quiet gate on that exact tip:
matrix 716/0 (load 2), adapter IT 118/0 ×2, settings-merge 53/0, player crate suites green in both render modes.
**Owner: re-pin NixOS** — in `/etc/nixos/livepaper.nix` replace the `git+file…ref=lp-player&rev=3ae0937…` line with
```nix
  livepaperFlake = builtins.getFlake "github:Kryxzort/livepaper-pro/b33eec9d772682285287914020cb8be9158a6b89";
```
then `sudo nixos-rebuild switch` (no `--impure` needed for a github: pin). The first build also builds the LWE core
from `Kryxzort/linux-wallpaperengine` (pinned by hash in `third_party/lwe/PIN`). Phase 2 work after `b33eec9`
(Task 7 real scenes, …) stays on `lp-player` until its own gate.
