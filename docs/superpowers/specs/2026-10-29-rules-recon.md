# Rules system — reconnaissance (2026-10-29)

Research only, no design decisions. Input for the rules system (triggers → actions, with exceptions) that runs
inside `liascape-player`. Read with the Phase 3 plan (`plans/2026-10-29-liascape-player-phase3-programs.md`,
Task 6 pause-when-covered, Task 14 auto-mute) and `plans/2026-10-29-game-running-signal-DRAFT.md`.

Confidence tags: **[machine]** = checked on the owner's machine (CachyOS, kernel 7.1.3, Hyprland 0.56.2, uwsm,
DMS + Noctalia shells, PipeWire + pipewire-pulse, NVIDIA, no battery). **[doc]** = from upstream docs or protocol
XML. **[belief]** = from memory or secondary sources, not verified here. Verify these before you build on them.

---

## 0. The findings that change the design

1. **"Covered" must mean visible, not focused.** Task 6's predicate is `activated && !minimized && fullscreen/maximized`.
   It breaks on two monitors. Under wlr-foreign-toplevel, `activated` means *has keyboard focus*. If a game is
   fullscreen on DP-1 and the user clicks a window on DP-2, the game loses `activated`, so DP-1 is "uncovered" and
   the wallpaper resumes behind the game. A fullscreen window on a hidden workspace is the opposite case: it has no
   `activated` flag, and nothing in wlr-ft says whether its workspace is shown. **wlr-ft cannot answer "is output X
   covered" on any compositor with workspaces.** Hyprland IPC answers it exactly (§1.1). Sway IPC has a `visible`
   flag (§1.2). Use wlr-ft only as the generic fallback, with "fullscreen on that output, any focus" as the rule,
   and accept the hidden-workspace false positive there.
2. **Three identity namespaces must be joined.** A rule's "app" is seen as a Wayland `app_id`, a process
   (pid / binary / cmdline) and a PipeWire client (`application.*`). None of them is reliable alone:
   - On NixOS the binaries are `.foo-wrapped` **[machine]**.
   - Electron apps all show up as `electron` (vesktop) **[machine]**.
   - Browser audio comes from a child process. Opera: the window's pid is 72290, the audio client's pid is 73002,
     and 73002's parent is 72290 **[machine]**.
   - pipewire-pulse clients' `pipewire.sec.pid` is the pulse server's own pid (2014), so their pid is self-reported
     **[machine]**.
   - Flatpak pids are namespaced.

   **The strongest join key on this machine is the systemd scope.** uwsm/app2unit puts every app in
   `app-<desktop-id>-<pid>.scope`, for example `app-vesktop-3367.scope` and `app-org.chromium.Chromium-72290.scope`
   **[machine]**. A pid's `/proc/<pid>/cgroup` gives the app's whole process tree plus its desktop id, and that
   matches both the window's pid and the audio child's pid.
3. **Process start/exit is event-driven and unprivileged on this kernel.** A netlink proc connector listener ran
   as uid 1000 and got 191 exec events in 1.5 s **[machine]**. The CAP_NET_ADMIN requirement was lifted by the 2023
   `cn_proc` series. Older kernels still need the capability, so poll `/proc` as the fallback. Expect a flood
   (1128 messages in 1.5 s): filter on the kernel side if possible, and read `comm` lazily.
4. **Lock state has no portable source.**
   - `hyprland_lock_notifier_v1` is advertised here **[machine]** and pushes locked/unlocked.
   - logind `LockedHint` is only set if the locker sets it. It is `no` here **[machine]**.
   - logind's `Lock`/`Unlock` signals are *requests* to lock, not states.
   - `org.freedesktop.ScreenSaver.ActiveChanged` is owned by the bar shell (DMS) here **[machine]**.
5. **GNOME cannot host liascape-player at all.** Mutter has no `zwlr_layer_shell_v1` **[doc]**, so no GNOME trigger
   work matters until there is a Shell-extension host. **KDE works for rendering but hides window state:** KWin
   implements neither wlr-ft nor ext-foreign-toplevel-list **[doc: wayland.app]**. Its
   `org_kde_plasma_window_management` is granted only to clients whose `.desktop` declares it (§1.4). The practical
   KDE route is a KWin script that calls back over D-Bus.
6. **The player already has the PipeWire per-stream capture machinery.** `audio/sysmon.rs` creates one passive
   capture per `Stream/Output/Audio` node, with an `admit()` hook already planned for allow/deny lists. Task 14's
   meter and the "app is playing audio" trigger should share it rather than add a second one.
7. **A game signal comes from several cheap sources** (§1.8):
   - the GameMode bus: `ClientCount` emits-change, and `GameRegistered(i,o)` **[machine]**;
   - the Steam `reaper` cmdline;
   - the Proton window class `steam_app_<N>`;
   - Hyprland's per-client `contentType` (`game` when the app sets `wp_content_type_v1`) **[machine: field present]**;
   - the PipeWire `media.role=Game`.
8. **Layer-shell surfaces never show up as toplevels.** Bars, docks, desktop widgets, launchers and lock screens
   (DMS, Noctalia, waybar, eww, rofi, bongocat) are excluded from "covering" by construction **[machine:
   `hyprctl layers`]**. The cover exception catalogue only has to name *toplevels* that pretend to be fullscreen:
   screenshot and annotation tools, XWayland docks, xwaylandvideobridge.

