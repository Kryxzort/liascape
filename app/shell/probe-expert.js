// Settings levels + playlist start probe — `scripts/test-ui-matrix.sh --probe probe-expert.js` (the matrix's hermetic stack:
// private backend + headless liascape-player + this tree's UI). Settings levels (owner 2026-11-06, web-ui.md § "Settings
// levels") + Phase 3 Task 10 (plan 2026-10-29 § Playlist start):
//   1. Standard is the default: the level picker sits in the top bar (Basic · Standard · Advanced · Expert), no
//      Advanced / Expert row renders
//   2. each level shows its own rows and every row below it (tagged Advanced / Expert); the choice is saved and survives a reload
//   3. a changed setting a lower level hides: the value is untouched and stays live, the "tucked away" note counts it; its
//      Show raises the level (there the row's own reset puts it back) — no bulk reset
//   4. "When the playlist starts again": Settings (a Select + a hint per value) and the playlist modal (beside the global
//      value it overrides; the playlist's own choice only matters under "Override global rotation settings")
//   5. "Pause behind windows": the Playback row (liascape-player), default "A fullscreen or maximized window", saved + live
// Exit 1 on any FAIL.
const { app, BrowserWindow } = require("electron");
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
  await win.loadURL(U + "/");
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
        return el ? { inTopbar: !!el.closest(".topbar"), pills: [...el.querySelectorAll("[data-level]")].map((b) => [b.textContent.trim(), b.classList.contains("active")]) } : null`);
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
        [...document.querySelectorAll(".pl-modal .segbtn")].find((b) => b.textContent.trim() === "Start over")?.click(); await window.__x.sleep(500); return true`);
      const m2 = await js(`return { hint: document.querySelector(".pl-modal [data-playlist-start-hint]")?.textContent ?? null, on: document.querySelector(".pl-modal [data-playlist-start]")?.dataset.playlistStart }`);
      if (m2.on !== "start_over") v.push(`after choosing Start over the modal shows ${m2.on}`);
      if (!/global: Resume where it left off/.test(m2.hint ?? "") || !/shuffle shuffles anew/.test(m2.hint ?? "")) v.push(`under the override the hint should give the choice's text and the global value: ${JSON.stringify(m2.hint)}`);
      const saved = async () => (await http("GET", "/playlist/state")).json?.settings;
      if (!(await waitFor(async () => { const s = await saved(); return s?.overrideGlobalSettings === true && s?.playlistStart === "start_over"; }, 5000)))
        v.push(`the playlist's settings ${JSON.stringify(await saved())}: want override on + playlistStart start_over`);
      await js(`[...document.querySelectorAll(".pl-modal .segbtn")].find((b) => b.textContent.trim() === "Resume where it left off")?.click(); await window.__x.sleep(500); return true`);
      if (!(await waitFor(async () => (await saved())?.playlistStart === "resume", 5000))) v.push(`playlistStart ${(await saved())?.playlistStart}, want resume`);
      // leave it as found
      await js(`[...document.querySelectorAll(".pl-modal .segbtn")].find((b) => b.textContent.trim() === "Start over")?.click(); await window.__x.sleep(300);
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
  } catch (e) {
    results.push({ name: "setup", v: [e.message] });
    console.log(`ERROR setup: ${e.message}`);
  }
  const fail = results.filter((r) => r.v.length).length;
  console.log(`EXPERT pass=${results.length - fail} fail=${fail}`);
  fs.writeFileSync(path.join(OUT, "expert.json"), JSON.stringify(results, null, 1));
  app.exit(fail ? 1 : 0);
});
