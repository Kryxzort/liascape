// Renderer recovery probe — `scripts/test-ui-matrix.sh --probe probe-recover.js` (the matrix's hermetic stack). It runs the
// REAL shell (app/shell/main.js, a child Electron per cell) against the stack's backend in its dev-mode path
// (LIASCAPE_VITE = the stack's backend, which serves the built UI: the page loads with ?api=<port>&debug&token=…, the
// owner's dev setup) with LIASCAPE_DEBUG on a free CDP port, on the stack's Xvfb (WAYLAND_DISPLAY dropped: never a
// window on the session), and drives its page over CDP (app/shell/renderer-recovery.js).
//   recover:crash   CDP Page.crash: the shell logs the reason and exit code, and the page comes back by itself in a new
//                   renderer (a marker set before the crash is gone), mounted, still on ?api=<the backend's port>&debug,
//                   its API calls accepted (the token), liascapeDbg there, CDP still answering
//   recover:kill    SIGKILL on the renderer (the OOM killer's way, reason killed): the same comeback
//   recover:loop    three crashes in a row: the first two reload by themselves, the third shows the reload notice and
//                   nothing reloads after it; its Reload brings the app back, and the next crash reloads by itself again
//                   (the count starts over); screenshot <LIASCAPE_OUT>/recover-notice.png
//   recover:hang    an endless loop in the page + mouse input: the shell logs "unresponsive", ends the renderer when it
//                   stays so (HANG_KILL_MS) and the page comes back mounted
//   notice:look     the notice in the user's theme (a non-default one: its accent on the button, its text colour), the
//                   button's glow on, none under "Glow effects" off; motion on = a rise (transform + opacity), motion off =
//                   a short fade on opacity alone (motion-off.js judge, the appear replayed); screenshots
//                   <LIASCAPE_OUT>/recover-notice-<theme>.png, recover-notice-off.png
// LIASCAPE_RECOVER_MAIN=<another main.js> runs that shell instead (a copy of the pre-fix one shows the cells RED).
// Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app } = require("electron");
const cp = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const { SAMPLE, OPACITY_ONLY, judge, brief } = require("./motion-off");
const { HANG_KILL_MS } = require("./renderer-recovery");

const E = process.env;
const U = E.LIASCAPE_URL;
const OUT = E.LIASCAPE_OUT;
const ONLY = E.LIASCAPE_ONLY ? new RegExp(E.LIASCAPE_ONLY) : null;
const MAIN = E.LIASCAPE_RECOVER_MAIN || path.join(__dirname, "main.js");
const ELECTRON = E.ELECTRON || process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", path.join(OUT, "electron-user-data"));
// every child is gone however the probe ends; the run as a whole has a hard ceiling
const children = new Set();
process.on("exit", () => { for (const c of children) try { c.kill("SIGKILL"); } catch { /* gone */ } });
setTimeout(() => { console.log("FAIL  probe: no end in 15 min"); app.exit(1); }, 15 * 60_000).unref();

async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
async function setSettings(patch) { const s0 = (await http("GET", "/settings")).json; await http("POST", "/settings", { ...s0, ...patch }); }
async function waitFor(pred, ms, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await pred(); if (v) return v; } catch { /* retry */ } await sleep(step); }
  return null;
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

// ── the shell under test ────────────────────────────────────────────────────────────────────────
async function launch(tag) {
  const port = await freePort();
  const env = { ...E, LIASCAPE_VITE: U, LIASCAPE_DEBUG: "1", LIASCAPE_CDP_PORT: String(port), LIASCAPE_OZONE: "x11", LIASCAPE_SOFTGL: "1", LIASCAPE_MUTE: "1" };
  delete env.WAYLAND_DISPLAY; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_OZONE_PLATFORM_HINT; env.XDG_SESSION_TYPE = "x11";
  const file = path.join(OUT, `recover-${tag}.log`);
  // no core dumps: under a piped core_pattern (systemd-coredump) a crashed renderer stays alive until its core is written
  // — over a minute here — so the shell hears of the death that much later (and the store fills with probe cores)
  const child = cp.spawn("/bin/sh", ["-c", 'ulimit -c 0; exec "$0" "$@"', ELECTRON, "--ozone-platform=x11", MAIN], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let text = "";
  const add = (b) => { text += b; fs.appendFileSync(file, b); };
  child.stdout.on("data", add); child.stderr.on("data", add);
  const stop = async () => {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      if (!(await waitFor(() => child.exitCode != null || child.signalCode != null, 5000))) child.kill("SIGKILL");
    }
    children.delete(child);
  };
  return { port, pid: child.pid, log: () => text, lines: (re) => text.split("\n").filter((l) => re.test(l)), stop };
}

