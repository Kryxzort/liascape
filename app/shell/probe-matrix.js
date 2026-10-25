// UI × player-state matrix driver (run by scripts/test-ui-matrix.sh, which builds the hermetic stack:
// a private backend + headless lp-player + the UI bundle served by that backend). For every cell
// (state × control): reset everything to a baseline, reload the UI, bring the player into the state
// through the backend, operate the control through the real DOM (or a `--action=` keybind), then check
// with the ORACLE what every live source of the player runs:
//   gain.user / speed   = the source's OWN item's override ?? the global setting (whatever else is live)
//   no_audio, hwdec, fps_cap, cache, demuxer_*, af = the globals; gain.mute = the user mute
//   every main layer's fit = VideoScale; player.paused = what the cell expects
//   the backend's /current, the screen (cur:*) and the UI's "playing" marker agree (when settled)
//   no transition.failed / source.error / source.rejected; no unexpected cancel; no HTTP error
// plus each control's own expectation. Output: <LP_OUT>/cells.jsonl + a summary; exit 1 on any FAIL.
const { app, BrowserWindow, session } = require("electron");
const net = require("net");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const E = process.env;
const U = E.LP_URL;
const K = JSON.parse(E.LP_CLIPS); // library videoPaths of k1..k4 (k4 is the short one)
const OUT = E.LP_OUT;
const ONLY = E.LP_ONLY ? new RegExp(E.LP_ONLY) : null;
// `i/N` (test-ui-matrix.sh --jobs N runs N hermetic stacks in parallel): this instance runs the cells whose
// index in the (--only filtered) cell list is ≡ i mod N — state-major order, so every shard gets a slice of
// every state
const SHARD = E.LP_SHARD ? E.LP_SHARD.split("/").map(Number) : null;
const TITLE = (p) => (K.indexOf(p) >= 0 ? `k${K.indexOf(p) + 1}` : String(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// (test-ui-matrix.sh runs it on a private Xvfb: --ozone-platform=x11 --disable-gpu)
app.setPath("userData", path.join(OUT, "electron-user-data"));

// ---------------------------------------------------------------- player socket (requests + events)
function ctlClient() {
  let sock = null, buf = "", id = 0;
  const pend = new Map();
  const connect = () => new Promise((res, rej) => {
    const s = net.createConnection(E.LP_PLAYER_SOCKET, () => { sock = s; res(); });
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
  const s = net.createConnection(E.LP_PLAYER_SOCKET);
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
  return new Promise((res) => cp.execFile(E.LP_DOTNET, [E.LP_DLL, `--action=${action}`], { timeout: 40000 }, (err, out, errOut) =>
    res({ code: err ? err.code ?? (err.killed ? `killed (${err.signal}) after ${Date.now() - t0} ms` : 1) : 0, out: String(out) + String(errOut), ms: Date.now() - t0 })));
}

// ---------------------------------------------------------------- oracle
const VolumeDb = (p) => (p <= 0 ? -96 : Math.min(12, Math.max(-96, 60 * Math.log10(p / 100))));
const near = (a, b, eps = 0.02) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= eps;
async function snapshot() {
  const [st, s, lib, cur, ps] = [await ctl.call("state"), await getSettings(), (await http("GET", "/library")).json,
    (await http("GET", "/current")).json, (await http("GET", "/playlist/state")).json];
  return { st, s, lib, cur, ps, muted: fs.existsSync(E.LP_USER_MUTE) };
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
    if (!near(gm, snap.muted ? -96 : 0, 0.5)) v.push(`${who} gain.mute ${gm} but user mute is ${snap.muted ? "on" : "off"}`);
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
  // record what the page POSTs to /preview (its bodies — the backend only sees what arrives)
  await js(`(() => { window.__mxReq = []; const f = window.fetch; window.fetch = (u, o) => { if (String(u).includes("/preview")) window.__mxReq.push(o?.body ?? null); return f(u, o); }; })(); true`);
  for (let i = 0; i < 100; i++) { if (await js(`document.querySelectorAll('.card.lib').length`) >= 4) break; await sleep(100); }
  await js(PAGE);
  await sleep(300);
}
const ui = (code) => js(`(async () => { const m = window.__mx; ${code} })()`);

// per-cell log excerpts (backend + adapter), attached to a FAIL
const LOGS = [E.LP_BACKEND_LOG, E.LP_ADAPTER_LOG].filter(Boolean);
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
const PS = (o = {}) => ({ order: 0, overrideGlobalSettings: true, intervalSeconds: 600, advanceOnVideoEnd: false, waitForVideoEnd: false,
  transitionEnabled: true, transitionEffectIds: ["fade"], transitionDurationMs: 2500, transitionDurationMaxMs: 0, transitionShuffle: false, ...o });
async function reset(pl) {
  const st = await ctl.call("state");
  for (const [name, w, h] of [["VIRTUAL-1", 640, 360], ["VIRTUAL-2", 320, 180]])
    if (!st.outputs.some((o) => o.name === name)) await ctl.call("headless.add_output", { name, width: w, height: h, hz: 60 }).catch(() => {});
  await post("/stop"); await sleep(300);
  await post("/mute", { user: true, value: false });
  while (((await http("GET", "/library/undo-depth")).json?.depth ?? 0) > 0) await post("/library/undo");
  await post("/settings", BASE_SETTINGS);
  for (const p of K) { await post("/library/volume", { path: p, intValue: null }); await post("/library/speed", { path: p, doubleValue: null }); }
  await post("/playlist/state", { videoPaths: pl?.paths ?? [K[0], K[1], K[2]], settings: pl?.settings ?? PS(), name: null });
  await waitSettled(4000);
}
const PENDING_PL = () => ({ paths: [K[3], K[0], K[1]], settings: PS({ advanceOnVideoEnd: true, transitionDurationMs: 600 }) });
const STATES = {
  // roles: which item is on screen (`shown`) and which other item is live in the state (`other`: the
  // incoming B of an effect, the pending B of an end-wait) or, with nothing else live, an off-screen one
  idle: { exp: { paused: false }, roles: () => [null, null], async enter() {} },
  single: { exp: { paused: false }, roles: () => [K[0], K[2]], async enter(c) { await post("/apply", { path: K[0] }); c.ok = await waitSettled(12000, K[0]); } },
  playlist: { exp: { paused: false }, roles: () => [K[0], K[1]], async enter(c) { c.playlist = true; c.fresh = true;
    await post("/playlist/play", { paths: [K[0], K[1], K[2]], settings: PS() }); c.ok = await waitSettled(12000, K[0]); } },
  // A → B with both live (from non-empty — never a fade in from nothing)
  effect: { exp: { paused: false }, roles: () => [K[0], K[1]], async enter(c) {
    await STATES.playlist.enter(c); if (c.ok === false) return;
    c.fresh = false; await post("/next"); c.ok = await waitFor(async () => (await live()).some((t) => t.phase === "running" && (t.from || []).length > 0), 8000, 50); c.mid = true; } },
  pending: { exp: { paused: false }, roles: () => [K[3], K[0]], playlist: PENDING_PL, async enter(c) { c.playlist = true; c.fresh = true;
    await post("/playlist/play", PENDING_PL());
    c.ok = (await waitSettled(12000, K[3])) && (await waitFor(async () => (await live()).some((t) => t.phase === "waiting_start"), 4000, 50));
    c.pending = true; } },
  paused: { exp: { paused: true }, roles: () => [K[0], K[2]], async enter(c) { await STATES.single.enter(c); if (c.ok !== false) await post("/pause"); } },
  pausedEffect: { exp: { paused: true }, roles: () => [K[0], K[1]], async enter(c) { await STATES.effect.enter(c); if (c.ok !== false) await post("/pause"); } },
  noOutput: { exp: { paused: false }, roles: () => [K[0], K[2]], async enter(c) {
    await STATES.single.enter(c); if (c.ok === false) return;
    await ctl.call("headless.remove_output", { name: "VIRTUAL-1" }); await ctl.call("headless.remove_output", { name: "VIRTUAL-2" }); c.noOutput = true; } },
  muted: { exp: { paused: false, muted: true }, roles: () => [K[0], K[2]], async enter(c) { await STATES.single.enter(c); if (c.ok !== false) await post("/mute", { user: true, value: true }); } },
};

// ---------------------------------------------------------------- controls
// Each: { run(c) → void, settle: "short"|"switch", check?(c, before, after) → violations[], states? }
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
    if (v.length) v.push(`preview bodies: ${JSON.stringify((c.previewBodies || []).slice(0, 3).map((b) => String(b).replace(/\/tmp\/lpmx-[^/]+\/home\/.local\/share\/livepaper\/library\/imported\/[^/]+\//g, "")))}`);
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
// switches
C["cardApply"] = { switch: true, async run(c) { c.target = K[2] === c.shown ? K[1] : K[2]; await ui(`m.click(m.card(${JSON.stringify(TITLE(c.target))})?.querySelector(".thumb-wrap"), "card");`); },
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
  check: (c) => notTargeted(c, c.target) };
C["stripRemove:shown"] = { async run(c) { c.target = c.shown; if (!c.target || !(await ui(`return !!m.strip(${JSON.stringify(TITLE(c.target))});`))) return c.skip = "not in strip";
  await ui(`m.click(m.strip(${JSON.stringify(TITLE(c.target))}).querySelector(".pl-remove"), "remove");`); await sleep(900); },
  check: (c) => notTargeted(c, c.target) };
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
  check: (c) => afterTrash(c, c.target) };
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
    return v;
  } };
// keybind volume-up, then any UI settings save: the keybind's volume must survive (the UI posts its whole copy)
C["cli:volume-up+uiSave"] = { async run(c) {
    c.cli = await cli("volume-up"); await sleep(400);
    await ui(`m.tab("Settings"); await m.sleep(500); m.setCheck(m.input("Loop"), false, "Loop");`); await sleep(900); },
  check: (c) => (c.after.s.volume === Math.min(100, c.before.s.volume + 5) ? [] : [`volume ${c.after.s.volume} after volume-up + a UI save, from ${c.before.s.volume}`]) };
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
action("volume-up", (c) => (c.after.s.volume === Math.min(100, c.before.s.volume + 5) ? [] : [`volume ${c.after.s.volume} after volume-up from ${c.before.s.volume}`]));
action("volume-down", (c) => (c.after.s.volume === Math.max(0, c.before.s.volume - 5) ? [] : [`volume ${c.after.s.volume} after volume-down from ${c.before.s.volume}`]));
// user switches — paused: KeepPauseOnSwitch off (default) resumes and switches with the transition; on
// (the `-keep` cells) stays paused and cuts to B's first frame
const stayed = (c, a) => (c.before.cur?.path && c.after.cur?.path === c.before.cur.path ? [`${a} stayed on ${TITLE(c.before.cur.path)}`] : []);
function pausedSwitch(c) {
  if (!c.wasPaused || !c.before.cur?.path || c.after.cur?.path === c.before.cur.path) return [];
  const sched = c.evs.filter((e) => e.event === "transition.scheduled");
  const last = sched[sched.length - 1];
  if (!last) return ["no switch was requested"];
  if (c.keep && last.effect_id != null) return [`a switch while paused that keeps the pause used ${last.effect_id}, not a cut`];
  if (!c.keep && !c.noOutput && last.effect_id == null) return ["a switch that resumes from a pause was a cut (transitions are on)"];
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

function expectShown(c, want, { effect }) {
  const v = [];
  if (!c.noOutput && c.after.cur?.path !== want) v.push(`expected ${TITLE(want)} on screen, /current says ${TITLE(c.after.cur?.path)}`);
  const sched = c.evs.filter((e) => e.event === "transition.scheduled");
  const mine = sched.filter((e) => e.path === want);
  if (!mine.length) v.push(`no switch to ${TITLE(want)} was requested`);
  else if (effect && !c.noOutput && mine[mine.length - 1].effect_id == null) v.push(`switch to ${TITLE(want)} was a cut (transitions are on)`);
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

// Cells whose expectation waits on an owner decision: reported as KNOWN (with the reason), not FAIL.
const KNOWN = [];

// ---------------------------------------------------------------- run
async function runCell(stateName, ctlName) {
  const S = STATES[stateName], K_ = C[ctlName];
  const c = { state: stateName, control: ctlName, exp: { ...S.exp } };
  [c.shown, c.other] = S.roles();
  await reset(S.playlist?.());
  if (K_.pre) await K_.pre(c); // before the UI loads: it reads overrides/settings at start, like a real session
  const logAt = logSizes();
  await loadUi();
  await S.enter(c);
  if (c.ok === false) return { state: stateName, control: ctlName, result: "SETUP", violations: [`state ${stateName} not reached`] };
  c.before = await snapshot();
  const t0 = Date.now(); const h0 = httpLog.length;
  try { await K_.run(c); } catch (e) { return { ...c, result: "ERROR", violations: [`control failed: ${e.message}`] }; }
  if (c.skip) return { ...c, result: "SKIP" };
  if (K_.exp) Object.assign(c.exp, K_.exp);
  if (K_.flipPause) c.exp.paused = !c.exp.paused;
  if (K_.flipMute) c.exp.muted = !(c.exp.muted ?? false);
  if (K_.switch && c.noSettle) { await sleep(1500); c.exp.settled = true; } // paused: the cut's ramps wait for the resume
  else if (K_.switch) { await sleep(400); await waitSettled(); c.exp.settled = true; } else await sleep(800);
  if (!c.mid) c.exp.settled = c.exp.settled ?? !c.pending;
  if (c.mid) c.exp.settled = false;
  c.after = await snapshot();
  c.evs = events.filter((e) => e._t >= t0);
  const v = [...oracle(c.after, c.exp), ...(K_.check ? K_.check(c, c.before, c.after) : [])];
  for (const e of c.evs) {
    if (e.event === "transition.failed") v.push(`transition.failed ${e.corr}: ${e.reason}`);
    if (e.event === "source.error") v.push(`source.error ${e.source ?? ""}: ${e.reason}`);
    if (e.event === "source.rejected") v.push(`source.rejected ${e.prop}: ${e.reason}`);
    if (e.event === "transition.cancelled" && !K_.switch && !ctlName.startsWith("pl") && !ctlName.startsWith("strip") && !ctlName.startsWith("trash")) v.push(`a switch was cancelled (${e.corr}, ${e.reason})`);
    if (e.event === "transition.scheduled" && K_.noSwitch) v.push(`a switch was requested (${TITLE(e.path)})`);
  }
  const asset = /\/(media|img|anim|assets|transitions)\b|favicon|icons\.svg/;
  for (const r of httpLog.slice(h0)) if (r.status >= 400 && r.status !== 409 && !asset.test(r.url)) v.push(`HTTP ${r.status} ${r.method} ${r.url.replace(U, "")}`);
  if (c.exp.settled && !c.noOutput) {
    const p = await ui(`if (!document.querySelector(".card.lib")) { m.tab("Library"); await m.sleep(600); } return m.playing();`).catch(() => null);
    const cur = c.after.cur?.path ? TITLE(c.after.cur.path) : null;
    if (p && cur && !p.cards.includes(cur)) v.push(`UI marks ${JSON.stringify(p.cards)} as playing, backend plays ${cur}`);
  }
  // the strip the UI shows == the backend's playlist (a stale strip saves itself back over it)
  const strip = await ui(`if (!document.querySelector(".card.lib")) { m.tab("Library"); await m.sleep(600); } return [...document.querySelectorAll(".pl-item")].map((e) => e.title);`).catch(() => null);
  const want = (c.after.ps?.videoPaths || []).map(TITLE);
  if (strip && JSON.stringify(strip) !== JSON.stringify(want)) v.push(`UI strip ${JSON.stringify(strip)}, backend playlist ${JSON.stringify(want)}`);
  if (c.cli && c.cli.code !== 0) v.push(`--action exit ${c.cli.code} (${c.cli.ms} ms): ${c.cli.out.trim().slice(0, 200)}`);
  // load-dependent (the owner's desktop shares the machine): a warning with the CLI's own phase line, not a FAIL
  const warnings = c.cli && c.cli.code === 0 && c.cli.ms > 3000 ? [`--action took ${c.cli.ms} ms: ${c.cli.out.trim().slice(0, 300)}`] : undefined;
  const known = v.length ? KNOWN.find(([re]) => re.test(`${stateName} × ${ctlName}`))?.[1] : undefined;
  return { state: stateName, control: ctlName, result: !v.length ? "PASS" : known ? "KNOWN" : "FAIL", violations: v, known, warnings,
    target: c.target ? TITLE(c.target) : undefined, shown: c.shown ? TITLE(c.shown) : undefined,
    logs: v.length ? logsSince(logAt) : undefined,
    http: v.length ? httpLog.slice(h0).filter((r) => !asset.test(r.url)).map((r) => `+${r.t - t0}ms ${r.method} ${r.url.replace(U, "")} ${r.status}`) : undefined,
    events: v.length ? c.evs.map((e) => `+${e._t - t0}ms ${e.event} ${e.corr ?? ""} ${e.path ? TITLE(e.path) : ""} ${e.reason ?? ""} ${e.effect_id ?? ""}`.trim()) : undefined };
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onCompleted({ urls: ["<all_urls>"] }, (d) => httpLog.push({ url: d.url, method: d.method, status: d.statusCode, t: Date.now() }));
  win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  subscribe();
  BASE_SETTINGS = await getSettings();
  const out = fs.createWriteStream(path.join(OUT, "cells.jsonl"));
  const results = [];
  let idx = -1;
  for (const st of Object.keys(STATES)) for (const k of Object.keys(C)) {
    const name = `${st} × ${k}`;
    if (ONLY && !ONLY.test(name)) continue;
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
