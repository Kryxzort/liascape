// UI × player-state matrix driver (run by scripts/test-ui-matrix.sh, which builds the hermetic stack:
// a private backend + headless liascape-player + the UI bundle served by that backend). For every cell
// (state × control): reset everything to a baseline, reload the UI, bring the player into the state
// through the backend, operate the control through the real DOM (or a `--action=` keybind), then check
// with the ORACLE what every live source of the player runs:
//   gain.user / speed   = the source's OWN item's override ?? the global setting (whatever else is live)
//   no_audio, hwdec, fps_cap, cache, demuxer_* = the globals; gain.mute = the user mute (or an auto-mute)
//   af = none with normalization off; on (audio on) = the source's OWN item's loudnorm at the target once measured
//   every main layer's fit = VideoScale; player.paused = what the cell expects
//   the backend's /current, the screen (cur:*) and the UI's "playing" marker agree (when settled)
//   no transition.failed / source.error / source.rejected; no unexpected cancel; no HTTP error
// plus each control's own expectation. Output: <LIASCAPE_OUT>/cells.jsonl + a summary; exit 1 on any FAIL.
const { app, BrowserWindow, session } = require("electron");
const net = require("net");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const E = process.env;
const U = E.LIASCAPE_URL;
const K = JSON.parse(E.LIASCAPE_CLIPS); // library videoPaths of k1..k4 (k4 is the short one)
const OUT = E.LIASCAPE_OUT;
const ONLY = E.LIASCAPE_ONLY ? new RegExp(E.LIASCAPE_ONLY) : null;
// `i/N` (test-ui-matrix.sh --jobs N runs N hermetic stacks in parallel): this instance runs the cells whose
// index in the (--only filtered) cell list is ≡ i mod N — state-major order, so every shard gets a slice of
// every state
const SHARD = E.LIASCAPE_SHARD ? E.LIASCAPE_SHARD.split("/").map(Number) : null;
// synthetic WE scene items (test-ui-matrix.sh seeds them, titled s1..s3): s1 red + 440 Hz, s2 blue + 660 Hz, s3 crashes
const SC = JSON.parse(E.LIASCAPE_SCENES || "[]");
const TITLE = (p) => (K.indexOf(p) >= 0 ? `k${K.indexOf(p) + 1}` : SC.indexOf(p) >= 0 ? `s${SC.indexOf(p) + 1}` : String(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// (test-ui-matrix.sh runs it on a private Xvfb: --ozone-platform=x11 --disable-gpu)
app.setPath("userData", path.join(OUT, "electron-user-data"));

// ---------------------------------------------------------------- player socket (requests + events)
function ctlClient() {
  let sock = null, buf = "", id = 0;
  const pend = new Map();
  const connect = () => new Promise((res, rej) => {
    const s = net.createConnection(E.LIASCAPE_PLAYER_SOCKET, () => { sock = s; res(); });
    s.setEncoding("utf8");
    s.on("error", (e) => { if (!sock) rej(e); });
    s.on("close", () => { if (sock === s) sock = null; for (const p of pend.values()) p.rej(new Error("ctl closed")); pend.clear(); });
    s.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        const p = m.id != null && pend.get(m.id);
        if (p) { pend.delete(m.id); m.ok ? p.res(m.result) : p.rej(Object.assign(new Error(m.error?.message), m.error)); }
      }
    });
  });
  const call = async (cmd, args = {}, timeout = 4000) => {
    if (!sock) await connect();
    return new Promise((res, rej) => {
      const i = ++id;
      const t = setTimeout(() => { pend.delete(i); rej(new Error(`ctl ${cmd} timed out`)); }, timeout);
      pend.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      sock.write(JSON.stringify({ id: i, cmd, args }) + "\n");
    });
  };
  return { call };
}
const ctl = ctlClient();
const events = [];
function subscribe() {
  const s = net.createConnection(E.LIASCAPE_PLAYER_SOCKET);
  s.setEncoding("utf8"); let buf = "";
  s.on("connect", () => s.write(JSON.stringify({ id: 1, cmd: "subscribe", args: { topics: [
    "transition.", "source.error", "source.rejected", "anim.dropped", "output.", "supervisor.", "player.", "snapshot.invalid"] } }) + "\n"));
  s.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (m.event) { m._t = Date.now(); events.push(m); } } catch { /* partial */ }
    }
  });
  s.on("close", () => setTimeout(subscribe, 300));
}