---

## 1. Per trigger: API, push/poll, identity, gotchas

### 1.1 Hyprland (IPC)

**Sockets.** `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/`:
- `.socket.sock` takes requests (`j/clients`, `j/monitors`, `j/workspaces`, `j/activewindow`, `j/layers`; batch
  several with `[[BATCH]]`).
- `.socket2.sock` streams events as `EVENT>>DATA\n` lines, comma-separated **[doc, wiki 0.56]**.
- Both are dotfiles, so a plain `ls` does not show them **[machine]**.

**socket2 events that matter** **[doc]**:

| event | data | use |
|---|---|---|
| `fullscreen` | `0/1` | **No window address, no mode.** Not guaranteed to alternate (an app may send three enter requests). Re-query state on every one. |
| `activewindowv2` | `ADDR` | focus |
| `activewindow` | `CLASS,TITLE` | |
| `windowtitlev2` | `ADDR,TITLE` | title rules |
| `openwindow` | `ADDR,WSNAME,CLASS,TITLE` | |
| `closewindow` | `ADDR` | |
| `kill` | `ADDR` | |
| `movewindowv2` | `ADDR,WSID,WSNAME` | |
| `workspacev2` | `WSID,WSNAME` | Only on a user-requested change; mouse focus moves come as `focusedmonv2`. |
| `focusedmonv2` | `MON,WSID` | |
| `activespecialv2` | `WSID,WSNAME,MON` | Empty values when the special workspace closes. |
| `moveworkspacev2` | `WSID,WSNAME,MON` | |
| `minimized` | `ADDR,0/1` | Only when a taskbar *requests* it; Hyprland has no real minimize. |
| `changefloatingmode` | `ADDR,0/1` | |
| `pin` | `ADDR,0/1` | |
| `monitoraddedv2` / `monitorremovedv2` | `ID,NAME,DESC` | |
| `screencast` / `screencastv2` | `STATE,OWNER[,NAME]` | Trigger "screen is being shared" (owner = monitor / window / region). |
| `bell` | `ADDR` | `xdg-system-bell-v1` |
| `configreloaded` | | |
| `openlayer` / `closelayer` | `NAMESPACE` | |

**Per-window state, from `j/clients`** **[machine, 0.56.2]**:
- Fields: `address`, `pid`, `class`, `initialClass`, `title`, `workspace{id,name}`, `monitor` (an id; map it through
  `j/monitors`), `fullscreen`, `fullscreenClient`, `floating`, `pinned`, `hidden` (a background tab of a group),
  `visible`, `mapped`, `xwayland`, `contentType` (`none|photo|video|game`), `inhibitingIdle`, `stableId`, `tags`,
  `xdgTag`, `xdgDescription`, `focusHistoryID`.
- `fullscreen` is the internal mode, a bitmask: 0 none, 1 maximized, 2 fullscreen, 3 both **[belief; 1 observed for
  a `fullscreen 1` kitty]**. `fullscreenClient` is what the client was told (it differs under fake fullscreen).
- **`visible` is not "on screen".** Windows on inactive workspace 6 reported `visible=true`, while the app hidden
  behind a fullscreen kitty on the active workspace 7 reported `false` **[machine]**. Do not use it for covering.

**Per-monitor state:**
- `j/monitors`: `name`, `id`, `activeWorkspace{id}`, `specialWorkspace{id,name}` (id 0 when none is open),
  `focused`, `dpmsStatus`, `disabled` **[machine]**.
- `j/workspaces`: `hasfullscreen`, `monitor`, `windows` **[machine]**.

**Exact cover rule on Hyprland.** An output is covered when either of these has a mapped client with
`fullscreen & mode` set:
- its open special workspace (if any), or
- its active workspace.

The event-driven recompute: on `fullscreen | workspacev2 | focusedmonv2 | activespecialv2 | moveworkspacev2 |
openwindow | closewindow | movewindowv2 | changefloatingmode | monitor*`, send one batched
`j/monitors;j/clients` request. It is cheap: these events are rare and fire on user actions.

**Address ↔ wlr-ft handle.** `hyprland_toplevel_mapping_manager_v1` is advertised here **[machine]**. Its
`get_window_for_toplevel_wlr(zwlr handle)` / `get_window_for_toplevel(ext handle)` returns a `window_address`
event, or `failed` **[doc]**. This lets a wlr-ft-based tracker get a pid on Hyprland without parsing IPC JSON.

**Gotchas:**
- Gate on `HYPRLAND_INSTANCE_SIGNATURE`. After a Hyprland restart the signature changes, so reconnect.
- The owner's memory notes a Lua-config Hyprland setup where `hyprctl dispatch` is shimmed. Read-only `j/` requests
  over the socket are unaffected.

### 1.2 Sway (i3 IPC)

**[doc/belief — Sway is not running on this machine]**
- **Socket:** `$SWAYSOCK`. `SUBSCRIBE ["window","workspace","output","shutdown"]` pushes events; `GET_TREE` and
  `GET_WORKSPACES` give a full snapshot.
