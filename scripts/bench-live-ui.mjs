// Live UI benchmark — NOT hermetic: drives the RUNNING app's window through its debug port (start it with
// LIASCAPE_DEBUG=1, CDP on :9222) with synthetic input, while recording a Chromium trace + CPU profile.
// The repeatable half of the performance standard: the UI matrix gates refresh-independent COUNTS (layers, forced
// layouts, renders); this measures real TIME on real hardware, judged in frames of the display's measured refresh rate.
// Harmless input only: pointer moves, tab clicks, right-click (opens the item sidebar without applying) + Escape. Never a
// left-click on a card (applies it), Enter (plays) or any button. Restores the tab it started on.
// Usage: node scripts/bench-live-ui.mjs <idle|plhover|plhover-slow|tabs|sidebar> [out-label] [--profile high|typical]
//   prints one JSON line (hz, budgetMs, overBudget = main-thread tasks longer than one frame, over2Frames, main-thread ms by
//   phase, worst tasks, layouts) + the top JS self-time; writes <label>.trace.json + <label>.cpuprofile in the cwd.
// Compare runs only at the same refresh rate, build (Vite dev vs packaged) and tab. Rules: .claude/rules/testing.md.
import fs from "node:fs";
// --profile high (default): this machine's CPU, judged at the display's measured refresh rate.
// --profile typical: the CPU slowed 4× (Chromium's DevTools throttling) and judged at 60 Hz — most users' screens, on a
// weaker PC. A change must hold up under both.
const args = process.argv.slice(2), pi = args.indexOf("--profile");
const profile = pi >= 0 ? args.splice(pi, 2)[1] : "high";
if (!["high", "typical"].includes(profile)) { console.error("--profile high|typical"); process.exit(2); }
const scen = args[0], label = args[1] || `${scen}-${profile}`;
const list = await (await fetch("http://localhost:9222/json")).json();
const ws = new WebSocket(list.find((x) => x.type === "page").webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const events = []; let done;
const finished = new Promise((r) => (done = r));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Tracing.dataCollected") events.push(...m.params.value);
  if (m.method === "Tracing.tracingComplete") done();
  if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
await new Promise((r) => ws.addEventListener("open", r));
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const move = (x, y) => call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
const key = async (k, code, vk) => { await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk }); await call("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk }); };
const rightClick = async (x, y) => { await move(x, y); await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", clickCount: 1 }); await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", clickCount: 1 }); };
const leftClickTab = async (name) => {
  const r = await ev(`(() => { const t = [...document.querySelectorAll("button.tab")].find((b) => b.textContent.trim() === ${JSON.stringify(name)}); if (!t) return null; const b = t.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) throw new Error("no tab " + name);
  await move(r.x, r.y); await call("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
};
const curTab = await ev(`document.querySelector("button.tab.active")?.textContent.trim()`);
// the frame budget from the display's real refresh: sample rAF for half a second before the run (a 240 Hz monitor = 4.2 ms)
const hz = await ev(`new Promise((r) => { let n = 0; const t0 = performance.now(); const f = (t) => { n++; if (t - t0 < 500) requestAnimationFrame(f); else r(Math.round(n * 1000 / (t - t0))); }; requestAnimationFrame(f); })`);
const budgetHz = profile === "typical" ? 60 : hz;
const budget = 1000 / budgetHz;
if (profile === "typical") await call("Emulation.setCPUThrottlingRate", { rate: 4 });

async function run() {
  if (scen === "idle") { await sleep(4000); return; }
  if (scen.startsWith("plhover")) {
    const items = await ev(`[...document.querySelectorAll(".pl-item")].map((e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }).filter((p) => p.x > 0 && p.x < innerWidth)`);
    if (!items?.length) throw new Error("no playlist items on screen");
    const y = items[0].y, x0 = Math.max(2, items[0].x - 40), x1 = Math.min(items.at(-1).x + 40, (await ev("innerWidth")) - 2);
    const ms = scen === "plhover-slow" ? 3000 : 900; // a fast flick vs a slow read along the row
    for (let pass = 0; pass < 2; pass++) for (let t = 0; t <= ms; t += 7) { const k = t / ms, x = pass ? x1 - (x1 - x0) * k : x0 + (x1 - x0) * k; await move(Math.round(x), Math.round(y)); await sleep(7); }
    await move(2, 2); await sleep(600);
    return;
  }
  if (scen === "tabs") { for (const t of ["Browse", "Settings", "Library", "Browse", "Library"]) { await leftClickTab(t); await sleep(900); } return; }
  if (scen === "sidebar") {
    if (curTab !== "Library") { await leftClickTab("Library"); await sleep(900); }
    const cards = await ev(`[...document.querySelectorAll(".lib-scroll .thumb-wrap")].map((e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }).filter((p) => p.y > 80 && p.y < innerHeight - 160).slice(0, 3)`);
    if (!cards?.length) throw new Error("no library cards");
    for (const c of cards) { await rightClick(Math.round(c.x), Math.round(c.y)); await sleep(900); }   // open, then switch twice
    await key("Escape", "Escape", 27); await sleep(900);                                               // close
    return;
  }
  throw new Error("unknown scenario " + scen);
}

await call("Profiler.enable"); await call("Profiler.setSamplingInterval", { interval: 200 });
await call("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,cc,benchmark", transferMode: "ReportEvents" });
await call("Profiler.start"); await sleep(200);
const t0 = Date.now(); let err = null;
try { await run(); } catch (e) { err = e.message; }
const wall = (Date.now() - t0) / 1000;
const prof = (await call("Profiler.stop")).result.profile;
if (profile === "typical") await call("Emulation.setCPUThrottlingRate", { rate: 1 }); // never leave the owner's window slowed
await call("Tracing.end"); await finished;
if (curTab && scen !== "idle") { const now = await ev(`document.querySelector("button.tab.active")?.textContent.trim()`); if (now !== curTab) await leftClickTab(curTab); }
fs.writeFileSync(`${label}.trace.json`, JSON.stringify({ traceEvents: events })); fs.writeFileSync(`${label}.cpuprofile`, JSON.stringify(prof));

const pr = events.filter((e) => e.name === "PipelineReporter" && e.ph === "b" && e.args?.chrome_frame_reporter);
const states = {}; for (const e of pr) { const s = (e.args.chrome_frame_reporter.state || "?").replace("STATE_", ""); states[s] = (states[s] || 0) + 1; }
const byTid = new Map(); for (const e of events) if (e.name === "UpdateLayoutTree" || e.name === "FunctionCall") byTid.set(`${e.pid}:${e.tid}`, (byTid.get(`${e.pid}:${e.tid}`) || 0) + 1);
const main = [...byTid.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
const mainEv = events.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === "X" && e.dur);
const cat = { script: ["FunctionCall", "EvaluateScript", "TimerFire", "FireAnimationFrame", "EventDispatch", "RunMicrotasks"], style: ["UpdateLayoutTree"],
  layout: ["Layout"], prepaint: ["PrePaint"], paint: ["Paint"], commit: ["Commit", "Layerize"], intersect: ["IntersectionObserverController::computeIntersections"], gc: ["MinorGC", "MajorGC"] };
const ms = {}; for (const [k, n] of Object.entries(cat)) ms[k] = Math.round(mainEv.filter((e) => n.includes(e.name)).reduce((a, e) => a + e.dur, 0) / 1000);
const tasks = mainEv.filter((e) => e.name === "RunTask").map((e) => e.dur / 1000).sort((a, b) => b - a);
const lay = mainEv.filter((e) => e.name === "Layout");
const self = new Map(); const dts = prof.timeDeltas || []; const byNode = new Map(prof.nodes.map((n) => [n.id, n])); const cnt = new Map();
(prof.samples || []).forEach((s, i) => cnt.set(s, (cnt.get(s) || 0) + (dts[i] || 0)));
for (const [nid, us] of cnt) { const f = byNode.get(nid).callFrame; if (["(idle)", "(program)", "(root)", "(garbage collector)"].includes(f.functionName)) continue;
  const k = `${f.functionName || "(anon)"} ${(f.url || "").split("/").slice(-2).join("/").split("?")[0]}:${f.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + us / 1000); }
console.log(JSON.stringify({ scen, err, wallS: +wall.toFixed(1), frames: states, mainThreadMs: ms, tasks: tasks.length, profile, displayHz: hz, budgetHz, budgetMs: +budget.toFixed(2), overBudget: tasks.filter((d) => d > budget).length, over2Frames: tasks.filter((d) => d > 2 * budget).length, over16ms: tasks.filter((d) => d > 16).length,
  over50ms: tasks.filter((d) => d > 50).length, worstMs: tasks.slice(0, 5).map((d) => +d.toFixed(1)), layouts: lay.length,
  layoutAvgMs: lay.length ? +(lay.reduce((a, e) => a + e.dur, 0) / lay.length / 1000).toFixed(2) : 0 }));
console.log("JS self (ms):"); for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${v.toFixed(1).padStart(7)}  ${k}`);
process.exit(0);
