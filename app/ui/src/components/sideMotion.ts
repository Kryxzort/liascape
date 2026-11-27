
// COOL: the item sidebar's open / close (.claude/rules/ui/design.md § Item sidebar). Opening, the whole panel slides in from
// the window's edge on `--side-slide` while the grid's cards glide to the columns the dock leaves them, nearest the panel
// first; the panel's fill, edge and shadow (its ::before, index.css `.side-panel::before`) fade in over the slide, so the
// cards still gliding out from under it stay in view; the content soft-cascades in late (from 30 % of the slide) and from
// far off (head, picture, then the body's blocks) on `--spring-soft`. Closing slides it back out with the fill thinning
// first while the cards glide back. An item switch keeps the CSS carousel (SidePanel.tsx). Motion off never reaches here:
// index.css :root.no-motion fades the panel. Everything runs through Element.animate on translate / scale / opacity (the
// compositor); the only reads are one batch of card rects per open or close.
// Guard: probe-sidebar side:open:slide, side:open:glide, side:open:cascade, side:close, side:motionOff

const EASE_IN = "cubic-bezier(.5, 0, .75, 0)"; // a leaving thing accelerates and never bounces
const EASE_OUT = "cubic-bezier(.2, .9, .3, 1)";
const FILL_IN = "cubic-bezier(.55, 0, .45, 1)"; // thin while the cards glide out from under the panel, solid as it settles
const FILL_OUT = "cubic-bezier(.3, 0, .2, 1)";
const FILL_OUT_MS = 200;
// the slide out (hooks/useLinger.ts SIDE_CLOSE_MS keeps the panel mounted a little longer; index.css side-out matches it)
export const SLIDE_OUT_MS = 260;
const EDGE_STAGGER_MS = 70; // the card farthest from the panel starts this much after the nearest
// the content's cascade: its first block starts at CASCADE_AT of the slide's visual duration (the spring's 460 ms, not its
// settle), each block travels TRAVEL × its base offset (head 32 px, picture 40 px, body 48 px), 25 / 27 ms apart
const CASCADE_AT = 0.3, SLIDE_VISUAL_MS = 460, TRAVEL = 6;
const SETTLE_MS = 140;

// `--side-slide` (index.css :root: the panel's spring, sampled into linear()) and `--spring-soft`, read once the stylesheet
// is in. PERF: the first read is a computed-style read, so it is done in the app's first frame (see flipGlide.ts spring()).
let tok: { slide: string; slideMs: number; soft: string; softMs: number } | null = null;
function tokens() {
  if (tok) return tok;
  const cs = getComputedStyle(document.documentElement), v = (k: string) => cs.getPropertyValue(k).trim();
  const ms = (k: string, d: number) => { const x = v(k); return x ? parseFloat(x) * (x.endsWith("ms") ? 1 : 1000) : d; };
  const t = { slide: v("--side-slide") || EASE_OUT, slideMs: ms("--side-slide-dur", 528), soft: v("--spring-soft") || EASE_OUT, softMs: ms("--spring-soft-dur", 500) };
  if (v("--side-slide")) tok = t;
  return t;
}
if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => { tokens(); });

// ---- the grid making room (a FLIP) ----
// `snapGrid` reads where the cards are BEFORE the focus change renders the dock (one batch of rect reads, on the click whose
// layout is clean), `afterLayout` waits for the frame that laid out the new columns, `playGrid` reads where they are now and
// plays each card's difference back. On `translate` / `scale`, not `transform`: a card's hover lift and the focused card's
// raise live on `transform` (index.css `.card:hover`, `.card.focused`) and compose with these. Only cards on screen before
// or after take part.
export type GridSnap = Map<HTMLElement, DOMRect>;
const glides = new WeakMap<HTMLElement, Animation>();
const cardsOf = (grid: Element) => grid.querySelectorAll<HTMLElement>(":scope > .card");

export function snapGrid(grid: Element | null): GridSnap | null {
  if (!grid) return null;
  const m: GridSnap = new Map();
  for (const c of cardsOf(grid)) m.set(c, c.getBoundingClientRect());
  return m;
}

