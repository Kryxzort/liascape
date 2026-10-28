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
- Card → modal morphs (Browse preview, library/strip settings): `components/useMorph.ts` (WAAPI, see
  "Settings-modal morph" below) — not framer's `layoutId` any more. framer-motion: `AnimatePresence`
  enter/exit on other modals/toasts, spring drag (dnd-kit) on the playlist strip.
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
- **Preview full-res:** `PreviewModal` lazily `api.detail(source, w)` → layers the card's own static (base)
  → `detail.previewUrl` (full-res, mounted once the morph `landed`, fades in) → the gif on top from the
  first frame, with the card's own `anim()` URL (it used `thumb()` — another image, so it restarted, and
  it mounted only after the morph). Morphs out of / back into its Browse card (`data-morph-id="br-…"`,
  `.lifted` while previewing). Needs the `source` prop.
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
  buttons persist immediately; unmount flushes a pending persist. **Speed slider is hidden for scenes
  under legacy** (LWE is 1×, so it'd be a no-op); with `playerEngine` lp-player it shows (a scene's speed scales its
  animation and its pitch-kept sound — matrix `itemSpd:scene`; it was hidden for every engine).
- **"Scene properties" in the item modal (`components/ScenePropsEditor.tsx`, `key={path}`; a scene item, not a
  multi-selection).** `api.sceneProps(path)` after the open-morph (`SETTINGS_MORPH.open` + 40 ms, like the duration row); one row per
  visible property (`data-scene-prop=<name>`): bool → checkbox, slider → range (+ value, `precision`), colour →
  `<input type=color>` (sent as `#rrggbb`), combo → the app's `Select`, textinput → text field; `group` → a heading,
  `text` → plain text (never HTML), not-editable types → greyed with their reason; a "Default" button on each
  overridden row + "Reset all". Same contract as volume/speed: slider/colour → local value at once + throttled
  `previewSceneProp` (~90 ms) + debounced persist (250 ms, per property); toggle/combo/reset persist at once; text
  persists debounced; the POST's answer (overridden flags, condition visibility) replaces the list; unmount flushes
  pending persists. Under legacy the backend's `note` shows ("applied when the scene starts").
- **Global Volume/Speed sliders (Settings page) drag-preview live too** (`useGlobalPreview` in
  `views/Settings.tsx`): each `onChange` → `setSetting` (the store's debounced 250 ms `/settings` save
  persists) + a throttled (~90 ms, trailing) `api.preview({volume|speed, global: true})` — the backend
  moves every live wallpaper that follows the global and never one with its own override. Before, the
  desktop only changed 250 ms after the drag stopped. Guard: matrix `globalDragVol` / `globalDragSpd`
  (a real 40-step drag, every source sampled every 40 ms).
