// First-run help probe — `scripts/test-ui-matrix.sh --probe probe-firstrun.js` (the matrix's hermetic stack): the Library's
// welcome (app/ui/src/components/Welcome.tsx), the one-time tips (components/Tip.tsx) and the empty states that teach.
//   welcome:items        a library with wallpapers shows its cards and no welcome; Settings has "Welcome page" and "Tips"
//   welcome:settings     Settings → Welcome page → Show: the Library tab, the welcome in the grid's place (no card, no item
//                        sidebar); "Back to your wallpapers" brings the cards back
//   welcome:workshop     the Workshop card: whether Steam is here (an answer, not "looking"), the download mode switch is the
//                        setting (a pick saves it, the hint follows), "Steam settings" opens Settings at its section, "Browse
//                        the Workshop" opens Browse on the Workshop
//   welcome:steamError   a failed ask about Steam says so with Retry (never "Looking for Steam…" for good); Retry answers
//   welcome:import       "Import a folder" opens the import dialog on the picked folder
//   tip:<id>             each tip (cardMenu, playlists, itemSettings, downloadModes): shown in its place, dismissed, saved in
//                        settings (seenTips), not shown again after a reload
//   tip:again            Settings → Tips counts the dismissed ones; "Show tips again" empties seenTips and the Library's tip comes
//                        back without a reload
//   empty:playlist       the empty playlist bar and the Load dialog with no saved playlists say what they're for and how to fill them
//   empty:libSearch      a Library search that finds nothing says what it searched, "Clear search" brings the cards back
//   empty:favourites     the Library's Favourites ✓ with no favourite at all (a stubbed sign-in): how to star one
//   empty:hidden         every wallpaper hidden: the Library says where they are (not the welcome); the Hidden row ✓ with
//                        nothing hidden left: what it's for and how to fill it
//   empty:browse         a web source with nothing says so by name, a search on it says what it searched, "Clear search" goes back
//   motion:tip:<mode>    on / off / reduced: a dismissed tip leaves and a tip shown again arrives; off and reduced only fade
//                        (motion-off.js); on, what follows the tip glides
//   motion:welcome:<mode> on / off / reduced: the welcome comes in (Settings → Show) and leaves over the grid coming in
//   look:help            theme colours, no-glow (no glow on the bulb and the Steam line's icon), bg-live (the cards keep their fill,
//                        the words over the wallpaper their shadow)
//   welcome:empty        an empty library (Housekeeping's clear): the welcome as the empty state, no card, no "Back"; an import
//                        brings the grid in and the welcome leaves (last: it empties the library)
// Screenshots: <LIASCAPE_OUT>/firstrun-*.png. Exit 1 on any FAIL. LIASCAPE_ONLY = a regex over the cell names.
const { app, BrowserWindow } = require("electron");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const { SAMPLE, judge, brief } = require("./motion-off");

const E = process.env;
const U = E.LIASCAPE_URL;
const { withToken, authHeaders } = require("./api-auth"); // the backend's API token (.claude/rules/backend/api.md § Security)
const OUT = E.LIASCAPE_OUT;
const K = JSON.parse(E.LIASCAPE_CLIPS);
const ONLY = E.LIASCAPE_ONLY ? new RegExp(E.LIASCAPE_ONLY) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const TIPS = ["cardMenu", "playlists", "itemSettings", "downloadModes"];
app.setPath("userData", path.join(OUT, "electron-user-data"));

