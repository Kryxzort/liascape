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
- **`app/shell`** — Electron: `main.js` spawns `livepaper --serve`, reads `serve.port`, loads the UI
  same-origin (`LP_UI_DIR` → C# serves the dist). `probe.js` = headless self-test (offscreen window,
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
- framer-motion: card→preview `layoutId` morph (wrap grid in `<LayoutGroup>`), `AnimatePresence`
  enter/exit on modals/toasts, spring drag (dnd-kit) on the playlist strip.
- Re-bench Browse/Library at ≥120 visible after glow/motion changes (the `demos/` harness still works).

## Icons + component patterns (parity-polish pass)
- **Icons = `lucide-react`**, never emoji. Size 14–16px, `fill/stroke=currentColor` so theme
  accent/danger + glow flow through. Helper class `.ico` (inline-flex, gap) for icon+label buttons;
  `.mini` already centers an icon-only button. Probe asserts `svg.lucide` count + `emojiInBody==false`.
- **Per-wallpaper settings modal is lifted to the store** (`settingsItem`/`settingsSiblings`,
  `openItemSettings(item, siblings?)`, `closeItemSettings()`), rendered ONCE in `App.tsx`. Both
  `LibraryCard` and the playlist-strip context menu open it. Don't re-add local modal state.
- **Strip context menu = `position:fixed` at cursor coords** (`{x,y}` from the `contextmenu` event):
  the `.pl-item` clips overflow, so an absolutely-positioned menu would be hidden. `.pl-ctx` opens
  upward (`translateY(-100%)`) since the strip sits at the bottom.
- **`PlaylistToggle.tsx`** = inline SVG of `PlaylistToggleGeometry` (unchecked = accent ring;
  checked = accent fill with checkmark cut out via `fillRule=evenodd`). currentColor → hover brightens.
- **Library card = compact title-overlay fork** (`.lib-title`, no below-thumb `.title`); trash + toggle
  sit above the 44px bar.
- **Preview full-res:** `PreviewModal` lazily `api.detail(source, w)` → layers thumb (morph anchor) →
  `detail.previewUrl` (full-res, fades in) → animated gif on top. Needs the `source` prop.
- **Native pickers:** `app/shell/preload.js` exposes `window.lp.pickFolder()/pickFile()` →
  `ipcMain "lp:pick"` → `dialog.showOpenDialog`. Settings "Browse" buttons use it; `window.lp` is
  undefined in a plain browser → falls back to the text input.
- **Animated library/strip previews (`MotionThumb.tsx`):** library items expose
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
  `{x,y}`. A grid card has `contain:content` (paint containment) and the strip has `backdrop-filter` —
  both create containing blocks that otherwise trap `position:fixed` inside them. Same reason the
  playlist Save/Load/Settings modals are portal'd out of `.strip` (they were landing off-screen).
  **A portal still bubbles through the React tree:** a menu declared inside a clickable element
  (the `.pl-item`, whose `onClick` is `playFrom`) receives every menu click too — opening
  "Settings (volume / speed)" from the strip restarted playback from that item. Wrap the portal
  content in a `display: contents` element that `stopPropagation`s click/contextmenu/pointerdown/
  keydown, or declare the portal outside the clickable element (`LibraryCard` does). Guard:
  `electron app/shell/probe-plmenu.js "http://localhost:5173/?api=<port>"` (stubs playback +
  `/open`, so it never touches the live wallpaper or opens a window).
- **`useSmoothScroll(ref, axis)`** (`hooks/`) — smooth wheel scrolling (wheel→velocity, rAF ease,
  friction 0.85). Wire on every `.scroll` container + the horizontal `.strip-row` (`"x"`).
- **Never set `scrollbar-width`/`scrollbar-color`** — Chromium ≥121 then ignores `::-webkit-scrollbar`
  and you lose the rounded thumb. webkit-only.
- **`thumb(u)`** (`api/client.ts`): local file path → `/media`, `http(s)` → `/img` proxy. Use for
  Browse cards (WE-local hands absolute paths; `img()` alone → blank thumbnails). Library/playlist
  items are always local → `MotionThumb` uses `media()` directly.
- **Browse gif = layered, not `src`-swapped**: keep the gif `<img>` mounted (opacity-toggled) so
  hover/AutoPlayGifs never restarts it. Same `active = hover || (autoPlayGifs && hasGifAsset)` rule.
- **`PlaylistToggle` checked tick** = a `<mask>` (white box − black checkmark), not an evenodd path
  (Chromium can render evenodd filled). `useId()` for the mask id.
- **Selection (library)**: no toolbar — card trash/toggle/settings repeat to the whole selection when
  the card is selected (`targetsFor`). Ctrl+A/Delete bail while typing (`typing()`);
  click on `.scroll`/`.grid` background clears. Browse keeps its small Download/Cancel `.sel-toolbar`.
- **`StatusBar`** (`components/StatusBar.tsx`) = persistent bottom bar (status / playing / Ready + Undo).
- **Open-in-FM + duration** are backend (need FS): `AppOps.RevealLibraryItem` (resolve symlink/scene
  dir) + `GET /library/duration` (ffprobe). Frontend passes `isScene/workshopId/copiedSceneDir`.

## Round-3 patterns (live wallpaper bg, translucency, app dropdowns, drag-preview)
- **`WallpaperBg.tsx`** — the LIVE wallpaper played behind the UI (`position:fixed`, z-0), gated by the
  `WallpaperBgAllTabs` advanced setting. A **single persistent `<video>`** (no crossfade — `src` swap is
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
- **`LibrarySettingsModal`** (lifted to the store, rendered once in `App.tsx`): the volume/speed sliders
  **drag-preview live, persist on release**. Each `onChange` → optimistic `patchLibraryItem` (instant
  bg/cards) + **throttled** `api.preview({volume|speed, paths: targets})` (~90ms) + **debounced** persist
  `api.libraryVolume|Speed` (250ms after the last tick → one index write; **one timer per field** — a
  shared one let a speed drag drop the volume drag's save). **The preview names the edited item(s)**: the
  backend moves exactly their sources, wherever they are, and nothing when none is live — never "what's
  playing" (mid-transition that's the incoming side: a drag on A moved B and left it there). No UI
  "is it playing" gate either (the store's `playingPath` is one side of a transition). Guard:
  `electron app/shell/probe-preview.js "http://localhost:5173/?api=<port>"` (stubs every write). Reset
  buttons persist immediately; unmount flushes a pending persist. **Speed slider is hidden for scenes**
  (LWE is 1×, so it'd be a no-op).
- **Global Volume/Speed sliders (Settings page) drag-preview live too** (`useGlobalPreview` in
  `views/Settings.tsx`): each `onChange` → `setSetting` (the store's debounced 250 ms `/settings` save
  persists) + a throttled (~90 ms, trailing) `api.preview({volume|speed, global: true})` — the backend
  moves every live wallpaper that follows the global and never one with its own override. Before, the
  desktop only changed 250 ms after the drag stopped. Guard: matrix `globalDragVol` / `globalDragSpd`
  (a real 40-step drag, every source sampled every 40 ms).
- **Settings-modal morph (`components/morph.ts`, not framer).** The surface that opened the modal (card
  `.thumb-wrap` / strip `.pl-item`) carries `data-morph-id` (`lib-…` / `pl-…` = `settingsMorphId`) and is
  `.lifted` (hidden) while the modal is out. WAAPI flights, both ways: the media box (`[data-morph-media]`,
  transform-origin 0 0) moves with ONE uniform scale onto the cover-box of the source while a clip-path
  `inset()` re-crops it to the source's visible crop (so it never stretches between a 16:9/square card crop
  and the image's own aspect); a fixed `.morph-ghost` with the panel's bg/border/shadow grows source →
  panel (the panel is see-through meanwhile, `[data-morph]`); the body is clipped to the growing ghost
  (a `polygon()` clip — `inset()`s summing past the box get scaled down and stop tracking) and fades in
  late / out early. Close re-measures the source (the strip may have scrolled) and lands on it, then
  `closeItemSettings` (source shown in the same render); off-screen/missing source → fade. Escape closes.
  The media box layers the card's own `still()` (cached → frame 1 IS the card), the sharp native image,
  and the playing preview: the card's gif URL (same image → same animation) or the video, started where
  the card's hover video was (`settingsSource`, read at the click — the card's layer unmounts on open).
  framer's `layoutId` used to scale one `<img>` between aspects (stretched mid-flight), flew a low-res
  still, and the strip's close vanished (the id was dropped at once, and the row clips). Guard:
  `scripts/test-ui-matrix.sh --probe probe-morph.js` (per-frame boxes through open + close from a card and
  a strip item: starts/ends on the source's crop, uniform aspect, smooth, lands; the preview animates).

## Backend-owned state the store mirrors (UI × player-state matrix findings)
- **Settings**: every save posts the store's WHOLE `settings` → the store must hold what the backend
  changed itself: WS `settings-changed {fields}` → `mergeSettings` (a keybind volume-up was reverted by the
  next UI save). `setSetting`'s debounced save posts `get().settings` at fire time, not its own snapshot.
- **Playlist strip**: trash/undo change the backend's playlist → `trashItems` drops the items first (a
  pending strip save can't put them back), both re-read it via `syncPlaylist()`.
- **Origin**: production = `http://127.0.0.1:<backend port>`; `main.js` reuses the last port while free
  (`LP_PORT`) so localStorage prefs survive a relaunch; WS connects to `location.origin` when `API` is "".
- Guard: `scripts/test-ui-matrix.sh` (every control × every player state through the real UI, hermetic).

## Comment convention (grep these)
- `// PERF:` — perf-critical; don't naïvely "simplify" (usually content-visibility / memo / selector).
- `// COOL:` — motion/glow/UX intent.
- `// API:` — coupling to a backend endpoint/contract.

## Build / run / verify
- `cd app/ui && npm run build` (or `npm run dev` + `?api=<port>` in browser).
- Backend: `dotnet run --project src/livepaper -- --serve` (writes `serve.port`).
- App: Electron `main.js` (dev uses `demos/shell/node_modules/electron`); package via electron-builder (Phase 7).
- **Self-test:** `electron app/shell/probe.js http://127.0.0.1:<port>` → prints PROBE_BROWSE/LIBRARY/SETTINGS counts.