// ---------------------------------------------------------------- backend HTTP (never printed: /settings holds tokens)
async function http(method, p, body) {
  const r = await fetch(U + p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}
const post = (p, b = {}) => http("POST", p, b);
const getSettings = async () => (await http("GET", "/settings")).json;
function cli(action) {
  const t0 = Date.now();
  return new Promise((res) => cp.execFile(E.LIASCAPE_DOTNET, [E.LIASCAPE_DLL, `--action=${action}`], { timeout: 40000 }, (err, out, errOut) =>
    res({ code: err ? err.code ?? (err.killed ? `killed (${err.signal}) after ${Date.now() - t0} ms` : 1) : 0, out: String(out) + String(errOut), ms: Date.now() - t0 })));
}

// ---------------------------------------------------------------- loudness: what the backend measured (the library's own index)
// k1..k4 are imported items: <library>/imported/<key>/<key>.mp4, one index.json for the source
const INDEX = path.join(path.dirname(path.dirname(K[0])), "index.json");
function readIndex() { try { return JSON.parse(fs.readFileSync(INDEX, "utf8")); } catch { return {}; } }
const keyOf = (p) => path.basename(path.dirname(p));
const LOUD = ["loudnessI", "loudnessTP", "loudnessLRA", "loudnessThresh"];
const measured = (idx, p) => { const m = p && idx[keyOf(p)]; return m && LOUD.every((k) => typeof m[k] === "number") ? m : null; };
// LibraryService.LoudnormAf: C#'s invariant double formatting is the shortest round-trip, like JS's
const loudnormAf = (m, target) => `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${m.loudnessI}:measured_TP=${m.loudnessTP}:measured_LRA=${m.loudnessLRA}:measured_thresh=${m.loudnessThresh}:linear=true`;
// measure every clip once (the backend's own backfill: normalization on for a moment, nothing playing)
async function measureAll(ms = 30000) {
  if (K.every((p) => measured(readIndex(), p))) return true;
  const s = await getSettings(); const was = !!s.normalizeAudio;
  if (!was) await post("/settings", { ...s, normalizeAudio: true });
  const ok = await waitFor(async () => K.every((p) => measured(readIndex(), p)), ms, 200);
  if (!was) { const s2 = await getSettings(); s2.normalizeAudio = false; await post("/settings", s2); }
  return ok;
}
// forget every clip's measurement (written like the backend would read it: whole file, renamed over)
function unmeasureAll() {
  const idx = readIndex();
  for (const p of K) { const m = idx[keyOf(p)]; if (m) for (const k of [...LOUD, "loudnessSkip"]) delete m[k]; }
  fs.writeFileSync(INDEX + ".mx", JSON.stringify(idx, null, 2)); fs.renameSync(INDEX + ".mx", INDEX);
}

// ---------------------------------------------------------------- oracle
const VolumeDb = (p) => (p <= 0 ? -96 : Math.min(12, Math.max(-96, 60 * Math.log10(p / 100))));
const near = (a, b, eps = 0.02) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= eps;
async function snapshot() {
  const [st, s, lib, cur, ps] = [await ctl.call("state"), await getSettings(), (await http("GET", "/library")).json,
    (await http("GET", "/current")).json, (await http("GET", "/playlist/state")).json];
  return { st, s, lib, cur, ps, muted: fs.existsSync(E.LIASCAPE_USER_MUTE), idx: readIndex() };
}
const sourcesOf = (st) => Object.entries(st.graph).filter(([, n]) => n && n.gain_effective_db !== undefined && n.kind !== "snapshot" && n.kind !== "color");
// What's on screen per output: the main layer's content, through an effect to its `to`.
function screen(st) {
  const out = {};
  for (const [id, n] of Object.entries(st.graph)) {
    if (!id.startsWith("lay:") || !id.endsWith(":main")) continue;
    let c = n.content; const fx = c && st.graph[c];
    if (fx && fx.effect_id !== undefined) c = fx.to;
    out[id] = c && st.graph[c] ? st.graph[c].path : null;
  }
  return out;
}
function oracle(snap, exp) {
  const v = [];
  const { st, s, lib } = snap;
  const by = Object.fromEntries((lib || []).map((i) => [i.videoPath, i]));
  for (const [id, n] of sourcesOf(st)) {
    const it = by[n.path];
    const who = `${id}(${TITLE(n.path)})`;
    const gu = n.gain?.user ?? 0, gm = n.gain?.mute ?? 0;
    const wantG = VolumeDb(it?.volumeOverride ?? s.volume);
    const wantS = Math.min(4, Math.max(0.1, it?.speedOverride ?? s.speed));
    if (!near(gu, wantG)) v.push(`${who} gain.user ${gu.toFixed(2)} ≠ ${wantG.toFixed(2)} (override ${it?.volumeOverride ?? "–"} ?? global ${s.volume})`);
    if (!near(n.speed, wantS, 0.001)) v.push(`${who} speed ${n.speed} ≠ ${wantS} (override ${it?.speedOverride ?? "–"} ?? global ${s.speed})`);
    if (n.no_audio !== !!s.noAudio) v.push(`${who} no_audio ${n.no_audio} ≠ NoAudio ${s.noAudio}`);
    const hw = (s.hwDec ?? "").trim() || "no";
    if (n.hwdec !== hw) v.push(`${who} hwdec ${n.hwdec} ≠ ${hw}`);
    if (!near(n.fps_cap, Math.max(0, s.videoFps ?? 0), 0.001)) v.push(`${who} fps_cap ${n.fps_cap} ≠ ${s.videoFps}`);
    if (n.cache !== !s.disableCache) v.push(`${who} cache ${n.cache} ≠ !DisableCache(${s.disableCache})`);
    if (!near(n.demuxer_max_mib, Math.max(0, s.demuxerMaxBytes ?? 0), 0.001)) v.push(`${who} demuxer_max_mib ${n.demuxer_max_mib} ≠ ${s.demuxerMaxBytes}`);
    if (!near(n.demuxer_back_mib, Math.max(0, s.demuxerMaxBackBytes ?? 0), 0.001)) v.push(`${who} demuxer_back_mib ${n.demuxer_back_mib} ≠ ${s.demuxerMaxBackBytes}`);
    if (!s.normalizeAudio && (n.af ?? "") !== "") v.push(`${who} af "${n.af}" with normalization off`);
    // normalization on (audio on): a measured item's every source runs ITS OWN loudnorm at the target
    // (unmeasured: nothing to check — the backend measures it in the background)
    const lm = s.normalizeAudio && !s.noAudio && measured(snap.idx || {}, n.path);
    if (lm && (n.af ?? "") !== loudnormAf(lm, s.normalizeTargetLufs))
      v.push(`${who} af "${String(n.af ?? "").slice(0, 60)}" ≠ its own loudnorm at ${s.normalizeTargetLufs} LUFS (normalization on, measured I=${lm.loudnessI})`);
    const wantMute = snap.muted || exp.autoMuted;
    if (!near(gm, wantMute ? -96 : 0, 0.5)) v.push(`${who} gain.mute ${gm} but user mute is ${snap.muted ? "on" : "off"}${exp.autoMuted ? " (auto-muted)" : ""}`);
  }
  const fit = s.videoScale === "fit" ? "fit" : "fill";
  for (const [id, n] of Object.entries(st.graph)) if (id.startsWith("lay:") && id.endsWith(":main") && n.fit !== fit) v.push(`${id} fit ${n.fit} ≠ VideoScale ${s.videoScale}`);
  if (exp.paused !== undefined && !!st.graph.player?.paused !== exp.paused) v.push(`player.paused ${!!st.graph.player?.paused}, expected ${exp.paused}`);
  if (exp.muted !== undefined && snap.muted !== exp.muted) v.push(`user mute ${snap.muted}, expected ${exp.muted}`);
  // agreement: backend /current vs the screen (only when nothing is mid-switch and outputs exist)
  const scr = Object.values(screen(st));
  if (exp.settled && scr.length && !(st.transitions || []).some((t) => t.phase === "running" || t.phase === "handoff")) {
    const shown = [...new Set(scr)];
    const cur = snap.cur?.path ?? null;
    if (shown.length !== 1 || shown[0] !== cur) v.push(`screen shows ${shown.map(TITLE)} but /current says ${TITLE(cur)}`);
  }
  return v;
}

// ---------------------------------------------------------------- the page
let win;
const httpLog = [];
const js = (code) => win.webContents.executeJavaScript(code);
const PAGE = `window.__mx = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text); },
  click(el, what) { if (!el) throw new Error("not found: " + what); el.click(); },
  tab(name) { this.click(this.byText(".tab", name), "tab " + name); },
  card(t) { return [...document.querySelectorAll(".card.lib")].find((c) => c.querySelector(".lib-title")?.title === t); },
  strip(t) { return [...document.querySelectorAll(".pl-item")].find((e) => e.title === t); },
  ctx(el, what) { if (!el) throw new Error("not found: " + what); const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 })); },
  async cardMenu(t, label) { this.ctx(this.card(t)?.querySelector(".thumb-wrap"), "card " + t); await this.sleep(250); this.click(this.byText(".lib-ctx button", label), label); },
  async stripMenu(t, label) { this.ctx(this.strip(t), "strip " + t); await this.sleep(250); this.click(this.byText(".pl-ctx button", label), label); },
  // a real drag: many input events over time (the throttled preview + debounced persist interleave)
  async drag(el, from, to, steps, ms, what) { for (let i = 1; i <= steps; i++) { this.setValue(el, +(from + (to - from) * i / steps).toFixed(2), what); await this.sleep(ms); } },
  setValue(el, v, what) { if (!el) throw new Error("not found: " + what); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true })); },
  setCheck(el, b, what) { if (!el) throw new Error("not found: " + what); if (el.checked !== b) el.click(); },
  row(label) { return [...document.querySelectorAll(".settings .srow")].find((r) => r.querySelector(".slabel-row")?.firstChild?.textContent?.trim() === label); },
  input(label, sel = "input") { return this.row(label)?.querySelector(sel); },
  async select(label, opt) { this.click(this.row(label)?.querySelector(".sel"), "select " + label); await this.sleep(200); this.click(this.byText(".sel-pop .sel-opt", opt), opt); },
  modalRange(i) { return document.querySelectorAll(".lib-settings input[type=range]")[i]; },
  modalReset(i) { return [...document.querySelectorAll(".lib-settings .srow")].filter((r) => r.querySelector("input[type=range]"))[i]?.querySelector("button"); },
  closeModal() { const b = [...document.querySelectorAll(".modal-backdrop")].pop(); this.click(b, "modal backdrop"); },
  plCheck(text) { return [...document.querySelectorAll(".pl-modal label.ck")].find((l) => l.textContent.trim().startsWith(text))?.querySelector("input"); },
  playing() { return { strip: [...document.querySelectorAll(".pl-item.playing")].map((e) => e.title), cards: [...document.querySelectorAll(".card.lib.playing")].map((c) => c.querySelector(".lib-title")?.title) }; },
}; true`;
async function loadUi() {
  await win.loadURL(U + "/");
  // record what the page POSTs to /preview (its bodies — the backend only sees what arrives), and count its requests
  // in flight (a fuzz step waits for them: under load a persist was still on its way when the step looked)
  await js(`(() => { window.__mxReq = []; window.__mxInflight = 0; const f = window.fetch; window.fetch = (u, o) => { if (String(u).includes("/preview")) window.__mxReq.push(o?.body ?? null);
    window.__mxInflight++; return f(u, o).finally(() => { window.__mxInflight--; }); }; })(); true`);
  for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.card.lib').length`) >= 4) break; await sleep(100); }
  await js(PAGE);
  await sleep(300);
}
const ui = (code) => js(`(async () => { const m = window.__mx; ${code} })()`);

// per-cell log excerpts (backend + adapter + the backend's transition/rotation log), attached to a FAIL
const LOGS = [E.LIASCAPE_BACKEND_LOG, E.LIASCAPE_ADAPTER_LOG, E.LIASCAPE_ADAPTER_LOG && path.join(path.dirname(E.LIASCAPE_ADAPTER_LOG), "liascape-transition.log")].filter(Boolean);
const logSizes = () => LOGS.map((f) => { try { return fs.statSync(f).size; } catch { return 0; } });
function logsSince(at) {
  return LOGS.map((f, i) => { try { const b = fs.readFileSync(f); return b.subarray(at[i]).toString().split("\n").filter((l) => l.trim() && !/SteamRefreshToken/.test(l)).slice(-25); } catch { return []; } }).flat();
}

// ---------------------------------------------------------------- waits
async function waitFor(pred, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await pred()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const live = async () => (await ctl.call("state")).transitions || [];
// settled = no switch requested/starting/running (an aligned one armed for A's end is fine) — twice, 150 ms
// apart (a request still in the backend's queue shows up in between) — and, with `want`, /current says it.
// ("scheduled" used to count as settled: /apply returns before its switch runs, so "single" cells ran
// mid-fade-in and "effect" was a fade from NOTHING.)
async function waitSettled(ms = 12000, want) {
  const quiet = async () => (await live()).every((t) => t.phase === "waiting_start" || t.phase === "done")
    && (want === undefined || (await http("GET", "/current")).json?.path === want);
  return waitFor(async () => (await quiet()) && (await sleep(150), await quiet()), ms, 100);
}
const waitPhase = (phase, ms = 8000) => waitFor(async () => (await live()).some((t) => t.phase === phase), ms, 50);

// ---------------------------------------------------------------- baseline + states
let BASE_SETTINGS;
// Fades: 1200 ms (global too — test-ui-matrix.sh's settings); the mid-effect states' playlist keeps EFFECT_MS so a
// control still lands inside the running effect. Was 2500 everywhere: every switch a cell made waited it out.
const EFFECT_MS = 2500;
// the rotation (player-adapter.md § Rotation): advance-on-end off → intervalSeconds is the timer; on → it is the minimum
// play time and maxPlaySeconds the maximum (0 = off)
const PS = (o = {}) => ({ order: 0, overrideGlobalSettings: true, intervalSeconds: 600, advanceOnVideoEnd: false, maxPlaySeconds: 0,
  transitionEnabled: true, transitionEffectIds: ["fade"], transitionDurationMs: 1200, transitionDurationMaxMs: 0, transitionShuffle: false, ...o });
// Getting INTO a state isn't what a cell tests: its entry switches run as ENTRY_MS fades BEFORE the UI loads (the
// app opened onto a playing wallpaper, as in real use), then the configured durations go back — so the UI reads
// those. The fade-in from nothing at 2500 ms was ~40 % of a run (phases: enter 2.76 s/cell).
const ENTRY_MS = 250;
async function withGlobalMs(ms, fn) {
  const s = await getSettings(), was = s.globalTransitionDurationMs; // full bodies: an older backend (LIASCAPE_MATRIX_DLL) replaced the whole settings
  await post("/settings", { ...s, globalTransitionDurationMs: ms });
  try { return await fn(); } finally { await post("/settings", { ...(await getSettings()), globalTransitionDurationMs: was }); }
}
async function playFast(c, paths, settings) {
  await post("/playlist/play", { paths, settings: { ...settings, transitionDurationMs: ENTRY_MS } });
  c.ok = await waitSettled(12000, paths[0]);
  await post("/playlist/state", { videoPaths: paths, settings, name: null }); // the real durations, live (a 600 s timer: no switch)
}
async function reset(pl) {
  const st = await ctl.call("state");
  for (const [name, w, h] of [["VIRTUAL-1", 640, 360], ["VIRTUAL-2", 320, 180]])
    if (!st.outputs.some((o) => o.name === name)) await ctl.call("headless.add_output", { name, width: w, height: h, hz: 60 }).catch(() => {});
  await stopTones();
  await post("/stop"); // gone when nothing is hosted or switching any more (was a fixed 300 ms)
  await waitFor(async () => { const t = await ctl.call("state"); return !(t.transitions || []).length && !sourcesOf(t).length; }, 1500, 25);
  await post("/mute", { user: true, value: false });
  while (((await http("GET", "/library/undo-depth")).json?.depth ?? 0) > 0) await post("/library/undo");
  await post("/settings", BASE_SETTINGS);
  resetScenes();
  for (const p of K) { await post("/library/volume", { path: p, intValue: null }); await post("/library/speed", { path: p, doubleValue: null }); }
  await post("/playlist/state", { videoPaths: pl?.paths ?? [K[0], K[1], K[2]], settings: pl?.settings ?? PS(), name: null });
  await waitSettled(4000);
}
// ---------------------------------------------------------------- scenes (Phase 2 Task 12)
// The scene items live in the library's `workshop` source (index.json there: their titles). Scene support is OFF in the
// baseline settings (library stepping / random would otherwise land on them — s3 crashes); every scene state and
// scene control turns it on before the UI loads. Each cell starts with the items as seeded: no crash mark, no
// whitelist, no overrides, and a healthy fake VRAM sample (test-ui-matrix.sh: LIASCAPE_PLAYER_VRAM_PROBE=fake:<file>).
const SC_INDEX = SC.length ? path.join(path.dirname(SC[0]), "index.json") : null;
const SC_KEY = (p) => path.basename(p);
function vramFake(procs = {}) {
  if (!E.LIASCAPE_VRAM_FAKE) return;
  fs.writeFileSync(E.LIASCAPE_VRAM_FAKE + ".mx", JSON.stringify({ total_mib: 8192, free_mib: 6000, procs }));
  fs.renameSync(E.LIASCAPE_VRAM_FAKE + ".mx", E.LIASCAPE_VRAM_FAKE);
}
function resetScenes() {
  vramFake();
  if (!SC_INDEX) return;
  const idx = Object.fromEntries(SC.map((p, i) => [SC_KEY(p), { title: `s${i + 1}`, isScene: true, workshopId: SC_KEY(p) }]));
  fs.writeFileSync(SC_INDEX + ".mx", JSON.stringify(idx, null, 2)); fs.renameSync(SC_INDEX + ".mx", SC_INDEX);
}
const readScIndex = () => { try { return JSON.parse(fs.readFileSync(SC_INDEX, "utf8")); } catch { return {}; } };
async function scenesOn(extra = {}) { const s = await getSettings(); await post("/settings", { ...s, allowScenes: true, ...extra }); }
const rot = (a, i) => [...a.slice(i), ...a.slice(0, i)];
// the scene playlist [k1, s1, s2, k2], entered at index i (the strip in play order: next = the item after)
const SC_PL = () => [K[0], SC[0], SC[1], K[1]];
// the live source(s) / scene worker of a path, from a `state`
const srcIdsOf = (st, p) => sourcesOf(st).filter(([, n]) => n.path === p).map(([id]) => id);
const workerOf = (st, p) => (st.workers || []).find((w) => w.path === p || srcIdsOf(st, p).includes(w.id));
const workersProbe = async () => (await ctl.call("probe", { name: "workers" }).catch(() => ({ workers: [] }))).workers || [];
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pget = async (p) => (await ctl.call("get", { path: p }).catch((e) => ({ value: `<${e.code ?? e.message}>` }))).value;
// a scene shown as itself: /current = it, cur:* kind scene + ready, one live worker for it
function sceneShown(c, p) {
  const v = [];
  if (c.after.cur?.path !== p) v.push(`expected scene ${TITLE(p)} on screen, /current says ${TITLE(c.after.cur?.path)}`);
  const ids = srcIdsOf(c.after.st, p);
  const n = ids.length ? c.after.st.graph[ids[0]] : null;
  if (!n) v.push(`no live source for ${TITLE(p)}`);
  else { if (n.kind !== "scene") v.push(`${TITLE(p)}'s source kind ${n.kind}, expected scene`); if (n.ready !== true) v.push(`${TITLE(p)}'s source not ready`); }
  const w = workerOf(c.after.st, p);
  if (!w?.pid) v.push(`no scene worker for ${TITLE(p)} (workers: ${JSON.stringify((c.after.st.workers || []).map((x) => [x.id, x.pid, x.state]))})`);
  else if (!pidAlive(w.pid)) v.push(`${TITLE(p)}'s worker ${w.pid} is not running`);
  return v;
}

// advance-on-end with no minimum (the interval field IS the minimum there): k4's switch is armed for its end at once
const PENDING_PL = () => ({ paths: [K[3], K[0], K[1]], settings: PS({ advanceOnVideoEnd: true, intervalSeconds: 0, transitionDurationMs: 600 }) });
const STATES = {
  // roles: which item is on screen (`shown`) and which other item is live in the state (`other`: the
  // incoming B of an effect, the pending B of an end-wait) or, with nothing else live, an off-screen one
  idle: { exp: { paused: false }, roles: () => [null, null], async enter() {} },
  // `enter` runs before the UI loads (short entry fades), `late` after it (what must still be running when the cell acts)
  single: { exp: { paused: false }, roles: () => [K[0], K[2]], async enter(c) {
    await withGlobalMs(ENTRY_MS, async () => { await post("/apply", { path: K[0] }); c.ok = await waitSettled(12000, K[0]); }); } },
  playlist: { exp: { paused: false }, roles: () => [K[0], K[1]], async enter(c) { c.playlist = true; c.fresh = true;
    await playFast(c, [K[0], K[1], K[2]], PS()); } },
  // A → B with both live (from non-empty — never a fade in from nothing), an EFFECT_MS fade the control lands inside
  effect: { exp: { paused: false }, roles: () => [K[0], K[1]], playlist: () => ({ paths: [K[0], K[1], K[2]], settings: PS({ transitionDurationMs: EFFECT_MS }) }),
    async enter(c) { c.playlist = true; c.fresh = true; await playFast(c, [K[0], K[1], K[2]], PS({ transitionDurationMs: EFFECT_MS })); },
    async late(c) { c.fresh = false; await post("/next"); c.ok = await waitFor(async () => (await live()).some((t) => t.phase === "running" && (t.from || []).length > 0), 8000, 50); c.mid = true; } },
  pending: { exp: { paused: false }, roles: () => [K[3], K[0]], playlist: PENDING_PL, async enter(c) { c.playlist = true; c.fresh = true;
    await post("/playlist/play", PENDING_PL());
    c.ok = (await waitSettled(12000, K[3])) && (await waitFor(async () => (await live()).some((t) => t.phase === "waiting_start"), 8000, 50));
    c.pending = true; } },
  paused: { exp: { paused: true }, roles: () => [K[0], K[2]], async enter(c) { await STATES.single.enter(c); if (c.ok !== false) await post("/pause"); } },
  pausedEffect: { exp: { paused: true }, roles: () => [K[0], K[1]], playlist: () => STATES.effect.playlist(), async enter(c) { await STATES.effect.enter(c); },
    async late(c) { await STATES.effect.late(c); if (c.ok !== false) await post("/pause"); } },
  noOutput: { exp: { paused: false }, roles: () => [K[0], K[2]], async enter(c) {
    await STATES.single.enter(c); if (c.ok === false) return;
    await ctl.call("headless.remove_output", { name: "VIRTUAL-1" }); await ctl.call("headless.remove_output", { name: "VIRTUAL-2" }); c.noOutput = true; } },
  muted: { exp: { paused: false, muted: true }, roles: () => [K[0], K[2]], async enter(c) { await STATES.single.enter(c); if (c.ok !== false) await post("/mute", { user: true, value: true }); } },
  // like `playlist` (timed, 600 s), but FOLLOWING the global rotation (no override) — opt-in
  playlistGlobal: { optIn: true, exp: { paused: false }, roles: () => [K[0], K[1]], playlist: () => ({ paths: [K[0], K[1], K[2]], settings: PS({ overrideGlobalSettings: false }) }),
    async enter(c) { c.playlist = true; c.fresh = true;
      await post("/playlist/play", STATES.playlistGlobal.playlist()); c.ok = await waitSettled(12000, K[0]); } },
  // like `pending`, but the playlist FOLLOWS the global rotation + transitions (no override) — opt-in: only
  // the controls that list it run here. Its globals go in before the UI loads (the UI saves its whole copy).
  pendingGlobal: { optIn: true, exp: { paused: false }, roles: () => [K[3], K[0]], playlist: () => ({ ...PENDING_PL(), settings: PS({ overrideGlobalSettings: false, intervalSeconds: 0 }) }),
    async pre() { const s = await getSettings(); Object.assign(s, { globalAdvanceOnVideoEnd: true, globalIntervalSeconds: 0, globalMaxPlaySeconds: 0, globalTransitionDurationMs: 600 }); await post("/settings", s); },
    async enter(c) { c.playlist = true; c.fresh = true;
      await post("/playlist/play", STATES.pendingGlobal.playlist());
      c.ok = (await waitSettled(12000, K[3])) && (await waitFor(async () => (await live()).some((t) => t.phase === "waiting_start"), 8000, 50));
      c.pending = true; } },
  // like `playlist` with all four clips and 300 ms fades (timed, 600 s, its own rotation) — opt-in: the shuffle-order
  // cells step through many switches here
  playlist4: { optIn: true, exp: { paused: false }, roles: () => [K[0], K[1]], playlist: () => ({ paths: [K[0], K[1], K[2], K[3]], settings: PS({ transitionDurationMs: 300 }) }),
    async enter(c) { c.playlist = true; c.fresh = true;
      await post("/playlist/play", STATES.playlist4.playlist()); c.ok = await waitSettled(12000, K[0]); } },
  // Phase 2 scenes (opt-in: only the scene controls run here; scene support on before the UI loads)
  // a single scene (s1) on screen
  scene: { optIn: true, exp: { paused: false }, roles: () => [SC[0], SC[1]], async pre() { await scenesOn(); },
    async enter(c) { await withGlobalMs(ENTRY_MS, async () => { await post("/apply", { path: SC[0] }); c.ok = await waitSettled(12000, SC[0]); }); } },
  // the scene playlist [k1, s1, s2, k2] (timed, 600 s) at k1 / s1 / s2: next = V→S / S→S / S→V
  sceneV: { optIn: true, exp: { paused: false }, roles: () => [K[0], SC[0]], playlist: () => ({ paths: SC_PL(), settings: PS() }),
    async pre() { await scenesOn(); }, async enter(c) { c.playlist = true; c.fresh = true; await playFast(c, SC_PL(), PS()); } },
  sceneS: { optIn: true, exp: { paused: false }, roles: () => [SC[0], SC[1]], playlist: () => ({ paths: rot(SC_PL(), 1), settings: PS() }),
    async pre() { await scenesOn(); }, async enter(c) { c.playlist = true; c.fresh = true; await playFast(c, rot(SC_PL(), 1), PS()); } },
  sceneS2: { optIn: true, exp: { paused: false }, roles: () => [SC[1], K[1]], playlist: () => ({ paths: rot(SC_PL(), 2), settings: PS() }),
    async pre() { await scenesOn(); }, async enter(c) { c.playlist = true; c.fresh = true; await playFast(c, rot(SC_PL(), 2), PS()); } },
  // the scene playlist at s1 FOLLOWING the global rotation: advance-on-end, no minimum / maximum, "Separate timing for
  // scenes" off — nothing moves the scene (opt-in: the global scene-timing cell)
  sceneSGlobal: { optIn: true, exp: { paused: false }, roles: () => [SC[0], SC[1]], playlist: () => ({ paths: rot(SC_PL(), 1), settings: PS({ overrideGlobalSettings: false }) }),
    async pre() { await scenesOn({ globalAdvanceOnVideoEnd: true, globalIntervalSeconds: 0, globalMaxPlaySeconds: 0, globalSeparateSceneTiming: false, globalSwitchScenesAfterSeconds: 0 }); },
    async enter(c) { c.playlist = true; c.fresh = true; await playFast(c, rot(SC_PL(), 1), PS({ overrideGlobalSettings: false })); } },
};

// ---------------------------------------------------------------- controls
// Each: { run(c), switch?: waits for the switch to settle, check?(c) → violations[], pre?(c) before the UI loads,
//         exp?: oracle expectations, noSwitch?: no switch may be requested, rearms?: may cancel + re-arm an aligned
//         switch, states?: only these states (else every state but the opt-in ones) }
const srcFor = (snap, p) => sourcesOf(snap.st).filter(([, n]) => n.path === p);
const itemTargets = ["shown", "other", "off"];
const pick = (c, t) => (t === "shown" ? c.shown : t === "other" ? c.other : K[3] === c.shown ? K[2] : K[3]);
const C = {};
for (const t of itemTargets) {
  C[`itemVol:${t}`] = { async run(c) {
    c.target = pick(c, t); if (!c.target) return c.skip = "no target";
    await ui(`await m.cardMenu(${JSON.stringify(TITLE(c.target))}, "Settings (volume / speed)"); await m.sleep(500); m.setValue(m.modalRange(0), 37, "volume slider");`);
    await sleep(170); c.during = await snapshot();
    await sleep(500); await ui(`m.closeModal();`);
  }, check(c) {
    const v = []; const want = VolumeDb(37);
    for (const [id, n] of srcFor(c.during, c.target)) if (!near(n.gain?.user ?? 0, want)) v.push(`live drag didn't reach ${id}(${TITLE(c.target)}): ${n.gain?.user}`);
    const ov = (c.after.lib || []).find((i) => i.videoPath === c.target)?.volumeOverride;
    if (ov !== 37) v.push(`${TITLE(c.target)} volumeOverride ${ov}, expected 37`);
    return v;
  } };
  C[`itemSpd:${t}`] = { async run(c) {
    c.target = pick(c, t); if (!c.target) return c.skip = "no target";
    await ui(`await m.cardMenu(${JSON.stringify(TITLE(c.target))}, "Settings (volume / speed)"); await m.sleep(500); m.setValue(m.modalRange(1), 1.7, "speed slider");`);
    await sleep(170); c.during = await snapshot();
    await sleep(500); await ui(`m.closeModal();`);
  }, check(c) {
    const v = [];
    for (const [id, n] of srcFor(c.during, c.target)) if (!near(n.speed, 1.7, 0.001)) v.push(`live drag didn't reach ${id}(${TITLE(c.target)}): ${n.speed}`);
    const ov = (c.after.lib || []).find((i) => i.videoPath === c.target)?.speedOverride;
    if (ov !== 1.7) v.push(`${TITLE(c.target)} speedOverride ${ov}, expected 1.7`);
    return v;
  } };
  C[`itemVolReset:${t}`] = { async pre(c) { c.target = pick(c, t); if (c.target) await post("/library/volume", { path: c.target, intValue: 30 }); },
    async run(c) {
      if (!c.target) return c.skip = "no target";
      await ui(`await m.cardMenu(${JSON.stringify(TITLE(c.target))}, "Settings (volume / speed)"); await m.sleep(500); m.click(m.modalReset(0), "volume reset");`);
      await sleep(600); await ui(`m.closeModal();`);
    }, check(c) {
      const ov = (c.after.lib || []).find((i) => i.videoPath === c.target)?.volumeOverride;
      return ov == null ? [] : [`${TITLE(c.target)} volumeOverride ${ov} after reset`];
    } };
  C[`stripVol:${t}`] = { async run(c) {
    c.target = pick(c, t);
    const inStrip = await ui(`return !!m.strip(${JSON.stringify(TITLE(c.target))});`);
    if (!c.target || !inStrip) return c.skip = "target not in the strip";
    await ui(`await m.stripMenu(${JSON.stringify(TITLE(c.target))}, "Settings (volume / speed)"); await m.sleep(500); m.setValue(m.modalRange(0), 42, "volume slider");`);
    await sleep(700); await ui(`m.closeModal();`);
  }, check(c) {
    const ov = (c.after.lib || []).find((i) => i.videoPath === c.target)?.volumeOverride;
    return ov === 42 ? [] : [`${TITLE(c.target)} volumeOverride ${ov}, expected 42`];
  }, noSwitch: true };
}
// A REAL drag on an item's slider (40 steps over ~1.6 s), every source sampled every 40 ms meanwhile:
// no source of another item may move — even for a moment (owner: "A's speed leaks into B while it changes
// during a transition"; the single-step cells above only looked at the target, and only once)
const effectiveOf = (c, p, field, global) => (c.before.lib || []).find((i) => i.videoPath === p)?.[field] ?? global;
for (const [kind, idx, field, from, to] of [["Spd", 1, "speedOverride", 1.0, 2.6], ["Vol", 0, "volumeOverride", 80, 20]]) for (const t of ["shown", "other"]) {
  C[`item${kind}Drag:${t}`] = { async run(c) {
    c.target = pick(c, t); if (!c.target) return c.skip = "no target";
    await ui(`await m.cardMenu(${JSON.stringify(TITLE(c.target))}, "Settings (volume / speed)"); await m.sleep(500);`);
    c.samples = []; let on = true;
    const sampler = (async () => { while (on) { try { c.samples.push({ t: Date.now(), st: await ctl.call("state") }); } catch {} await sleep(40); } })();
    await ui(`await m.drag(m.modalRange(${idx}), ${from}, ${to}, 40, 40, "slider");`);
    await sleep(400); on = false; await sampler;
    c.previewBodies = await js(`window.__mxReq.slice(-20)`);
    await ui(`m.closeModal();`);
  }, check(c) {
    const v = [];
    for (const { st } of c.samples) for (const [id, n] of sourcesOf(st)) {
      if (n.path === c.target) continue;
      if (kind === "Spd") { const want = Math.min(4, Math.max(0.1, effectiveOf(c, n.path, field, c.before.s.speed)));
        if (!near(n.speed, want, 0.001)) v.push(`${id}(${TITLE(n.path)}) speed ${n.speed} while ${TITLE(c.target)}'s slider moved (its own: ${want})`); }
      else { const want = VolumeDb(effectiveOf(c, n.path, field, c.before.s.volume));
        if (!near(n.gain?.user ?? 0, want)) v.push(`${id}(${TITLE(n.path)}) gain.user ${n.gain?.user} while ${TITLE(c.target)}'s slider moved (its own: ${want})`); }
    }
    const ov = (c.after.lib || []).find((i) => i.videoPath === c.target)?.[field];
    if (ov !== to) v.push(`${TITLE(c.target)} ${field} ${ov}, expected ${to}`);
    if (v.length) v.push(`preview bodies: ${JSON.stringify((c.previewBodies || []).slice(0, 3).map((b) => String(b).replace(/\/tmp\/liascape-mx-[^/]+\/home\/.local\/share\/liascape\/library\/imported\/[^/]+\//g, "")))}`);
    return [...new Set(v)].slice(0, 4).concat(v.slice(-1));
  } };
}
// global settings (the "other" live item gets its own override first, so the override/global split shows)
const setting = (name, key, value, drive) => {
  C[`set:${name}`] = { async pre(c) { if (c.other) { await post("/library/volume", { path: c.other, intValue: 30 }); await post("/library/speed", { path: c.other, doubleValue: 0.8 }); } },
    async run() { await ui(`m.tab("Settings"); await m.sleep(500); ${drive}`); await sleep(900); },
    check(c) { const got = c.after.s[key]; return JSON.stringify(got) === JSON.stringify(value) ? [] : [`settings.${key} = ${JSON.stringify(got)}, expected ${JSON.stringify(value)}`]; } };
};
// A REAL drag on the Settings page's GLOBAL Volume/Speed slider (40 steps over ~1.6 s), every source sampled
// every 40 ms: a wallpaper that follows the global (no override of its own for that field) follows the drag
// LIVE — through the values in between, during the drag (RED before: the global sliders only saved 250 ms
// after the last tick; nothing moved while dragging) — and one with its own override never moves, not even
// for a moment (override ?? global, R61). The persisted value afterwards is the drag's last one.
for (const [kind, label, field, key, from, to, own, eps] of [["Vol", "Volume", "volumeOverride", "volume", 90, 20, 30, 0.02], ["Spd", "Speed", "speedOverride", "speed", 1.0, 2.5, 0.8, 0.001]]) {
  C[`globalDrag${kind}`] = {
    async pre(c) { if (c.other) await post(kind === "Vol" ? "/library/volume" : "/library/speed", kind === "Vol" ? { path: c.other, intValue: own } : { path: c.other, doubleValue: own }); },
    async run(c) {
      await ui(`m.tab("Settings"); await m.sleep(500);`);
      c.samples = []; let on = true;
      const sampler = (async () => { while (on) { try { c.samples.push({ t: Date.now(), st: await ctl.call("state") }); } catch {} await sleep(40); } })();
      c.t0 = Date.now();
      await ui(`await m.drag(m.input(${JSON.stringify(label)}), ${from}, ${to}, 40, 40, "global ${label} slider");`);
      c.t1 = Date.now();
      await sleep(900); on = false; await sampler;
    },
    check(c) {
      const v = [], lib = c.before.lib || [];
      const ownOf = (p) => lib.find((i) => i.videoPath === p)?.[field];
      const val = (n) => (kind === "Vol" ? n.gain?.user ?? 0 : n.speed);
      const wantOwn = (o) => (kind === "Vol" ? VolumeDb(o) : o);
      const seen = new Map(); // following source id → distinct values seen during the drag
      for (const { t, st } of c.samples) for (const [id, n] of sourcesOf(st)) {
        const o = ownOf(n.path);
        if (o != null) { if (!near(val(n), wantOwn(o), eps)) v.push(`${id}(${TITLE(n.path)}) has its own ${field} ${o} but ${key} ${val(n)} while the global slider moved`); continue; }
        if (t < c.t0 + 300 || t > c.t1) continue;
        if (!seen.has(id)) seen.set(id, new Set());
        seen.get(id).add(Math.round(val(n) * 1000) / 1000);
      }
      for (const [id, vals] of seen) if (vals.size < 3) v.push(`${id} follows the global but took only ${vals.size} value(s) during the drag (${[...vals].join(", ")}) — no live preview`);
      if (JSON.stringify(c.after.s[key]) !== JSON.stringify(to)) v.push(`settings.${key} = ${JSON.stringify(c.after.s[key])} after the drag, expected ${to}`);
      return [...new Set(v)].slice(0, 5);
    } };
}
setting("volume", "volume", 55, `m.setValue(m.input("Volume"), 55, "Volume");`);
setting("speed", "speed", 1.5, `m.setValue(m.input("Speed"), 1.5, "Speed");`);
setting("noAudio", "noAudio", true, `m.setCheck(m.input("Mute audio"), true, "Mute audio");`);
setting("loopOff", "loop", false, `m.setCheck(m.input("Loop"), false, "Loop");`);
setting("scaleFit", "videoScale", "fit", `await m.select("Video scale", "fit");`);
setting("fps24", "videoFps", 24, `m.setValue(m.input("Video FPS cap"), 24, "fps");`);
setting("hwdecNo", "hwDec", "no", `await m.select("Hardware decoding", "no");`);
setting("noCache", "disableCache", true, `m.setCheck(m.input("Disable cache"), true, "Disable cache");`);
setting("demux64", "demuxerMaxBytes", 64, `m.setValue(m.input("Demuxer max (MiB)"), 64, "demuxer");`);
// numeric settings fields type freely and snap on blur (owner: "everything should let you empty out the field
// entirely and only snap back to minimum when you focus out" — components/NumInput.tsx): focused, the field keeps
// exactly what was typed (empty / past the max) and nothing is saved; blur → clamped to min / max, saved
for (const [name, label, key, start, typed, want, adv] of [["clearToMin", "Demuxer max (MiB)", "demuxerMaxBytes", 40, "", 1, true],
  ["overToMax", "Video FPS cap", "videoFps", 24, "999", 480, false]]) {
  C[`num:${name}`] = { states: ["idle", "single"], noSwitch: true,
    async pre() { await post("/settings", { [key]: start, ...(adv ? { advancedSettings: true } : {}) }); },
    async run(c) {
      await ui(`m.tab("Settings"); for (let i = 0; i < 60 && !m.input(${JSON.stringify(label)}); i++) await m.sleep(100);
        const el = m.input(${JSON.stringify(label)}); el.focus(); m.setValue(el, ${JSON.stringify(typed)}, ${JSON.stringify(label)});`);
      await sleep(900); // past the store's 250 ms save debounce
      c.focused = { field: await ui(`return m.input(${JSON.stringify(label)}).value;`), saved: (await http("GET", "/settings")).json?.[key] };
      await ui(`m.input(${JSON.stringify(label)}).blur();`); await sleep(900);
      c.blurred = await ui(`return m.input(${JSON.stringify(label)}).value;`);
    }, check(c) {
      const v = [];
      if (c.focused.field !== typed) v.push(`while focused the field shows ${JSON.stringify(c.focused.field)}, typed ${JSON.stringify(typed)}`);
      if (c.focused.saved !== start) v.push(`while focused settings.${key} = ${c.focused.saved} (typed ${JSON.stringify(typed)}; nothing may be saved before the blur)`);
      if (c.after.s[key] !== want) v.push(`after the blur settings.${key} = ${c.after.s[key]}, expected ${want}`);
      if (c.blurred !== String(want)) v.push(`after the blur the field shows ${JSON.stringify(c.blurred)}, expected "${want}"`);
      return v;
    } };
}
// switches
// (neither side of a running effect: a fuzz chain's incoming B can be k3)
C["cardApply"] = { switch: true, async run(c) { c.target = [K[2], K[1], K[3]].find((p) => p !== c.shown && p !== c.before.cur?.path); await ui(`m.click(m.card(${JSON.stringify(TITLE(c.target))})?.querySelector(".thumb-wrap"), "card");`); },
  exp: { paused: false }, check: (c) => expectShown(c, c.target, { effect: true }) };
C["stripClick"] = { switch: true, async run(c) {
    for (const k of [K[2], K[1], K[0]]) if (k !== c.shown && (await ui(`return !!m.strip(${JSON.stringify(TITLE(k))});`))) { c.target = k; break; }
    if (!c.target) return c.skip = "no other item in the strip";
    await ui(`m.click(m.strip(${JSON.stringify(TITLE(c.target))}), "strip item");`); },
  exp: { paused: false }, check: (c) => [...expectShown(c, c.target, { effect: true }), ...psKept(c)] };
C["stripPlay"] = { switch: true, async run(c) { await ui(`m.click(document.querySelector(".play-btn"), "Play");`); },
  exp: { paused: false }, check: (c) => [...expectShown(c, c.after.ps?.videoPaths?.[0], { effect: !!c.before.cur?.path }), ...psKept(c)] };
C["stopButton"] = { switch: true, async run(c) { const has = await ui(`return !!m.byText(".topbar button", "Stop");`); if (!has) return c.skip = "no Stop button (nothing playing)"; await ui(`m.click(m.byText(".topbar button", "Stop"), "Stop");`); },
  exp: { paused: false }, check: (c) => (c.after.cur?.path ? [`still playing ${TITLE(c.after.cur.path)} after Stop`] : []) };
// playlist edits
C["stripRemove:other"] = { async run(c) { c.target = c.other; if (!c.target || !(await ui(`return !!m.strip(${JSON.stringify(TITLE(c.target))});`))) return c.skip = "not in strip";
  await ui(`m.click(m.strip(${JSON.stringify(TITLE(c.target))}).querySelector(".pl-remove"), "remove");`); await sleep(900); },
  check: afterRemove };
C["stripRemove:shown"] = { async run(c) { c.target = c.shown; if (!c.target || !(await ui(`return !!m.strip(${JSON.stringify(TITLE(c.target))});`))) return c.skip = "not in strip";
  await ui(`m.click(m.strip(${JSON.stringify(TITLE(c.target))}).querySelector(".pl-remove"), "remove");`); await sleep(900); },
  check: afterRemove };
// what plays after trashing `p`: on screen (or incoming — /current is the incoming side) → a playlist plays on
// from the next surviving strip item after it, a single item stops; anything else → no switch at all
function afterTrash(c, p) {
  const v = [...notTargeted(c, p, { gone: true })];
  const was = c.before.cur?.path, now = c.after.cur?.path, strip = c.before.ps?.videoPaths || [];
  if (now === p) v.push(`trashed ${TITLE(p)} still on screen`);
  if (c.noOutput) return v;
  let want = was;
  if (was === p) {
    const i = strip.indexOf(p);
    want = c.playlist && i >= 0 ? [...strip.slice(i + 1), ...strip.slice(0, i)][0] ?? null : null;
  }
  if ((now ?? null) !== (want ?? null)) v.push(`after trashing ${TITLE(p)}: /current ${TITLE(now)}, expected ${TITLE(want)}`);
  return v;
}
// trashing what's on screen stops the session or plays on from the next item — a new session: a pause ends
const trashEndsPause = (c) => { if (c.before.cur?.path === c.target) c.exp.paused = false; };
C["trash:other"] = { switch: true, async run(c) { c.target = c.other; if (!c.target) return c.skip = "no other"; trashEndsPause(c);
  await ui(`m.click(m.card(${JSON.stringify(TITLE(c.target))})?.querySelector(".del"), "trash");`); await sleep(900); },
  check: (c) => [...afterTrash(c, c.target), ...armedCheck(c)] };
C["trash:shown"] = { switch: true, async run(c) { c.target = c.shown; if (!c.target) return c.skip = "nothing shown"; trashEndsPause(c);
  await ui(`m.click(m.card(${JSON.stringify(TITLE(c.target))})?.querySelector(".del"), "trash");`); await sleep(900); },
  check: (c) => afterTrash(c, c.target) };
// trash then Undo: back in the library AND in the playlist where it was (the strip shows it)
for (const t of ["shown", "other"]) C[`trashUndo:${t}`] = { switch: true, async run(c) {
    c.target = t === "shown" ? c.shown : c.other; if (!c.target) return c.skip = "no target"; trashEndsPause(c);
    c.idx = (c.before.ps?.videoPaths || []).indexOf(c.target);
    await ui(`m.click(m.card(${JSON.stringify(TITLE(c.target))})?.querySelector(".del"), "trash"); await m.sleep(900); m.click(m.byText(".topbar button", "Undo"), "Undo");`);
    await sleep(900); },
  check(c) {
    const v = [];
    if (!(c.after.lib || []).some((i) => i.videoPath === c.target)) v.push(`${TITLE(c.target)} not back in the library`);
    const at = (c.after.ps?.videoPaths || []).indexOf(c.target);
    if (c.idx >= 0 && at !== c.idx) v.push(`${TITLE(c.target)} back at playlist index ${at}, was ${c.idx}`);
    return [...v, ...armedCheck(c)]; // an armed switch goes to the strip's next again — the undone item when it's that
  } };
// keybind volume-up, then any UI settings save: the keybind's volume must survive (the UI posts its whole copy)
C["cli:volume-up+uiSave"] = { async run(c) {
    c.cli = await cli("volume-up"); await sleep(400);
    await ui(`m.tab("Settings"); await m.sleep(500); m.setCheck(m.input("Loop"), false, "Loop");`); await sleep(900); },
  check: (c) => volKeyAuto(c, "volume-up", " + a UI save") };
C["plAdvanceOff"] = { async run(c) {
  await ui(`m.click(document.querySelector('button[title="Playlist settings"]'), "pl settings"); await m.sleep(500); m.setCheck(m.plCheck("Switch when video ends"), false, "advance"); await m.sleep(400); m.click(m.byText(".pl-modal button", "Close"), "close");`);
  await sleep(900); },
  check(c) { const v = []; if (c.after.ps?.settings?.advanceOnVideoEnd !== false) v.push(`playlist advanceOnVideoEnd ${c.after.ps?.settings?.advanceOnVideoEnd}`);
    if (c.pending && (c.after.st.transitions || []).some((t) => t.phase === "waiting_start")) v.push("advance-on-end turned off but the aligned switch is still armed");
    return v; } };
// keybinds (a separate one-shot CLI process each, like a real keybind)
const action = (a, check, extra = {}) => { C[`cli:${a}`] = { async run(c) { c.cli = await cli(a); }, check, ...extra }; };
action("toggle-pause", () => [], { flipPause: true }); // the oracle checks player.paused against the flipped expectation
action("toggle-mute", () => [], { flipMute: true });
// VolumeKeyTarget "auto" (the default): the playing wallpaper's own volume moves when it has one, else the global. A
// matrix cell's playing item never has one here (the `:overridden` cells below cover that); a fuzz chain's may (an
// earlier step dragged its slider) — `what` names what ran before the check (a UI save after the key)
function volKeyAuto(c, a, what = "") {
  const cur = c.before.cur?.path, own = cur ? ((c.before.lib || []).find((i) => i.videoPath === cur)?.volumeOverride ?? null) : null;
  const want = (b) => (a === "volume-up" ? Math.min(100, b + 5) : Math.max(0, b - 5));
  if (own == null) return c.after.s.volume === want(c.before.s.volume) ? [] : [`volume ${c.after.s.volume} after ${a}${what} from ${c.before.s.volume}`];
  const v = [], got = (c.after.lib || []).find((i) => i.videoPath === cur)?.volumeOverride ?? null;
  const exp = want(own) === c.before.s.volume ? null : want(own); // landing on the global = follows it again (SaveVolumeOverride)
  if (c.after.s.volume !== c.before.s.volume) v.push(`auto, ${TITLE(cur)} has its own volume ${own}: the global moved ${c.before.s.volume} → ${c.after.s.volume}${what}`);
  if (got !== exp) v.push(`auto: ${TITLE(cur)}'s own volume ${got} after ${a}${what} from ${own}, expected ${exp}`);
  return v;
}
action("volume-up", (c) => volKeyAuto(c, "volume-up"));
action("volume-down", (c) => volKeyAuto(c, "volume-down"));
// the same keybinds by VolumeKeyTarget (Advanced → "Volume keys adjust"): "auto" (default) moves the playing
// wallpaper's own volume when it has one, else the global; "item" always the playing wallpaper's own (giving it
// one); "global" always the global (an overridden one keeps its own). Every other item keeps its own, and every
// source runs override ?? global (the general oracle, R61). `cur` = the playing item (mid-effect: the incoming).
const volKey = (a, base) => (a === "volume-up" ? Math.min(100, base + 5) : Math.max(0, base - 5));
const ovOf = (c, p) => (c.after.lib || []).find((i) => i.videoPath === p)?.volumeOverride ?? null;
const VKS = ["single", "playlist", "effect", "pending", "paused"];
for (const a of ["volume-up", "volume-down"]) {
  C[`cli:${a}:overridden`] = { states: VKS, // auto, both live items at their own 30
    async pre(c) { for (const p of [c.shown, c.other].filter(Boolean)) await post("/library/volume", { path: p, intValue: 30 }); },
    async run(c) { c.cli = await cli(a); await sleep(400); },
    check(c) {
      const cur = c.before.cur?.path, v = [];
      if (c.after.s.volume !== c.before.s.volume) v.push(`auto, ${TITLE(cur)} has its own volume: the global moved ${c.before.s.volume} → ${c.after.s.volume}`);
      if (ovOf(c, cur) !== volKey(a, 30)) v.push(`auto: ${TITLE(cur)}'s own volume ${ovOf(c, cur)} after ${a} from 30, expected ${volKey(a, 30)}`);
      for (const p of [c.shown, c.other].filter((p) => p && p !== cur)) if (ovOf(c, p) !== 30) v.push(`${TITLE(p)} (not playing) moved to ${ovOf(c, p)}`);
      return v;
    } };
  C[`cli:${a}:item`] = { states: VKS, // "item", no overrides: the playing item gets one
    async pre() { const s = await getSettings(); await post("/settings", { ...s, volumeKeyTarget: "item" }); },
    async run(c) { c.cli = await cli(a); await sleep(400); },
    check(c) {
      const cur = c.before.cur?.path, g = c.before.s.volume, want = volKey(a, g), v = [];
      if (c.after.s.volume !== g) v.push(`item mode: the global moved ${g} → ${c.after.s.volume}`);
      if (ovOf(c, cur) !== (want === g ? null : want)) v.push(`item mode: ${TITLE(cur)}'s own volume ${ovOf(c, cur)} after ${a} from the global ${g}, expected ${want}`);
      for (const p of [c.shown, c.other].filter((p) => p && p !== cur)) if (ovOf(c, p) != null) v.push(`${TITLE(p)} (not playing) got its own volume ${ovOf(c, p)}`);
      return v;
    } };
  C[`cli:${a}:global`] = { states: VKS, // "global", both live items at their own 30: only the global moves
    async pre(c) { const s = await getSettings(); await post("/settings", { ...s, volumeKeyTarget: "global" });
      for (const p of [c.shown, c.other].filter(Boolean)) await post("/library/volume", { path: p, intValue: 30 }); },
    async run(c) { c.cli = await cli(a); await sleep(400); },
    check(c) {
      const v = [];
      if (c.after.s.volume !== volKey(a, c.before.s.volume)) v.push(`global mode: volume ${c.after.s.volume} after ${a} from ${c.before.s.volume}`);
      for (const p of [c.shown, c.other].filter(Boolean)) if (ovOf(c, p) !== 30) v.push(`global mode: ${TITLE(p)}'s own volume moved to ${ovOf(c, p)}`);
      return v;
    } };
}
// the playing item's settings modal open while the keybind moves its own volume: the modal's slider follows (WS
// `library-item-changed`), and closing it saves nothing that undoes the keybind
C["cli:volume-up:modalOpen"] = { states: ["single", "playlist"],
  async pre(c) { await post("/library/volume", { path: c.shown, intValue: 30 }); },
  async run(c) {
    const open = `await m.cardMenu(${JSON.stringify(TITLE(c.shown))}, "Settings (volume / speed)"); await m.sleep(600);`;
    await ui(`${open}`); c.cli = await cli("volume-up"); await sleep(600);
    c.shownValue = await ui(`return m.modalRange(0)?.value;`);
    await ui(`m.closeModal();`); await sleep(900);
  }, check(c) {
    const v = [];
    if (String(c.shownValue) !== "35") v.push(`the open modal's volume slider shows ${c.shownValue} after the keybind moved it 30 → 35`);
    if (ovOf(c, c.shown) !== 35) v.push(`${TITLE(c.shown)}'s own volume ${ovOf(c, c.shown)} after the keybind + closing the modal, expected 35`);
    return v;
  } };
// user switches — paused: KeepPauseOnSwitch off (default) resumes and switches with the transition; on
// (the `-keep` cells) stays paused and cuts to B's first frame
const stayed = (c, a) => (c.before.cur?.path && c.after.cur?.path === c.before.cur.path ? [`${a} stayed on ${TITLE(c.before.cur.path)}`] : []);
function pausedSwitch(c) {
  if (!c.wasPaused || !c.before.cur?.path || c.after.cur?.path === c.before.cur.path) return [];
  const sched = c.evs.filter((e) => e.event === "transition.scheduled");
  const last = sched[sched.length - 1];
  if (!last) return ["no switch was requested"];
  if (c.keep && last.effect_id != null) return [`a switch while paused that keeps the pause used ${last.effect_id}, not a cut`];
  if (!c.keep && !c.noOutput && !c.cutsOk && last.effect_id == null) return ["a switch that resumes from a pause was a cut (transitions are on)"];
  return [];
}
// a fresh playlist session at its first item has nothing before it: previous leaves it — and an armed
// aligned switch — alone (it used to relaunch the playing item and cancel the armed switch)
function prevCheck(c) {
  if (!c.before.cur?.path) return [];
  if (!c.fresh) return [...stayed(c, "previous-wallpaper"), ...pausedSwitch(c)];
  const v = [];
  if (c.after.cur?.path !== c.before.cur.path) v.push(`previous at the first item switched to ${TITLE(c.after.cur?.path)}`);
  for (const e of c.evs) if (e.event === "transition.scheduled" || e.event === "transition.cancelled") v.push(`previous at the first item: ${e.event} ${e.corr} ${TITLE(e.path) ?? ""}`);
  return v;
}
const SWITCHES = {
  "next-wallpaper": (c) => [...stayed(c, "next-wallpaper"), ...pausedSwitch(c)],
  "previous-wallpaper": prevCheck,
  random: (c) => [...stayed(c, "random"), ...pausedSwitch(c)],
};
for (const [a, check] of Object.entries(SWITCHES)) {
  // a user switch from a pause resumes (default) or keeps it (-keep); in a fresh session's no-op previous it keeps it either way
  const userSwitch = (keep) => (c) => { c.wasPaused = !!c.exp.paused; c.keep = keep; if (c.wasPaused && !keep && !(a === "previous-wallpaper" && c.fresh)) c.exp.paused = false; };
  C[`cli:${a}`] = { switch: true, async run(c) { userSwitch(false)(c); c.cli = await cli(a); }, check };
  C[`cli:${a}-keep`] = { switch: true,
    async pre() { const s = await getSettings(); s.keepPauseOnSwitch = true; await post("/settings", s); },
    async run(c) { userSwitch(true)(c); if (c.wasPaused) c.noSettle = true; c.cli = await cli(a); },
    check: (c) => [...check(c), ...(c.after.s.keepPauseOnSwitch ? [] : ["keepPauseOnSwitch not set"])] };
}
action("stop", (c) => (c.after.cur?.path ? [`still playing ${TITLE(c.after.cur.path)} after stop`] : []), { switch: true, exp: { paused: false } });

// ---------------------------------------------------------------- the playlist strip + two controls in a row
// (each control lists its `states` — the ones where its two halves share state; not a full cross product)
const PL_STATES = ["playlist", "effect", "pending"];
const succ = (list, p) => { const i = (list || []).indexOf(p); return i < 0 ? list?.[0] : list[(i + 1) % list.length]; };
const armedTo = (st) => (st.transitions || []).filter((t) => t.phase === "waiting_start").map((t) => st.graph[t.to]?.path ?? t.to);
// an advance-on-end session (the `pending` state) keeps exactly one aligned switch armed, to the strip's next
// item after what plays (`want`; null = none may stay armed)
function armedCheck(c, want = succ(c.after.ps?.videoPaths, c.after.cur?.path)) {
  if (!c.pending || c.noOutput) return [];
  if ((c.after.ps?.videoPaths || []).length < 2) want = null; // a one-item playlist has nothing to advance to
  const a = armedTo(c.after.st);
  if (want === null) return a.length ? [`an aligned switch is still armed (to ${a.map(TITLE)})`] : [];
  if (a.length !== 1) return [`${a.length} aligned switches armed (${a.map(TITLE)}), expected one to ${TITLE(want)}`];
  return a[0] === want ? [] : [`the armed switch goes to ${TITLE(a[0])}, expected ${TITLE(want)} (the strip's next after ${TITLE(c.after.cur?.path)})`];
}
// a playlist edit never switches by itself (re-arming an aligned switch for A's end is fine)
const noSwitchNow = (c) => c.evs.filter((e) => e.event === "transition.scheduled" && e.align !== "end").map((e) => `a switch was requested (to ${TITLE(e.path)}, align ${e.align})`);
const keptShown = (c) => (c.noOutput || (c.after.cur?.path ?? null) === (c.before.cur?.path ?? null) ? [] : [`/current ${TITLE(c.before.cur?.path)} → ${TITLE(c.after.cur?.path)} after a playlist edit`]);
const stripHas = (c, p) => ui(`return !!m.strip(${JSON.stringify(TITLE(p))});`);
// every switch the cell requested, in order (B's path)
const switchesTo = (c) => c.evs.filter((e) => e.event === "transition.scheduled").map((e) => e.path);
async function cliStep(c, a) { const r = await cli(a); if (!c.cli || r.code !== 0) c.cli = r; return r; }
// the switch the cell made last ("now" — not the aligned one an advance-on-end session re-arms after it)
const lastSwitch = (c) => c.evs.filter((e) => e.event === "transition.scheduled" && e.align !== "end").pop();

// --- drag-reorder: REAL input events (Chromium makes the pointer events dnd-kit's PointerSensor listens to:
// pointerdown on the item, pointermove past its 6 px activation distance, pointerup over the drop target)
async function stripDrag(fromTitle, toTitle) {
  const r = await ui(`const a = m.strip(${JSON.stringify(fromTitle)}), b = m.strip(${JSON.stringify(toTitle)});
    if (!a || !b) throw new Error("strip item not found"); a.scrollIntoView({ block: "nearest", inline: "nearest" }); await m.sleep(150);
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return { ax: ra.x + ra.width / 2, ay: ra.y + ra.height / 2, bx: rb.x + rb.width / 2, by: rb.y + rb.height / 2 };`);
  const send = (e) => win.webContents.sendInputEvent(e);
  const at = (x, y) => ({ x: Math.round(x), y: Math.round(y) });
  send({ type: "mouseMove", ...at(r.ax, r.ay) }); await sleep(60);
  send({ type: "mouseDown", ...at(r.ax, r.ay), button: "left", clickCount: 1 }); await sleep(60);
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    send({ type: "mouseMove", ...at(r.ax + (r.bx - r.ax) * i / steps, r.ay + (r.by - r.ay) * i / steps), button: "left", modifiers: ["leftButtonDown"] });
    await sleep(35);
  }
  await sleep(250); // dnd-kit's sortable settles over the target
  send({ type: "mouseUp", ...at(r.bx, r.by), button: "left", clickCount: 1 });
  await sleep(900); // the strip's debounced /playlist/state save (200 ms) + the backend's live reorder
}
const stripTitles = () => ui(`return [...document.querySelectorAll(".pl-item")].map((e) => e.title);`);
const moved = (list, from, to) => { const l = [...list]; const [x] = l.splice(from, 1); l.splice(to, 0, x); return l; };
for (const [name, fromIdx, toIdx] of [["lastToSecond", -1, 1], ["firstToEnd", 0, -1]]) {
  const plan = (c) => { const s = c.before.ps?.videoPaths || []; const f = fromIdx < 0 ? s.length + fromIdx : fromIdx, t = toIdx < 0 ? s.length + toIdx : toIdx; return { s, f, t, want: moved(s, f, t) }; };
  C[`stripDrag:${name}`] = { states: PL_STATES, async run(c) {
      const { s, f, t, want } = plan(c); c.want = want;
      await stripDrag(TITLE(s[f]), TITLE(s[t]));
      c.uiStrip = await stripTitles();
    }, check(c) {
      const v = [...noSwitchNow(c), ...keptShown(c), ...armedCheck(c)];
      const got = (c.after.ps?.videoPaths || []).map(TITLE), w = c.want.map(TITLE);
      if (JSON.stringify(got) !== JSON.stringify(w)) v.push(`playlist ${JSON.stringify(got)} after dragging, expected ${JSON.stringify(w)} (UI strip right after the drop: ${JSON.stringify(c.uiStrip)})`);
      return v;
    } };
}
// drag, then next: the next item is the new order's (not the old one's)
C["seq:stripDrag+next"] = { states: ["playlist", "effect"], switch: true, async run(c) {
    const s = c.before.ps?.videoPaths || []; c.want = moved(s, s.length - 1, 1);
    await stripDrag(TITLE(s[s.length - 1]), TITLE(s[1]));
    c.target = succ(c.want, c.before.cur?.path);
    await cliStep(c, "next-wallpaper");
  }, check: (c) => [...expectShown(c, c.target, { effect: true })] };

// --- remove from the playlist (the X, or the context menu) — the shown item, the incoming/armed one, another
const stripOff = (c) => (c.before.ps?.videoPaths || []).find((p) => p !== c.shown && p !== c.other);
const removeTarget = (c, t) => (t === "shown" ? c.shown : t === "other" ? c.other : stripOff(c));
function afterRemove(c) {
  const v = [...notTargeted(c, c.target), ...noSwitchNow(c), ...keptShown(c)];
  // what the rotation plays next: the strip's next item after what plays — after the REMOVED one when that
  // was what played (its old successor that's still there), like trash does
  const old = c.before.ps?.videoPaths || [], now = c.after.ps?.videoPaths || [], cur = c.after.cur?.path;
  let want = succ(now, cur);
  if (cur === c.target) { const i = old.indexOf(cur); want = [...old.slice(i + 1), ...old.slice(0, i)].find((p) => now.includes(p)) ?? null; }
  return [...v, ...armedCheck(c, want)];
}
for (const t of ["shown", "other", "off"]) {
  if (t === "off") C["stripRemove:off"] = { states: PL_STATES, async run(c) { c.target = stripOff(c); if (!c.target || !(await stripHas(c, c.target))) return c.skip = "not in strip";
    await ui(`m.click(m.strip(${JSON.stringify(TITLE(c.target))}).querySelector(".pl-remove"), "remove");`); await sleep(900); }, check: afterRemove };
  C[`stripRemoveMenu:${t}`] = { states: PL_STATES, async run(c) { c.target = removeTarget(c, t); if (!c.target || !(await stripHas(c, c.target))) return c.skip = "not in strip";
    await ui(`await m.stripMenu(${JSON.stringify(TITLE(c.target))}, "Remove from playlist");`); await sleep(900); }, check: afterRemove };
}
// remove what plays (or is incoming), then next: the rotation goes on from the removed item's place in the strip
for (const t of ["shown", "other"]) C[`seq:stripRemove+next:${t}`] = { states: t === "shown" ? PL_STATES : ["effect"], switch: true, async run(c) {
    c.target = removeTarget(c, t); if (!c.target || !(await stripHas(c, c.target))) return c.skip = "not in strip";
    const old = c.before.ps?.videoPaths || [], cur = c.before.cur?.path, i = old.indexOf(cur);
    const now = old.filter((p) => p !== c.target);
    c.want = cur === c.target ? [...old.slice(i + 1), ...old.slice(0, i)].find((p) => now.includes(p)) : succ(now, cur);
    await ui(`m.click(m.strip(${JSON.stringify(TITLE(c.target))}).querySelector(".pl-remove"), "remove");`); await sleep(900);
    await cliStep(c, "next-wallpaper");
  }, check: (c) => [...expectShown(c, c.want, { effect: true }), ...((c.after.ps?.videoPaths || []).includes(c.target) ? [`${TITLE(c.target)} still in the playlist`] : [])] };

// --- saved playlists (the strip's Save / Load modals → /playlist/save, /playlist/load)
C["plSave"] = { states: ["idle", "playlist", "pending"], noSwitch: true, async run(c) {
    c.name = `mx-${c.state}`;
    await ui(`m.click(document.querySelector('button[title="Save playlist"]'), "save"); await m.sleep(500);
      m.setValue(document.querySelector(".pl-modal input.text"), ${JSON.stringify(c.name)}, "name"); await m.sleep(150);
      m.click(m.byText(".pl-modal button", "Save"), "Save");`);
    await sleep(900);
    c.names = (await http("GET", "/playlist/names")).json; c.saved = (await post("/playlist/load", { name: c.name })).json;
  }, check(c) {
    const v = [];
    if (!(c.names || []).includes(c.name)) v.push(`/playlist/names ${JSON.stringify(c.names)} has no ${c.name}`);
    const a = (c.saved?.videoPaths || []).map(TITLE), b = (c.before.ps?.videoPaths || []).map(TITLE);
    if (JSON.stringify(a) !== JSON.stringify(b)) v.push(`saved ${JSON.stringify(a)}, the strip was ${JSON.stringify(b)}`);
    for (const k of ["order", "intervalSeconds", "advanceOnVideoEnd", "transitionEnabled", "transitionDurationMs"])
      if (JSON.stringify(c.saved?.settings?.[k]) !== JSON.stringify(c.before.ps?.settings?.[k])) v.push(`saved ${k} ${JSON.stringify(c.saved?.settings?.[k])}, the playlist's ${JSON.stringify(c.before.ps?.settings?.[k])}`);
    return [...v, ...keptShown(c), ...armedCheck(c)];
  } };
// a saved playlist with other items, another order and its own rotation (timed, 300 s: no advance-on-end)
const LOADED = () => ({ videoPaths: [K[2], K[1], K[3]], settings: PS({ intervalSeconds: 300, transitionDurationMs: 900 }), name: "mx-load" });
const loadIt = (c) => ui(`m.click(document.querySelector('button[title="Load playlist"]'), "load"); await m.sleep(500);
  m.click(m.byText(".pl-modal .pl-name", "mx-load"), "mx-load"); await m.sleep(150); m.click(m.byText(".pl-modal button", "Load"), "Load");`);
C["plLoad"] = { states: ["idle", "single", ...PL_STATES], async pre() { await post("/playlist/save", { name: "mx-load", playlist: LOADED() }); },
  async run(c) { await loadIt(c); await sleep(1200); c.uiStrip = await stripTitles(); },
  check(c) {
    const v = [...noSwitchNow(c), ...keptShown(c)];
    const want = LOADED().videoPaths.map(TITLE), got = (c.after.ps?.videoPaths || []).map(TITLE);
    if (JSON.stringify(got) !== JSON.stringify(want)) v.push(`playlist ${JSON.stringify(got)} after loading, expected ${JSON.stringify(want)}`);
    if (JSON.stringify(c.uiStrip) !== JSON.stringify(want)) v.push(`UI strip ${JSON.stringify(c.uiStrip)} after loading, expected ${JSON.stringify(want)}`);
    if (c.after.ps?.settings?.intervalSeconds !== 300) v.push(`playlist interval ${c.after.ps?.settings?.intervalSeconds} after loading, expected 300`);
    // the loaded rotation has no advance-on-end: nothing may stay armed (an armed switch to k1 played an item the playlist no longer holds)
    return [...v, ...armedCheck(c, null)];
  } };
C["seq:plLoad+next"] = { states: ["playlist", "effect"], switch: true, async pre() { await post("/playlist/save", { name: "mx-load", playlist: LOADED() }); },
  async run(c) { await loadIt(c); await sleep(1200); c.want = succ(LOADED().videoPaths, c.before.cur?.path); await cliStep(c, "next-wallpaper"); },
  check(c) { const v = expectShown(c, c.want, { effect: true }); const d = lastSwitch(c)?.duration_ms;
    if (d !== undefined && d !== 900) v.push(`the switch after loading took ${d} ms, the loaded playlist says 900`); return v; } };

// --- the playlist-settings modal beyond advance-on-end, while playing
const plOpen = `m.click(document.querySelector('button[title="Playlist settings"]'), "pl settings"); await m.sleep(500);`;
const plClose = `await m.sleep(400); m.click(m.byText(".pl-modal button", "Close"), "close");`;
const hms = (i) => `document.querySelectorAll(".pl-modal .hms input")[${i}]`;
// interval → 8 s live: the running rotation switches within the new interval (its countdown keeps the elapsed part)
C["plInterval"] = { states: ["playlist", "pending"], async run(c) {
    await ui(`${plOpen} m.setValue(${hms(2)}, 8, "s"); await m.sleep(300); m.setValue(${hms(1)}, 0, "m"); ${plClose}`);
    c.tChange = Date.now();
    c.sw = await waitFor(async () => events.some((e) => e._t >= c.tChange - 500 && e.event === "transition.scheduled" && e.align !== "end"), 11000, 100);
    await sleep(300); await waitSettled(8000);
  }, check(c) {
    const v = [];
    if (c.after.ps?.settings?.intervalSeconds !== 8) v.push(`playlist interval ${c.after.ps?.settings?.intervalSeconds}, expected 8`);
    // pending: advance-on-end stays on — the field is its MINIMUM play time there (8 s ≤ k4's 10 s: it still advances at
    // k4's end, re-armed for it)
    if (!c.pending && !c.sw) v.push("no switch within 11 s of setting an 8 s interval");
    return [...v, ...armedCheck(c)];
  } };
// the minutes field emptied first (0 m 0 s for a moment): no switch storm, then the 8 s interval holds
C["plIntervalZero"] = { states: ["playlist"], async run(c) {
    await ui(`${plOpen} m.setValue(${hms(1)}, 0, "m"); await m.sleep(1500);`);
    c.during = events.filter((e) => e._t >= Date.now() - 1500 && e.event === "transition.scheduled").length;
    await ui(`m.setValue(${hms(2)}, 8, "s"); ${plClose}`);
    c.tChange = Date.now();
    c.sw = await waitFor(async () => events.some((e) => e._t >= c.tChange - 500 && e.event === "transition.scheduled"), 11000, 100);
    await sleep(300); await waitSettled(8000);
  }, check(c) {
    const v = [];
    if (c.during > 0) v.push(`${c.during} switches while the interval read 0 s`);
    if (c.after.ps?.settings?.intervalSeconds !== 8) v.push(`playlist interval ${c.after.ps?.settings?.intervalSeconds}, expected 8`);
    if (!c.sw) v.push("no switch within 11 s of setting an 8 s interval");
    const n = switchesTo(c).length; if (n > 2) v.push(`${n} switches requested in the cell (storm?)`);
    return v;
  } };
// "Switch when video ends" on (the timed playlist, 600 s): the one interval field is relabelled "Minimum play time"
// (same value), "Maximum play time" appears below it, there's no wait toggle any more; a 4 s minimum on k1 (30 s) →
// the switch is armed for k1's end (align:end), never made now
C["plAdvanceRelabel"] = { states: ["playlist"], async run(c) {
    await ui(`${plOpen} m.setCheck(m.plCheck("Switch when video ends"), true, "advance"); await m.sleep(400);`);
    c.ui = await js(`(() => { const lab = [...document.querySelectorAll(".pl-modal .field-label")].map((e) => e.textContent.trim());
      const g = document.querySelectorAll(".pl-modal .hms"); const v = (i) => [...g[i]?.querySelectorAll("input") ?? []].map((x) => x.value);
      return { lab, min: v(0), max: v(1), wait: [...document.querySelectorAll(".pl-modal label.ck")].some((l) => /wait for video/i.test(l.textContent)) }; })()`);
    await ui(`m.setValue(${hms(2)}, 4, "s"); await m.sleep(300); m.setValue(${hms(1)}, 0, "m"); ${plClose}`);
    c.tChange = Date.now();
    c.armed = await waitFor(async () => armedTo(await ctl.call("state")).length > 0, 9000, 100);
  }, check(c) {
    const v = [];
    const s = c.after.ps?.settings;
    if (!s?.advanceOnVideoEnd || s?.intervalSeconds !== 4) v.push(`playlist advance ${s?.advanceOnVideoEnd} interval (minimum) ${s?.intervalSeconds}, expected true / 4`);
    if (!c.ui?.lab?.includes("MINIMUM PLAY TIME") || c.ui?.lab?.includes("SWITCH EVERY")) v.push(`modal labels ${JSON.stringify(c.ui?.lab)}: expected "MINIMUM PLAY TIME" in place of "SWITCH EVERY"`);
    if (JSON.stringify(c.ui?.min) !== '["0","10","0"]') v.push(`the minimum shows ${JSON.stringify(c.ui?.min)} — expected the same field's 600 s (0 h 10 m 0 s)`);
    if (!c.ui?.lab?.includes("MAXIMUM PLAY TIME") || (c.ui?.max ?? []).length !== 3) v.push(`no "MAXIMUM PLAY TIME" h/m/s field under the minimum (${JSON.stringify(c.ui)})`);
    if (c.ui?.wait) v.push("the removed \"Wait for video to end\" toggle is still in the modal");
    if (!c.armed) v.push("a 4 s minimum on a 30 s clip: no switch armed for its end");
    const now = c.evs.filter((e) => e.event === "transition.scheduled" && e.align !== "end");
    if (now.length) v.push(`advance-on-end + a 4 s minimum switched at once (to ${now.map((e) => TITLE(e.path))})`);
    return v;
  } };
// order → Shuffle: no switch now; the session keeps what plays; an armed switch still goes to a playlist item
C["plShuffle"] = { states: ["playlist", "pending"], async run(c) {
    await ui(`${plOpen} m.click(m.byText(".pl-modal .segbtn", "Shuffle"), "Shuffle"); ${plClose}`); await sleep(900);
  }, check(c) {
    const v = [...noSwitchNow(c), ...keptShown(c)];
    if (c.after.ps?.settings?.order !== 1) v.push(`playlist order ${c.after.ps?.settings?.order}, expected 1 (shuffle)`);
    const strip = c.after.ps?.videoPaths || [];
    if (c.pending) { const a = armedTo(c.after.st); if (a.length !== 1 || !strip.includes(a[0]) || a[0] === c.after.cur?.path) v.push(`armed after shuffling: ${JSON.stringify(a.map(TITLE))}`); }
    return v;
  } };
// the transition picker (playlist): off / a duration / another effect — then the next switch uses it; with an
// aligned switch already armed (pending) that switch must use it too (it fires later; it's still "the next switch")
const trOpen = `m.click(document.querySelector(".pl-modal .tr-open"), "transitions"); await m.sleep(600);
  for (let i = 0; i < 30 && !document.querySelector(".tr-modal .tr-chip"); i++) await m.sleep(100);`;
const trDone = `await m.sleep(300); m.click(document.querySelector(".tr-modal .tr-done"), "Done"); await m.sleep(500);`;
const TR = {
  Off: { drive: `m.setCheck(document.querySelector(".tr-modal .tr-head input[type=checkbox]"), false, "enable");`,
    saved: (s) => s?.transitionEnabled === false, want: (e) => e.effect_id == null, what: "a cut" },
  Duration: { drive: `m.setValue(document.querySelector(".tr-modal .tr-row input.num"), 1200, "duration");`,
    saved: (s) => s?.transitionDurationMs === 1200, want: (e) => e.duration_ms === 1200, what: "1200 ms" },
  // under the old 50 ms floor (owner QOL): a 20 ms effect runs as 20 ms; 0 ms is a plain cut (no effect requested)
  Short: { drive: `m.setValue(document.querySelector(".tr-modal .tr-row input.num"), 20, "duration");`,
    saved: (s) => s?.transitionDurationMs === 20, want: (e) => e.effect_id != null && e.duration_ms === 20, what: "a 20 ms effect" },
  Zero: { drive: `m.setValue(document.querySelector(".tr-modal .tr-row input.num"), 0, "duration");`,
    saved: (s) => s?.transitionDurationMs === 0, want: (e) => e.effect_id == null, what: "0 ms = a cut" },
  Effect: { drive: `m.click(m.byText(".tr-modal .tr-chip", "Crosswarp"), "Crosswarp"); await m.sleep(200); m.click(m.byText(".tr-modal .tr-chip", "Fade"), "Fade");`,
    saved: (s) => JSON.stringify(s?.transitionEffectIds) === JSON.stringify(["crosswarp"]), want: (e) => e.effect_id === "crosswarp", what: "crosswarp" },
};
const fmtSw = (e) => (e ? `${TITLE(e.path)} effect ${e.effect_id} ${e.duration_ms} ms align ${e.align}` : "none");
for (const [k, tr] of Object.entries(TR)) {
  const drive = `${plOpen} ${trOpen} ${tr.drive} ${trDone} ${plClose}`;
  C[`plTr${k}`] = { states: ["pending"], async run(c) { await ui(drive); await sleep(900); },
    check(c) {
      const v = [...armedCheck(c)];
      if (!tr.saved(c.after.ps?.settings)) v.push(`playlist settings didn't take the change (${JSON.stringify({ en: c.after.ps?.settings?.transitionEnabled, ms: c.after.ps?.settings?.transitionDurationMs, ids: c.after.ps?.settings?.transitionEffectIds })})`);
      // the armed switch's request (its latest scheduled event)
      const [armed] = (c.after.st.transitions || []).filter((t) => t.phase === "waiting_start");
      const req = armed && [...events].reverse().find((e) => e.event === "transition.scheduled" && e.corr === armed.corr);
      if (armed && !(req && tr.want(req))) v.push(`the armed switch still runs ${fmtSw(req)}, the playlist now says ${tr.what}`);
      return v;
    } };
  C[`seq:plTr${k}+next`] = { states: PL_STATES, switch: true, async run(c) { await ui(drive); await sleep(700); await cliStep(c, "next-wallpaper"); },
    check(c) {
      const v = [...stayed(c, "next-wallpaper")];
      const e = lastSwitch(c);
      if (!e || !tr.want(e)) v.push(`the next switch ran ${fmtSw(e)}, the playlist says ${tr.what}`);
      if (!tr.saved(c.after.ps?.settings)) v.push("playlist settings didn't take the change");
      return v;
    } };
}

// --- two controls in a row that share state
// an item's slider dragged (its override), then next: the override stays on its item, the next item plays at its own
for (const [kind, idx, field, from, to] of [["Spd", 1, "speedOverride", 1.0, 2.2], ["Vol", 0, "volumeOverride", 80, 25]]) for (const t of ["shown", "other"]) {
  if (kind === "Vol" && t === "shown") continue;
  C[`seq:item${kind}Drag+next:${t}`] = { states: t === "shown" ? ["single", ...PL_STATES] : PL_STATES, switch: true, async run(c) {
      c.target = pick(c, t); if (!c.target) return c.skip = "no target";
      await ui(`await m.cardMenu(${JSON.stringify(TITLE(c.target))}, "Settings (volume / speed)"); await m.sleep(500); await m.drag(m.modalRange(${idx}), ${from}, ${to}, 20, 40, "slider"); await m.sleep(400); m.closeModal();`);
      await sleep(900);
      await cliStep(c, "next-wallpaper");
    }, check(c) {
      const ov = (c.after.lib || []).find((i) => i.videoPath === c.target)?.[field];
      return [...stayed(c, "next-wallpaper"), ...(ov === to ? [] : [`${TITLE(c.target)} ${field} ${ov}, expected ${to}`])];
    } };
}
// pause (keybind), then play from a strip item: a new session — it resumes and switches with the transition
C["seq:pause+stripClick"] = { states: PL_STATES, switch: true, async run(c) {
    await cliStep(c, "toggle-pause"); await sleep(300);
    for (const k of [K[2], K[1], K[0], K[3]]) if (k !== c.before.cur?.path && (await stripHas(c, k))) { c.target = k; break; }
    await ui(`m.click(m.strip(${JSON.stringify(TITLE(c.target))}), "strip item");`);
  }, exp: { paused: false }, check: (c) => [...expectShown(c, c.target, { effect: true }), ...psKept(c)] };
// mute (keybind), then next: B comes up muted too
C["seq:mute+next"] = { states: ["single", ...PL_STATES], switch: true, async run(c) {
    await cliStep(c, "toggle-mute"); await sleep(300); await cliStep(c, "next-wallpaper");
  }, exp: { muted: true }, check: (c) => stayed(c, "next-wallpaper") };
// a global setting changed (Settings page), then next: B takes the new global (the other live item keeps its override)
for (const [name, key, value, drive] of [["volume", "volume", 55, `m.setValue(m.input("Volume"), 55, "Volume");`],
  ["speed", "speed", 1.5, `m.setValue(m.input("Speed"), 1.5, "Speed");`], ["noAudio", "noAudio", true, `m.setCheck(m.input("Mute audio"), true, "Mute audio");`]]) {
  C[`seq:set:${name}+next`] = { states: name === "noAudio" ? ["playlist", "effect"] : ["single", ...PL_STATES], switch: true,
    async pre(c) { if (c.other) await post("/library/volume", { path: c.other, intValue: 30 }); },
    async run(c) { await ui(`m.tab("Settings"); await m.sleep(500); ${drive}`); await sleep(900); await cliStep(c, "next-wallpaper"); },
    check: (c) => [...stayed(c, "next-wallpaper"), ...(JSON.stringify(c.after.s[key]) === JSON.stringify(value) ? [] : [`settings.${key} = ${JSON.stringify(c.after.s[key])}, expected ${JSON.stringify(value)}`])] };
}
// next twice quickly (two keybinds back to back): both count — two steps along the strip (a lost one = one step)
C["seq:next+next"] = { states: ["single", ...PL_STATES, "paused"], switch: true, async run(c) {
    c.wasPaused = !!c.exp.paused; if (c.wasPaused) c.exp.paused = false;
    await cliStep(c, "next-wallpaper"); await cliStep(c, "next-wallpaper");
  }, check(c) {
    const v = [];
    const cur = c.before.cur?.path;
    if (c.playlist || c.pending) { const s = c.before.ps?.videoPaths || []; const want = succ(s, succ(s, cur));
      if (!c.noOutput && c.after.cur?.path !== want) v.push(`two nexts from ${TITLE(cur)}: /current ${TITLE(c.after.cur?.path)}, expected ${TITLE(want)} (strip ${JSON.stringify(s.map(TITLE))})`); }
    else if (c.after.cur?.path === cur) v.push(`two nexts stayed on ${TITLE(cur)}`);
    const n = switchesTo(c).length; if (n > 3) v.push(`${n} switches requested (storm?)`);
    return v;
  } };
// next then previous: back where it was
C["seq:next+prev"] = { states: PL_STATES, switch: true, async run(c) { await cliStep(c, "next-wallpaper"); await sleep(250); await cliStep(c, "previous-wallpaper"); },
  check: (c) => (c.after.cur?.path === c.before.cur?.path ? [] : [`next then previous from ${TITLE(c.before.cur?.path)} landed on ${TITLE(c.after.cur?.path)}`]) };
// the modal's speed slider dragged, the modal closed, reopened: it shows what was set, the source still runs it, and
// reopening/closing it again sends nothing stale
C["seq:previewDrag+reopen"] = { states: ["single", "playlist", "effect"], async run(c) {
    c.target = c.shown;
    const open = `await m.cardMenu(${JSON.stringify(TITLE(c.target))}, "Settings (volume / speed)"); await m.sleep(600);`;
    await ui(`${open} await m.drag(m.modalRange(1), 1.0, 1.8, 20, 40, "slider"); await m.sleep(400); m.closeModal();`);
    await sleep(1000);
    c.reqAt = await js(`window.__mxReq.length`);
    c.shownValue = await ui(`${open} return m.modalRange(1)?.value;`);
    await sleep(300); await ui(`m.closeModal();`); await sleep(900);
    c.lateBodies = await js(`window.__mxReq.slice(${c.reqAt})`);
  }, check(c) {
    const v = [];
    if (String(c.shownValue) !== "1.8") v.push(`reopened, the speed slider shows ${c.shownValue}, expected 1.8`);
    const ov = (c.after.lib || []).find((i) => i.videoPath === c.target)?.speedOverride;
    if (ov !== 1.8) v.push(`${TITLE(c.target)} speedOverride ${ov}, expected 1.8`);
    for (const b of c.lateBodies || []) { let j = null; try { j = JSON.parse(b); } catch {} if (j && j.speed !== undefined && j.speed !== 1.8) v.push(`reopening sent a preview of speed ${j.speed}`); }
    return v;
  } };

// The UI saves its whole settings on every change while the backend reads them (every request, the tick, the
// adapter): a read that lands mid-save must still see the settings — never the C# defaults (NoAudio on,
// volume 100, the legacy engine; /settings itself then saved those over everything, Steam tokens included).
C["race:settingsSaveLoad"] = { states: ["idle"], async run(c) {
    const s = await getSettings(); c.want = { volume: s.volume, noAudio: s.noAudio, playerEngine: s.playerEngine };
    let bad = 0, n = 0, first = null;
    const writers = Array.from({ length: 3 }, async () => { for (let i = 0; i < 25; i++) await post("/settings", s); });
    const readers = Array.from({ length: 3 }, async () => { for (let i = 0; i < 80; i++) { const g = await getSettings(); n++;
      if (!g || g.volume !== s.volume || g.noAudio !== s.noAudio || g.playerEngine !== s.playerEngine) { bad++; first ??= g && { volume: g.volume, noAudio: g.noAudio, playerEngine: g.playerEngine }; } } });
    await Promise.all([...writers, ...readers]);
    c.race = { bad, n, first };
  }, check: (c) => [...(c.race.bad ? [`${c.race.bad}/${c.race.n} reads of /settings during saves were not the settings: ${JSON.stringify(c.race.first)}, saved ${JSON.stringify(c.want)}`] : []),
    ...(c.after.s.playerEngine !== c.want.playerEngine || c.after.s.volume !== c.want.volume ? [`after the saves: engine ${c.after.s.playerEngine} volume ${c.after.s.volume}`] : [])] };

// The same race for the other shared state files: the current playlist (playlist_state.json — the strip saves it on
// every edit; the UI's init, the tick's transition config and /settings read it) and a library index (index.json —
// every override / loudness write rewrites it; every switch, /settings and /library read it). A read mid-save must
// still see the file: a null playlist gave the UI an empty strip + the DEFAULT playlist settings (its next save
// wrote those over the real ones), an empty index made every override read "follows the global".
C["race:playlistSaveLoad"] = { states: ["idle"], async run(c) {
    const pl = { videoPaths: [K[0], K[1], K[2]], settings: PS({ advanceOnVideoEnd: true, intervalSeconds: 321 }), name: null };
    let bad = 0, n = 0, first = null;
    await post("/playlist/state", pl); // the saves below write what's already there: any other read is a torn one
    const writers = Array.from({ length: 3 }, async () => { for (let i = 0; i < 25; i++) await post("/playlist/state", pl); });
    const readers = Array.from({ length: 3 }, async () => { for (let i = 0; i < 80; i++) { const g = (await http("GET", "/playlist/state")).json; n++;
      if (!g || g.videoPaths?.length !== 3 || g.settings?.intervalSeconds !== 321 || g.settings?.advanceOnVideoEnd !== true) { bad++; first ??= g ? { n: g.videoPaths?.length, iv: g.settings?.intervalSeconds } : "null"; } } });
    await Promise.all([...writers, ...readers]);
    c.race = { bad, n, first };
  }, check: (c) => (c.race.bad ? [`${c.race.bad}/${c.race.n} reads of /playlist/state during saves were not the playlist: ${JSON.stringify(c.race.first)}`] : []) };
C["race:indexSaveLoad"] = { states: ["idle"],
  async pre() { await post("/library/volume", { path: K[0], intValue: 30 }); await post("/library/speed", { path: K[1], doubleValue: 0.8 }); },
  async run(c) {
    let bad = 0, n = 0, first = null;
    const writers = Array.from({ length: 3 }, async (_, w) => { for (let i = 0; i < 40; i++) await post("/library/volume", { path: K[2], intValue: 40 + ((i + w) % 2) }); });
    const readers = Array.from({ length: 3 }, async () => { for (let i = 0; i < 120; i++) { const lib = (await http("GET", "/library")).json || []; n++;
      const a = lib.find((x) => x.videoPath === K[0]), b = lib.find((x) => x.videoPath === K[1]);
      if (a?.volumeOverride !== 30 || b?.speedOverride !== 0.8) { bad++; first ??= { items: lib.length, k1: a?.volumeOverride ?? null, k2: b?.speedOverride ?? null }; } } });
    await Promise.all([...writers, ...readers]);
    c.race = { bad, n, first };
  }, check: (c) => (c.race.bad ? [`${c.race.bad}/${c.race.n} reads of /library during index saves lost the overrides: ${JSON.stringify(c.race.first)} (k1 volume 30, k2 speed 0.8)`] : []) };
// …and the lost update: every writer of an index must read-modify-write it under ONE lock. Trash / undo (and the WE
// sync, a direct-download reconcile) loaded the index, worked, and saved their stale copy back — over an override
// saved meanwhile (a slider released while another item is trashed: the release is gone, "follows the global").
C["race:indexLostUpdate"] = { states: ["idle"], async run(c) {
    const s = await getSettings();
    const vals = Array.from({ length: 60 }, (_, i) => 11 + i).filter((v) => v !== s.volume).slice(0, 40);
    const item = ((await http("GET", "/library")).json || []).find((x) => x.videoPath === K[3]);
    let lost = 0, first = null, cycles = 0;
    const writer = (async () => { for (const v of vals) {
      await post("/library/volume", { path: K[0], intValue: v });
      const got = ((await http("GET", "/library")).json || []).find((x) => x.videoPath === K[0])?.volumeOverride;
      if (got !== v) { lost++; first ??= { wrote: v, read: got ?? null }; } } })();
    const trasher = (async () => { for (let i = 0; i < 15 && item; i++) { await post("/library/trash", { items: [item] }); await post("/library/undo"); cycles++; } })();
    await Promise.all([writer, trasher]);
    await sleep(200);
    const fin = ((await http("GET", "/library")).json || []).find((x) => x.videoPath === K[0])?.volumeOverride;
    c.race = { lost, first, n: vals.length, cycles, last: vals.at(-1), fin: fin ?? null, item: !!item };
  }, check: (c) => [
    ...(!c.race.item ? ["k4 not in the library — nothing to trash"] : []),
    ...(c.race.lost ? [`${c.race.lost}/${c.race.n} k1 volume saves were gone right after (trash/undo of k4 ×${c.race.cycles} saved a stale index over them): first ${JSON.stringify(c.race.first)}`] : []),
    ...(c.race.fin !== c.race.last ? [`k1's override ends at ${c.race.fin}, the last save was ${c.race.last}`] : [])] };

// A volume save that lands AFTER its item was trashed (the modal's persist fires 250 ms after release; a volume key in
// "item" mode): it must not create an index entry for the gone item (a ghost a later download with that key
// inherits), and Undo brings the item back with what it had when it was trashed.
C["race:saveAfterTrash"] = { states: ["idle"],
  async pre() { await post("/library/volume", { path: K[3], intValue: 30 }); },
  async run(c) {
    const item = ((await http("GET", "/library")).json || []).find((x) => x.videoPath === K[3]);
    await post("/library/trash", { items: [item] });
    await post("/library/volume", { path: K[3], intValue: 55 }); // the late persist
    c.ghost = readIndex()[keyOf(K[3])] ?? null;
    await post("/library/undo"); await sleep(200);
    c.back = ((await http("GET", "/library")).json || []).find((x) => x.videoPath === K[3]) ?? null;
  }, check: (c) => [
    ...(c.ghost ? [`a save after the trash wrote an index entry for the trashed k4: ${JSON.stringify(c.ghost)}`] : []),
    ...(!c.back ? ["k4 not back after Undo"] : c.back.volumeOverride !== 30 ? [`k4 back with volume ${c.back.volumeOverride}, it was trashed at 30`] : [])] };

// POST /playlist/state with only some keys (a script, an agent): the rest of the saved playlist stays — like /settings
// (a body of just the paths reset its rotation + transitions to the C# defaults); a nested `settings` merges by key
C["plState:partial"] = { states: ["idle"], async run(c) {
    await post("/playlist/state", { videoPaths: [K[0], K[1], K[2]], settings: PS({ advanceOnVideoEnd: true, intervalSeconds: 321 }), name: null });
    await post("/playlist/state", { videoPaths: [K[1], K[0]] });
    c.a = (await http("GET", "/playlist/state")).json;
    await post("/playlist/state", { settings: { intervalSeconds: 77 } });
    c.b = (await http("GET", "/playlist/state")).json;
    await sleep(400); // the page follows another client's edit (WS playlist-changed → re-read); the shared strip check sees it
  }, check(c) {
    const v = [], a = c.a?.settings, b = c.b?.settings;
    if (JSON.stringify(c.a?.videoPaths) !== JSON.stringify([K[1], K[0]])) v.push(`paths-only body: paths ${JSON.stringify(c.a?.videoPaths?.map(TITLE))}`);
    if (!(a?.intervalSeconds === 321 && a?.advanceOnVideoEnd === true && a?.transitionDurationMs === PS().transitionDurationMs)) v.push(`paths-only body reset the playlist settings: ${JSON.stringify({ iv: a?.intervalSeconds, adv: a?.advanceOnVideoEnd, ms: a?.transitionDurationMs })}`);
    if (!(b?.intervalSeconds === 77 && b?.advanceOnVideoEnd === true && JSON.stringify(c.b?.videoPaths) === JSON.stringify([K[1], K[0]]))) v.push(`a settings-only body lost the rest: ${JSON.stringify({ iv: b?.intervalSeconds, adv: b?.advanceOnVideoEnd, n: c.b?.videoPaths?.length })}`);
    return v;
  } };

// A switch that FAILS (a file mpv can't play): A stays on screen, but every client was told B when it was requested
// (wallpaper-changed) — the UI went on marking a wallpaper playing that never showed. The shared checks compare the
// UI's playing mark and the screen with /current.
C["apply:broken"] = { states: ["single", "paused"], expectFail: true, exp: { paused: false } /* an apply is a new session */, async run(c) {
    const dir = path.join(path.dirname(path.dirname(K[0])), "kbroken"), bad = path.join(dir, "kbroken.mp4");
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(bad, Buffer.alloc(256 * 1024, 0x5a)); // not a video
    const t0 = Date.now();
    await post("/apply", { path: bad });
    c.failed = await waitFor(() => events.some((e) => e._t >= t0 && e.event === "transition.failed"), 15000, 100);
    await sleep(400);
    try { fs.unlinkSync(bad); fs.rmdirSync(dir); } catch {}
  }, check: (c) => c.failed ? [] : ["the switch to the broken file never failed (the cell tests a FAILED switch)"] };

// A /settings change landing while an apply runs: /apply (and random, next, a playlist play) loaded the settings, ran the
// switch, then saved that whole copy back for its LastSession — reverting whatever /settings saved in between. Also 8
// switches in ~300 ms with every /settings's live sets landing on the opening B's: the last B's only (paused) frame went
// unrendered past mpv's 200 ms VO flip timeout and was dropped — "no first frame within 10 s" (sources/mpv.rs REFETCH_AFTER)
C["race:settingsDuringApply"] = { states: ["idle", "single"], switch: true, async run(c) {
    c.lost = [];
    for (let i = 0; i < 8; i++) {
      const want = i % 2 === 0;
      await Promise.all([post("/apply", { path: K[i % 3] }), (async () => { await sleep([10, 40, 80][i % 3]); await post("/settings", { resumeFromLast: want }); })()]);
      const got = (await getSettings()).resumeFromLast;
      if (got !== want) c.lost.push(`#${i} resumeFromLast ${got}, posted ${want}`);
    }
    c.target = K[7 % 3];
  }, check: (c) => c.lost.length ? [`${c.lost.length}/8 settings saves reverted by an apply: ${c.lost.join("; ")}`] : [] };

// --- the global Settings page's Rotation section + transition method, with an aligned switch armed: a playlist
// that follows the globals (pendingGlobal) takes the change in its armed switch; one with its own override
// (pending) keeps its own (a global change never clobbers an override)
const armedReq = (c) => { const [a] = (c.after.st.transitions || []).filter((t) => t.phase === "waiting_start");
  return a && [...events].reverse().find((e) => e.event === "transition.scheduled" && e.corr === a.corr); };
const gTrDrive = (k) => `m.tab("Settings"); await m.sleep(600); m.click(m.row("Transitions")?.querySelector(".sctl button"), "global transitions");
  await m.sleep(600); for (let i = 0; i < 30 && !document.querySelector(".tr-modal .tr-chip"); i++) await m.sleep(100);
  ${TR[k].drive} await m.sleep(300); m.click(document.querySelector(".tr-modal .tr-done"), "Done");`;
const G_SAVED = { Off: (s) => s.globalTransitionEnabled === false, Duration: (s) => s.globalTransitionDurationMs === 1200,
  Effect: (s) => JSON.stringify(s.globalTransitionEffectIds) === JSON.stringify(["crosswarp"]),
  Short: (s) => s.globalTransitionDurationMs === 20, Zero: (s) => s.globalTransitionDurationMs === 0 };
for (const k of Object.keys(TR)) C[`gTr${k}`] = { states: ["pending", "pendingGlobal"], rearms: true, async run(c) { await ui(gTrDrive(k)); await sleep(1200); },
  check(c) {
    const v = [...armedCheck(c)];
    if (!G_SAVED[k](c.after.s)) v.push(`the global transition setting didn't take the change`);
    const req = armedReq(c);
    if (c.state === "pendingGlobal" && !(req && TR[k].want(req))) v.push(`the armed switch still runs ${fmtSw(req)}, the globals now say ${TR[k].what}`);
    if (c.state === "pending" && !(req && req.effect_id === "fade" && req.duration_ms === 600)) v.push(`a global change reached the playlist's own transition: the armed switch runs ${fmtSw(req)} (its playlist: fade 600 ms)`);
    return v;
  } };
C["gMethodFrozen"] = { states: ["pending", "pendingGlobal"], rearms: true, async run(c) { await ui(`m.tab("Settings"); await m.sleep(600); await m.select("Transition method", "Frozen");`); await sleep(1200); },
  check(c) { const v = [...armedCheck(c)]; const req = armedReq(c);
    if (c.after.s.transitionMethod !== "frozen") v.push(`transitionMethod ${c.after.s.transitionMethod}`);
    if (!(req && req.method === "frozen")) v.push(`the armed switch still runs method ${req?.method}, the setting says frozen`); return v; } };
C["gAdvanceOff"] = { states: ["pending", "pendingGlobal"], rearms: true, async run(c) { await ui(`m.tab("Settings"); await m.sleep(600); m.setCheck(m.input("Switch when video ends"), false, "advance");`); await sleep(1200); },
  check(c) { const v = c.after.s.globalAdvanceOnVideoEnd === false ? [] : ["globalAdvanceOnVideoEnd not saved off"];
    // following the globals: nothing stays armed; with its own override: the playlist still advances at A's end
    return [...v, ...armedCheck(c, c.state === "pendingGlobal" ? null : undefined)]; } };

// --- the global interval (Settings → Rotation) → 8 s: a timed playlist that follows the globals switches within it;
// one with its own interval (playlist: 600 s) doesn't
C["gInterval8s"] = { states: ["playlist", "playlistGlobal"], rearms: true, async run(c) {
    await ui(`m.tab("Settings"); await m.sleep(600); const iv = m.row("Switch every").querySelectorAll(".hms input");
      m.setValue(iv[2], 8, "s"); await m.sleep(300); m.setValue(iv[1], 0, "m");`);
    c.tChange = Date.now();
    c.sw = await waitFor(async () => events.some((e) => e._t >= c.tChange && e.event === "transition.scheduled"), 11000, 100);
    await sleep(300); await waitSettled(8000);
  }, check(c) {
    const v = c.after.s.globalIntervalSeconds === 8 ? [] : [`globalIntervalSeconds ${c.after.s.globalIntervalSeconds}, expected 8`];
    if (c.state === "playlistGlobal" && !c.sw) v.push("following the globals, no switch within 11 s of an 8 s global interval");
    if (c.state === "playlist" && c.sw) v.push("a global interval change switched a playlist that has its own (600 s)");
    return v;
  } };

// --- multi-select (Ctrl+click cards): a card action on a selected card applies to the whole selection
const ctrlClick = (p) => `m.card(${JSON.stringify(TITLE(p))})?.querySelector(".thumb-wrap").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })); await m.sleep(150);`;
// what plays after trashing the set `ps`: what was on screen (or incoming) trashed → a playlist plays on from the
// next strip item after it that survives, a single item stops; else nothing switches
function afterTrashMany(c, ps) {
  const del = new Set(ps), v = [];
  for (const p of ps) v.push(...notTargeted(c, p, { gone: true }));
  const was = c.before.cur?.path, now = c.after.cur?.path, strip = c.before.ps?.videoPaths || [];
  if (del.has(now)) v.push(`trashed ${TITLE(now)} still on screen`);
  if (c.noOutput) return v;
  let want = was;
  if (del.has(was)) { const i = strip.indexOf(was); want = c.playlist && i >= 0 ? [...strip.slice(i + 1), ...strip.slice(0, i)].find((p) => !del.has(p)) ?? null : null; }
  if ((now ?? null) !== (want ?? null)) v.push(`after trashing ${ps.map(TITLE)}: /current ${TITLE(now)}, expected ${TITLE(want)}`);
  return v;
}
const SEL_STATES = ["single", ...PL_STATES];
C["selTrash:shown+other"] = { states: SEL_STATES, switch: true, async run(c) {
    c.targets = [c.shown, c.other].filter(Boolean); if (c.before.cur?.path && c.targets.includes(c.before.cur.path)) c.exp.paused = false;
    await ui(`${c.targets.map(ctrlClick).join(" ")} m.click(m.card(${JSON.stringify(TITLE(c.targets[0]))})?.querySelector(".del"), "trash");`); await sleep(900);
  }, check: (c) => [...afterTrashMany(c, c.targets), ...armedCheck(c)] };
C["selTrashUndo:shown+other"] = { states: SEL_STATES, switch: true, async run(c) {
    c.targets = [c.shown, c.other].filter(Boolean); if (c.before.cur?.path && c.targets.includes(c.before.cur.path)) c.exp.paused = false;
    c.idx = c.targets.map((p) => (c.before.ps?.videoPaths || []).indexOf(p));
    await ui(`${c.targets.map(ctrlClick).join(" ")} m.click(m.card(${JSON.stringify(TITLE(c.targets[0]))})?.querySelector(".del"), "trash"); await m.sleep(900);
      m.click(m.byText(".topbar button", "Undo"), "Undo");`); await sleep(900);
  }, check(c) {
    const v = [];
    c.targets.forEach((p, k) => {
      if (!(c.after.lib || []).some((i) => i.videoPath === p)) v.push(`${TITLE(p)} not back in the library`);
      const at = (c.after.ps?.videoPaths || []).indexOf(p); if (c.idx[k] >= 0 && at !== c.idx[k]) v.push(`${TITLE(p)} back at playlist index ${at}, was ${c.idx[k]}`);
    });
    return [...v, ...armedCheck(c)];
  } };
// toggle on a selected card: adds the whole selection when that card isn't in the playlist, removes it when it is
C["selToggle:add"] = { states: PL_STATES, rearms: true, async run(c) {
    const strip = c.before.ps?.videoPaths || []; c.add = K.find((p) => !strip.includes(p)); c.also = c.shown;
    await ui(`${[c.add, c.also].map(ctrlClick).join(" ")} m.click(m.card(${JSON.stringify(TITLE(c.add))})?.querySelector(".pl-toggle"), "toggle");`); await sleep(900);
  }, check(c) {
    const want = [...(c.before.ps?.videoPaths || []), c.add].map(TITLE), got = (c.after.ps?.videoPaths || []).map(TITLE);
    return [...(JSON.stringify(got) === JSON.stringify(want) ? [] : [`playlist ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`]), ...noSwitchNow(c), ...keptShown(c), ...armedCheck(c)];
  } };
C["selToggle:remove"] = { states: PL_STATES, rearms: true, async run(c) {
    const strip = c.before.ps?.videoPaths || []; c.out = K.find((p) => !strip.includes(p)); c.target = c.other;
    await ui(`${[c.out, c.target].map(ctrlClick).join(" ")} m.click(m.card(${JSON.stringify(TITLE(c.target))})?.querySelector(".pl-toggle"), "toggle");`); await sleep(900);
  }, check(c) {
    const want = (c.before.ps?.videoPaths || []).filter((p) => p !== c.target).map(TITLE), got = (c.after.ps?.videoPaths || []).map(TITLE);
    return [...(JSON.stringify(got) === JSON.stringify(want) ? [] : [`playlist ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`]), ...afterRemove(c)];
  } };
// the settings modal opened from a selected card edits every selected item: both live sides (A and B / the pending B)
C["selVol:shown+other"] = { states: ["effect", "pending"], async run(c) {
    c.targets = [c.shown, c.other];
    await ui(`${c.targets.map(ctrlClick).join(" ")} await m.cardMenu(${JSON.stringify(TITLE(c.shown))}, "Settings (volume / speed)"); await m.sleep(600); m.setValue(m.modalRange(0), 33, "volume");`);
    await sleep(170); c.during = await snapshot(); await sleep(600); await ui(`m.closeModal();`); await sleep(500);
  }, check(c) {
    const v = [];
    for (const p of c.targets) {
      const ov = (c.after.lib || []).find((i) => i.videoPath === p)?.volumeOverride; if (ov !== 33) v.push(`${TITLE(p)} volumeOverride ${ov}, expected 33`);
      for (const [id, n] of srcFor(c.during, p)) if (!near(n.gain?.user ?? 0, VolumeDb(33))) v.push(`the drag didn't reach ${id}(${TITLE(p)}): ${n.gain?.user}`);
    }
    return v;
  } };
// keys pressed while a slider is HELD (owner: "make F not do yellow outline when holding slider"): a real mouse
// press on the item modal's volume slider (two library cards selected), then F, Delete, Escape and an arrow key
// while it's held. Nothing may react — no focus ring / outline on the held slider (Chromium flips a mouse-focused
// control to keyboard focus on any key: the system ring), the selection isn't trashed, the modal stays open, the
// value doesn't step — and after the release the slider shows no keyboard-focus ring either
C["keys:sliderHeld"] = { states: ["idle", "single"], noSwitch: true, async run(c) {
    c.targets = [K[2], K[3]];
    await ui(`${c.targets.map(ctrlClick).join(" ")} await m.cardMenu(${JSON.stringify(TITLE(K[2]))}, "Settings (volume / speed)"); await m.sleep(1400);`); // landed (the open flies 900 ms): a real press hit-tests
    const r = await ui(`const s = m.modalRange(0); if (!s) throw new Error("no volume slider"); const b = s.getBoundingClientRect(); return { x: Math.round(b.x + b.width * 0.3), y: Math.round(b.y + b.height / 2), w: Math.round(b.width) };`);
    const send = (e) => win.webContents.sendInputEvent(e);
    send({ type: "mouseMove", x: r.x, y: r.y }); await sleep(60);
    send({ type: "mouseDown", x: r.x, y: r.y, button: "left", clickCount: 1 }); await sleep(80);
    send({ type: "mouseMove", x: r.x + 20, y: r.y, button: "left", modifiers: ["leftButtonDown"] }); await sleep(120);
    const look = `const s = m.modalRange(0); const cs = s ? getComputedStyle(s) : null;
      return { open: !!document.querySelector(".lib-settings"), value: s?.value, focusVisible: !!s?.matches(":focus-visible"),
        outline: cs ? cs.outlineStyle + " " + cs.outlineWidth : null, filter: cs?.filter ?? null };`;
    c.held0 = await ui(look);
    for (const k of ["f", "F", "Delete", "Escape", "Right"]) {
      send({ type: "keyDown", keyCode: k }); if (k.length === 1) send({ type: "char", keyCode: k }); await sleep(40); send({ type: "keyUp", keyCode: k }); await sleep(120);
    }
    c.held = await ui(look);
    send({ type: "mouseUp", x: r.x + 20, y: r.y, button: "left", clickCount: 1 }); await sleep(300);
    c.released = await ui(look);
    await ui(`if (document.querySelector(".modal-backdrop")) m.closeModal();`); await sleep(900);
  }, check(c) {
    const v = [];
    if (!c.held.open || !c.released.open) v.push("the modal closed while the slider was held (Escape went through)");
    if (c.held.outline && !/^none /.test(c.held.outline) && !/ 0px$/.test(c.held.outline)) v.push(`the held slider shows an outline after a key: ${c.held.outline}`);
    if (c.held.filter && c.held.filter !== "none") v.push(`the held slider glows after a key: ${c.held.filter}`);
    if (c.held.value !== c.held0.value) v.push(`a key stepped the held slider: ${c.held0.value} → ${c.held.value}`);
    if (c.released.focusVisible) v.push(`after the release the slider still has keyboard focus (${c.released.outline}, ${c.released.filter})`);
    for (const p of c.targets) if (!(c.after.lib || []).some((i) => i.videoPath === p)) v.push(`${TITLE(p)} was trashed by Delete while the slider was held`);
    return v;
  } };
// the card's own toggle (one item): take what plays out of the playlist / put another one in
C["cardToggle:shown"] = { states: PL_STATES, rearms: true, async run(c) { c.target = c.shown;
    await ui(`m.click(m.card(${JSON.stringify(TITLE(c.target))})?.querySelector(".pl-toggle"), "toggle");`); await sleep(900); }, check: afterRemove };
C["cardToggle:add"] = { states: PL_STATES, rearms: true, async run(c) { const strip = c.before.ps?.videoPaths || []; c.add = K.find((p) => !strip.includes(p));
    await ui(`m.click(m.card(${JSON.stringify(TITLE(c.add))})?.querySelector(".pl-toggle"), "toggle");`); await sleep(900); },
  check(c) { const got = (c.after.ps?.videoPaths || []).map(TITLE), want = [...(c.before.ps?.videoPaths || []), c.add].map(TITLE);
    return [...(JSON.stringify(got) === JSON.stringify(want) ? [] : [`playlist ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`]), ...noSwitchNow(c), ...keptShown(c), ...armedCheck(c)]; } };
// a saved playlist overwritten (Save → click its name → Save): loading it gives the current strip
C["plSaveOverwrite"] = { states: ["playlist"], noSwitch: true,
  async pre() { await post("/playlist/save", { name: "mx-over", playlist: { videoPaths: [K[1]], settings: PS(), name: "mx-over" } }); },
  async run(c) {
    await ui(`m.click(document.querySelector('button[title="Save playlist"]'), "save"); await m.sleep(500);
      m.click(m.byText(".pl-modal .pl-name", "mx-over"), "mx-over"); await m.sleep(150); m.click(m.byText(".pl-modal button", "Save"), "Save");`);
    await sleep(900); c.saved = (await post("/playlist/load", { name: "mx-over" })).json;
  }, check(c) { const a = (c.saved?.videoPaths || []).map(TITLE), b = (c.before.ps?.videoPaths || []).map(TITLE);
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [`mx-over holds ${JSON.stringify(a)} after overwriting, the strip was ${JSON.stringify(b)}`]; } };

// --- the same switch control twice quickly: the second one wins, no storm
C["seq:cardApply×2"] = { states: ["single", "playlist", "effect"], switch: true, async run(c) {
    const [a, b] = [K[2], K[3]].map((p) => (p === c.before.cur?.path ? K[1] : p)); c.target = b;
    await ui(`m.click(m.card(${JSON.stringify(TITLE(a))})?.querySelector(".thumb-wrap"), "card"); await m.sleep(120); m.click(m.card(${JSON.stringify(TITLE(b))})?.querySelector(".thumb-wrap"), "card");`);
  }, check: (c) => expectShown(c, c.target, { effect: true }) };
C["seq:stripClick×2"] = { states: PL_STATES, switch: true, async run(c) {
    const strip = c.before.ps?.videoPaths || []; const others = strip.filter((p) => p !== c.before.cur?.path);
    if (others.length < 2) return c.skip = "needs two other strip items"; c.target = others[1];
    await ui(`m.click(m.strip(${JSON.stringify(TITLE(others[0]))}), "strip"); await m.sleep(120); m.click(m.strip(${JSON.stringify(TITLE(others[1]))}), "strip");`);
  }, check: (c) => [...expectShown(c, c.target, { effect: true }), ...psKept(c)] };
// two trashes, two undos: both back where they were (the undo stack runs newest first)
C["seq:trash×2+undo×2"] = { states: ["playlist", "pending"], switch: true, async run(c) {
    c.targets = [c.other, c.shown]; c.exp.paused = false;
    c.idx = c.targets.map((p) => (c.before.ps?.videoPaths || []).indexOf(p));
    for (const p of c.targets) { await ui(`m.click(m.card(${JSON.stringify(TITLE(p))})?.querySelector(".del"), "trash");`); await sleep(900); }
    for (let i = 0; i < 2; i++) { await ui(`m.click(m.byText(".topbar button", "Undo"), "Undo");`); await sleep(900); }
  }, check(c) {
    const v = [];
    c.targets.forEach((p, k) => {
      if (!(c.after.lib || []).some((i) => i.videoPath === p)) v.push(`${TITLE(p)} not back in the library`);
      const at = (c.after.ps?.videoPaths || []).indexOf(p); if (c.idx[k] >= 0 && at !== c.idx[k]) v.push(`${TITLE(p)} back at playlist index ${at}, was ${c.idx[k]}`);
    });
    return [...v, ...armedCheck(c)];
  } };
// paused, then the playlist's interval → 8 s: the rotation holds while paused (the picture is frozen; a switch now
// would unfreeze it or cut on a paused clock) — and switches once resumed
C["seq:pause+plInterval"] = { states: ["playlist"], rearms: true, async run(c) {
    await cliStep(c, "toggle-pause"); await sleep(300);
    await ui(`${plOpen} m.setValue(${hms(2)}, 8, "s"); await m.sleep(300); m.setValue(${hms(1)}, 0, "m"); ${plClose}`);
    const t = Date.now(); await sleep(11000);
    c.whilePaused = events.filter((e) => e._t >= t - 1500 && e.event === "transition.scheduled").map((e) => TITLE(e.path));
    c.pausedAfter = !!(await ctl.call("state")).graph.player?.paused;
    await cliStep(c, "toggle-pause"); const t2 = Date.now();
    c.sw = await waitFor(async () => events.some((e) => e._t >= t2 && e.event === "transition.scheduled"), 11000, 100);
    await sleep(300); await waitSettled(8000);
  }, check(c) {
    const v = [];
    if (c.whilePaused.length) v.push(`the rotation switched while paused (to ${c.whilePaused})`);
    if (!c.pausedAfter) v.push("not paused any more 11 s after pausing");
    if (!c.sw) v.push("no switch within 11 s of resuming (the 8 s interval had passed)");
    return v;
  } };

// --- keyboard selection: Ctrl+click + Shift+click a range, then the Delete key; Ctrl+A, Delete, then Undo
const key = (k, mods = {}) => `window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} })); await m.sleep(150);`;
C["selRange+Delete"] = { states: SEL_STATES, switch: true, async run(c) {
    const order = await ui(`return [...document.querySelectorAll(".card.lib")].map((e) => e.querySelector(".lib-title")?.title);`);
    const i = order.indexOf(TITLE(c.shown)); const j = i + 1 < order.length ? i + 1 : i - 1;
    c.targets = [c.shown, [...K, ...SC].find((p) => TITLE(p) === order[j])]; c.exp.paused = false; // the neighbour may be a scene card
    const shift = `m.card(${JSON.stringify(order[j])})?.querySelector(".thumb-wrap").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true })); await m.sleep(150);`;
    await ui(`${ctrlClick(c.shown)} ${shift} ${key("Delete")}`); await sleep(900);
  }, check: (c) => [...afterTrashMany(c, c.targets), ...armedCheck(c)] };
C["selAll+Delete+undo"] = { states: ["playlist", "pending"], switch: true, async run(c) {
    c.exp.paused = false; c.strip = c.before.ps?.videoPaths || [];
    await ui(`${key("a", { ctrlKey: true })} ${key("Delete")}`); await sleep(1200);
    c.midState = { lib: ((await http("GET", "/library")).json || []).length, cur: (await http("GET", "/current")).json?.path ?? null };
    await ui(`m.click(m.byText(".topbar button", "Undo"), "Undo");`); await sleep(1200);
  }, check(c) {
    const v = [];
    if (c.midState.lib !== 0 || c.midState.cur) v.push(`after Ctrl+A, Delete: ${c.midState.lib} library items, /current ${TITLE(c.midState.cur)}`);
    if ((c.after.lib || []).length !== (c.before.lib || []).length) v.push(`${(c.after.lib || []).length} library items after the undo, expected ${(c.before.lib || []).length} (all of them back)`); // k1–k4 + the scene items
    const got = (c.after.ps?.videoPaths || []).map(TITLE), want = c.strip.map(TITLE);
    if (JSON.stringify(got) !== JSON.stringify(want)) v.push(`playlist ${JSON.stringify(got)} after the undo, was ${JSON.stringify(want)}`);
    if (c.after.cur?.path) v.push(`${TITLE(c.after.cur.path)} plays after deleting everything + undo (the delete stopped playback)`);
    return v;
  } };

// --- the item settings modal closed with Escape the instant a drag ends (its persist is still pending): the last
// value is saved and stays live — closing must flush, never drop or revert it
for (const t of ["shown", "other"]) C[`itemVolDragEsc:${t}`] = { states: ["single", "effect", "pending"], async run(c) {
    c.target = pick(c, t); if (!c.target) return c.skip = "no target";
    await ui(`await m.cardMenu(${JSON.stringify(TITLE(c.target))}, "Settings (volume / speed)"); await m.sleep(600);
      await m.drag(m.modalRange(0), 80, 30, 10, 30, "volume"); ${key("Escape")}`);
    await sleep(1200);
    c.open = await ui(`return !!document.querySelector(".lib-settings");`);
  }, check(c) {
    const v = [];
    const ov = (c.after.lib || []).find((i) => i.videoPath === c.target)?.volumeOverride;
    if (ov !== 30) v.push(`${TITLE(c.target)} volumeOverride ${ov} after a drag to 30 closed with Escape`);
    if (c.open) v.push("the settings modal is still open 1.2 s after Escape");
    return v;
  } };

// ================================================================ round 3: the rest of the global Settings page, the
// order a shuffle plays, three or more controls in a row

// sample every source's state while a control runs (`every` ms apart; 0 = back to back)
function sampler(c, every = 40) {
  c.samples = []; let on = true;
  const run = (async () => { while (on) { try { c.samples.push({ t: Date.now(), st: await ctl.call("state") }); } catch { /* retry */ } if (every) await sleep(every); } })();
  return async () => { on = false; await run; };
}
// a switch to `want` was requested (not a cut, transitions are on) and it's on screen; at most `maxNow` user
// switches (align:now) in the cell — aligned re-arms of an advance-on-end session don't count
function expectShownN(c, want, maxNow) {
  const v = [];
  if (!c.noOutput && c.after.cur?.path !== want) v.push(`expected ${TITLE(want)} on screen, /current says ${TITLE(c.after.cur?.path)}`);
  const now = c.evs.filter((e) => e.event === "transition.scheduled" && e.align !== "end");
  const mine = now.filter((e) => e.path === want);
  if (!mine.length) v.push(`no switch to ${TITLE(want)} was requested`);
  else if (!c.noOutput && !c.cutsOk && mine[mine.length - 1].effect_id == null) v.push(`switch to ${TITLE(want)} was a cut (transitions are on)`);
  if (now.length > maxNow) v.push(`${now.length} switches requested (${now.map((e) => TITLE(e.path))}), expected ≤ ${maxNow}`);
  return v;
}
const settingsTab = (drive) => `m.tab("Settings"); await m.sleep(600); ${drive}`;
const gIntervalTo = (secs, row = "Switch every") => `const iv = m.row(${JSON.stringify(row)}).querySelectorAll(".hms input"); m.setValue(iv[2], ${secs}, "s"); await m.sleep(300); m.setValue(iv[1], 0, "m");`;

// --- Settings → Rotation (global): advance-on-end and its minimum / maximum. A timed playlist that follows the globals
// (playlistGlobal: 600 s) takes them live; one with its own rotation (playlist: 600 s, no advance) never does
// "Switch when video ends" on: the "Switch every" row becomes "Minimum play time" (same value) with "Maximum play time"
// below it and no wait toggle; a 4 s minimum → the switch is armed for A's end (align:end), never made now
const rowLabels = `[...document.querySelectorAll(".settings .srow .slabel-row")].map((r) => r.firstChild?.textContent?.trim())`;
C["gAdvanceRelabel"] = { states: ["playlist", "playlistGlobal"], rearms: true, async run(c) {
    await ui(settingsTab(`m.setCheck(m.input("Switch when video ends"), true, "advance"); await m.sleep(400);`));
    c.ui = await js(`(() => { const rows = ${rowLabels}; const v = (l) => [...(document.querySelector(".settings") && [...document.querySelectorAll(".settings .srow")].find((r) => r.querySelector(".slabel-row")?.firstChild?.textContent?.trim() === l)?.querySelectorAll(".hms input") || [])].map((x) => x.value);
      return { rows: rows.filter((r) => /^(switch every|switch when|minimum play|maximum play|wait for video|interval)/i.test(r || "")), min: v("Minimum play time"), max: v("Maximum play time") }; })()`);
    await ui(`${gIntervalTo(4, "Minimum play time")}`);
    c.armed = await waitFor(async () => armedTo(await ctl.call("state")).length > 0, 9000, 100);
    c.armedSt = await ctl.call("state");
  }, check(c) {
    const v = [];
    if (c.after.s.globalAdvanceOnVideoEnd !== true || c.after.s.globalIntervalSeconds !== 4) v.push(`globalAdvanceOnVideoEnd ${c.after.s.globalAdvanceOnVideoEnd} / globalIntervalSeconds ${c.after.s.globalIntervalSeconds}, expected true / 4`);
    if ("globalWaitForVideoEnd" in c.after.s) v.push("GET /settings still has globalWaitForVideoEnd");
    const want = ["Switch when video ends", "Minimum play time", "Maximum play time"];
    if (JSON.stringify(c.ui?.rows) !== JSON.stringify(want)) v.push(`rotation rows ${JSON.stringify(c.ui?.rows)}, expected ${JSON.stringify(want)}`);
    if (JSON.stringify(c.ui?.min) !== '["0","10","0"]') v.push(`the minimum shows ${JSON.stringify(c.ui?.min)} — expected the "Switch every" field's 600 s (0 h 10 m 0 s)`);
    const now = c.evs.filter((e) => e.event === "transition.scheduled" && e.align !== "end");
    if (now.length) v.push(`advance-on-end + a 4 s minimum switched at once (to ${now.map((e) => TITLE(e.path))})`);
    if (c.state === "playlistGlobal") {
      const a = armedTo(c.armedSt), want2 = succ(c.before.ps?.videoPaths, c.before.cur?.path);
      if (!c.armed) v.push("following the globals: a 4 s minimum on a 30 s clip, but no switch armed for its end");
      else if (a.length !== 1 || a[0] !== want2) v.push(`armed ${JSON.stringify(a.map(TITLE))}, expected one to ${TITLE(want2)}`);
    } else if (c.armed) v.push(`a global advance-on-end + minimum change armed ${JSON.stringify(armedTo(c.armedSt).map(TITLE))} on a playlist with its own rotation (600 s, no advance)`);
    return [...v, ...keptShown(c)];
  } };
// advance-on-end on: following the globals → the old 600 s interval is now the minimum (k1, 30 s, loops: nothing
// requested yet), then the minimum → 0 → one aligned switch armed to the strip's next; its own rotation → nothing
C["gAdvanceOn"] = { states: ["playlist", "playlistGlobal"], rearms: true, async run(c) {
    await ui(settingsTab(`m.setCheck(m.input("Switch when video ends"), true, "advance");`)); await sleep(1500);
    c.heldArmed = armedTo(await ctl.call("state"));
    await ui(`m.setValue(m.row("Minimum play time").querySelectorAll(".hms input")[1], 0, "m");`); await sleep(1200);
  }, check(c) {
    const v = c.after.s.globalAdvanceOnVideoEnd === true && c.after.s.globalIntervalSeconds === 0 ? [] : [`globalAdvanceOnVideoEnd ${c.after.s.globalAdvanceOnVideoEnd} / minimum ${c.after.s.globalIntervalSeconds}, expected true / 0`];
    const a = armedTo(c.after.st), want = succ(c.after.ps?.videoPaths, c.after.cur?.path);
    if (c.heldArmed.length) v.push(`a 600 s minimum on a 30 s clip: a switch was requested already (${JSON.stringify(c.heldArmed.map(TITLE))}) — it must hold until the loop that reaches it`);
    if (c.state === "playlistGlobal" && (a.length !== 1 || a[0] !== want)) v.push(`following the globals: armed ${JSON.stringify(a.map(TITLE))} after advance-on-end on + minimum 0, expected one to ${TITLE(want)}`);
    if (c.state === "playlist" && a.length) v.push(`a global advance-on-end change armed ${JSON.stringify(a.map(TITLE))} on a playlist with its own rotation`);
    return [...v, ...noSwitchNow(c), ...keptShown(c)];
  } };
// the playlist modal's "Override global rotation settings" off while armed (pending: its own advance-on-end) → it
// follows the globals (advance-on-end off): nothing stays armed
C["plOverrideOff"] = { states: ["pending"], rearms: true, async run() {
    await ui(`${plOpen} m.setCheck(m.plCheck("Override global rotation settings"), false, "override"); ${plClose}`); await sleep(1200);
  }, check(c) {
    const v = c.after.ps?.settings?.overrideGlobalSettings === false ? [] : [`overrideGlobalSettings ${c.after.ps?.settings?.overrideGlobalSettings}, expected false`];
    return [...v, ...noSwitchNow(c), ...keptShown(c), ...armedCheck(c, null)];
  } };
// following the globals (advance-on-end on, armed) → override on (its own rotation: a 0 s timer, advance off):
// disarmed → its own "Switch when video ends" on: armed again to the strip's next, with ITS transition (fade, PS()'s duration)
C["seq:plOverrideOn+advanceOn"] = { states: ["pendingGlobal"], rearms: true, async run(c) {
    await ui(`${plOpen} m.setCheck(m.plCheck("Override global rotation settings"), true, "override"); await m.sleep(1200);`);
    c.midArmed = armedTo(await ctl.call("state"));
    await ui(`m.setCheck(m.plCheck("Switch when video ends"), true, "advance"); ${plClose}`); await sleep(1200);
  }, check(c) {
    const v = [];
    if (c.midArmed.length) v.push(`override on (its own rotation: no advance-on-end): still armed ${JSON.stringify(c.midArmed.map(TITLE))}`);
    const s = c.after.ps?.settings;
    if (s?.overrideGlobalSettings !== true || s?.advanceOnVideoEnd !== true) v.push(`playlist override ${s?.overrideGlobalSettings} advance ${s?.advanceOnVideoEnd}, expected true / true`);
    const req = armedReq(c);
    const own = PS().transitionDurationMs;
    if (req && !(req.effect_id === "fade" && req.duration_ms === own)) v.push(`the armed switch runs ${fmtSw(req)}, the playlist's own transition is fade ${own} ms`);
    return [...v, ...noSwitchNow(c), ...keptShown(c), ...armedCheck(c)];
  } };
// advance-on-end off → on → next, following the globals: disarmed, re-armed to the strip's next, next plays it and arms the one after
C["seq3:gAdvanceOff+On+next"] = { states: ["pendingGlobal"], rearms: true, switch: true, async run(c) {
    await ui(settingsTab(`m.setCheck(m.input("Switch when video ends"), false, "advance");`)); await sleep(1200);
    c.offArmed = armedTo(await ctl.call("state"));
    await ui(`m.setCheck(m.input("Switch when video ends"), true, "advance");`); await sleep(1200);
    c.onArmed = armedTo(await ctl.call("state"));
    c.want = succ(c.before.ps?.videoPaths, c.before.cur?.path);
    await cliStep(c, "next-wallpaper");
  }, check(c) {
    const v = [];
    if (c.offArmed.length) v.push(`advance-on-end off (the playlist follows the globals): still armed ${JSON.stringify(c.offArmed.map(TITLE))}`);
    if (c.onArmed.length !== 1 || c.onArmed[0] !== c.want) v.push(`advance-on-end back on: armed ${JSON.stringify(c.onArmed.map(TITLE))}, expected one to ${TITLE(c.want)}`);
    return [...v, ...expectShownN(c, c.want, 1), ...armedCheck(c)];
  } };

// --- Settings → Normalize audio (EBU R128): every live source of a measured item runs ITS OWN loudnorm `af` at the
// target (the oracle checks it in every cell; off → none). The clips are measured before the UI loads.
const NORM_STATES = ["single", "playlist", "effect", "pending", "paused", "pausedEffect", "muted", "noOutput"];
const normOn = async (target) => { const s = await getSettings(); s.normalizeAudio = true; if (target !== undefined) s.normalizeTargetLufs = target; await post("/settings", s); };
const normMeasured = (c) => (c.measured ? [] : ["the clips were never measured (normalization's background backfill, 30 s)"]);
C["set:normalizeOn"] = { states: NORM_STATES, async pre(c) { c.measured = await measureAll(); },
  async run() { await ui(settingsTab(`m.setCheck(m.input("Normalize audio"), true, "Normalize audio");`)); await sleep(900); },
  check: (c) => [...normMeasured(c), ...(c.after.s.normalizeAudio === true ? [] : ["normalizeAudio not saved on"])] };
C["set:normalizeOff"] = { states: NORM_STATES, async pre(c) { c.measured = await measureAll(); await normOn(); },
  async run() { await ui(settingsTab(`m.setCheck(m.input("Normalize audio"), false, "Normalize audio");`)); await sleep(900); },
  check: (c) => [...normMeasured(c), ...(c.after.s.normalizeAudio === false ? [] : ["normalizeAudio not saved off"])] };
// the target's preset (−14 → −19): every live measured source re-targets
C["set:normalizeTarget"] = { states: ["single", "effect", "pending", "paused"], async pre(c) { c.measured = await measureAll(); await normOn(-14); },
  async run() { await ui(settingsTab(`m.click(m.row("Target loudness")?.querySelector(".combo-caret"), "presets"); await m.sleep(300); m.click(m.byText(".sel-pop .sel-opt", "Quiet (−19)"), "Quiet");`)); await sleep(900); },
  check: (c) => [...normMeasured(c), ...(c.after.s.normalizeTargetLufs === -19 ? [] : [`normalizeTargetLufs ${c.after.s.normalizeTargetLufs}, expected -19`])] };
// switched on with nothing measured yet: the background backfill measures every clip — and what plays takes its
// loudnorm once it's measured (not only at its next switch)
C["set:normalizeFresh"] = { states: ["single", "playlist", "effect"], async pre() { unmeasureAll(); },
  async run(c) {
    await ui(settingsTab(`m.setCheck(m.input("Normalize audio"), true, "Normalize audio");`));
    c.measured = await waitFor(() => K.every((p) => measured(readIndex(), p)), 30000, 200);
    await sleep(1500);
  }, check: (c) => normMeasured(c) };
// on, then next: B comes up normalized (its own measurement)
C["seq:set:normalizeOn+next"] = { states: ["single", "playlist", "effect", "pending"], switch: true, async pre(c) { c.measured = await measureAll(); },
  async run(c) { await ui(settingsTab(`m.setCheck(m.input("Normalize audio"), true, "Normalize audio");`)); await sleep(900); await cliStep(c, "next-wallpaper"); },
  check: (c) => [...normMeasured(c), ...stayed(c, "next-wallpaper")] };
// normalization on; Mute audio on → next (B starts with no audio: no filter) → Mute audio off: B's audio comes back
// normalized — not only at its next switch
C["seq3:normalize+noAudio+next+noAudioOff"] = { states: ["single", "playlist", "effect"], switch: true, async pre(c) { c.measured = await measureAll(); await normOn(); },
  async run(c) {
    await ui(settingsTab(`m.setCheck(m.input("Mute audio"), true, "Mute audio");`)); await sleep(900);
    await cliStep(c, "next-wallpaper"); await sleep(400); await waitSettled(8000);
    await ui(`m.setCheck(m.input("Mute audio"), false, "Mute audio");`); await sleep(900);
  }, check: (c) => [...normMeasured(c), ...stayed(c, "next-wallpaper"), ...(c.after.s.noAudio === false && c.after.s.normalizeAudio === true ? [] : [`noAudio ${c.after.s.noAudio} normalizeAudio ${c.after.s.normalizeAudio}`])] };

// --- Settings → Appearance (theme / thumbnail aspect / card size / gif autoplay): UI-only — it must not touch
// playback. Every source sampled back to back while the change saves (/settings posts the whole object): no
// switch, no re-created source, no source property moved — not even for a moment — and an armed switch stays the
// same one. (The other live item has its own volume/speed, so a re-applied global would show on it.)
const SRC_PROPS = (n) => ({ path: n.path, "gain.user": +(n.gain?.user ?? 0).toFixed(2), "gain.mute": Math.round(n.gain?.mute ?? 0), speed: n.speed,
  no_audio: n.no_audio, af: n.af ?? "", hwdec: n.hwdec, fps_cap: n.fps_cap, cache: n.cache, demuxer_max_mib: n.demuxer_max_mib, demuxer_back_mib: n.demuxer_back_mib });
const armedCorrs = (st) => (st.transitions || []).filter((t) => t.phase === "waiting_start").map((t) => t.corr).join(",");
function untouched(c) {
  const v = [], seen = new Set(), b0 = c.base ?? c.before.st; // the baseline: right before the control (a state's own mute ramp has landed)
  const base = Object.fromEntries(sourcesOf(b0).map(([id, n]) => [id, SRC_PROPS(n)]));
  const fit = (st) => JSON.stringify(Object.entries(st.graph).filter(([id]) => id.startsWith("lay:") && id.endsWith(":main")).map(([id, n]) => [id, n.fit]));
  const once = (k, msg) => { if (!seen.has(k)) { seen.add(k); v.push(msg); } };
  for (const { t, st } of c.samples) {
    for (const [id, n] of sourcesOf(st)) {
      const b = base[id];
      if (!b) { once(id, `a new source ${id}(${TITLE(n.path)}) appeared at +${t - c.t0} ms (a switch / relaunch)`); continue; }
      const now = SRC_PROPS(n);
      for (const k of Object.keys(b)) if (JSON.stringify(b[k]) !== JSON.stringify(now[k])) once(id + k, `${id}(${TITLE(n.path)}) ${k} ${JSON.stringify(b[k])} → ${JSON.stringify(now[k])} at +${t - c.t0} ms`);
    }
    if (fit(st) !== fit(b0)) once("fit", `layer fit ${fit(b0)} → ${fit(st)} at +${t - c.t0} ms`);
    if (!!st.graph.player?.paused !== !!b0.graph.player?.paused) once("paused", `player.paused → ${!!st.graph.player?.paused} at +${t - c.t0} ms`);
  }
  if (armedCorrs(b0) !== armedCorrs(c.after.st)) v.push(`the armed switch ${armedCorrs(b0) || "–"} → ${armedCorrs(c.after.st) || "–"} (re-armed)`);
  if (!c.samples.length) v.push("no state samples");
  return v;
}
const APPEAR = {
  "appear:theme": { states: ["idle", "single", "effect", "pending", "paused", "pausedEffect", "muted"], drive: (c) => `await m.select("Theme", ${JSON.stringify(c.theme)});`, saved: (c) => c.after.s.theme === c.theme },
  "appear:aspect": { drive: () => `await m.select("Thumbnail aspect", "16:9");`, saved: (c) => c.after.s.thumbnailAspect === "16:9" },
  "appear:cardSize": { drive: () => `await m.select("Card size", "Large");`, saved: (c) => c.after.s.cardSize === "Large" },
  "appear:gifs": { drive: () => `m.setCheck(m.input("Autoplay GIF thumbnails"), true, "gifs");`, saved: (c) => c.after.s.autoPlayGifs === true },
  "appear:wallpaperBg": { drive: () => `m.setCheck(m.input("Live wallpaper behind all tabs"), true, "bg");`, saved: (c) => c.after.s.wallpaperBgAllTabs === true },
  // the mpvpaper leak-restart (Settings → "Restart mpvpaper every"): a legacy-only workaround, a no-op under liascape-player —
  // a 2 s interval, sampled for 3.5 s: nothing relaunches (a single video restarts under legacy, a playlist at its changeover)
  "noop:restartEvery": { states: ["single", "playlist", "effect"], ms: 3500, drive: () => `m.setValue(m.input("Restart mpvpaper every (s)"), 2, "restart");`, saved: (c) => c.after.s.restartIntervalSeconds === 2 },
  "noop:restartAtChangeover": { states: ["single", "playlist"], ms: 3500,
    drive: () => `m.setValue(m.input("Restart mpvpaper every (s)"), 2, "restart"); await m.sleep(300); m.setCheck(m.input("Restart only at playlist changeover"), true, "changeover");`,
    saved: (c) => c.after.s.restartIntervalSeconds === 2 && c.after.s.restartOnSwitchOnly === true },
};
for (const [k, a] of Object.entries(APPEAR)) C[k] = { states: a.states ?? ["effect", "pending"], noSwitch: true,
  async pre(c) { if (c.other) { await post("/library/volume", { path: c.other, intValue: 30 }); await post("/library/speed", { path: c.other, doubleValue: 0.8 }); } },
  async run(c) {
    if (k === "appear:theme") { const th = (await http("GET", "/themes")).json || []; c.theme = th.map((t) => t.name).find((n) => n !== (c.before.s.theme || "Catppuccin Mocha")); }
    await ui(`m.tab("Settings"); await m.sleep(500);`);
    c.base = await ctl.call("state");
    const stop = sampler(c, 0); c.t0 = Date.now();
    await ui(a.drive(c)); await sleep(a.ms ?? 1200); await stop();
  }, check: (c) => [...(a.saved(c) ? [] : [`the ${k} change wasn't saved`]), ...untouched(c)] };

// --- Settings → Auto-Mute, against the stack's PRIVATE audio server (test-ui-matrix.sh: its own PulseAudio at
// $XDG_RUNTIME_DIR/pulse/native with one null sink `mx_null`, no device): the backend's AudioMonitor (pactl subscribe +
// parec) and these synthetic streams only ever meet there — the owner's audio server is never seen or touched.
const PULSE = E.LIASCAPE_PULSE === "1";
let TONE = null;
const tones = new Set();
function toneWav() { // 12 s of a 440 Hz sine at −12 dBFS, mono 48 kHz (bounded; written once)
  if (TONE) return TONE;
  const sr = 48000, n = sr * 12, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8200 * Math.sin(2 * Math.PI * 440 * i / sr)), 44 + i * 2);
  TONE = path.join(OUT, "tone.wav"); fs.writeFileSync(TONE, b); return TONE;
}
// a synthetic stream into the private null sink for `ms` (≤ 12 s); `name` = its application.name
function tone(ms, name) {
  const p = cp.spawn("paplay", ["--device=mx_null", ...(name ? [`--property=application.name=${name}`] : []), toneWav()], { stdio: "ignore" });
  tones.add(p);
  const t = setTimeout(() => p.kill("SIGTERM"), ms);
  p.on("exit", () => { clearTimeout(t); tones.delete(p); });
  p.on("error", () => { clearTimeout(t); tones.delete(p); });
  return p;
}
async function stopTones() { for (const p of tones) p.kill("SIGTERM"); await waitFor(() => tones.size === 0, 3000, 50); }
const muteOf = (st) => sourcesOf(st).map(([id, n]) => `${id}(${TITLE(n.path)}) ${Math.round(n.gain?.mute ?? 0)}`);
const allMuted = (st, want) => { const s = sourcesOf(st); return s.length > 0 && s.every(([, n]) => near(n.gain?.mute ?? 0, want ? -96 : 0, 0.5)); };
const muteNow = async (want) => allMuted(await ctl.call("state"), want);
// the backend's stream watch is up: its `pactl subscribe` is a client of the private server (besides this check's own pactl)
async function amReady() {
  return waitFor(() => new Promise((res) => cp.execFile("pactl", ["list", "clients"], { timeout: 2000 }, (err, out) =>
    res(!err && (String(out).match(/application\.process\.binary = "pactl"/g) || []).length >= 2))), 5000, 100);
}
const amEnable = settingsTab(`m.setCheck(m.input("Mute when system audio plays"), true, "auto-mute"); await m.sleep(400);`);
const amSkip = (c) => (PULSE ? false : (c.skip = "no private audio server (pulseaudio) for this stack"));
const amReadyCheck = (c) => (c.ready ? [] : ["auto-mute's stream watch (pactl subscribe) never connected to the stack's audio server"]);
// a stream plays: every live source mutes (ramped, while paused too); it ends: after the unmute delay (2 s) they unmute
// — unless the user muted (then they stay muted)
C["autoMute:tone"] = { states: ["single", "playlist", "effect", "pending", "paused", "pausedEffect", "muted", "noOutput"], async run(c) {
    if (amSkip(c)) return;
    await ui(amEnable); c.ready = await amReady();
    const t0 = Date.now(); tone(3000);
    c.mutedMs = (await waitFor(() => muteNow(true), 3000, 40)) ? Date.now() - t0 : null;
    c.during = await ctl.call("state");
    await waitFor(() => tones.size === 0, 5000, 50); const t1 = Date.now();
    if (c.exp.muted) { await sleep(3000); return; } // user-muted: it must STAY muted past the unmute delay (the oracle)
    c.unmutedMs = (await waitFor(() => muteNow(false), 5000, 50)) ? Date.now() - t1 : null;
  }, check(c) {
    const v = [...amReadyCheck(c)];
    if (c.mutedMs == null) v.push(`a stream played 3 s but the wallpaper wasn't auto-muted: ${JSON.stringify(muteOf(c.during))}`);
    if (!c.exp.muted && c.unmutedMs == null) v.push("the stream ended but the wallpaper stayed muted > 5 s (unmute delay 2 s)");
    if (c.after.s.autoMute !== true) v.push("autoMute not saved on");
    return v;
  } };
