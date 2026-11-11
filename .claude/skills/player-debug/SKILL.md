---
name: player-debug
description: Inspect or debug a running liascape-player (the Rust wallpaper compositor) — what each monitor shows, why a switch failed, audio gaps, wrong volume, a crashed scene. Use when asked why playback, a transition or scene audio misbehaves, or before changing src/player or src/backend/Player to find the real cause.
---

# Debugging liascape-player

Read-only on the owner's machine: query the running player, never restart, kill or reconfigure it unless the owner
asked. For experiments start a private one (below). Never print `~/.config/liascape/settings.json` or `steam-auth.json`.

## 1. What is on screen and what each source runs
- `liascape ctl state` — every output's layer content (`lay:<output>:main.content`, `cur:`), each source's `path`, `ready`, `paused`, `gain`, `gain_effective_db`, running `transitions` and `programs` (`prog:main`: `phase`, `path`, `next`, `played_ms`).
- `liascape ctl probe '{"name":"sources"}'` — what mpv really runs per source (`mpv_volume_gain`, pause, `effective_paused`).
- `liascape ctl get '{"path":"player.paused"}'` — the player owns pause; the backend keeps no copy.

## 2. One switch's story
- Find the corr: `liascape ctl logs '{"kind_prefix":"transition."}'` (or the adapter log names it).
- `liascape ctl logs '{"corr":"tr-12"}'` — scheduled → started → handoff → done, or cancelled/failed with a reason.
- `liascape ctl logs '{"min_level":"warn"}'` — everything that went wrong.

## 3. Audio
- `liascape ctl probe '{"name":"bus"}'` first — is there a bus, which sink, meter health.
- `liascape ctl probe '{"name":"dropout","args":{"corr":"tr-N"}}'` after `transition.done` — real gaps vs the gain schedule (result arrives as a `probe.dropout` event: `liascape ctl subscribe probe.`).
- `liascape ctl probe '{"name":"meter.window","args":{"last_ms":1000}}'` — the bus's raw dBFS.
- Symptom → query → likely cause table: `docs/player/debugging.md`.

## 4. Debug mode
- `liascape ctl set '{"path":"player.debug","value":true}'` (or a private `serve --debug`) runs the dropout probe after every transition automatically.

## 5. The backend's side
- Adapter log: `~/.cache/liascape/liascape-player-adapter.log`; player stdout/stderr: `~/.cache/liascape/liascape-player-serve.log`.
- `GET /player-engine` (with the API token) — engine, binary, `running.stale`, `scenes`, `vram`.

## 6. A private player for experiments
- `cd src/player && env -u LD_LIBRARY_PATH nix develop -c cargo build`, then run `target/debug/liascape-player serve --headless --outputs 640x360@60 --clock real --ao null` with its own `XDG_RUNTIME_DIR` and `XDG_STATE_HOME` (socket path < 108 bytes); talk to it with `LIASCAPE_PLAYER_SOCKET=<its socket> target/debug/liascape-player ctl …`.
- Signal the COMPOSITOR pid (`ctl hello` → `pid`) to simulate a hang or crash, never the supervisor; stop it with `ctl quit`.
- For the full stack use the hermetic tests in `CLAUDE.md` § Verify your work.
