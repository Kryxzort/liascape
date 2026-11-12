import { useEffect, type RefObject } from "react";
import { FADE_EXIT_MS } from "../components/motion";

// "Travel to running wallpaper on app open" (docs/decisions.md § "Travel to the playing wallpaper once per session, spotlit
// in the playing green"): the first time a list shows the playing item in this
// app session — the app opening on Library, or the first visit to the Library tab with something playing — its scroll
// container jumps (no smooth glide: it's where the page opens) so the playing item sits in the middle of the view. Once
// per session per list (`key`): coming back to the tab later, or a switch while the app is open, never moves the user's
// scroll. Nothing playing / the item not in the list (a search hides it) → nothing happens, and the next chance tries again.
// `shown` says whether the list renders the playing item: the search for its element runs only then, since the page's
// effects run again on every return to it (App.tsx <Activity>) and a search for an item that isn't there would run a
// frame loop each time. Guard: probe-layout perf:tabs
// `selector` finds the playing element inside `ref` (`.card.playing`, `.pl-item.playing`). The grid's cards are
// `content-visibility: auto` (their offscreen size is the intrinsic estimate), so the jump is re-aimed over a few frames
// while the cards around the target render at their real size.
const traveled = new Set<string>();

export function useTravelToPlaying(ref: RefObject<HTMLElement | null>, key: string, axis: "x" | "y", selector: string,
  playingPath: string | null, shown: boolean) {
  useEffect(() => {
    if (traveled.has(key) || !playingPath || !shown) return;
    let raf = 0, tries = 0, cancelled = false;
    const aim = () => {
      const sc = ref.current, el = sc?.querySelector<HTMLElement>(selector);
      if (!sc || !el || cancelled) return false;
      const s = sc.getBoundingClientRect(), r = el.getBoundingClientRect();
      if (s.width === 0 || s.height === 0) return false; // not laid out yet
      if (axis === "y") sc.scrollTop += r.top - s.top - (s.height - r.height) / 2;
      else sc.scrollLeft += r.left - s.left - (s.width - r.width) / 2;
      return true;
    };
    let aimed = 0;
    const step = () => {
      if (cancelled) return;
      if (aim()) { traveled.add(key); aimed++; }
      // the first aim → 3 more frames re-aimed (the cards near the target take their real size); not found yet → keep
      // looking for ~1 s (the list renders after the items land)
      if (aimed < 4 && ++tries < 60) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // the user scrolling first wins: stop aiming
    const sc = ref.current;
    const stop = () => { cancelled = true; cancelAnimationFrame(raf); };
    sc?.addEventListener("wheel", stop, { passive: true });
    sc?.addEventListener("pointerdown", stop);
    return () => { stop(); sc?.removeEventListener("wheel", stop); sc?.removeEventListener("pointerdown", stop); };
  }, [playingPath, shown]); // eslint-disable-line
}

// "Go to the playing wallpaper" buttons — the Library top bar's and the playlist bar head's. `glideTo` eases the scroll container so `selector`'s
// element sits mid-view: every frame it re-measures where the element is (the grid's `content-visibility` cards take their real
// size as they come into view, so a target computed once would land off) and closes a fraction of the remaining distance
// (exponential, ~0.5 s), stopping when it's there, after 1.5 s, or the moment the user wheels / presses in the container.
// Motion off → one jump, re-aimed over 3 frames like the app-open travel. Then `locateFx` spotlights it (below).
// Returns false when the element isn't in the list (nothing playing, the item filtered out / not in the playlist).
// Where an element can actually be SEEN: the window ∩ every clipping ancestor, minus the app's overlays that don't contain it
// (the playlist bar over the grid's bottom, the top bar, a floating sidebar) — an overlay that spans the box's width cuts
// its top / bottom, one that spans its height its left / right. The glide aims for this box's middle and the spotlight
// draws only inside it (never its spotlight and outline over an overlay such as the playlist bar).
type Box = { l: number; t: number; r: number; b: number };
const OVERLAYS = ".playlist-bar, .topbar, .side-panel";
function clipAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") out.push(a);
  }
  return out;
}
export function visibleBox(el: HTMLElement, ancestors = clipAncestors(el), self = false): Box {
  let b: Box = { l: 0, t: 0, r: window.innerWidth, b: window.innerHeight };
  const cut = (q: DOMRect) => { b = { l: Math.max(b.l, q.left), t: Math.max(b.t, q.top), r: Math.min(b.r, q.right), b: Math.min(b.b, q.bottom) }; };
  for (const a of self ? [el, ...ancestors] : ancestors) cut(a.getBoundingClientRect());
  for (const ov of document.querySelectorAll<HTMLElement>(OVERLAYS)) {
    if (ov.contains(el) || el.contains(ov)) continue;
    const q = ov.getBoundingClientRect();
    if (!q.width || !q.height || q.right <= b.l || q.left >= b.r || q.bottom <= b.t || q.top >= b.b) continue;
    const wide = q.left <= b.l + 1 && q.right >= b.r - 1, tall = q.top <= b.t + 1 && q.bottom >= b.b - 1;
    if (wide) { if (q.top > b.t) b.b = Math.min(b.b, q.top); else b.t = Math.max(b.t, q.bottom); }
    else if (tall) { if (q.left > b.l) b.r = Math.min(b.r, q.left); else b.l = Math.max(b.l, q.right); }
  }
  return b;
}

