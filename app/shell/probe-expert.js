// Expert tier + playlist start probe — `scripts/test-ui-matrix.sh --probe probe-expert.js` (the matrix's hermetic stack:
// private backend + headless liascape-player + this tree's UI). Phase 3 Task 10 (plan 2026-10-29, designer call 12 + § Playlist start):
//   1. "Show expert options" off (the default): no Expert section, no `expert` row, the toggle is in Advanced and unchecked
//   2. on: the Expert section and its row (with the "Expert" tag) appear; the toggle persists (saved, and after a reload)
//   3. an expert value changed, then the group hidden: the value is untouched, the "Show expert options" row carries the
//      deviated marker; the marker's reset puts the value back and the marker goes
//   4. "When the playlist starts again": Settings (a Select + a hint per value) and the playlist modal (beside the global
//      value it overrides; the playlist's own choice only matters under "Override global rotation settings")
//   5. "Pause when covered": the Playback row (liascape-player), default "A fullscreen or maximized window", saved + live
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
    // a known start: the toggle off, the expert value at its default, the start choice at its default
    await http("POST", "/settings", { ShowExpertOptions: false, RotateWhileParked: true, GlobalPlaylistStart: "start_over", PauseWhenCovered: "maximized", AdvancedSettings: true });
    await loadSettings();

    await cell("off (default): no Expert section, no expert row, the toggle in Advanced unchecked", async () => {
      const v = [];
      const secs = await js(`return window.__x.sections()`);
      if (secs.includes("Expert")) v.push(`the Expert section shows with the toggle off: ${JSON.stringify(secs)}`);
      if (await js(`return document.querySelectorAll("[data-expert]").length`)) v.push("an expert row renders with the toggle off");
      if (await js(`return !!window.__x.row(${JSON.stringify(EXPERT_ROW)})`)) v.push(`"${EXPERT_ROW}" renders with the toggle off`);
      const t = await js(`return window.__x.info("Show expert options")`);
      if (!t) v.push('no "Show expert options" row');
      else if (t.checked !== false) v.push(`the toggle reads checked=${t.checked}`);
      const adv = await js(`return window.__x.sections().indexOf("Advanced")`);
      const rowsInAdv = await js(`const h = [...document.querySelectorAll(".settings .ssection")].find((s) => s.querySelector("h3")?.textContent.trim() === "Advanced"); return [...(h?.querySelectorAll(".srow") ?? [])].map((r) => window.__x.label(r))`);
      if (adv < 0 || rowsInAdv[0] !== "Advanced settings" || rowsInAdv[1] !== "Show expert options") v.push(`Advanced's first rows ${JSON.stringify(rowsInAdv.slice(0, 3))}: "Show expert options" belongs directly under "Advanced settings"`);
      return v;
    });

    await cell("on: the Expert section + its tagged row appear; the toggle is saved and survives a reload", async () => {
      const v = [];
      await js(`window.__x.row("Show expert options").querySelector("input[type=checkbox]").click(); await window.__x.sleep(500); return true`);
      const secs = await js(`return window.__x.sections()`);
      if (secs[secs.length - 1] !== "Expert") v.push(`sections ${JSON.stringify(secs)}: the Expert section should be last`);
      const r = await js(`return window.__x.info(${JSON.stringify(EXPERT_ROW)})`);
      if (!r) v.push(`no "${EXPERT_ROW}" row with the toggle on`);
      else { if (!r.tag || !r.expert) v.push(`the expert row lacks its Expert tag (${JSON.stringify(r)})`); if (r.sel !== "Keep rotating") v.push(`its default reads ${JSON.stringify(r.sel)}, want "Keep rotating"`); }
      if (!(await waitFor(async () => (await field("showExpertOptions")) === true, 4000))) v.push(`showExpertOptions not saved (${await field("showExpertOptions")})`);
      await loadSettings();
      if (!(await js(`return !!window.__x.row(${JSON.stringify(EXPERT_ROW)})`))) v.push("after a reload the Expert row is gone — the toggle did not persist");
      return v;
    });

    await cell("an expert value, then hidden: value kept, the Show-expert-options row carries the deviated marker, its reset restores", async () => {
      const v = [];
      await js(`await window.__x.select(${JSON.stringify(EXPERT_ROW)}, "Hold until a monitor returns"); return true`);
      if (!(await waitFor(async () => (await field("rotateWhileParked")) === false, 4000))) v.push(`rotateWhileParked not saved false (${await field("rotateWhileParked")})`);
      let t = await js(`return window.__x.info("Show expert options")`);
      if (t?.deviated) v.push("the deviated marker shows while the toggle is on (it is for the hidden state)");
      await js(`window.__x.row("Show expert options").querySelector("input[type=checkbox]").click(); await window.__x.sleep(500); return true`);
      if (await js(`return window.__x.sections().includes("Expert") || !!window.__x.row(${JSON.stringify(EXPERT_ROW)})`)) v.push("the group is still shown after the toggle went off");
      await sleep(600);
      if ((await field("rotateWhileParked")) !== false) v.push(`hiding changed the value: rotateWhileParked ${await field("rotateWhileParked")}`);
      t = await js(`return window.__x.info("Show expert options")`);
      if (!t?.deviated) v.push(`no deviated marker on "Show expert options" with a non-default hidden expert value (${JSON.stringify(t)})`);
      await js(`window.__x.row("Show expert options").querySelector(".s-reset").click(); await window.__x.sleep(600); return true`);
      if (!(await waitFor(async () => (await field("rotateWhileParked")) === true, 4000))) v.push(`the marker's reset did not restore rotateWhileParked (${await field("rotateWhileParked")})`);
      t = await js(`return window.__x.info("Show expert options")`);
      if (t?.deviated) v.push("the marker stays after the reset");
      if ((await field("showExpertOptions")) !== false) v.push("the reset switched the toggle on");
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

    await cell('"Pause when covered": Settings → Playback row, default "A fullscreen or maximized window", saved', async () => {
      const v = [];
      await loadSettings();
      const L = "Pause when covered";
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
