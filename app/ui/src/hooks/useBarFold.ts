import { useLayoutEffect, useRef, useState, type RefObject } from "react";

// COOL: the playlist bar folds like a drawer. Collapsing, the whole bar sinks by its body's height on the soft spring (its
// head settles where the folded bar rests) while the body (the row, or the empty hint) fades out; expanding plays it back:
// the bar rises out of the window's bottom edge and the row fades in. Transform + opacity only (WAAPI).
// PERF: the body stays mounted while folded (index.css hides it with display: none once the fold has played): a click
// neither tears down nor builds a component per playlist item, so the chevron's turn and the slide get their frames from
// the first one. Guard: probe-layout perf:plFold, look:plFold.
// While it plays the body is out of flow (`data-fold` on the bar: absolutely placed where it sits in flow), so the bar's
// layout height is the folded one from a collapse's click to an expand's last frame. Its ResizeObserver (PlaylistBar
// --playlist-bar-h) writes the folded height at a collapse's click (the grid grows behind the sinking bar) and the
// unfolded one when an expand has landed (the grid's bottom is trimmed under the risen bar): the grid never has a gap
// above the bar, and its column fit ignores the bar (hooks/useGridFit.ts), so neither write moves a card.
// A collapse starts in the click's layout effect from the body height measured while it showed: nothing is measured in the
// click. An expand from rest shows the body out of flow and starts in its ResizeObserver's first callback (after that
// frame's layout, before its paint), from the height that layout gave it. Motion off: index.css swaps at once.

let tok: { e: string; ms: number } | null = null;
function spring() {
  if (tok) return tok;
  const cs = getComputedStyle(document.documentElement);
  const dur = cs.getPropertyValue("--spring-soft-dur").trim();
  tok = { e: cs.getPropertyValue("--spring-soft").trim() || "ease-out", ms: (parseFloat(dur) || 0.5) * (dur.endsWith("ms") ? 1 : 1000) };
  return tok;
}

type Run = { bar: Animation; body: Animation; y: [number, number]; o: [number, number] };

function folder() {
  let h = 0, run: Run | null = null, waiting = false, target: boolean | null = null;
  let bar: HTMLElement | null = null, body: HTMLElement | null = null;
  const settle = () => {
    waiting = false;
    if (run) { run.bar.cancel(); run.body.cancel(); run = null; }
    bar?.removeAttribute("data-fold");
  };
  // where a running fold is now (its eased progress on each animation): a reversal starts from that frame, never a jump
  const at = (a: Animation, [from, to]: [number, number]) => from + (to - from) * (a.effect?.getComputedTiming().progress ?? 1);
  const play = (collapse: boolean) => {
    if (!bar || !body || !h) { settle(); return; }
    const y: [number, number] = [run ? at(run.bar, run.y) : collapse ? -h : 0, collapse ? 0 : -h];
    const o: [number, number] = [run ? at(run.body, run.o) : collapse ? 1 : 0, collapse ? 0 : 1];
    if (run) { run.bar.cancel(); run.body.cancel(); }
    bar.dataset.fold = collapse ? "out" : "in";
    const { e, ms } = spring();
    // fill both: the last frame holds until settle() swaps the bar's layout and drops it in one go (no frame in between)
    const ba = bar.animate([{ transform: `translateY(${y[0]}px)` }, { transform: `translateY(${y[1]}px)` }], { duration: ms, easing: e, fill: "both" });
    // the row is gone before the bar lands, and comes in while the bar is still rising
    const bo = body.animate([{ opacity: o[0] }, { opacity: o[1] }], { duration: ms * (collapse ? 0.45 : 0.6), easing: collapse ? "ease-in" : "ease-out", fill: "both" });
    const r: Run = run = { bar: ba, body: bo, y, o };
    ba.finished.then(() => { if (run === r) settle(); }, () => {});
  };
  return {
    bind(b: HTMLElement | null, d: HTMLElement | null) { bar = b; body = d; },
    // the body's border-box height while it shows: how far the bar travels
    sized(px: number) {
      if (px <= 0) return;
      h = px;
      if (waiting) { waiting = false; play(false); }
    },
    update(collapsed: boolean, motion: boolean, live: boolean) {
      if (!live || !motion) { target = collapsed; settle(); return; }
      if (collapsed === target) return;
      target = collapsed;
      if (!collapsed && !run) { bar?.setAttribute("data-fold", "in"); waiting = true; return; }
      waiting = false;
      play(collapsed);
    },
    settle,
  };
}

export function useBarFold(barRef: RefObject<HTMLElement | null>, bodyRef: RefObject<HTMLElement | null>, collapsed: boolean, motion: boolean) {
  const [fold] = useState(folder);
  const live = useRef(false);
  // before the `live` effect below: on a mount — the first, or the bar shown again by App.tsx's <Activity> — `live` is still
  // false and the bar takes its state at once; only a change while shown plays
  useLayoutEffect(() => {
    fold.bind(barRef.current, bodyRef.current);
    fold.update(collapsed, motion, live.current);
  }, [fold, barRef, bodyRef, collapsed, motion]);
  useLayoutEffect(() => {
    live.current = true;
    const body = bodyRef.current;
    const ro = body ? new ResizeObserver(([e]) => fold.sized(e.borderBoxSize[0].blockSize)) : null;
    if (body) ro!.observe(body);
    return () => { live.current = false; ro?.disconnect(); fold.settle(); };
  }, [fold, bodyRef]);
}
