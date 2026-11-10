# Wallpaper Engine-style sidebar (Library + Browse) — design

Owner, 2026-11-10: "reworking ui to be more like wallpaper engine since thats what works for this format. so instead of a
settings menu when clicking right click and settings, it should open a sidebar when you focus a card and thats what has
all the 4 options from the right click menu. same for the browse tab".

The owner was asleep; every judgement call below was made against Wallpaper Engine's own UI (its shipped `ui/dist`
templates and `locale/ui_en-us.json`: a details panel on the right — title, preview, author / type / rating / file size,
Unsubscribe + Workshop buttons, then "Properties" — next to a grid where a click applies the wallpaper, plus a right-click
context menu that stays: Add to playlist, Open in Workshop, Unsubscribe, …). They are listed at the end.

## What replaces what

| Today | After |
|---|---|
| Library right-click → menu → "Settings (volume / speed)" → centred modal morphing out of the card (`CardSettingsModal`) | Focusing a card opens the **Library sidebar** on the right: everything the modal had + the menu's three other actions |
| Playlist bar right-click → "Settings (volume / speed)" → the same modal, morphing out of the bar item | "Settings" in the bar's menu focuses that item in the Library sidebar |
| Browse click = download & apply; right-click = preview modal (`PreviewModal`) | Browse click (or right-click) focuses the card → the **Browse sidebar** (the preview modal's contents + actions); double-click / Enter / the sidebar's button = download & apply |

`CardSettingsModal.tsx`, `PreviewModal.tsx` and `useMorph`'s flight go away (the WAAPI flight code stays in git history,
last in `c87376bb`).

## Focus

- **Library.** Plain click = focus + apply (WE applies on click; it was already apply). Ctrl/Shift-click = selection as
  today, and the clicked card takes focus. Right-click = the context menu at the cursor, as before (WE keeps its context
  menu next to its details panel): its **Settings** now opens the sidebar on that card (no apply), then Open in file
  manager, Delete, Delete from source. With the sidebar already open, a right-click also moves it to that card. (First
  built as "right-click = focus + menu": the docked sidebar opening re-fitted the grid and slid the card out from under the
  menu and the pointer — the matrix's `hoverPreview:rightClick:card` caught it — so a right-click no longer opens it.)
- **Browse.** Click / right-click = focus (nothing downloads). Double-click = download & apply. Middle-click unchanged
  (open the source page / folder). The hover download glyph (it said "click downloads") becomes a small real download
  button in the card's corner (same place as the Library card's trash).
