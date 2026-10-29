# Cover sources — spike (Phase 3 Task 6, 2026-10-30)

What the covered Signal reads on each compositor, checked **read-only** on the owner's session
(Hyprland 0.56.2, DP-1 + DP-2): `hyprctl -j monitors|clients|workspaces` and the raw IPC socket. No
`hyprctl dispatch`, no window of the owner's opened, moved or closed. Input: the rules recon
(`docs/superpowers/specs/2026-10-29-rules-recon.md` §0.1, §1.1–1.4) and the plan's revised designer call 9.

## Why not wlr-foreign-toplevel everywhere

The plan's first rule was "a toplevel that is `activated`, not minimized, and fullscreen/maximized on an output
covers it". `activated` is keyboard focus (wlr-ft protocol XML): a fullscreen game on DP-1 would stop covering the
moment the user clicks DP-2, and the wallpaper would resume behind the game. wlr-ft also has no workspace, so a
fullscreen window on a hidden workspace can't be told apart from one on screen. "Covered" must mean *visible*, which
needs the compositor's own IPC where there is one.

## Hyprland (checked on the machine)

- **Sockets:** `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/` holds `.socket.sock`, `.socket2.sock` (dotfiles:
  a plain `ls` hides them), `hyprland.lock`, `hyprland.log`. A player run with a private `XDG_RUNTIME_DIR` (the
  hermetic on-machine scripts) must fall back to `/run/user/<uid>/hypr/<sig>/` — the source tries both, then
  `/tmp/hypr/<sig>/` (Hyprland < 0.40).
- **Batch:** `[[BATCH]]j/monitors;j/clients` on `.socket.sock` answers both JSON replies joined by `"\n\n\n"`, then
  closes. One request per re-read.
- **`j/monitors`** (per monitor): `id`, `name` (= the `wl_output` name, `DP-1`), `activeWorkspace {id, name}`,
  `specialWorkspace {id, name}` — `{id: 0, name: ""}` when no special workspace is open on it, `focused`, `disabled`,
  `dpmsStatus`. `j/monitors` lists enabled monitors only (`monitors all` = 2 here, none disabled).
- **`j/clients`** (per window): `address`, `class`, `initialClass`, `pid`, `workspace {id, name}`, `monitor` (an
  id), `fullscreen`, `fullscreenClient`, `mapped`, `hidden`, `visible`, `floating`, `pinned`, `xwayland`,
  `contentType`. Special workspaces have negative ids (`special:<name>`).
- **`fullscreen`** is Hyprland's internal mode bitmask: 0 none, 1 maximized, 2 fullscreen, 3 both;
  `fullscreenClient` is what the client was told (differs under fake fullscreen) and is not used.
- **`visible` is not "on screen"** (recon §1.1, machine 2026-10-29: windows on inactive workspace 6 reported
  `visible: true`, a window hidden behind a fullscreen kitty reported `false`). Never read.
- **`j/workspaces`:** `id`, `name`, `monitor`, `monitorID`, `windows`, `hasfullscreen`, `lastwindow`.
  `hasfullscreen` doesn't say which mode, so the rule reads the clients.
- **socket2:** `EVENT>>DATA` lines. `fullscreen>>0|1` carries no window and needn't alternate, so every relevant
  event triggers a re-read (coalesced 30 ms, confirmed 300 ms later), never an inference from the event.
