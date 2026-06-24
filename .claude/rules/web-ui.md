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
  bg/cards) + **throttled** `api.preview({volume|speed})` (~90ms, gated to "edited item == playing") +
  **debounced** persist `api.libraryVolume|Speed` (250ms after the last tick → one index write). Reset
  buttons persist immediately; unmount flushes a pending persist. **Speed slider is hidden for scenes**
  (LWE is 1×, so it'd be a no-op). The card→modal `layoutId` morph anchors the SAME `still()` src the card
  uses (morphs from the thumbnail, not flying in from the side).

## Comment convention (grep these)
- `// PERF:` — perf-critical; don't naïvely "simplify" (usually content-visibility / memo / selector).
- `// COOL:` — motion/glow/UX intent.
- `// API:` — coupling to a backend endpoint/contract.

## Build / run / verify
- `cd app/ui && npm run build` (or `npm run dev` + `?api=<port>` in browser).
- Backend: `dotnet run --project src/livepaper -- --serve` (writes `serve.port`).
- App: Electron `main.js` (dev uses `demos/shell/node_modules/electron`); package via electron-builder (Phase 7).
- **Self-test:** `electron app/shell/probe.js http://127.0.0.1:<port>` → prints PROBE_BROWSE/LIBRARY/SETTINGS counts.