// auto-muted, then next: B comes up muted while the stream still plays; the stream ends → both unmute
C["autoMute:tone+next"] = { states: ["single", "playlist", "effect", "pending"], switch: true, async run(c) {
    if (amSkip(c)) return;
    await ui(amEnable); c.ready = await amReady();
    tone(10000); c.muted1 = await waitFor(() => muteNow(true), 3000, 40);
    await cliStep(c, "next-wallpaper"); await sleep(400); await waitSettled(8000);
    c.during = await ctl.call("state"); c.duringTone = tones.size > 0;
    await stopTones();
    c.unmuted = await waitFor(() => muteNow(false), 5000, 50);
  }, check(c) {
    const v = [...amReadyCheck(c), ...stayed(c, "next-wallpaper")];
    if (!c.muted1) v.push("not auto-muted before the next");
    if (!c.duringTone) v.push("the 10 s stream ended before the switch settled");
    else if (!allMuted(c.during, true)) v.push(`after next, the stream still playing: ${JSON.stringify(muteOf(c.during))} — not all muted`);
    if (!c.unmuted) v.push("the stream ended but the wallpaper stayed muted > 5 s");
    return v;
  } };
// toggle-mute ×3 around an auto-mute: auto-muted → the keybind unmutes now (the stream still plays) → mutes (user)
// → the stream ends and the unmute delay passes: STILL muted (the user's) → the keybind unmutes
C["seq:autoMute+toggleMute×3"] = { states: ["single", "playlist"], async run(c) {
    if (amSkip(c)) return;
    await ui(amEnable); c.ready = await amReady();
    tone(12000); c.s = [];
    c.s.push(["auto-muted by the stream", await waitFor(() => muteNow(true), 3000, 40)]);
    await cliStep(c, "toggle-mute"); c.s.push(["toggle-mute while auto-muted: unmuted now", await waitFor(() => muteNow(false), 2000, 40)]);
    await cliStep(c, "toggle-mute"); c.s.push(["toggle-mute again: muted (the user's)", (await waitFor(() => muteNow(true), 2000, 40)) && fs.existsSync(E.LIASCAPE_USER_MUTE)]);
    c.s.push(["the stream still played through all that", tones.size > 0]);
    await stopTones(); await sleep(3000);
    c.s.push(["the stream ended + the unmute delay: still muted (user)", await muteNow(true)]);
    await cliStep(c, "toggle-mute"); c.s.push(["toggle-mute: unmuted", await waitFor(() => muteNow(false), 2000, 40)]);
  }, exp: { muted: false }, check: (c) => [...amReadyCheck(c), ...c.s.filter(([, ok]) => !ok).map(([what]) => `not: ${what}`)] };
