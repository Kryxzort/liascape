// Settings levels + playlist start probe — `scripts/test-ui-matrix.sh --probe probe-expert.js` (the matrix's hermetic stack:
// private backend + headless liascape-player + this tree's UI). Settings levels (.claude/rules/ui/state-and-api.md
// § Settings page) + the playlist start (docs/decisions.md § "Fold "Resume from last" into the playlist start setting"):
//   1. Standard is the default: the level picker sits in the top bar (Basic · Standard · Advanced · Expert), no
//      Advanced / Expert row renders
//   2. each level shows its own rows and every row below it (tagged Advanced / Expert); the choice is saved and survives a reload
//   3. a changed setting a lower level hides: the value is untouched and stays live, the "tucked away" note counts it; its
//      Show raises the level (there the row's own reset puts it back) — no bulk reset
//   4. "When the playlist starts again": Settings (a Select + a hint per value) and the playlist modal (beside the global
//      value it overrides; the playlist's own choice only matters under "Override global rotation settings")
//   5. "Pause behind windows": the Playback row (liascape-player), default "A fullscreen or maximized window", saved + live
//   3b. settings:noOverflow: no control sticks out of its row (every level, 1920 and 960 px windows)
//   6. the number stepper (components/NumInput.tsx): no native spin arrows, − / + step and clamp, hold repeats and speeds up,
//      ↑ / ↓ and the wheel on a focused field, typing as before, the digit roll (motion on / off), its look (glow, no-glow,
//      bg-live, Latte); pictures stepper-*.png (1920×1080 when the screen fits: LIASCAPE_MATRIX_SCREEN=1920x1080)
// Exit 1 on any FAIL.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const OUT = E.LIASCAPE_OUT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath("userData", path.join(OUT, "electron-user-data"));

async function http(method, p, body) {
  try {
    const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, json };
  } catch (e) { return { status: 0, json: null, error: e.message }; }
}
async function waitFor(pred, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await pred()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}

let win;
const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const settings = async () => (await http("GET", "/settings")).json ?? {};
// never prints a /settings response: only the single non-secret fields asked for
const field = async (k) => (await settings())[k];

// page helpers (installed per load): rows by label, selects by label, the Settings tab
const HELPERS = `
  window.__x = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    label: (r) => r.querySelector(".slabel-row")?.firstChild?.textContent?.trim(),
    row(label) { return [...document.querySelectorAll(".settings .srow")].find((r) => this.label(r) === label); },
    async settingsTab() {
      [...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Settings")?.click();
      for (let i = 0; i < 60 && !document.querySelector(".settings .srow"); i++) await this.sleep(100);
      await this.sleep(300);
    },
    async select(label, opt) {
      this.row(label)?.querySelector(".sel")?.click(); await this.sleep(200);
      [...document.querySelectorAll(".sel-pop .sel-opt")].find((e) => e.textContent.trim() === opt)?.click(); await this.sleep(200);
    },
    info(label) {
      const r = this.row(label); if (!r) return null;
      return { tag: !!r.querySelector("[data-expert-tag]"), expert: r.hasAttribute("data-expert"), hint: r.querySelector(".shint")?.textContent ?? "",
        reset: !!r.querySelector(".s-reset"), deviated: !!r.querySelector(".s-reset[data-deviated]"),
        checked: r.querySelector("input[type=checkbox]")?.checked ?? null, sel: r.querySelector(".sel")?.textContent?.trim() ?? null };
    },
    sections() { return [...document.querySelectorAll(".settings .ssection h3")].map((h) => h.textContent.trim()); },
  }; true`;
async function loadSettings() {
  await win.loadURL(withToken(U + "/"));
  for (let i = 0; i < 100 && !(await js(`return !!document.querySelector(".tab")`)); i++) await sleep(100);
  await js(HELPERS);
  await js(`await window.__x.settingsTab(); return true`);
}

