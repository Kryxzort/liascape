// The window shows the app's own UI and nothing else (.claude/rules/ui/shell-and-probes.md § Shell): a link, a
// window.open or a page trying to navigate elsewhere goes to the user's browser (http(s) only) and never opens inside the
// app, where it would get the preload's bridge and the app's session. Its own module so a probe can run these exact rules
// with a stubbed `openExternal` (probe-sidebar.js preview:ytLink).
//   guardWebContents(wc, { isAppUrl, openExternal }) — on every webContents (main.js: app "web-contents-created")
function openOutsideWith(openExternal) {
  return (u) => {
    let x;
    try { x = new URL(u); } catch { return; } // not a URL
    if (x.protocol !== "http:" && x.protocol !== "https:") return;
    // a browser that never opens is otherwise silent: say so where the shell logs
    Promise.resolve().then(() => openExternal(x.toString()))
      .catch((e) => console.error(`[shell] couldn't open ${x.origin} in the browser: ${e?.message ?? e}`));
  };
}

function guardWebContents(wc, { isAppUrl, openExternal }) {
  const openOutside = openOutsideWith(openExternal);
  wc.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: "deny" }; });
  wc.on("will-navigate", (e, url) => { if (!isAppUrl(url)) { e.preventDefault(); openOutside(url); } });
  wc.on("will-attach-webview", (e) => e.preventDefault());
  // A frame the page embeds (the YouTube trailer) that navigates ITSELF is following one of its own links: YouTube's
  // title link has no target, so it loads youtube.com/watch inside the trailer's frame, which YouTube refuses to be
  // framed in (a broken frame, no browser). That page goes to the browser and the frame stays on its embed. The frame's
  // own loads (the page setting its src) are the page's, so they go ahead. Guard: probe-sidebar.js preview:ytLink
  wc.on("will-frame-navigate", (e) => {
    const f = e.frame, by = e.initiator;
    if (e.isMainFrame || e.isSameDocument || !f || !by || !isAppUrl(wc.mainFrame.url)) return;
    if (f.parent?.frameTreeNodeId !== wc.mainFrame.frameTreeNodeId) return; // a frame inside the embed: the embed's own business
    if (by.frameTreeNodeId === wc.mainFrame.frameTreeNodeId) return;
    e.preventDefault();
    openOutside(e.url);
  });
}

module.exports = { guardWebContents };