- **Focus events are title events too:** 5 s of socket2 with the owner just working in a terminal gave
  `windowtitle` ×5, `windowtitlev2` ×5, `activewindow` ×5, `activewindowv2` ×5 — Hyprland re-posts
  `activewindow`/`activewindowv2` on every title change of the focused window (kitty's title spinner). Focus never
  changes visibility, so only an `activewindowv2` with a *new* address re-reads; with that, 20 s of the owner's
  activity went from 48 queries (every event + confirm) to 4 (start + one focus change, each confirmed).

**State on 2026-10-30 (read-only):** DP-1 shows workspace 1 (no windows), DP-2 workspace 6 (one tiled kitty,
`fullscreen: 0`, `mapped`, not `hidden`), no special workspace open → both monitors uncovered. There was no
fullscreen or maximized window, no window on a hidden workspace and no open special workspace to look at, and
creating one would have changed the owner's session. Those cases rest on the recon's machine record (a `fullscreen
1` kitty = maximized; `visible` on hidden workspaces) and on unit tests over records with the same field names.

**The rule** (`signal::covered::hypr_cover`): a monitor is covered by the highest `fullscreen` bits among the mapped,
non-`hidden` clients whose `workspace.id` is its open special workspace or its active workspace. Cases:

| case | covered? | why |
|---|---|---|
| fullscreen game on DP-1's active workspace, focus on DP-2 | DP-1 fullscreen | focus is not in the rule |
| fullscreen window on a workspace DP-1 doesn't show | no | its `workspace.id` is neither active nor special |
| maximized kitty (`fullscreen: 1`) | maximized | counts in `maximized` mode only |
| fullscreen window in an open special workspace | that monitor | the special workspace is on screen |
| special workspace closed (`id` 0) | no | |
| open special workspace over a fullscreen window on the active one | yes | the wallpaper is still behind the fullscreen window |
| background tab of a group (`hidden`) / unmapped | no | |

## Sway

Not running here; from the i3 IPC docs + the recon (§1.2). `SUBSCRIBE ["window","workspace","output","shutdown"]`,
`GET_TREE` on a second connection. A container's `fullscreen_mode` is 0 none, 1 workspace, 2 global; `visible` is set
on views and is a real on-screen flag. A fullscreen split container counts as visible through its views. No
maximized state: both modes mean fullscreen. Tested against a fake socket (`signal::sway`).

## Other wlroots compositors (wlr-foreign-toplevel)

labwc, river, Wayfire, niri… The rule there is "fullscreen (or maximized), not minimized, on that output, any
focus". It can't see workspaces: a fullscreen window on a hidden workspace covers its output — the fallback's known
false positive, accepted (the plan's Risk 2). Bound only when neither Hyprland nor Sway IPC is the source.

## GNOME, KDE

GNOME has no layer-shell (the player can't run); KWin implements neither wlr-ft nor gives
`org_kde_plasma_window_management` to an unlisted client. The source reports `unavailable`, every
`out:<c>.covered` reads `unavailable`, `hello.health.cover` says why, and the rule never pauses.

## On-machine check (2026-10-30)

`liascape-watch` stopped (no other liascape-player surface mapped), then a private `liascape-player serve
--no-supervise` on the real Wayland session: its own `XDG_RUNTIME_DIR`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`, a private
PipeWire + WirePlumber with one null sink (the bus reported `default_sink: hermetic-sink`), a dark colour source on
both outputs, `player.pause_when_covered maximized`. Nothing was sent to Hyprland but read-only `j/` requests; no
window was touched.

- `hello`: backend `wayland`, `health.cover {ok: null, source: hyprland}` (the first reading was still in flight;
  the capability list now carries `cover` whenever a source exists). The private `XDG_RUNTIME_DIR` had no
  `hypr/<sig>`, so the source found the session's sockets through the `/run/user/1000/hypr/<sig>` fallback.
- `probe cover`: `source hyprland, ok true`, DP-1 and DP-2 both `covered: none`, `showing: true`, `rule: false`,
  hold inactive — matching `hyprctl -j` (DP-1 workspace 1 empty, DP-2 workspace 6 with one `fullscreen: 0` kitty, no
  special workspace). `out:DP-1.covered = "none"`, `covered_by = {}`; `cover.source` logged pending → ok; no
  `cover.changed`; the colour source `effective_paused: false`.
- **Not exercised live:** a fullscreen or maximized window of the owner's (there was none, and making one would have
  changed their session), so `cover.engaged` on the real outputs is covered by the tests only: the fake-source API
  tests and `cover_from_a_fake_hyprland` (the same thread and parser against a fake socket with this machine's field
  names). Task 12 step 4 runs it with real windows.
- `liascape-watch` started again afterwards.
