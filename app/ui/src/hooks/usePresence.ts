import { useLayoutEffect, useReducer, useState, type RefObject } from "react";
import { FADE_EXIT_MS, FADE_MS } from "../components/motion";
import { softSpringCss } from "../components/flipGlide";

// COOL: cards leaving and joining a list (the Library and Browse grids, the playlist bar's row) move instead of jumping
// (design.md § Motion — nothing pops): the leaving card stays mounted where it was, out of the flow, and fades as it shrinks;
// its neighbours glide into the gap (a FLIP on the soft spring, as components/flipGlide.ts plays it); a joining card is the
// leave played backwards: it grows in from the same scale as it fades in. A card that comes back while it's still leaving
// (Undo, a filter toggled back) turns round from where it is. Everything runs as Element.animate on opacity and the
// individual `translate` / `scale` properties, so it composes with what owns `transform` (a card's hover lift, the focused
// card's raise, the bar's dock magnification and its sortable) and runs on the compositor.
//
// The list renders `list` (its items plus the ones still leaving, each in its old place); each item's root element is a
// direct child of `boxRef` carrying `data-key` = its key, and the box is positioned (a leaving card is pinned inside it).
// PERF: only cards on screen take part — what's off screen leaves, joins and moves at once. The cards' boxes are read twice per
// change of the list's keys, each time in one batch: in the render that changes them (the DOM still shows the old list, its
// layout clean after the input that caused it) and in the commit's layout effect (the new list's layout, which the frame
// would do anyway, done there once: everything starts before that frame paints, so none shows the new places un-animated;
// a ResizeObserver's first callback came a frame late when the list changed twice in a row, as Browse's does with its
// placeholders). The page's own layout effects that move the list (a filter's scroll reset to the top) run before it:
// the hook is called after them. Nothing reads per frame, and a render whose keys didn't change (a selection, the focus,
// a download's progress) costs a comparison.
// Motion off (useMotion false): the leaving card fades in place (FADE_MS, kept FADE_EXIT_MS), a joining one fades in, the
// neighbours take their new places at once (docs/decisions.md § "Fade, never move, with motion off").
// Guard: probe-presence lib:trash, lib:undo, lib:filter, bar:remove, browse:filter (and their :off / :reduced cells)

export const LEAVE_MS = 220;
// a leaving card shrinks to this and a joining one grows from it
const LEAVE_SCALE = 0.88;
// exits accelerate and never bounce; a join is the exit's curve run backwards (the time-reverse of the leave's bezier)
const EASE_LEAVE = "cubic-bezier(.5, 0, .75, 0)";
const EASE_JOIN = "cubic-bezier(.25, 1, .5, 1)";
// many cards joining at once (a filter cleared) come in reading order, a little apart, the last no later than JOIN_MAX_DELAY
const JOIN_GAP = 12, JOIN_MAX_DELAY = 150;
// "on screen": within the view (and the window) by this much; a card read this far beyond it can glide in from under the edge
const NEAR = 40;

type Rect = { cx: number; cy: number; l: number; t: number; r: number; b: number };
const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, l: r.left, t: r.top, r: r.right, b: r.bottom };
};
type View = { l: number; t: number; r: number; b: number };
function viewOf(el: Element | null): View | null {
  if (!el) return null;
  const v = el.getBoundingClientRect();
  if (!v.width || !v.height) return null; // a hidden page (the Library under <Activity>): nothing shows, nothing animates
  return { l: Math.max(v.left, 0), t: Math.max(v.top, 0), r: Math.min(v.right, innerWidth), b: Math.min(v.bottom, innerHeight) };
}
const within = (r: Rect, v: View, m: number) => r.r > v.l - m && r.l < v.r + m && r.b > v.t - m && r.t < v.b + m && r.r > r.l;
// how far past the view a card is still read: one more row or item (half the view), so the one sliding into the last slot
// glides in from under the edge instead of fading in
const reach = (v: View) => Math.max(NEAR, Math.min(v.r - v.l, v.b - v.t) / 2);