export function glideTo(sc: HTMLElement | null, selector: string, axis: "x" | "y", smooth: boolean): boolean {
  const target = sc?.querySelector<HTMLElement>(selector);
  if (!sc || !target) return false;
  const TAU = 110, MAX_MS = 1500;
  let raf = 0, last = 0, t0 = 0, frames = 0, stopped = false;
  // the spotlight dims the window from the click on, its hole riding the target through the glide
  const fx = locateFx(target, smooth);
  const scAnc = clipAncestors(sc);
  const stop = () => {
    if (stopped) return;
    stopped = true; cancelAnimationFrame(raf);
    sc.removeEventListener("wheel", interrupt); sc.removeEventListener("pointerdown", interrupt);
  };
  const interrupt = () => { stop(); fx.cancel(); };
  const step = (t: number) => {
    if (stopped) return;
    const el = sc.querySelector<HTMLElement>(selector);
    if (!el) { interrupt(); return; }
    if (!t0) t0 = t;
    // the middle of what's VISIBLE of the list (the playlist bar may cover the grid's bottom)
    const v = visibleBox(sc, scAnc, true), r = el.getBoundingClientRect();
    const cur = axis === "y" ? sc.scrollTop : sc.scrollLeft;
    const delta = axis === "y" ? r.top - v.t - (v.b - v.t - r.height) / 2 : r.left - v.l - (v.r - v.l - r.width) / 2;
    const dt = last ? Math.min(t - last, 64) : 16;
    last = t;
    // the browser clamps at the list's ends (an item at the very end can't be centred): no own max — scrollWidth − clientWidth
    // came out 3 px short of the real end — just stop once a step no longer moves it
    const next = !smooth || Math.abs(delta) < 0.75 ? cur + delta : cur + delta * (1 - Math.exp(-dt / TAU));
    if (axis === "y") sc.scrollTop = next; else sc.scrollLeft = next;
    const moved = Math.abs((axis === "y" ? sc.scrollTop : sc.scrollLeft) - cur);
    frames++;
    const done = smooth ? Math.abs(delta) < 0.75 || (frames > 2 && moved < 0.25) : frames >= 4;
    if (done || t - t0 > MAX_MS) { stop(); fx.reveal(); return; }
    raf = requestAnimationFrame(step);
  };
  sc.addEventListener("wheel", interrupt, { passive: true });
  sc.addEventListener("pointerdown", interrupt);
  raf = requestAnimationFrame(step);
  return true;
}