// auto-muted, then auto-mute switched off in Settings: unmuted at once, the stream still playing
C["autoMute:offWhileMuted"] = { states: ["single", "effect", "pending"], async run(c) {
    if (amSkip(c)) return;
    await ui(amEnable); c.ready = await amReady();
    tone(10000); c.muted1 = await waitFor(() => muteNow(true), 3000, 40);
    const t = Date.now(); await ui(`m.setCheck(m.input("Mute when system audio plays"), false, "auto-mute");`);
    c.unmutedMs = (await waitFor(() => muteNow(false), 3000, 40)) ? Date.now() - t : null; c.duringTone = tones.size > 0;
  }, check(c) {
    const v = [...amReadyCheck(c)];
    if (!c.muted1) v.push("not auto-muted by the stream");
    if (c.unmutedMs == null) v.push("auto-mute switched off while muted: still muted 3 s later");
    else if (!c.duringTone) v.push("(the stream had ended — not proven while it plays)");
    if (c.after.s.autoMute !== false) v.push("autoMute not saved off");
    return v;
  } };
// streams that must never auto-mute: mpv's own (application.name mpv — the filter), one below the level threshold
// (Min level −6 dB vs a −12 dBFS stream); then the threshold back to −70 while it plays → muted (the change is live)
C["autoMute:mpvStream"] = { states: ["single"], async run(c) {
    if (amSkip(c)) return;
    await ui(amEnable); c.ready = await amReady();
    tone(2500, "mpv"); const stop = sampler(c, 40); await waitFor(() => tones.size === 0, 5000, 50); await stop();
  }, check(c) { const m = c.samples.filter(({ st }) => sourcesOf(st).some(([, n]) => (n.gain?.mute ?? 0) < -1));
    return [...amReadyCheck(c), ...(m.length ? [`an mpv stream auto-muted the wallpaper (${m.length}/${c.samples.length} samples)`] : [])]; } };
