import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { FADE_EXIT_MS, reducedMotion, useMotion } from "./motion";

// COOL: the window's opening. The app logo pops in at the window's centre on the soft spring while one accent ring ripples
// off it (Play's ring: the app launching), then the cover dissolves and the logo lifts away toward the viewer, the UI
// showing through. Motion off: the logo fades in, holds, and everything fades out on opacity alone. index.css § the
// window's opening. Guard: probe-intro (every cell).
//
// It plays only when the shell asks for it (app/shell/main.js opens the page with `?intro`), so the probes and a plain
// browser tab never see it unless they ask, and once per window: sessionStorage outlives a reload in the same window (Vite's
// full reload, the renderer recovery's) and starts empty in a new one. Read once when the module loads; a hot update that
// re-runs this module finds the mark and stays quiet. Guard: probe-intro intro:once, intro:absent
const SHOWN_KEY = "liascape.introShown";
function wanted(): boolean {
  if (!new URLSearchParams(location.search).has("intro")) return false;
  try {
    if (sessionStorage.getItem(SHOWN_KEY)) return false;
    sessionStorage.setItem(SHOWN_KEY, "1");
  } catch { /* storage off: once per page load */ }
  return true;
}
const WANTED = wanted();

// It starts with the page, before the backend answers, so it covers the first data load instead of adding to it: the
// theme's colours come from the copy the store keeps for the first frames (store applyThemeVars), "Smooth window
// animations" from the copy kept here (the OS's reduced motion is read live). The logo shows once its picture is decoded
// (at most DECODE_MAX_MS: it must never pop in half-way). The cover starts to dissolve REVEAL_MS after the logo starts once
// the first data is in (the library's cards built under it, never under a moving logo), and at HOLD_MAX_MS whatever the
// backend does; it is gone OUT_MS later. Nothing holds input: the overlay never takes a pointer event, and any click, key
// or wheel skips it. Guard: probe-intro intro:plays (the deadlines), intro:clickThrough
const DECODE_MAX_MS = 200, REVEAL_MS = 320, HOLD_MAX_MS = 700;
const OUT_MS = 320, OUT_STILL_MS = FADE_EXIT_MS;
const MOTION_KEY = "liascape.introMotion";
const keptMotion = () => { try { return localStorage.getItem(MOTION_KEY) !== "0"; } catch { return true; } };

const BASE = import.meta.env.BASE_URL;
const LOGO = { night: `${BASE}favicon.svg`, lavender: `${BASE}logo-lavender.svg` } as const;
type Variant = keyof typeof LOGO;
// the logo's two grounds: Lavender on a light theme, Night (the installed icon) on a dark one
function themeVariant(): Variant {
  const m = /^#?([0-9a-f]{6})$/i.exec(getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim());
  if (!m) return "night";
  const n = parseInt(m[1], 16), lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const y = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return y > 0.4 ? "lavender" : "night";
}

// cover: the page's ground while the logo decodes; play: the logo in; open: the cover dissolving; skip: a click or key fades
// it all out at once, from wherever it is (the root's own fade, so nothing jumps)
type Phase = "cover" | "play" | "open" | "skip" | "gone";

export function Intro() {
  const [phase, setPhase] = useState<Phase>(WANTED ? "cover" : "gone");
  // the look is fixed for the whole sequence: a setting landing mid-way changes nothing on screen
  const [look] = useState(() => (WANTED ? { still: reducedMotion() || !keptMotion(), variant: themeVariant() } : null));
  const ready = useStore((s) => s.settings != null);
  const motion = useMotion();
  const img = useRef<HTMLImageElement>(null);
  const started = useRef(0);

  // "Smooth window animations" for the next window's opening, once the saved settings are in (not while the OS asks for
  // reduced motion: that answer is read live)
  useEffect(() => {
    if (!ready || reducedMotion()) return;
    try { localStorage.setItem(MOTION_KEY, motion ? "1" : "0"); } catch { /* storage off: motion next time */ }
  }, [ready, motion]);

  useEffect(() => {
    if (!WANTED) return;
    let go = true;
    const start = () => { if (!go) return; go = false; started.current = performance.now(); setPhase((p) => (p === "cover" ? "play" : p)); };
    const t = setTimeout(start, DECODE_MAX_MS);
    img.current?.decode().then(start, start);
    return () => { go = false; clearTimeout(t); };
  }, []);

  // timers, not animation ends
  useEffect(() => {
    if (phase === "play") {
      const left = (ready ? REVEAL_MS : HOLD_MAX_MS) - (performance.now() - started.current);
      const t = setTimeout(() => setPhase("open"), Math.max(0, left));
      return () => clearTimeout(t);
    }
    if (phase === "open" || phase === "skip") {
      const t = setTimeout(() => setPhase("gone"), phase === "skip" || look?.still ? OUT_STILL_MS : OUT_MS);
      return () => clearTimeout(t);
    }
  }, [phase, ready, look]);

  // any click, key or wheel skips it; capture phase, nothing stopped, so the same input also reaches the UI underneath.
  // Guard: probe-intro intro:skip, intro:skipKey
  const live = phase === "cover" || phase === "play" || phase === "open";
  useEffect(() => {
    if (!live) return;
    const skip = () => setPhase("skip");
    const opts = { capture: true, passive: true } as const;
    for (const ev of ["pointerdown", "keydown", "wheel"] as const) addEventListener(ev, skip, opts);
    return () => { for (const ev of ["pointerdown", "keydown", "wheel"] as const) removeEventListener(ev, skip, opts); };
  }, [live]);

  if (phase === "gone" || !look) return null;
  const cls = ["intro", phase !== "cover" && "started", look.still && "still", phase === "open" && "open", phase === "skip" && "skip"]
    .filter(Boolean).join(" ");
  return (
    <div className={cls} data-phase={phase} aria-hidden>
      <div className="intro-bg" />
      <div className="intro-logo">
        <div className="intro-tile">
          <img ref={img} className="intro-img" data-variant={look.variant} src={LOGO[look.variant]} alt="" draggable={false} />
        </div>
        <span className="intro-ring" />
      </div>
    </div>
  );
}
