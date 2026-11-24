# Multi-monitor — design

Status: agreed with the owner in conversation on 2026-11-17, pending their read of this document. Implements the
"Multi-monitor management" item of `docs/TODO.md` § Ready-to-do backlog. The owner's bar: Liascape isn't ready for the
public eye until this is done well. The owner's own words where quoted; everything else here is the agreed design or
marked as the writer's call.

## Intent
People with two or more screens set multi-monitor up once — a playlist per screen, or the same thing everywhere — and
rarely come back to it ("they just put a playlist on them and rarely open it"). So the design must:
- cost single-screen users nothing and two-screen users almost nothing day to day;
- always show where an action will land (the main failure of multi-monitor wallpaper apps: you apply and get surprised);
- keep the app's existing rules: a plain click applies, right-click opens the item sidebar, no item menus
  (`docs/decisions.md` § "Left click does the tab's main action, right click opens the item sidebar").

## Goals
- Show a different wallpaper or playlist per screen, the same one on all, or one picture spanned across all.
- A visible "current screen" context in the top bar that decides where Library actions and the playlist bar act.
- Per-screen settings: FPS, volume/mute, speed, fit, scenes allowed, scene FPS; adding screens; arranging them.
- Keybinds / CLI that work sensibly with several screens.
- Screens remembered across replugs and restarts.

## Non-goals
- Changing the compositor's real monitor layout (Hyprland/KDE config). Arranging screens in Liascape only changes
  Liascape's own picture of the layout ("definitely just how liascape views it").
- Per-screen copies of settings a playlist already owns (order, max play time, "switch scenes and pictures after",
  resume / start over, transitions). A screen picks which playlist it runs; it doesn't override playlist settings.
- Adding or removing compositor outputs (Liascape never does).

## Anti-goals (would make it a failure even if it works)
- A click that lands somewhere the UI didn't show.
- A big permanent panel or strip eating the top of the app.
- Item context menus.
- Single-screen users seeing multi-monitor controls they can't use.

## Approaches considered
1. **Display-map strip above Library/Browse** (the first mockup): screens laid out as a map, a mode switch,
   target pills. Rejected: takes a lot of vertical space for something set up once.
2. **Screens button + popover** holding everything (map, modes, per-screen settings, "actions reach" rule). Rejected
   as the main surface: a hidden rule decides where clicks land, so the UI doesn't show the target. Kept as the
   per-screen settings surface (below).
3. **Top-bar screen carousel as a visible context** (owner's idea, picked): a chip showing one screen's live preview
   and name, arrows to switch between screens and "All". The selected entry is where Library actions and the
   playlist bar act. Chosen because the target is always visible, it is small, and it collapses to a "now playing"
   chip for one screen.

## The design

### Top bar
- The status line leaves the top bar (see "Status and feedback"); the screen carousel takes its space.
- Carousel: `‹ [live preview + name] ›`; entries are each enabled screen, in Liascape's arrangement order, then **All**.
  Mouse wheel and arrow keys cycle too; dots under it show the position. The All entry shows the screens side by side.
- One screen: no arrows, no All — just the preview chip (a calm "now playing").
- Clicking the preview opens that screen's settings popover (below); on All, the All settings (span toggle, keybind
  reach, which screens follow All).
- If the selected screen is unplugged, the carousel moves to All.

### Screens follow All until given their own
- Each screen is in one of two states: **following All**, or **own** (its own wallpaper and/or playlist).
- **The most recent action wins:**
  - Apply / Play while on a screen → that screen becomes **own**; other screens unchanged.
  - Apply / Play while on **All** → every screen rejoins All (its playlist choice becomes "Follow All"). No undo:
    it's low stakes, and picking a screen's playlist again is one click in its popover.