C["seq:autoMute+threshold+tone+thresholdBack"] = { states: ["single"], async run(c) {
    if (amSkip(c)) return;
    await ui(settingsTab(`m.setCheck(m.input("Mute when system audio plays"), true, "auto-mute"); await m.sleep(400); m.setValue(m.input("Min level (dB)"), -6, "min level"); await m.sleep(400);`));
    await sleep(500); c.ready = await amReady();
    tone(9000); const stop = sampler(c, 40); await sleep(2500); await stop();
    const t = Date.now(); await ui(`m.setValue(m.input("Min level (dB)"), -70, "min level");`);
    c.mutedMs = (await waitFor(() => muteNow(true), 4000, 40)) ? Date.now() - t : null; c.duringTone = tones.size > 0;
    await stopTones(); await waitFor(() => muteNow(false), 5000, 50);
  }, check(c) {
    const v = [...amReadyCheck(c)];
    const m = c.samples.filter(({ st }) => sourcesOf(st).some(([, n]) => (n.gain?.mute ?? 0) < -1));
    if (m.length) v.push(`a −12 dBFS stream under a −6 dB threshold auto-muted (${m.length}/${c.samples.length} samples)`);
    if (c.mutedMs == null) v.push(`the threshold back to −70 while the stream plays: not muted within 4 s${c.duringTone ? "" : " (the stream had ended)"}`);
    if (c.after.s.autoMuteThresholdDb !== -70) v.push(`autoMuteThresholdDb ${c.after.s.autoMuteThresholdDb}`);
    return v;
  } };
// Mute after 1500 ms: not muted 0.8 s into a stream, muted by 4 s
C["autoMute:delay"] = { states: ["single"], async run(c) {
    if (amSkip(c)) return;
    await ui(settingsTab(`m.setCheck(m.input("Mute when system audio plays"), true, "auto-mute"); await m.sleep(400); m.setValue(m.input("Mute after (ms)"), 1500, "delay"); await m.sleep(400);`));
    await sleep(500); c.ready = await amReady();
    const t0 = Date.now(); tone(6000); await sleep(800); c.early = await muteNow(true);
    c.mutedMs = (await waitFor(() => muteNow(true), 3500, 40)) ? Date.now() - t0 : null;
    await stopTones(); await waitFor(() => muteNow(false), 5000, 50);
  }, check(c) {
    const v = [...amReadyCheck(c)];
    if (c.early) v.push("muted 0.8 s into the stream with a 1500 ms mute delay");
    if (c.mutedMs == null) v.push("not muted 4.3 s into the stream (mute delay 1500 ms)");
    if (c.after.s.autoMuteDelayMs !== 1500) v.push(`autoMuteDelayMs ${c.after.s.autoMuteDelayMs}`);
    return v;
  } };
// Unmute after 4000 ms (default 2000): still muted 3 s after the stream ended, unmuted by 8 s
C["autoMute:unmuteDelay"] = { states: ["single"], async run(c) {
    if (amSkip(c)) return;
    await ui(settingsTab(`m.setCheck(m.input("Mute when system audio plays"), true, "auto-mute"); await m.sleep(400); m.setValue(m.input("Unmute after (ms)"), 4000, "unmute delay"); await m.sleep(400);`));
    await sleep(500); c.ready = await amReady();
    tone(10000); c.muted1 = await waitFor(() => muteNow(true), 4000, 40); // muted (under load the watch can take > 2 s)
    await stopTones(); const t1 = Date.now(); // the stream ends here
    await sleep(3000); c.at3 = await muteNow(true);
    c.unmutedMs = (await waitFor(() => muteNow(false), 5000, 50)) ? Date.now() - t1 : null;
  }, check(c) {
    const v = [...amReadyCheck(c)];
    if (!c.muted1) v.push("not auto-muted by the stream");
    if (!c.at3) v.push("unmuted < 3 s after the stream ended with a 4000 ms unmute delay");
    if (c.unmutedMs == null) v.push("still muted 8 s after the stream ended (unmute delay 4000 ms)");
    if (c.after.s.autoUnmuteDelayMs !== 4000) v.push(`autoUnmuteDelayMs ${c.after.s.autoUnmuteDelayMs}`);
    return v;
  } };

// --- the order a shuffle plays. Contract (session.md § Timed Playlist, PlayerHelper.AdvanceToNext): each CYCLE plays
// every item of the playlist once, in a fresh random order; a new cycle never starts with the item the last one ended
// on (no immediate repeat); turning Shuffle on mid-session keeps what plays and plays the REST once (in random order)
// before the first full cycle; previous walks back through what actually played. Sequential = the strip's order.
const plSeg = (label) => `${plOpen} m.click(m.byText(".pl-modal .segbtn", ${JSON.stringify(label)}), ${JSON.stringify(label)}); ${plClose}`;
// `n` next keybinds, each settled: the item each one put on screen
async function nexts(c, n, a = "next-wallpaper") {
  const out = [];
  for (let i = 0; i < n; i++) { await cliStep(c, a); await sleep(300); await waitSettled(8000); out.push((await http("GET", "/current")).json?.path ?? null); }
  return out;
}
// `plays` split at `cuts` (index of each cycle's first play) → every cycle a permutation of `items` (the last may be
// partial: no item twice), no item twice in a row
function shuffleOrder(plays, items, first = 0) {
  const v = [], T = (l) => JSON.stringify(l.map(TITLE));
  for (let i = 1; i < plays.length; i++) if (plays[i] === plays[i - 1]) v.push(`${TITLE(plays[i])} played twice in a row (plays ${T(plays)})`);
  for (let at = first; at < plays.length; at += items.length) {
    const cyc = plays.slice(at, at + items.length);
    if (new Set(cyc).size !== cyc.length || cyc.some((p) => !items.includes(p))) v.push(`cycle ${T(cyc)} isn't one pass over ${T(items)} (plays ${T(plays)})`);
  }
  return [...new Set(v)];
}
const notStripOrder = (plays, strip, first) => {
  const cyc = []; for (let at = first; at + strip.length <= plays.length; at += strip.length) cyc.push(plays.slice(at, at + strip.length));
  return cyc.length >= 3 && cyc.every((x) => JSON.stringify(x) === JSON.stringify(strip)) ? [`shuffle on, but ${cyc.length} cycles all played the strip's order`] : [];
};
// Shuffle chosen in the playlist modal, then Play, then 11 nexts: 12 plays = three full cycles over the 4 clips
C["shuffle:play+next×11"] = { states: ["idle"], switch: true,
  async pre() { await post("/playlist/state", { videoPaths: [K[0], K[1], K[2], K[3]], settings: PS({ transitionDurationMs: 300 }), name: null }); },
  async run(c) {
    await ui(plSeg("Shuffle")); await sleep(500);
    await ui(`m.click(document.querySelector(".play-btn"), "Play");`); await sleep(400); await waitSettled(10000);
    c.plays = [(await http("GET", "/current")).json?.path ?? null, ...(await nexts(c, 11))];
  }, check(c) {
    const strip = [K[0], K[1], K[2], K[3]];
    const v = [...shuffleOrder(c.plays, strip), ...notStripOrder(c.plays, strip, 0)];
    if (c.after.ps?.settings?.order !== 1) v.push(`playlist order ${c.after.ps?.settings?.order}, expected 1 (shuffle)`);
    if (JSON.stringify((c.after.ps?.videoPaths || []).map(TITLE)) !== JSON.stringify(strip.map(TITLE))) v.push(`the strip ${JSON.stringify((c.after.ps?.videoPaths || []).map(TITLE))} — shuffling reordered it`);
    return v;
  } };
// the same order contract for the rotation itself: Shuffle + a 2 s interval, Play, 11 interval switches
C["shuffle:rotation"] = { states: ["idle"], switch: true,
  async pre() { await post("/playlist/state", { videoPaths: [K[0], K[1], K[2], K[3]], settings: PS({ transitionDurationMs: 300, intervalSeconds: 2 }), name: null }); },
  async run(c) {
    await ui(plSeg("Shuffle")); await sleep(500);
    const t0 = Date.now();
    await ui(`m.click(document.querySelector(".play-btn"), "Play");`);
    const sched = () => events.filter((e) => e._t >= t0 && e.event === "transition.scheduled");
    c.done = await waitFor(() => sched().length >= 12, 45000, 100);
    c.plays = sched().slice(0, 12).map((e) => e.path);
    await post("/stop"); // the 2 s rotation would go on switching through the snapshot
  }, exp: { paused: false }, check(c) {
    const strip = [K[0], K[1], K[2], K[3]];
    const v = c.done ? [] : [`only ${c.plays.length} switches in 45 s with a 2 s interval`];
    return [...v, ...shuffleOrder(c.plays, strip), ...notStripOrder(c.plays, strip, 0)];
  } };
// Shuffle turned on mid-session (playing k1 of k1..k4): the other three once each, then full cycles
C["shuffle:onMidSession"] = { states: ["playlist4"], switch: true, async run(c) {
    await ui(plSeg("Shuffle")); await sleep(500);
    c.plays = [c.before.cur?.path, ...(await nexts(c, 11))];
  }, check(c) {
    const strip = c.before.ps?.videoPaths || [];
    const v = [...shuffleOrder(c.plays, strip, 4)];
    const rest = c.plays.slice(1, strip.length);
    if (new Set(rest).size !== strip.length - 1 || rest.includes(c.plays[0])) v.push(`after Shuffle on, the rest of the cycle ${JSON.stringify(rest.map(TITLE))} isn't the other ${strip.length - 1} items once each`);
    return [...v, ...psKept(c)];
  } };
// Shuffle on, 2 nexts, Sequential, 4 nexts: from where it is, the strip's order (wrapping)
C["shuffle:offMidSession"] = { states: ["playlist4"], switch: true, async run(c) {
    await ui(plSeg("Shuffle")); await sleep(500);
    c.shuffled = await nexts(c, 2);
    await ui(plSeg("Sequential")); await sleep(500);
    c.plays = await nexts(c, 4);
  }, check(c) {
    const strip = c.before.ps?.videoPaths || [], v = [];
    let prev = c.shuffled[c.shuffled.length - 1];
    c.plays.forEach((p, i) => { const want = succ(strip, prev); if (p !== want) v.push(`Sequential again, next #${i + 1} from ${TITLE(prev)}: ${TITLE(p)}, expected ${TITLE(want)} (the strip's order)`); prev = p; });
    if (c.after.ps?.settings?.order !== 0) v.push(`playlist order ${c.after.ps?.settings?.order}, expected 0`);
    return v;
  } };
