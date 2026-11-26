import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { FADE_EXIT_MS, reducedMotion, useMotion } from "./motion";
import { softSpringCss } from "./flipGlide";

// COOL: the window's opening. The app logo shows at the window's centre from the window's first frame and pops in on the soft
// spring while one accent ring ripples off it (Play's ring: the app launching), then the logo becomes the library: the whole
// logo splits into pieces, one per card of the Library's first row, that glide to those cards and become them while the
// cover dissolves behind; then the rest of the cards in view rise into place in reading order (row by row, left to right):
// each comes up from a little below its place, past it and back on the spring as it fades in. The library stays unseen
// until its cards arrive. Without cards to land on (an empty library, another page showing, the first data not in by
// HOLD_MAX_MS) the logo lifts away toward the viewer instead and the page shows as it is. Motion off: the logo shows still,
// holds, and everything fades out on opacity alone. index.css § the window's opening. Guard: probe-intro (every cell).
//
// The cover, the logo and its pop are the page's own markup (index.html #intro), drawn before any of the app's JavaScript
// has loaded: the window's first frame is the logo, in the production build and under Vite's dev server alike (whose
// module graph takes seconds to load), and the shell shows the window once that frame is drawn (app/shell/main.js
// ready-to-show). index.html's first script decides, before that frame, whether it plays and how it looks: only when the
// shell asks for it (main.js opens the page with `?intro`), so the probes and a plain browser tab never see it unless they
// ask, and once per window (sessionStorage outlives a reload in the same window, Vite's full reload or the renderer
// recovery's, and starts empty in a new one); still with motion off, the theme's colours and the logo's ground from the
// copies kept for the first frame. This component takes the overlay over where it is, the same element mid-pop, and plays
// the rest. Its ask (window.__liascapeIntro) is read once when the module loads and taken: a hot update that re-runs this
// module finds none and ends a cover still showing. Guard: probe-intro intro:firstFrame, intro:once, intro:absent
type Boot = { at: number };
const BOOT: Boot | null = (() => {
  const w = window as { __liascapeIntro?: Boot };
  const b = w.__liascapeIntro ?? null;
  delete w.__liascapeIntro;
  return b;
})();
const OVERLAY = BOOT ? document.getElementById("intro") : null;
const ROOT_CLASSES = ["intro-on", "intro-still", "intro-no-glow", "intro-light"];
// the overlay leaves the page with the classes that drew it
function finish() {
  document.getElementById("intro")?.remove();
  document.documentElement.classList.remove(...ROOT_CLASSES);
}
if (!OVERLAY) finish();

// The cover starts to dissolve REVEAL_MS after the logo first showed (index.html) once the first data is in (the library's
// cards built under it, never under a moving logo), and HOLD_MAX_MS after it whatever the backend does, but never before
// the app's code has had DATA_MIN_MS to ask for that data: under Vite's dev server the code alone takes longer than
// HOLD_MAX_MS to load, and a hold over before the first request could only ever lift. It is gone OUT_MS later (the lift)
// or once the last card has joined (the hand-over).
// Nothing holds input and nothing ends it early: the overlay and its tiles never take a pointer event, every click, key,
// wheel and drag reaches the page at once (a card not shown yet is there to be clicked or focused), and the opening plays
// on to its end meanwhile. Guard: probe-intro intro:plays (the deadlines), intro:slowData, intro:click, intro:key,
// intro:scroll
const REVEAL_MS = 320, HOLD_MAX_MS = 1200, DATA_MIN_MS = 600;
const OUT_MS = 320, OUT_STILL_MS = FADE_EXIT_MS;
// the hand-over: each tile glides GLIDE_MS on `--spring-soft`'s curve, the next one a little after it in reading order (all
// of them within TILE_SPREAD_MS); under its piece of the logo the card's picture fades in (FACE_MS), then the piece fades
// off it (SWAP_MS, SWAP_AT_MS into the glide): one opaque layer over another, so the tile never goes pale half-way. Landed,
// its card shows under it and it fades out in TILE_FADE_MS. The rest of the cards in view rise from CASCADE_LEAD_MS before
// the last tile lands, one after another in reading order (CASCADE_GAP_MS apart, all within CASCADE_SPREAD_MS): each starts
// RISE_PX below its place and comes up on `--spring`'s curve over RISE_MS (past its place by the spring's overshoot, about
// 23 %, a few px, then back with a smaller dip), fading in over RISE_FADE_MS, so the overshoot shows. `--spring-soft`'s 8 %
// was too small to see at a rise this short. Measured with 6 columns and 5 rows in view: done about 1.1 s after the cover
// opens.
const GLIDE_MS = 260, TILE_SPREAD_MS = 80, FACE_MS = 50, SWAP_AT_MS = 40, SWAP_MS = 150, TILE_FADE_MS = 100;
const CASCADE_LEAD_MS = 60, CASCADE_GAP_MS = 12, CASCADE_SPREAD_MS = 300, RISE_MS = 480, RISE_PX = 24, RISE_FADE_MS = 100;
// DEBUG: `?introSlow=<n>` (the Vite dev build only) plays the opening n times slower, its timers and every animation in it,
// for a recording to judge it frame by frame; a production build always plays it at 1.
const SLOW = import.meta.env.DEV ? Math.max(1, Number(new URLSearchParams(location.search).get("introSlow")) || 1) : 1;
const ms = (t: number) => t * SLOW;
// "Smooth window animations" and "Glow effects" for the next window's first frame (index.html reads them)
const MOTION_KEY = "liascape.introMotion", GLOW_KEY = "liascape.introGlow";