- The All entry shows who follows it ("Left follows All · Right has its own").
- **Defaults:** every screen follows All (= "same wallpaper on each screen, each shown whole — not spanned"); keybind
  reach = All screens (owner's choices).
- **Span**: a toggle on All — "Show as one picture across the screens" — the All wallpaper drawn across the screens
  by Liascape's arrangement. Fit: fill (crop) / fit (bars) / stretch.

### Playlist bar (Library)
- Shows the playlist of the carousel's selection: a screen's own playlist, or the All playlist. Editing edits that
  one; Play starts it on that selection (with the "most recent action wins" rule).
- Save / Load / Playlist settings work on the shown playlist as today.
- The All playlist's rotation advances only screens following All; an own screen runs its own timer.

### Library cards
- The playing ring marks what plays on the carousel's selection (on All: what the All followers play).
- A plain click applies to the selection (most-recent-wins). No new modifier clicks are required by this design.

### Per-screen settings popover (from the carousel's preview)
- Name (rename), fit, FPS cap, volume + mute, speed, scenes allowed on this screen, scene FPS.
- Its own playlist (pick a saved one) or "Follow All".
- Screen arrangement: drag the screens (above / below / left / right) — Liascape's view only, used for the carousel
  order, the All preview and span. Default arrangement read from the compositor where it can tell us.
- Every connected screen is used at once (Liascape discovers them itself; no "+ Add"). This replaces Settings' current
  "Scene monitors" section (monitor list + per-monitor fps + Add / Remove). Writer's call: a "Don't use this screen"
  switch per screen (e.g. a TV), so the compositor's own background stays there.
- On All: the span toggle, keybind reach, the follow list, and **sound**: a sortable priority list, like the card
  preview order in Settings — "Only <screen>" per screen, "All screens", "Loudest"; the top entry that applies wins (an
  "Only <screen>" entry is passed over while that screen is off, unplugged, or its wallpaper has no sound). Default:
  the primary / first screen at the top. Only matters once screens play different things.

### Keybinds and CLI
- Keybinds fire with the app closed, so they don't follow the carousel. A rule on All's popover:
  **Keybinds act on: All screens (default) / The focused screen / The screen picked in the app.**
  - "The focused screen" is offered only where Liascape can ask the compositor (e.g. Hyprland / Sway IPC); elsewhere
    it isn't shown.
- `next` / `previous` advance each targeted screen within what it runs (followers together on the All playlist,
  own screens on their own).
- Every command takes `--screen <name|connector|focused|all>` to override the rule (bind Super+1 → Left's next, …).

### Hotplug and identity
- Screens are remembered by make + model + connector, and the serial where the monitor reports one (two monitors of
  the same model can't be told apart by make + model alone).
- A screen seen before gets its own setup back; a new screen is used at once, following All; an unplugged screen's
  setup is kept for its return.

### Status and feedback (moves out of the top bar)
- Library: the status / now-playing line moves into the playlist bar's header, between its buttons and Play. With
  several screens it reads per screen ("Left · Tidal Glass · Right · Sakura Night Train").
- Other tabs have no status line; their messages move next to what they're about:
  - Browse download progress / results: already on the card and in the sidebar; failed card = its error + Retry; a
    failed search shows its reason in the grid.
  - Steam sign-in errors → the sign-in window; Steam to-do errors → the to-do panel.
  - Settings results ("Cache cleared — freed 340 MB", "Settings / Library cleared", loudness done) → beside the
    button that did it, briefly.
  - Real failures keep the existing error modal.

## Decisions from the builder check (owner's answers marked; the rest are the writer's calls)
- **Scene monitors (writer):** Settings' "Scene monitors" section (per-output scene fps) stays until this work replaces it
  with the per-screen settings.
- **How per-screen values combine (owner):** specificity wins, nothing multiplies — the wallpaper's own value > the
  screen's > the global, for volume, speed, fit and FPS. A wallpaper's own settings (its volume, speed, scene
  properties) are either the same on every screen or set per screen — a choice in the item sidebar; per screen adds
  one more level on top: this wallpaper on this screen > this wallpaper > the screen > global. A spanned picture uses
  All's values. All live (CLAUDE.md hard rule).
- **A follower's volume, speed and frame-rate cap (owner, 2026-11-18):** screens following All share one decoded
  source (that's what keeps them in sync and costs about one screen), so a follower uses All's values; those popover
  rows are disabled with the reason until the screen has its own wallpaper. Fit stays per screen.
- **Scenes off on a screen that follows All (owner):** a desync is worse than a missing scene, so while any follower
  has scenes off, All plays no scenes: All's rotation skips scenes and applying a scene on All is disabled with the
  reason ("Left doesn't allow scenes"). On that screen alone (own), scenes are simply not offered. The global "Allow
  scenes" (import and play) stays; the per-screen switch only narrows it.
- **Span with screens that have their own setup (writer):** the spanned picture covers only the screens following All, by
  Liascape's arrangement.

## Constraints
- liascape-player already has per-output layers, per-output transitions, hotplug adoption, and shares one scene worker
  / one decoder between outputs showing the same thing (so "follow All" costs about one screen).
- Today the C# adapter sends everything to `out:*` (`src/backend/Player/LiascapePlayerMedia.cs`) and rotation is one
  program `prog:main` on all outputs (`src/backend/Player/LiascapePlayerProgram.cs`): per-screen state, per-screen
  programs and span are new work in the backend and the player.
- Settings apply live, features compose, UI design checklist (`CLAUDE.md` hard rules, `.claude/rules/ui/design.md`).
- Pre-release: no migration of old settings needed (the old "Scene monitors" list may simply be replaced).

## Left to the builder
- Data model for per-screen state (follower / own, its playlist, its settings); API shape between UI, backend and player; how
  span is drawn in the player.
- Popover layout details, animation (UI design checklist), the exact carousel visuals.
- How the default arrangement is read per compositor, and the IPC for "focused screen".
- Test plan (probes for the carousel, most-recent-wins, hotplug; player tests for per-output programs and span).
- Splitting the work into steps (e.g. 1: per-screen state + carousel + per-screen apply; 2: per-screen playlists;
  3: popover settings; 4: span; 5: keybind rule + `--screen`; 6: status-line move).
