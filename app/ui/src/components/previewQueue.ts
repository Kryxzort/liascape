import { useEffect, type RefObject } from "react";
import { previewsSeen, type PreviewsSeen } from "../api/client";

// What the backend needs to make every library card's previews ahead of the card (Web/PreviewBackfill.cs): which cards are on
// screen now (they go first), the item open in the sidebar (before them), the Library's order (the rest follow it) and a
// card's box in device px (the clips it makes for cards off screen are that size, as a card on screen would ask:
// components/clipSource.ts). Sent when one of them changes, a moment after (a scroll sends once it stops), the order only when
// it changed. Nothing here decides what to make: the backend follows the preview settings itself.
// Guard: --probe probe-libops.js libops:backfill.
const SEND_MS = 400;
const onScreen = new Set<string>();
const pathOf = new Map<Element, string>();
let io: IntersectionObserver | null = null;
let box: { w: number; h: number } | null = null;
let side: string | null = null;
let order: string[] | null = null;
// what the backend has: the order's version and the box it was last sent (a failed send, or a backend that restarted and
// re-read by the page — a new order — sends them again)
let orderVer = 0, orderSentVer = 0, boxSent = "";
let timer = 0, lastSent = "";

function schedule() { if (!timer) timer = window.setTimeout(send, SEND_MS); }
function send() {
  timer = 0;
  const body: PreviewsSeen = { visible: [...onScreen], side };
  const ver = orderVer, bk = box ? `${box.w}x${box.h}` : "";
  if (order && ver !== orderSentVer) body.order = order;
  if (box && bk !== boxSent) body.box = box;
  const key = JSON.stringify([body.visible, side]);
  if (key === lastSent && !body.order && !body.box) return;
  lastSent = key;
  void previewsSeen(body).then((ok) => {
    if (!ok) { lastSent = ""; return; }
    if (body.order) orderSentVer = ver;
    if (body.box) boxSent = bk;
  });
}

// PERF: one observer for every card; its entries carry their boxes, so nothing here reads layout
function observer(): IntersectionObserver {
  return io ??= new IntersectionObserver((es) => {
    let moved = false;
    for (const e of es) {
      const p = pathOf.get(e.target);
      if (!p) continue;
      if (e.isIntersecting) {
        if (!onScreen.has(p)) { onScreen.add(p); moved = true; }
        const r = e.boundingClientRect, dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
        // rounded to 8 css px, as a card's own clip request is (clipSource.ts useBoxSize)
        const w = Math.round(Math.ceil(r.width / 8) * 8 * dpr), h = Math.round(Math.ceil(r.height / 8) * 8 * dpr);
        if (w > 0 && h > 0 && (!box || box.w !== w || box.h !== h)) { box = { w, h }; moved = true; }
      } else if (onScreen.delete(p)) moved = true;
    }
    if (moved) schedule();
  });
}

// a library card: on screen or not
export function useSeenCard(ref: RefObject<Element | null>, path: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    pathOf.set(el, path);
    observer().observe(el);
    return () => {
      io?.unobserve(el);
      pathOf.delete(el);
      if (onScreen.delete(path)) schedule();
    };
  }, [ref, path]);
}

// the Library's order (its sort and filter, as shown): the backend makes the rest of the library after these
export function setPreviewOrder(paths: string[]) {
  order = paths; orderVer++;
  // a new list after a backend restart (the page re-reads it): the box goes along again
  boxSent = "";
  schedule();
}
export function setPreviewSide(path: string | null) {
  if (side === path) return;
  side = path;
  schedule();
}