// shuffled: previous walks back through what played (not the strip's previous), next forward again
C["shuffle:prev+next"] = { states: ["playlist4"], switch: true, async run(c) {
    await ui(plSeg("Shuffle")); await sleep(500);
    c.fwd = [c.before.cur?.path, ...(await nexts(c, 2))];
    c.back = await nexts(c, 2, "previous-wallpaper");
    c.again = await nexts(c, 1);
  }, check(c) {
    const T = (l) => JSON.stringify(l.map(TITLE)), v = [];
    if (T(c.back) !== T([c.fwd[1], c.fwd[0]])) v.push(`played ${T(c.fwd)}, then previous ×2 gave ${T(c.back)}, expected ${T([c.fwd[1], c.fwd[0]])}`);
    if (c.again[0] !== c.fwd[1]) v.push(`then next gave ${TITLE(c.again[0])}, expected ${TITLE(c.fwd[1])} (forward through what played)`);
    return v;
  } };

// --- three or more controls in a row (each in the states where all of them share state)
// drag → next → pause → resume → next: both nexts follow the dragged order, the pause in between holds and ends
C["seq5:stripDrag+next+pause+resume+next"] = { states: ["playlist", "effect"], switch: true, async run(c) {
    const s = c.before.ps?.videoPaths || []; c.want = moved(s, s.length - 1, 1);
    await stripDrag(TITLE(s[s.length - 1]), TITLE(s[1]));
    c.t1 = succ(c.want, c.before.cur?.path); c.t2 = succ(c.want, c.t1);
    c.first = (await nexts(c, 1))[0];
    await cliStep(c, "toggle-pause"); await sleep(600); c.pausedMid = !!(await ctl.call("state")).graph.player?.paused;
    await cliStep(c, "toggle-pause"); await sleep(300);
    await cliStep(c, "next-wallpaper");
  }, exp: { paused: false }, check(c) {
    const v = [...expectShownN(c, c.t2, 2)];
    if (c.first !== c.t1) v.push(`the first next after the drag played ${TITLE(c.first)}, expected ${TITLE(c.t1)} (the new order)`);
    if (!c.pausedMid) v.push("toggle-pause after the next didn't pause");
    const got = (c.after.ps?.videoPaths || []).map(TITLE), w = c.want.map(TITLE);
    if (JSON.stringify(got) !== JSON.stringify(w)) v.push(`playlist ${JSON.stringify(got)}, expected the dragged order ${JSON.stringify(w)}`);
    return v;
  } };
// mute → next → unmute: B came up muted, and everything is unmuted at the end
C["seq3:mute+next+unmute"] = { states: ["single", ...PL_STATES], switch: true, async run(c) {
    await cliStep(c, "toggle-mute"); await sleep(300);
    await cliStep(c, "next-wallpaper"); await sleep(400); await waitSettled(8000);
    c.midSt = await ctl.call("state");
    await cliStep(c, "toggle-mute");
  }, exp: { muted: false }, check: (c) => [...stayed(c, "next-wallpaper"), ...(allMuted(c.midSt, true) ? [] : [`muted, then next: ${JSON.stringify(muteOf(c.midSt))} — not all muted`])] };
// trash the other live item → Undo → next: the undone item is back in its place and the next follows the restored strip
C["seq3:trash+undo+next"] = { states: ["playlist", "pending"], switch: true, async run(c) {
    c.target = c.other; c.idx = (c.before.ps?.videoPaths || []).indexOf(c.target);
    await ui(`m.click(m.card(${JSON.stringify(TITLE(c.target))})?.querySelector(".del"), "trash"); await m.sleep(900); m.click(m.byText(".topbar button", "Undo"), "Undo");`);
    await sleep(900);
    c.want = succ(c.before.ps?.videoPaths, c.before.cur?.path);
    await cliStep(c, "next-wallpaper");
  }, check(c) {
    const at = (c.after.ps?.videoPaths || []).indexOf(c.target);
    return [...(at === c.idx ? [] : [`${TITLE(c.target)} back at playlist index ${at}, was ${c.idx}`]), ...expectShownN(c, c.want, 1), ...armedCheck(c)];
  } };
// pause → drag the playing item's volume → resume: the drag reaches its source while paused and stays after the resume
C["seq3:pause+itemVolDrag+resume"] = { states: ["single", "playlist", "effect"], async run(c) {
    c.target = c.shown;
    await cliStep(c, "toggle-pause"); await sleep(300);
    await ui(`await m.cardMenu(${JSON.stringify(TITLE(c.target))}, "Settings (volume / speed)"); await m.sleep(500); await m.drag(m.modalRange(0), 80, 25, 20, 40, "slider"); await m.sleep(400); m.closeModal();`);
    await sleep(900); c.whilePaused = await ctl.call("state");
    await cliStep(c, "toggle-pause");
  }, check(c) {
    const v = [];
    const ov = (c.after.lib || []).find((i) => i.videoPath === c.target)?.volumeOverride;
    if (ov !== 25) v.push(`${TITLE(c.target)} volumeOverride ${ov}, expected 25`);
    if (!c.whilePaused.graph.player?.paused) v.push("not paused during the drag");
    for (const [id, n] of srcFor({ st: c.whilePaused }, c.target)) if (!near(n.gain?.user ?? 0, VolumeDb(25))) v.push(`while paused the drag didn't reach ${id}(${TITLE(c.target)}): ${n.gain?.user}`);
    return v;
  } };
// global speed → next → previous: back on the first item, at the new global speed (the other one keeps its own)
C["seq3:set:speed+next+prev"] = { states: ["playlist", "effect"], switch: true,
  async pre(c) { if (c.other) await post("/library/speed", { path: c.other, doubleValue: 0.8 }); },
  async run(c) {
    await ui(settingsTab(`m.setValue(m.input("Speed"), 1.5, "Speed");`)); await sleep(900);
    await nexts(c, 1); await cliStep(c, "previous-wallpaper");
  }, check: (c) => [...(c.after.cur?.path === c.before.cur?.path ? [] : [`speed → next → previous from ${TITLE(c.before.cur?.path)} landed on ${TITLE(c.after.cur?.path)}`]),
    ...(c.after.s.speed === 1.5 ? [] : [`settings.speed ${c.after.s.speed}, expected 1.5`])] };
// next → pause → next: the second next (a user switch from a pause) resumes and switches with its transition
C["seq3:next+pause+next"] = { states: ["playlist", "pending"], switch: true, async run(c) {
    const s = c.before.ps?.videoPaths || []; c.want = succ(s, succ(s, c.before.cur?.path));
    await nexts(c, 1);
    await cliStep(c, "toggle-pause"); await sleep(500); c.pausedMid = !!(await ctl.call("state")).graph.player?.paused;
    await cliStep(c, "next-wallpaper");
  }, exp: { paused: false }, check: (c) => [...expectShownN(c, c.want, 2), ...(c.pausedMid ? [] : ["toggle-pause between the nexts didn't pause"]), ...armedCheck(c)] };
// pause → trash what plays → Undo: the session plays on from the next item (a new session: the pause ends), the
// trashed item is back in its place in the strip, and what plays now stays
C["seq3:pause+trash:shown+undo"] = { states: ["playlist", "pending"], switch: true, async run(c) {
    await cliStep(c, "toggle-pause"); await sleep(300);
    c.target = c.shown; c.idx = (c.before.ps?.videoPaths || []).indexOf(c.target);
    c.want = succ(c.before.ps?.videoPaths, c.target);
    await ui(`m.click(m.card(${JSON.stringify(TITLE(c.target))})?.querySelector(".del"), "trash"); await m.sleep(1200); m.click(m.byText(".topbar button", "Undo"), "Undo");`);
    await sleep(900);
  }, exp: { paused: false }, check(c) {
    const at = (c.after.ps?.videoPaths || []).indexOf(c.target), v = [];
    if (at !== c.idx) v.push(`${TITLE(c.target)} back at playlist index ${at}, was ${c.idx}`);
    if (!(c.after.lib || []).some((i) => i.videoPath === c.target)) v.push(`${TITLE(c.target)} not back in the library`);
    return [...v, ...expectShownN(c, c.want, 1), ...armedCheck(c)];
  } };
// random (keybind), then next / previous: the rotation goes on from the random pick's place in the strip — next =
// the item after it (it used to keep the rotation's old position: next replayed the pick itself, or the item after
// what played before), and an advance-on-end session re-arms to that item; previous = back to what played before
// (the pick replaced the pre-fetched, never-played next — previous went to that instead) and the next after that
// is the pick again (history forward, like next after any previous). Random excludes what plays, so it's repeated
// until it lands on the item two after the starting one (the pick where the old position's successor isn't the
// pick's: the fuzz found it 2 of 3 times in `pending`); an advance-on-end session must re-arm to the strip's next
// after every pick (`c.midV`).
async function randomTo(c) {
  const s = c.before.ps?.videoPaths || [], i = s.indexOf(c.before.cur?.path);
  c.target = s[(i + 2) % s.length]; c.tries = 0; c.midV = [];
  for (let cur = c.before.cur?.path; cur !== c.target && c.tries < 10; c.tries++) {
    c.from = cur; await cliStep(c, "random"); await sleep(300); await waitSettled(8000);
    cur = (await http("GET", "/current")).json?.path ?? null;
    if (c.pending) {
      await waitFor(async () => armedTo(await ctl.call("state")).length > 0, 3000, 50);
      const a = armedTo(await ctl.call("state")), want = succ(s, cur);
      if (a.length !== 1 || a[0] !== want) c.midV.push(`random → ${TITLE(cur)}: armed to ${JSON.stringify(a.map(TITLE))}, expected ${TITLE(want)}`);
    }
  }
}
const randomLanded = (c) => [...(c.midV || []), ...(c.landed === c.target ? [] : [`random never landed on ${TITLE(c.target)} in ${c.tries} tries (on ${TITLE(c.landed)})`])];
C["seq:random+next"] = { states: ["playlist", "pending"], switch: true, async run(c) {
    await randomTo(c); c.landed = (await http("GET", "/current")).json?.path ?? null;
    c.want = succ(c.before.ps?.videoPaths, c.target);
    await cliStep(c, "next-wallpaper");
  }, check: (c) => [...randomLanded(c), ...expectShownN(c, c.want, c.tries + 1), ...armedCheck(c)] };
C["seq:random+prev"] = { states: ["playlist", "pending"], switch: true, async run(c) {
    await randomTo(c); c.landed = (await http("GET", "/current")).json?.path ?? null;
    await cliStep(c, "previous-wallpaper");
  }, check: (c) => [...randomLanded(c), ...expectShownN(c, c.from, c.tries + 1), ...armedCheck(c, c.landed)] }; // history: next after previous = the pick again
// a playlist that only advances at each video's end (interval 0 — no countdown) played, then next: it's taken. The tick
// (which takes every queued next / previous / random) only started with an interval, so the keybind and the UI's
// next queued pending_action.txt for nobody
C["seq:plPlayAdvanceOnly+next"] = { states: ["pending"], switch: true, async run(c) {
    await post("/playlist/play", { ...PENDING_PL(), settings: PS({ advanceOnVideoEnd: true, transitionDurationMs: 600, intervalSeconds: 0 }) });
    await sleep(500); await waitSettled(8000);
    c.mid = (await http("GET", "/current")).json?.path ?? null; c.want = succ(c.before.ps?.videoPaths, c.mid);
    await cliStep(c, "next-wallpaper");
  }, check: (c) => [...expectShownN(c, c.want, 2), ...armedCheck(c)] };
// a timed playlist of ONE item (600 s), then next / random: the tick takes it (a switch to that item — the strip's next
// and the only pick), and nothing rotates by itself. The tick that takes every queued next / previous / random started
// only for > 1 item: the keybind queued pending_action.txt for nobody, and a tick started later (the list grew) threw
// it away
for (const a of ["next-wallpaper", "random"]) C[`seq:plPlayOne+${a === "random" ? "random" : "next"}`] = { states: ["single"], switch: true, async run(c) {
    await playFast(c, [K[1]], PS()); c.exp.paused = false; // (+ /playlist/state: the strip follows it)
    await sleep(600);
    c.tStep = Date.now();
    await cliStep(c, a);
  }, check(c) {
    const after = c.evs.filter((e) => e.event === "transition.scheduled" && e._t >= c.tStep);
    const v = [];
    if (!after.some((e) => e.path === K[1] && e.align !== "end")) v.push(`${a} in a one-item timed playlist: no switch to ${TITLE(K[1])} was requested (the queued action was never taken)`);
    if (after.length > 1) v.push(`${after.length} switches after the ${a} (${after.map((e) => `${TITLE(e.path)} ${e.align}`)}), expected one`);
    if (!c.noOutput && c.after.cur?.path !== K[1]) v.push(`expected ${TITLE(K[1])} on screen, /current says ${TITLE(c.after.cur?.path)}`);
    return v;
  } };
// remove the other item from the strip (the session plays on with two), trash what plays (it plays on from the one
// survivor: a one-item session) → Undo (both back) → next: the rotation still takes it. A one-item session started no
// tick and putting items back never started one — the queued next (pending_action.txt) was never taken while
// /current said timed (fuzz: playlist → stripRemove:other → trashUndo:shown → cli:next-wallpaper)
C["seq3:stripRemove+trashUndo+next"] = { states: ["playlist", "pending"], switch: true, async run(c) {
    c.removed = c.other; if (!c.removed || !(await stripHas(c, c.removed))) return c.skip = "not in strip";
    await ui(`m.click(m.strip(${JSON.stringify(TITLE(c.removed))}).querySelector(".pl-remove"), "remove");`); await sleep(900);
    c.target = c.shown; c.exp.paused = false;
    await ui(`m.click(m.card(${JSON.stringify(TITLE(c.target))})?.querySelector(".del"), "trash"); await m.sleep(1200); m.click(m.byText(".topbar button", "Undo"), "Undo");`);
    await sleep(900); await waitSettled(8000);
    c.mid = (await http("GET", "/current")).json?.path ?? null;
    c.midPs = (await http("GET", "/playlist/state")).json?.videoPaths || [];
    c.want = succ(c.midPs, c.mid);
    await cliStep(c, "next-wallpaper");
  }, check(c) {
    const v = [];
    if (!c.midPs.includes(c.target)) v.push(`${TITLE(c.target)} not back in the playlist after Undo (${JSON.stringify(c.midPs.map(TITLE))})`);
    if (c.mid === c.target || !c.mid) v.push(`trashing ${TITLE(c.target)} left ${TITLE(c.mid)} on screen`);
    return [...v, ...expectShownN(c, c.want, 2), ...armedCheck(c)];
  } };