- **Window events:** `change` = `new|close|focus|title|fullscreen_mode|move|floating|urgent|mark`, with the full
  container attached. Container fields: `app_id` (`null` for XWayland), `window_properties.class/instance` (X11),
  `pid`, `shell` (`xdg_shell|xwayland`), `fullscreen_mode` (0 none, 1 workspace, 2 global), `visible` (a real
  on-screen flag, unlike Hyprland's), `inhibit_idle`, `idle_inhibitors`.
- **No "maximized" in Sway.** A tiled window alone on its workspace is the nearest thing. Ship fullscreen-only
  there, or treat "only tiled window on the output's visible workspace" as maximized.
- **A workspace switch arrives as a `workspace` event, not per-window.** Re-read `GET_TREE` and recompute from
  `visible` + `fullscreen_mode`.

### 1.3 Other wlroots compositors / niri / COSMIC

**`zwlr_foreign_toplevel_manager_v1` (v3)** **[doc: wayland.app]**:
- **Supported:** Hyprland, Sway, labwc, Wayfire, river, niri, Jay, Cage, phoc, Treeland, Louvre, Mir (v2).
- **Not supported:** KWin, Mutter, COSMIC, Weston, gamescope.
- **Events:** `title`, `app_id`, `output_enter`/`output_leave`, `state` (an array of `maximized`, `minimized`,
  `activated`, `fullscreen` (v2+)), `parent` (v3), `done`, `closed`.
- **No pid. No workspace.** `activated` means focus.

**`ext_foreign_toplevel_list_v1`** **[doc]**:
- **Supported:** Hyprland, Sway, niri, COSMIC, labwc, river. **Not supported:** KWin, Mutter, Wayfire.
- **Events:** `identifier` (stable, up to 32 bytes), `app_id`, `title`, `done`, `closed`.
- **No state at all**, by design; extension protocols are meant to add it. Good for "app is open" only.
- Advertised here **[machine]**.

**`ext_workspace_manager_v1`** — advertised here **[machine]**. It gives workspace active/hidden state per output
group, but no window membership. It cannot alone tell which workspace a toplevel is on.

**niri IPC** **[doc]**:
- `niri msg --json event-stream`, or the socket at `$NIRI_SOCKET`. It sends the full state first, then updates.
- Events: `WindowsChanged`, `WindowOpenedOrChanged`, `WindowClosed`, `WindowFocusChanged`, `WorkspacesChanged`
  (with `is_active` per output), `WorkspaceActivated`.
- `Window` fields: `id`, `title`, `app_id`, `pid` (`None` for xdg-desktop-portal-gnome windows), `workspace_id`,
  `is_focused`, `is_floating`, `is_urgent`, `layout`, `focus_timestamp`.
- **No `is_fullscreen` / `is_maximized` in the published struct.** Combine wlr-ft's `fullscreen` state with niri's
  `workspace_id` + active workspaces. niri is scrollable tiling, so "maximized" is a column width; treat it as
  fullscreen-only.

**COSMIC** **[belief]**: its own `zcosmic_toplevel_info_v1` extends ext-foreign-toplevel handles with state
(maximized, minimized, activated, fullscreen, sticky), output and workspace. Access policy for privileged protocols
unverified.

### 1.4 KDE Plasma (KWin) and GNOME (Mutter)

**KDE:**
- **Layer-shell:** yes, so liascape-player can render.
- **Window state, option 1:** `org_kde_plasma_window_management`. It has full state (fullscreen, maximized, active,
  minimized, on-all-desktops), `app_id`, `resource_name`, **`pid`**, virtual desktop and stacking order. But it is a
  restricted global, granted only if the client's `.desktop` file has
  `X-KDE-Wayland-Interfaces=org_kde_plasma_window_management`. KWin matches the running exe against the desktop
  file's `Exec`, and a `%u` in `Exec` breaks the match **[doc: KDE mailing list + plasma-workspace MR]**.
  liascape-player is launched by the backend, not from a desktop file, so getting the grant is uncertain.
- **Window state, option 2 (robust):** a KWin script loaded over D-Bus (`org.kde.KWin /Scripting
  loadScript/start`). It hooks `workspace.windowAdded` / `windowActivated` and each window's
  `fullScreenChanged` / `maximizedChanged`, and pushes changes with `callDBus` to a liascape bus name. Identity:
  `pid`, `resourceClass`, `desktopFileName` **[belief]**. Event-driven and unprivileged, but it needs a session bus
  service on our side.
- **Lock:** `org.freedesktop.ScreenSaver.ActiveChanged` (ksmserver/kscreenlocker); logind `LockedHint` is set by
  kscreenlocker **[belief]**.

**GNOME:**
- **No layer-shell, so the player cannot run.** Window state is only reachable from a Shell extension, or from
  `org.gnome.Shell.Introspect.GetWindows` (allow-listed callers / unsafe mode).
- GNOME live wallpapers (Hanabi, Hidamari) are Shell extensions or desktop windows for this reason.
- Out of scope until a GNOME host exists.

### 1.5 logind (system bus `org.freedesktop.login1`)

| signal / prop | push? | notes |
|---|---|---|
| `Session.Lock` / `Session.Unlock` (signals on the session object) | push | A **request** ("please lock": `loginctl lock-session`, hypridle's `lock_cmd` path). Not a confirmation that a lock screen is up. |
| `Session.LockedHint` (PropertiesChanged) | push | Only true if the locker calls `SetLockedHint`. `no` here while unlocked **[machine]**. hyprlock/swaylock don't call it by default **[belief]**; kscreenlocker does. |
| `Manager.PrepareForSleep(b)` | push | `true` before suspend, `false` after resume. To act *before* sleep (pause, release the GPU), take a `delay` inhibitor (`Inhibit("sleep", "liascape", "...", "delay")`, fd-based, allowed for the active session's user by polkit default). Close the fd when done (default limit 5 s). On resume, **re-sync everything** (outputs may have reprobed). |
| `Manager.PrepareForShutdown(b)` | push | Same pattern. |
| `Session.IdleHint` / `IdleSinceHint` | push | Set only by an idle manager that calls `SetIdleHint` (e.g. hypridle with config) — `no`/0 here **[machine]**. Prefer Wayland `ext_idle_notifier_v1` (advertised **[machine]**): `get_idle_notification(timeout)` → `idled`/`resumed`. v2's `get_input_idle_notification` ignores idle inhibitors, so a playing video can't keep the wallpaper "active". |
| `Manager.PreparingForSleep`, `BlockInhibited` | prop | Snapshot at start **[machine: readable unprivileged]**. |

**Lock, best per compositor:**
- **Hyprland:** `hyprland_lock_notifier_v1` (push, `locked` after the lock frame is presented on every output)
  **[doc + machine]**.
- **KDE / GNOME:** `ScreenSaver.ActiveChanged` / `LockedHint`.
- **Generic fallback:** logind `Lock`/`Unlock` + `LockedHint`.
- **Shells:** on this machine `org.freedesktop.ScreenSaver` and `org.gnome.ScreenSaver` are both owned by DMS
  (`.dms-wrapped`), with `GetActive` + `ActiveChanged(b)` **[machine]**. Whatever owns that name defines its truth.
- `ext_session_lock_manager_v1` is exclusive: only one client may lock, so it is no use for detection.

**Monitor off (DPMS):** `zwlr_output_power_manager_v1` is advertised **[machine]**. `get_output_power(wl_output)`
pushes `mode(on|off)` per output. It is a clean "display asleep" trigger (WE has one). Hyprland's `j/monitors`
`dpmsStatus` too.

### 1.6 UPower / power profiles (system bus)

- `org.freedesktop.UPower` `/org/freedesktop/UPower`: **`OnBattery` (b)**, `LidIsClosed`, `LidIsPresent`, all via
  PropertiesChanged (push). Readable here **[machine: false/false/false]**.
- `/org/freedesktop/UPower/devices/DisplayDevice`: `Percentage`, `State`, `WarningLevel`, `IsPresent`, `Type` (0 =
  no battery here **[machine]**).
- Gotchas:
  - A desktop with a UPS can report `OnBattery` on a power cut; treat that as a feature.
  - Bluetooth peripherals are separate devices; ignore them.
- `net.hadess.PowerProfiles` / `org.freedesktop.UPower.PowerProfiles`: `ActiveProfile` (`balanced` here
  **[machine]**; `power-saver` makes a good "power saving" trigger, like Windows Energy Saver in WE/Lively).

### 1.7 PipeWire (stream identity and level)

**Discovery.** Registry globals, push (the player already has a connection):
- Nodes with `media.class=Stream/Output/Audio` are playback (count these).
- `Stream/Input/Audio` are captures. cava, the Quickshell spectrum and our own meters are captures; never count
  them **[machine]**.

**Identity on the Node** **[machine]**:
- Fields: `application.name`, `node.name`, `media.name`, `media.role`, `media.category`, `client.id`.
- Native libpipewire clients' nodes carry **no pid**. mpv's node has `application.id=mpv` and no
  `application.process.*`. Go through the **Client** object (`client.id`).

**Identity on the Client** **[machine]**:
- Fields: `application.name`, `application.process.binary`, `application.process.id`, `pipewire.sec.pid`,
  `pipewire.access`, `application.id`, `pipewire.access.portal.app_id` (Flatpak).
- **pipewire-pulse clients: `pipewire.sec.pid` = the pipewire-pulse server pid (2014 here).**
  `application.process.id` is self-reported. Native clients have `sec.pid` = their real pid (SO_PEERCRED).
- Observed values:

| what | `application.name` | binary | notes |
|---|---|---|---|
| vesktop | `vesktop` | `electron` | |
| Opera | `Chromium input` | `opera` | |
| Steam | `Steam`, `Steam Voice Settings` | `steam` | `application.id=org.valvesoftware.steam` on one client |
| KDE notifications | `libcanberra` | `.kded6-wrapped` | `application.id=org.freedesktop.libcanberra` |
| our player | `liascape-player` | `liascape-player`, or `liascape-scene-worker` for the scene | |

- NixOS wrapper names: strip a leading `.` and a trailing `-wrapped`.
- Flatpak: `application.process.id` is the sandbox's pid namespace. Match `pipewire.access.portal.app_id`.

**Level.** PipeWire publishes no level property; you must meter.
- The existing `sysmon.rs` pattern does it: a passive capture stream with `target.object=<serial>`,
  `node.dont-reconnect`, `node.dont-fallback`.
- Cheap pre-filter: the node's `state` (`running` vs `idle`/`suspended`). A corked or paused pulse stream goes idle,
  so only meter running nodes, or meter all and skip zero buffers.
- The node `Props` param carries `mute`, `channelVolumes`, `softVolumes`, which helps decide "muted counts as
  silent". Whether a capture of an output stream is post-stream-volume is **[belief: yes, the volume is applied in
  the stream's audioconvert before its output ports]**; Task 14 already plans to test it.
- Skip `node.virtual` / loopback halves (existing `admit()`) and filter-chain or EasyEffects nodes.
  EasyEffects is a client (`.easyeffects-wrapped`) **[machine]**.

**Roles.**
- PipeWire `media.role` values: Movie, Music, Camera, Screen, Communication, Game, Notification, DSP, Production,
  Accessibility, Test. PulseAudio values: video, music, game, event, phone, animation, production, a11y, test.
- Our nodes say `Wallpaper` **[machine]**.
- `Notification`/`event`, `Communication`/`phone`, `Accessibility`/`a11y`, `Test` are natural default exceptions
  for auto-mute.
- `Game` is a weak "a game is running" hint.

**MPRIS** (Task 14): `org.mpris.MediaPlayer2.*` on the session bus.
- **Exclude `org.mpris.MediaPlayer2.playerctld`.** It is a proxy that mirrors another player, so counting it double
  counts **[machine: present]**.
- Chromium registers `...chromium.instance<pid>` where pid = the browser main process (72290) **[machine]**.
- mpv: `...mpv.instance-<rand>` (mpv-mpris).

### 1.8 Games

| source | API | push? | identity | gotchas |
|---|---|---|---|---|
| **Feral GameMode** | session bus `com.feralinteractive.GameMode` `/com/feralinteractive/GameMode`: `ClientCount` (i, **emits-change**), signals `GameRegistered(i pid, o path)` / `GameUnregistered`, `ListGames() → a(io)`, `QueryStatusByPID` **[machine]** | push | pid | Only games run through `gamemoderun` / Lutris / Heroic, or with Steam's launch option. `gamemoded` runs per user (it was running here) **[machine]**. The registered pid may be a wrapper. |
| **Steam reaper** | process `reaper` with cmdline `SteamLaunch AppId=<N> -- …` **[belief, matches the DRAFT]**; game processes carry env `SteamAppId` / `SteamGameId` (`/proc/<pid>/environ`, readable for own uid) | proc events (§1.9) or a poll | AppId, pid tree | Exclude the Steam client itself: `steam`, `steamwebhelper`, `pressure-vessel-*`, `srt-*`, `steam-runtime-*`. On this machine the Steam client is in `app-steam@autostart.service` **[machine]**. No reaper was running at check time. |
| **Proton window class** | XWayland `class` = `steam_app_<N>` (Hyprland/Sway IPC, wlr-ft `app_id`) **[doc: common Hyprland windowrules]**; umu: `GAMEID=umu-<N>` gives the same class (owner memory) | push (window events) | AppId | Steam Big Picture can't be told apart by class. Proton's Wayland driver may change the app_id. Some games show `steam_app_default`. |
| **Steam registry.vdf** | `~/.steam/registry.vdf` `HKCU/Software/Valve/Steam/RunningAppID` **[belief]**, inotify-able | push (inotify) | AppId | The key was **absent** with no game running **[machine]**, so whether Linux Steam writes it on launch is unverified. The file also holds account-related keys: parse narrowly, never log it. |
| **gamescope** | process `gamescope`; nested window `app_id`/class `gamescope` | proc events | pid | In Deck-style gamescope-session, gamescope *is* the compositor: no layer-shell, no liascape. |
| **content-type** | Hyprland `j/clients` `contentType` (`game` when the app sets `wp_content_type_v1`) **[machine: field exists, all `none` now]** | re-query on window events | window | Few apps set it. Treat it as a bonus signal. |
| **audio role** | PipeWire `media.role=Game` | push | stream | Rarely set. |
| **Lutris / Heroic / Bottles** | children of `lutris`, `heroic`, `bottles`; wine processes (`wine*`, `*.exe` in cmdline, `wineserver`) | proc events | pid | `wineserver` also runs for non-games; it is noisy. |

### 1.9 Process start and exit

| approach | push? | privilege | gives | gotchas |
|---|---|---|---|---|
| **netlink proc connector** (`NETLINK_CONNECTOR`, group `CN_IDX_PROC`, `PROC_CN_MCAST_LISTEN`) | push (fork/exec/exit/comm…) | **none on this kernel** [machine: worked as uid 1000 on 7.1.3]. Older kernels (pre the 2023 cn_proc "allow non-root" series, ≈6.6) need CAP_NET_ADMIN, so fall back to polling | pid, tgid, ppid; exec has no name, so read `/proc/<pid>/comm`/`exe` at once | System-wide **flood**: 1128 messages in 1.5 s here. Lossy (`ENOBUFS` on overflow, so resync with a full `/proc` scan). Short-lived pids exit before you read them. The same series added event-type filtering; check the kernel uapi before relying on it. |
| **`/proc` poll** | poll (1–2 s) | none | everything | ~hundreds of dirents per scan, cheap. Read cmdline only for new pids. Latency = the interval. |
| **pidfd** (`pidfd_open` + poll for readability) | push, exit only | none (≥5.3) | the pid you track | Best for "this game exited" once it is known. |
| **systemd user manager** (`org.freedesktop.systemd1`, `UnitNew`/`UnitRemoved`, `Subscribe()`) | push | none | scope/unit name = desktop id + pid | Only apps launched through scopes (uwsm/app2unit here; KDE/GNOME launchers too). Games launched by Steam run inside Steam's unit, not their own. |
| **cgroup `cgroup.events` inotify** | push | none | "scope became empty" | Pairs with the above for exit. |
| fanotify / eBPF | push | CAP_SYS_ADMIN / CAP_BPF | — | Not for an unprivileged player. |

Recommendation input: proc connector when the bind + listen succeeds, else a 1–2 s `/proc` poll. On top of either,
match name / cmdline / scope against the rule's app.

---

## 2. Mapping a Wayland window to a process

| compositor | window → pid |
|---|---|
| Hyprland | `j/clients.pid` directly. wlr/ext handle → address via `hyprland_toplevel_mapping_manager_v1`, then pid. |
| Sway | the container's `pid` |
| niri | `Window.pid` (nullable) |
| KDE | plasma-window-management `pid` (restricted), or a KWin script's `window.pid` |
| wlr-ft / ext-list only (labwc, river, Wayfire…) | **no pid**. Only `app_id`, matched heuristically (below). |

**app_id ↔ process heuristics**, in order of reliability:
1. **systemd scope**: `/proc/<pid>/cgroup` → `app-<desktop-id>[@…]-<n>.scope|service` **[machine]**. The desktop id is
   usually the app_id (`org.chromium.Chromium` for Opera here, while its Wayland class is `Opera GX`, so it can
   differ).
2. **Flatpak**: app_id = the Flatpak id; `/proc/<pid>/root/.flatpak-info`.
3. **The `.desktop` file**: `StartupWMClass` / file name ↔ app_id, `Exec` → binary.
4. **The binary name**: `/proc/<pid>/exe` basename and `comm`. Normalize NixOS `.x-wrapped`. Electron apps resolve
   to `electron`, so prefer the cmdline (`--app-path`/asar) or the scope.
5. **XWayland**: app_id = WM_CLASS. Proton = `steam_app_N`.

**Gotchas:**
- The window's pid is the process that owns the Wayland connection. Audio and work are often in children (Chromium,
  Electron, Firefox content processes). Opera audio pid 73002 → ppid 72290 = the window pid **[machine]**.
- Use **same-scope** or **ancestor walk** to say "the same app"; never equal pids.
- Wrapper launchers (Steam reaper → pressure-vessel → game, umu, gamescope) put the window pid deep in a tree.

---

## 3. What users want: prior art

### Wallpaper Engine (Windows) **[doc + forum; exact labels per version unverified]**

**Global "Playback" settings**, each one Keep running / Mute / Pause / Stop (free memory):
- Other application focused, maximized, fullscreen.
- Other application playing audio (Keep running / Mute).
- Displays asleep.
- Laptop on battery.

**Application rules** (Settings → Performance → Application rules):
- Pick an `.exe` from the running list.
- **Condition:** Is running / Is focused / Is maximized / Is fullscreen / Is playing audio.
- **Action:** Keep running / Mute / Pause / Stop (free memory).

**How rules are used:**
- Mostly as **exceptions**. The documented fix for "WE mutes while I record or voice-chat" is a rule
  `<app> Is playing audio → Keep running`.
- A fullscreen overlay app gets `explorer.exe Is fullscreen → Keep running`.
- Users report the playing-audio detector catching visualisers and recorders. Windows can't tell capture from
  playback; PipeWire can (§1.7).
- Users report `Pause` on fullscreen misbehaving; the developers suggest `Stop`.

**Other WE features users mention:**
- Pause per monitor vs all monitors.
- Screensaver mode.
- Hardware RGB integration (iCUE / Chroma) driven by the wallpaper.

### Lively (Windows) **[belief]**

- Per-app rules: Pause / Ignore / Kill.
- "Pause on battery" and "pause on power saving".
- "Pause on remote desktop".
- Per-screen vs all-screens pause.

### Linux tools

**mpvpaper** **[doc: man page]**:
- `--auto-pause` / `--auto-stop`: "hidden" = the compositor stops sending frame callbacks. The man page calls this
  "at best a hack". On Sway it means a fullscreen window in front.
- `--auto-mode FULL|MAX`.
- `~/.config/mpvpaper/pauselist` / `stoplist`: program names, checked with `pidof`. This is the "app is running"
  rule, by name.
- The mpv IPC socket for scripting.

**linux-wallpaperengine** **[doc: README]**:
- Auto-mute when other apps play audio (`--noautomute` turns it off).
- `--no-fullscreen-pause`.
- `--fullscreen-pause-only-active` (Wayland).
- `--fullscreen-pause-ignore-appid <substr>` (repeatable): the exception-list pattern.

**swww, hyprpaper:** IPC only, no rules or hooks. They are driven by user scripts.

**waypaper, wpaperd** **[belief]**:
- waypaper has a `post_command` config hook after a wallpaper is set.
- wpaperd has an `exec` hook given the output + path.

**Komorebi:** none of this **[belief]**.

**Hidamari / Hanabi (GNOME)** **[belief]**: pause on maximized / fullscreen, mute on other audio.

### What r/unixporn-style scripts do that WE doesn't

- **Theme generation on change:** `wal -i` / `matugen image` / `wallust` after every wallpaper change, so the bar,
  terminal and GTK recolour. A "wallpaper started" action needs **variables**: path, a **still frame /
  thumbnail path** for video and scene, output name, wallpaper id/title.
- **Per-workspace wallpaper:** a Hyprland `workspacev2` event → switch wallpaper or playlist.
- **Time of day / sunrise–sunset / weather:** a timed or solar trigger (geoclue).
- **Music sync:** an MPRIS track change → wallpaper / accent change (the owner already runs a "song-accent" daemon,
  Spotify art → accent).
- **Screen sharing → privacy:** switch to a safe wallpaper or pause while `screencast` is active (Hyprland socket2
  `screencast`, or PipeWire screencast nodes).
- **Idle → screensaver wallpaper**, **DPMS off → stop**, **battery low → static image**, **power-saver profile →
  pause**.
- **Lock → hand a frozen frame to hyprlock** (blurred background), or a dedicated lock wallpaper.
- **High GPU temperature / load → pause** (nvidia-smi / hwmon poll); VRAM pressure (the player already has a VRAM
  hold).
- **OpenRGB / keyboard colours** from the wallpaper palette (the owner runs OpenRGB).
- **Do-not-disturb / focus mode** (the shells expose DND) → mute.

### Implication for the "run shell command" action

- Run it detached from the player's cgroup (`systemd-run --user --scope` or a double fork + `setsid`). If it isn't,
  a player restart kills it, and dev unit restarts kill the player's whole cgroup.
- Pass `LIASCAPE_*` env vars (event, output, wallpaper path, frame path, app that triggered).
- Debounce it.
- Never inherit the player's fds.

---

## 4. Default exception catalogues

The match keys are app_id / WM_CLASS, the binary (normalized: drop a leading `.` and a trailing `-wrapped`), the
PipeWire `application.name` / `application.id`, and `media.role`. Prefer role-based exceptions where they apply.

### 4.1 Never trigger auto-mute (or "app is playing audio")

- **By role (generic):** `media.role` ∈ {`Notification`, `event`, `Communication`, `phone`, `Accessibility`,
  `a11y`, `Test`}; `media.category` ∈ {`Capture`, `Monitor`} (captures).
- **Captures by class:** any `Stream/Input/Audio`.

**Voice chat:**
- Discord family: `discord`, `Discord`, `vesktop` (binary `electron`), `WebCord`, `legcord` / `armcord`, `dorion`,
  `goofcord`. Discord's voice engine stream: `application.name` "WEBRTC VoiceEngine" **[belief]**.
- Matrix and messengers: `element-desktop` / `Element`, `nheko`, `fractal`, `signal-desktop`,
  `org.telegram.desktop` / `telegram-desktop` (running here **[machine]**).
- `mumble` / `info.mumble.Mumble`.
- TeamSpeak: `ts3client_linux_amd64` / `TeamSpeak 3`, `TeamSpeak`.
- Meetings: `zoom`, `teams-for-linux`, `slack`, `skypeforlinux`, `jitsi-meet`.
- SIP: `linphone`, `baresip`.
- Steam voice: `Steam Voice Settings` **[machine]**.

**Recorders, streamers and audio plumbing:**
- Recorders and streamers: `obs` / `com.obsproject.Studio`, `gpu-screen-recorder`, `wf-recorder`, `kooha`,
  `simplescreenrecorder`, `vokoscreenNG`, `peek`.
- Audio plumbing: `easyeffects` / `com.github.wwmm.easyeffects`, `noisetorch`, `carla`, `qpwgraph`, `helvum`,
  `pw-loopback`.
- VR and streaming bridges: `wivrn` (the owner uses it), `alvr`.

**Notification and event sound sources:**
- Notification daemons and shells: `canberra-gtk-play`, `libcanberra` / `org.freedesktop.libcanberra`,
  `dunst`, `mako`, `swaync`, `fnott`, `xfce4-notifyd`, `notify-osd`, `quickshell` / `qs`, `dms`, `noctalia`,
  `ags`, `astal`.
- Desktop shells: `gnome-shell`, `plasmashell`, `kded6` / `kded5` (KNotification, **[machine]**), `knotify5`.
- Phone and system: `kdeconnectd`, `xdg-desktop-portal*`, `speech-dispatcher` (`sd_*`), `orca`.

**Our own:** by ownership, never by name (Task 14). Our nodes carry `media.role=Wallpaper` **[machine]**.

**Gray zone (the owner decides):**
- `Steam` client sounds.
- `paplay` / `pw-play`: used by notification scripts and by real playback alike.
- `mpv`: the user's own playback; the owner confirmed it should mute.
- Games: should a game's audio mute the wallpaper when the game rule already pauses it? The DRAFT warns about
  double-counting.

### 4.2 Never count as covering

Layer-shell surfaces are excluded by construction. That covers waybar, eww, ags/astal, quickshell / DMS / Noctalia
(`dms:bar`, `dms:dock`, `noctalia-*` **[machine]**), hyprpanel, nwg-dock, rofi(-wayland), wofi, fuzzel, anyrun,
walker, wlogout, hyprlock, swaylock, hyprpicker, slurp, wvkbd, wayland-bongocat and conky on Wayland. List them
only for the KDE / XWayland cases.

Toplevels that need an exception:
- **Fullscreen capture and annotation tools:**
  - `flameshot`: a fullscreen toplevel on Wayland; running here **[machine]**.
  - `org.kde.spectacle` (region mode), `ksnip`, `com.gabm.satty` / `satty`, `swappy`.
- **Invisible helpers:** `xwaylandvideobridge`, portal share pickers (`hyprland-share-picker`).
- **XWayland docks and panels** (toplevels under XWayland): `plank`, `cairo-dock`, `latte-dock`, `xfce4-panel`,
  `tint2`, `polybar`.
- **Desktop pets and overlays:** `Shijima-Qt` / shimeji-ee (java), `oneko`, `xpenguins`, `xeyes`, `livecaptions` /
  `net.sapples.LiveCaptions`, `onboard`, `squeekboard`. MangoHud and the Steam overlay are in-process: no window,
  nothing to exclude.
- **Launchers that are toplevels:** `ulauncher`, `krunner`.
- **Picture-in-picture:** title `Picture-in-Picture` / `Picture in picture` (Firefox / Chromium). It is small and
  floating, so it never reaches the threshold, but a "focused" or "maximized" rule might.
- **The liascape app itself** (`liascape` class **[machine]**).
- **Rule:** a toplevel only covers an output when it is fullscreen/maximized **and** opaque. Hyprland window
  opacity rules (the owner uses opacity overrides) can make a fullscreen window see-through. That is an edge case:
  expose it as an exception, don't detect it.

---

## 5. On-machine snapshot, for reference

- **Wayland globals** (from `WAYLAND_DEBUG` of a client) include:
  - window state: `zwlr_foreign_toplevel_manager_v1`, `ext_foreign_toplevel_list_v1`,
    `hyprland_toplevel_mapping_manager_v1`, `ext_workspace_manager_v1`;
  - lock and idle: `hyprland_lock_notifier_v1`, `ext_idle_notifier_v1`, `ext_session_lock_manager_v1`;
  - outputs: `zwlr_output_power_manager_v1`, `wp_content_type_manager_v1`, `zwlr_layer_shell_v1`;
  - capture: `ext_image_copy_capture_manager_v1`, `hyprland_toplevel_export_manager_v1`.
- **`hyprctl -j clients`:** a kitty maximized (`fullscreen: 1`) on workspace 7 / DP-2; DP-1 showing an empty
  workspace 1. With the default mode (`maximized`), DP-2 counts as covered now and DP-1 doesn't, so the wallpaper
  keeps playing (correct per plan call 9).
- **Session bus:** `com.feralinteractive.GameMode`, `org.freedesktop.ScreenSaver` (DMS), `org.freedesktop.Notifications`
  (quickshell), `org.mpris.MediaPlayer2.{chromium.instance72290, mpv.instance-…, playerctld}`,
  `com.steampowered.PressureVessel.LaunchAlongsideSteam`.
- **System bus:** `org.freedesktop.UPower`, `net.hadess.PowerProfiles`, `org.freedesktop.login1`.

## Sources

- Hyprland IPC events: https://wiki.hypr.land/0.56.0/IPC/
- hyprland-toplevel-mapping-v1: https://wayland.app/protocols/hyprland-toplevel-mapping-v1
- hyprland-lock-notify-v1: https://wayland.app/protocols/hyprland-lock-notify-v1
- wlr-foreign-toplevel support matrix: https://wayland.app/protocols/wlr-foreign-toplevel-management-unstable-v1
- ext-foreign-toplevel-list: https://wayland.app/protocols/ext-foreign-toplevel-list-v1
- niri IPC `Window`: https://niri-wm.github.io/niri/niri_ipc/struct.Window.html, events: https://niri-wm.github.io/niri/niri_ipc/enum.Event.html
- KWin restricted interfaces: https://mail.kde.org/pipermail/kwin/2024-January/005306.html, https://invent.kde.org/plasma/plasma-workspace/-/merge_requests/1240, https://mail.kde.org/pipermail/kwin/2019-July/000625.html
- cn_proc unprivileged: https://lkml.iu.edu/hypermail/linux/kernel/2304.2/05965.html
- WE application rules: https://help.wallpaperengine.io/en/functionality/applicationrules.html, https://help.wallpaperengine.io/en/performance/game.html, https://steamcommunity.com/app/431960/discussions/2/1635237606658635767
- mpvpaper: https://manpages.opensuse.org/Tumbleweed/mpvpaper/mpvpaper.1.en.html
- linux-wallpaperengine flags: https://github.com/Almamu/linux-wallpaperengine (README)
