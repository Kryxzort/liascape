# Lumilia Rename — Plan

**Goal (owner, 2026-10-28):** rename the project to **Lumilia** "as if the code base was named lumilia from the
start" — every name derived from "livepaper" changes (functions, types, namespaces, files, env vars, paths, units,
packaging), and code names match the UI labels at the same time (one combined rename, one breakage round).

**When:** after the in-flight morph and rotation-redesign branches land on `lp-player`.

## Decisions

- **Name: NOT DECIDED.** "Lumilia" was dropped (2026-10-28): it is the full name of Lumi, the protagonist of the desktop
  game *Outcore* — too close to a desktop app. Candidates (free on AUR + GitHub): Emilight, Silvamilia, Frostmilia,
  Emiluna. Every "lumilia" below stands for the final name.
- **Command style: one command + subcommands** (git/cargo/podman style). Users only ever type `lumilia`:
  - `lumilia` — opens the app (GUI); `lumilia <action>` replaces `--action=…` (e.g. `lumilia next`, `lumilia volume up`);
    `lumilia restore`, `lumilia kill`, `lumilia random`; `lumilia ctl …` = the player's ctl (state/logs/probe).
  - The real executables live **off PATH** in `libexec/lumilia/` with short internal names: the C# backend
    (serve + daemons), the Rust compositor (was `lp-player`), the scene worker (was `lp-scene-worker`), the legacy
    helpers if still present. `lumilia` dispatches to them.
- **Code-to-UI names:** every identifier whose UI label differs is renamed to the label (e.g. advance-on-end → the
  rotation labels after the redesign, "strip" → playlist bar, "item modal" → card settings, `LweMonitors` → per-monitor
  scene fps). The agent first produces the UI-label ↔ code-name table, then renames.
- **Paths:** `~/.config/lumilia`, `~/.local/share/lumilia`, `$XDG_RUNTIME_DIR/lumilia`, dev units `lumilia-*`, env vars
  `LUMILIA_*` (was `LP_*`), Electron app id, window title, flake outputs/module, PKGBUILD, `install.sh`, docs and
  `.claude/rules`.
- **No migration code** (owner is the only user): a one-off script moves the owner's config/library/state and rewrites
  renamed keys, run once after merge with a backup.
- **History:** git history is not rewritten.

## Owner steps at the end

1. `/etc/nixos/livepaper.nix` → the new module/flake output (exact edit provided; never committed by Claude).
2. GitHub repo rename `livepaper-pro` → `lumilia` (asked separately — public; GitHub redirects the old URL).
3. The Noctalia todo / keybinds / Hyprland config that call `livepaper` (grep provided).