// COOL: the "here it is" after a glide. A fixed layer on <body> — above everything, never clipped by the grid / the bar's row — over the element's
// box: the rest of the window dims (a hole: one huge spread shadow around the box, painted once), the element glows in the
// accent (a pre-blurred shadow layer whose OPACITY animates), three accent rings ripple out of it (each scaled by its own
// px-exact factors so a wide card and a small bar item ring out the same 26 px), then it all fades back — 1.5 s. Only
// transform + opacity animate, on its own composited layers: nothing in the grid repaints. The layer follows the element every
// frame (the bar's dock magnification moves it; a scroll). The element itself carries `.locate-flash` meanwhile: a static
// accent outline (shows with "Glow effects" off; the matrix's travel:button reads it). Glow effects off → no glow layer, the
// spotlight + rings stay; motion off → nothing moves: the dim, the outline and one still ring fade in, hold for 1.2 s and
// fade out (opacity only, FADE_MS; index.css `.locate-fx.still`). Guard: probe-sidebar look:locator
// Two phases (the dim is there from the moment of the click): `locateFx` puts up
// the dim at once (a quick fade in, `.lfx-dim.in`) — its hole follows the element while `glideTo` scrolls it into place — and
// `reveal()` on arrival adds the glow, edge and rings and starts the 1.5 s clock, the dim holding then fading with them.
// `cancel()` (the user wheels / presses mid-glide) fades the dim straight out.
let fxCleanup: (() => void) | null = null;
export const LOCATE_FX_MS = 1500, LOCATE_STATIC_MS = 1200, LOCATE_OUT_MS = 160;
export function locateFx(el: HTMLElement, motion: boolean): { reveal: () => void; cancel: () => void } {
  fxCleanup?.();
  const fx = document.createElement("div");
  fx.className = `locate-fx${motion ? "" : " still"}`;
  fx.setAttribute("aria-hidden", "true");
  fx.style.setProperty("--r", getComputedStyle(el).borderRadius || "10px");
  // the dim, then a clip box holding the glow / edge / rings (added on arrival) — clipped to where the item is visible
  fx.innerHTML = `<div class="lfx-dim in"></div><div class="lfx-clip"></div>`;
  const dim = fx.firstElementChild as HTMLElement, clip = fx.lastElementChild as HTMLElement, anc = clipAncestors(el);
  let raf = 0, last = "", t = 0, phase: "travel" | "shown" | "gone" = "travel";
  const place = () => {
    const r = el.getBoundingClientRect(), v = visibleBox(el, anc);
    const k = `${r.left},${r.top},${r.width},${r.height},${v.l},${v.t},${v.r},${v.b}`;
    if (k === last) return;
    last = k;
    fx.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`; fx.style.width = `${r.width}px`; fx.style.height = `${r.height}px`;
    // the hole = the VISIBLE part of the item; none visible (still far off in the list, or under the bar) → a zero hole at
    // the nearest visible point, so the WHOLE window is dimmed (the dim's spread reaches 1.5× the window from the hole —
    // a hole thousands of px off-screen leaves part of the window undimmed when the destination is very far away) and the
    // hole grows in from
    // the edge as the item arrives
    let hl = Math.max(r.left, v.l), ht = Math.max(r.top, v.t), hr = Math.min(r.right, v.r), hb = Math.min(r.bottom, v.b);
    if (hr <= hl || hb <= ht) {
      hl = hr = Math.min(Math.max((r.left + r.right) / 2, v.l), v.r);
      ht = hb = Math.min(Math.max((r.top + r.bottom) / 2, v.t), v.b);
    }
    Object.assign(dim.style, { left: `${hl - r.left}px`, top: `${ht - r.top}px`, width: `${hr - hl}px`, height: `${hb - ht}px` });
    // the glow / edge / rings: cut where the item is covered or scrolled away, free (glowing out) elsewhere
    const side = (d: number) => (d > 0.5 ? `${d}px` : "-400px");
    clip.style.clipPath = `inset(${side(v.t - r.top)} ${side(r.right - v.r)} ${side(r.bottom - v.b)} ${side(v.l - r.left)})`;
  };
  const tick = () => { if (!el.isConnected) { done(); return; } place(); raf = requestAnimationFrame(tick); };
  const done = () => {
    phase = "gone"; cancelAnimationFrame(raf); clearTimeout(t); fx.remove(); el.classList.remove("locate-flash");
    if (fxCleanup === done) fxCleanup = null;
  };
  const born = performance.now(), DIM_IN_MS = 180;
  const reveal = () => {
    if (phase !== "travel") return;
    // a short glide (the item already near view) arrives before the dim has faded up: wait it out, no opacity pop
    const wait = motion ? DIM_IN_MS - (performance.now() - born) : 0;
    if (wait > 8) { clearTimeout(t); t = window.setTimeout(reveal, wait); return; }
    phase = "shown";
    const glow = !document.documentElement.classList.contains("no-glow");
    if (!glow) fx.classList.add("flat");
    const r0 = el.getBoundingClientRect(), D = 26;
    fx.style.setProperty("--sx", String((r0.width + 2 * D) / Math.max(1, r0.width)));
    fx.style.setProperty("--sy", String((r0.height + 2 * D) / Math.max(1, r0.height)));
    dim.className = "lfx-dim";
    clip.insertAdjacentHTML("beforeend", `${glow ? `<div class="lfx-glow"></div>` : ""}<div class="lfx-edge"></div>` +
      (motion ? `<div class="lfx-ring"></div><div class="lfx-ring"></div><div class="lfx-ring"></div>` : `<div class="lfx-ring"></div>`));
    el.classList.add("locate-flash");
    t = window.setTimeout(motion ? done : fadeOut, motion ? LOCATE_FX_MS : LOCATE_STATIC_MS);
  };
  // motion off: the whole layer fades, the outline (drawn over by the layer's edge) goes with it
  const fadeOut = () => {
    clearTimeout(t); el.classList.remove("locate-flash"); fx.classList.add("out");
    t = window.setTimeout(done, FADE_EXIT_MS);
  };
  const cancel = () => {
    if (phase !== "travel") return;
    phase = "gone"; clearTimeout(t);
    if (!motion) { fadeOut(); return; }
    dim.className = "lfx-dim out";
    t = window.setTimeout(done, LOCATE_OUT_MS);
  };
  place();
  document.body.appendChild(fx);
  raf = requestAnimationFrame(tick);
  fxCleanup = done;
  return { reveal, cancel };
}
