# Icon motion vocabulary — design

Covers every lucide icon in `app/ui/src` (and the two hand-drawn ones: the Browse card's download arrow, the playlist
toggle). Why: `docs/decisions.md` § "Make the UI itself a work of art". The rule that keeps it: `.claude/rules/ui/design.md`
§ Icon motion. Code: `app/ui/src/index.css` § "icon motion", `app/ui/src/components/iconMotion.ts`,
`app/ui/src/components/magnet.ts`, `app/ui/src/components/icons.ts`. Guard: `app/shell/probe-icons.js`.

## The problem it fixes
Icons moved by accident of who built the control: download arrows bobbed in a loop, "go to playing" turned and grew, section
chips grew and tilted, one arrow slid 3 px, and everything else (top-bar buttons, playlist toggle, delete, mini buttons,
chevrons, external links, folder, trash, copy, refresh, stop, mute…) stood still. Same meaning, different motion; most of
the app none at all.

## Physics: one set of springs
Every icon motion settles on a damped spring — it overshoots and comes back, it never just stops. The curves are sampled into
CSS `linear()` once, as custom properties on `:root` (index.css), and JS reads the same properties (`iconMotion.ts`
`tokens()`), so there is one source:

| token | what | use |
|---|---|---|
| `--spring` / `--spring-dur` (650 ms) | ζ ≈ 0.42, ~23 % overshoot | an icon's own gesture (a nudge, a drop, a pop, a lid) |
| `--spring-soft` / `--spring-soft-dur` (500 ms) | ζ ≈ 0.62, ~8 % overshoot | bigger turns (chevrons, a refresh spin's landing, the magnet's release) |
| `--ease-icon-out` | `cubic-bezier(.2, .9, .3, 1)` | the first half of a one-shot (the "throw" before the spring catches it) |
| `--press-dur` (70 ms) | — | the press squeeze going in (out is `--spring`) |

Small moves only: a gesture travels 2–5 viewBox units (a 16 px icon: 1.5–3.5 px); a turn is 90°–360°.

## Roles

| role | icons | on hover | held state |
|---|---|---|---|
| **act** — a verb, the icon plays its meaning once | download, cloud-download, upload, external-link, copy, refresh, reset (rotate-ccw), undo, save, stop (square), sparkles, check-check, star, sliders, volume, cloud-off, locate | one-shot (WAAPI, `iconMotion.ts`), plays to the end even if the pointer leaves | — |
| **hold** — an object that opens while pointed at | trash (lid lifts, hinged left), folder (the front flap falls open), close / remove (X turns 90°) | — | CSS transition on `--spring`; leaving closes it on the same spring |
| **direction** — it says where you go | arrow-right, skip-forward, play, log-in | one nudge along its direction, springs back | — |
| **disclosure** — chevrons | chevron-down / -left / -right | none | ROTATES to its state on `--spring-soft` (one icon, never a swap) |
| **object** — a section's emblem, an icon button with no verb of its own | section chips (`.ssection-ico`, `.side-sec-ico`), library, wand, anything without a recipe | tilts −8° and grows 1.08× | while hovered, on `--spring` |
| **status** — a fact | warning triangle, cloud-check, a chip's check / repeat, the pills' info glyphs | never moves | glows (a static `drop-shadow` / the chip's shadow) under glows; nothing under `no-glow` |
| **progress** — the only loops | `LoaderCircle` (`.side-sub-spin`), the indeterminate download sweep | loops while the work runs | — |
| **toggle** — on/off | the playlist toggle, the mute button, the copied-ID check | none on hover (a checkbox that grows feels wrong) | the new state POPS once (scale 0.6 → 1 on `--spring`) when the user changes it — never on mount of an already-on card |

Recipes (viewBox units; parts are lucide's own SVG children, picked by `:nth-child`; a part that lucide draws as one path
gets a two-part lucide icon of our own via `createLucideIcon` in `app/ui/src/components/icons.ts` — no new icon library):
- **download / cloud-download / the Browse card's own arrow** (`Card.tsx` `.dl-glyph`: a solid arrow + a tray): the arrow drops through into the tray (y +7, fading), a fresh one falls in from above (y −9)
  and lands on `--spring`; the tray dips 1.5 as it lands.
- **upload**: mirrored — the arrow leaves through the top, a fresh one rises out of the tray.
- **external-link**: the arrow slides out to the top-right (+5, −5, fading) and comes back in from the bottom-left.
- **copy**: the front sheet peels off the back one — from (−6, −6), on top of it, to its place.
- **refresh**: a full turn (360°) — fast start, long `--spring-soft` landing; **reset** turns −360°; **undo** swings back −30° and springs.
- **save**: a stamp — the disk presses down (y +1.5, scaleY .88) and springs back.
- **stop**: the square squeezes (scale .7) and springs back.
- **sparkles**: the big star turns in from 45° and grows from .7; the small cross and dot pop in after it.
- **check-check**: the second tick lands after the first.
- **star**: pops (scale .6 → 1) with a −20° turn.
- **sliders**: the three knobs slide ±3 and spring back, staggered.
- **volume-2**: the two waves ripple out, staggered; **volume-x**: the X turns 90°.
- **cloud-off**: the slash draws across (scale 0 → 1 from its top-left end).
- **locate**: the crosshair holds a 90° turn while hovered (hold, `--spring-soft`) and its centre dot pops once.

## The magnet (primary actions only)
A primary action leans toward a pointer that comes near: inside its box plus 28 px around it, it translates toward the
pointer, at most 3 px across / 2 px down, falling off with distance; out of range it springs home (`--spring-soft`).
`translate` only (it composes with a hover lift on `transform`), written in the pointer's own `pointermove` (no
`requestAnimationFrame`: an idle page asks for no frames), rects cached per element (re-read only with the pointer near, at most every 250 ms, and after a
scroll or resize). Opt in with `ref={magnetRef}` (`app/ui/src/components/magnet.ts`). Where: the playlist bar's Play, the Browse
sidebar's Download & Apply / Apply, the Steam to-do's Done — next, Subscribe / Unsubscribe, the modals' accent buttons.
Never in a list (cards, playlist items, filter rows): a grid of 170 leaning buttons is noise and a listener per card.

## Press
Every icon button squeezes its icon on press (`scale` .82 in `--press-dur`) and springs back on release (`--spring`).
`scale` is its own property, so it composes with a one-shot running on `transform` and with the object tilt's `rotate`.
Not inside the segmented control (its highlight is the feedback), the number stepper (its own squeeze) or the filter
column's tri-state switch.

## Rules that hold everything
- transform / opacity / the individual `translate` `rotate` `scale` properties only; an SVG child's transform repaints that
  icon only (no layout). Guard: probe-icons `icon:perf`.
- `:root.no-motion` (the "Smooth window animations" toggle and `prefers-reduced-motion`): no one-shot is started
  (`iconMotion.ts` checks the class), every icon transition is `none`, holds jump to their state, the magnet stays home.
  Guard: probe-icons `icon:*:off`.
- Glow only on status icons and the hosts' existing glows (`var(--glow*)`, a static `drop-shadow`); `:root.no-glow` turns
  them off in its block at the end of `index.css`. Guard: probe-icons `icon:status`.
- Only progress loops. Guard: probe-icons `icon:loops`.
- One delegated `pointerover` listener plays every one-shot (no listener per icon, nothing per card); it never restarts an
  icon's one-shot while it's running.

## Not now
- A play ↔ pause morph: the app has no pause control. When one comes: one icon, the triangle's two halves scale into the two
  bars (`scaleX` per half, `--spring`), never a swap.