- **Keyboard** (both grids, when no field / slider / menu / popover has the keys): ←/→ = previous / next card, ↑/↓ = a row
  up / down (the grid's `--cols`); the first arrow with nothing focused focuses the playing card (Library) or the first
  card. Enter = apply (Library) / download & apply (Browse). Escape = close the sidebar (and clear a selection). The
  focused card scrolls into view (`block: nearest`) and carries `.focused` (an accent ring offset from the card, distinct
  from the selection's outline).
- **State** lives in the store: `libFocus` (item path) and `browseFocus` (page URL) — they survive a tab switch; a focused
  Browse item that leaves the list (source switch, search) closes its sidebar; a focused Library item that is trashed
  closes it. The sidebar always resolves its item from the live lists, so `library-item-changed` updates it in place.
- **Identity rule** (the 2026-11-10 morph-replay bug): everything per-open (the duration fetch, the scene properties, the
  trailer, the content cross-fade, the picture's layers) keys on the item's path / page URL, never on the item object.

## Layout

- The sidebar is an `<aside class="side-panel" data-side="library|browse">` beside the page, from the top bar's bottom
  (`--topbar-h`, measured by App with a ResizeObserver — the top bar wraps on narrow windows) to the window's bottom.
  Width `--side-w` = `clamp(300px, 26vw, 400px)`.
- **Docked (window ≥ 900 px wide):** the grid (`.scroll`) and the playlist bar end at the sidebar's left edge (`margin-right`
  / `right: var(--side-w)` while it's open). The grid re-fits its columns (useGridFit's ResizeObserver).
- **Overlay (< 900 px):** the sidebar floats over the page (`min(360px, 100vw)`), a scrim over the rest closes it on a click.
- It scrolls on its own (`overflow-y: auto`), so it fits any height down to 430 px; the close button is in a sticky head.
- Translucency: `--tr-strong` like the other panels; no backdrop-filter. Glow: the accent edge is a static `var(--glow-sm)`
  shadow (the `no-glow` block covers it).

## Motion

- Open (closed → open): the panel slides in 24 px + fades (transform + opacity, 220 ms ease-out, no fill). Close: slides
  out (160 ms) then unmounts (a timer, never an animation-end event). Item switch while open: the content cross-fades
  (opacity, 140 ms). `:root.no-motion` (the "Smooth window animations" toggle off, or the OS's reduced motion) → it
  appears / leaves / switches at once.
- **The card → modal morph is dropped** for the sidebar: the card stays in the grid (WE-like), so there is nothing to lift
  out, and a docked sidebar re-fits the grid at the moment it opens — the card a flight would leave from moves under it.

## Library sidebar contents (top → bottom)

1. Head: title (2 lines) + close. "applies to N selected" when the focused card is part of a multi-selection (volume /
   speed / delete repeat to the selection, as the modal's siblings did; scene properties only for a single scene).
2. Picture: the card's still → the sharp native image → the gif / video preview (the modal's layering), at the picture's
   own aspect (read from the card's loaded image at focus, else 16:9 until loaded), height capped (`min(38vh, 320px)`).
   YouTube trailer over it.
3. A state line: "Playing now" (+ "· looping this one" while `keepCurrent` — the loop-current keybind) for the playing
   item; SCENE; the crash warning.
4. Primary row: **Play** (disabled "Playing" when it plays) · **Add to playlist / In playlist**.
5. Meta: duration (row reserved before it loads), resolution, age rating, the scene loudness line + its note.
6. The three file actions (the old menu's): **Open in file manager**, **Delete**, **Delete from source** (Workshop items,
   auto-import off — as before).
7. Volume, Speed (scenes under legacy: hidden as before), crash whitelist.
8. Scene properties (`ScenePropsEditor`, `key={path}`).
9. Tags, Workshop ID (copy), Play YouTube, Open on Steam.

**Settings levels:** rows follow `settingsLevel` like Settings does: Volume, scene properties, the actions = Basic; Speed,
the loudness line, Workshop ID = Standard (Speed / loudness match their Settings rows' levels). A row hidden by the level
still shows when this item has its own value for it (a speed override) — hiding never hides a changed value.

**No pop-in:** the body under the picture is held invisible until its asynchronous sections are in (a scene: its
properties; ≤ 450 ms, then it shows whatever it has), then fades in once; the duration row is reserved; scene properties
are cached per path for the session, so a revisit is instant. Sections never appear above content the user already sees.

## Browse sidebar contents

1. Head: title + close. 2. Picture: the card's still → full-res (`api.detail` → `previewUrl`, fades in once loaded) → the
gif (the card's `/anim` URL), YouTube over it. 3. **In library** (`data-in-library`): "In your library" + **Show in
Library** (switches to Library with that item focused) — the badge's info. 4. Primary: **Download & Apply** (accent; an
in-library item: **Apply**, the library copy), **Download** (no apply); while downloading: the progress + Cancel.
5. Meta: resolution, subscriptions, favourites, views, size, author, SCENE. 6. Description, tags. 7. Play YouTube, Open
on Steam / Open page (the middle-click target), Copy ID.

## Other effects

- `autoplay.ts` no longer pauses grid video autoplay "while a settings modal is open" (the grid stays visible); App's
  `body.modal-open` gif freeze goes (it was for the opaque modals).
- `travelToPlaying.ts` is untouched (it centres the playing card once per session; the sidebar is closed at app start).
- The tab slide keeps animating `.scroll`; the sidebar has its own entrance.

## Tests

- New `app/shell/probe-sidebar.js` (`scripts/test-ui-matrix.sh --probe probe-sidebar.js`) — replaces `probe-morph.js`:
  click / right-click open, the actions (Open in file manager stubbed, Delete + Undo, Delete from source present),
  volume persisted, stays still on `library-item-changed`, keyboard (arrows, Enter, Escape), playlist bar "Settings",
  Browse (click doesn't download, double-click does, In library + Show in Library), settings levels, no pop-in for a
  scene, motion on / off / reduced. Written first, RED on the old UI.
- `probe-layout.js`: `resize:modal:*` → `resize:side:*` (at each of the 9 sizes: inside the window, close reachable,
  docked → the grid ends left of it, overlay → over the page) + screenshots.
- `probe-matrix.js`: the cells that opened the modal open the sidebar (right-click focus) and read its sliders.
