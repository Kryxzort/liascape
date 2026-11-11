---
paths:
  - "app/ui/**"
  - "app/shell/**"
---

# Web UI (Electron + React)

React renderer over the headless C# backend (`web-backend.md`). Chosen via a bake-off (`demos/`):
Electron renders at display refresh (135–240fps measured); the frameworks tied on perf, so React won
for framer-motion's "cool" ceiling. See memory `web-frontend-rewrite-idea`.

## Layout
- **`app/ui`** — Vite + React 19 + TS. `src/api` (client + events), `src/store` (zustand),
  `src/views` (Browse/Library/Settings), `src/components`, `src/index.css` (theme vars + glow).
- **`app/shell`** — Electron: `main.js` spawns `liascape serve`, reads `serve.port`, loads the UI
  same-origin (`LIASCAPE_UI_DIR` → C# serves the dist). `probe.js` = headless self-test (offscreen window,
  counts rendered elements per tab — **use it to verify UI changes**, no GUI popup).

## API access
Same-origin: client `API=""` → relative `/sources` etc. (C# serves UI + API on one port). Browser
dev: append `?api=<port>`. Remote images **must** go through `img(url)` (`/img` proxy — UA/Referer/CORS);
local media via `media(path)` (`/media`). WS via `useEvents`.

## PERF rules (non-negotiable — the bench proved these)
- **`content-visibility:auto` + `contain-intrinsic-size`** on every grid card — skips offscreen
  render+decode. This is what makes a dense animated grid hit 135–240fps. Do not remove.
- **Per-card store selectors.** Cards are `memo`'d and read their *own* slice
  (`useStore(s => …)`), so flipping one card's state re-renders one card, not the whole grid.
  Never lift per-card state to a parent that re-renders the list.
- Stable keys (`pageUrl`/`videoPath`). WS events → targeted slice writes.
- Animate **transform/opacity/filter only**.

## Glow + motion (COOL — no compromise)
- All glow is **accent-driven** via `--accent` CSS var → every theme glows on-brand. Vars set in
  `store.applyThemeVars` from `/themes` (32 themes, ThemeService color keys).
- Glow = **static `box-shadow`/`drop-shadow` toggled by state** (hover/playing/selected), never
  animated blur radius (paint storms). Pulsing glow animates opacity/box-shadow on a composited layer.
- The item sidebar (Library + Browse, "Item sidebar" below) slides in / cross-fades / slides out on transform + opacity —
  the card → modal morphs it replaced are gone (2026-11-10; the WAAPI flight code is in git history, last in `c87376bb`).
  framer-motion: `AnimatePresence` enter/exit on other modals/toasts, spring drag (dnd-kit) on the playlist bar.
- Re-bench Browse/Library at ≥120 visible after glow/motion changes (the `demos/` harness still works).
- **Appearance toggles (Settings → Appearance; `AppSettings` `Glows` / `Morphs` / `AutoPlayVideoThumbs`, UI-only).**
  - **Glow effects** (`glows`, default on): off = `<html class="no-glow">` (App.tsx effect). `index.css`'s last block zeroes
    `--glow`/`--glow-sm` and overrides every hard-coded glow (the playing pulse, `dl-glow`, `glow-pulse`, drop-shadow hovers, the
    Settings corner pools / section edges, the Stop/danger glows, the keyboard-focus slider glow → an outline). The playlist bar's
    portal'd `.pl-hover-glow` isn't rendered. State that isn't glow stays (green playing ring, selected outline, accent borders).
    **A new glow = a `var(--glow*)` shadow, or add its override to that block.** Matrix `appear:glows` reads computed styles.
  - **Smooth window animations** (`morphs`, default on — the key keeps its old name): off = `<html class="no-motion">` (App.tsx),
    under which index.css stops the item sidebar's slide / cross-fade (it appears and leaves at once — its exit linger,
    `useLinger`, drops to a 0 ms timer), the tab slide and the playlist bar's dock lift (below). Other framer-motion modal
    enter/exit fades stay. Matrix `appear:morphs` (the sidebar from a card and from the bar: on = transform/opacity animations,
    off = none, closes ≤ 100 ms, also after a reload). **The OS's `prefers-reduced-motion: reduce` counts as off** (2026-11-10):
    read it through `useMotion()` (`components/motion.ts` — the toggle AND the media query, live) in components,
    `motionOn(settings)` outside React; never `settings.morphs` directly.
  - **Autoplay video thumbnails** (`autoPlayVideoThumbs`, default off): `components/autoplay.ts` `useAutoplayVideo` — a library
    card / playlist-bar item with only a video preview (`hasVideoPreview`: no gif/webp, not a scene) mounts MotionThumb's hover
    `<video>` without a hover. Only on-screen items (IntersectionObserver), at most `AUTOPLAY_VIDEO_CAP` = 4 at once across cards +
    bar (a queue hands out freed slots), none while `!appActive`; a hovered item plays on top of the cap. The item sidebar
    doesn't pause them (the grid stays in view beside it — the old modal covered it). Gif items stay under "Autoplay GIF thumbnails". Browse cards have no video preview (remote sources ship a gif or
    nothing), so they're unaffected. Matrix `appear:videoThumbs`.

## Icons + component patterns (parity-polish pass)
- **Icons = `lucide-react`**, never emoji. Size 14–16px, `fill/stroke=currentColor` so theme
  accent/danger + glow flow through. Helper class `.ico` (inline-flex, gap) for icon+label buttons;
  `.mini` already centers an icon-only button. Probe asserts `svg.lucide` count + `emojiInBody==false`.
- **The item sidebar's focus is in the store** (`libFocus` / `browseFocus`, `focusLib` / `focusBrowse`): Library cards, the
  playlist-bar menu's "Settings" and Browse's "Show in Library" all focus through it. Don't re-add local panel state.
- **Strip context menu = `position:fixed` at cursor coords** (`{x,y}` from the `contextmenu` event):
  the `.pl-item` clips overflow, so an absolutely-positioned menu would be hidden. `.pl-ctx` opens
  upward (`translateY(-100%)`) since the playlist bar sits at the bottom.
- **`PlaylistToggle.tsx`** = inline SVG of `PlaylistToggleGeometry` (unchecked = accent ring;
  checked = accent fill with checkmark cut out via `fillRule=evenodd`). currentColor → hover brightens.
- **Library card = compact title-overlay fork** (`.lib-title`, no below-thumb `.title`); trash + toggle
  sit above the 44px bar.
- **Preview full-res:** the Browse sidebar (`BrowseSide`) lazily `api.detail(source, w)` → `SideMedia` layers the card's own
  static (base) → `detail.previewUrl` (full-res, fades in once loaded) → the gif on top from the first frame, with the card's
  own `anim()` URL (the same image → the same animation, no restart). Needs the `source` prop.
- **Native pickers:** `app/shell/preload.js` exposes `window.liascape.pickFolder()/pickFile()` →
  `ipcMain "liascape:pick"` → `dialog.showOpenDialog`. Settings "Browse" buttons use it; `window.liascape` is
  undefined in a plain browser → falls back to the text input.