const EXPERT_ROW = "When no monitor shows the wallpaper";
const results = [];
const cell = async (name, fn) => {
  let v;
  try { v = await fn(); } catch (e) { v = [`ERROR ${e.message}`]; }
  results.push({ name, v });
  console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
  for (const x of v) console.log(`        - ${x}`);
};

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  try {
    // a known start: the default level, the expert value at its default, the start choice at its default
    await http("POST", "/settings", { SettingsLevel: "standard", RotateWhileParked: true, GlobalPlaylistStart: "start_over", PauseWhenCovered: "maximized" });
    await loadSettings();
    const LEVEL = (l) => js(`document.querySelector('[data-settings-level] [data-level="${l}"]')?.click(); await window.__x.sleep(500); return true`);
    const view = () => js(`const rows = [...document.querySelectorAll(".settings .srow")];
      return { level: document.querySelector("[data-settings-level]")?.dataset.settingsLevel ?? null, n: rows.length,
        lv: rows.reduce((m, r) => { m[r.dataset.level] = (m[r.dataset.level] ?? 0) + 1; return m; }, {}),
        hidden: document.querySelector("[data-hidden-changed]")?.dataset.hiddenChanged ?? null }`);
    const has = (label) => js(`return !!window.__x.row(${JSON.stringify(label)})`);

    await cell("Standard (default): the picker in the top bar, no Advanced / Expert row", async () => {
      const v = [];
      const p = await js(`const el = document.querySelector("[data-settings-level]");
        return el ? { inTopbar: !!el.closest(".topbar"), pills: [...el.querySelectorAll("[data-level]")].map((b) => [b.textContent.trim(), b.getAttribute("aria-checked") === "true"]) } : null`);
      if (!p) return ["no level picker ([data-settings-level])"];
      if (!p.inTopbar) v.push("the level picker isn't in the top bar beside the tabs");
      if (JSON.stringify(p.pills.map((x) => x[0])) !== JSON.stringify(["Basic", "Standard", "Advanced", "Expert"])) v.push(`pills ${JSON.stringify(p.pills)}`);
      if (p.pills.filter((x) => x[1]).map((x) => x[0]).join() !== "Standard") v.push(`active ${JSON.stringify(p.pills)}, want Standard`);
      const w = await view();
      if (w.lv.advanced || w.lv.expert) v.push(`Advanced / Expert rows at Standard: ${JSON.stringify(w.lv)}`);
      if (await has(EXPERT_ROW)) v.push(`"${EXPERT_ROW}" renders at Standard`);
      if (await field("settingsLevel") !== "standard") v.push(`settingsLevel ${await field("settingsLevel")}, want standard`);
      return v;
    });

    await cell("each level shows its rows and every row below; tagged; saved and kept over a reload", async () => {
      const v = [];
      const seen = {};
      for (const l of ["basic", "standard", "advanced", "expert"]) {
        await LEVEL(l); seen[l] = { ...(await view()), speed: await has("Playback speed"), hw: await has("Hardware decoding"), exp: await has(EXPERT_ROW) };
      }
      if (seen.basic.speed || seen.basic.lv.standard || seen.basic.lv.advanced || seen.basic.lv.expert) v.push(`Basic shows more than Basic rows: ${JSON.stringify(seen.basic.lv)}`);
      if (!seen.standard.speed || seen.standard.hw) v.push(`Standard: "Playback speed" ${seen.standard.speed}, "Hardware decoding" ${seen.standard.hw}`);
      if (!seen.advanced.hw || seen.advanced.exp) v.push(`Advanced: "Hardware decoding" ${seen.advanced.hw}, "${EXPERT_ROW}" ${seen.advanced.exp}`);
      if (!seen.expert.exp) v.push(`Expert: no "${EXPERT_ROW}"`);
      const ns = ["basic", "standard", "advanced", "expert"].map((l) => seen[l].n);
      if (!(ns[0] < ns[1] && ns[1] < ns[2] && ns[2] < ns[3])) v.push(`row counts per level ${JSON.stringify(ns)} should grow`);
      const r = await js(`return window.__x.info(${JSON.stringify(EXPERT_ROW)})`);
      if (!r?.tag || !r?.expert) v.push(`the Expert row lacks its tag (${JSON.stringify(r)})`);
      else if (r.sel !== "Keep rotating") v.push(`its default reads ${JSON.stringify(r.sel)}, want "Keep rotating"`);
      const hw = await js(`return window.__x.row("Hardware decoding")?.querySelector("[data-expert-tag]")?.textContent?.trim() ?? null`);
      if (hw !== "Advanced") v.push(`"Hardware decoding" tag ${JSON.stringify(hw)}, want "Advanced"`);
      if (!(await waitFor(async () => (await field("settingsLevel")) === "expert", 4000))) v.push(`settingsLevel not saved (${await field("settingsLevel")})`);
      await loadSettings();
      if (!(await has(EXPERT_ROW))) v.push("after a reload the Expert row is gone — the level did not persist");
      return v;
    });

    await cell("settings:noOverflow — no control sticks out of its row, at every level and at a wide and a narrow window", async () => {
      // a long hint once squeezed a control column narrower than its segmented control, clipping an option off the row
      const v = [];
      await LEVEL("expert");
      for (const [w, h] of [[1920, 1080], [960, 900]]) {
        win.setContentSize(w, h); await sleep(600);
        const bad = await js(`return [...document.querySelectorAll(".settings .srow")].filter((r) => r.offsetParent).flatMap((r) => {
          const rr = r.getBoundingClientRect(), label = r.querySelector(".slabel")?.firstChild?.textContent?.trim() ?? r.textContent.slice(0, 40);
          const out = [];
          for (const c of r.querySelectorAll(".sctl, .sctl > *")) { const cr = c.getBoundingClientRect();
            if (cr.width && (cr.right > rr.right + 0.5 || cr.left < rr.left - 0.5)) out.push(label + ": " + (c.className || c.tagName) + " " + Math.round(cr.left) + "-" + Math.round(cr.right) + " outside row " + Math.round(rr.left) + "-" + Math.round(rr.right)); }
          const ctl = r.querySelector(".sctl"); if (ctl && ctl.scrollWidth > ctl.clientWidth + 1) out.push(label + ": its control column overflows (" + ctl.scrollWidth + " > " + ctl.clientWidth + " px)");
          return out; })`);
        const rows = await js(`return [...document.querySelectorAll(".settings .srow")].filter((r) => r.offsetParent).length`);
        if (rows < 20) v.push(`${w}px: only ${rows} rows rendered — proved nothing`);
        for (const b of bad.slice(0, 6)) v.push(`${w}px: ${b}`);
      }
      win.setContentSize(1400, 900); await sleep(400); await LEVEL("standard");
      return v;
    });

    await cell("a changed setting hidden by a lower level: kept and live, the note counts it, Show raises the level", async () => {
      const v = [];
      await LEVEL("standard"); await sleep(300);
      const n0 = +((await view()).hidden ?? 0); // the stack's own non-default hidden settings (engine, transition style, …)
      await LEVEL("expert");
      await js(`await window.__x.select(${JSON.stringify(EXPERT_ROW)}, "Hold until a monitor returns"); return true`);
      if (!(await waitFor(async () => (await field("rotateWhileParked")) === false, 4000))) v.push(`rotateWhileParked not saved false (${await field("rotateWhileParked")})`);
      if ((await view()).hidden) v.push("the note shows at Expert, where nothing is hidden");
      await LEVEL("standard"); await sleep(300);
      if (await has(EXPERT_ROW)) v.push("the Expert row is still shown at Standard");
      if ((await field("rotateWhileParked")) !== false) v.push(`hiding changed the value: rotateWhileParked ${await field("rotateWhileParked")}`);
      if (+((await view()).hidden ?? 0) !== n0 + 1) v.push(`the note reads ${JSON.stringify((await view()).hidden)}, want ${n0 + 1}`);
      await js(`document.querySelector("[data-hidden-show]")?.click(); await window.__x.sleep(500); return true`);
      if ((await view()).level !== "expert" || !(await has(EXPERT_ROW))) v.push(`Show didn't raise the level to Expert (${(await view()).level})`);
      await js(`window.__x.row(${JSON.stringify(EXPERT_ROW)})?.querySelector(".s-reset")?.click(); await window.__x.sleep(600); return true`);
      if (!(await waitFor(async () => (await field("rotateWhileParked")) === true, 4000))) v.push(`the row's reset did not restore rotateWhileParked (${await field("rotateWhileParked")})`);
      await LEVEL("standard"); await sleep(300);
      if (+((await view()).hidden ?? 0) !== n0) v.push(`after the reset the note reads ${JSON.stringify((await view()).hidden)}, want ${n0 || null}`);
      if (await js(`return !!document.querySelector("[data-hidden-reset]")`)) v.push("a bulk reset button on the note (it could flip the player engine)");
      return v;
    });

    await cell('"When the playlist starts again": Settings select + a hint per value, saved', async () => {
      const v = [];
      const L = "When the playlist starts again";
      let r = await js(`return window.__x.info(${JSON.stringify(L)})`);
      if (!r) return [`no "${L}" row in Settings`];
      if (r.sel !== "Start over") v.push(`default reads ${JSON.stringify(r.sel)}`);
      if (!/shuffle shuffles anew/.test(r.hint)) v.push(`start-over hint ${JSON.stringify(r.hint)}`);
      await js(`await window.__x.select(${JSON.stringify(L)}, "Resume where it left off"); return true`);
      if (!(await waitFor(async () => (await field("globalPlaylistStart")) === "resume", 4000))) v.push(`globalPlaylistStart ${await field("globalPlaylistStart")}, want resume`);
      r = await js(`return window.__x.info(${JSON.stringify(L)})`);
      if (!/same wallpaper, at the same moment/.test(r?.hint ?? "")) v.push(`resume hint ${JSON.stringify(r?.hint)}`);
      if (!r?.reset) v.push("no reset icon on a non-default start choice");
      return v;
    });

    await cell("the playlist modal: its own start choice beside the global one, effective only under the override", async () => {
      const v = [];
      await js(`[...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Library")?.click(); await window.__x.sleep(900);
        document.querySelector('button[title="Playlist settings"]')?.click(); await window.__x.sleep(700); return true`);
      const m = await js(`const hint = document.querySelector(".pl-modal [data-playlist-start-hint]")?.textContent ?? null;
        const seg = document.querySelector(".pl-modal [data-playlist-start]");
        return { hint, on: seg?.dataset.playlistStart ?? null, btns: [...(seg?.querySelectorAll("button") ?? [])].map((b) => ({ t: b.textContent.trim(), dis: b.disabled })),
          label: [...document.querySelectorAll(".pl-modal .field-label")].some((e) => e.textContent.trim() === "WHEN THE PLAYLIST STARTS AGAIN") }`);
      if (!m.label) return [`the playlist modal has no "WHEN THE PLAYLIST STARTS AGAIN" (modal not opened? ${JSON.stringify(m)})`];
      if (!/Global setting: Resume where it left off/.test(m.hint ?? "")) v.push(`without the override the modal should name the global value: ${JSON.stringify(m.hint)}`);
      if (!m.btns.every((b) => b.dis)) v.push(`the choice is enabled without the override: ${JSON.stringify(m.btns)}`);
      await js(`[...document.querySelectorAll(".pl-modal label.ck")].find((l) => l.textContent.includes("Override global rotation"))?.querySelector("input")?.click(); await window.__x.sleep(400);
        [...document.querySelectorAll(".pl-modal .seg-opt")].find((b) => b.textContent.trim() === "Start over")?.click(); await window.__x.sleep(500); return true`);
      const m2 = await js(`return { hint: document.querySelector(".pl-modal [data-playlist-start-hint]")?.textContent ?? null, on: document.querySelector(".pl-modal [data-playlist-start]")?.dataset.playlistStart }`);
      if (m2.on !== "start_over") v.push(`after choosing Start over the modal shows ${m2.on}`);
      if (!/global: Resume where it left off/.test(m2.hint ?? "") || !/shuffle shuffles anew/.test(m2.hint ?? "")) v.push(`under the override the hint should give the choice's text and the global value: ${JSON.stringify(m2.hint)}`);
      const saved = async () => (await http("GET", "/playlist/state")).json?.settings;
      if (!(await waitFor(async () => { const s = await saved(); return s?.overrideGlobalSettings === true && s?.playlistStart === "start_over"; }, 5000)))
        v.push(`the playlist's settings ${JSON.stringify(await saved())}: want override on + playlistStart start_over`);
      await js(`[...document.querySelectorAll(".pl-modal .seg-opt")].find((b) => b.textContent.trim() === "Resume where it left off")?.click(); await window.__x.sleep(500); return true`);
      if (!(await waitFor(async () => (await saved())?.playlistStart === "resume", 5000))) v.push(`playlistStart ${(await saved())?.playlistStart}, want resume`);
      // leave it as found
      await js(`[...document.querySelectorAll(".pl-modal .seg-opt")].find((b) => b.textContent.trim() === "Start over")?.click(); await window.__x.sleep(300);
        [...document.querySelectorAll(".pl-modal label.ck")].find((l) => l.textContent.includes("Override global rotation"))?.querySelector("input")?.click(); await window.__x.sleep(400);
        [...document.querySelectorAll(".pl-modal button")].find((b) => b.textContent.trim() === "Close")?.click(); await window.__x.sleep(300); return true`);
      return v;
    });

    await cell('"Pause behind windows": Settings → Playback row, default "A fullscreen or maximized window", saved', async () => {
      const v = [];
      await loadSettings();
      const L = "Pause behind windows";
      let r = await js(`return window.__x.info(${JSON.stringify(L)})`);
      if (!r) return [`no "${L}" row (the stack runs liascape-player)`];
      if (r.sel !== "A fullscreen or maximized window") v.push(`default reads ${JSON.stringify(r.sel)}`);
      if (!/Pauses picture and sound while every monitor showing the wallpaper is covered/.test(r.hint)) v.push(`hint ${JSON.stringify(r.hint)}`);
      if (r.reset) v.push("a reset icon on the default value");
      await js(`await window.__x.select(${JSON.stringify(L)}, "A fullscreen window"); return true`);
      if (!(await waitFor(async () => (await field("pauseWhenCovered")) === "fullscreen", 4000))) v.push(`pauseWhenCovered ${await field("pauseWhenCovered")}, want fullscreen`);
      await js(`await window.__x.select(${JSON.stringify(L)}, "Off"); return true`);
      if (!(await waitFor(async () => (await field("pauseWhenCovered")) === "off", 4000))) v.push(`pauseWhenCovered ${await field("pauseWhenCovered")}, want off`);
      r = await js(`return window.__x.info(${JSON.stringify(L)})`);
      if (!r?.reset) v.push("no reset icon on a non-default value");
      await js(`window.__x.row(${JSON.stringify(L)}).querySelector(".s-reset")?.click(); await window.__x.sleep(500); return true`);
      if (!(await waitFor(async () => (await field("pauseWhenCovered")) === "maximized", 4000))) v.push(`the reset left pauseWhenCovered ${await field("pauseWhenCovered")}`);
      return v;
    });

    // ---- the number stepper (components/NumInput.tsx) on "Video frame rate cap" (0–480): a real mouse, keys and wheel
    // (sendInputEvent), the saved value read back. The page's own state (level, theme, toggles) is put back after each cell.
    const FPS = "Video frame rate cap";
    const SI = (ev) => win.webContents.sendInputEvent(ev);
    const R = JSON.stringify(FPS);
    const IN = `window.__x.row(${R})?.querySelector("input.num")`;
    const st = () => js(`const r = window.__x.row(${R}), s = r?.querySelector("[data-num-step]"), i = ${IN};
      const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), l: b.x, t: b.y, w: b.width, h: b.height }; };
      const b = (d) => s?.querySelector('[data-step="' + d + '"]');
      return { has: !!s, field: i?.value ?? null, input: box(i), wrap: box(s), dec: box(b(-1)), inc: box(b(1)), decDis: b(-1)?.disabled ?? null, incDis: b(1)?.disabled ?? null,
        focused: !!i && document.activeElement === i }`);
    const show = () => js(`window.__x.row(${R})?.scrollIntoView({ block: "center" }); await window.__x.sleep(500); return true`);
    // an unfocused field commits a script-set value at once, clamped (NumInput's onChange)
    const setField = async (v) => { await js(`const i = ${IN}; i.blur(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(String(v))});
      i.dispatchEvent(new Event("input", { bubbles: true })); await window.__x.sleep(80); return true`); await waitFor(async () => (await field("videoFpsCap")) === v, 3000); };
    const move = async (p) => { SI({ type: "mouseMove", x: p.x, y: p.y }); await sleep(60); };
    const press = async (p, ms = 40) => { await move(p); SI({ type: "mouseDown", x: p.x, y: p.y, button: "left", clickCount: 1 }); await sleep(ms); SI({ type: "mouseUp", x: p.x, y: p.y, button: "left", clickCount: 1 }); await sleep(150); };
    const key = async (keyCode, modifiers = []) => { SI({ type: "keyDown", keyCode, modifiers }); SI({ type: "keyUp", keyCode, modifiers }); await sleep(120); };
    const savedIs = (v) => waitFor(async () => (await field("videoFpsCap")) === v, 3000);
    const stepperStart = async () => {
      await http("POST", "/settings", { settingsLevel: "standard", videoFpsCap: 24, morphs: true, glows: true });
      await loadSettings(); await show();
      for (let i = 0; i < 20 && (await st()).field !== "24"; i++) await sleep(100);
    };
    const shots = async (name, rect) => {
      const img = await win.webContents.capturePage(rect);
      fs.writeFileSync(path.join(OUT, `stepper-${name}.png`), img.toPNG());
    };

    await cell("stepper: no native spin arrows; themed − / + (lucide) around a typeable field", async () => {
      await stepperStart();
      const s = await st();
      if (!s.input) return [`no "${FPS}" field`];
      const v = [];
      if (!s.has) v.push("no stepper ([data-num-step]) on the row — the field is still a bare <input type=number>");
      const look = await js(`const s = window.__x.row(${R}).querySelector("[data-num-step]"), i = ${IN};
        return { app: getComputedStyle(i).appearance, btns: [...(s?.querySelectorAll(".ns-btn") ?? [])].map((b) => ({ svg: !!b.querySelector("svg.lucide"), aria: b.getAttribute("aria-label"), tab: b.tabIndex })) }`);
      if (look.app !== "textfield") v.push(`the input's appearance is ${look.app} (want textfield: no spin buttons)`);
      if (look.btns.length !== 2 || !look.btns.every((b) => b.svg && b.aria && b.tab === -1)) v.push(`buttons ${JSON.stringify(look.btns)}: want two lucide icon buttons with an aria-label, out of the tab order`);
      // the outcome: hover the field (Chromium paints its spin arrows on hover), hide the digits, count bright pixels in it
      await move(s.input); await sleep(300);
      await js(`const i = ${IN}; i.style.color = "transparent"; i.style.caretColor = "transparent"; return true`); await sleep(100);
      const img = await win.webContents.capturePage({ x: Math.round(s.input.l) + 1, y: Math.round(s.input.t) + 1, width: Math.round(s.input.w) - 2, height: Math.round(s.input.h) - 2 });
      await js(`const i = ${IN}; i.style.color = ""; i.style.caretColor = ""; return true`);
      const bmp = img.toBitmap(); let bright = 0; // BGRA
      for (let p = 0; p < bmp.length; p += 4) if (Math.min(bmp[p], bmp[p + 1], bmp[p + 2]) > 150) bright++;
      if (bright > 6) v.push(`${bright} bright pixels inside the hovered field with its digits hidden — the native spin arrows still show`);
      return v;
    });

    await cell("stepper: − / + step by one and save; a bound disables its button and holds", async () => {
      await stepperStart();
      let s = await st();
      if (!s.inc) return ["no + button"];
      const v = [];
      await press(s.inc);
      if ((s = await st()).field !== "25") v.push(`+ from 24 shows ${s.field}, want 25`);
      await press(s.dec); await press(s.dec);
      if ((s = await st()).field !== "23") v.push(`− − from 25 shows ${s.field}, want 23`);
      if (!(await savedIs(23))) v.push(`videoFpsCap ${await field("videoFpsCap")} after the clicks, want 23`);
      if (s.focused) v.push("a click on − / + moved the focus into the field");
      await setField(479); s = await st();
      if (s.incDis) v.push("+ is disabled at 479 (max 480)");
      await press(s.inc); s = await st();
      if (s.field !== "480" || !s.incDis || s.decDis) v.push(`at the max: field ${s.field}, + disabled ${s.incDis}, − disabled ${s.decDis} (want 480, true, false)`);
      await press(s.inc);
      if ((s = await st()).field !== "480" || !(await savedIs(480))) v.push(`+ past the max: field ${s.field}, saved ${await field("videoFpsCap")}`);
      await setField(1); s = await st();
      await press(s.dec); s = await st();
      if (s.field !== "0" || !s.decDis || s.incDis) v.push(`at the min: field ${s.field}, − disabled ${s.decDis}, + disabled ${s.incDis} (want 0, true, false)`);
      if (!(await savedIs(0))) v.push(`videoFpsCap ${await field("videoFpsCap")} at the min, want 0`);
      return v;
    });

    await cell("stepper: press-and-hold repeats and speeds up (gaps shrink, then ×10 jumps); release stops it", async () => {
      await stepperStart(); await setField(0);
      const s = await st();
      if (!s.inc) return ["no + button"];
      await js(`const i = ${IN}; let last = i.value; window.__hv = []; clearInterval(window.__hp);
        window.__hp = setInterval(() => { if (i.value !== last) { last = i.value; window.__hv.push([performance.now(), +last]); } }, 4); return true`);
      await move(s.inc);
      const t0 = await js(`return performance.now()`);
      SI({ type: "mouseDown", x: s.inc.x, y: s.inc.y, button: "left", clickCount: 1 });
      await sleep(2600);
      SI({ type: "mouseUp", x: s.inc.x, y: s.inc.y, button: "left", clickCount: 1 });
      const tUp = await js(`return performance.now()`);
      await sleep(700);
      const hv = await js(`clearInterval(window.__hp); return window.__hv`);
      const v = [];
      if (hv.length < 3) return [`the hold changed the field ${hv.length} time(s) — proved nothing (${JSON.stringify(hv)})`];
      if (hv[0][0] - t0 > 200) v.push(`the first step came ${Math.round(hv[0][0] - t0)} ms after the press (want at once)`);
      if (hv.length < 25) v.push(`only ${hv.length} steps in a 2.6 s hold`);
      const gaps = hv.slice(1).map((x, i) => x[0] - hv[i][0]);
      const early = (gaps[1] + gaps[2] + gaps[3]) / 3, late = gaps.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
      if (!(early >= 2 * late)) v.push(`repeat gaps don't shrink: early ${early.toFixed(0)} ms vs late ${late.toFixed(0)} ms`);
      const incs = hv.slice(1).map((x, i) => x[1] - hv[i][1]);
      if (!incs.slice(0, 5).every((d) => d === 1)) v.push(`the first repeats step ${JSON.stringify(incs.slice(0, 5))}, want 1 each`);
      if (!incs.slice(-3).every((d) => d === 10)) v.push(`a long hold's last steps are ${JSON.stringify(incs.slice(-3))}, want ×10 (10 each)`);
      const after = hv.filter((x) => x[0] > tUp + 80);
      if (after.length) v.push(`the field kept changing after the release: ${JSON.stringify(after.map((x) => x[1]))}`);
      const end = hv.at(-1)[1];
      if (!(await savedIs(end))) v.push(`saved ${await field("videoFpsCap")}, the field ended at ${end}`);
      return v;
    });

    await cell("stepper: ↑ / ↓ step a focused field, Shift ×10; typing still commits only a complete in-range value", async () => {
      await stepperStart(); await setField(100);
      const v = [];
      await js(`${IN}.focus(); return true`); await sleep(100);
      await key("Up"); let s = await st();
      if (s.field !== "101") v.push(`↑ from 100 shows ${s.field}`);
      await key("Up", ["shift"]); s = await st();
      if (s.field !== "111") v.push(`Shift+↑ from 101 shows ${s.field}, want 111`);
      await key("Down"); s = await st();
      if (s.field !== "110") v.push(`↓ from 111 shows ${s.field}`);
      if (!(await savedIs(110))) v.push(`saved ${await field("videoFpsCap")} after the keys, want 110`);
      await js(`${IN}.select(); return true`); win.webContents.insertText("37"); await sleep(150);
      if ((s = await st()).field !== "37" || !(await savedIs(37))) v.push(`typed 37: field ${s.field}, saved ${await field("videoFpsCap")}`);
      await js(`${IN}.select(); return true`); win.webContents.insertText("999"); await sleep(600);
      if ((s = await st()).field !== "999") v.push(`typed 999 shows ${s.field} while focused`);
      if ((await field("videoFpsCap")) !== 37) v.push(`an out-of-range draft was saved: ${await field("videoFpsCap")}`);
      await key("Return"); s = await st();
      if (s.field !== "480" || !(await savedIs(480))) v.push(`Enter on 999: field ${s.field}, saved ${await field("videoFpsCap")} (want 480)`);
      await js(`${IN}.select(); return true`); win.webContents.insertText("50"); await sleep(150);
      if (s.inc) await press(s.inc); s = await st();
      if (s.field !== "51" || !s.focused) v.push(`+ on a typed 50: field ${s.field}, focused ${s.focused} (want 51, still focused)`);
      await js(`${IN}.blur(); return true`);
      if (!(await savedIs(51))) v.push(`saved ${await field("videoFpsCap")} after the blur, want 51`);
      return v;
    });

    await cell("stepper: the wheel steps a focused field and the page stays; over an unfocused one the page glides on", async () => {
      await stepperStart(); await setField(200);
      const v = [];
      const top = () => js(`return window.__x.row(${R}).closest(".scroll")?.scrollTop ?? null`);
      const room = await js(`const e = window.__x.row(${R}).closest(".scroll"); return e ? e.scrollHeight - e.clientHeight : 0`);
      if (room < 200) return [`the Settings scroller has ${room} px to scroll — proved nothing`];
      const NOTCH = (dir) => ({ type: "mouseWheel", deltaX: 0, deltaY: -120 * dir, wheelTicksX: 0, wheelTicksY: -dir, hasPreciseScrollingDeltas: false, canScroll: true });
      // a window listener runs after the page's own: defaultPrevented = the smooth scroller took the notch (it glides)
      await js(`window.__wdp = []; if (!window.__wdpOn) { window.__wdpOn = true; addEventListener("wheel", (e) => window.__wdp.push(e.defaultPrevented), { passive: true }); } return true`);
      let s = await st(); await move(s.input);
      let t0 = await top(); SI({ ...NOTCH(1), x: s.input.x, y: s.input.y }); await sleep(800);
      let t1 = await top(); s = await st();
      if (s.field !== "200") v.push(`a wheel over the unfocused field changed it to ${s.field}`);
      if (Math.abs(t1 - t0) < 20) v.push(`a wheel over the unfocused field didn't scroll the page (${t0} → ${t1})`);
      const dp = await js(`return window.__wdp`);
      if (dp[0] !== true) v.push(`over the unfocused field the notch scrolled natively (defaultPrevented ${JSON.stringify(dp)}), not the page's smooth glide`);
      await show(); s = await st();
      await js(`${IN}.focus(); return true`); await move(s.input);
      t0 = await top(); SI({ ...NOTCH(1), x: s.input.x, y: s.input.y }); await sleep(800);
      t1 = await top(); s = await st();
      if (s.field !== "199") v.push(`a wheel down over the focused field shows ${s.field}, want 199`);
      if (Math.abs(t1 - t0) > 1) v.push(`the page scrolled ${t1 - t0} px under a wheel over the focused field`);
      const up = s.inc ?? s.input; SI({ ...NOTCH(-1), x: up.x, y: up.y }); await sleep(500);
      if ((s = await st()).field !== "200") v.push(`a wheel up over the focused stepper's + shows ${s.field}, want 200`);
      await js(`${IN}.blur(); return true`);
      if (!(await savedIs(200))) v.push(`saved ${await field("videoFpsCap")}, want 200`);
      return v;
    });

    // per-frame samples of the input (rolling in) and its ghost (the old digits rolling out) over one + click
    const rollRun = async () => {
      const s = await st();
      if (!s.inc) return null;
      await js(`const i = ${IN}, g = i.parentElement.querySelector(".ns-ghost"); window.__rs = []; const t0 = performance.now();
        const ty = (e) => { const m = getComputedStyle(e).transform; return m === "none" ? 0 : new DOMMatrix(m).m42; };
        const tick = () => { window.__rs.push({ t: performance.now() - t0, iy: ty(i), io: +getComputedStyle(i).opacity, gy: g ? ty(g) : 0, go: g ? +getComputedStyle(g).opacity : 0 });
          if (performance.now() - t0 < 500) requestAnimationFrame(tick); };
        requestAnimationFrame(tick); return true`);
      await press(s.inc, 20); await sleep(450);
      return js(`return window.__rs`);
    };
    await cell("stepper: a step rolls the digits (motion on: in-between frames); motion off: a cross-fade in place", async () => {
      await stepperStart(); await setField(10);
      const v = [];
      const on = await rollRun();
      if (!on) return ["no + button"];
      const midIn = on.filter((f) => Math.abs(f.iy) > 1 || (f.io > 0.05 && f.io < 0.95)).length;
      const midOut = on.filter((f) => f.go > 0.05 && f.go < 0.95).length;
      if (midIn < 2 || midOut < 2) v.push(`motion on: ${midIn} frames of the new digits rolling in, ${midOut} of the old rolling out (want ≥ 2 each) — ${JSON.stringify(on.slice(0, 8))}`);
      const last = on.at(-1);
      if (Math.abs(last.iy) > 0.5 || last.io < 0.99 || last.go > 0.01) v.push(`the roll didn't settle: ${JSON.stringify(last)}`);
      if ((await st()).field !== "11") v.push(`the step shows ${(await st()).field}, want 11`);
      await js(`window.__x.row("Smooth window animations").querySelector("input[type=checkbox]").click(); await window.__x.sleep(400); return true`);
      if (!(await waitFor(async () => (await field("morphs")) === false, 3000))) v.push("couldn't turn motion off");
      await show();
      const off = await rollRun();
      // nothing moves; the old value fades out as the new fades in (never a pop), and it settles
      // (a shown layer: the hidden ghost may still hold the last motion-on roll's end, out of sight)
      const moved = off.filter((f) => (Math.abs(f.iy) > 0.5 && f.io > 0.02) || (Math.abs(f.gy) > 0.5 && f.go > 0.02));
      if (moved.length) v.push(`motion off: ${moved.length} frames still roll (${JSON.stringify(moved.slice(0, 3))})`);
      const fIn = off.filter((f) => f.io > 0.02 && f.io < 0.98).length, fOut = off.filter((f) => f.go > 0.02 && f.go < 0.98).length;
      if (!fIn || !fOut) v.push(`motion off: the digits popped (${fIn} frames of the new fading in, ${fOut} of the old fading out) — ${JSON.stringify(off.slice(0, 6))}`);
      const end = off.at(-1);
      if (end && (end.io < 0.99 || end.go > 0.01)) v.push(`motion off: the cross-fade didn't settle: ${JSON.stringify(end)}`);
      if ((await st()).field !== "12") v.push(`the motion-off step shows ${(await st()).field}, want 12`);
      await js(`window.__x.row("Smooth window animations").querySelector("input[type=checkbox]").click(); await window.__x.sleep(300); return true`);
      return v;
    });

    await cell("stepper: look — hover glow, a springy press, no-glow, bg-live, Latte", async () => {
      await stepperStart();
      const { screen } = require("electron");
      const d = screen.getPrimaryDisplay().size, big = d.width >= 1920 && d.height >= 1080;
      if (big) { win.setContentSize(1920, 1080); await sleep(600); await show(); }
      console.log(`        pictures at ${win.getContentSize().join("×")} (screen ${d.width}×${d.height})`);
      const v = [];
      const C = (expr) => js(`const p = document.createElement("i"); p.style.color = ${JSON.stringify(expr)}; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c`);
      const read = () => js(`const s = window.__x.row(${R}).querySelector("[data-num-step]"), b = s.querySelector('[data-step="1"]'), cs = getComputedStyle(s), bb = getComputedStyle(b, "::before");
        return { border: cs.borderColor, shadow: cs.boxShadow, bg: cs.backgroundColor, btn: getComputedStyle(b).color, discO: +bb.opacity, discShadow: bb.boxShadow,
          held: b.classList.contains("held"), svgT: getComputedStyle(b.querySelector("svg")).transform }`);
      // a box-shadow with any visible colour (no-glow's --glow-sm is "0 0 #0000": transparent)
      const lit = (sh) => !!sh && sh !== "none" && sh.split(/,(?![^(]*\))/).some((part) => {
        const m = /rgba?\(([^)]*)\)/.exec(part); if (!m) return false; const c = m[1].split(",").map(Number); return c.length < 4 || c[3] > 0; });
      let s = await st();
      if (!s.wrap || !s.inc) return ["no stepper ([data-num-step]) to look at"];
      const pad = 40, rect = { x: Math.max(0, Math.round(s.wrap.l - 360)), y: Math.max(0, Math.round(s.wrap.t - pad)), width: Math.round(s.wrap.w + 360 + pad), height: Math.round(s.wrap.h + 2 * pad) };
      await move({ x: 5, y: 5 }); await sleep(300);
      const rest = await read();
      if (rest.btn !== await C("var(--subtext)")) v.push(`the buttons at rest are ${rest.btn}, want --subtext`);
      const off = await js(`return [...window.__x.row(${R}).querySelectorAll(".ns-btn")].map((b) => { const r = b.getBoundingClientRect(), i = b.querySelector("svg").getBoundingClientRect();
        return [+(i.x + i.width / 2 - r.x - r.width / 2).toFixed(2), +(i.y + i.height / 2 - r.y - r.height / 2).toFixed(2)]; })`);
      if (off.some(([dx, dy]) => Math.abs(dx) > 0.6 || Math.abs(dy) > 0.6)) v.push(`− / + icons off their buttons' centre by ${JSON.stringify(off)} px`);
      await shots("rest", rect); await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(OUT, "stepper-rest-full.png"), img.toPNG()));
      await move(s.inc); await sleep(500);
      const hov = await read();
      if (hov.border !== await C("var(--accent)")) v.push(`hovered border ${hov.border}, want --accent`);
      if (!lit(hov.shadow) || !lit(hov.discShadow) || hov.discO < 0.99) v.push(`hovered: pill glow ${hov.shadow}, + disc ${hov.discO} / ${hov.discShadow} (want both glowing)`);
      if (hov.btn !== await C("var(--accent)")) v.push(`hovered + is ${hov.btn}, want --accent`);
      await shots("hover", rect); await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(OUT, "stepper-hover-full.png"), img.toPNG()));
      // a held press squeezes the icon; mid-roll picture: the roll's animations paused part-way
      SI({ type: "mouseDown", x: s.inc.x, y: s.inc.y, button: "left", clickCount: 1 }); await sleep(150);
      const held = await read();
      await js(`for (const a of document.getAnimations()) if (a.effect?.target?.closest?.("[data-num-step]")) { a.pause(); a.currentTime = 70; } return true`);
      await sleep(100); await shots("midroll", rect);
      SI({ type: "mouseUp", x: s.inc.x, y: s.inc.y, button: "left", clickCount: 1 });
      await js(`for (const a of document.getAnimations()) if (a.effect?.target?.closest?.("[data-num-step]")) a.finish(); return true`);
      if (!held.held || !/matrix\(0\.[0-9]/.test(held.svgT)) v.push(`held +: class held ${held.held}, icon transform ${held.svgT} (want squeezed)`);
      await sleep(300);
      {
        await js(`document.documentElement.classList.add("no-glow"); return true`); await sleep(300);
        const ng = await read();
        if (lit(ng.shadow) || lit(ng.discShadow)) v.push(`no-glow: still glowing (pill ${ng.shadow}, disc ${ng.discShadow})`);
        await js(`document.documentElement.classList.remove("no-glow"); document.documentElement.classList.add("bg-live"); return true`); await sleep(300);
        // color-mix computes to color(srgb r g b / a), a plain fill to rgb()/rgba()
        const bl = await read(), a = /\/\s*([0-9.]+)\s*\)$/.exec(bl.bg)?.[1] ?? /rgba\([^)]*,\s*([0-9.]+)\)/.exec(bl.bg)?.[1] ?? 1;
        if (!(+a < 1)) v.push(`bg-live: the pill's fill ${bl.bg} is opaque (want --tr translucency)`);
        await js(`document.documentElement.classList.remove("bg-live"); return true`);
      }
      const theme0 = await js(`return window.__x.row("Theme")?.querySelector(".sel")?.textContent?.trim() ?? null`);
      await js(`await window.__x.select("Theme", "Catppuccin Latte"); await window.__x.sleep(400); return true`);
      await show(); s = await st(); await move(s.inc); await sleep(500);
      const lt = await read();
      if (lt.border !== await C("var(--accent)") || lt.btn !== await C("var(--accent)")) v.push(`Latte hovered: border ${lt.border}, + ${lt.btn}, want its --accent ${await C("var(--accent)")}`);
      const latteBg = await C("color-mix(in srgb, var(--surface1) var(--tr), transparent)");
      if (lt.bg !== latteBg) v.push(`Latte fill ${lt.bg}, want its --surface1 ${latteBg}`);
      await shots("latte-hover", { ...rect, y: Math.max(0, Math.round(s.wrap.t - pad)) });
      if (theme0) await js(`await window.__x.select("Theme", ${JSON.stringify(theme0)}); return true`);
      await move({ x: 5, y: 5 });
      if (big) win.setContentSize(1400, 900);
      return v;
    });
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`EXPERT pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "expert.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
