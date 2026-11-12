import { useEffect, useState, type RefObject } from "react";
import { clipInfo, clipFile, clipShrink, type ClipQuality } from "../api/client";
import { useStore } from "../store";

// Which preview clip a card plays (the backend's Web/ClipStore.cs makes and keeps them; docs/decisions.md § "Play every
// on-screen video preview, each as a small clip"). A card asks for a clip sized to its own box: the box's CSS px ×
// devicePixelRatio × the quality's factor (Settings → "Video preview quality"); the backend snaps that up to a few widths,
// keeps the source's shape (the card crops it, object-fit: cover) and answers with the clip it has now — a 10 s stand-in
// until the full-length one exists, a narrower one while a wider one is made. While something better is coming the card
// asks again every POLL_MS and hands over to it mid-play (components/PreviewPlayer.tsx). Off screen a card asks nothing,
// so nothing is made for it. Guard: matrix clip:size, clip:shortToFull.
export const QUALITY_FACTOR: Record<ClipQuality, number> = { low: 0.75, mid: 1, high: 1.5 };
const POLL_MS = 4000;

export const useClipQuality = () => useStore((s) => {
  const q = s.settings?.videoPreviewQuality;
  return q === "low" || q === "high" ? q : "mid";
});

// ---- the box a clip plays in: one ResizeObserver for every card (sizes arrive after layout, nothing forced) ----
type Sized = (w: number, h: number) => void;
const sizeWatchers = new Map<Element, Sized>();
let ro: ResizeObserver | null = null;
export function useBoxSize(ref: RefObject<Element | null>, on: boolean): { w: number; h: number } | null {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    // PERF: rounded to 8 css px, so a window resize re-asks only once a card has changed by a step
    sizeWatchers.set(el, (w, h) => setBox((b) => {
      const nw = Math.ceil(w / 8) * 8, nh = Math.ceil(h / 8) * 8;
      return b && b.w === nw && b.h === nh ? b : nw > 0 && nh > 0 ? { w: nw, h: nh } : b;
    }));
    ro ??= new ResizeObserver((es) => { for (const e of es) { const s = e.borderBoxSize?.[0]; sizeWatchers.get(e.target)?.(s ? s.inlineSize : e.contentRect.width, s ? s.blockSize : e.contentRect.height); } });
    ro.observe(el);
    return () => { sizeWatchers.delete(el); ro?.unobserve(el); };
  }, [on, ref]);
  return on ? box : null;
}

// ---- what each card needs, for the idle shrink ----
// path → the last box (device px × factor) and quality a card on screen asked for; `shown` = the cards that play a clip now
type Need = { w: number; h: number; q: ClipQuality };
const needs = new Map<string, Need>();
const shown = new Map<string, number>();
let idleSent = false;
// The app goes inactive: the backend may shrink, one at a time, a clip 2x wider than its card now needs — never one on screen
// (read here, before the inactive window unmounts every preview). Back active: it stops.
useStore.subscribe((s, p) => {
  if (s.appActive === p.appActive) return;
  if (!s.appActive) {
    const items = [...needs].filter(([path]) => !shown.get(path)).map(([path, n]) => ({ path, ...n }));
    if (!items.length) return;
    idleSent = true;
    void clipShrink(true, items);
  } else if (idleSent) {
    idleSent = false;
    void clipShrink(false, []);
  }
});

// The clip URL a card plays now (null: none yet), and `retry` for a clip that failed to load (replaced and deleted since).
export function useClipSrc(path: string | null, box: { w: number; h: number } | null): { src: string | null; retry: () => void } {
  const q = useClipQuality();
  const [src, setSrc] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // off screen: forget it, so a card coming back plays only what the backend names then (an older file may be gone)
  if (!path && src) setSrc(null);
  const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const w = box ? Math.round(box.w * dpr * QUALITY_FACTOR[q]) : 0;
  const h = box ? Math.round(box.h * dpr * QUALITY_FACTOR[q]) : 0;
  useEffect(() => {
    if (!path || !w || !h) return;
    let dead = false, timer = 0;
    needs.set(path, { w, h, q });
    shown.set(path, (shown.get(path) ?? 0) + 1);
    const ask = async () => {
      const r = await clipInfo(path, w, h, q).catch(() => null);
      if (dead) return;
      if (r?.v) setSrc(clipFile(path, r.v));
      // pending: a better clip is being made for this card; no answer: the backend is away, try again later
      if (!r || r.pending) timer = window.setTimeout(ask, r ? POLL_MS : POLL_MS * 4);
    };
    void ask();
    return () => {
      dead = true; clearTimeout(timer);
      const n = (shown.get(path) ?? 1) - 1;
      if (n > 0) shown.set(path, n); else shown.delete(path);
    };
  }, [path, w, h, q, attempt]);
  return { src: path && w && h ? src : null, retry: () => setAttempt((a) => a + 1) };
}
