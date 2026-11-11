import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../api/client";
import { DEBUG_ON } from "./debugFlag";

interface Metrics { fps: number; low1: number; low01: number; ms: number; vis: number; cards: number; anim: number; heap: number; longs: number; }
const ZERO: Metrics = { fps: 0, low1: 0, low01: 0, ms: 0, vis: 0, cards: 0, anim: 0, heap: 0, longs: 0 };

export function DebugHud({ setTab, getScroll }: { setTab: (t: string) => void; getScroll: () => HTMLElement | null }) {
  const [m, setM] = useState<Metrics>(ZERO);
  const mRef = useRef<Metrics>(ZERO);
  // keep the latest callbacks in a ref so the meter/bridge effects run ONCE — App passes inline arrows, and re-running the
  // effect would reset the frame-stamp window (a bogus "1 fps" flash on every App re-render). Written after render.
  const cb = useRef({ setTab, getScroll });
  useLayoutEffect(() => { cb.current = { setTab, getScroll }; });
  // BRIDGE (liascapeDbg, fetchable) runs when the Settings toggle is on OR env/?debug (tooling/CDP).
  // OVERLAY is only shown by the SETTINGS toggles — env/?debug never force the visual HUD.
  const settingDebug = useStore((s) => !!s.settings?.debugMode);
  const overlayPref = useStore((s) => s.settings?.debugOverlay !== false);
  const bridgeOn = settingDebug || DEBUG_ON;
  const overlayOn = settingDebug && overlayPref;
  // The frame meter runs only while someone looks: the HUD overlay, or a `liascapeDbg.metrics()` sample. A rAF loop makes
  // Chromium produce a frame every refresh (144 fps of style + layout + IntersectionObserver work on an idle page), so an
  // always-on meter would measure — and cause — exactly the load it's there to catch.
  const overlayOnRef = useRef(overlayOn);
  useLayoutEffect(() => { overlayOnRef.current = overlayOn; });
  const meter = useRef<{ use: () => () => void; sample: (ms: number) => Promise<void> } | null>(null);

  // ---- rAF frame meter (counts real presented frames; immune to delta-averaging inflation) ----
  useEffect(() => {
    if (!bridgeOn) return;
    let users = 0, raf = 0, prev = 0, lastHud = 0, longs = 0;
    const stamps: number[] = []; // frame times in the last 1000ms → fps
    const durs: number[] = [];   // recent frametimes (ms) → low percentiles
    let po: PerformanceObserver | undefined;
    const pctLow = (sorted: number[], p: number) => {
      if (sorted.length < 50) return 0;
      const k = Math.max(1, Math.floor(sorted.length * p));
      let s = 0; for (let i = 0; i < k; i++) s += sorted[i];
      return Math.round(1000 / (s / k));
    };
    const publish = (now: number, dt: number) => {
      lastHud = now;
      const sorted = [...durs].sort((a, b) => b - a); // slowest first
      const scroll = cb.current.getScroll();
      let vis = 0, cards = 0, anim = 0;
      if (scroll) {
        const vr = scroll.getBoundingClientRect();
        const cs = scroll.querySelectorAll<HTMLElement>(".card");
        cards = cs.length;
        cs.forEach((c) => { const r = c.getBoundingClientRect(); if (r.bottom > vr.top && r.top < vr.bottom) vis++; });
        anim = scroll.querySelectorAll(".thumb.anim").length;
      }
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      const next: Metrics = {
        fps: stamps.length, low1: pctLow(sorted, 0.01), low01: pctLow(sorted, 0.001),
        ms: +dt.toFixed(1), vis, cards, anim,
        heap: mem ? Math.round(mem.usedJSHeapSize / 1048576) : 0,
        longs: longs * 4, // per 250ms → per second
      };
      longs = 0; mRef.current = next; setM(next);
    };
    const tick = (now: number) => {
      stamps.push(now); while (stamps.length && stamps[0] <= now - 1000) stamps.shift();
      const dt = now - prev; prev = now;
      if (dt > 0 && dt < 2000) { durs.push(dt); if (durs.length > 2400) durs.shift(); } // ~10s @240
      if (now - lastHud >= 250) publish(now, dt);
      raf = requestAnimationFrame(tick);
    };
    const use = () => {
      if (users++ === 0) {
        stamps.length = 0; durs.length = 0; prev = 0; lastHud = performance.now();
        try { po = new PerformanceObserver((l) => { longs += l.getEntries().length; }); po.observe({ entryTypes: ["longtask"] }); } catch { /* unsupported */ }
        raf = requestAnimationFrame(tick);
      }
      let released = false;
      return () => {
        if (released) return; released = true;
        if (--users === 0) { cancelAnimationFrame(raf); raf = 0; po?.disconnect(); po = undefined; }
      };
    };
    // a full second of frames, so `fps` is a real count; the low percentiles need ~50 frames
    const sample = (ms: number) => new Promise<void>((done) => { const release = use(); setTimeout(() => { release(); done(); }, ms); });
    meter.current = { use, sample };
    return () => { meter.current = null; if (users > 0) { cancelAnimationFrame(raf); po?.disconnect(); } users = 0; };
  }, [bridgeOn]);

  // the visible HUD keeps the meter running for as long as it shows
  useEffect(() => (overlayOn ? meter.current?.use() : undefined), [overlayOn, bridgeOn]);

  // ---- window.liascapeDbg bridge (registered once) ----
  useEffect(() => {
    if (!bridgeOn) return;
    const setTab = (t: string) => cb.current.setTab(t);
    const getScroll = () => cb.current.getScroll();
    const S = () => useStore.getState();
    const fmt = () => { const x = mRef.current; return `fps=${x.fps} low1%=${x.low1} low0.1%=${x.low01} ms=${x.ms} vis=${x.vis}/${x.cards} anim=${x.anim} heap=${x.heap}MB longs/s=${x.longs}`; };
    let autoRaf = 0;
    const stopScroll = () => { cancelAnimationFrame(autoRaf); autoRaf = 0; };
    const liascapeDbg = {
      help: () => "metrics fps tab(name) source(i) cardsize(S/M/L) aspect(x) gifs(bool) loadmore play stop next prev pause scroll(px) scrolltop scrollbottom autoscroll(pps,secs) stopscroll",
      // overlay off → sample a second first (the meter isn't running); callers await (CDP awaitPromise, executeJavaScript)
      metrics: async () => { if (!overlayOnRef.current) await meter.current?.sample(1100); return fmt(); },
      fps: async () => { if (!overlayOnRef.current) await meter.current?.sample(1100); return `fps=${mRef.current.fps} low1%=${mRef.current.low1} ms=${mRef.current.ms}`; },
      tab: (t: string) => { setTab(t); return "tab=" + t; },
      source: (i: number) => { S().setSource(i); return "source=" + i; },
      cardsize: (x: string) => { S().setSetting("cardSize", x); return "cardSize=" + x; },
      aspect: (x: string) => { S().setSetting("thumbnailAspect", x); return "aspect=" + x; },
      gifs: (on: boolean) => { S().setSetting("autoPlayGifs", on); return "autoPlayGifs=" + on; },
      active: (v: boolean) => { useStore.setState({ appActive: v }); return "appActive=" + v; }, // FREEZE FIX test hook
      anim: () => `animLayers=${document.querySelectorAll("img.thumb.anim, video.thumb.anim").length}`,
      loadmore: () => { S().loadMore(); return "loadmore"; },
      play: () => { S().playPlaylist(); return "play"; },
      stop: () => { S().stop(); return "stop"; },
      next: () => { api.next(); return "next"; },
      prev: () => { api.prev(); return "prev"; },
      pause: () => { api.pause(); return "pause"; },
      scroll: (px: number) => { const el = getScroll(); if (el) el.scrollTop += px; return "y=" + (el ? Math.round(el.scrollTop) : -1); },
      scrolltop: () => { const el = getScroll(); if (el) el.scrollTop = 0; return "top"; },
      scrollbottom: () => { const el = getScroll(); if (el) el.scrollTop = el.scrollHeight; return "bottom"; },
      autoscroll: (pps = 2500, secs = 15) => {
        const el = getScroll(); if (!el) return "no scroll";
        stopScroll();
        let last = 0, t0 = 0, dir = 1;
        const step = (t: number) => {
          if (!t0) t0 = t;
          const dt = last ? (t - last) / 1000 : 1 / 60; last = t;
          const max = Math.max(0, el.scrollHeight - el.clientHeight);
          let y = el.scrollTop + dir * pps * dt;
          if (y >= max) { y = max; dir = -1; } else if (y <= 0) { y = 0; dir = 1; }
          el.scrollTop = y;
          if ((t - t0) / 1000 < secs) autoRaf = requestAnimationFrame(step); else autoRaf = 0;
        };
        autoRaf = requestAnimationFrame(step);
        return `autoscroll ${pps}px/s ${secs}s`;
      },
      stopscroll: () => { stopScroll(); return "stopped"; },
    };
    (window as unknown as { liascapeDbg: typeof liascapeDbg }).liascapeDbg = liascapeDbg;
    console.log("[liascapeDbg] ready — liascapeDbg.help()");
    return () => { stopScroll(); try { delete (window as unknown as { liascapeDbg?: unknown }).liascapeDbg; } catch { /* noop */ } };
  }, [bridgeOn]);

  if (!overlayOn) return null;
  return (
    <div className="dbg-hud">
      <div><b className={m.fps < 50 ? "bad" : ""}>{m.fps}</b> fps · low <b>{m.low1}</b>/<b>{m.low01}</b> · {m.ms}ms</div>
      <div>vis {m.vis}/{m.cards} · anim {m.anim}</div>
      <div>heap {m.heap}MB · longs/s {m.longs}</div>
    </div>
  );
}