- **Animated library/playlist bar previews (`MotionThumb.tsx`):** library items expose
  `animatedThumbnailPath` (the source preview **gif/webp**, persisted by the backend — see
  `library.md`). `MotionThumb` layers, over the static thumb: a gif/webp `<img>` (autoplays in-browser,
  off-thread — **no extra gif-decode machinery needed**) when the asset exists,
  else a hover `<video src=videoPath>` fallback (moewalls/motionbgs ship no gif). `active` = hover OR
  (`AutoPlayGifs` && `hasGifAsset`) — **only cheap gif/webp assets bulk-autoplay; video is hover-only.**
  `content-visibility:auto` on the card means offscreen anim layers never decode. Browse + Preview
  animate via the remote `animatedThumbnailUrl` (workshop/WE only). Wires the formerly-dead
  `AutoPlayGifs` setting.

## Round-2 patterns (regression fixes)
- **Context menus must portal to `document.body`** (`createPortal`) + `position:fixed` at the cursor
  `{x,y}`. A grid card has `contain:content` (paint containment) and the playlist bar has `backdrop-filter` —
  both create containing blocks that otherwise trap `position:fixed` inside them. Same reason the
  playlist Save/Load/Settings modals are portal'd out of `.playlist-bar` (they were landing off-screen).
  **A portal still bubbles through the React tree:** a menu declared inside a clickable element
  (the `.pl-item`, whose `onClick` is `playFrom`) receives every menu click too — opening
  "Settings" from the playlist bar restarted playback from that item. Wrap the portal
  content in a `display: contents` element that `stopPropagation`s click/contextmenu/pointerdown/
  keydown, or declare the portal outside the clickable element (`LibraryCard` does). Guard:
  `electron app/shell/probe-plmenu.js "http://localhost:5173/?api=<port>"` (stubs playback +
  `/open`, so it never touches the live wallpaper or opens a window).
- **`useSmoothScroll(ref, axis)`** (`hooks/`) — smooth wheel scrolling (wheel→velocity, rAF ease,
  friction 0.85). Wire on every `.scroll` container + the horizontal `.playlist-bar-row` (`"x"`).
- **Never set `scrollbar-width`/`scrollbar-color`** — Chromium ≥121 then ignores `::-webkit-scrollbar`
  and you lose the rounded thumb. webkit-only.
- **`thumb(u)`** (`api/client.ts`): local file path → `/media`, `http(s)` → `/img` proxy. Use for
  Browse cards (WE-local hands absolute paths; `img()` alone → blank thumbnails). Library/playlist
  items are always local → `MotionThumb` uses `media()` directly.
- **Browse gif = layered, not `src`-swapped**: keep the gif `<img>` mounted (opacity-toggled) so
  hover/AutoPlayGifs never restarts it. Same `active = hover || (autoPlayGifs && hasGifAsset)` rule.
- **`PlaylistToggle` checked tick** = a `<mask>` (white box − black checkmark), not an evenodd path
  (Chromium can render evenodd filled). `useId()` for the mask id.
- **Selection (library)**: no toolbar — card trash/toggle and the sidebar's volume / speed / Delete repeat to the whole
  selection when the focused card is selected (`targetsFor`; the sidebar's head says "applies to N selected"). Ctrl+A/Delete bail while typing (`typing()`);
  click on `.scroll`/`.grid` background clears. Browse keeps its small Download/Cancel `.sel-toolbar`.
- **`StatusBar`** (`components/StatusBar.tsx`) = persistent bottom bar (status / playing / Ready + Undo).
- **Open-in-FM + duration** are backend (need FS): `AppOps.RevealLibraryItem` (resolve symlink/scene
  dir) + `GET /library/duration` (ffprobe). Frontend passes `isScene/workshopId/copiedSceneDir`.

- **A context menu holds its item's hover preview** (`LibraryCard`, `PlItem`): `active` includes the open menu (its
  backdrop takes the pointer off a card, `mouseleave`), and closing sets the hover from the closing click's coordinates
  (`pointerOver`) — on the item the same `<video>` goes on, off it, it stops (a bar item, the menu's React parent, gets no
  leave of its own). Guard: matrix `hoverPreview:rightClick:card|bar`, real input events.
- **The UI never guesses which playlist item plays** (`markPlayingAfterPlay`): the bar's border and the card's mark come from
  `wallpaper-changed` (the player's `program.current`, at B's start: until then the old item stays marked) and, for the Play
  that switches nothing, `/current` — dropped if an event landed meanwhile, which is newer. It used to set item 1 after the
  POST: wrong under Shuffle until the event, and for good when the event beat the reply. Guard: matrix `playlistMark:shufflePlay`
  (+ `:resume` — the same rounds under "Resume where it left off", 2026-11-10 re-check of the owner's report: green).

- **Travel to the playing wallpaper** (owner todo 2026-11-10, "travel to running wallpaper on app open";
  `hooks/travelToPlaying.ts` `useTravelToPlaying(ref, key, axis, selector, playingPath, count)`): the first time in an app
  session that the Library grid (`.card.playing`) / the playlist bar's row (`.pl-item.playing`) shows the playing item —
  the app opening on Library, or the first Library visit with something playing — its scroll container jumps (no glide)
  so the item sits mid-view, re-aimed over 3 more frames (the `content-visibility` cards near it take their real size).
  Once per session per list (a module `Set`): a later tab visit or a switch never moves the user's scroll; a wheel / a
  pointer-down first stops it; nothing playing or the item filtered out → the next chance tries again. Guard: matrix
  `travel:appOpen` (a 560×430 window, the item last in both plays, a reload; RED on the old UI: both at scroll 0).
- **"In library" on Browse cards** (owner todo 2026-11-10, "mark the wallpapers already downloaded"): `Browse.tsx`
  `libraryKeys(libraryItems)` (one Set per library change: `ws:<workshopId>` and `url:<pageUrl | sourceId | videoPath>`)
  → each memo'd `Card` gets a boolean `inLibrary` (`ws:` match for Workshop and WE-local — the same item under either
  source —, else the page URL for moewalls / motionbgs / desktophut) → a `.badge.inlib` (`data-in-library`, a lucide
  Check + "In library", the success colour, top-right — the SCENE badge's opposite corner). It follows downloads / trash
  live (the library slice). Guard: matrix `browse:inLibrary` (a WE-local folder whose "900000001" is s1's Workshop id;
  RED on the old UI: no badge). The Browse sidebar says it too (`[data-in-library]` "In your library" + **Show in Library**,
  and its main button is **Apply** — the library copy — instead of Download & Apply).
- **`loop-current` in the UI**: Settings → Keyboard shortcuts lists `liascape loop-current` (with a hint); WS `loop-current`
  → the topbar status (its `message`) + the store's `keepCurrent` (also `/current.keep` on every resync; a Play /
  play-from clears it) → the status line's ", looping this one (loop-current)", and the Library sidebar's "Playing now · looping
  this one" chip on the playing item. player-adapter.md § Rotation.