- **Settings-modal morph (`components/morph.ts` + the `useMorph` hook, not framer — also the Browse
  preview's).** The surface that opened the modal (card
  `.thumb-wrap` / strip `.pl-item`) carries `data-morph-id` (`lib-…` / `pl-…` = `settingsMorphId`) and is
  `.lifted` (hidden) while the modal is out. WAAPI flights, both ways, **on `transform` (+ the body's opacity) ONLY**
  (2026-10-28, owner "why is morph so laggy" — see the perf note below). Every flight lerps one screen-space pose
  `{V, C, G, R}` between the source pose (`sourcePose(S, aspect)`: V = G = R = the source box, C = its cover box) and
  the rest pose (`restPose`: the media box, the panel, the body): **V** = the media's visible crop — the outer
  `[data-morph-media]` box (rounded, `overflow: hidden`, transform-origin 0 0) scaled NON-uniformly onto it; **C** =
  the whole picture — its one child `[data-morph-pic]` (holds every picture layer) counter-scaled inside so its net
  scale is uniform (C keeps the image's aspect at both ends, so its lerp never stretches); **G** = the panel's chrome —
  the panel draws nothing itself (`.morph-panel`: no background/shadow, a transparent border), its `::before` carries
  the background / border / radius / shadow, has its own layer (`will-change`), is rastered once and is scaled source →
  panel (`animate(…, { pseudoElement: "::before" })`); **R** = the body's clip — `bodyRef` is a `.morph-clip` wrapping
  `.modal-body`, scaled onto R (`overflow: hidden` only in flight, `[data-morph]`) with the body counter-scaled to stay
  put; the body fades in late / out early (opacity on the clip box). Nested scales interpolate per factor, not per
  product, so `flightFrames` SAMPLES the keyframes (the easing baked in, one per ~12 ms, `easing: "linear"`) — exact to a
  fraction of a pixel; `bezier()` evaluates the CSS cubic-bezier. Close re-measures the source (the strip may have
  scrolled) and lands on it, then `closeItemSettings` (source shown in the same render); off-screen/missing source →
  fade. Escape closes; a close while the open still flies starts from the pose it's in (`lerpPose` at the open's eased
  progress) and decelerates into the source (reversing replayed the ease-out backwards). The flight waits (panel
  hidden, ≤ 300 ms) until the picture's aspect is known — from the source's loaded still/gif/video at the click, else
  the modal's own copy loading — since a box re-laid out mid-flight jumps; a row that fills in late (the duration) is
  reserved, since the panel is centred and growing mid-flight moves the landing spot. The close lands one frame AFTER
  finishing (unmounting in the finishing frame never painted the landing pose).
  The media box layers the card's own `still()` (cached → frame 1 IS the card) and the card's gif URL (same image →
  same animation) from the first frame; **the sharp native image and the video preview mount once `landed`** (the
  video — often the wallpaper itself, 4K, software-decoded — starts where the card's hover video was + the open's
  duration, fades in on `playing`; `settingsSource`, read at the click), and a playing video is paused for the close.
  framer's `layoutId` used to scale one `<img>` between aspects (stretched mid-flight), flew a low-res
  still, and the strip's close vanished (the id was dropped at once, and the row clips). Guard:
  `scripts/test-ui-matrix.sh --probe probe-morph.js` (per-frame boxes through open + close from a library
  card, a strip item and a Browse card — a local WE item, offline: starts/ends on the source's crop,
  uniform aspect — the `[data-morph-pic]` box —, smooth, lands; the flight times; ≤ 30 % of the travel in the first
  quarter; rAF pacing vs the page's idle frame (median ≤ 1.25×, ≤ 15 % of frames > 2×); the preview animates; a close
  mid-open lands on the card).
  **Timing — TUNE in `morph.ts` `SETTINGS_MORPH`** (owner "slow down morph" → 620 ms "still too snappy", 2026-10-28):
  open 900 ms / close 700 ms, both `SOFT` = `cubic-bezier(0.37, 0, 0.63, 1)` (symmetric, sine-like: 25 % of the time →
  ~15 % of the travel; measured 18–19 % on screen). The 620 ms curve `(0.3, 0.7, 0.2, 1)` still did 67–76 % of its
  travel in the first quarter — that front-load, not the length, read as the snap. The Browse preview keeps
  `PREVIEW_MORPH` (430 / 340 ms, not asked for). The duration row, the scene properties (`open.duration + 40`) and App's
  `modal-open` gif freeze key off these numbers; the matrix's `keys:sliderHeld` waits 1400 ms for the landing (a real
  press hit-tests). No reduced-motion branch (the app has none; noted, not added). probe-morph asserts the settings
  flights move 780–1050 / 590–850 ms (measured 872–884 / 681–684) and the Browse one ≤ 520 ms (RED on the 620 ms UI: 8
  cells — 532–567 / 461–485 ms, 67–76 % in the first quarter).
  **PERF (measured 2026-10-28, `/tmp`-scratch probe on the matrix stack, 1920×1080 Xvfb, `--disable-gpu
  --enable-unsafe-swiftshader` = main.js's NVIDIA branch, Chromium tracing):** the owner's UI is software-composited, so
  every animated pixel is CPU work. Before: the ghost's left/top/width/height/border-radius (+ its 60 px shadow) and the
  clip-path re-crops on the media + the body ran on the main thread (`compositeFailed` 8192/8224 = unsupported
  property) and re-rastered every frame — a 4K video item's open: viz draw 5.0 ms + raster ≈ 7.4 ms + main 1.2 ms per
  frame (≈ 13.6 ms of CPU a frame; raster 282 ms over the flight), plus the 4K preview video decoding from the first
  frame. After: every flight animation composited (`compositeFailed` 0 — an element that paints nothing gets 131072
  "no visible change", hence `.morph-pic`'s own background), viz draw 3.0 ms + raster ≈ 0.1 ms + main 0.7 ms per frame
  (raster 8 ms over the flight). Both hold 60 fps on the 60 Hz Xvfb (rAF median 16.7, p90 16.7); uncapped
  (`--disable-frame-rate-limit`) the compositor floor of this software path at 1080p is ~3.5–4 ms/frame for ANY
  animation (a 40 px box costs 4.1 ms: it redraws the whole frame), so 144 Hz is in reach and 240 Hz (4.17 ms) is at
  the floor — the remaining cost is the software compositor itself, not the morph. Keep it that way: no
  size / radius / shadow / filter / clip-path animation in a flight, nothing heavy mounting mid-flight.

## Hardware GL on NVIDIA (checked 2026-10-28 — default unchanged: software)
`main.js` still puts NVIDIA on `disable-gpu` + SwiftShader (memory `nixos-electron-ozone-x11`: native Wayland → the
surface via Vulkan, rejected; XWayland → GPU-process segfault). Hermetic check (no display: `--ozone-platform=headless`,
an offscreen window animating + WebGL, 5 s) with the store's electron 42.11.18 (the flake's `electron_42`) and 44.9.3 on
the RTX 3070 Ti (open module 595.84): the default backend's GPU process exits during init ("disabled due to frequent
crashes" — headless has no default GL), but **`--use-angle=gles-egl` (NVIDIA's EGL, "OpenGL ES 3.2") and
`--use-angle=vulkan` bring up full GPU compositing + raster + WebGL with no GPU-process exit** on both versions. That
does not exercise the window's presentation path (Wayland surface / XWayland present — where both crashes were), which
can't be driven hermetically (no headless Wayland compositor here; Xvfb has no NVIDIA GL), so it's not proof and the
default stays. To try it: `LP_HWGL=1 LP_ANGLE=gles-egl livepaper-ui` (both env vars already exist in `main.js`; EGL, not
Vulkan, for the surface); if the window shows and stays up, the GPU composites the UI and the CPU cost per frame measured above goes away.

## Backend-owned state the store mirrors (UI × player-state matrix findings)
- **Settings**: every save posts the store's WHOLE `settings` → the store must hold what the backend
  changed itself: WS `settings-changed {fields}` → `mergeSettings` (a keybind volume-up was reverted by the
  next UI save). `setSetting`'s debounced save posts `get().settings` at fire time, not its own snapshot.
- **Playlist strip**: trash/undo change the backend's playlist → `trashItems` drops the items first (a
  pending strip save can't put them back), both re-read it via `syncPlaylist()`. Another client's
  `POST /playlist/state` (a script, an agent) → WS `playlist-changed {client}` → `syncPlaylist()`; every POST
  carries the page's `X-LP-Client` id (`api/client.ts` `CLIENT_ID`) so a page skips the echo of its own save.
- **Backend restart under an open page → `store.resync()`** (2026-10-28: "Library is empty" while a wallpaper played).
  Everything the store mirrors — sources, themes, settings (+ theme vars), `/current`, library, strip (paths +
  settings + name), playlist names, undo depth, Steam status — is read by ONE `resync()` (`readBackend`): at start
  (`init` retries it — 250 ms doubling to 2 s — while a CORE read — sources, themes, settings, current, library,
  strip — fails for want of a backend: a `TypeError`, not an HTTP error; names / undo depth / Steam never hold it up) and on every WS reopen after the first (`useEvents(onEvent, onReconnect)` → `App.tsx` `onReconnect`; also
  reloads a Browse list the outage left empty). Each piece is applied only when ITS read succeeded — never `[]` for a
  failed read (init used to `.catch(() => [])` the library) — and a strip / settings edit still waiting for its debounced
  save keeps the local copy (`stripSavePending` / `settingsSavePending`). Overlapping calls coalesce into one more pass.
  The incident: `dotnet watch` restarted the dev backend on a cherry-pick that also changed `api/client.ts`; Vite's HMR
  re-created the store (empty) and re-ran `init` into the outage (journal: `hmr update /src/App.tsx …` 13:11:21, backend
  `Exited` 13:11:26, listening 13:11:29) — `init` failed and nothing ever re-read; the backend's startup
  `library-synced` broadcast fires before any page has reconnected, so it never helped. The backend serves the whole
  library from its first request (`LoadAll` scans the folders per call — there's no lazy index load). Guard: matrix
  `restart:backend` (idle/playlist: backend down 3 s under the open page — an item added, the strip and
  `thumbnailAspect` changed on disk meanwhile → the page shows all three, and the new backend's first `/library` is
  whole), `restart:midLibrary` (the page's first `/library` held, the backend SIGKILLed under it, then back),
  `restart:initDown` (the built UI from `file://…?api=<port>` — the dev topology — started while the backend is down).
  All three were RED before the fix.
- **Origin**: production = `http://127.0.0.1:<backend port>`; `main.js` reuses the last port while free
  (`LP_PORT`) so localStorage prefs survive a relaunch; WS connects to `location.origin` when `API` is "".
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
  Drags that need real hit-testing go through `webContents.sendInputEvent` (the strip's dnd-kit reorder).
  **Scene cells (Phase 2 Task 12).** `test-ui-matrix.sh` seeds three synthetic WE scenes into the private library
  (`library/workshop/90000000{1,2,3}`, titled s1–s3 in that source's `index.json`, 320×180 previews; the worker's
  synthetic renderer: s1 red + 440 Hz, s2 blue + 660 Hz, s3 crashing 1.5 s after every start), runs its player with
  `LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1` + `LP_SCENE_WORKER_BIN` and `LP_PLAYER_VRAM_PROBE=fake:<file>` (healthy unless a
  cell writes a worker's MiB into it; short `LP_PLAYER_VRAM_TIMING`). Scene support stays **off** in the baseline (the
  library-stepping / random cells would land on scenes, s3 crashes) — the opt-in states `scene` (s1 alone), `sceneV`
  / `sceneS` / `sceneS2` (the playlist [k1, s1, s2, k2] at k1 / s1 / s2) and every scene control turn it on before
  the UI loads; each cell starts with the scenes unmarked (index rewritten) and the fake VRAM healthy. Cells (oracle in
  brackets — `state.workers[]` pid / `fps_target` / `audio.gain_db|no_audio|speed`, player props, the index, the UI):
  `apply:scene` (idle/single/playlist: a card click → kind scene, ready, a live worker, `/player-engine.scenes`),
  `next:v→s|s→s|s→v:<full-live|reveal|frozen>` (the started switch's `method`, its handoff, the outgoing scene's
  worker reaped), `pause:scene` (no frame latched, the scene clock still, captures 500 ms apart identical, `gain.pause`
  −96), `mute:scene` / `volume:scene` / `itemVol:scene` / `itemSpd:scene` / `noAudio:scene` (the worker's stream, same
  pid), `trash:playingScene` (scene / sceneS), `crash:scene` (s3 from the strip → `source.broken`, index `crashed`, its
  card marked, the strip's next plays), `noOutput:scene` (parked with the worker kept, shown again on replug),
  `settings:sceneFps` (Monitors → `out:VIRTUAL-1.scene_fps` 45 + `fps_target`), `settings:sceneThrottle|vramLimit|
  vramLowMode` (the GPU / VRAM group → `player.*`, same pid), `vram:exceeded` (the fake reports s1's worker at 2000 MiB
  > 1536 → the rotation advances, not marked crashed, the status bar's text), `playlist:sceneInterval` (a 4 s interval
  advances off a scene), `restore:scene` (the backend restarted on the same port — `LP_PORT` — the scene stays, same
  worker; the probe kills only the backend the stack started and records its replacement in `backend2.pid` for the
  cleanup); **`sceneProp:set|switch|restart|reset`** (s1's project.json declares `color` — the synthetic renderer's
  WE-encoded colour, red by default —, `clock`, and `bars` shown while clock is on; oracle: a pixel of s1's own
  source, its `scene_props`, `workers.properties`, the index): set in the modal → green live on the same worker,
  persisted, a toggle hides its dependant; saved before s1 opens → green at open, after s2 and back (a new source) too;
  a compositor SIGKILL → the restored scene green; "Default" → red live (the default sent), dropped from the index.
  `allowErr(e)` lets a control's own `source.error` through (crash, VRAM). `matrix-cells-for.sh`: the scene
  worker / `scene/` / `worker/` / `vram.rs` / their probes → the scene family. Fuzz excludes them (their fixtures).

## Advance-on-end play-time limits (2026-10-28)
Settings → Rotation: "Minimum play time" / "Maximum play time" rows right under "Switch when video ends" (greyed while
it is off), and the same pair in the playlist-settings modal (`.pl-playtime`, inside the override block, greyed unless
override + advance-on-end). Both are `components/PlayTimeInput.tsx`: a seconds field (0 = off) with its h/m/s reading;
**free typing (emptiable); only a complete in-range number commits live; clamped 0…359999 and saved on blur /
Enter** (the owner's number-input rule; Escape drops the draft) — the props of the shared `NumInput` (min / max / step
/ value / onChange, another lane's, not on lp-player yet): swap its inner `<input>` for it at the merge. Semantics: `player-adapter.md` §
Play-time limits. Matrix cells drive them with `setValue` + a `focusout`.

## Settings page under lp-player (Phase 2 scenes)
`views/Settings.tsx` reads `GET /player-engine` on mount and after an engine or "Allow scene support" change;
while `active === "lp-player"` (`lpActive`): "Scene transition delay" is hidden (the player switches once the
scene's first frame is in — no lead), the Monitors (scenes) rows drop the **primary** radio (one scene worker
for every output; its sound is one stream) and label the fps **"fps (live)"** (the backend sets
`out:<name>.scene_fps` on save), and a scene that can't play shows `scenes.reason` under the toggle. Legacy:
unchanged. **GPU / VRAM** (a section shown only under lp-player; every row live — `player-adapter.md` § Scenes):
"Auto-throttle scenes" (`sceneThrottle`), "Limit VRAM per scene" (`sceneVramLimitEnabled`) + "VRAM limit (MiB)"
(`sceneVramLimitMib`, shown while it's on), "When VRAM runs low" Stop (free memory) / Pause / Off (`vramLowMode`); while
Settings is open under lp-player it re-reads `/player-engine` every 5 s and says so when `vram.low_active` (the player's
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
`keys:sliderHeld` (idle, single — a real mouse press on the item modal's volume slider via `sendInputEvent`, two
cards selected, then f/F/Delete/Escape/Right: no outline/glow on the held slider, the modal stays open, the value
doesn't step, nothing trashed, no keyboard ring after the release; RED on the base UI: the outline `auto` + Escape
closed the modal).

## Missing pieces warn on their rows (`views/Settings.tsx` `WarnIcon`, owner todo 2026-10-28)
"Make missing libraries fail loudly — if a feature won't work because of something in the build, show a warning icon".
Settings reads `api.featureHealth()` (`GET /health/features`, web-backend.md — the feature/dependency table) 300 ms
after mount, after an engine / scene-support / steamcmd change and every 15 s; `HealthCtx` maps each settings key a
broken feature (`ok === false`) `affects` → its reasons. `Row` renders `<WarnIcon k={wk ?? rk}>` right after its label
(an amber `AlertTriangle`, `.s-warn`, `title` = the reason(s), `data-feature-warn=<key>`) — **the control itself stays
shown and usable** (never hidden or disabled for it). `wk` names the key for a row without `rk` (the steamcmd rows).
A summary (`[data-health-summary]`, `.health-sum`) on top lists the broken features that are **in use** (`inUse`:
switched on / selected — so a missing steamcmd for a Steam-subscription user, or playerctl with the MPRIS option off,
is a row icon only). `ok: null` (not known — the GPU interop before a player ran) shows nothing. Not wired: the
playlist modal's own Transitions button (the global Transitions row carries the icon). Guard: `--probe
probe-health.js` (below in web-backend.md; RED on the base UI: 8 rows without an icon, no summary).

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
- Backend: `dotnet run --project src/livepaper -- --serve` (writes `serve.port`).
- App: Electron `main.js` (dev uses `demos/shell/node_modules/electron`); package via electron-builder (Phase 7).
- **Self-test:** `electron app/shell/probe.js http://127.0.0.1:<port>` → prints PROBE_BROWSE/LIBRARY/SETTINGS counts.