// where a leaving card sits in its box (layout, transform-free: its own hover lift isn't kept)
type Pin = { l: number; t: number; w: string; h: string };
// `at`: where the box's content was on screen (its box less its scroll offset), to follow a box that moves before the new
// layout paints
type Snap = { els: Map<HTMLElement, Rect>; pins: Map<string, Pin>; at: { x: number; y: number } };
const contentAt = (box: HTMLElement) => { const r = box.getBoundingClientRect(); return { x: r.left - box.scrollLeft, y: r.top - box.scrollTop }; };
function snapshot(box: HTMLElement, view: View, removed: Set<string>): Snap {
  const els = new Map<HTMLElement, Rect>(), pins = new Map<string, Pin>(), m = reach(view);
  for (const el of box.children as HTMLCollectionOf<HTMLElement>) {
    // only the list's own cards: a placeholder (Browse's) jumps to its new place. Its infinite scroll watches the placeholders
    // with an IntersectionObserver, which sees their transform: gliding down from the view they'd still be in range, and every
    // page that lands would ask for the next. Guard: probe-layout tabs:browse
    if (el.dataset.key == null) continue;
    // a card already leaving is read too (one that comes back glides from where it was pinned) but never pinned again
    const r = rectOf(el);
    if (!within(r, view, m)) continue;
    els.set(el, r);
    const k = el.dataset.key;
    if (k != null && removed.has(k) && within(r, view, NEAR)) {
      const cs = getComputedStyle(el);
      pins.set(k, { l: el.offsetLeft, t: el.offsetTop, w: cs.width, h: cs.height });
    }
  }
  return { els, pins, at: contentAt(box) };
}

const PIN_PROPS = ["position", "left", "top", "width", "height", "margin", "pointer-events"];
function pin(el: HTMLElement, p: Pin) {
  el.dataset.leaving = "";
  Object.assign(el.style, { position: "absolute", left: `${p.l}px`, top: `${p.t}px`, width: p.w, height: p.h, margin: "0", pointerEvents: "none" });
}
function unpin(el: HTMLElement) {
  delete el.dataset.leaving;
  for (const k of PIN_PROPS) el.style.removeProperty(k);
}

const glides = new WeakMap<Element, Animation>();

type Leaver<T> = { item: T; el: HTMLElement | null; pin: Pin; anim: Animation | null; timer: number;
  // PERF: a leaving card's unfinished image loads are dropped at once, as its unmount would (components/Card.tsx): a replaced
  // list's thumbnails never wait behind them; a card that comes back gets them again
  imgs: [HTMLImageElement, string][] };

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

// One list's presence: `sync` in its render (reads the DOM the last commit left, which `box` holds), `commit` in its layout
// effect.
class Presence<T> {
  box: HTMLElement | null = null; // the list's box as of the last commit
  items: readonly T[] | null = null; keys: string[] = []; byKey = new Map<string, T>();
  leaving = new Map<string, Leaver<T>>();
  starting: string[] = []; back: string[] = []; snap: Snap | null = null;
  merged: T[] = []; mergedFor: [readonly T[] | null, number] = [null, -1]; shown: string[] = [];
  isLeaving = (k: string) => this.leaving.has(k) && !this.byKey.has(k);