function expectShown(c, want, { effect }) {
  const v = [];
  if (!c.noOutput && c.after.cur?.path !== want) v.push(`expected ${TITLE(want)} on screen, /current says ${TITLE(c.after.cur?.path)}`);
  const sched = c.evs.filter((e) => e.event === "transition.scheduled");
  const mine = sched.filter((e) => e.path === want);
  if (!mine.length) v.push(`no switch to ${TITLE(want)} was requested`);
  // (c.cutsOk: a fuzz chain switched a transition off earlier — the switch may be a cut; never set by a matrix cell)
  else if (effect && !c.noOutput && !c.cutsOk && mine[mine.length - 1].effect_id == null) v.push(`switch to ${TITLE(want)} was a cut (transitions are on)`);
  if (sched.length > 3) v.push(`${sched.length} switches requested (storm?)`);
  return v;
}
function psKept(c) {
  const s = c.after.ps?.settings; const want = c.before.ps?.settings;
  if (!s || !want) return [];
  const v = ["transitionEnabled", "transitionDurationMs", "advanceOnVideoEnd", "intervalSeconds"].filter((k) => JSON.stringify(s[k]) !== JSON.stringify(want[k]))
    .map((k) => `playlist ${k} ${JSON.stringify(want[k])} → ${JSON.stringify(s[k])}`);
  // playing from an item mustn't reorder the strip (it's saved: the next launch showed the play order)
  const a = (c.before.ps?.videoPaths || []).map(TITLE), b = (c.after.ps?.videoPaths || []).map(TITLE);
  if (JSON.stringify(a) !== JSON.stringify(b)) v.push(`playlist order ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  return v;
}
// after removing/trashing `p`: the playlist doesn't hold it, and no armed switch still goes to it
function notTargeted(c, p, { gone } = {}) {
  const v = [];
  if ((c.after.ps?.videoPaths || []).includes(p)) v.push(`${TITLE(p)} still in the playlist`);
  if (gone && (c.after.lib || []).some((i) => i.videoPath === p)) v.push(`${TITLE(p)} still in the library`);
  for (const t of c.after.st.transitions || []) {
    const b = c.after.st.graph[t.to];
    if (b?.path === p && t.phase === "waiting_start") v.push(`an armed switch (${t.corr}) still goes to the removed ${TITLE(p)}`);
  }
  return v;
}

// ---------------------------------------------------------------- scene controls (Phase 2 Task 12)
// Every one runs only in the states it lists (the scene states are opt-in) and checks the player itself: the general
// oracle covers a scene source like a video's (gain.user / speed / no_audio / gain.mute / … are resolved per source),
// plus what each control is about — the worker (`state.workers[]`: pid, fps_target, audio.gain_db / no_audio / speed),
// the player props, the index's crash mark, the UI. `allowErr(e)`: a source.error the control causes on purpose.
const scWorker = async (p) => workerOf(await ctl.call("state"), p);
const waitWorker = (p, pred, ms = 5000) => waitFor(async () => { const w = await scWorker(p); return !!w && pred(w); }, ms, 100);
const settingsRow = (label) => `m.tab("Settings"); for (let i = 0; i < 60 && !m.row(${JSON.stringify(label)}); i++) await m.sleep(100);`;
const samePid = (c, p) => { const a = workerOf(c.before.st, p)?.pid, b = workerOf(c.after.st, p)?.pid; return a && a === b ? [] : [`${TITLE(p)}'s worker ${a} → ${b} (a setting must apply live, on the same worker)`]; };
const scLogs = async (kind) => ((await ctl.call("logs", { kind_prefix: kind, limit: 1000 }).catch(() => null))?.events || []);

// apply a scene by clicking its card — from nothing, over a single video, over a running playlist
C["apply:scene"] = { states: ["idle", "single", "playlist"], switch: true, exp: { paused: false },
  async pre() { await scenesOn(); },
  async run(c) { c.target = SC[0]; await ui(`m.click(m.card("s1")?.querySelector(".thumb-wrap"), "card s1");`); c.pe = (await http("GET", "/player-engine")).json; },
  check: (c) => [...expectShown(c, SC[0], { effect: !!c.before.cur?.path }), ...sceneShown(c, SC[0]),
    ...(c.pe?.scenes?.available === true ? [] : [`/player-engine.scenes ${JSON.stringify(c.pe?.scenes)}`])] };

// next in the scene playlist [k1, s1, s2, k2]: V→S, S→S, S→V × every transition method (a keybind, like the user's)
for (const [combo, st] of [["v→s", "sceneV"], ["s→s", "sceneS"], ["s→v", "sceneS2"]]) for (const m of ["full-live", "reveal", "frozen"]) {
  C[`next:${combo}:${m}`] = { states: [st], switch: true,
    async pre() { await scenesOn({ transitionMethod: m }); },
    async run(c) {
      c.from = c.before.cur?.path; c.want = succ(c.before.ps?.videoPaths, c.from); c.aPid = workerOf(c.before.st, c.from)?.pid;
      c.cli = await cli("next-wallpaper");
      // the outgoing scene's worker is reaped once the switch has handed off
      if (c.aPid) { await waitSettled(12000, c.want); c.aGone = await waitFor(() => !pidAlive(c.aPid), 3000, 100); }
    },
    check(c) {
      const v = [...expectShown(c, c.want, { effect: true })];
      if (SC.includes(c.want)) v.push(...sceneShown(c, c.want));
      const sw = lastSwitch(c);
      const started = sw && c.evs.find((e) => e.event === "transition.started" && e.corr === sw.corr);
      if (!started) v.push(`the switch ${sw?.corr ?? "?"} never started`);
      else if (started.method !== m) v.push(`the switch ran method ${started.method}, TransitionMethod is ${m}`);
      if (sw && !c.evs.some((e) => e.event === "transition.handoff" && e.corr === sw.corr)) v.push(`no transition.handoff for ${sw.corr}`);
      if (c.aPid && !c.aGone) v.push(`the outgoing scene ${TITLE(c.from)}'s worker ${c.aPid} still runs after the switch`);
      return v;
    } };
}

// pause a scene: the player pauses (the oracle), the scene's frames stop (the worker latches nothing, its clock stands
// still, the picture is identical 500 ms apart) and its sound is gated out (gain.pause −96)
C["pause:scene"] = { states: ["scene"], flipPause: true, async run(c) {
    c.cli = await cli("toggle-pause");
    await waitFor(async () => (await pget("player.paused")) === true, 4000, 50);
    await sleep(300); // the pause gate's 30 ms ramp + the hold
    const shot = async (n) => { const f = path.join(OUT, `mx-pause-${process.pid}-${n}.png`); await ctl.call("capture", { target: "out:VIRTUAL-1", path: f }); return fs.readFileSync(f); };
    const w0 = await scWorker(SC[0]); const a = await shot("a");
    await sleep(500);
    const w1 = await scWorker(SC[0]); const b = await shot("b");
    c.sameShot = a.equals(b); c.w0 = w0; c.w1 = w1;
  }, check(c) {
    const v = [];
    if (!c.sameShot) v.push("the picture changed while paused (captures 500 ms apart differ)");
    if (!c.w0 || !c.w1) v.push("no s1 worker while paused");
    else {
      if (c.w1.latched !== c.w0.latched) v.push(`s1's worker latched ${c.w1.latched - c.w0.latched} frames while paused`);
      if (c.w1.scene_time !== c.w0.scene_time) v.push(`s1's scene clock moved while paused: ${c.w0.scene_time} → ${c.w1.scene_time}`);
    }
    for (const id of srcIdsOf(c.after.st, SC[0])) { const gp = c.after.st.graph[id].gain?.pause; if (!(gp <= -95.9)) v.push(`${id}(s1) gain.pause ${gp}, expected −96 while paused`); }
    return v;
  } };

// mute a scene: gain.mute −96 on its source (the oracle) reaches its worker's stream
C["mute:scene"] = { states: ["scene"], flipMute: true, async run(c) {
    c.cli = await cli("toggle-mute");
    await waitWorker(SC[0], (w) => w.audio?.gain_db <= -95, 4000);
  }, check(c) { const g = workerOf(c.after.st, SC[0])?.audio?.gain_db; return g <= -95 ? [] : [`s1's worker stream gain ${g} dB while muted, expected −96`]; } };

// the global volume on a scene: its source's gain.user (the oracle) and the worker's stream gain follow
C["volume:scene"] = { states: ["scene"], async run(c) {
    await ui(`${settingsRow("Volume")} m.setValue(m.input("Volume"), 55, "Volume");`);
    await waitWorker(SC[0], (w) => near(w.audio?.gain_db, VolumeDb(55), 0.1), 5000);
  }, check(c) {
    const v = c.after.s.volume === 55 ? [] : [`settings.volume ${c.after.s.volume}, expected 55`];
    const g = workerOf(c.after.st, SC[0])?.audio?.gain_db;
    if (!near(g, VolumeDb(55), 0.1)) v.push(`s1's worker stream gain ${g} dB, expected ${VolumeDb(55).toFixed(2)} (Volume 55)`);
    return [...v, ...samePid(c, SC[0])];
  } };

// the scene's own volume / speed (its settings modal): its source only, persisted, live on the same worker — a
// scene's speed scales its animation and its pitch-kept sound under liascape-player (owner decision), so the slider shows
for (const [k, idx, val, field] of [["itemVol", 0, 37, "volumeOverride"], ["itemSpd", 1, 1.7, "speedOverride"]]) {
  C[`${k}:scene`] = { states: ["scene"], async run(c) {
      await ui(`await m.cardMenu("s1", "Settings (volume / speed)"); await m.sleep(500); m.setValue(m.modalRange(${idx}), ${val}, "${k} slider");`);
      await waitWorker(SC[0], (w) => (k === "itemVol" ? near(w.audio?.gain_db, VolumeDb(val), 0.1) : near(w.audio?.speed, val, 0.001)), 4000);
      await sleep(500); await ui(`m.closeModal();`);
    }, check(c) {
      const v = [];
      const ov = (c.after.lib || []).find((i) => i.videoPath === SC[0])?.[field];
      if (ov !== val) v.push(`s1 ${field} ${ov}, expected ${val}`);
      const w = workerOf(c.after.st, SC[0]);
      if (k === "itemVol" && !near(w?.audio?.gain_db, VolumeDb(val), 0.1)) v.push(`s1's worker stream gain ${w?.audio?.gain_db}, expected ${VolumeDb(val).toFixed(2)}`);
      if (k === "itemSpd" && !near(w?.audio?.speed, val, 0.001)) v.push(`s1's worker speed ${w?.audio?.speed}, expected ${val}`);
      return [...v, ...samePid(c, SC[0])];
    } };
}

// Mute audio (NoAudio) on a scene: no_audio on its source (the oracle) and its worker, live, same worker
C["noAudio:scene"] = { states: ["scene"], async run(c) {
    await ui(`${settingsRow("Mute audio")} m.setCheck(m.input("Mute audio"), true, "Mute audio");`);
    await waitWorker(SC[0], (w) => w.audio?.no_audio === true, 5000);
  }, check(c) {
    const v = c.after.s.noAudio === true ? [] : [`settings.noAudio ${c.after.s.noAudio}`];
    if (workerOf(c.after.st, SC[0])?.audio?.no_audio !== true) v.push("s1's worker still plays its sound (audio.no_audio false)");
    return [...v, ...samePid(c, SC[0])];
  } };

// trash the playing scene: a single one stops, a playlist plays on from the next item; its worker goes
C["trash:playingScene"] = { states: ["scene", "sceneS"], switch: true, async run(c) {
    c.target = SC[0]; trashEndsPause(c); c.aPid = workerOf(c.before.st, SC[0])?.pid;
    await ui(`m.click(m.card("s1")?.querySelector(".del"), "trash s1");`); await sleep(900);
    c.aGone = await waitFor(() => !pidAlive(c.aPid), 3000, 100);
  }, check: (c) => [...afterTrash(c, SC[0]), ...(c.aGone ? [] : [`s1's worker ${c.aPid} still runs after it was trashed`])] };

// a scene that crashes (s3: 1.5 s after every start) played from the strip: broken after 3 restarts → marked
// crashed in its index entry, its card shows it, the rotation advances to the strip's next (s1)
C["crash:scene"] = { states: ["scene"], switch: true, exp: { paused: false },
  allowErr: (e) => String(e.reason ?? "").includes(SC_KEY(SC[2])), // "scene worker broken (crash record …/900000003-….json)"
  async pre() { await post("/playlist/state", { videoPaths: [SC[2], SC[0]], settings: PS(), name: null }); },
  async run(c) {
    await ui(`m.click(m.strip("s3"), "strip s3");`);
    c.marked = await waitFor(() => readScIndex()[SC_KEY(SC[2])]?.crashed === true, 30000, 200);
    c.advanced = await waitSettled(12000, SC[0]);
    c.card = await waitFor(() => ui(`return !!m.card("s3")?.classList.contains("crashed");`), 5000, 100);
    c.broken = (await scLogs("source.broken")).filter((e) => e.path === SC[2]);
  }, check(c) {
    const v = [];
    if (!c.broken.length) v.push("no source.broken for s3");
    if (!c.marked) v.push(`s3 not marked crashed in its index entry (${JSON.stringify(readScIndex()[SC_KEY(SC[2])])})`);
    if (!c.card) v.push("the UI doesn't show s3's card as crashed");
    if (c.after.cur?.path !== SC[0]) v.push(`after s3 broke: /current ${TITLE(c.after.cur?.path)}, expected s1 (the strip's next)`);
    return v;
  } };

// every output unplugged while a scene plays: it's parked (silent, paused, the worker kept); replugged it shows again
C["noOutput:scene"] = { states: ["scene"], async run(c) {
    c.pid0 = workerOf(c.before.st, SC[0])?.pid; c.ids = srcIdsOf(c.before.st, SC[0]);
    for (const o of ["VIRTUAL-1", "VIRTUAL-2"]) await ctl.call("headless.remove_output", { name: o });
    c.parked = await waitFor(async () => c.ids.includes((await ctl.call("state")).parked), 3000, 50);
    c.pidParked = (await scWorker(SC[0]))?.pid;
    for (const [name, w, h] of [["VIRTUAL-1", 640, 360], ["VIRTUAL-2", 320, 180]]) await ctl.call("headless.add_output", { name, width: w, height: h, hz: 60 });
    c.back = await waitFor(async () => { const st = await ctl.call("state"); const s = screen(st); return Object.keys(s).length === 2 && Object.values(s).every((p) => p === SC[0]); }, 5000, 100);
  }, check(c) {
    const v = [];
    if (!c.parked) v.push(`s1 (${c.ids}) wasn't parked with every output gone`);
    if (c.pidParked !== c.pid0) v.push(`s1's worker ${c.pid0} → ${c.pidParked} while parked (it must be kept)`);
    if (!c.back) v.push("replugged outputs don't show s1 again");
    return [...v, ...samePid(c, SC[0])];
  } };

// per-monitor scene fps (Monitors (scenes) → fps (live)): out:<c>.scene_fps and the worker's rate, same worker
C["settings:sceneFps"] = { states: ["scene"], async run(c) {
    await ui(`m.tab("Settings"); for (let i = 0; i < 60 && !m.byText(".settings button", "+ Add monitor"); i++) await m.sleep(100);
      m.click(m.byText(".settings button", "+ Add monitor"), "add monitor"); await m.sleep(400);
      const name = document.querySelector(".settings .mon-name"); m.setValue(name, "VIRTUAL-1", "monitor name"); await m.sleep(100);
      m.setValue(name.parentElement.querySelector("input.num"), 45, "monitor fps");`);
    c.fps = await waitFor(async () => (await pget("out:VIRTUAL-1.scene_fps")) === 45, 5000, 100);
    await waitWorker(SC[0], (w) => near(w.fps_target, 45, 0.5), 3000);
  }, check(c) {
    const v = [];
    const m = (c.after.s.lweMonitors || []).find((x) => x.name === "VIRTUAL-1");
    if (!m || m.fps !== 45) v.push(`settings.lweMonitors ${JSON.stringify(c.after.s.lweMonitors)}, expected VIRTUAL-1 at 45`);
    if (!c.fps) v.push("out:VIRTUAL-1.scene_fps never became 45");
    const w = workerOf(c.after.st, SC[0]);
    if (!near(w?.fps_target, 45, 0.5)) v.push(`s1's worker fps_target ${w?.fps_target}, expected 45`);
    return [...v, ...samePid(c, SC[0])];
  } };

// the GPU / VRAM group (liascape-player): each control → its player prop, live, the scene on the same worker
for (const [name, prop, want, drive, saved] of [
  ["sceneThrottle", "player.scene_throttle", false, `${settingsRow("Auto-throttle scenes")} m.setCheck(m.input("Auto-throttle scenes"), false, "auto-throttle");`, (s) => s.sceneThrottle === false],
  ["vramLimit", "player.scene_vram_limit_mib", 2048, `${settingsRow("Limit VRAM per scene")} m.setCheck(m.input("Limit VRAM per scene"), true, "VRAM limit"); await m.sleep(300);
    for (let i = 0; i < 30 && !m.input("VRAM limit (MiB)"); i++) await m.sleep(100); m.setValue(m.input("VRAM limit (MiB)"), 2048, "MiB");`, (s) => s.sceneVramLimitEnabled === true && s.sceneVramLimitMib === 2048],
  ["vramLowMode", "player.vram_low_mode", "pause", `${settingsRow("When VRAM runs low")} await m.select("When VRAM runs low", "Pause");`, (s) => s.vramLowMode === "pause"],
]) {
  C[`settings:${name}`] = { states: ["scene"], async run(c) {
      c.was = await pget(prop);
      await ui(drive);
      c.ok = await waitFor(async () => (await pget(prop)) === want, 5000, 100);
      c.lowActive = await pget("player.vram_low_active");
    }, check(c) {
      const v = [];
      if (!c.ok) v.push(`${prop} ${JSON.stringify(c.was)} → never ${JSON.stringify(want)}`);
      if (!saved(c.after.s)) v.push(`the setting wasn't saved (${JSON.stringify({ sceneThrottle: c.after.s.sceneThrottle, sceneVramLimitEnabled: c.after.s.sceneVramLimitEnabled, sceneVramLimitMib: c.after.s.sceneVramLimitMib, vramLowMode: c.after.s.vramLowMode })})`);
      if (c.lowActive !== false) v.push(`player.vram_low_active ${c.lowActive} (the fake VRAM sample is healthy)`);
      return [...v, ...samePid(c, SC[0])];
    } };
}

// a scene over the per-scene VRAM limit (the fake probe reports its worker at 2000 MiB > 1536): the player stops it,
// the rotation advances at once, the UI says why — and it is NOT marked crashed
C["vram:exceeded"] = { states: ["sceneS"], switch: true,
  allowErr: (e) => String(e.reason ?? "").includes("vram_exceeded"),
  async pre() { await scenesOn({ sceneVramLimitEnabled: true, sceneVramLimitMib: 1536 }); },
  async run(c) {
    c.pid = workerOf(c.before.st, SC[0])?.pid;
    vramFake({ [c.pid]: 2000 });
    c.adv = await waitSettled(12000, SC[1]);
    c.status = "";
    await waitFor(async () => (c.status = String(await ui(`return document.querySelector(".status")?.textContent ?? "";`))).includes("stopped: used"), 5000, 100);
    c.ev = (await scLogs("scene.vram_exceeded")).filter((e) => e.path === SC[0]);
    vramFake();
  }, check(c) {
    const v = [...expectShown(c, SC[1], { effect: true })];
    if (!c.ev.length) v.push(`no scene.vram_exceeded for s1 (worker ${c.pid})`);
    if (readScIndex()[SC_KEY(SC[0])]?.crashed) v.push("s1 was marked crashed by a VRAM stop");
    if (!c.status.includes("used 2000 MiB > limit 1536 MiB")) v.push(`the status bar says "${c.status}", expected "s1: stopped: used 2000 MiB > limit 1536 MiB of VRAM"`);
    return v;
  } };

// --- advance-on-end play-time limits (wall-clock seconds, 0 = off), live on the `pending` rotation: k4 (10 s) plays
// with its switch to k1 armed for its end. The minimum IS the rotation's interval field (relabelled under "Switch when
// video ends"), the maximum the field below it — both h/m/s groups (PlayTimeInput over NumInput); the drive sets the
// seconds field (a value set without focus commits at once) and fires focusout anyway.
// `where`: the playlist modal (its own rotation) or the Settings page (the globals).
const limitDrive = (where, which, secs) => {
  const label = which === "minimum" ? "Minimum play time" : "Maximum play time";
  return where === "playlist"
    ? `${plOpen} const el = document.querySelector('.pl-modal input[aria-label="${label} seconds"]'); m.setValue(el, ${secs}, "${which}");
       el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); ${plClose}`
    : settingsTab(`const el = m.row("${label}")?.querySelector('input[aria-label="${label} seconds"]'); m.setValue(el, ${secs}, "${which}");
       el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); await m.sleep(300);`);
};
// k4's position now → when (wall ms) its current loop ends; skips the cell when too little of it is left to act in
async function k4LoopEnd(c, needMs) {
  const pos = Number(await pget("cur:*.time_pos")), t = Date.now();
  if (!Number.isFinite(pos) || (await http("GET", "/current")).json?.path !== K[3]) return (c.skip = "k4 not playing"), null;
  const end = t + (10 - pos) * 1000;
  if (end - t < needMs) return (c.skip = `k4 at ${pos.toFixed(1)} s: its loop ends too soon to act`), null;
  return { pos, t, end };
}
const limitSaved = (c, where, key, want) => {
  const got = where === "playlist" ? c.after.ps?.settings?.[key] : c.after.s?.[where === "global" ? `global${key[0].toUpperCase()}${key.slice(1)}` : key];
  return got === want ? [] : [`${where} ${key} ${got} after the UI change, expected ${want}`];
};
// minimum 15 s: the switch armed for k4's first loop end is re-requested — k4 loops once more and advances at the end of
// its 2nd loop (align:end, never mid-loop)
for (const where of ["playlist", "global"]) C[`${where}:minPlay`] = { states: [where === "playlist" ? "pending" : "pendingGlobal"], rearms: true, async run(c) {
    c.k4 = await k4LoopEnd(c, 4000); if (!c.k4) return;
    await ui(limitDrive(where, "minimum", 15)); c.tChange = Date.now();
    await waitFor(async () => (await http("GET", "/current")).json?.path === K[0] && (c.tSwitched = Date.now()), 26000, 100);
    await waitSettled(8000);
  }, check(c) {
    const v = limitSaved(c, where, "intervalSeconds", 15);
    if (c.tChange > c.k4.end - 800) v.push(`precondition: the limit landed ${c.tChange - c.k4.end} ms after k4's loop end`);
    const sw = c.evs.filter((e) => e.event === "transition.scheduled" && e.path === K[0]);
    if (!c.tSwitched) v.push("k4 never advanced to k1 within 26 s of a 15 s minimum");
    else if (c.tSwitched < c.k4.end + 8000) v.push(`k4 advanced ${c.tSwitched - c.k4.end} ms after its 1st loop's end — the 15 s minimum wasn't held (its 2nd loop ends +10 s)`);
    if (sw.some((e) => e.align !== "end")) v.push(`a switch to k1 with align ${sw.map((e) => e.align)} — the minimum must end on a loop's end`);
    return v;
  } };
// maximum 4 s: k4 advances once it played 4 s — now (align:now, a transition), long before its end
for (const where of ["playlist", "global"]) C[`${where}:maxPlay`] = { states: [where === "playlist" ? "pending" : "pendingGlobal"], rearms: true, async run(c) {
    c.k4 = await k4LoopEnd(c, 3000); if (!c.k4) return;
    await ui(limitDrive(where, "maximum", 4)); c.tChange = Date.now();
    await waitFor(async () => (c.sw = events.find((e) => e._t >= c.tChange - 2000 && e.event === "transition.scheduled" && e.path === K[0] && e.align !== "end")), 7000, 100);
    await waitSettled(8000);
  }, check(c) {
    const v = limitSaved(c, where, "maxPlaySeconds", 4);
    if (!c.sw) return [...v, "no switch now (align:now) to k1 within 7 s of a 4 s maximum"];
    const played = c.k4.pos + (c.sw._t - c.k4.t) / 1000;
    if (played < 3.6) v.push(`k4 advanced after ${played.toFixed(1)} s of play, before the 4 s maximum`);
    if (c.sw._t > c.k4.end - 200) v.push("the maximum's switch came only at k4's end");
    if (c.sw.effect_id == null) v.push("the maximum's switch was a cut (transitions are on)");
    if (c.after.cur?.path !== K[0]) v.push(`/current ${TITLE(c.after.cur?.path)}, expected k1`);
    return v;
  } };
// a global maximum on a playlist with its OWN rotation (no limits): nothing switches now
C["global:maxPlay:own"] = { states: ["pending"],
  // (the global maximum's row shows with the global advance-on-end; the playlist's own rotation doesn't read it)
  async pre() { const s = await getSettings(); await post("/settings", { ...s, globalAdvanceOnVideoEnd: true }); },
  async run(c) {
    c.k4 = await k4LoopEnd(c, 4500); if (!c.k4) return;
    await ui(limitDrive("global", "maximum", 2)); c.tChange = Date.now();
    await sleep(Math.min(3500, c.k4.end - Date.now() - 300));
    c.now = events.filter((e) => e._t >= c.tChange && e.event === "transition.scheduled" && e.align !== "end");
  }, check(c) {
    const v = limitSaved(c, "global", "maxPlaySeconds", 2);
    if (c.now.length) v.push(`a global 2 s maximum switched a playlist with its own rotation now (to ${c.now.map((e) => TITLE(e.path))})`);
    return v;
  } };

// a short playlist interval set while a scene plays (it never ends): the rotation advances off it to the next item
C["playlist:sceneInterval"] = { states: ["sceneS"], async run(c) {
    await ui(`${plOpen} m.setValue(${hms(2)}, 4, "s"); await m.sleep(300); m.setValue(${hms(1)}, 0, "m"); ${plClose}`);
    c.saved = (await http("GET", "/playlist/state")).json?.settings?.intervalSeconds;
    c.tChange = Date.now();
    c.sw = await waitFor(async () => events.some((e) => e._t >= c.tChange - 500 && e.event === "transition.scheduled" && e.path === SC[1]), 9000, 100);
    await waitSettled(8000, SC[1]);
    // stop rotating before the checks (another client's save: the strip re-syncs)
    await post("/playlist/state", { settings: { intervalSeconds: 600 } }); await sleep(500);
  }, check(c) {
    const v = [];
    if (c.saved !== 4) v.push(`playlist interval ${c.saved} after the UI change, expected 4`);
    if (!c.sw) v.push("no switch off the scene within 9 s of a 4 s interval");
    if (c.after.cur?.path !== SC[1]) v.push(`/current ${TITLE(c.after.cur?.path)}, expected s2 (the strip's next after s1)`);
    const e = c.evs.find((x) => x.event === "transition.scheduled" && x.path === SC[1]);
    if (e && e.effect_id == null) v.push("the interval's switch off the scene was a cut (transitions are on)");
    return v;
  } };

// "Separate timing for scenes" (advance-on-end only; player-adapter.md § Rotation): on → a scene / still image switches
// after "Switch scenes after" (0 = off), the minimum / maximum apply to videos only. Driven through the real UI while s1
// plays: the toggle shows only under "Switch when video ends", the seconds field only while it's on; 4 s → s1 (playing
// for a while already: its play time counts since it showed) moves on to s2 now, with its transition.
const sceneTimingCheck = (c, savedOn, savedSecs) => {
  const v = [];
  if (savedOn !== true || savedSecs !== 4) v.push(`separate timing ${savedOn} / switch scenes after ${savedSecs} after the UI change, expected true / 4`);
  const early = c.evs.filter((e) => e.event === "transition.scheduled" && e._t < c.tChange - 300);
  if (early.length) v.push(`a switch before the scene timing was set (to ${early.map((e) => TITLE(e.path))}) — nothing should move s1 then`);
  if (!c.sw) v.push("no switch off s1 within 9 s of \"Switch scenes after\" 4 s");
  else {
    if (c.sw.align === "end") v.push("the scene's switch was align:end (a scene never ends — it must switch now)");
    if (c.sw.effect_id == null) v.push("the scene's switch was a cut (transitions are on)");
  }
  if (c.after.cur?.path !== SC[1]) v.push(`/current ${TITLE(c.after.cur?.path)}, expected s2 (the strip's next after s1)`);
  return v;
};
const sceneSecsTo4 = (group) => `const iv = ${group}.querySelectorAll("input"); m.setValue(iv[0], 0, "h"); m.setValue(iv[1], 0, "m"); await m.sleep(200);
  m.setValue(iv[2], 4, "s"); iv[2].dispatchEvent(new FocusEvent("focusout", { bubbles: true }));`;
const plLabels = `[...document.querySelectorAll(".pl-modal .field-label, .pl-modal label.ck")].map((e) => e.textContent.trim())`;
C["playlist:sceneTiming"] = { states: ["sceneS"], async run(c) {
    // its own rotation: a 600 s timer (advance off) → the toggle isn't there; advance on → it is (on by default), with
    // the seconds field; 4 s
    await ui(plOpen); c.lab0 = await js(plLabels);
    await ui(`m.setCheck(m.plCheck("Switch when video ends"), true, "advance"); await m.sleep(400);`); c.lab1 = await js(plLabels);
    await ui(`m.setCheck(m.plCheck("Separate timing for scenes"), true, "separate"); await m.sleep(300);
      ${sceneSecsTo4(`document.querySelectorAll(".pl-modal .hms")[2]`)} ${plClose}`);
    c.tChange = Date.now();
    await waitFor(async () => (c.sw = events.find((e) => e._t >= c.tChange - 1500 && e.event === "transition.scheduled" && e.path === SC[1])), 9000, 100);
    await waitSettled(8000, SC[1]);
    c.saved = (await http("GET", "/playlist/state")).json?.settings;
    // stop rotating before the checks: 0 = off → s2 (a scene) stays
    await post("/playlist/state", { settings: { switchScenesAfterSeconds: 0 } }); await sleep(500);
  }, check(c) {
    const v = sceneTimingCheck(c, c.saved?.separateSceneTiming, c.saved?.switchScenesAfterSeconds);
    if (c.saved?.advanceOnVideoEnd !== true) v.push(`playlist advanceOnVideoEnd ${c.saved?.advanceOnVideoEnd}, expected true`);
    if (c.lab0?.some((l) => /separate timing|switch scenes after/i.test(l))) v.push(`scene timing shown with "Switch when video ends" off: ${JSON.stringify(c.lab0)}`);
    if (!c.lab1?.includes("Separate timing for scenes") || !c.lab1?.includes("SWITCH SCENES AFTER")) v.push(`modal after advance on: ${JSON.stringify(c.lab1)} — expected "Separate timing for scenes" + "SWITCH SCENES AFTER"`);
    return v;
  } };
C["global:sceneTiming"] = { states: ["sceneSGlobal"], async run(c) {
    // the globals: advance on, no limits, toggle off → s1 stays; the toggle row shows, the seconds row doesn't; on → it
    // does; 4 s
    await ui(settingsTab(`await m.sleep(200);`)); c.rows0 = await js(rowLabels);
    await ui(`m.setCheck(m.input("Separate timing for scenes"), true, "separate"); await m.sleep(500);`); c.rows1 = await js(rowLabels);
    await ui(sceneSecsTo4(`m.row("Switch scenes after")`));
    c.tChange = Date.now();
    await waitFor(async () => (c.sw = events.find((e) => e._t >= c.tChange - 1500 && e.event === "transition.scheduled" && e.path === SC[1])), 9000, 100);
    await waitSettled(8000, SC[1]);
    c.savedS = await getSettings();
    await post("/settings", { ...(await getSettings()), globalSwitchScenesAfterSeconds: 0 }); await sleep(500);
  }, check(c) {
    const v = sceneTimingCheck(c, c.savedS?.globalSeparateSceneTiming, c.savedS?.globalSwitchScenesAfterSeconds);
    if (!c.rows0?.includes("Separate timing for scenes") || c.rows0?.includes("Switch scenes after")) v.push(`rotation rows with the toggle off: ${JSON.stringify(c.rows0)} — expected the toggle, no "Switch scenes after"`);
    if (!c.rows1?.includes("Switch scenes after")) v.push(`rotation rows with the toggle on: ${JSON.stringify(c.rows1)} — expected "Switch scenes after"`);
    return v;
  } };

// the backend restarted (dotnet watch, an app relaunch) while a scene plays: the same scene stays — no switch, the same
// worker — and the new backend says so (/current, the UI's playing mark)
let backendPid = Number(E.LIASCAPE_BACKEND_PID || 0);
const procAlive = (pid) => { try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; } };
// SIGTERM, SIGKILL after `graceMs` (0: SIGKILL at once — the restart landing mid-request). An open page's WebSocket
// holds a graceful shutdown open (Kestrel's 30 s), as under `dotnet watch`, whose restart then kills it.
async function stopBackend(graceMs = 35000) {
  const old = backendPid;
  if (!old || !procAlive(old)) return;
  process.kill(old, graceMs ? "SIGTERM" : "SIGKILL");
  if (!(await waitFor(() => !procAlive(old), graceMs || 5000, 50))) { process.kill(old, "SIGKILL"); await waitFor(() => !procAlive(old), 5000, 50); }
}
async function restartBackend() {
  await win.loadURL("about:blank"); // the page's WebSocket would hold the old backend's shutdown open (Kestrel's 30 s)
  await stopBackend();
  return startBackend();
}
// a new backend on the same port (LIASCAPE_PORT), recorded for test-ui-matrix.sh's cleanup; true once it answers /health
async function startBackend() {
  const env = { ...process.env, LIASCAPE_PORT: new URL(U).port };
  for (const k of ["DISPLAY", "LIASCAPE_URL", "LIASCAPE_CLIPS", "LIASCAPE_OUT", "LIASCAPE_ONLY", "LIASCAPE_SHARD"]) delete env[k];
  const log = fs.openSync(E.LIASCAPE_BACKEND_LOG, "a");
  const ch = cp.spawn(E.LIASCAPE_DOTNET, [E.LIASCAPE_DLL, "--serve"], { env, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  backendPid = ch.pid; if (E.LIASCAPE_BACKEND_PID_FILE) fs.writeFileSync(E.LIASCAPE_BACKEND_PID_FILE, String(ch.pid));
  return waitFor(async () => (await http("GET", "/health")).json?.ok === true, 40000, 200);
}
C["restore:scene"] = { states: ["scene"], noSwitch: true, async run(c) {
    c.pid0 = workerOf(c.before.st, SC[0])?.pid;
    c.up = await restartBackend();
    await loadUi(); await sleep(500);
  }, check(c) {
    const v = [...sceneShown(c, SC[0]), ...samePid(c, SC[0])];
    if (!c.up) v.push("the restarted backend didn't answer /health");
    return v;
  } };

// The backend restarted UNDER AN OPEN PAGE (the owner's incident: `dotnet watch` restarted the dev backend on a
// cherry-pick while the app stayed open, and Vite's HMR of the same change re-ran the store's init into the outage —
// the Library tab said "Library is empty" for good, the playing wallpaper's title in the header). The page must pick
// up everything it mirrors from the backend by itself — no reload: the library (cards), the strip, the settings
// (thumbnailAspect → --thumb-aspect), what plays — and never show [] for a read that failed.
const CFG = path.dirname(E.LIASCAPE_USER_MUTE); // the stack's ~/.config/liascape (settings.json, playlist_state.json)
const K5 = () => path.join(path.dirname(path.dirname(K[0])), "k5", "k5.mp4");
const ASPECT_CSS = { "1:1": "1 / 1", "16:9": "16 / 9" };
function editJson(file, fn) {
  const j = JSON.parse(fs.readFileSync(file, "utf8")); fn(j);
  fs.writeFileSync(file + ".mx", JSON.stringify(j, null, 2)); fs.renameSync(file + ".mx", file);
}
const keyIn = (o, name) => Object.keys(o).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name[0].toUpperCase() + name.slice(1);
// what the page shows of the backend's data (read from the DOM, whichever tab — the cards are mounted on Library)
const pageData = () => js(`({ cards: [...document.querySelectorAll(".card.lib .lib-title")].map((e) => e.title).sort(),
  empty: !!document.querySelector(".center-msg"), strip: [...document.querySelectorAll(".pl-item")].map((e) => e.title),
  aspect: document.documentElement.style.getPropertyValue("--thumb-aspect") })`);
const libTitles = async () => ((await http("GET", "/library")).json || []).map((i) => i.title).sort();
// k5 (a copy of k4) leaves the library through the backend's own delete (the page's stale card is fine: the next cell reloads)
async function dropK5() {
  const it = ((await http("GET", "/library").catch(() => null))?.json || []).find((i) => i.videoPath === K5());
  if (it) await post("/library/delete", it);
}
C["restart:backend"] = { states: ["idle", "playlist"], noSwitch: true, async run(c) {
    const wantTitles = [...(await libTitles()), "k5"].sort();
    await stopBackend(3000);
    try {
      // while it's down, what another process changes (a CLI's WE sync, a hand edit, the next build's startup): an item
      // added, the thumbnail aspect flipped, the strip rewritten
      fs.mkdirSync(path.dirname(K5()), { recursive: true }); fs.copyFileSync(K[3], K5());
      editJson(path.join(CFG, "settings.json"), (s) => { const k = keyIn(s, "thumbnailAspect"); c.aspect = (s[k] ?? "1:1") === "16:9" ? "1:1" : "16:9"; s[k] = c.aspect; });
      editJson(path.join(CFG, "playlist_state.json"), (p) => { p[keyIn(p, "videoPaths")] = [K[2], K[0]]; });
      await sleep(500);
      c.up = await startBackend();
      c.firstLib = await libTitles(); // the new backend's first /library: whole, never an empty list while it loads
      c.recovered = await waitFor(async () => { const d = (c.page = await pageData());
        return JSON.stringify(d.cards) === JSON.stringify(wantTitles) && JSON.stringify(d.strip) === '["k3","k1"]' && d.aspect === ASPECT_CSS[c.aspect]; }, 12000, 200);
      c.want = { cards: wantTitles, strip: ["k3", "k1"], aspect: ASPECT_CSS[c.aspect] };
    } finally { await dropK5(); }
  }, check(c) {
    const v = [];
    if (!c.up) v.push("the restarted backend didn't answer /health");
    if (JSON.stringify(c.firstLib) !== JSON.stringify(c.want?.cards)) v.push(`the restarted backend's first /library: ${JSON.stringify(c.firstLib)}, expected ${JSON.stringify(c.want?.cards)}`);
    if (!c.recovered) v.push(`the open page didn't take the restarted backend's data within 12 s (no reload): shows ${JSON.stringify(c.page)}, expected ${JSON.stringify(c.want)}`);
    return v;
  } };
// the page's first /library in flight when the backend dies (held at the request, the backend SIGKILLed, then let go):
// the failed read must not become "Library is empty", and the page fills itself once the backend is back
C["restart:midLibrary"] = { states: ["idle"], noSwitch: true, async run(c) {
    const wantTitles = await libTitles();
    let seen = false, release;
    const go = new Promise((r) => (release = r));
    const filter = { urls: [`${U}/library`] };
    session.defaultSession.webRequest.onBeforeRequest(filter, (d, cb) => { if (seen) return cb({}); seen = true; go.then(() => cb({})); });
    try {
      await win.loadURL(U + "/");
      c.held = await waitFor(() => seen, 8000, 20);
      await sleep(600); // the page's other startup reads land
      await stopBackend(0);
    } finally { release(); session.defaultSession.webRequest.onBeforeRequest(filter, null); }
    await sleep(1500);
    c.during = await pageData();
    c.up = await startBackend();
    c.recovered = await waitFor(async () => JSON.stringify((c.page = await pageData()).cards) === JSON.stringify(wantTitles), 12000, 200);
    c.want = wantTitles;
    await js(PAGE);
  }, check(c) {
    const v = [];
    if (!c.held) v.push("the page's /library was never seen (nothing was held)");
    if (!c.up) v.push("the restarted backend didn't answer /health");
    if (!c.recovered) v.push(`after its /library failed mid-restart the page didn't recover the library within 12 s (no reload): shows ${JSON.stringify(c.page)}, expected cards ${JSON.stringify(c.want)}`);
    return v;
  } };
// the page STARTS while the backend is down (the dev UI is Vite's, another origin: an HMR update re-runs the store's
// init — the incident's path. Here: the built UI from file:// with ?api=<port>), then the backend comes up
C["restart:initDown"] = { states: ["idle"], noSwitch: true, async run(c) {
    const wantTitles = await libTitles();
    const ps = (await http("GET", "/playlist/state")).json;
    c.want = { cards: wantTitles, strip: (ps?.videoPaths || []).map(TITLE), aspect: ASPECT_CSS[BASE_SETTINGS.thumbnailAspect ?? "1:1"] };
    await win.loadURL("about:blank");
    await stopBackend();
    await win.loadURL(`file://${E.LIASCAPE_UI_DIR}/index.html?api=${new URL(U).port}`);
    await sleep(2500);
    c.during = await pageData();
    c.up = await startBackend();
    c.recovered = await waitFor(async () => { const d = (c.page = await pageData());
      return JSON.stringify(d.cards) === JSON.stringify(c.want.cards) && JSON.stringify(d.strip) === JSON.stringify(c.want.strip) && d.aspect === c.want.aspect; }, 12000, 200);
    await js(PAGE);
  }, check(c) {
    const v = [];
    if (!c.up) v.push("the restarted backend didn't answer /health");
    if (!c.recovered) v.push(`a page started while the backend was down didn't load once it came up (12 s, no reload): shows ${JSON.stringify(c.page)}, expected ${JSON.stringify(c.want)}`);
    return v;
  } };

// a scene's user properties (the item modal's "Scene properties"): s1's project.json declares `color` (the synthetic
// renderer's colour, WE-encoded — red by default), `clock` (bool) and `bars` (shown while clock is on). Oracle: s1's own
// picture (a pixel of its source), its source's scene_props, the worker's `properties` answer, the index, the modal.
const SP_GREEN = "0 255 0", SP_RED = "255 0 0";
async function scPixel(p) {
  const id = srcIdsOf(await ctl.call("state"), p)[0];
  if (!id) return null;
  const f = path.join(OUT, `mx-sp-${process.pid}.png`);
  try { await ctl.call("capture", { target: id, path: f }); } catch { return null; }
  return [...cp.execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", f, "-vf", "crop=1:1:100:100", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])].join(" ");
}
const waitPixel = (p, want, ms = 6000) => waitFor(async () => (await scPixel(p)) === want, ms, 150);
const liveSp = (st, p) => { const id = srcIdsOf(st, p)[0]; return id ? st.graph[id].scene_props : undefined; };
const spColor = (sp) => (Array.isArray(sp?.color) ? sp.color.map((x) => Math.round(x)) : sp?.color);
const spIndex = () => readScIndex()[SC_KEY(SC[0])]?.sceneProps ?? null;
const openSpModal = `await m.cardMenu("s1", "Settings (volume / speed)"); for (let i = 0; i < 50 && !document.querySelector("[data-scene-prop=color]"); i++) await m.sleep(100);`;
const spSet = (name, value) => post("/library/scene-props", { path: SC[0], name, value });
// set in the modal → live on the playing scene (same worker) → persisted; the bool hides its dependant at once
C["sceneProp:set"] = { states: ["scene"], async run(c) {
    await ui(`${openSpModal} m.setValue(document.querySelector('[data-scene-prop=color] input[type=color]'), "#00ff00", "color input");`);
    c.green = await waitPixel(SC[0], SP_GREEN);
    c.barsBefore = await ui(`return !!document.querySelector('[data-scene-prop=bars]');`);
    await ui(`m.setCheck(document.querySelector('[data-scene-prop=clock] input[type=checkbox]'), false, "clock");`);
    c.barsHidden = await waitFor(() => ui(`return !document.querySelector('[data-scene-prop=bars]');`), 4000, 100);
    c.workerOk = await waitFor(async () => (await workersProbe()).find((w) => w.path === SC[0])?.properties?.color?.ok === true, 4000, 100);
    await sleep(400); await ui(`m.closeModal();`);
  }, check(c) {
    const v = [];
    if (!c.green) v.push("s1 didn't turn green live");
    if (!c.workerOk) v.push("s1's worker never answered the colour (workers.properties.color.ok)");
    if (!c.barsBefore || !c.barsHidden) v.push(`"Bars" (condition clock.value): shown before ${c.barsBefore}, hidden after clock off ${c.barsHidden}`);
    const ix = spIndex();
    if (ix?.color !== "0 1 0" || ix?.clock !== false || Object.keys(ix).length !== 2) v.push(`s1's index sceneProps ${JSON.stringify(ix)}, expected {"color":"0 1 0","clock":false}`);
    const sp = liveSp(c.after.st, SC[0]);
    if (JSON.stringify(spColor(sp)) !== "[0,1,0]" || sp?.clock !== false) v.push(`s1's source scene_props ${JSON.stringify(sp)}`);
    return [...v, ...samePid(c, SC[0])];
  } };
// saved before s1 opens → applied at open; switched away (s2) and back (a new source): still applied
C["sceneProp:switch"] = { states: ["scene"], switch: true,
  async pre() { await spSet("color", "0 1 0"); },
  async run(c) {
    c.atOpen = await waitPixel(SC[0], SP_GREEN);
    await ui(`m.click(m.card("s2")?.querySelector(".thumb-wrap"), "card s2");`);
    c.away = await waitSettled(12000, SC[1]);
    await ui(`m.click(m.card("s1")?.querySelector(".thumb-wrap"), "card s1");`);
    c.back = await waitSettled(12000, SC[0]);
    c.green = await waitPixel(SC[0], SP_GREEN);
  }, check(c) {
    const v = [...sceneShown(c, SC[0])];
    if (!c.atOpen) v.push("a saved colour wasn't applied when s1 opened");
    if (!c.away || !c.back) v.push(`the switches didn't settle (away ${c.away}, back ${c.back})`);
    if (!c.green) v.push("after switching away and back, s1 isn't green (not re-applied at open)");
    if (JSON.stringify(spColor(liveSp(c.after.st, SC[0]))) !== "[0,1,0]") v.push(`s1's new source scene_props ${JSON.stringify(liveSp(c.after.st, SC[0]))}`);
    return v;
  } };
// a player crash (its compositor killed → supervised restart from the snapshot, then R81's re-apply): still applied
C["sceneProp:restart"] = { states: ["scene"],
  async pre() { await spSet("color", "0 1 0"); },
  async run(c) {
    c.pid0 = (await ctl.call("hello")).pid;
    process.kill(c.pid0, "SIGKILL");
    c.up = await waitFor(async () => { const h = await ctl.call("hello").catch(() => null); return !!h && h.pid !== c.pid0; }, 10000, 150);
    c.green = await waitPixel(SC[0], SP_GREEN, 10000);
  }, check(c) {
    const v = [...sceneShown(c, SC[0])];
    if (!c.up) v.push(`no new compositor after SIGKILL of ${c.pid0}`);
    if (!c.green) v.push("after the player restart, s1 isn't green");
    if (JSON.stringify(spColor(liveSp(c.after.st, SC[0]))) !== "[0,1,0]") v.push(`s1's restored source scene_props ${JSON.stringify(liveSp(c.after.st, SC[0]))}`);
    return v;
  } };
// the modal's "Default": live back to the scene's own value (sent explicitly — LWE has no reset), dropped from the index
C["sceneProp:reset"] = { states: ["scene"],
  async pre() { await spSet("color", "0 1 0"); },
  async run(c) {
    c.atOpen = await waitPixel(SC[0], SP_GREEN);
    await ui(`${openSpModal} m.click(document.querySelector('[data-scene-prop=color] button'), "color Default");`);
    c.red = await waitPixel(SC[0], SP_RED);
    await sleep(300); await ui(`m.closeModal();`);
  }, check(c) {
    const v = [];
    if (!c.atOpen) v.push("the saved colour wasn't applied at open");
    if (!c.red) v.push("Default didn't bring s1 back to red live");
    if (spIndex() !== null) v.push(`s1's index sceneProps ${JSON.stringify(spIndex())}, expected none`);
    if (JSON.stringify(spColor(liveSp(c.after.st, SC[0]))) !== "[1,0,0]") v.push(`s1's source scene_props ${JSON.stringify(liveSp(c.after.st, SC[0]))} (the default must be sent)`);
    return [...v, ...samePid(c, SC[0])];
  } };

// Cells whose expectation waits on an owner decision: reported as KNOWN (with the reason), not FAIL.
const KNOWN = [];

// ---------------------------------------------------------------- run
// a state's entry that didn't get there: what it saw (a SETUP is usually load: the run's timing, not a product bug)
async function notReached(stateName, logAt) {
  const st = await ctl.call("state").catch(() => null);
  return { result: "SETUP", violations: [`state ${stateName} not reached`],
    seen: st && { transitions: (st.transitions || []).map((t) => `${t.corr} ${t.phase} → ${TITLE(st.graph[t.to]?.path)}`), screen: Object.values(screen(st)).map(TITLE),
      current: TITLE((await http("GET", "/current")).json?.path) }, logs: logsSince(logAt) };
}
async function runCell(stateName, ctlName) {
  const S = STATES[stateName], K_ = C[ctlName];
  const c = { state: stateName, control: ctlName, exp: { ...S.exp } };
  // where each cell's time goes (cells.jsonl `phases`, ms) — what the matrix's speed work measures against
  let tp = Date.now(); const ph = (c.phases = {}); const lap = (k) => { const n = Date.now(); ph[k] = (ph[k] ?? 0) + n - tp; tp = n; };
  [c.shown, c.other] = S.roles();
  await reset(S.playlist?.()); lap("reset");
  if (S.pre) await S.pre(c);
  if (K_.pre) await K_.pre(c); // before the UI loads: it reads overrides/settings at start, like a real session
  const logAt = logSizes();
  await S.enter(c); lap("enter");
  if (c.ok !== false) { await loadUi(); lap("ui"); }
  if (c.ok !== false && S.late) { await S.late(c); lap("enter"); }
  if (c.ok === false) return { state: stateName, control: ctlName, ...(await notReached(stateName, logAt)) };
  c.before = await snapshot(); lap("snap");
  const t0 = Date.now(); const h0 = httpLog.length;
  try { await K_.run(c); } catch (e) { return { ...c, result: "ERROR", violations: [`control failed: ${e.message}`] }; }
  lap("run");
  if (c.skip) return { ...c, result: "SKIP" };
  const a = await afterControl(c, K_, ctlName, { t0, h0, lap, logAt });
  const v = a.violations;
  const known = v.length ? KNOWN.find(([re]) => re.test(`${stateName} × ${ctlName}`))?.[1] : undefined;
  return { state: stateName, control: ctlName, result: !v.length ? "PASS" : known ? "KNOWN" : "FAIL", violations: v, known, warnings: a.warnings, phases: ph,
    target: c.target ? TITLE(c.target) : undefined, shown: c.shown ? TITLE(c.shown) : undefined,
    logs: a.logs, player: a.player, http: a.http, events: a.events };
}

// After a control ran (c.before taken; `t0` / `h0` marked as it started): settle the way the control asks, snapshot, then
// EVERY check — the oracle against the expectations (the state's, the control's `exp` / flipPause / flipMute, what its
// `run` set), the control's own `check`, the events (a failed / errored switch, a rejected property, an unexpected cancel,
// a switch from a noSwitch control), HTTP errors, the CLI's exit, and the UI's playing mark + strip against the backend.
// Shared by a matrix cell (runCell) and every fuzz step (fuzzStep).
// `fuzz`: in a chain an armed advance-on-end switch can fire ON ITS OWN mid-step (k4 is 10 s) — `rotated`. What that makes
// unknowable from outside is skipped: the control's own check (its before/after comparisons) and the "no switch" / "no
// cancel" event checks; the oracle and every other check still run.
async function afterControl(c, K_, ctlName, { t0, h0, lap, logAt, fuzz = false }) {
  // fuzz: what the page sent is answered, and a keybind's switch the playlist's tick hasn't taken yet (its
  // pending_action.txt) is taken, before the step settles and before it looks — a cell's fixed waits assume an unloaded
  // box; a chain runs long enough to meet a loaded one (a debounced persist still in flight, a next that "stayed")
  const pageQuiet = () => (fuzz ? waitFor(async () => !fs.existsSync(PENDING_ACTION) && (await js("window.__mxInflight || 0")) === 0, 4000, 50) : null);
  await pageQuiet();
  if (K_.exp) Object.assign(c.exp, K_.exp);
  if (K_.flipPause) c.exp.paused = !c.exp.paused;
  if (K_.flipMute) c.exp.muted = !(c.exp.muted ?? false);
  if (K_.switch && c.noSettle) { await sleep(1500); c.exp.settled = true; } // paused: the cut's ramps wait for the resume
  else if (K_.switch) { await sleep(400); await waitSettled(); c.exp.settled = true; } else await sleep(800);
  // fuzz: an armed advance-on-end switch fired ON ITS OWN during the step — let it land, so the checks below see where
  // it went, not its middle (mid-effect /current is already the incoming side while the screen + UI still show A)
  if (fuzz && rotatedDuring(c.before, events.filter((e) => e._t >= t0))) await waitSettled();
  await pageQuiet();
  lap("settle");
  if (!c.mid) c.exp.settled = c.exp.settled ?? !c.pending;
  if (c.mid) c.exp.settled = false;
  c.after = await snapshot(); lap("snap");
  c.evs = events.filter((e) => e._t >= t0);
  const rotated = fuzz && rotatedDuring(c.before, c.evs);
  const v = [...oracle(c.after, c.exp), ...(K_.check && !rotated ? K_.check(c, c.before, c.after) : [])];
  // a keybind's next/prev/random in a timed playlist is a file the session's 100 ms tick takes — still there after the
  // waits above: no tick takes it (the keybind did nothing)
  if (fuzz && fs.existsSync(PENDING_ACTION)) v.push(`the playlist's tick never took a keybind's "${(() => { try { return fs.readFileSync(PENDING_ACTION, "utf8").trim(); } catch { return "?"; } })()}" (pending_action.txt still there > 4 s later; /current timed=${c.after.cur?.timed})`);
  for (const e of c.evs) {
    if (e.event === "transition.failed" && !K_.expectFail) v.push(`transition.failed ${e.corr}: ${e.reason}`);
    if (e.event === "source.error" && !K_.expectFail && !(K_.allowErr && K_.allowErr(e))) v.push(`source.error ${e.source ?? ""}: ${e.reason}`);
    if (e.event === "source.rejected") v.push(`source.rejected ${e.prop}: ${e.reason}`);
    if (rotated) continue;
    if (e.event === "transition.cancelled" && !K_.switch && !K_.rearms && !ctlName.startsWith("pl") && !ctlName.startsWith("strip") && !ctlName.startsWith("trash")) v.push(`a switch was cancelled (${e.corr}, ${e.reason})`);
    if (e.event === "transition.scheduled" && K_.noSwitch) v.push(`a switch was requested (${TITLE(e.path)})`);
  }
  const asset = /\/(media|img|anim|assets|transitions)\b|favicon|icons\.svg/;
  for (const r of httpLog.slice(h0)) if (r.status >= 400 && r.status !== 409 && !asset.test(r.url)) v.push(`HTTP ${r.status} ${r.method} ${r.url.replace(U, "")}`);
  if (c.exp.settled && !c.noOutput) {
    const p = await ui(`if (!document.querySelector(".card.lib")) { m.tab("Library"); for (let i = 0; i < 40 && !document.querySelector(".card.lib"); i++) await m.sleep(50); await m.sleep(150); } return m.playing();`).catch(() => null);
    const cur = c.after.cur?.path ? TITLE(c.after.cur.path) : null;
    if (p && cur && !p.cards.includes(cur)) v.push(`UI marks ${JSON.stringify(p.cards)} as playing, backend plays ${cur}`);
  }
  // the strip the UI shows == the backend's playlist (a stale strip saves itself back over it)
  const strip = await ui(`if (!document.querySelector(".card.lib")) { m.tab("Library"); for (let i = 0; i < 40 && !document.querySelector(".card.lib"); i++) await m.sleep(50); await m.sleep(150); } return [...document.querySelectorAll(".pl-item")].map((e) => e.title);`).catch(() => null);
  const want = (c.after.ps?.videoPaths || []).map(TITLE);
  if (strip && JSON.stringify(strip) !== JSON.stringify(want)) v.push(`UI strip ${JSON.stringify(strip)}, backend playlist ${JSON.stringify(want)}`);
  if (c.cli && c.cli.code !== 0) v.push(`--action exit ${c.cli.code} (${c.cli.ms} ms): ${c.cli.out.trim().slice(0, 200)}`);
  // load-dependent (the owner's desktop shares the machine): a warning with the CLI's own phase line, not a FAIL
  const warnings = c.cli && c.cli.code === 0 && c.cli.ms > 3000 ? [`--action took ${c.cli.ms} ms: ${c.cli.out.trim().slice(0, 300)}`] : undefined;
  lap("post");
  // a failed switch: the player's own story of it (ctl logs {corr}) + what each source was doing, while the stack lives
  let player;
  const failed = v.length && c.evs.find((e) => e.event === "transition.failed");
  if (failed) player = {
    logs: ((await ctl.call("logs", { corr: failed.corr, limit: 120 }).catch(() => null))?.events || [])
      .map((e) => `${e.t_mono_ms?.toFixed(0)} ${e.comp} ${e.kind} ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !["t_mono_ms", "t_wall", "comp", "kind", "corr", "level"].includes(k))))}`.slice(0, 400)),
    warns: ((await ctl.call("logs", { min_level: "warn", limit: 40 }).catch(() => null))?.events || []).map((e) => `${e.t_mono_ms?.toFixed(0)} ${e.kind} ${JSON.stringify(e).slice(0, 300)}`),
    sources: await ctl.call("probe", { name: "sources" }).catch((e) => String(e)),
    source: ((await ctl.call("logs", { kind_prefix: "source.", limit: 300 }).catch(() => null))?.events || [])
      .filter((e) => e.kind !== "source.position").map((e) => `${e.t_mono_ms?.toFixed(0)} ${e.kind} ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !["t_mono_ms", "t_wall", "comp", "kind", "level"].includes(k))))}`.slice(0, 300)),
  };
  return { violations: v, warnings, player, rotated,
    logs: v.length ? logsSince(logAt) : undefined,
    http: v.length ? httpLog.slice(h0).filter((r) => !asset.test(r.url)).map((r) => `+${r.t - t0}ms ${r.method} ${r.url.replace(U, "")} ${r.status}`) : undefined,
    events: v.length || rotated ? c.evs.map((e) => `+${e._t - t0}ms ${e.event} ${e.corr ?? ""} ${e.path ? TITLE(e.path) : ""} ${e.reason ?? ""} ${e.effect_id ?? ""}${e.align ? ` align:${e.align}` : ""}`.trim()) : undefined };
}
// an armed align:end switch (advance-on-end) fired on its own around this step: in flight when it began, or started /
// handed off / done during it
const alignOf = (corr) => events.find((e) => e.event === "transition.scheduled" && e.corr === corr)?.align;
function rotatedDuring(before, evs) {
  if ((before.st.transitions || []).some((t) => t.phase !== "waiting_start" && t.phase !== "done" && alignOf(t.corr) === "end")) return true;
  return evs.some((e) => (e.event === "transition.started" || e.event === "transition.handoff" || e.event === "transition.done") && alignOf(e.corr) === "end");
}

// ================================================================ fuzz: random chains of controls (test-ui-matrix.sh --fuzz)
// A cell runs ONE control from a fresh state; bugs keep turning up at combinations nobody listed. A fuzz run enters a
// random start state (the matrix's own, minus the opt-in ones), then applies LIASCAPE_FUZZ_STEPS controls picked at random —
// a seeded PRNG (LIASCAPE_FUZZ_SEED + the run's index → the same picks) — from the ones eligible in the state the stack is in
// NOW, and after EACH step runs every check a cell runs (afterControl). A run stops at its first failing step.
//   - The state a step sees is DERIVED from what runs (fuzzContext): its label (a STATES name, by precedence idle >
//     noOutput > pausedEffect > effect > paused > muted > pending(Global) > playlist(Global) > single — a control's
//     `states` must list it; an unrestricted control runs under every label: the matrix leaves its opt-in states to the
//     controls that list them only to bound its size), the roles (shown = on screen / the outgoing A, other = the
//     incoming B / the armed B / the strip's next / an off-screen item) and the flags the checks read (playlist, pending
//     = advance-on-end, fresh = at the session's first history item, mid = mid-effect, cutsOk = a transition is off).
//   - The EXPECTATIONS carry across steps instead: paused / muted go from the start state's `exp` through every control's
//     exp / flipPause / flipMute / what its run set, exactly as in a cell — a pause or mute silently lost still fails;
//     noOutput holds for the whole run.
//   - A control's `pre` (its fixture — an override, a saved playlist, a setting — written over HTTP BEFORE the UI loads
//     in a cell) runs right before its step, then the UI reloads: the backend pushes none of those writes to the page.
//   - Between steps the page goes back to the Library tab with no selection: a cell starts on a fresh page, and a
//     leftover Ctrl+click selection makes a later card action repeat to every selected card.
// LIASCAPE_FUZZ_REPLAY='<state>:<c1>,<c2>,…' reruns exactly that sequence (what a failure prints), eligibility unchecked.
// The seed reproduces a run's picks while the states it passes through derive the same (a natural advance-on-end switch
// can land a step earlier or later under load); the replay is exact. Results: <LIASCAPE_OUT>/fuzz.jsonl, one record per run.
//
// Which controls a chain may use, and when — the first matching rule wins; every other control: any step its `states`
// allow.  exclude: never.  last: only as a run's LAST step — what it leaves behind, the later controls' expectations
// can't follow.  when(x): only while x (the derived context) holds — the control's drive or check assumes a starting
// value.  shrinks: takes an item out of the strip — only while it holds ≥ 3 (never below 2: a one-item playlist has
// nowhere to go next, an empty one isn't specified).  removes(x): the item it takes out — when that's what a running
// playlist plays, only as the last step (the backend goes on from the removed item's old place, which no later "the
// strip's next" expectation can know).
const sameIds = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ownTr = (x, ids, ms) => x.ps.transitionEnabled !== false && sameIds(x.ps.transitionEffectIds, ids) && (ms === undefined || x.ps.transitionDurationMs === ms);
const gTrOn = (x) => x.s.globalTransitionEnabled !== false;
const notInStrip = (x) => K.some((p) => !x.strip.includes(p));
// an item control's check wants its value saved as the item's own — one equal to the global is saved as "follows the
// global" instead (LibraryService.SaveVolumeOverride/SaveSpeedOverride), so only while the global is something else
const offGlobal = (vol, spd) => (x) => (vol === undefined || ![].concat(vol).includes(x.s.volume)) && (spd === undefined || Math.abs(x.s.speed - spd) > 1e-6);
const FUZZ_RULES = [
  [/^race:|^plState:partial$/, { exclude: "backend-only HTTP stress (no UI) that rewrites the playlist / index under the run" }],
  [/^apply:broken$/, { exclude: "a switch that FAILS on purpose (expectFail): its transition.failed would fail every later step" }],
  [/[sS]cene|^vram:|^settings:vram|^next:[sv]→/, { exclude: "the scene controls: scene support on + their own scene fixtures (a crashing scene, the fake VRAM probe, a backend restart)" }],
  [/autoMute/, { exclude: "synthetic streams on the private audio server + Auto-Mute's delays outlive a step" }],
  [/^shuffle:/, { exclude: "their own idle / playlist4 fixtures (a 4-item playlist, 12-switch chains)" }],
  [/^set:normalizeFresh$/, { exclude: "forgets every measurement in the index file + a 30 s backfill" }],
  [/^restart:/, { exclude: "restarts the backend under the page (their own fixtures: an item added on disk, a held request, a file:// page)" }],
  [/^(playlist|global):(minPlay|maxPlay)/, { exclude: "timed against the pending fixture's k4 (10 s, fresh); a limit left set reshapes every later step's rotation" }],
  [/^(trash:|selTrash:|selRange\+Delete$)/, { last: "trashed items stay gone — the later controls name k1..k4's cards" }],
  [/^plShuffle$/, { last: "a shuffled order makes every later 'the strip's next' expectation (armedCheck, *+next) unknowable" }],
  [/^(plInterval|plIntervalZero|plAdvanceRelabel|gInterval8s|gAdvanceRelabel|seq:pause\+plInterval)$/, { last: "leaves a 4–8 s rotation switching on its own between the later steps" }],
  [/-keep$/, { last: "KeepPauseOnSwitch stays on — every later switch from a pause expects it to resume" }],
  [/^cli:volume-(up|down):global$/, { last: "VolumeKeyTarget stays global — the later volume keys expect auto", when: (x) => offGlobal(30)(x) }], // its pre: own 30
  [/^cli:volume-(up|down):item$/, { last: "VolumeKeyTarget stays item — the later volume keys expect auto",
    when: (x) => [x.cur, x.shown, x.other].every((p) => !p || x.ownVol(p) == null) }], // its check: nothing live had its own volume
  [/^(plTrEffect|seq:plTrEffect\+next)$/, { when: (x) => ownTr(x, ["fade"]) }], // the drive toggles Crosswarp on + Fade off
  [/^(plTr(Duration|Short|Zero)|seq:plTr(Duration|Short|Zero)\+next)$/, { when: (x) => x.ps.transitionEnabled !== false }], // a cut has no duration
  // in `pending` their check wants the pending fixture's own fade 600 untouched; in `pendingGlobal` the globals on
  [/^gTrEffect$/, { when: (x) => (x.label === "pending" ? ownTr(x, ["fade"], 600) : gTrOn(x) && sameIds(x.s.globalTransitionEffectIds, ["fade"])) }],
  [/^(gTrOff|gTrDuration|gTrShort|gTrZero|gMethodFrozen)$/, { when: (x) => (x.label === "pending" ? ownTr(x, ["fade"], 600) : gTrOn(x)) }],
  [/^seq:plOverrideOn\+advanceOn$/, { when: (x) => ownTr(x, ["fade"], PS().transitionDurationMs) }], // its check: PS()'s own transition
  [/^plAdvanceOff$/, { when: (x) => x.ps.overrideGlobalSettings !== false }], // the modal's checkbox is disabled while the playlist follows the globals
  [/^(selToggle:add|cardToggle:add)$/, { when: notInStrip }], // adds an item the strip doesn't hold
  [/^selToggle:remove$/, { when: notInStrip, shrinks: true, removes: (x) => x.other }],
  [/^(stripRemove|stripRemoveMenu):(shown|other|off)$/, { shrinks: true, removes: (x, n) => removeTarget(x, n.split(":")[1]) }],
  [/^cardToggle:shown$/, { shrinks: true, removes: (x) => x.shown }],
  [/^seq:stripRemove\+next:/, { shrinks: true }],
  [/^seq3:stripRemove\+trashUndo\+next$/, { shrinks: true }], // removes one, then trashes what plays: needs a survivor after both
  // Settings → "Mute audio" on disables the Volume slider and "Normalize audio" (and hides the target): their drive
  // would click a disabled input
  [/^(set:volume|globalDragVol|seq:set:volume\+next|set:normalize(On|Off|Target)|seq:set:normalizeOn\+next)$/, { when: (x) => !x.s.noAudio }],
  [/^itemVol:/, { when: offGlobal(37) }], [/^itemSpd:/, { when: offGlobal(undefined, 1.7) }], [/^stripVol:/, { when: offGlobal(42) }],
  [/^itemVolDrag:/, { when: offGlobal(20) }], [/^itemSpdDrag:/, { when: offGlobal(undefined, 2.6) }], [/^itemVolDragEsc:/, { when: offGlobal(30) }],
  [/^selVol:/, { when: offGlobal(33) }], [/^seq:itemVolDrag\+next:/, { when: offGlobal(25) }], [/^seq:itemSpdDrag\+next:/, { when: offGlobal(undefined, 2.2) }],
  [/^seq3:pause\+itemVolDrag\+resume$/, { when: offGlobal(25) }], [/^seq:previewDrag\+reopen$/, { when: offGlobal(undefined, 1.8) }],
  [/^cli:volume-(up|down):overridden$/, { when: offGlobal(30) }], [/^cli:volume-up:modalOpen$/, { when: offGlobal([30, 35]) }], // their pre: own 30
];
const fuzzRule = (n) => (FUZZ_RULES.find(([re]) => re.test(n)) || [null, {}])[1];
function fuzzEligible(n, x, last) {
  const r = fuzzRule(n), states = C[n].states;
  if (r.exclude || (r.last && !last)) return false;
  if (states && !states.includes(x.label)) return false;
  if (r.when && !r.when(x)) return false;
  if (r.shrinks && x.strip.length < 3) return false;
  if (r.removes && !last && x.playlist && r.removes(x, n) === x.cur) return false;
  return true;
}

// what runs now, as a control sees it (see above)
const TIMED = path.join(path.dirname(E.LIASCAPE_USER_MUTE), "timed_state.json"); // the backend's timed-playlist session (history, mode)
const PENDING_ACTION = path.join(path.dirname(E.LIASCAPE_USER_MUTE), "pending_action.txt"); // a next/prev/random the tick hasn't taken
const readTimed = () => { try { return JSON.parse(fs.readFileSync(TIMED, "utf8")); } catch { return null; } };
function fuzzContext(snap, fz) {
  const { st } = snap, trs = st.transitions || [];
  const pathOf = (id) => st.graph[id]?.path ?? null;
  const midT = trs.find((t) => (t.phase === "running" || t.phase === "handoff") && (t.from || []).length > 0);
  const armedT = trs.find((t) => t.phase === "waiting_start");
  const paused = !!st.graph.player?.paused;
  // with no output nothing is "shown", so /current is null: what plays is the session's own bookkeeping then
  const live = !!snap.cur?.path || (fz.noOutput && sourcesOf(st).length > 0);
  const playlist = live && !!snap.cur?.timed;
  const ts = playlist ? readTimed() : null;
  const pending = playlist && !!ts?.AdvanceOnVideoEnd;
  const hi = ts ? (ts.WaitingForVideoEnd && ts.HistoryIndex > 0 ? ts.HistoryIndex - 1 : ts.HistoryIndex) : -1; // PlayerHelper.PlayingHistoryIndex
  const cur = snap.cur?.path ?? (live ? (playlist ? ts?.History?.[hi] : snap.s.lastSession?.paths?.[0]) ?? null : null);
  const strip = snap.ps?.videoPaths || [], ps = snap.ps?.settings || {}, own = ps.overrideGlobalSettings !== false;
  let shown = cur, other = null;
  if (midT) { other = pathOf(midT.to) ?? cur; shown = [...midT.from.map(pathOf), ...sourcesOf(st).map(([, n]) => n.path)].find((p) => p && p !== other) ?? cur; }
  else if (armedT) other = pathOf(armedT.to);
  else if (playlist) other = succ(strip, cur);
  if (!live) shown = other = null;
  else if (!other || other === shown) other = [K[2], K[1], K[3], K[0]].find((p) => p !== shown);
  const label = !live ? "idle" : fz.noOutput ? "noOutput" : midT ? (paused ? "pausedEffect" : "effect") : paused ? "paused" : snap.muted ? "muted"
    : pending && armedT ? (own ? "pending" : "pendingGlobal") : playlist ? (own ? "playlist" : "playlistGlobal") : "single";
  return { label, cur, shown, other, playlist, pending, fresh: playlist && hi === 0, mid: !!midT, strip, ps, s: snap.s, before: snap,
    ownVol: (p) => (snap.lib || []).find((i) => i.videoPath === p)?.volumeOverride ?? null,
    cutsOk: snap.s.globalTransitionEnabled === false || ps.transitionEnabled === false };
}
// a page (re)load in a chain: the Settings view is a lazy chunk, loaded on its first visit — under load that took past
// the 500 ms a Settings control waits ("not found: Speed" after a reload). Load it once now, back on the Library tab.
async function loadUiFuzz() {
  await loadUi();
  await ui(`m.tab("Settings"); for (let i = 0; i < 100 && !document.querySelector(".settings .srow"); i++) await m.sleep(50);
    m.tab("Library"); for (let i = 0; i < 40 && !document.querySelector(".card.lib"); i++) await m.sleep(50); await m.sleep(150);`).catch(() => {});
}
// between steps: the Library tab, no selection (a click on the grid's background clears it)
const tidyUi = () => ui(`if (!document.querySelector(".card.lib")) { m.tab("Library"); for (let i = 0; i < 40 && !document.querySelector(".card.lib"); i++) await m.sleep(50); await m.sleep(150); }
  const g = document.querySelector(".lib-scroll .grid"); if (g) { g.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await m.sleep(80); }`).catch(() => {});

async function fuzzStep(name, x, fz) {
  const K_ = C[name];
  const c = { state: x.label, control: name, exp: { ...fz.exp }, shown: x.shown, other: x.other, playlist: x.playlist, pending: x.pending,
    fresh: x.fresh, mid: x.mid, noOutput: fz.noOutput, cutsOk: x.cutsOk, before: x.before };
  let tp = Date.now(); const ph = {}; const lap = (k) => { const n = Date.now(); ph[k] = (ph[k] ?? 0) + n - tp; tp = n; };
  const base = { control: name, state: x.label, shown: x.shown ? TITLE(x.shown) : undefined, other: x.other ? TITLE(x.other) : undefined, phases: ph };
  const logAt = logSizes();
  if (K_.pre) { await K_.pre(c); await loadUiFuzz(); c.before = await snapshot(); lap("pre"); }
  await tidyUi(); lap("tidy");
  const t0 = Date.now(), h0 = httpLog.length;
  try { await K_.run(c); } catch (e) { return { ...base, result: "ERROR", violations: [`control failed: ${e.message}`] }; }
  lap("run");
  if (c.skip) return { ...base, result: "SKIP", skip: c.skip };
  const a = await afterControl(c, K_, name, { t0, h0, lap, logAt, fuzz: true });
  fz.exp = { paused: c.exp.paused, muted: c.exp.muted };
  return { ...base, result: a.violations.length ? "FAIL" : "PASS", violations: a.violations.length ? a.violations : undefined, rotated: a.rotated || undefined,
    warnings: a.warnings, target: c.target ? TITLE(c.target) : undefined, exp: { ...fz.exp },
    after: { cur: TITLE(c.after.cur?.path ?? null), strip: (c.after.ps?.videoPaths || []).map(TITLE), paused: !!c.after.st.graph.player?.paused, muted: c.after.muted },
    logs: a.logs, player: a.player, http: a.http, events: a.events };
}

const FUZZ_STARTS = Object.keys(STATES).filter((s) => !STATES[s].optIn);
const FUZZ_POOL = Object.keys(C).filter((n) => !fuzzRule(n).exclude);
// mulberry32 — one stream per (seed, run), so a run's picks don't depend on how the runs are split across shards
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const runRng = (seed, run) => prng((Math.imul(seed >>> 0, 0x9E3779B1) ^ Math.imul(run + 1, 0x85EBCA77)) >>> 0);
const pickOf = (rng, list) => list[Math.floor(rng() * list.length)];
function parseReplay(s) {
  const i = s.indexOf(":"), state = i < 0 ? s : s.slice(0, i);
  const controls = i < 0 ? [] : s.slice(i + 1).split(",").map((n) => n.trim()).filter(Boolean);
  if (!STATES[state]) throw new Error(`--fuzz-replay: no state "${state}" (${Object.keys(STATES).join(", ")})`);
  for (const n of controls) if (!C[n]) throw new Error(`--fuzz-replay: no control "${n}"`);
  return { state, controls };
}

async function fuzzRun({ run, seed, steps, replay }) {
  const rng = replay ? null : runRng(seed, run);
  const start = replay ? replay.state : pickOf(rng, FUZZ_STARTS);
  const S = STATES[start];
  const rec = { seed, run, shard: E.LIASCAPE_SHARD || undefined, start, sequence: [], steps: [] };
  const t0 = Date.now();
  const c0 = { state: start, exp: { ...S.exp } };
  [c0.shown, c0.other] = S.roles();
  const logAt = logSizes();
  await reset(S.playlist?.());
  if (S.pre) await S.pre(c0);
  await S.enter(c0);
  if (c0.ok !== false) await loadUiFuzz();
  if (c0.ok !== false && S.late) await S.late(c0);
  rec.setupMs = Date.now() - t0;
  if (c0.ok === false) return { ...rec, ...(await notReached(start, logAt)), replay: `${start}:` };
  const fz = { exp: { paused: S.exp.paused, muted: S.exp.muted }, noOutput: !!c0.noOutput };
  const n = replay ? replay.controls.length : steps;
  console.log(`---- run ${run}${replay ? " (replay)" : ` (seed ${seed})`}: ${start}`);
  for (let k = 0; k < n; k++) {
    let x, name, r;
    try {
      x = fuzzContext(await snapshot(), fz);
      if (replay) name = replay.controls[k];
      else {
        const pool = FUZZ_POOL.filter((m) => fuzzEligible(m, x, k === n - 1));
        if (!pool.length) { rec.stopped = `no eligible control under ${x.label}`; break; }
        name = pickOf(rng, pool);
      }
      rec.sequence.push(name);
      r = await fuzzStep(name, x, fz);
    } catch (e) { r = { control: name, state: x?.label, result: "ERROR", violations: [String((e && e.stack) || e)] }; }
    rec.steps.push(r);
    console.log(`  ${String(k + 1).padStart(2)}/${n} ${r.result.padEnd(5)} [${r.state}] ${name}${r.skip ? ` (skip: ${r.skip})` : ""}${r.rotated ? " (an advance-on-end switch fired in the step: its own check skipped)" : ""}`);
    if (r.result === "FAIL" || r.result === "ERROR") { rec.failedAt = k; break; }
  }
  rec.result = rec.failedAt === undefined ? "PASS" : rec.steps[rec.failedAt].result;
  rec.replay = `${start}:${rec.sequence.join(",")}`;
  return rec;
}

async function fuzzMain() {
  const seed = Number(E.LIASCAPE_FUZZ_SEED || 0) >>> 0, steps = Number(E.LIASCAPE_FUZZ_STEPS || 0), runs = Number(E.LIASCAPE_FUZZ_RUNS || 1);
  const replay = E.LIASCAPE_FUZZ_REPLAY ? parseReplay(E.LIASCAPE_FUZZ_REPLAY) : null;
  const out = fs.createWriteStream(path.join(OUT, "fuzz.jsonl"));
  // normalization's controls find every clip measured (their `pre` is then instant)
  if (!(await measureAll())) console.log("(the clips weren't measured in 30 s — the normalization steps report it)");
  const plan = replay ? [{ run: 0, replay }] : [...Array(runs).keys()].filter((r) => !SHARD || r % SHARD[1] === SHARD[0]).map((run) => ({ run, seed, steps }));
  const results = [];
  for (const p of plan) {
    let r; const t0 = Date.now();
    try { r = await fuzzRun(p); } catch (e) { r = { seed: p.seed, run: p.run, result: "ERROR", sequence: [], steps: [], violations: [String((e && e.stack) || e)] }; }
    r.ms = Date.now() - t0;
    results.push(r); out.write(JSON.stringify(r) + "\n");
    const fail = r.failedAt !== undefined ? r.steps[r.failedAt] : null;
    console.log(`${r.result.padEnd(5)} run ${r.run}${replay ? "" : ` (seed ${r.seed})`}: ${[r.start, ...r.sequence].join(" → ")}${r.stopped ? ` (stopped: ${r.stopped})` : ""}`
      + (r.result === "PASS" ? "" : (fail ? `\n        at step ${r.failedAt + 1}: [${fail.state}] ${fail.control}` : "")
        + ((fail?.violations ?? r.violations) || []).map((v) => `\n        - ${v}`).join("")
        + (r.replay ? `\n        replay: scripts/test-ui-matrix.sh --fuzz-replay '${r.replay}'` : "")));
  }
  out.end();
  const n = (x) => results.filter((r) => r.result === x).length;
  console.log(`FUZZ runs=${results.length} pass=${n("PASS")} fail=${n("FAIL")} error=${n("ERROR")} setup=${n("SETUP")} steps=${results.reduce((a, r) => a + (r.steps || []).length, 0)}${replay ? " (replay)" : ` seed=${seed}`}`);
  await reset().catch(() => {});
  app.exit(n("FAIL") + n("ERROR") + n("SETUP") ? 1 : 0);
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onCompleted({ urls: ["<all_urls>"] }, (d) => httpLog.push({ url: d.url, method: d.method, status: d.statusCode, t: Date.now() }));
  // SHOWN (on the private Xvfb — nothing reaches the session's display) and focused, like the real app: a
  // hidden window renders no frames — requestAnimationFrame never fires, so framer-motion/WAAPI animations
  // never finish (an exiting modal stayed in the DOM), dnd-kit's drop never lands (pointermoves are
  // rAF-aligned: they coalesced and the drop saw a stale target) and gifs/the live bg stayed paused (unfocused)
  win = new BrowserWindow({ show: !E.LIASCAPE_MATRIX_HIDDEN, x: 0, y: 0, width: 1400, height: 900, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  win.focus();
  subscribe();
  BASE_SETTINGS = await getSettings();
  if (E.LIASCAPE_FUZZ_STEPS || E.LIASCAPE_FUZZ_REPLAY) return fuzzMain();
  const out = fs.createWriteStream(path.join(OUT, "cells.jsonl"));
  const results = [];
  let idx = -1;
  for (const st of Object.keys(STATES)) for (const k of Object.keys(C)) {
    const name = `${st} × ${k}`;
    if (ONLY && !ONLY.test(name)) continue;
    if (C[k].states ? !C[k].states.includes(st) : STATES[st].optIn) continue;
    if (SHARD && ++idx % SHARD[1] !== SHARD[0]) continue;
    let r; const t0 = Date.now();
    try { r = await runCell(st, k); } catch (e) { r = { state: st, control: k, result: "ERROR", violations: [String(e && e.stack || e)] }; }
    r.ms = Date.now() - t0;
    results.push(r); out.write(JSON.stringify(r) + "\n");
    console.log(`${r.result.padEnd(5)} ${name}${r.violations?.length ? "\n        - " + r.violations.join("\n        - ") : ""}${r.warnings?.length ? "\n        ! " + r.warnings.join("\n        ! ") : ""}`);
  }
  out.end();
  const n = (x) => results.filter((r) => r.result === x).length;
  console.log(`MATRIX pass=${n("PASS")} fail=${n("FAIL")} error=${n("ERROR")} skip=${n("SKIP")} setup=${n("SETUP")} known=${n("KNOWN")}`);
  await reset().catch(() => {});
  app.exit(n("FAIL") + n("ERROR") + n("SETUP") ? 1 : 0);
});