// the first frame after a commit, once its layout and useGridFit's column re-fit are done, before it paints: a new
// ResizeObserver delivers its first notification there, after every older observer's (useGridFit's binds when the page
// mounts; gridKeys.ts keepCardInView's, which keeps the clicked card's row, on the click)
export function afterLayout(el: Element, cb: () => void) {
  const ro = new ResizeObserver(() => { ro.disconnect(); cb(); });
  ro.observe(el);
}

const onScreen = (r: DOMRect, v: DOMRect) => r.bottom > v.top - 40 && r.top < v.bottom + 40 && r.width > 0;
export function playGrid(before: GridSnap | null, grid: Element | null, view: Element | null) {
  if (!before || !grid || !view) return;
  const { slide, slideMs } = tokens();
  // a glide still running stops first, so the rects below are resting places (the BEFORE rects were read mid-glide if
  // one ran: the new glide starts from where the card was seen)
  for (const c of before.keys()) glides.get(c)?.cancel();
  const vr = view.getBoundingClientRect(), moves: [HTMLElement, DOMRect, DOMRect][] = [];
  for (const c of cardsOf(grid)) {
    const was = before.get(c), r = c.getBoundingClientRect();
    if (was && (onScreen(was, vr) || onScreen(r, vr))) moves.push([c, was, r]);
  }
  const far = Math.max(1, ...moves.map(([, , r]) => vr.right - r.right));
  for (const [c, was, r] of moves) {
    const dx = was.x + was.width / 2 - (r.x + r.width / 2), dy = was.y + was.height / 2 - (r.y + r.height / 2);
    const sx = was.width / r.width, sy = was.height / r.height;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.002 && Math.abs(sy - 1) < 0.002) continue;
    glides.set(c, c.animate([{ translate: `${dx}px ${dy}px`, scale: `${sx} ${sy}` }, { translate: "0px 0px", scale: "1 1" }],
      { duration: slideMs, easing: slide, delay: EDGE_STAGGER_MS * Math.max(0, vr.right - r.right) / far, fill: "backwards" }));
  }
}

// ---- the panel ----
// One of ours (a script animation) still running or holding on a target — a close while it still opens, a re-open while it
// closes: return where the target IS for `props` and cancel ours, so the new move turns around from there instead of
// jumping; null when none is in effect. CSS animations and transitions are left alone.
// PERF: ours are kept here, never found with getAnimations(): that call lays out the frame's pending changes inside the
// click or key that opens or closes the panel; computed style is read only when one of ours still moves or holds the
// target (an interrupted open or close). Guard: probe-layout perf:sidebar
const REST: Record<string, string> = { translate: "0px 0px", scale: "1 1" };
const ours = new WeakMap<Element, Animation[]>();
// still moving the target, or holding it where it ended (fill: forwards)
const holds = (a: Animation) => a.playState === "running" || a.playState === "paused"
  || (a.playState === "finished" && ["forwards", "both"].includes(String(a.effect?.getTiming().fill)));
function play(el: Element, keyframes: Keyframe[], timing: KeyframeAnimationOptions) {
  const a = el.animate(keyframes, timing);
  ours.set(el, [...(ours.get(el) ?? []).filter(holds), a]);
  return a;
}
function takeOver(el: Element, props: string[], pseudo?: string): Keyframe | null {
  const mine = (ours.get(el) ?? []).filter((a) => ((a.effect as KeyframeEffect | null)?.pseudoElement ?? null) === (pseudo ?? null));
  if (!mine.length) return null;
  let now: Keyframe | null = null;
  if (mine.some(holds)) {
    const cs = getComputedStyle(el, pseudo ?? null);
    now = {};
    for (const p of props) { const v = cs.getPropertyValue(p); now[p] = v === "none" ? REST[p] ?? v : v; }
  }
  for (const a of mine) a.cancel();
  ours.set(el, (ours.get(el) ?? []).filter((a) => !mine.includes(a)));
  return now;
}
function move(el: HTMLElement, pseudo: string | undefined, from: Keyframe, to: Keyframe, timing: KeyframeAnimationOptions) {
  const live = takeOver(el, Object.keys(from), pseudo);
  return play(el, [live ?? from, to], { ...timing, pseudoElement: pseudo });
}

