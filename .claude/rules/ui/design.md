---
paths:
  - "app/ui/src/components/**"
  - "app/ui/src/views/**"
  - "app/ui/src/hooks/**"
  - "app/ui/src/App.tsx"
  - "app/ui/src/App.css"
  - "app/ui/src/index.css"
  - "app/ui/src/main.tsx"
---

# UI design rules (React renderer, `app/ui/src`)

The owner's look-and-feel decisions and why: `docs/decisions.md` § UI.
The bar: the UI itself is a work of art (`docs/decisions.md` § "Make the UI itself a work of art") — consistent and correct is
the floor; a new element is designed to delight within the toggles and the frame budget.

## Every new UI element (a panel, row, control, badge or overlay) — done only when all hold
- **Theme**: colours only from the theme vars (`--accent`, `--accent-fg`, `--accent-hover`, `--text`, `--subtext*`, `--bg-*`, `--surface*`, `--danger`, `--success`, `--warn`); never a hard-coded colour.
- **Glow**: hover / active / focused / "on" states glow like their neighbours through `var(--glow)` / `var(--glow-sm)`, or add the element's own glow override to the `:root.no-glow` block at the end of `index.css`.
- **Motion — nothing pops**: appear/leave (transform + opacity; keep exits mounted with `hooks/useLinger.ts`), position changes glide, size/state changes morph (framer `layout` or a FLIP like `hooks/filterMorph.ts`), content changes slide or cross-fade, chevrons ROTATE with the springy overshoot (one icon, never a swap), numbers and bars ease.
- **Motion off**: `:root.no-motion` (the "Smooth window animations" toggle AND `prefers-reduced-motion`) makes all of it instant — CSS under `:root.no-motion`, components through `useMotion()` (`components/motion.ts`), `motionOn(settings)` outside React. Never read `settings.morphs` directly.
- **Transparency**: panel/menu fills through `--tr` / `--tr-strong` (`color-mix(… P%)`, P = opacity). Under `:root.bg-live` (live wallpaper behind every tab) a docked panel has no fill of its own: its cards carry the darkness, text over the wallpaper gets `filter: drop-shadow(0 0 3.5px #000)`.
- **Controls**: the themed checkbox/radio (inside `.ck`, `.settings` or `.side-panel`), `components/Select.tsx` (never a native `<select>`), `components/NumInput.tsx` (never a raw `<input type=number>` for a setting), `app/ui/src/components/Segmented.tsx` for any pick-one-of-a-few switch (its sliding highlight, keys and variants; never a row of buttons with an `.on` fill of their own), lucide icons (never emoji) centred — measure it.
- **Placement**: a fixed overlay inside a card, the playlist bar or a transformed parent portals to `<body>`; pick its z-index against the existing layers in `index.css` (bar glow / filter drawer 45, Steam to-do and drawer 46, modals 50, selection toolbar 55, locator 85, dropdowns 90/91).
- **Proof**: a probe cell covering motion on/off (per-frame samples that pass through in-between states), `no-glow` and `bg-live`, and mid-animation screenshots you LOOKED at. Procedure: the `ui-verify` skill.

## Icon motion (spec: `docs/superpowers/specs/2026-11-12-icon-motion-design.md`)
- Give every icon its role's motion, never a one-off: act (a verb plays its meaning once on hover — `app/ui/src/components/iconMotion.ts` RECIPES by lucide class), hold (trash lid / folder flap / X / crosshair open while hovered — index.css § icon motion), direction (one nudge; Play launches — out to the right, a fresh one springs in, one accent ring ripples off its button), disclosure (chevrons rotate), object (tilt while hovered — the default), status (glow only, never moves), progress (the only loops), toggle (the new state pops once on a user change, never on mount).
- Start every one-shot from the icon's rest state (first keyframe = rest), even a "pop in": a first keyframe off rest jumps the moment the hover lands. Guard: probe-icons `icon:act:*` (starts at rest).
- Time it with the `:root` springs only: `--spring` / `--spring-dur` for an icon's gesture, `--spring-soft` / `--spring-soft-dur` for turns and returns, `--press-dur` for the press; never a new cubic-bezier for an icon.
- Every icon button squeezes on press through the `scale` property alone (it composes with the rest); a new state-glyph control (like `.seg-opt`, `.ns-btn`, `.wf-seg`) joins the exclusions in both index.css and `iconMotion.ts` SKIP.
- A part that must move on its own (a lid, a flap) uses lucide's SVG children or a two-part icon from `createLucideIcon` (`app/ui/src/components/icons.ts`); no other icon library.
- The magnet (`ref={magnetRef}`, `app/ui/src/components/magnet.ts`) only on a primary action, never on a list's items.
- Guard: `--probe probe-icons.js` (a new acting icon gets an `icon:act:<name>` cell).