// scroll-driven animations (Chromium 115+); the DOM types this TypeScript ships don't have them yet
const ScrollTimelineCtor = (globalThis as unknown as { ScrollTimeline?: new (o: { source: Element; axis: "block" }) => AnimationTimeline }).ScrollTimeline;

type Box = { x: number; y: number; w: number; h: number };
const boxOf = (r: DOMRect): Box => ({ x: r.left, y: r.top, w: r.width, h: r.height });
// One tile of the hand-over: its card, its piece of the logo (`from`, in the window), and the card's picture when it is
// already loaded (the tile turns into it; else into the card's empty ground).
type Tile = { key: string; i: number; card: HTMLElement; from: Box; thumb: string | null };
// the hand-over: the logo's box, the first row's tiles, and the other cards in view in reading order
type Plan = { logo: Box; tiles: Tile[]; rest: HTMLElement[] };

// The Library's first row of cards, as the logo cut into pieces, and the rest of the cards in view; null when there is
// nothing to land on: another page shows, the library is empty or not built yet, the row is out of view. The pieces cover
// the whole logo, edge to edge, in the first row's order: rows of pieces as close to the cards' shape as an even split
// allows (3×3 for nine square cards; seven: 3, 2, 2), so the logo is whole when it splits and each piece only grows into
// its card. Read in a frame callback, where the frame lays the page out anyway.
// Guard: probe-intro intro:cards, intro:fewCards, intro:fallback:*
function measurePlan(logo: HTMLElement | null): Plan | null {
  const scroll = document.querySelector('.app[data-page="library"] .lib-scroll');
  const grid = scroll?.querySelector(".grid");
  if (!logo || !scroll || !grid) return null;
  const view = scroll.getBoundingClientRect();
  const cards: { el: HTMLElement; r: DOMRect }[] = [];
  for (const el of grid.children)
    if (el instanceof HTMLElement && el.matches(".card[data-key]")) cards.push({ el, r: el.getBoundingClientRect() });
  const top = cards[0]?.r.top;
  const first = cards.filter(({ r }) => Math.abs(r.top - top) <= 1);
  if (!first.length || first.some(({ r }) => r.width < 8 || r.height < 8 || r.top < view.top - 1 || r.bottom > view.bottom || r.left < 0 || r.right > innerWidth)) return null;
  const L = boxOf(logo.getBoundingClientRect()), n = first.length;
  const aspect = first[0].r.width / first[0].r.height;
  const rows = Math.min(n, Math.max(1, Math.round(Math.sqrt(n / aspect))));
  const tiles: Tile[] = [];
  for (let row = 0, i = 0; row < rows; row++) {
    const k = Math.floor(n / rows) + (row < n % rows ? 1 : 0);
    for (let c = 0; c < k; c++, i++) {
      const { el } = first[i];
      const img = el.querySelector<HTMLImageElement>("img.thumb:not(.anim)");
      tiles.push({ key: el.dataset.key!, i, card: el, from: { x: L.x + (c * L.w) / k, y: L.y + (row * L.h) / rows, w: L.w / k, h: L.h / rows },
        thumb: img?.complete && img.naturalWidth ? img.currentSrc : null });
    }
  }
  const rest = cards.slice(n).filter(({ r }) => r.bottom > view.top && r.top < view.bottom).map(({ el }) => el);
  return { logo: L, tiles, rest };
}

