import { API, authHeaders } from "../api/client";

// DIAGNOSTIC: catch the recurring main-thread wedge. Every ~2s (and on any long task >200ms) we POST a
// compact snapshot to the backend, which appends it to ~/.cache/liascape/freeze.log. When the main
// thread wedges, these stop firing — the GAP in the log timestamps the freeze, and the last line before
// it captures the trigger context (tab, scrolling, gif/anim count, JS heap, DOM size, worst stall).
// Cheap + always-on so a freeze during normal use is diagnosable after the fact (no live attach needed).
export function startFreezeLog() {
  if (typeof window === "undefined") return;

  // No frame counter here: a requestAnimationFrame loop makes Chromium render every refresh (144 fps of style, layout and
  // IntersectionObserver work on an idle page — a third of a core), and a wedged page renders nothing anyway, so the
  // heartbeat gap below already timestamps a freeze. Live fps: `liascapeDbg.metrics()` (samples on demand).

  // worst main-thread stall since last post (longtask = task that blocked the main thread >50ms)
  let maxLongTask = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration > maxLongTask) maxLongTask = Math.round(e.duration);
        if (e.duration > 200) post({ ev: "longtask", ms: Math.round(e.duration) }); // flush notable stalls immediately
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch { /* longtask unsupported → heartbeat-only */ }

  // transient "is the user scrolling" flag (capture-phase, passive → ~free)
  let scrollingUntil = 0;
  addEventListener("scroll", () => { scrollingUntil = performance.now() + 250; }, { capture: true, passive: true });

  const snap = () => {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    return {
      tab: document.querySelector("button.tab.active")?.textContent ?? "?",
      scrolling: performance.now() < scrollingUntil,
      focus: document.hasFocus(),
      vis: document.visibilityState === "visible",
      animImg: document.querySelectorAll("img.thumb.anim").length,
      animVid: document.querySelectorAll("video.thumb.anim, video.settings-bg").length,
      cards: document.querySelectorAll(".card.lib, .lib-card").length,
      dom: document.getElementsByTagName("*").length,
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
      stallMs: maxLongTask,
    };
  };

  function post(extra?: Record<string, unknown>) {
    try {
      const body = JSON.stringify(extra ? { ...snap(), ...extra } : snap());
      // keepalive → non-blocking, fire-and-forget (survives unload); failures ignored
      fetch(`${API}/debug/log`, { method: "POST", body, keepalive: true, headers: authHeaders({ "Content-Type": "application/json" }) }).catch(() => {});
    } catch { /* ignore */ }
    maxLongTask = 0; // reset the window each post
  }

  post({ ev: "start", ua: navigator.userAgent.slice(0, 40) });
  setInterval(() => post(), 2000);
}