  sync(items: readonly T[], keyOf: (t: T) => string, scroller: "parent" | "self", ver: number): T[] {
    if (items !== this.items) {
      const keys = items.map(keyOf);
      if (this.items && !sameKeys(keys, this.keys)) {
        const next = new Set(keys);
        for (const k of this.leaving.keys()) if (next.has(k)) this.back.push(k);
        const removed = new Set(this.keys.filter((k) => !next.has(k)));
        const box = this.box?.isConnected ? this.box : null, view = viewOf(box && (scroller === "self" ? box : box.parentElement));
        const snap = box && view ? snapshot(box, view, removed) : null;
        if (snap) {
          // a second change before the first was committed (two in one frame) keeps the first's leavers and places
          this.snap = this.snap ? { els: new Map([...snap.els, ...this.snap.els]), pins: new Map([...this.snap.pins, ...snap.pins]), at: this.snap.at } : snap;
          for (const [k, pin] of snap.pins) {
            const item = this.byKey.get(k);
            if (item === undefined) continue;
            this.leaving.set(k, { item, el: null, pin, anim: null, timer: 0, imgs: [] });
            this.starting.push(k);
          }
        }
      }
      this.items = items; this.keys = keys;
      this.byKey = new Map(items.map((it, i) => [keys[i], it]));
    }
    // the rendered list: the items, and each card still leaving right after the one it followed (its place in the DOM keeps
    // its paint order: the cards after it glide over it)
    if (this.mergedFor[0] !== items || this.mergedFor[1] !== ver) {
      if (!this.leaving.size) { this.merged = items as T[]; this.shown = this.keys; }
      else {
        const after = new Map<string | null, string[]>(), present = this.byKey, was = new Set(this.shown);
        const add = (a: string | null, k: string) => { const l = after.get(a); if (l) l.push(k); else after.set(a, [k]); };
        let anchor: string | null = null;
        for (const k of this.shown) {
          if (present.has(k)) anchor = k;
          else if (this.leaving.has(k)) add(anchor, k);
        }
        for (const k of this.leaving.keys()) if (!present.has(k) && !was.has(k)) add(null, k);
        const out: T[] = [], shown: string[] = [];
        const put = (a: string | null) => { for (const k of after.get(a) ?? []) { const L = this.leaving.get(k)!; out.push(L.item); shown.push(k); } };
        put(null);
        items.forEach((it, i) => { out.push(it); shown.push(this.keys[i]); put(this.keys[i]); });
        this.merged = out; this.shown = shown;
      }
      this.mergedFor = [items, ver];
    }
    return this.merged;
  }

