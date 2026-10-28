// Feature-health probe — `scripts/test-ui-matrix.sh --probe probe-health.js` (the matrix's hermetic stack: private
// backend + headless liascape-player + this tree's UI, on a private Xvfb). Owner: "make missing libraries fail loudly — if a
// feature won't work because of something in the build, show a warning icon" (FeatureHealth.cs, /health/features,
// Settings' WarnIcon).
//   1. the stack as built (everything present — synthetic scenes, the repo's catalogue, the fake VRAM probe, the PATH's
//      pactl/parec/ffmpeg): /health/features says ok for them, and their Settings rows carry NO warning icon
//   2. the stack with pieces missing: the stack's player quit and the backend restarted (same port) with a copy of
//      liascape-player that has no liascape-scene-worker next to it + LIASCAPE_SCENE_WORKER_BIN=/nonexistent, LIASCAPE_PLAYER_VRAM_PROBE=none,
//      LIASCAPE_TRANSITIONS_DIR = a catalogue that doesn't load, and a PATH without pactl/parec/playerctl/ffmpeg/ffprobe:
//      the endpoint reports each one not ok with its reason, every affected row shows the icon (its tooltip = the
//      reason), the control itself is still there and enabled, and the summary lists them
// Exit 1 on any FAIL. The restarted backend is recorded in LIASCAPE_BACKEND_PID_FILE for the stack's cleanup.
const { app, BrowserWindow } = require("electron");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const OUT = E.LIASCAPE_OUT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", path.join(OUT, "electron-user-data"));