// ── CDP: one short session per call; the page target outlives its renderer, its socket doesn't ──────
async function target(port) {
  const l = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
  return l.find((t) => t.type === "page");
}
async function session(port) {
  const t = await target(port);
  if (!t) throw new Error("no page target");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", () => rej(new Error("ws error")), { once: true }); });
  let id = 0; const wait = new Map();
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); const w = wait.get(m.id); if (w) { wait.delete(m.id); w(m); } });
  return {
    call: (method, params = {}, ms = 8000) => new Promise((res, rej) => {
      const n = ++id; const to = setTimeout(() => { wait.delete(n); rej(new Error(`${method}: no answer in ${ms} ms`)); }, ms);
      wait.set(n, (m) => { clearTimeout(to); m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result); });
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
    send: (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params })), // no answer awaited
    close: () => { try { ws.close(); } catch { /* gone */ } },
  };
}
async function evalIn(port, expression, ms = 8000) {
  const s = await session(port);
  try {
    const r = await s.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  } finally { s.close(); }
}
async function shot(port, file) {
  const s = await session(port);
  try { fs.writeFileSync(path.join(OUT, file), Buffer.from((await s.call("Page.captureScreenshot", { format: "png" })).data, "base64")); } finally { s.close(); }
}

// the shell's renderer processes (its descendants with --type=renderer)
function rendererPids(root) {
  const procs = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map((d) => {
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8"); const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return { pid: Number(d), ppid, cmd: fs.readFileSync(`/proc/${d}/cmdline`, "utf8") };
    } catch { return null; }
  }).filter(Boolean);
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  const under = (pid) => { for (let p = pid, n = 0; p > 1 && n < 20; p = parent.get(p), n++) if (p === root) return true; return false; };
  return procs.filter((p) => p.cmd.includes("--type=renderer") && under(p.pid)).map((p) => p.pid);
}

// the app's page as it stands: mounted (the tabs), its address, its API reachable with its token, the debug bridge
const STATE = `(async () => {
  const q = new URLSearchParams(location.search);
  let api = 0;
  try { api = (await fetch("http://127.0.0.1:" + q.get("api") + "/settings", { headers: { "X-Liascape-Token": sessionStorage.getItem("liascape_token") || "" } })).status; } catch { /* down */ }
  return { tabs: document.querySelectorAll(".tab").length, api, apiParam: q.get("api"), debug: q.has("debug"), dbg: typeof window.liascapeDbg,
    mark: window.__recoverMark ?? null, notice: document.documentElement.dataset.rendererGone ?? null };
})()`;
const state = (c) => evalIn(c.port, STATE, 4000);
const mounted = (c) => waitFor(async () => { const s = await state(c); return s.tabs > 0 && s.api === 200 && s.mark == null && !s.notice ? s : null; }, 60_000, 400);
const mark = (c) => evalIn(c.port, "window.__recoverMark = 1");
const GONE = /^renderer: gone \(reason=(\S+) exitCode=(-?\d+)\)/;

// crash the page n times, each after it came back; the last one waits for nothing
// Page.crash, the session held until the shell logs the death: DevTools replays a command still unanswered to the next
// renderer of a session left open, so a page loaded at once (the notice) would crash too
async function crash(c) {
  const n = c.lines(/^renderer: /).length;
  const s = await session(c.port);
  try { s.send("Page.crash"); await waitFor(() => c.lines(/^renderer: /).length > n, 8000, 50); } finally { s.close(); }
}
async function crashes(c, n, v) {
  for (let i = 1; i <= n; i++) {
    await mark(c);
    await crash(c);
    if (!(await waitFor(() => c.lines(GONE).length >= i, 8000))) { v.push(`crash ${i}: no "renderer: gone (reason=… exitCode=…)" in the shell's log`); return false; }
    if (i < n && !(await mounted(c))) { v.push(`crash ${i}: the page never came back by itself`); return false; }
  }
  return true;
}
const noticeUp = (c) => waitFor(async () => (await state(c)).notice, 15_000);