- **Tab slide** (owner todo 2026-11-10): `.tabs` is a grid of equal columns with one `.tab-pill` (the accent fill + glow) under the
  buttons, moved by `transform: translateX(calc(var(--tab-i) * (100% + 4px)))` (`--tab-i` = the active tab's index, App.tsx)
  with a 320 ms ease-out transition; the page switched to slides in from its side (`.app[data-tab-dir="l"|"r"] > .scroll`,
  `tab-in-l|r`: 28 px + opacity, 280 ms, **no fill** — a transform left on `.scroll` would trap the Settings backdrop's
  `position: fixed`). No direction until the first switch (the first page doesn't slide in). `:root.no-motion` → the pill jumps,
  the page appears. Guard: `--probe probe-layout.js` `tabs:slide` / `:off` / `:reduced` (the pill's per-frame x, the page's
  animated properties = transform + opacity only; RED on the old UI: no pill).
- **Dock-style playlist bar hover** (owner todo 2026-11-10): the hovered `.pl-item` lifts 4 px, its neighbours 2 px, the next ones
  0.75 px — CSS only (`+` for the ones after it, `:has(+ …)` for the ones before), transform with a 180 ms ease-out. A playing item
  neither lifts nor lifts its neighbours (its green ring). The row has `padding-top: 6px; margin-top: -4px` (it clips vertically:
  room for the lift, same height as before); the portal'd `.pl-hover-glow` follows the item's box (below).
  `:root.no-motion` → the hovered item alone, 2 px, no easing; `:root.no-glow` → no glow layer, the lift stays. Guard:
  `probe-layout.js` `dock:hover` / `:off` (computed `translateY` of the items).
  **The hovered item is the row's state, not CSS `:hover`** (owner 2026-11-11: "doesn't lose the hover thing in the gaps"):
  `PlaylistBar`'s `hoverPath` — an item's `mouseenter` sets it, the 10 px gaps keep it, the row's `mouseleave` or the pointer
  past the first / last item clears it — → `.pl-item.hov` (the lift, the remove button) and the item's preview. The glow follows
  the hovered item's box with a rAF loop (the eased lift and the row's smooth scroll fire no mousemove). **The row's wheel
  listener re-attaches when the row mounts** (`useSmoothScroll(rowRef, "x", [rowShown])`): attached once at the bar's mount,
  before the playlist had loaded, the bar never scrolled. Guard: `--probe probe-plbar.js` — `bar:wheel`, `bar:wheelReopen`
  (collapse + expand), `bar:gap`, `bar:leave`, real input events in a narrow window (RED before: 3/4).
- **Any window size** (owner todo 2026-11-10, "responsive at any tiled size"): the `.topbar` is `flex-wrap: wrap` (a second row
  instead of controls past the window's edge); `.status` = `flex: 1000 1 0; min-width: min(140px, 100%)` (fills a row's end,
  truncates, never forces a wrap by its text); `.search` = `flex: 0 1 240px; min-width: 120px` (≤ 640 px: `1 1 140px`, fills its
  row); `.pills` shrink/wrap inside themselves; ≤ 760 px the source pills are `display: contents` (each pill wraps on its own
  and the search fills a row's end; the Settings level pills stay a block); ≤ 640 px tighter paddings. The item sidebar fits
  any size (below). Guard: `scripts/test-ui-matrix.sh --probe probe-layout.js` with
  `LIASCAPE_MATRIX_SCREEN=2560x1440` — nine sizes from 480×720 and 560×430 up to 2400×520 and 1600×400 × Browse / Library /
  Settings (no top-bar control past the window or over another, the bar ≤ 35 % of the height, the search ≥ 110 px, no
  sideways page scroll, cards inside the grid) + `resize:side:<w>x<h>` the item sidebar at each size (inside the window, close
  + Delete reachable; ≥ 900 px docked: no card under it, the grid ends at its edge; narrower: a scrim); screenshots
  `layout-<tab>-<w>x<h>.png`, `layout-side-<w>x<h>.png`. RED on the old UI: 15 of 36 resize cells (Browse's pills + search
  past the right edge from 1100 px down, Library's sort from 640, Settings' level pills at 480–560; the modal taller than the
  window at ≤ 600 px high); `resize:side` 9/9 RED before the sidebar (none).
- **A Browse list reply belongs to its generation** (`store` `browseGen`, 2026-11-10): `reload()` starts a new one (source switch,
  search, sort, filters, refresh) and both `reload` and `loadMore` drop a reply from an older one (and leave `loading` to the
  newer request). Before, a slow online source still loading when the user switched let its late page replace the new
  source's list — MotionBgs' cards under the "Wallpaper Engine (Local)" pill (probe-morph's Browse cells caught it).

## Round-3 patterns (live wallpaper bg, translucency, app dropdowns, drag-preview)
- **`WallpaperBg.tsx`** — the LIVE wallpaper played behind the UI (`position:fixed`, z-0), gated by the
  `LiveWallpaperBehindAllTabs` advanced setting. A **single persistent `<video>`** (no crossfade — `src` swap is
  instant, like the desktop). Shows the playing video; on a scene (no playable video) keeps the last shown;
  nothing ever played → a random library video. `muted` (desktop owns audio). Synced to the live mpv
  position (`/current` `position`, ~2s) and **paused when backgrounded** (`appActive`), re-synced on refocus.
  **`playbackRate` = effective speed** (`item.speedOverride ?? globalSpeed`) so a 2× wallpaper's bg doesn't
  crawl + stutter on each resync.
- **`appActive`** (store) — window focused/visible (focus/visibility listeners). Gates gif autoplay AND
  WallpaperBg playback → **fixes the main-thread freeze** (offscreen decode storm when backgrounded). Never
  decode/animate while `!appActive`.
- **Translucency = two CSS vars** `--tr` / `--tr-strong` (`--tr-strong` = `--tr` + 0.1). Applied via
  `color-mix(… P%)` where the percentage **is** the alpha (so a higher number = *more* opaque). `--tr`:
  topbar, search, sort, "wallpapers in playlist" counter, Browse filters. `--tr-strong`: filter dropdown,
  Settings / More-info modal, right-click menu, playlist-settings menu, debug overlay. **The playlist bar
  itself has 0% bg** — it shows the live `WallpaperBg` directly (cards must NOT be visible behind it). No
  `backdrop-filter: blur` (removed — paint cost + by request).
- **`Select.tsx`** — app-controlled dropdown, **not native `<select>`**: a `.sel` button + a portal'd
  `.sel-pop` popover (smooth-scroll via `useSmoothScroll`, `--tr-strong` bg). Native selects can't be
  themed/translucent/smooth-scrolled on Chromium/Linux, so all dropdowns use this.
- **The Library sidebar's volume / speed** (`LibrarySide`): the sliders
  **drag-preview live, persist on release**. Each `onChange` → optimistic `patchLibraryItem` (instant
  bg/cards) + **throttled** `api.preview({volume|speed, paths: targets})` (~90ms) + **debounced** persist
  `api.libraryVolume|Speed` (250ms after the last tick → one index write; **one timer per field** — a
  shared one let a speed drag drop the volume drag's save). **The preview names the edited item(s)**: the
  backend moves exactly their sources, wherever they are, and nothing when none is live — never "what's
  playing" (mid-transition that's the incoming side: a drag on A moved B and left it there). No UI
  "is it playing" gate either (the store's `playingPath` is one side of a transition). Guard:
  `electron app/shell/probe-preview.js "http://localhost:5173/?api=<port>"` (stubs every write). Reset
  buttons persist immediately; unmount (an item switch remounts it, a close unmounts it after its slide) flushes a pending persist. **Speed slider is hidden for scenes
  under legacy** (LWE is 1×, so it'd be a no-op); with `playerEngine` liascape-player it shows (a scene's speed scales its
  animation and its pitch-kept sound — matrix `itemSpd:scene`; it was hidden for every engine).
- **"Scene properties" in the Library sidebar (`components/ScenePropsEditor.tsx`, `key={path}`; a scene item, not a
  multi-selection).** `api.sceneProps(path)` at once, the last answer cached per path for the session
  (`scenePropsCache.ts` — a revisit shows at once; every answer refreshes it), `onReady` when the first answer is in; one row per
  visible property (`data-scene-prop=<name>`): bool → checkbox, slider → range (+ value, `precision`), colour →
  `<input type=color>` (sent as `#rrggbb`), combo → the app's `Select`, textinput → text field; `group` → a heading,
  `text` → plain text (never HTML), not-editable types → greyed with their reason; a "Default" button on each
  overridden row + "Reset all". Same contract as volume/speed: slider/colour → local value at once + throttled
  `previewSceneProp` (~90 ms) + debounced persist (250 ms, per property); toggle/combo/reset persist at once; text
  persists debounced; the POST's answer (overridden flags, condition visibility) replaces the list; unmount flushes
  pending persists. Under legacy the backend's `note` shows ("applied when the scene starts").
- **Scene loudness (2026-10-29; web-backend.md § Scene loudness).** The Library sidebar's meta row (a scene under
  liascape-player, `data-scene-loudness-line`): "≈ −14.6 LUFS (estimated)" — the offline estimate of its current
  properties' sound — or "−15.2 LUFS (measured, 30 min)" (`sceneLoudnessText`: `loudnessLufs/Estimated/Seconds` of the
  `/library` item); a `low`-confidence estimate adds "Estimate may be off: <its first note>" (`data-scene-loudness-note`).
  It follows a property toggle live: `library-item-changed` carries only the fields that changed (`{path, …}` spread
  into `itemChangedByBackend` — the grid's copy, which the sidebar reads; it used to pass `volumeOverride` always, which a
  loudness-only payload would have cleared). **Settings → Playback → "Scene loudness"** (under "Normalize audio" /
  "Target loudness", liascape-player only — `SceneLoudnessRow`, `wk="normalizeAudio"` so the ffmpeg warning shows):
  **Estimate** (scenes without an estimate for their current properties; "every scene is already estimated" when
  none), **Recalculate all** (force), **Cancel** while running; the hint carries `done / total (current id)…` or the
  last run's failure count (`GET /library/scene-loudness/status` when idle; a run already going on is picked up).
  **Topbar status** (App.tsx `s.status`): WS `scene-loudness-progress` → "Estimating scene loudness 12 / 96…"
  (untimed) while it runs, then "Scene loudness: estimated N scenes" / "…: cancelled" (timed, 5 s) at `finished`;
  the store's `sceneLoudness` holds the progress (null = idle).
- **Global Volume/Speed sliders (Settings page) drag-preview live too** (`useGlobalPreview` in
  `views/Settings.tsx`): each `onChange` → `setSetting` (the store's debounced 250 ms `/settings` save
  persists) + a throttled (~90 ms, trailing) `api.preview({volume|speed, global: true})` — the backend
  moves every live wallpaper that follows the global and never one with its own override. Before, the
  desktop only changed 250 ms after the drag stopped. Guard: matrix `globalDragVol` / `globalDragSpd`
  (a real 40-step drag, every source sampled every 40 ms).
- **Item sidebar — Wallpaper Engine-style (owner 2026-11-10: "instead of a settings menu when clicking right click and
  settings, it should open a sidebar when you focus a card and thats what has all the 4 options from the right click menu.
  same for the browse tab"; spec `docs/superpowers/specs/2026-11-10-we-sidebar-design.md`).** It replaced the per-card
  settings modal and the Browse preview modal (`CardSettingsModal`, `PreviewModal`, the `useMorph` flight — gone; the morph's
  history is in git, last in `c87376bb`).
  - **Shell** `components/SidePanel.tsx`: an `<aside class="side-panel" data-side="library|browse" data-side-id=…>` the grid
    view renders next to its `.scroll` (a direct child of `.app`), from `--topbar-h` (App measures the wrapping top bar with
    a ResizeObserver) to the bottom, `--side-w` = `clamp(300px, 26vw, 400px)`. **≥ 900 px docked**: `.app:has(> .side-panel:not(.closing))`
    gives `.scroll` a `margin-right` and the playlist bar a `right` of `--side-w` (the grid re-fits its columns); **below**, it
    floats (`min(360px, 100vw)`) with a `.side-scrim` that closes it. Its own scroll; a sticky head (title, "applies to N
    selected", `[data-side-close]`). Motion: `side-in` (24 px + opacity, 220 ms, no fill) on open, the content keyed by the
    item → `side-swap` cross-fade on a switch, `.closing` + `side-out` (160 ms) on close — kept mounted by `useLinger`
    (`hooks/useLinger.ts`, a timer, 0 ms with motion off). Transform + opacity only; `:root.no-motion` → none.
  - **Identity, not objects** (the 2026-11-10 morph-replay bug: "the morph animation plays again and again every like 1-2
    minutes"): the store holds the PATH / page URL (`libFocus` / `browseFocus`), the views resolve the live item from their
    lists, and everything per-open (the content key, the duration fetch, the scene properties, the trailer, `SideMedia`'s
    aspect) keys on it — a `library-item-changed` (a playing scene's loudness report, a property re-plan, a volume keybind)
    updates the values in place and replays nothing. Guard: probe-sidebar `lib:still` (k1 plays, VolumeKeyTarget "item", two
    `/volume` keybinds: the picture doesn't move, nothing animates, the slider follows).
  - **Focus.** Library: a plain click = focus + apply (as before; WE applies on click), Ctrl/Shift-click = the selection +
    focus, **right-click = the context menu** (**Settings** = the sidebar on that card without applying it, Open in file
    manager, Delete, Delete from source — WE keeps a context menu beside its details panel too); with the sidebar already
    open a right-click also moves it to that card. A right-click doesn't open it by itself: the docked sidebar re-fits the
    grid, which slid the card out from under the menu and the pointer (matrix `hoverPreview:rightClick:card` caught it). Browse: click /
    right-click = focus (nothing downloads any more), **double-click = download & apply**, the hover **download button**
    (`.dl-btn`, bottom-right — the old whole-card glyph overlay meant "click downloads") too, middle-click unchanged. The
    playlist bar's menu "Settings" = `focusLib` + the card scrolled into view. The focused card is `.focused` (a light ring
    off the card, distinct from the selection's accent outline). **Keys** (`hooks/gridKeys.ts` `gridOwnsKey` — never with a
    menu / dropdown / modal open, a slider held, or — for arrows / Enter — a field or button focused): ← → one card, ↑ ↓ one
    row (`--cols`), the first arrow with nothing focused = the playing card; Enter = Play (Library) / Download & Apply or the
    library copy's Apply (Browse); Escape = close + clear the selection (a card's / bar item's open menu takes the first Escape).
    A focused item that leaves (trashed, a source switch) closes it; a Browse reload keeps the last copy while it's away.
  - **Library sidebar** (`LibrarySide`): picture (`SideMedia`: the card's still → the sharp image → gif / video from where the
    card's hover video was, at the picture's own aspect — read from the card at the focus, `captureSource`, else remembered
    per id — height `--side-media-h` = `min(38vh, 320px)`; YouTube over it), "Playing now · looping this one" (`keepCurrent`) /
    SCENE / crashed chips, **Play** · **Add to playlist / In playlist**, the meta (duration — row reserved —, resolution, age
    rating, the loudness line + note), **Open in file manager · Delete · Delete from source** (Workshop items, auto-import off),
    the crash whitelist, Volume, Speed, Scene properties, tags, Workshop ID, Play YouTube, Open on Steam. **Settings levels**
    (`settingsLevel.ts`): Volume / scene properties / the actions = Basic, Speed / the loudness line / Workshop ID = Standard
    (their Settings rows' levels); a row the level hides still shows when the item has its own value for it (a speed
    override). `[data-side-row=volume|speed|loudness|workshop-id]`. **No pop-in**: `.side-body.wait` (opacity 0) until the
    scene's properties are in (`onReady`; cached per path; `READY_CAP_MS` = 450 ms at most), then one fade — the "scene config
    pops in when the settings grow" item, closed by this. Guard: probe-sidebar `lib:popin` (every frame: never shown without
    its properties, never grows after it showed; measured: shown at ~70 ms with them).
  - **Browse sidebar** (`BrowseSide`): picture (above), In your library + Show in Library, **Download & Apply** · **Download**
    (or **Apply** for an item the library has; the progress + Cancel while it downloads), the numbers, description, tags, Play
    YouTube, Open on Steam / Open page / Open in file manager (the middle-click target), Copy ID.
  - Guard: `scripts/test-ui-matrix.sh --probe probe-sidebar.js` — `lib:click` / `lib:rightClick` / `lib:fourOptions`
    (`/open` stubbed; Delete + Undo; Delete from source on s1) / `lib:volume` / `lib:still` / `lib:keys` / `lib:selection` /
    `bar:settings` / `lib:levels` / `lib:popin` / `motion:on|off|reduced` / `browse:click` / `browse:inLibrary` /
    `browse:dblclick`; screenshots `side-*.png`. RED on the old UI 15/16 (`browse:dblclick` held: a click downloaded then);
    + probe-layout `resize:side:*`; the matrix cells that opened the modal (`itemVol*`, `itemSpd*`, `selVol`, `keys:sliderHeld`,
    `cli:volume-up:modalOpen`, `sceneProp:*`, `appear:morphs`, `appear:videoThumbs`, …) open the sidebar (`m.openSide(t)`: a
    the menu's Settings) and read `[data-side-row]` sliders.

## Hardware GL on NVIDIA (2026-10-28 — now the DEFAULT: ANGLE `gles-egl`)
The owner ran `LIASCAPE_HWGL=1 LIASCAPE_ANGLE=gles-egl liascape` in the real Wayland session: the window shows, stays up, the
morph is GPU-composited. So `main.js` now defaults NVIDIA to hardware GL via `--use-angle=gles-egl`; `LIASCAPE_SOFTGL=1`
brings back the SwiftShader path; `LIASCAPE_ANGLE` overrides the backend. The log line "'--ozone-platform=wayland' is not
compatible with Vulkan" is harmless. History below.
`main.js` still puts NVIDIA on `disable-gpu` + SwiftShader (memory `nixos-electron-ozone-x11`: native Wayland → the
surface via Vulkan, rejected; XWayland → GPU-process segfault). Hermetic check (no display: `--ozone-platform=headless`,
an offscreen window animating + WebGL, 5 s) with the store's electron 42.11.18 (the flake's `electron_42`) and 44.9.3 on
the RTX 3070 Ti (open module 595.84): the default backend's GPU process exits during init ("disabled due to frequent
crashes" — headless has no default GL), but **`--use-angle=gles-egl` (NVIDIA's EGL, "OpenGL ES 3.2") and
`--use-angle=vulkan` bring up full GPU compositing + raster + WebGL with no GPU-process exit** on both versions. That
does not exercise the window's presentation path (Wayland surface / XWayland present — where both crashes were), which
can't be driven hermetically (no headless Wayland compositor here; Xvfb has no NVIDIA GL), so it's not proof and the
default stays. To try it: `LIASCAPE_HWGL=1 LIASCAPE_ANGLE=gles-egl liascape` (both env vars already exist in `main.js`; EGL, not
Vulkan, for the surface); if the window shows and stays up, the GPU composites the UI and the CPU cost per frame measured above goes away.

## Backend-owned state the store mirrors (UI × player-state matrix findings)
- **Settings**: every save posts the store's WHOLE `settings` → the store must hold what the backend
  changed itself: WS `settings-changed {fields}` → `mergeSettings` (a keybind volume-up was reverted by the
  next UI save). `setSetting`'s debounced save posts `get().settings` at fire time, not its own snapshot.
- **Playlist bar**: trash/undo change the backend's playlist → `trashItems` drops the items first (a
  pending playlist bar save can't put them back), both re-read it via `syncPlaylist()`. Another client's
  `POST /playlist/state` (a script, an agent) → WS `playlist-changed {client}` → `syncPlaylist()`; every POST
  carries the page's `X-Liascape-Client` id (`api/client.ts` `CLIENT_ID`) so a page skips the echo of its own save.
- **Backend restart under an open page → `store.resync()`** (2026-10-28: "Library is empty" while a wallpaper played).
  Everything the store mirrors — sources, themes, settings (+ theme vars), `/current`, library, playlist bar (paths +
  settings + name), playlist names, undo depth, Steam status — is read by ONE `resync()` (`readBackend`): at start
  (`init` retries it — 250 ms doubling to 2 s — while a CORE read — sources, themes, settings, current, library,
  playlist bar — fails for want of a backend: a `TypeError`, not an HTTP error; names / undo depth / Steam never hold it up) and on every WS reopen after the first (`useEvents(onEvent, onReconnect)` → `App.tsx` `onReconnect`; also
  reloads a Browse list the outage left empty). Each piece is applied only when ITS read succeeded — never `[]` for a
  failed read (init used to `.catch(() => [])` the library) — and a playlist bar / settings edit still waiting for its debounced
  save keeps the local copy (`playlistBarSavePending` / `settingsSavePending`). Overlapping calls coalesce into one more pass.
  The incident: `dotnet watch` restarted the dev backend on a cherry-pick that also changed `api/client.ts`; Vite's HMR
  re-created the store (empty) and re-ran `init` into the outage (journal: `hmr update /src/App.tsx …` 13:11:21, backend
  `Exited` 13:11:26, listening 13:11:29) — `init` failed and nothing ever re-read; the backend's startup
  `library-synced` broadcast fires before any page has reconnected, so it never helped. The backend serves the whole
  library from its first request (`LoadAll` scans the folders per call — there's no lazy index load). Guard: matrix
  `restart:backend` (idle/playlist: backend down 3 s under the open page — an item added, the playlist bar and
  `thumbnailAspect` changed on disk meanwhile → the page shows all three, and the new backend's first `/library` is
  whole), `restart:midLibrary` (the page's first `/library` held, the backend SIGKILLed under it, then back),
  `restart:initDown` (the built UI from `file://…?api=<port>` — the dev topology — started while the backend is down).
  All three were RED before the fix.
- **Origin**: production = `http://127.0.0.1:<backend port>`; `main.js` reuses the last port while free
  (`LIASCAPE_PORT`) so localStorage prefs survive a relaunch; WS connects to `location.origin` when `API` is "".
- Guard: `scripts/test-ui-matrix.sh` (every control × every player state through the real UI, hermetic;
  `--jobs N` shards it, default 6 ≈ 10 min; **`--changed [<rev>]`** runs only the cells the change can affect —
  `scripts/matrix-cells-for.sh` maps changed files → cell families, central files → the full matrix, docs /
  uncovered areas → none: use it before a commit, the full run before a merge or a release build).
  **`--fuzz <steps> [--seed <n>] [--fuzz-runs <k>]`** chains random controls instead (a run: a random start state,
  then `<steps>` controls eligible in the state the stack is in NOW — derived from the live player/backend, `states`
  must list it — and every cell check after EACH step; paused/muted expectations carry across steps via each control's
  `exp`/`flipPause`/`flipMute`). `probe-matrix.js`'s `FUZZ_RULES` excludes backend-only / failure-on-purpose / special-
  setup controls (race:*, apply:broken, autoMute*, shuffle:*), allows what the later steps can't follow (trash without
  undo, plShuffle, interval changers, -keep / volume-key modes) only as the last step, and gates controls whose drive or
  check assumes a starting value. Default 2 jobs; a run's picks depend only on (seed, run). A failure prints the seed,
  run, sequence and a **`--fuzz-replay '<state>:<c1>,<c2>,…'`** command that reruns exactly it; results in `fuzz.jsonl`.
  Its window is **shown** (on a private Xvfb) and focused: a
  hidden BrowserWindow renders no frames — rAF never fires, so framer-motion / WAAPI exits never finish,
  dnd-kit's rAF-aligned pointermoves coalesce (a drop lands on a stale target) and `appActive` stays false.
  Drags that need real hit-testing go through `webContents.sendInputEvent` (the playlist bar's dnd-kit reorder).
  **Scene cells (Phase 2 Task 12).** `test-ui-matrix.sh` seeds three synthetic WE scenes into the private library
  (`library/workshop/90000000{1,2,3}`, titled s1–s3 in that source's `index.json`, 320×180 previews; the worker's
  synthetic renderer: s1 red + 440 Hz, s2 blue + 660 Hz, s3 crashing 1.5 s after every start), runs its player with
  `LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1` + `LIASCAPE_SCENE_WORKER_BIN` and `LIASCAPE_PLAYER_VRAM_PROBE=fake:<file>` (healthy unless a
  cell writes a worker's MiB into it; short `LIASCAPE_PLAYER_VRAM_TIMING`). Scene support stays **off** in the baseline (the
  library-stepping / random cells would land on scenes, s3 crashes) — the opt-in states `scene` (s1 alone), `sceneV`
  / `sceneS` / `sceneS2` (the playlist [k1, s1, s2, k2] at k1 / s1 / s2) and every scene control turn it on before
  the UI loads; each cell starts with the scenes unmarked (index rewritten) and the fake VRAM healthy. Cells (oracle in
  brackets — `state.workers[]` pid / `fps_target` / `audio.gain_db|no_audio|speed`, player props, the index, the UI):
  `apply:scene` (idle/single/playlist: a card click → kind scene, ready, a live worker, `/player-engine.scenes`),
  `next:v→s|s→s|s→v:<full-live|reveal|frozen>` (the started switch's `method`, its handoff, the outgoing scene's
  worker reaped), `pause:scene` (no frame latched, the scene clock still, captures 500 ms apart identical, `gain.pause`
  −96), `mute:scene` / `volume:scene` / `itemVol:scene` / `itemSpd:scene` / `noAudio:scene` (the worker's stream, same
  pid), `trash:playingScene` (scene / sceneS), `crash:scene` (s3 from the playlist bar → `source.broken`, index `crashed`, its
  card marked, the playlist bar's next plays), `noOutput:scene` (parked with the worker kept, shown again on replug),
  `settings:sceneFps` (Monitors → `out:VIRTUAL-1.scene_fps` 45 + `fps_target`), `settings:autoThrottleScenes|vramLimit|
  vramLowMode` (the GPU / VRAM group → `player.*`, same pid), `vram:exceeded` (the fake reports s1's worker at 2000 MiB
  > 1536 → the rotation advances, not marked crashed, the status bar's text), `playlist:sceneInterval` (a 4 s interval
  advances off a scene), `restore:scene` (the backend restarted on the same port — `LIASCAPE_PORT` — the scene stays, same
  worker; the probe kills only the backend the stack started and records its replacement in `backend2.pid` for the
  cleanup); **`sceneProp:set|switch|restart|reset`** (s1's project.json declares `color` — the synthetic renderer's
  WE-encoded colour, red by default —, `clock`, and `bars` shown while clock is on; oracle: a pixel of s1's own
  source, its `scene_props`, `workers.properties`, the index): set in the modal → green live on the same worker,
  persisted, a toggle hides its dependant; saved before s1 opens → green at open, after s2 and back (a new source) too;
  a compositor SIGKILL → the restored scene green; "Default" → red live (the default sent), dropped from the index.
  `allowErr(e)` lets a control's own `source.error` through (crash, VRAM). `matrix-cells-for.sh`: the scene
  worker / `scene/` / `worker/` / `vram.rs` / their probes → the scene family. Fuzz excludes them (their fixtures).
  **Program cells (Phase 3 Task 11).** Every rotation runs inside the player's `prog:main` (`state.programs[]`: `phase`,
  `path`, `next`, `corr`, `played_ms`, `history_index`); the matrix's opt-in states and controls put the UI through the
  seams a program adds. States: `programArmed` (advance-on-end over k1..k4, k1 = 30 s, minimum 60 s: a switch armed for
  k1's end that nothing reaches during a cell), `programHeld` (the `pending` program — k4 → k1 → k2 — user-paused at ≥ 2.5 s
  of play: its clocks stand), `coverHeld` (a timed playlist with a fullscreen window over EVERY output, the hold engaged).
  `afterControl` runs **`progCheck`** for them (the program exists, `prog:main.path` = `/current`, an armed switch goes where
  `prog:main.next` says, phase `armed`); a control with `progOnly` also fails on any switch whose `origin` isn't
  `program:*`. Cells: `programArmed × plTr* | plShuffle | playlistBarRemove:other | trash:other | restart:backend`
  (an edit under the armed switch re-arms it to the bar's next; a backend killed and restarted under it leaves the program
  alone — same item/corr, play time only grows, no switch requested by anyone — and the page resyncs to it);
  `programHeld × prog:next|previous|random|trash:shown` (the user switch resumes the pause and goes through the program's own
  verbs; `previous` at the first item does nothing and **leaves the pause alone**) and `prog:minPlay|maxPlay` (a limit edited
  while held: saved, nothing switches, the play time stands; a maximum below the time played switches at the user's resume);
  `coverHeld × cover:pause|pauseResume|next|volume|mute` (a user pause/mute/volume/switch through the hold: the user's pause
  survives the cover leaving, the hold survives a user switch, B shows once the cover leaves).
  **The covered Signal** is driven with `headless.cover {output|"*", state}` (what Hyprland/Sway/wlr-ft report on Wayland;
  `reset()` uncovers): `cover:fullscreen` (single/playlist/effect/pending: engages ≥ 250 ms after, `player.cover_hold_active`,
  every source `effective_paused`, the pause ramp down, `player.paused` never written, `time_pos` / effect `progress` /
  the program's `played_ms` frozen, all back on release — an armed B is node-paused by design and not counted),
  `cover:oneOfTwo`, `cover:modeLive` (Settings → "Pause when covered": fullscreen-only ignores a maximized window, Off
  releases at once, the default counts both), `cover:default` (settings file without the key → backend restart → first
  switch → `maximized` on the player → a maximized cover holds). **Playlist start** (`plStart:*`): `change` (choosing in the
  modal never moves the current play, `prog:main.start_mode` live), `global` (Settings select, the "takes effect the next time"
  hint), `startOver|resume : playAgain|stopPlay|ABA` (Play on the playing playlist; next → Stop → Play; Load/Play A → next →
  Load/Play B → Load/Play A through the real modals — start over = A's first item, resume = where A was left).
  **`parked:rotate|hold`** (both outputs removed on a playlist, 3 s interval: rotating invisibly by default — 2–4 `parked`
  switches in 9.5 s, origin `program:*`, the last target shown when the outputs return; the expert "Hold until a monitor
  returns" chosen in the UI: no switch, `played_ms` stands, the same item back). **`expert:toggle`** (idle/playlist: hidden by
  default → toggle on → tagged row → "Hold" saved and `prog:main.while_parked` hold live → toggle off: group gone, value kept,
  deviated marker → the marker's reset; the pure-UI cases incl. a reload stay in `probe-expert.js`). **`cli:next:backendDown`**
  (playlist: backend stopped, two `liascape next` processes at once reach the program: it lands two items on, no switch
  from a non-program origin, the new backend reports it). Fuzz excludes all of them (their fixtures); its keybind wait is now
  "the program took it" (`keybindTaken`: a `program.current` since the step began, or `prog:main.path` moved) — the
  `pending_action.txt` wait is gone with the file. `matrix-cells-for.sh`: `recipes/program/`, `signal/`, `LiascapePlayerProgram.cs`
  → FULL; the Settings / playlist modal / AppSettings files add the `cover|plStart|parked|expert` families.

## Rotation rows (redesigned 2026-10-28)
Settings → Rotation: "Switch when video ends", then ONE interval row — **"Switch every"** while it's off (a plain
timer), **"Minimum play time"** while it's on (the same `globalIntervalSeconds`, relabelled: toggling shows the same
value under the other label) with **"Maximum play time"** (`globalMaxPlaySeconds`) right below it (only while on). The
"Wait for video to end after interval" row is gone. The playlist-settings modal mirrors it inside its override block
(field labels SWITCH EVERY / MINIMUM PLAY TIME + MAXIMUM PLAY TIME). Every duration is `components/PlayTimeInput.tsx`:
a thin h/m/s wrapper over the shared `NumInput` (3 fields, `aria-label` "<label> hours|minutes|seconds", the total
clamped to 359999 s; **"off"** next to every 0 limit — emptying a field and leaving it = 0 = off, the NumInput rule);
hints in its `ROT_HINT` (each says what its 0 does). Under the two fields (only while "Switch when video ends" is on):
**"Separate timing for scenes"** (`globalSeparateSceneTiming`, default on; the modal: a checkbox in its override block)
and, only while that's on, **"Switch scenes after"** (`globalSwitchScenesAfterSeconds`, default 1800; modal SWITCH
SCENES AFTER) — a scene / still image switches after it, 0 = off (it stays), and the min / max hints drop their scene
clause (`minScenes` / `maxScenes`). While it's off the scene rule is said in one plain line (`ROT_HINT.sceneRule`: "Scenes:
they switch at the minimum — or at the maximum if the minimum is off. Both off: a scene stays until you switch."): the
toggle row's hint in Settings, a `.shint` `[data-scene-rule]` under it in the playlist modal (owner 2026-11-10). The status line reads "N wallpapers, on video end, at least X, at most Y, scenes
after Z" (", scenes stay" for 0). Semantics: `player-adapter.md` § Rotation. Matrix cells drive the seconds field
(`input[aria-label="Minimum play time seconds"]`) with `setValue` (+ a `focusout`); `playlist:sceneTiming` /
`global:sceneTiming` the toggle + "Switch scenes after".

## Settings levels (owner 2026-11-06 — "the forever final 4 levels", Standard the default; "Simple" renamed "Basic" the same day)
How much of Settings shows: **Basic · Standard · Advanced · Expert**, a pill row in the top bar beside the tabs while
Settings is open (`App.tsx`, `[data-settings-level]`, each pill `[data-level]` with a tooltip). One saved setting,
**`settingsLevel`** (`AppSettings.SettingsLevel`, normalized — anything unknown is `standard`); it replaced the old
"Advanced settings" + "Show expert options" toggles (the owner's, both on, became Expert). The backend never reads it.
- **Each level shows its own rows and every row below it.** A row's level: `LEVEL_OF_KEY` in `src/settingsLevel.ts` by its
  settings key, or `Row`'s `lv` prop (rows without a key; default Basic). `Section` takes `lv` too (a whole section above the
  level renders nothing). Advanced / Expert rows carry a small tag (`.s-expert`, `data-expert-tag`, text "Advanced" /
  "Expert"); every row has `data-level`, an Expert row also `data-expert`.
- **What goes where.** Basic — what everyone touches: volume, mute, even out loudness, hush on other audio, pause behind
  windows, the rotation timer + transitions, theme, card size, the Workshop folder, play scenes, getting Workshop
  wallpapers, clear thumbnail cache. Standard — the everyday knobs: loudness target + pre-measuring scenes, the auto-mute
  details, loop, speed, the rest of rotation, video fit / fps cap, the GPU section's auto-throttle + low-memory rule, look &
  feel, scene monitors, keyboard shortcuts, reset / clear. Advanced — internals: decoding and buffers, cache, the legacy
  restart, the per-scene memory cap, copy/replace files, the player engine, transition style + its sync nudge, volume
  keys, the wallpaper behind every tab. Expert — while parked, debug, the raw mpv / LWE commands.
- **Hidden settings are ordinary:** saved and applied live whatever the level; **hiding never resets a value**. A
  non-default value hidden by the current level puts a note at the top of Settings (`[data-hidden-changed]=<count>`: "N
  settings you changed are tucked away at a higher level"), with **Show** (`[data-hidden-show]`: raises the level to the
  highest one needed; each row's own reset is there). No bulk reset: it would also reset deliberate choices such as the
  player engine (it did, in the first probe run).
- **Names and hints** are plain and friendly (2026-11-06 pass: "Even out loudness", "Hush when other audio plays",
  "Pause behind windows", "Ease off heavy scenes", …). The rotation labels stay as the playlist modal has them. Tests
  find rows by label (`m.row(label)`), so a rename updates `app/shell/probe-*.js` too.
- Probe: `scripts/test-ui-matrix.sh --probe probe-expert.js` (Standard default + the picker in the top bar; each level's rows;
  saved + kept over a reload; a hidden changed value: kept, the note, Show; the start choice; Pause behind windows).
  Matrix cell `expert:toggle` (the same through the player: `prog:main.while_parked` stays live while hidden). The matrix
  stack runs at Advanced (`scripts/test-ui-matrix.sh`'s settings file).

## Pause when covered, playlist start (Phase 3 Task 10)
- **Playback → "Pause behind windows"** (liascape-player only, `liascapeActive`): Off / A fullscreen window / A fullscreen or
  maximized window (default, `pauseWhenCovered`); hint `ROT_HINT.cover`; the health icon comes from `/health/features` →
  `cover` (`hello.health.cover`, `affects: ["pauseWhenCovered"]`: no window-state source here, e.g. GNOME/KDE).
- **Rotation → "When the playlist starts again"** (`globalPlaylistStart`): Start over / Resume where it left off; hint per value
  (`ROT_HINT.startOver|startResume`) + `ROT_HINT.startLive` ("Takes effect the next time the playlist starts — what's playing
  now carries on") while a playlist plays (`playlist.length > 1 && playlist.includes(playingPath)`). The playlist modal has the
  same choice as a segment control (`data-playlist-start`) under its override block (disabled without the override), with a
  line beside it naming the global value it overrides (`data-playlist-start-hint`). **"Resume from last on launch" is gone.**

## Settings page under liascape-player (Phase 2 scenes)
`views/Settings.tsx` reads `GET /player-engine` on mount and after an engine or "Allow scene support" change;
while `active === "liascape-player"` (`liascapeActive`): "Scene transition delay" is hidden (the player switches once the
scene's first frame is in — no lead), the Monitors (scenes) rows drop the **primary** radio (one scene worker
for every output; its sound is one stream) and label the fps **"fps (live)"** (the backend sets
`out:<name>.scene_fps` on save), and a scene that can't play shows `scenes.reason` under the toggle. Legacy:
unchanged. **GPU / VRAM** (a section shown only under liascape-player; every row live — `player-adapter.md` § Scenes):
"Auto-throttle scenes" (`autoThrottleScenes`), "Limit VRAM per scene" (`limitVramPerScene`) + "VRAM limit (MiB)"
(`sceneVramLimitMib`, shown while it's on), "When VRAM runs low" Stop (free memory) / Pause / Off (`vramLowMode`); while
Settings is open under liascape-player it re-reads `/player-engine` every 5 s and says so when `vram.low_active` (the player's
low-VRAM hold — not a user pause). WS `scene-vram-stopped` → the status bar: "<title>: stopped: used X MiB > limit Y
MiB of VRAM" (`App.tsx`).

## Keys while a slider is held (`hooks/rangeDrag.ts`, owner todo 2026-10-28)
"Make F not do yellow outline when holding slider": **nothing in the app is bound to F** (no shortcut in `app/ui`
or `app/shell`; the app's keys are Ctrl+A / Delete / Escape in Library + Browse, Escape in the modals and
dropdowns). The yellow outline was Chromium's own focus ring: a mouse-focused `<input type=range>` doesn't match
`:focus-visible`, but ANY keydown flips the page to keyboard modality and the held slider then does (outline
`auto`, measured). `installRangeDragGuard()` (from `main.tsx`, before any other listener): a capture-phase
`pointerdown` on an enabled range input marks a drag (`html.range-dragging`) until `pointerup`/`pointercancel`/
window `blur`; while it lasts every `keydown`/`keyup` is `preventDefault` + `stopImmediatePropagation`ed on window
capture (no app shortcut, no Escape-closes-the-modal, no arrow stepping the slider under the pointer), and a
slider that got a key during its drag is `blur()`ed on release so it doesn't keep the keyboard-modality ring.
CSS: `input[type=range]:focus-visible { outline: none }` everywhere; keyboard focus gets the hover's accent glow
instead (`:root:not(.range-dragging)`), so tabbing to a slider still shows where focus is. `shortcutsBlocked()`
(= typing in a field OR holding a slider) replaced Library/Browse's local `typing()`. Guard: matrix
`keys:sliderHeld` (idle, single — a real mouse press on the item sidebar's volume slider via `sendInputEvent`, two
cards selected, then f/F/Delete/Escape/Right: no outline/glow on the held slider, the sidebar stays open, the value
doesn't step, nothing trashed, no keyboard ring after the release; RED on the base UI: the outline `auto` + Escape
closed the then-modal).

## Missing pieces warn on their rows (`components/FeatureWarn.tsx` `WarnIcon`, owner todo 2026-10-28)
"Make missing libraries fail loudly — if a feature won't work because of something in the build, show a warning icon".
Settings reads `api.featureHealth()` (`GET /health/features`, web-backend.md — the feature/dependency table) 300 ms
after mount, after an engine / scene-support / steamcmd change and every 15 s; `HealthCtx` maps each settings key a
broken feature (`ok === false`) `affects` → its reasons. `Row` renders `<WarnIcon k={wk ?? rk}>` right after its label
(an amber `AlertTriangle`, `.s-warn`, `title` = the reason(s), `data-feature-warn=<key>`) — **the control itself stays
shown and usable** (never hidden or disabled for it). `wk` names the key for a row without `rk` (the steamcmd rows).
A summary (`[data-health-summary]`, `.health-sum`) on top lists the broken features that are **in use** (`inUse`:
switched on / selected — so a missing steamcmd for a Steam-subscription user, or playerctl with the MPRIS option off,
is a row icon only). `ok: null` (not known — the GPU interop before a player ran) shows nothing. A feature that
`affects` no key (`audio-bus`: the player's PipeWire bus down → sources on mpv's default device) shows in the
summary only. `HealthCtx` / `healthWarnings` / `WarnIcon` live in `components/FeatureWarn.tsx`; the **playlist
modal** (`PlaylistSettingsModal`) wraps itself in `<HealthCtx.Provider value={useFeatureWarnings(open)}>` (reads
`/health/features` when it opens, every 15 s while open) and puts `<WarnIcon k="globalTransitionEnabled">` in its
TRANSITIONS `.field-label` — the same icon as the global Transitions row (the playlist's transitions break with the
same `transitions` feature). Guard: `--probe probe-health.js` (below in web-backend.md; RED on the base UI: 8 rows
without an icon, no summary; the modal icon and `audio-bus` cells).

## Numeric fields (`components/NumInput.tsx`, owner todo 2026-10-28)
Owner: "everything should let you empty out the field entirely and only snap back to minimum when you focus out".
**Every numeric settings field is a `<NumInput value min max step onChange …>`** (Settings: restart interval, the
rotation H/M/S, auto-mute delays + threshold, fps cap, demuxer MiB, VRAM limit MiB, scene transition delay, monitor
fps, A-sync offset; the playlist modal's H/M/S; the transition picker's duration + range max; `Combo`'s field —
normalization LUFS). While focused it shows exactly what was typed (empty, `-`, past min/max, partial) and only a
complete in-range number is committed (`onChange` → still live while typing, like every setting); an empty /
out-of-range draft is never saved. Blur or Enter → `clampNum` (empty → `emptyValue ?? min ?? 0`; integers unless the
step has a fraction) → committed + shown. Set without focus (a script / the matrix's `setValue`) → committed clamped
at once. Don't add a raw `<input type=number>` for a setting — use it (and its min/max are the backend's bounds).
**Transition duration floor = 0 ms** (`TRANSITION_MIN_MS`; was 50): 0 = a plain cut (the backend sends no effect —
`TransitionService.Pick` → null, legacy `TryStart` → false), 1–49 ms run the effect that fast (the player accepts any
`duration_ms`; its gains still ramp ≥ 30 ms, R42); the UI preview clamps its own loop to ≥ 100 ms. Guards: matrix
`num:clearToMin` (Demuxer max: emptied → stays empty and unsaved while focused → blur → 1 saved),
`num:overToMax` (fps cap 999 → unsaved while focused → blur → 480), `plTrShort` / `plTrZero` / `gTrShort` / `gTrZero` (+ `seq:…+next`: a
20 ms effect / 0 ms = a cut on the armed and the next switch); RED on the base UI: 12/12 (saved 0 / 999 at once; the
duration clamped to 50).

## Comment convention (grep these)
- `// PERF:` — perf-critical; don't naïvely "simplify" (usually content-visibility / memo / selector).
- `// COOL:` — motion/glow/UX intent.
- `// API:` — coupling to a backend endpoint/contract.

## Build / run / verify
- `cd app/ui && npm run build` (or `npm run dev` + `?api=<port>` in browser).
- Backend: `dotnet run --project src/backend -- serve` (writes `serve.port`).
- App: Electron `main.js` (dev uses `demos/shell/node_modules/electron`); package via electron-builder (Phase 7).
- **Self-test:** `electron app/shell/probe.js http://127.0.0.1:<port>` → prints PROBE_BROWSE/LIBRARY/SETTINGS counts.