const head = (panel: Element) => [...panel.querySelectorAll<HTMLElement>(".side-head-text, .side-head-tools, .side-close")];
const live = (panel: Element) => panel.querySelector<HTMLElement>(".side-content:not(.side-exit)");
const stage = (content: Element | null) => content?.querySelector<HTMLElement>(":scope > .side-stage") ?? null;
const body = (content: Element | null) => content?.querySelector<HTMLElement>(":scope > .side-body") ?? null;
// the body's wait for its asynchronous parts (ItemSide.tsx `.side-body.wait`), per panel: its cascade starts when it lifts
const waits = new WeakMap<Element, MutationObserver>();

// each element slides in from `px` on --spring-soft at its turn, unseen until then (a late cascade's blocks would otherwise
// wait at their far-off start inside the panel) and fading in over its first CASCADE_FADE_MS, so its far-off start never
// pops in; backwards fill only: nothing stays moved once it landed
const CASCADE_FADE_MS = 120;
function cascade(els: HTMLElement[], px: number, scale: string | null, at: number, gap: number) {
  const { soft, softMs } = tokens();
  els.forEach((el, i) => {
    const delay = Math.max(0, at + i * gap);
    play(el, [{ translate: `${px * TRAVEL}px 0px` }, { translate: "0px 0px" }], { duration: softMs, easing: soft, delay, fill: "backwards" });
    if (scale) play(el, [{ scale }, { scale: "1" }], { duration: softMs, easing: soft, delay, fill: "backwards" });
    play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: CASCADE_FADE_MS, easing: "ease-out", delay, fill: "backwards" });
  });
}

export function openSide(panel: HTMLElement) {
  const { slide, slideMs } = tokens();
  move(panel, undefined, { translate: "100% 0px" }, { translate: "0px 0px" }, { duration: slideMs, easing: slide });
  move(panel, "::before", { opacity: 0 }, { opacity: 1 }, { duration: slideMs, easing: FILL_IN });
  const t0 = performance.now(), at = CASCADE_AT * SLIDE_VISUAL_MS;
  const c = live(panel), st = stage(c), b = body(c);
  cascade(head(panel), 32, null, at, 25);
  if (st) cascade([st], 40, "0.92", at + 25, 0);
  waits.get(panel)?.disconnect();
  if (!b) return;
  const go = () => cascade([...b.children] as HTMLElement[], 48, null, at + 55 - (performance.now() - t0), 27);
  if (!b.classList.contains("wait")) { go(); return; }
  // the body shows once its parts are in (at most 450 ms): its blocks cascade from then, on time if it was quick
  const mo = new MutationObserver(() => { if (!b.classList.contains("wait")) { mo.disconnect(); go(); } });
  mo.observe(b, { attributes: true, attributeFilter: ["class"] });
  waits.set(panel, mo);
}

export function closeSide(panel: HTMLElement) {
  waits.get(panel)?.disconnect();
  // what still cascades in settles in place quickly, so nothing is still arriving inside a panel that is leaving and a
  // quick re-open starts from blocks at rest
  const c = live(panel);
  for (const el of [...head(panel), stage(c), ...(body(c)?.children ?? [])] as (HTMLElement | null)[]) {
    if (!el) continue;
    const now = takeOver(el, ["translate", "scale"]);
    const far = Math.abs(parseFloat(String(now?.translate ?? "0")) || 0);
    if (now) el.animate([now, { translate: "0px 0px", scale: "1" }], { duration: Math.min(320, SETTLE_MS + far * 0.6), easing: EASE_OUT });
  }
  move(panel, undefined, { translate: "0px 0px" }, { translate: "100% 0px" }, { duration: SLIDE_OUT_MS, easing: EASE_IN, fill: "forwards" });
  // the fill thins first, so the cards gliding back under the leaving panel show through it
  move(panel, "::before", { opacity: 1 }, { opacity: 0 }, { duration: FILL_OUT_MS, easing: FILL_OUT, fill: "forwards" });
}

// how long the open's grid glide runs (the dock's padding stays under the panel until then: index.css [data-docking])
export const gridGlideMs = () => tokens().slideMs + EDGE_STAGGER_MS;