// a tile laid out on its card's box `to`, its glide starting from its piece of the logo, and the logo inside it drawn where
// the logo is: called at the start and again whenever the card moves (a scroll, a resize) while the tile flies
function place(el: HTMLElement, glide: Animation | null, logo: Box, from: Box, to: Box) {
  const sx = from.w / to.w, sy = from.h / to.h;
  Object.assign(el.style, { left: `${to.x}px`, top: `${to.y}px`, width: `${to.w}px`, height: `${to.h}px` });
  const piece = el.querySelector<HTMLElement>(".intro-card-logo");
  if (piece) Object.assign(piece.style, { left: `${(logo.x - from.x) / sx}px`, top: `${(logo.y - from.y) / sy}px`,
    width: `${logo.w / sx}px`, height: `${logo.h / sy}px` });
  (glide?.effect as KeyframeEffect | null)?.setKeyframes([{ transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${sx}, ${sy})` },
    { transform: "none" }]);
}

// the hand-over's timeline (ms from the cover opening): tile i leaves at stagger·i and lands GLIDE_MS later; card k of the
// rest joins at cascadeAt + gap·k, never before the first tile has landed; `end` = the last thing done
function timeline(n: number, m: number) {
  const stagger = n > 1 ? Math.min(10, TILE_SPREAD_MS / (n - 1)) : 0;
  const lastLand = (n - 1) * stagger + GLIDE_MS;
  const gap = m > 1 ? Math.min(CASCADE_GAP_MS, CASCADE_SPREAD_MS / (m - 1)) : 0;
  const cascadeAt = Math.max(GLIDE_MS, lastLand - CASCADE_LEAD_MS);
  return { stagger, gap, cascadeAt, end: Math.max(lastLand + TILE_FADE_MS, m ? cascadeAt + (m - 1) * gap + RISE_MS : 0) + 20 };
}

// play: the logo showing; open: the cover dissolving (and the hand-over)
type Phase = "play" | "open" | "gone";

export function Intro() {
  const [phase, setPhase] = useState<Phase>(OVERLAY ? "play" : "gone");
  // the look is fixed for the whole sequence (index.html chose it for the first frame): a setting landing mid-way changes
  // nothing on screen
  const [still] = useState(() => document.documentElement.classList.contains("intro-still"));
  const ready = useStore((s) => s.settings != null);
  const glows = useStore((s) => s.settings?.glows !== false);
  const motion = useMotion();
  const logo = useRef<HTMLElement | null>(OVERLAY?.querySelector<HTMLElement>(".intro-logo") ?? null);
  // the frame the logo first showed (index.html; else the first time the hold is counted): the hold counts from it; and when
  // the app's code first counted it
  const started = useRef(0), mounted = useRef(0);
  // the hand-over, measured as the cover starts to dissolve; null = the logo lifts away
  const [plan, setPlan] = useState<Plan | null>(null);

  // "Smooth window animations" (not while the OS asks for reduced motion: that answer is read live) and "Glow effects" for
  // the next window's opening, once the saved settings are in
  useEffect(() => {
    if (!ready) return;
    try {
      if (!reducedMotion()) localStorage.setItem(MOTION_KEY, motion ? "1" : "0");
      localStorage.setItem(GLOW_KEY, glows ? "1" : "0");
    } catch { /* storage off: motion and glow next time */ }
  }, [ready, motion, glows]);

  // timers, not animation ends. The cover's opening waits for the first data (`ready`: the settings and the library come in
  // one store update, so the Library's cards are built in the render that sets it), at most HOLD_MAX_MS from the logo.
  useEffect(() => {
    if (phase !== "play") return;
    const now = performance.now();
    started.current ||= BOOT?.at || now;
    mounted.current ||= now;
    const left = ready ? ms(REVEAL_MS) - (now - started.current)
      : Math.max(ms(HOLD_MAX_MS) - (now - started.current), ms(DATA_MIN_MS) - (now - mounted.current));
    let f = 0;
    const t = setTimeout(() => {
      // the cards as this frame draws them; the plan and the phase land in one render
      f = requestAnimationFrame(() => { setPlan(still ? null : measurePlan(logo.current)); setPhase("open"); });
    }, Math.max(0, left));
    return () => { clearTimeout(t); cancelAnimationFrame(f); };
  }, [phase, ready, still]);
  // once open, its end is fixed by what opened (data landing meanwhile doesn't move it); the plan goes with it, and with it
  // the hand-over's listeners
  useEffect(() => {
    if (phase !== "open") return;
    const out = still ? OUT_STILL_MS : plan ? timeline(plan.tiles.length, plan.rest.length).end : OUT_MS;
    const t = setTimeout(() => { setPhase("gone"); setPlan(null); }, ms(out));
    return () => clearTimeout(t);
  }, [phase, still, plan]);

  // the overlay's state on the element index.html drew, in the frame that renders it (the tiles' animations start in the
  // same frame, below); gone = it leaves the page
  useLayoutEffect(() => {
    if (!OVERLAY) return;
    if (phase === "gone") { finish(); return; }
    OVERLAY.dataset.phase = phase;
    OVERLAY.classList.toggle("open", phase === "open");
    OVERLAY.classList.toggle("cards", !!plan);
  }, [phase, plan]);

  // COOL: the tiles fly from the logo to their cards and the rest of the cards rise into place after them. Web Animations, all started
  // before the frame that first draws the tiles: no frame shows a tile on its card un-animated or a card before its turn
  // (each card's own animation keeps it unseen until then, `fill: backwards`). Transform and opacity only, on the
  // compositor; the cards' rise on `opacity` / `translate`, which composes with a hover's lift. Cards out of view are left
  // alone. The tiles follow their cards: a scroll of the grid moves them with it in the same frame, on the compositor (a
  // `translate` on a ScrollTimeline of the grid, composed with the glide's `transform`), and a resize re-places them where
  // their cards are now. Guard: probe-intro intro:cards, intro:scroll
  useLayoutEffect(() => {
    if (!plan || !OVERLAY) return;
    const { tiles, rest, logo: L } = plan;
    const tl = timeline(tiles.length, rest.length);
    const ease = softSpringCss().e;
    const anims: Animation[] = [];
    const flying: { el: HTMLElement; glide: Animation; t: Tile; to: Box }[] = [];
    const scrolls: Animation[] = [];
    const scroller = tiles[0].card.closest<HTMLElement>(".lib-scroll");
    const s0 = scroller?.scrollTop ?? 0, roomNow = () => (scroller ? scroller.scrollHeight - scroller.clientHeight : 0);
    let room = roomNow();
    const linked = !!(ScrollTimelineCtor && scroller && room > 0);
    // the scroll-linked translate maps the grid's whole scroll range onto `room` px: s0 - scrollTop at every offset
    const span = () => [{ translate: `0 ${s0}px` }, { translate: `0 ${s0 - room}px` }];
    // a card's box as it would be at the scroll offset the tiles were laid out at (the scroll-linked translate does the rest)
    const atStart = (r: DOMRect): Box => ({ ...boxOf(r), y: r.top + (linked ? scroller!.scrollTop - s0 : 0) });
    for (const t of tiles) {
      const el = OVERLAY.querySelector<HTMLElement>(`.intro-card[data-tile="${t.i}"]`);
      if (!el) continue;
      const d = t.i * tl.stagger, to = atStart(t.card.getBoundingClientRect());
      if (linked) scrolls.push(el.animate(span(), { timeline: new ScrollTimelineCtor!({ source: scroller!, axis: "block" }), fill: "both" }));
      const glide = el.animate([{ transform: "none" }, { transform: "none" }], { duration: GLIDE_MS, delay: d, easing: ease, fill: "backwards" });
      place(el, glide, L, t.from, to);
      flying.push({ el, glide, t, to });
      anims.push(glide);
      const face = el.querySelector(".intro-card-face"), piece = el.querySelector(".intro-card-logo");
      if (face) anims.push(face.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FACE_MS, delay: d, fill: "backwards" }));
      if (piece) anims.push(piece.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SWAP_MS, delay: d + SWAP_AT_MS, fill: "backwards" }));
      anims.push(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: TILE_FADE_MS, delay: d + GLIDE_MS, fill: "forwards" }));
      // its card shows under it as it lands
      anims.push(t.card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay: d + GLIDE_MS, fill: "backwards" }));
    }
    // the rise on `translate` (it composes with a hover's lift on `transform`), the fade with it; unseen until its turn
    const spring = getComputedStyle(document.documentElement).getPropertyValue("--spring").trim() || ease;
    rest.forEach((el, k) => {
      const delay = tl.cascadeAt + k * tl.gap;
      anims.push(el.animate([{ translate: `0 ${RISE_PX}px` }, { translate: "0 0" }], { duration: RISE_MS, delay, easing: spring, fill: "backwards" }));
      anims.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: RISE_FADE_MS, delay, easing: "linear", fill: "backwards" }));
    });
    if (SLOW > 1) for (const a of anims) a.playbackRate = 1 / SLOW;
    // a card that moves other than by the grid's scroll (a resize, a re-fit, or a scroll where the scroll-linked translate
    // can't run): its tile lands where the card is now. Read on the move's own events, a frame at a time; a card that left
    // the page (another tab) keeps its last place.
    let f = 0;
    const follow = () => {
      if (f) return;
      f = requestAnimationFrame(() => {
        f = 0;
        // the scroll range changed (more or fewer rows, a resize): the same offset is now another progress
        if (linked && roomNow() > 0 && Math.abs(roomNow() - room) >= 0.5) {
          room = roomNow();
          for (const a of scrolls) (a.effect as KeyframeEffect | null)?.setKeyframes(span());
        }
        for (const x of flying) {
          const r = x.t.card.getBoundingClientRect();
          if (!r.width) continue;
          const to = atStart(r);
          if (Math.abs(to.x - x.to.x) < 0.5 && Math.abs(to.y - x.to.y) < 0.5 && Math.abs(to.w - x.to.w) < 0.5 && Math.abs(to.h - x.to.h) < 0.5) continue;
          x.to = to;
          place(x.el, x.glide, L, x.t.from, x.to);
        }
      });
    };
    const opts = { capture: true, passive: true } as const;
    if (!linked) addEventListener("scroll", follow, opts);
    addEventListener("resize", follow, opts);
    // a card or the grid resized under its tile (the grid re-fitting its columns, a scrollbar coming or going)
    const ro = new ResizeObserver(follow);
    for (const x of flying) ro.observe(x.t.card);
    if (scroller) ro.observe(scroller);
    return () => {
      removeEventListener("scroll", follow, opts); removeEventListener("resize", follow, opts); ro.disconnect(); cancelAnimationFrame(f);
      for (const a of scrolls) a.cancel();
    };
  }, [plan]);

  // DEBUG: the slowed opening (SLOW) slows the stylesheet's animations too, from the frame after each one starts
  const shown = phase !== "gone";
  useEffect(() => {
    if (SLOW === 1 || !shown || !OVERLAY) return;
    let f = 0;
    const tick = () => {
      for (const a of OVERLAY.getAnimations({ subtree: true }))
        if (a.timeline === document.timeline && a.playbackRate !== 1 / SLOW) a.playbackRate = 1 / SLOW;
      f = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(f);
  }, [shown]);

  // over the logo: as they leave, its pieces are the whole of its picture while the logo itself fades out under them; laid
  // out and animated in the layout effect above
  if (!plan || !OVERLAY) return null;
  return createPortal(plan.tiles.map((t) => (
    <div key={t.key} className="intro-card" data-tile={t.i} data-key={t.key}>
      <div className="intro-card-face">{t.thumb && <img src={t.thumb} alt="" draggable={false} />}</div>
      <div className="intro-card-logo" />
    </div>
  )), OVERLAY);
}