async function http(method, p, body) {
  try {
    const r = await fetch(U + p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, json };
  } catch (e) { return { status: 0, json: null, error: e.message }; }
}
async function waitFor(pred, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await pred()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const procAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let win;
const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const features = async () => (await http("GET", "/health/features")).json?.features ?? null;
const byId = (fs_, id) => (fs_ || []).find((f) => f.id === id);

// the Settings page's rows: label → {warn: tooltip | null, controls (inputs/selects present + enabled)}
async function settingsRows() {
  return js(`
    const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Settings"); tab?.click();
    for (let i = 0; i < 60 && !document.querySelector(".settings .srow"); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1200)); // the page reads /health/features 300 ms after mount
    const rows = {};
    for (const r of document.querySelectorAll(".settings .srow")) {
      const label = r.querySelector(".slabel-row")?.firstChild?.textContent?.trim(); if (!label) continue;
      const w = r.querySelector("[data-feature-warn]");
      const ctl = r.querySelector(".sctl input, .sctl button, .sctl .sel");
      rows[label] = { warn: w ? w.getAttribute("title") : null, key: w?.dataset.featureWarn ?? null, control: !!ctl, enabled: !!ctl && !ctl.disabled };
    }
    const sum = document.querySelector("[data-health-summary]");
    return { rows, summary: sum ? [...sum.querySelectorAll("[data-feature]")].map((li) => li.dataset.feature) : null };`);
}

// rows a missing piece must mark, by feature id (the stack runs with AdvancedSettings on and PlayerEngine=liascape-player,
// so Hardware decoding / Transition method / the GPU section are shown)
const ROWS = {
  scenes: ["Allow scene support"],
  transitions: ["Transitions", "Transition method"],
  vram: ["Limit VRAM per scene", "When VRAM runs low"],
  "auto-mute": ["Mute when system audio plays"],
  mpris: ["Only if MPRIS player active"],
  ffmpeg: ["Normalize audio"],
};
const REASON = { scenes: /liascape-scene-worker not found/, transitions: /catalogue/, vram: /LIASCAPE_PLAYER_VRAM_PROBE=none/, "auto-mute": /pactl and parec/, mpris: /playerctl/, ffmpeg: /ffmpeg and ffprobe/ };

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  const results = [];
  const cell = async (name, fn) => {
    let v;
    try { v = await fn(); } catch (e) { v = [`ERROR ${e.message}`]; }
    results.push({ name, v });
    console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
    for (const x of v) console.log(`        - ${x}`);
  };
  const T = fs.mkdtempSync(path.join(path.dirname(E.LIASCAPE_BACKEND_LOG), "health-")); // inside the stack's dir: its cleanup takes it
  try {
    // ---- 1. everything present
    await win.loadURL(U + "/");
    const f1 = await features();
    await cell("present: /health/features ok for what the stack has", async () => {
      const v = [];
      if (!f1) return ["no /health/features answer"];
      for (const id of ["liascape-player", "scenes", "transitions", "vram", "auto-mute", "ffmpeg"]) {
        const f = byId(f1, id);
        if (!f) v.push(`${id} missing from the report`);
        else if (f.ok !== true) v.push(`${id} ok=${f.ok}: ${f.reason}`);
      }
      for (const f of f1) if (!Array.isArray(f.affects) || typeof f.label !== "string") v.push(`${f.id}: malformed ${JSON.stringify(f)}`);
      return v;
    });
    const s1 = await settingsRows();
    await cell("present: no warning icon on their rows", async () => {
      const v = [];
      for (const [id, labels] of Object.entries(ROWS)) {
        if (id === "mpris" && byId(f1, "mpris")?.ok === false) continue; // playerctl may be absent on this machine
        for (const l of labels) {
          const r = s1.rows[l];
          if (!r) v.push(`no row "${l}"`);
          else if (r.warn) v.push(`"${l}" warns although ${id} is present: ${r.warn}`);
        }
      }
      return v;
    });

    // ---- 2. pieces missing
    const bin = path.join(T, "bin"); fs.mkdirSync(bin);
    const lp = path.join(T, "liascape-bin"); fs.mkdirSync(lp);
    fs.copyFileSync(E.LIASCAPE_PLAYER_BIN, path.join(lp, "liascape-player")); fs.chmodSync(path.join(lp, "liascape-player"), 0o755); // no liascape-scene-worker beside it
    for (const t of ["sh", "setsid", "env"]) { // what the backend itself spawns through PATH (the player start)
      const w = cp.execFileSync("sh", ["-c", `command -v ${t}`]).toString().trim();
      if (w) fs.symlinkSync(fs.realpathSync(w), path.join(bin, t));
    }
    const cat = path.join(T, "transitions"); fs.mkdirSync(cat);
    fs.writeFileSync(path.join(cat, "manifest.json"), "[]"); // no wrap.vert / wrap.frag.template → the catalogue doesn't load
    // the stack's player quits (its health is what the backend would read otherwise)
    cp.spawnSync(E.LIASCAPE_PLAYER_BIN, ["ctl", "--timeout-ms", "3000", "quit"], { env: { ...E }, timeout: 8000 });
    await waitFor(() => !fs.existsSync(E.LIASCAPE_PLAYER_SOCKET), 8000, 100);
    await win.loadURL("about:blank"); // the page's WebSocket would hold the old backend's shutdown open
    const old = Number(E.LIASCAPE_BACKEND_PID || 0);
    if (old && procAlive(old)) {
      process.kill(old, "SIGTERM");
      if (!(await waitFor(() => !procAlive(old), 35000, 50))) process.kill(old, "SIGKILL");
    }
    const env = { ...E, LIASCAPE_PORT: new URL(U).port, PATH: bin, LIASCAPE_PLAYER_BIN: path.join(lp, "liascape-player"), LIASCAPE_SCENE_WORKER_BIN: "/nonexistent",
      LIASCAPE_PLAYER_VRAM_PROBE: "none", LIASCAPE_TRANSITIONS_DIR: cat };
    for (const k of ["DISPLAY", "LIASCAPE_URL", "LIASCAPE_CLIPS", "LIASCAPE_OUT", "LIASCAPE_ONLY", "LIASCAPE_SHARD", "LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES"]) delete env[k];
    const log = fs.openSync(E.LIASCAPE_BACKEND_LOG, "a");
    const ch = cp.spawn(E.LIASCAPE_DOTNET, [E.LIASCAPE_DLL, "--serve"], { env, stdio: ["ignore", log, log] });
    fs.closeSync(log);
    if (E.LIASCAPE_BACKEND_PID_FILE) fs.writeFileSync(E.LIASCAPE_BACKEND_PID_FILE, String(ch.pid));
    if (!(await waitFor(async () => (await http("GET", "/health")).json?.ok === true, 40000, 200))) throw new Error("the restarted backend didn't answer /health");
    const f2 = await features();
    await cell("missing: /health/features reports each missing piece with its reason", async () => {
      const v = [];
      if (!f2) return ["no /health/features answer"];
      for (const [id, re] of Object.entries(REASON)) {
        const f = byId(f2, id);
        if (!f) { v.push(`${id} missing from the report`); continue; }
        if (f.ok !== false) v.push(`${id} ok=${f.ok}, want false (${f.reason})`);
        if (!re.test(f.reason || "")) v.push(`${id}: reason ${JSON.stringify(f.reason)} doesn't match ${re}`);
      }
      if (byId(f2, "liascape-player")?.ok !== true) v.push(`liascape-player: ${JSON.stringify(byId(f2, "liascape-player"))} (the copy resolves)`);
      return v;
    });
    await win.loadURL(U + "/");
    for (let i = 0; i < 100 && !(await js(`return !!document.querySelector(".tab")`)); i++) await sleep(100);
    const s2 = await settingsRows();
    fs.writeFileSync(path.join(OUT, "health-rows.json"), JSON.stringify({ present: s1, missing: s2, f1, f2 }, null, 1));
    await cell("missing: a warning icon with the reason on every affected row, the control kept", async () => {
      const v = [];
      for (const [id, labels] of Object.entries(ROWS)) for (const l of labels) {
        const r = s2.rows[l];
        if (!r) { v.push(`no row "${l}" (a control must never be hidden for it)`); continue; }
        if (!r.warn) v.push(`"${l}" has no warning icon (${id} is missing)`);
        else if (!REASON[id].test(r.warn)) v.push(`"${l}" tooltip ${JSON.stringify(r.warn)} doesn't name ${REASON[id]}`);
        if (!r.control) v.push(`"${l}" lost its control`);
      }
      if (s2.rows["Allow scene support"] && !s2.rows["Allow scene support"].enabled) v.push("the scene toggle is disabled — it must stay usable");
      if (s2.rows["Volume"]?.warn) v.push(`"Volume" warns: ${s2.rows["Volume"].warn}`);
      return v;
    });
    // the summary: exactly the broken features that are in use (the stack: transitions on, AllowScenes / AutoMute off,
    // VRAM low mode "stop" → transitions, vram, ffmpeg in it; scenes / auto-mute / mpris / steamcmd only as row icons)
    await cell("missing: the summary lists the broken features in use (and only those)", async () => {
      if (!s2.summary) return ["no [data-health-summary]"];
      const want = f2.filter((f) => f.ok === false && f.inUse !== false).map((f) => f.id).sort();
      const v = [];
      if (JSON.stringify([...s2.summary].sort()) !== JSON.stringify(want)) v.push(`summary ${JSON.stringify(s2.summary)}, want ${JSON.stringify(want)}`);
      for (const id of ["transitions", "vram", "ffmpeg"]) if (!want.includes(id)) v.push(`${id} should be in use in this stack (inUse ${byId(f2, id)?.inUse})`);
      return v;
    });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`HEALTH pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "health.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