async function http(method, p, body) {
  try {
    const r = await fetch(U + p, { method, headers: authHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : J(body) });
    let json = null; try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, json };
  } catch (e) { return { status: 0, json: null, error: e.message }; }
}
async function waitFor(pred, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await pred()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const getSettings = async () => (await http("GET", "/settings")).json ?? {};
const setSettings = async (patch) => http("POST", "/settings", { ...(await getSettings()), ...patch });
const seen = async () => (await getSettings()).seenTips ?? null;

let win;
// every step has its own ceiling: a hung page step fails its cell instead of holding the test lock
const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: no answer in ${ms / 1000} s`)), ms))]);
const js = (code) => within(win.webContents.executeJavaScript(`(async () => { ${code} })()`), 30000, "page script");
async function reducedMotion(on) {
  const d = win.webContents.debugger;
  if (!d.isAttached()) d.attach("1.3");
  await within(d.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "" }] }), 10000, "reduced motion");
}
async function shot(name) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `firstrun-${name}.png`), img.toPNG()); }
// shown = in the document and drawn (the Library page kept hidden behind another tab is in the document, undrawn)
const shown = (sel) => js(`const e = document.querySelector(${J(sel)}); return !!e && e.getClientRects().length > 0`);
const text = (sel) => js(`return document.querySelector(${J(sel)})?.textContent.trim() ?? null`);
const click = (sel) => js(`const e = document.querySelector(${J(sel)}); if (!e) return false; e.click(); return true`);
const tab = (name) => js(`const t = [...document.querySelectorAll(".tab")].find((x) => x.textContent.trim() === ${J(name)}); t?.click(); return !!t`);
const page = () => js(`return document.querySelector(".app")?.dataset.page ?? null`);
const cards = () => js(`return [...document.querySelectorAll(".lib-scroll .card.lib")].filter((c) => c.getClientRects().length).length`);
async function load() {
  await win.loadURL(withToken(U + "/"));
  await waitFor(() => js(`return !!document.querySelector(".tab")`), 10000);
  await tab("Library");
  // the library read: its cards, or the welcome of an empty one
  await waitFor(async () => (await cards()) > 0 || (await shown("[data-welcome]")), 10000);
}
async function toSettings() {
  await tab("Settings");
  return waitFor(() => shown("[data-show-welcome]"), 8000);
}
const noMotionIs = (want) => waitFor(async () => (await js(`return document.documentElement.classList.contains("no-motion")`)) === want, 5000);

// CDP Fetch: the page's own reads of these paths answered here (a signed-in Steam with no favourites); null = off
let stubs = null;
// the requests each stubbed path answered (a check that a stubbed answer was really asked for)
const stubHits = {};
async function stubFetch(map) {
  const d = win.webContents.debugger;
  if (!d.isAttached()) d.attach("1.3");
  stubs = map;
  if (!map) { await d.sendCommand("Fetch.disable"); return; }
  await d.sendCommand("Fetch.enable", { patterns: Object.keys(map).map((p) => ({ urlPattern: `*${p}*` })) });
}
function onDebuggerMessage(_e, method, params) {
  if (method !== "Fetch.requestPaused") return;
  const d = win.webContents.debugger;
  const hit = stubs && Object.keys(stubs).find((p) => params.request.url.includes(p));
  if (hit) stubHits[hit] = (stubHits[hit] ?? 0) + 1;
  if (!hit) { d.sendCommand("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {}); return; }
  const a = stubs[hit], failed = a && a.__status; // { __status, body }: that status; anything else: a 200 with it as the body
  d.sendCommand("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: failed ? a.__status : 200,
    responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(J(failed ? a.body : a)).toString("base64") }).catch(() => {});
}

app.whenReady().then(async () => {
  setTimeout(() => { console.log("FAIL  the probe ran past 15 minutes"); app.exit(1); }, 15 * 60 * 1000).unref?.();
  win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
  win.focus();
  win.webContents.debugger.on("message", onDebuggerMessage);
  const results = [];
  const cell = async (name, fn) => {
    if (ONLY && !ONLY.test(name)) return;
    let v;
    try { v = await fn(); } catch (e) { v = [`ERROR ${e.message}`]; }
    results.push({ name, v });
    console.log(`${v.length ? "FAIL" : "PASS"}  ${name}`);
    for (const x of v) console.log(`        - ${x}`);
  };
  const T = fs.mkdtempSync(path.join(path.dirname(E.LIASCAPE_BACKEND_LOG), "firstrun-")); // inside the stack's dir: its cleanup takes it
  try {
    await setSettings({ settingsLevel: "standard", morphs: true, glows: true, liveWallpaperBehindAllTabs: false, workshopDownloadMode: "steamapp",
      seenTips: [], isPlaylistBarCollapsed: false });
    await http("POST", "/playlist/state", { videoPaths: K, settings: null, name: null });
    await load(); // a page first: the debugger (reduced motion, the fetch stubs) needs one

    await cell("welcome:items", async () => {
      const v = [];
      const n = await cards();
      if (!n) return ["the library's cards never showed — proved nothing"];
      if (await shown("[data-welcome]")) v.push("a library with wallpapers shows the welcome");
      if (!(await toSettings())) return [...v, "Settings has no Welcome page row ([data-show-welcome])"];
      if (!(await shown("[data-tips-again]"))) v.push("Settings has no Tips row ([data-tips-again])");
      await sleep(1200);
      await js(`document.querySelector('[data-section="start"]')?.scrollIntoView({ block: "center" }); return true`);
      await sleep(600);
      await shot("settings-start");
      return v;
    });

    await cell("welcome:settings", async () => {
      const v = [];
      await load();
      // an open item sidebar goes with the grid
      await js(`document.querySelector(".lib-scroll .card.lib .thumb-wrap")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); return true`);
      if (!(await waitFor(() => shown(".side-panel"), 3000))) return ["a card's right-click opened no item sidebar — proved nothing"];
      if (!(await toSettings())) return ["no Welcome page row"];
      await click("[data-show-welcome]");
      if (!(await waitFor(async () => (await page()) === "library", 3000))) v.push(`Show left the page on ${await page()} (want the Library)`);
      if (!(await waitFor(() => shown('[data-welcome="reopened"]'), 4000))) return [...v, "the welcome never showed on the Library"];
      await sleep(900);
      await shot("welcome-reopened");
      if (await cards()) v.push(`${await cards()} cards show beside the welcome (want none: it takes the grid's place)`);
      if (await shown(".side-panel")) v.push("the item sidebar stayed open over the welcome");
      for (const c of ["workshop", "import", "browse"]) if (!(await shown(`[data-welcome-choice="${c}"]`))) v.push(`no ${c} choice`);
      if (!(await click("[data-welcome-close]"))) return [...v, "no \"Back to your wallpapers\""];
      if (!(await waitFor(async () => !(await shown("[data-welcome]")) && (await cards()) > 0, 3000))) v.push("Back didn't bring the cards back");
      return v;
    });

    await cell("welcome:workshop", async () => {
      const v = [];
      await setSettings({ workshopDownloadMode: "steamapp" });
      await load();
      await toSettings(); await click("[data-show-welcome]");
      if (!(await waitFor(() => shown("[data-welcome]"), 4000))) return ["the welcome never showed"];
      const foundOk = await waitFor(async () => ["yes", "noFolder", "noSteam"].includes(await js(`return document.querySelector("[data-welcome-found]")?.dataset.welcomeFound`)), 4000);
      const f = await js(`const e = document.querySelector("[data-welcome-found]"); return { kind: e?.dataset.welcomeFound, text: e?.querySelector(".welcome-stack > span:not([data-off])")?.textContent.trim() }`);
      console.log(`        Steam here: ${f.kind} — ${f.text}`);
      if (!foundOk) v.push(`the Steam line never answered (${J(f)})`);
      const mode = () => js(`return document.querySelector("[data-welcome-mode]")?.dataset.welcomeMode ?? null`);
      if ((await mode()) !== "steamapp") v.push(`the switch shows ${await mode()} for the saved steamapp`);
      const hintNow = () => js(`return document.querySelector("[data-welcome-mode-hint] > span:not([data-off])")?.textContent ?? null`);
      const hint1 = await hintNow();
      await click('[data-welcome-wsmode="subscribe"]');
      const saved = await waitFor(async () => (await getSettings()).workshopDownloadMode === "subscribe", 3000);
      if (!saved) v.push("picking \"Your Steam login\" didn't save workshopDownloadMode = subscribe");
      const hint2 = await hintNow();
      if (hint1 === hint2) v.push(`the hint didn't follow the mode (${J(hint2)})`);
      await shot("welcome-workshop");
      await click('[data-welcome-wsmode="steamapp"]');
      await waitFor(async () => (await getSettings()).workshopDownloadMode === "steamapp", 3000);
      // Steam settings: Settings, at its section
      await click('[data-welcome-go="steam"]');
      if (!(await waitFor(async () => (await page()) === "settings", 3000))) v.push(`"Steam settings" left the page on ${await page()}`);
      const inView = await waitFor(() => js(`const s = document.querySelector('[data-section="workshop"]'); if (!s) return false; const r = s.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2`), 4000);
      if (!inView) v.push(`Settings' "Getting Workshop wallpapers" isn't brought into view (${J(await js(`return document.querySelector('[data-section="workshop"]')?.getBoundingClientRect().top ?? null`))})`);
      // Browse the Workshop
      await click("[data-show-welcome]");
      await waitFor(() => shown("[data-welcome]"), 4000);
      await click('[data-welcome-go="workshop"]');
      if (!(await waitFor(async () => (await page()) === "browse", 3000))) v.push(`"Browse the Workshop" left the page on ${await page()}`);
      const lit = await waitFor(async () => /Workshop/.test(await js(`return document.querySelector(".pill.active")?.textContent ?? ""`)), 3000);
      if (!lit) v.push(`Browse opened on ${J(await text(".pill.active"))} (want the Workshop)`);
      await tab("Library"); await click("[data-welcome-close]");
      return v;
    });

    await cell("welcome:steamError", async () => {
      const v = [];
      await load();
      await stubFetch({ "/steam/status": { __status: 500, body: { error: "probe" } } });
      try {
        await toSettings(); await click("[data-show-welcome]");
        if (!(await waitFor(() => shown("[data-welcome]"), 4000))) return ["the welcome never showed"];
        const kind = () => js(`return document.querySelector("[data-welcome-found]")?.dataset.welcomeFound ?? null`);
        if (!(await waitFor(async () => (await kind()) === "error", 4000))) return [`a failed ask leaves the Steam line at ${J(await kind())} (want "error")`];
        const t = await js(`return document.querySelector(".welcome-stack > span:not([data-off])")?.textContent.trim() ?? null`);
        console.log(`        "${t}"`);
        if (!(await shown("[data-welcome-found-retry]"))) v.push("no Retry on a failed ask");
        await stubFetch(null);
        await click("[data-welcome-found-retry]");
        if (!(await waitFor(async () => ["yes", "noFolder", "noSteam"].includes(await kind()), 4000))) v.push(`Retry didn't answer: ${J(await kind())}`);
      } finally { await stubFetch(null); }
      await click("[data-welcome-close]");
      return v;
    });

    await cell("welcome:import", async () => {
      const v = [];
      await load();
      await toSettings(); await click("[data-show-welcome]");
      if (!(await waitFor(() => shown("[data-welcome]"), 4000))) return ["the welcome never showed"];
      const d = path.join(T, "pick"); fs.mkdirSync(d, { recursive: true });
      cp.spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x36", "-frames:v", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(d, "picked.mp4")]);
      await js(`window.liascape = { pickFolder: async () => ${J(d)}, pickFiles: async () => null }; return true`);
      await click('[data-welcome-go="import"]');
      if (!(await waitFor(() => shown("[data-import-dialog]"), 5000))) v.push("\"Import a folder\" opened no import dialog");
      else if (!(await waitFor(() => js(`return [...document.querySelectorAll("[data-import-item]")].some((e) => e.dataset.importItem.endsWith("/picked.mp4"))`), 8000)))
        v.push(`the import dialog doesn't list the picked folder's video: ${J(await js(`return [...document.querySelectorAll("[data-import-item]")].map((e) => e.dataset.importItem)`))}`);
      await js(`document.querySelector(".imp-modal .btn.ghost")?.click(); return true`);
      await waitFor(async () => !(await shown("[data-import-dialog]")), 3000);
      await click("[data-welcome-close]");
      return v;
    });

    // each tip: shown where it belongs, dismissed, saved, not shown again
    const contexts = {
      cardMenu: { sel: ".lib-scroll > [data-tip=cardMenu]", async open() { await load(); } },
      playlists: { sel: ".playlist-bar-head [data-tip=playlists]", async open() { await load(); } },
      itemSettings: { sel: ".side-panel [data-tip=itemSettings]", async open() {
        await load();
        await js(`document.querySelector(".lib-scroll .card.lib .thumb-wrap")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); return true`);
        await waitFor(() => shown(".side-panel .side-body:not(.wait)"), 4000);
      } },
      downloadModes: { sel: ".side-panel [data-tip=downloadModes]", async open() {
        await load();
        await toSettings(); await click("[data-show-welcome]"); await waitFor(() => shown("[data-welcome]"), 4000);
        await click('[data-welcome-go="workshop"]');
        await waitFor(() => js(`return document.querySelectorAll(".br-scroll .card:not(.skel-card) .thumb-wrap").length > 0`), 8000);
        await js(`document.querySelector(".br-scroll .card:not(.skel-card) .thumb-wrap")?.click(); return true`);
        await waitFor(() => shown(".side-panel .side-body"), 4000);
      } },
    };
    for (const id of TIPS) {
      await cell(`tip:${id}`, async () => {
        const v = [], c = contexts[id];
        await setSettings({ seenTips: [] });
        await c.open();
        if (!(await waitFor(() => shown(c.sel), 4000))) return [`the ${id} tip never showed (${c.sel})`];
        const t = await js(`const e = document.querySelector(${J(c.sel)}); return { text: e.querySelector(".tip-text")?.textContent.trim(), x: !!e.querySelector("[data-tip-dismiss]"),
          oneLine: e.getBoundingClientRect().height < 40 }`);
        console.log(`        "${t.text}"`);
        if (!t.x) v.push("no dismiss button");
        if (id === "cardMenu" && !(await js(`return document.querySelector(${J(c.sel)}).nextElementSibling?.classList.contains("grid")`))) v.push("the card tip isn't right above the grid");
        await sleep(400); await shot(`tip-${id}`);
        await js(`document.querySelector(${J(c.sel + " [data-tip-dismiss]")}).click(); return true`);
        if (!(await waitFor(async () => !(await shown(c.sel)), 2000))) v.push("still shown after its dismiss");
        if (!(await waitFor(async () => (await seen())?.includes(id), 3000))) v.push(`not saved: seenTips ${J(await seen())}`);
        await c.open();
        await sleep(1500);
        if (await shown(c.sel)) v.push("shown again after a reload");
        // the other tips are untouched by this one's dismiss
        const s = await seen();
        if (s && s.some((x) => x !== id)) v.push(`dismissing ${id} saved ${J(s)}`);
        return v;
      });
    }

    await cell("tip:again", async () => {
      const v = [];
      await setSettings({ seenTips: TIPS });
      await load();
      if (await shown(contexts.cardMenu.sel)) v.push("the card tip shows while seen");
      if (!(await toSettings())) return [...v, "no Settings"];
      const row = await js(`const b = document.querySelector("[data-tips-again]"); return { off: b?.disabled, hint: b?.closest(".srow")?.querySelector(".shint")?.textContent ?? null }`);
      console.log(`        Tips row: ${J(row)}`);
      if (row.off !== false) v.push(`"Show tips again" is ${row.off ? "disabled" : "missing"} with all four dismissed`);
      if (!/4 of 4/.test(row.hint ?? "")) v.push(`the row's hint doesn't count them: ${J(row.hint)}`);
      await click("[data-tips-again]");
      if (!(await waitFor(async () => J(await seen()) === "[]", 3000))) v.push(`seenTips after Show tips again: ${J(await seen())}`);
      if (!(await js(`return document.querySelector("[data-tips-again]")?.disabled`))) v.push("\"Show tips again\" stays on with none dismissed");
      await tab("Library");
      if (!(await waitFor(() => shown(contexts.cardMenu.sel), 3000))) v.push("the card tip didn't come back on the Library (no reload)");
      return v;
    });

    await cell("empty:playlist", async () => {
      const v = [];
      await http("POST", "/playlist/state", { videoPaths: [], settings: null, name: null });
      await load();
      const t = await text('[data-empty="playlist"]');
      console.log(`        bar: ${J(t)}`);
      if (!t || !/empty/i.test(t) || !/Play/.test(t) || !/card/.test(t)) v.push(`the empty bar says ${J(t)} (want what it's for and how to fill it)`);
      if (await shown("[data-tip=playlists]")) v.push("the playlist tip shows on an empty playlist");
      await js(`document.querySelector('.playlist-bar-head [title="Load playlist"]')?.click(); return true`);
      await waitFor(() => shown(".pl-modal"), 3000);
      const s = await text('[data-empty="saved-playlists"]');
      console.log(`        load dialog: ${J(s)}`);
      if (!s || !/Save/.test(s)) v.push(`the Load dialog with nothing saved says ${J(s)} (want how to save one)`);
      await shot("empty-playlist");
      await js(`document.querySelector(".pl-modal .btn.ghost")?.click(); return true`);
      await http("POST", "/playlist/state", { videoPaths: K, settings: null, name: null });
      return v;
    });

    await cell("empty:libSearch", async () => {
      const v = [];
      await load();
      await js(`const i = document.querySelector('.topbar .tsearch input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(i, "zzqx-none"); i.dispatchEvent(new Event("input", { bubbles: true })); return true`);
      if (!(await waitFor(() => shown('[data-wf-none="search"]'), 3000))) return [`a search that finds nothing shows ${await cards()} cards and no note`];
      const t = await text('[data-wf-none="search"] > span');
      if (!/zzqx-none/.test(t ?? "")) v.push(`the note doesn't say what was searched: ${J(t)}`);
      await shot("empty-search");
      await click('[data-wf-none="search"] button');
      if (!(await waitFor(async () => (await cards()) > 0, 3000))) v.push("Clear search didn't bring the cards back");
      return v;
    });

    await cell("empty:favourites", async () => {
      const v = [];
      await stubFetch({ "/steam/status": { signedIn: true, rejected: false, accountName: "probe", daysLeft: 100, mode: "steamapp", usable: true },
        "/workshop/my-favorites": { signedIn: true, version: 1, loading: null, error: null, items: [] } });
      try {
        await js(`localStorage.setItem("liascape.libFilter", ${J(J({ include: ["@favorites"], exclude: [] }))}); return true`);
        await load();
        if (!(await waitFor(() => shown('[data-wf-none="favourites"]'), 5000)))
          return [`Favourites ✓ with none: ${await cards()} cards, notes ${J(await js(`return [...document.querySelectorAll("[data-wf-none]")].map((e) => e.dataset.wfNone + ": " + e.textContent)`))}`];
        const t = await text('[data-wf-none="favourites"] > span');
        console.log(`        "${t}"`);
        if (!/[Ss]tar/.test(t ?? "")) v.push(`the note doesn't say how to star one: ${J(t)}`);
        await shot("empty-favourites");
      } finally {
        await js(`localStorage.removeItem("liascape.libFilter"); return true`);
        await stubFetch(null);
      }
      return v;
    });

    await cell("empty:hidden", async () => {
      const v = [];
      const lib = (await http("GET", "/library")).json ?? [];
      const keys = lib.map((i) => i.videoPath);
      if (!keys.length) return ["an empty library — proved nothing"];
      const notes = () => js(`return [...document.querySelectorAll(".lib-scroll [data-wf-none]")].map((e) => e.dataset.wfNone + ": " + e.textContent.trim())`);
      try {
        await http("POST", "/hidden", { scope: "library", hide: lib.map((i) => ({ key: i.videoPath, title: i.title })) });
        await load();
        if (!(await waitFor(() => shown('.lib-scroll [data-wf-none="allHidden"]'), 5000))) v.push(`every wallpaper hidden: notes ${J(await notes())}, ${await cards()} cards`);
        if (await shown("[data-welcome]")) v.push("every wallpaper hidden shows the empty library's welcome");
        else console.log(`        all hidden: ${J(await notes())}`);
        await shot("empty-allhidden");
        // the Hidden row ✓ shows them; once none is hidden any more, it says what it's for
        await js(`localStorage.setItem("liascape.libFilter", ${J(J({ include: ["@hidden"], exclude: [] }))}); return true`);
        await load();
        await http("POST", "/hidden", { scope: "library", unhide: keys });
        if (!(await waitFor(() => shown('.lib-scroll [data-wf-none="hidden"]'), 5000))) v.push(`the Hidden row ✓ with nothing hidden: notes ${J(await notes())}, ${await cards()} cards`);
        else console.log(`        nothing hidden: ${J(await notes())}`);
        await shot("empty-hidden");
      } finally {
        await js(`localStorage.removeItem("liascape.libFilter"); return true`);
        await http("POST", "/hidden", { scope: "library", unhide: keys });
      }
      return v;
    });

    await cell("empty:browse", async () => {
      const v = [];
      await load();
      await tab("Browse");
      // the first web source: the stack's web fixture lists nothing for it ({}), so it says what it is and that it has nothing now;
      // a search on it says what was searched, and Clear search goes back to the source's own note
      await waitFor(() => js(`return document.querySelectorAll(".pill").length > 0`), 5000);
      const src = await js(`const p = document.querySelector(".pill"); p?.click(); return p?.textContent.trim() ?? null`);
      if (!(await waitFor(() => shown('[data-wf-none="browse-source"]'), 6000)))
        return [`${src} listing nothing shows no note: ${J(await js(`return [...document.querySelectorAll("[data-wf-none]")].map((e) => e.dataset.wfNone)`))}, ${await js(`return document.querySelectorAll(".br-scroll .card:not(.skel-card):not([data-leaving])").length`)} cards`];
      const t0 = await text('[data-wf-none="browse-source"] > span');
      console.log(`        "${t0}"`);
      if (!(t0 ?? "").includes(src)) v.push(`the source's note doesn't name it (${J(src)}): ${J(t0)}`);
      await waitFor(() => js(`return !!document.querySelector('.topbar .tsearch input')`), 5000);
      await js(`const i = document.querySelector('.topbar .tsearch input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(i, "zzqx-none"); i.dispatchEvent(new Event("input", { bubbles: true })); return true`);
      if (!(await waitFor(() => shown('[data-wf-none="browse-search"]'), 6000)))
        return [...v, `no note for a search with no result: ${J(await js(`return [...document.querySelectorAll("[data-wf-none]")].map((e) => e.dataset.wfNone)`))}`];
      const t = await text('[data-wf-none="browse-search"] > span');
      console.log(`        "${t}"`);
      if (!/zzqx-none/.test(t ?? "")) v.push(`the note doesn't say what was searched: ${J(t)}`);
      await shot("empty-browse");
      // a search whose request fails says nothing about it: the empty list the last answer left isn't its answer
      const type = (q) => js(`const i = document.querySelector('.topbar .tsearch input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(i, ${J(q)}); i.dispatchEvent(new Event("input", { bubbles: true })); return true`);
      await stubFetch({ "/browse": { __status: 500, body: { error: "probe" } } });
      try {
        const asked = stubHits["/browse"] ?? 0;
        await type("zzqx-other");
        if (!(await waitFor(() => (stubHits["/browse"] ?? 0) > asked && js(`return !document.querySelector(".loadbar")`), 5000))) v.push("the search sent no request to fail — proved nothing");
        await sleep(500);
        const t2 = await js(`return [...document.querySelectorAll("[data-wf-none]")].map((e) => e.textContent.trim())`);
        console.log(`        failed search: notes ${J(t2)}`);
        if (t2.some((x) => x.includes("zzqx-other"))) v.push(`a failed search is said to have no match: ${J(t2)}`);
      } finally { await stubFetch(null); }
      await type("zzqx-none");
      if (!(await waitFor(() => shown('[data-wf-none="browse-search"]'), 6000))) return [...v, "the search's note didn't come back once its request answered"];
      await click('[data-wf-none="browse-search"] button');
      if (!(await waitFor(async () => (await js(`return document.querySelector('.topbar .tsearch input')?.value ?? null`)) === "" && (await shown('[data-wf-none="browse-source"]')), 6000)))
        v.push(`Clear search: the field holds ${J(await js(`return document.querySelector('.topbar .tsearch input')?.value ?? null`))}, notes ${J(await js(`return [...document.querySelectorAll("[data-wf-none]")].map((e) => e.dataset.wfNone)`))}`);
      return v;
    });

    for (const mode of ["on", "off", "reduced"]) {
      await cell(`motion:tip:${mode}`, async () => {
        const v = [];
        await setSettings({ morphs: mode !== "off", seenTips: [] }); await reducedMotion(mode === "reduced");
        await load();
        if (!(await noMotionIs(mode !== "on"))) return [`:root.no-motion doesn't match motion ${mode} — proved nothing`];
        const sel = contexts.cardMenu.sel;
        if (!(await waitFor(() => shown(sel), 4000))) return ["the card tip never showed"];
        await sleep(300);
        const outP = js(`const s = ${SAMPLE({ tip: sel, grid: ".lib-scroll > .grid" }, 800)}; document.querySelector(${J(sel + " [data-tip-dismiss]")}).click(); return await s`);
        await sleep(110); await shot(`motion-tip-leave-mid-${mode}`);
        const out = await outP;
        console.log(`        leave: tip ${brief(out.tip)}`);
        const ys = [...new Set(out.grid.filter((f) => f[1] != null).map((f) => f[3]))];
        if (mode === "on") {
          if (!out.tip.some((f) => f[1] != null && f[1] > 0.05 && f[1] < 0.95)) v.push("motion on: the tip left without fading");
          if (ys.length < 4) v.push(`motion on: the grid jumped into the tip's room (${ys.length} positions: ${J(ys.slice(0, 6))})`);
        } else {
          v.push(...judge(`motion ${mode}: the leaving tip`, out.tip, { leave: true }));
          if (ys.length > 2) v.push(`motion ${mode}: the grid glided into the tip's room (${ys.length} positions)`);
        }
        await waitFor(async () => (await seen())?.includes("cardMenu"), 3000);
        // shown again from Settings: it arrives on the Library
        await toSettings();
        await click("[data-tips-again]");
        await waitFor(async () => J(await seen()) === "[]", 3000);
        const inn = await js(`const s = ${SAMPLE({ tip: sel, grid: ".lib-scroll > .grid" }, 900)};
          [...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "Library").click(); return await s`);
        console.log(`        arrive: tip ${brief(inn.tip)}`);
        if (mode === "on") {
          if (!inn.tip.some((f) => f[1] != null && f[1] > 0.05 && f[1] < 0.95)) v.push("motion on: the tip arrived without fading in");
        } else v.push(...judge(`motion ${mode}: the arriving tip`, inn.tip, { appear: true }));
        await shot(`motion-tip-${mode}`);
        return v;
      });
    }
    await reducedMotion(false);

    for (const mode of ["on", "off", "reduced"]) {
      await cell(`motion:welcome:${mode}`, async () => {
        const v = [];
        await setSettings({ morphs: mode !== "off" }); await reducedMotion(mode === "reduced");
        await load();
        if (!(await noMotionIs(mode !== "on"))) return [`:root.no-motion doesn't match motion ${mode} — proved nothing`];
        await toSettings();
        const card = '[data-welcome] [data-welcome-choice="workshop"]';
        const innP = js(`const s = ${SAMPLE({ card }, 1100)}; document.querySelector("[data-show-welcome]").click(); return await s`);
        await sleep(260); await shot(`motion-welcome-in-mid-${mode}`);
        const inn = await innP;
        console.log(`        in: ${brief(inn.card)}`);
        if (mode === "on") {
          const ys = [...new Set(inn.card.filter((f) => f[1] != null).map((f) => f[3]))];
          if (ys.length < 3) v.push(`motion on: the welcome's cards didn't rise in (${J(ys.slice(0, 6))})`);
        } else v.push(...judge(`motion ${mode}: the welcome coming in`, inn.card, { appear: true }));
        await sleep(400);
        const outP = js(`const s = ${SAMPLE({ welcome: "[data-welcome]", grid: ".lib-scroll > .grid" }, 900)}; document.querySelector("[data-welcome-close]").click(); return await s`);
        await sleep(110); await shot(`motion-welcome-out-mid-${mode}`);
        const out = await outP;
        console.log(`        out: welcome ${brief(out.welcome)}, grid ${brief(out.grid)}`);
        if (mode === "on") {
          if (!out.welcome.some((f) => f[1] != null && f[1] > 0.05 && f[1] < 0.95)) v.push("motion on: the welcome left without fading");
          if (!out.grid.some((f) => f[1] != null && f[1] > 0.05 && f[1] < 0.95)) v.push("motion on: the grid came in without fading");
        } else {
          v.push(...judge(`motion ${mode}: the welcome leaving`, out.welcome, { leave: true }));
          v.push(...judge(`motion ${mode}: the grid coming in`, out.grid, { appear: true, size: false }));
        }
        return v;
      });
    }
    await reducedMotion(false);
    await setSettings({ morphs: true });

    await cell("look:help", async () => {
      const v = [];
      await setSettings({ seenTips: [], glows: true, liveWallpaperBehindAllTabs: false });
      await load();
      await toSettings(); await click("[data-show-welcome]");
      await waitFor(() => shown("[data-welcome]"), 4000);
      await sleep(900);
      const look = () => js(`const cs = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null; };
        const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
        const probe = document.createElement("span"); probe.style.color = accent; document.body.append(probe); const acc = getComputedStyle(probe).color; probe.remove();
        const f = document.querySelector("[data-welcome-found]"); const ic = f?.querySelector("svg");
        return { acc, h3: cs("[data-welcome] .ssection h3")?.color, chip: cs("[data-welcome] .ssection")?.backgroundColor,
          foundIcon: ic ? getComputedStyle(ic).filter : null, headFilter: cs(".welcome-head h2")?.filter }`);
      const a = await look();
      console.log(`        glow on: ${J(a)}`);
      if (a.h3 !== a.acc) v.push(`a choice's title isn't the theme's accent (${a.h3} vs ${a.acc})`);
      if (!/drop-shadow/.test(a.foundIcon ?? "")) v.push(`the Steam line's icon doesn't glow with glows on (${a.foundIcon})`);
      await shot("look-glow");
      await setSettings({ glows: false }); await load(); await toSettings(); await click("[data-show-welcome]"); await waitFor(() => shown("[data-welcome]"), 4000); await sleep(900);
      const b = await look();
      if (b.foundIcon !== "none") v.push(`no-glow: the Steam line's icon ${b.foundIcon == null ? "is missing — proved nothing" : `still glows (${b.foundIcon})`}`);
      await click("[data-welcome-close]");
      await waitFor(() => shown("[data-tip=cardMenu] .tip-ico"), 3000);
      const tipIco = await js(`const i = document.querySelector("[data-tip=cardMenu] .tip-ico"); return i && i.getClientRects().length ? getComputedStyle(i).filter : null`);
      if (tipIco !== "none") v.push(`no-glow: the tip's bulb ${tipIco == null ? "isn't shown — proved nothing" : `still glows (${tipIco})`}`);
      await shot("look-noglow");
      await setSettings({ glows: true, liveWallpaperBehindAllTabs: true }); await load(); await toSettings(); await click("[data-show-welcome]"); await waitFor(() => shown("[data-welcome]"), 4000); await sleep(900);
      const c = await look();
      console.log(`        bg-live: ${J(c)}`);
      if (!/drop-shadow/.test(c.headFilter ?? "")) v.push(`bg-live: the welcome's title has no shadow over the wallpaper (${c.headFilter})`);
      if (!c.chip || /rgba\(0, 0, 0, 0\)|transparent/.test(c.chip)) v.push(`bg-live: a choice card lost its fill (${c.chip})`);
      await click("[data-welcome-close]");
      const tipText = await js(`const t = document.querySelector("[data-tip=cardMenu] .tip-text"); return t ? getComputedStyle(t).filter : null`);
      if (!/drop-shadow/.test(tipText ?? "")) v.push(`bg-live: the tip's words have no shadow over the wallpaper (${tipText})`);
      await shot("look-bglive");
      await setSettings({ liveWallpaperBehindAllTabs: false });
      return v;
    });

    // last: it empties the library
    await cell("welcome:empty", async () => {
      const v = [];
      const keep = path.join(T, "keep.mp4");
      fs.copyFileSync(fs.realpathSync(K[0]), keep);
      await http("POST", "/library/clear");
      await load();
      if (!(await waitFor(() => shown('[data-welcome="empty"]'), 5000))) return [`an empty library shows no welcome (${await cards()} cards)`];
      await sleep(900);
      await shot("welcome-empty");
      if (await cards()) v.push("cards show in an empty library");
      if (await shown("[data-welcome-close]")) v.push("an empty library's welcome offers \"Back to your wallpapers\"");
      const sub = await text(".welcome-sub");
      if (!/empty/i.test(sub ?? "")) v.push(`the welcome doesn't say the library is empty: ${J(sub)}`);
      // a wallpaper comes in through the welcome's own Import: the grid takes the welcome's place, live
      await js(`window.liascape = { pickFolder: async () => ${J(T)}, pickFiles: async () => null }; return true`);
      await click('[data-welcome-go="import"]');
      if (!(await waitFor(() => js(`return !!document.querySelector("[data-import-go]") && !document.querySelector("[data-import-go]").disabled`), 8000))) return [...v, "the import dialog never listed the folder"];
      await click("[data-import-go]");
      if (!(await waitFor(async () => (await cards()) > 0 && !(await shown("[data-welcome]")), 10000))) v.push(`after an import: ${await cards()} cards, welcome ${await shown("[data-welcome]")}`);
      await shot("welcome-gone");
      return v;
    });
  } catch (e) {
    console.log(`FAIL  probe: ${e.stack}`);
    results.push({ name: "probe", v: [e.message] });
  }
  const failed = results.filter((r) => r.v.length);
  console.log(`FIRSTRUN ${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
});
