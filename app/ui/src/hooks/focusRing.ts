// Focus rings only while navigating with Tab (owner 2026-11-11: "the buttons get the yellow focus outline when you click a
// letter after clicking them … we never want those pesky yellow outlines anywhere"). Chromium's own ring (the system
// colour — yellow here) shows on `:focus-visible`, and a click followed by ANY key flips the clicked button into
// `:focus-visible`. index.css hides every focus ring unless `:root.kbd-nav`, which only Tab / Shift+Tab sets and any
// pointer press clears — and then it's the app's accent ring, never the system one. The grid's arrow keys don't count:
// cards show their own `.focused` highlight (web-ui.md).
export function installFocusRingGuard() {
  const root = document.documentElement;
  window.addEventListener("keydown", (e) => { if (e.key === "Tab") root.classList.add("kbd-nav"); }, true);
  window.addEventListener("pointerdown", () => root.classList.remove("kbd-nav"), true);
}