## Performance
- Keep `content-visibility:auto` on every grid card and playlist bar item (`.pl-item`), each holding its real size while skipped: a card's height from its `aspect-ratio` with `min-height: 0` (no intrinsic or remembered height props it taller), a bar item's from `contain-intrinsic-size`. A placeholder of another height moves every row the user hasn't seen, and a kept scroll offset lands on another row. Guard: probe-layout `tabs:keep`, `tabs:browse`.
- Never write a measured size into a custom property on `.app` or `:root` that changes on a tab switch: every element inherits it, so each write restyles the whole page. Position against the element itself (`anchor()`, as the sidebar does to `.topbar`), and skip a write that didn't change. Guard: probe-layout `perf:tabs`.
- Cards are `memo`'d and read their own slice (`useStore(s => …)`); never lift per-card state into a parent that re-renders the list. Stable keys (`pageUrl` / `videoPath`).
- Hand a list's cards one handler per action that takes the item (`app/ui/src/hooks/useStableFn.ts`), never a fresh closure per card: it re-renders every card on any change of the list. Guard: probe-layout `perf:sidebar`.
- The Library page and the playlist bar stay mounted across tab switches, hidden by `<Activity>` (`App.tsx`): reset what a fresh page starts without (a selection) on leaving (`app/ui/src/hooks/useResetOnLeave.ts`), keep its scroll offset (the browser brings it back with the page), and scope a rule that reacts to a page's parts to the shown page (`.app[data-page=…]`, as the sidebar's docking does). Guard: probe-layout `tabs:keep`, `perf:tabs`.
- Browse is built on each visit and comes back as it was left: its list lives in the store (no request on the way back), its offset in `app/ui/src/hooks/useKeptScroll.ts`, restored in a ResizeObserver's first callback (from the first frame, nothing forced) and only onto the same view; another source, search, filter or sort starts at the top (`browseFor`, the request the shown list answers). Guard: probe-layout `tabs:browse`.
- Never measure layout in a mount effect (it forces the new page's layout inside the click): size from a ResizeObserver callback, or read on the user's next input. Guard: probe-layout `perf:tabs`.
- Animate transform / opacity / filter only. Glow is a static shadow toggled by state (pulse via opacity on a composited layer); never animate a blur radius. No `backdrop-filter: blur`.
- Decode or animate nothing while `!appActive` (the store's focus/visibility flag) — it caused the main-thread freeze.
- The page has 6 connections to the backend (Chromium, HTTP/1.1) and slow `/img` loads can hold them all: a list being replaced drops at once and its cards abort their unfinished image loads (`components/Card.tsx`), or the next API call queues behind them. Guard: matrix `browse:switchSource`.
- Bulk-autoplay gif/webp previews; a video preview plays on hover, or under "Animate wallpapers without a GIF" every one on screen, as a small `clip()` (`/clip`), never the full file: a full-size `<video>` holds one of the 6 connections while it plays. Guard: matrix `appear:videoThumbs`.
- Keep a gif `<img>` mounted once it has shown and hide it (`visibility: hidden` or opacity 0: unpainted, so none of its frames decode); never unmount it or swap its `src`: either restarts the gif (`components/MotionThumb.tsx` keepHidden). Guard: matrix `appear:gifResume`.

## Interaction rules
- Tooltips (`title=`) only when they tell something you can't see (an unclear icon-only control, a warning's reason, a setting's explanation, a value a short form hides). Never one that repeats the label, explains a click, names an obvious icon, or sits on cards / bar items. Icon-only controls always get an `aria-label`.
- Focus rings only while tabbing: `.kbd-nav` (set by `hooks/focusRing.ts`). Never add a focus style that bypasses it. Guard: probe-sidebar `look:focusRing`.
- No item context menus: a right-click focuses the item's sidebar without applying it (`focusLib` / `focusBrowse`).
- The item sidebar's focus lives in the store by PATH / page URL (`libFocus` / `browseFocus`); per-open work keys on it so a `library-item-changed` never replays an animation. Guard: probe-sidebar `lib:still`.
- A portal still bubbles through the React tree: wrap portal content in a `display: contents` element that stops click/contextmenu/pointerdown/keydown, or declare it outside the clickable parent. Guard: `--probe probe-plmenu.js`.
- While a slider is held, swallow every key (`hooks/rangeDrag.ts`, `shortcutsBlocked()`). Guard: matrix `keys:sliderHeld`.
- Grid keys go through `gridOwnsKey` (`hooks/gridKeys.ts`): never while a menu, dropdown, modal or held slider owns them.
- Sliders drag-preview live (throttled ~90 ms `api.preview` naming the edited items' paths) and persist debounced (250 ms, one timer per field); unmount flushes a pending persist.
- A numeric field shows exactly what is typed while focused, commits only a complete in-range value, and clamps on blur/Enter (`NumInput`). A transition duration of 0 ms is a cut.
- A Settings row whose only control is a checkbox/radio is a `<label>` (click anywhere ticks it).
- A missing dependency shows a `WarnIcon` on its row (`components/FeatureWarn.tsx`); the control stays usable.
- The password field in `components/SteamPasswordModal.tsx` is uncontrolled: read once on submit, emptied, never in React state or the store.
- Smooth wheel scrolling: every `.scroll` container and the playlist bar row takes the ref `useSmoothScroll(ref, axis)` returns (it fills `ref` too, and binds whenever the element appears); notched wheels glide, touchpads and motion off scroll natively. Never set `scrollbar-width` / `scrollbar-color` (Chromium then ignores `::-webkit-scrollbar`).
- Settings levels: a row's level comes from `LEVEL_OF_KEY` in `src/settingsLevel.ts` (or `Row`'s `lv`); hidden settings stay saved and live. Tests find rows by label (`m.row(label)`), so a rename updates `app/shell/probe-*.js` too.

## Comment tags (grep these)
- `// PERF:` perf-critical — don't "simplify". `// COOL:` motion/glow intent. `// API:` coupling to a backend contract.