  commit(box: HTMLElement | null, on: boolean, scroller: "parent" | "self", bump: () => void) {
    this.box = box;
    if (!this.snap && !this.starting.length && !this.back.length) return;
    const snap = this.snap; this.snap = null;
    const byKey = new Map<string, HTMLElement>();
    for (const el of (box?.children ?? []) as HTMLCollectionOf<HTMLElement>) { const k = el.dataset.key; if (k != null) byKey.set(k, el); }
    // coming back while it leaves (Undo, a filter turned back): from where it is now, its opacity and scale mid-exit, back
    // into the flow; it glides from its pinned place to its slot like any neighbour
    const turning: [HTMLElement, string, string][] = [];
    for (const k of this.back) {
      const L = this.leaving.get(k), el = byKey.get(k);
      this.leaving.delete(k); // its batch's timer finds it gone and leaves it be
      if (!L || !el) continue;
      const cs = getComputedStyle(el);
      turning.push([el, cs.opacity, cs.scale === "none" ? "1" : cs.scale]);
      L.anim?.cancel(); unpin(el);
      for (const [img, src] of L.imgs) if (!img.getAttribute("src")) img.src = src;
    }
    this.back = [];
    // leaving: out of the flow where it was (the neighbours lay out into its gap in this frame), gone after its exit — on a
    // timer, never an animation event (an unpainted window plays no animation to its end)
    const started: Leaver<T>[] = [];
    for (const k of this.starting) {
      const L = this.leaving.get(k), el = byKey.get(k);
      if (!L) continue;
      if (!el) { this.leaving.delete(k); continue; }
      L.el = el; pin(el, L.pin);
      for (const img of el.querySelectorAll("img")) if (!img.complete && img.getAttribute("src")) { L.imgs.push([img, img.src]); img.removeAttribute("src"); }
      started.push(L);
    }
    this.starting = [];
    // one timer for the batch: one render of the list drops them all
    if (started.length) {
      const timer = window.setTimeout(() => {
        let gone = false;
        for (const [k, x] of this.leaving) if (started.includes(x)) { this.leaving.delete(k); gone = true; }
        if (gone) bump();
      }, on ? LEAVE_MS + 40 : FADE_EXIT_MS);
      for (const L of started) L.timer = timer;
    }
    if (!box || !snap) return;
    // the leaving cards first: a box that moved under them since (the list's scroll reset to its top, a note that appeared
    // above the grid) puts them back where they were seen, then their exit starts
    const now = contentAt(box), dx = snap.at.x - now.x, dy = snap.at.y - now.y;
    for (const L of started) {
      const el = L.el!;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) { el.style.left = `${L.pin.l + dx}px`; el.style.top = `${L.pin.t + dy}px`; }
      L.anim = on
        ? el.animate([{ opacity: 1, scale: "1" }, { opacity: 0, scale: `${LEAVE_SCALE}` }], { duration: LEAVE_MS, easing: EASE_LEAVE, fill: "forwards" })
        : el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "linear", fill: "forwards" });
    }
    const view = viewOf(scroller === "self" ? box : box.parentElement);
    if (!view) return;
    // the neighbours: from where they were seen to their new place (a glide still running from the change before is stopped
    // first, so the rect below is its resting place and the new glide starts where the eye last saw it)
    const moved: [HTMLElement, Rect][] = [];
    for (const [el, was] of snap.els) {
      if (el.parentElement !== box || el.dataset.leaving != null) continue;
      glides.get(el)?.cancel();
      moved.push([el, was]);
    }
    const { e, ms } = softSpringCss();
    if (on) for (const [el, was] of moved) {
      const r = rectOf(el), dx = was.cx - r.cx, dy = was.cy - r.cy;
      if ((Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) || !(within(was, view, NEAR) || within(r, view, NEAR))) continue;
      glides.set(el, el.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0px 0px" }], { duration: ms, easing: e }));
    }
    for (const [el, op, sc] of turning) {
      el.animate(on ? [{ opacity: op, scale: sc }, { opacity: 1, scale: "1" }] : [{ opacity: op }, { opacity: 1 }],
        { duration: on ? LEAVE_MS : FADE_MS, easing: on ? EASE_JOIN : "linear" });
    }
    // the joining cards: on screen now and not seen before (new, or come from far off screen)
    let i = 0;
    for (const el of box.children as HTMLCollectionOf<HTMLElement>) {
      if (el.dataset.key == null || snap.els.has(el) || el.dataset.leaving != null || !within(rectOf(el), view, NEAR)) continue;
      if (on) el.animate([{ opacity: 0, scale: `${LEAVE_SCALE}` }, { opacity: 1, scale: "1" }],
        { duration: LEAVE_MS, easing: EASE_JOIN, delay: Math.min(i++ * JOIN_GAP, JOIN_MAX_DELAY), fill: "backwards" });
      else el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "linear" });
    }
  }

  // the list goes (a page left): the cards still leaving go with it
  dispose() { for (const L of this.leaving.values()) clearTimeout(L.timer); this.leaving.clear(); }
}

export function usePresence<T>(items: readonly T[], keyOf: (t: T) => string, boxRef: RefObject<HTMLElement | null>,
  motion: boolean, scroller: "parent" | "self" = "parent"): { list: T[]; leaving: (key: string) => boolean } {
  const [p] = useState(() => new Presence<T>());
  const [ver, bump] = useReducer((x: number) => x + 1, 0);
  const list = p.sync(items, keyOf, scroller, ver);
  useLayoutEffect(() => p.commit(boxRef.current, motion, scroller, bump));
  useLayoutEffect(() => () => p.dispose(), [p]);
  return { list, leaving: p.isLeaving };
}