const SERVE_PORT = new URL(U).port;
async function checkBack(c, v, what) {
  const s = await mounted(c);
  if (!s) { v.push(`${what}: the page never came back mounted (last: ${JSON.stringify(await state(c).catch((e) => e.message))})`); return false; }
  if (s.apiParam !== SERVE_PORT) v.push(`${what}: reloaded on ?api=${s.apiParam}, not the backend's ${SERVE_PORT}`);
  // the bridge comes with the debug HUD's effect, a moment after the tabs
  const dbg = s.debug && (await waitFor(async () => (await state(c)).dbg === "object", 10_000));
  if (!dbg) v.push(`${what}: reloaded without ?debug or its liascapeDbg bridge (?debug: ${s.debug})`);
  return true;
}

const hex = (h) => { const x = h.replace("#", ""); const n = x.length === 3 ? x.split("").map((d) => d + d).join("") : x.slice(0, 6); return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`; };
const LOOK = `(() => { const b = document.getElementById("reload"), g = document.querySelector(".gone"), cs = getComputedStyle(b);
  return { bg: cs.backgroundColor, fg: cs.color, shadow: cs.boxShadow, text: getComputedStyle(document.body).color, root: document.documentElement.className,
    anim: getComputedStyle(g).animationName, label: b.textContent.trim(), svg: !!b.querySelector("svg") }; })()`;

app.whenReady().then(async () => {
  const results = [];
  const run = async (name, fn) => {
    if (ONLY && !ONLY.test(name)) return;
    let v;
    try { v = await fn(); } catch (e) { v = [`ERROR ${e.message}`]; }
    results.push({ name, v });
    console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
    for (const x of v) console.log(`        - ${x}`);
  };
  const withShell = (tag, fn) => async () => {
    const c = await launch(tag);
    try {
      const v = [];
      if (!(await mounted(c))) return [`the shell's page never mounted (log tail: ${c.log().split("\n").slice(-4).join(" | ")})`];
      await fn(c, v);
      return v;
    } finally { await c.stop(); }
  };
  console.log(`== shell: ${MAIN}`);
  await setSettings({ morphs: true, glows: true, liveWallpaperBehindAllTabs: false });

  await run("recover:crash", withShell("crash", async (c, v) => {
    await mark(c);
    if ((await state(c)).mark !== 1) { v.push("the marker didn't stick — proved nothing"); return; }
    const t0 = Date.now();
    await crash(c);
    if (!(await waitFor(() => c.lines(GONE).length, 8000))) v.push(`no "renderer: gone (reason=… exitCode=…)" in the shell's log`);
    else console.log(`        log: ${c.lines(GONE)[0]}`);
    if (await checkBack(c, v, "after the crash")) console.log(`        back in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }));

  // the OOM killer's way: SIGKILL, no crash handler, no core
  await run("recover:kill", withShell("kill", async (c, v) => {
    await mark(c);
    const pids = rendererPids(c.pid);
    if (!pids.length) { v.push("no renderer process found under the shell — proved nothing"); return; }
    for (const p of pids) process.kill(p, "SIGKILL");
    if (!(await waitFor(() => c.lines(GONE).length, 8000))) v.push(`no "renderer: gone (reason=… exitCode=…)" in the shell's log`);
    else console.log(`        log: ${c.lines(GONE)[0]}`);
    await checkBack(c, v, "after SIGKILL");
  }));

  await run("recover:loop", withShell("loop", async (c, v) => {
    if (!(await crashes(c, 3, v))) return;
    if (!(await noticeUp(c))) { v.push(`three crashes in a row: no reload notice (state: ${JSON.stringify(await state(c).catch((e) => e.message))})`); return; }
    await sleep(8000);
    const s = await state(c);
    if (!s.notice || s.tabs) v.push("the notice was replaced by a reload after the loop guard tripped");
    const reloads = c.lines(/^renderer: gone .*reloading the page/).length;
    if (reloads !== 2) v.push(`${reloads} automatic reloads before the notice (want 2)`);
    if (!c.lines(/not reloading again, showing the reload notice/).length) v.push("the shell never logged that it stopped reloading");
    if (c.lines(/notice page is gone/).length) v.push("the notice page itself died");
    await shot(c.port, "recover-notice.png");
    await evalIn(c.port, `document.getElementById("reload").click()`);
    await checkBack(c, v, "after the notice's Reload");
    if (!c.lines(/Reload pressed on the notice/).length) v.push("the Reload press wasn't logged");
    // the user's Reload starts the count over: the next crash reloads by itself
    await mark(c);
    await crash(c);
    await checkBack(c, v, "a crash after the notice's Reload");
  }));

  await run("recover:hang", withShell("hang", async (c, v) => {
    await mark(c);
    const s = await session(c.port);
    try {
      s.send("Runtime.evaluate", { expression: "for (;;) {}" });
      await sleep(500);
      // the hang monitor starts on input the page doesn't acknowledge
      for (const type of ["mousePressed", "mouseReleased"]) s.send("Input.dispatchMouseEvent", { type, x: 700, y: 450, button: "left", clickCount: 1 });
      s.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" });
      // Chromium ignores a hung renderer while a DevTools client is attached to it (a breakpoint looks the same)
      await sleep(300); s.close();
      const t0 = Date.now();
      if (!(await waitFor(() => c.lines(/^renderer: unresponsive/).length, 40_000))) { v.push(`no "renderer: unresponsive" in ${(Date.now() - t0) / 1000} s of a frozen page`); return; }
      console.log(`        unresponsive after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (!(await waitFor(() => c.lines(/^renderer: still unresponsive .*ending it/).length, HANG_KILL_MS + 8000))) v.push("the frozen renderer was never ended");
      await checkBack(c, v, "after the hang");
      if (c.lines(/^renderer: responsive again/).length) v.push("the frozen page reported responsive — proved nothing");
    } finally { s.close(); }
  }));

  await run("notice:look", async () => {
    const v = [];
    const themes = (await http("GET", "/themes")).json;
    const t = themes.find((x) => x.name === "Dracula") ?? themes[1];
    await setSettings({ theme: t.name, glows: true, morphs: true });
    try {
      v.push(...await withShell("look", async (c, v2) => {
        if (!(await crashes(c, 3, v2)) || !(await noticeUp(c))) { v2.push("no notice to look at"); return; }
        await sleep(800);
        const on = await evalIn(c.port, LOOK);
        console.log(`        on: ${JSON.stringify(on)}`);
        if (on.bg !== hex(t.accent)) v2.push(`the button is ${on.bg}, not ${t.name}'s accent ${hex(t.accent)}`);
        if (on.fg !== hex(t.accentFg)) v2.push(`the button's label is ${on.fg}, not ${t.name}'s accentFg ${hex(t.accentFg)}`);
        if (on.text !== hex(t.textColor)) v2.push(`the text is ${on.text}, not ${t.name}'s text colour ${hex(t.textColor)}`);
        if (!on.shadow || on.shadow === "none") v2.push("the button has no glow with glows on");
        if (on.anim !== "rise") v2.push(`motion on: the appear is "${on.anim}", not the rise`);
        if (on.label !== "Reload" || !on.svg) v2.push(`the button reads "${on.label}" (icon: ${on.svg})`);
        await shot(c.port, `recover-notice-${t.name.toLowerCase().replace(/\W+/g, "-")}.png`);
        // glows and motion off: the next notice reads them (the Reload resets the count)
        await setSettings({ glows: false, morphs: false });
        await evalIn(c.port, `document.getElementById("reload").click()`);
        if (!(await mounted(c))) { v2.push("the notice's Reload never brought the app back"); return; }
        if (!(await crashes(c, 3, v2)) || !(await noticeUp(c))) { v2.push("no second notice"); return; }
        await sleep(800);
        const off = await evalIn(c.port, LOOK);
        console.log(`        off: ${JSON.stringify(off)}`);
        if (off.shadow !== "none") v2.push(`glows off: the button still glows (${off.shadow})`);
        if (!/\bno-glow\b/.test(off.root) || !/\bno-motion\b/.test(off.root)) v2.push(`the root's classes are "${off.root}" (want no-glow no-motion)`);
        // the appear replayed as the page runs it: a short fade, nothing moves
        const { fr, props, running } = await evalIn(c.port, `(() => { const g = document.querySelector(".gone"); g.style.animation = "none"; g.offsetWidth; g.style.animation = "";
          const props = (${OPACITY_ONLY})(document.body), running = document.body.getAnimations({ subtree: true }).length;
          return ${SAMPLE({ card: ".gone" }, 500)}.then((fr) => ({ fr, props, running })); })()`);
        console.log(`        motion off appear: ${brief(fr.card)} (${running} animation(s): ${props.join(", ") || "opacity only"})`);
        v2.push(...judge("notice card", fr.card, { appear: true }));
        if (!running) v2.push("motion off: no appear animation running after the replay — proved nothing");
        if (props.length) v2.push(`motion off: the appear animates ${props.join(", ")}`);
        await shot(c.port, "recover-notice-off.png");
      })());
    } finally { await setSettings({ theme: themes[0].name, glows: true, morphs: true }); }
    return v;
  });

  const fail = results.filter((r) => r.v.length).length;
  console.log(`RECOVER pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "recover.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
