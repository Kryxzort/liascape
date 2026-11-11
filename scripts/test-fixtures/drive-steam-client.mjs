// scripts/test-steam-signin.sh § 3: drives a private backend whose "Steam client" is fake_steamclient.c (Helpers/SteamClientUgc.cs)
import fs from "node:fs";
const [U, T] = [process.env.U, process.env.T];
const TOKEN = fs.readFileSync(`${process.env.XDG_CONFIG_HOME}/liascape/serve.token`, "utf8").trim();
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o = {}) => realFetch(u, { ...o, headers: { ...(o.headers || {}), "X-Liascape-Token": TOKEN } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (ok, name, extra = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
const urls = () => fs.readFileSync(`${T}/xdg-open.urls`, "utf8").trim().split("\n").filter(Boolean);
const ev = {}; // page URL → its download-progress payloads
const todo = []; // WS steam-todo payloads (the Steam to-do — Web/SteamTodo.cs)
const ws = new WebSocket(U.replace("http", "ws") + "/events?token=" + encodeURIComponent(TOKEN));
ws.onmessage = (m) => { const e = JSON.parse(m.data); if (e.type === "download-progress") (ev[e.payload.id] ??= []).push(e.payload);
  if (e.type === "steam-todo") todo.push(e.payload); };
const post = (p, body) => fetch(U + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
await new Promise((r) => { ws.onopen = r; });
const sources = await (await fetch(U + "/sources")).json();
const src = sources.find((s) => s.supportsTagFilter)?.index ?? sources.findIndex((s) => s.supportsTagFilter);
const pageUrl = (id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
const result = (id) => ({ title: `ws-${id}`, thumbnailUrl: "", pageUrl: pageUrl(id), workshopId: id, isScene: false, trailerKnown: true });
const download = (id, signal) => fetch(U + "/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: src, result: result(id), apply: false }), signal });
const lib = async () => (await (await fetch(U + "/library")).json());
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const childPid = () => +fs.readFileSync(`${T}/steamlib/child.pid`, "utf8").trim();
const released = () => fs.existsSync(`${T}/steamlib/released`) ? fs.readFileSync(`${T}/steamlib/released`, "utf8").split("\n").filter(Boolean) : [];

// a. the Steam client does it
let n0 = urls().length;
let r = await Promise.race([download("710000001"), sleep(20000).then(() => null)]);
let body = r ? await r.json() : null;
out(r?.status === 200 && body?.workshopId === "710000001", "through the Steam client: the download finishes", r ? `${r.status} ${JSON.stringify(body).slice(0, 140)}` : "timed out");
const pct = (ev[pageUrl("710000001")] ?? []).filter((e) => e.value > 0 && e.value < 1).map((e) => +e.value.toFixed(3));
out(new Set(pct).size >= 2 && pct.every((v, i) => i === 0 || v >= pct[i - 1]), "a real percent between 0 and 1 (Steam's bytes), climbing", `[${pct.slice(0, 8)}]`);
const sts = [...new Set((ev[pageUrl("710000001")] ?? []).map((e) => e.status).filter(Boolean))];
const seq = (ev[pageUrl("710000001")] ?? []).map((e) => e.status).filter(Boolean);
const firstBytes = seq.indexOf("Steam is downloading it…");
out(sts.includes("Subscribing through Steam…") && firstBytes >= 0 && !seq.slice(firstBytes).includes("Waiting for Steam…"),
  "the steps: Subscribing through Steam… → Steam is downloading it…, never back to waiting", sts.join(" | "));
out(urls().length === n0, "nothing opened in the Steam app", `${urls().length - n0} opened`);
out((await lib()).some((i) => i.workshopId === "710000001"), "/library has it (from the folder Steam reported — not the Workshop folder)");
await sleep(500);
let rel = released();
out(!alive(childPid()) && rel.includes("user") && rel.includes("pipe"), "the helper released its Steam user + pipe and exited", `pid ${childPid()} alive ${alive(childPid())}, released [${rel}]`);

// b. Steam refuses (not running / WE not owned) → the old way: the item's page in the Steam app
fs.writeFileSync(`${T}/steamlib/fail-init`, "");
n0 = urls().length;
const p = download("710000002");
let u = null;
for (let i = 0; i < 100 && !u; i++) { await sleep(100); u = urls().slice(n0).find((x) => x.includes("710000002")) ?? null; }
out(u === "steam://url/CommunityFilePage/710000002", "Steam refused the helper → the item's page opens in the Steam app (the old path)", u ?? "nothing opened");
const d = `${T}/ws3/431960/710000002`; fs.mkdirSync(d, { recursive: true });
fs.copyFileSync(`${T}/clip.mp4`, `${d}/v.mp4`); fs.writeFileSync(`${d}/project.json`, JSON.stringify({ type: "video", file: "v.mp4", title: "ws-710000002" }));
r = await Promise.race([p, sleep(20000).then(() => null)]);
out(r?.status === 200, "…and still finishes once Steam has it", r ? String(r.status) : "timed out");
await post("/steam-todo/next"); // its Steam to-do entry waits for the user's Next even after Steam delivered
fs.rmSync(`${T}/steamlib/fail-init`);

// c. cancel from the page mid-download: the child releases Steam and exits, nothing imported
const r0 = released().length;
const ac = new AbortController();
const pc = download("710000003", ac.signal).catch(() => "aborted");
for (let i = 0; i < 60 && !(ev[pageUrl("710000003")] ?? []).some((e) => e.value > 0); i++) await sleep(50);
ac.abort(); await pc; await sleep(1500);
const pid3 = childPid();
out(!alive(pid3) && released().length >= r0 + 2 && !(await lib()).some((i) => i.workshopId === "710000003"),
  "cancelled mid-download: the child released Steam + exited, nothing imported", `pid ${pid3} alive ${alive(pid3)}, released +${released().length - r0}`);
// d. "Open in the Steam app" (steampage): the page opens even though the Steam client would answer — no helper started
const settings = await (await fetch(U + "/settings")).json();
await fetch(U + "/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...settings, workshopDownloadMode: "steampage" }) });
const pidBefore = childPid();
n0 = urls().length;
const pd = download("710000004");
u = null;
for (let i = 0; i < 100 && !u; i++) { await sleep(100); u = urls().slice(n0).find((x) => x.includes("710000004")) ?? null; }
out(u === "steam://url/CommunityFilePage/710000004" && childPid() === pidBefore, "Open in the Steam app: the page opens, the Steam-client helper isn't used", `${u ?? "nothing opened"}, helper pid ${childPid() === pidBefore ? "unchanged" : "NEW"}`);
const st4 = (ev[pageUrl("710000004")] ?? []).map((e) => e.status).filter(Boolean);
out(st4.includes("Click Subscribe in Steam, then it downloads by itself…"), "…its status says to click Subscribe", st4.join(" | "));
const d4 = `${T}/ws3/431960/710000004`; fs.mkdirSync(d4, { recursive: true });
fs.copyFileSync(`${T}/clip.mp4`, `${d4}/v.mp4`); fs.writeFileSync(`${d4}/project.json`, JSON.stringify({ type: "video", file: "v.mp4", title: "ws-710000004" }));
r = await Promise.race([pd, sleep(20000).then(() => null)]);
out(r?.status === 200, "…and finishes once Steam has it", r ? String(r.status) : "timed out");
await post("/steam-todo/next"); // the Steam to-do's entry waits for the user's Next even after Steam delivered
// e. owner 2026-11-11 (a 369 MB duplicate): the WE folder setting names Steam's folder THROUGH A SYMLINK, the Steam client
// reports the real folder → still linked into the library (local/<id>), never copied (workshop/<id>)
fs.symlinkSync(`${T}/steamlib`, `${T}/wslink`);
const cur = await (await fetch(U + "/settings")).json();
await fetch(U + "/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...cur, workshopDownloadMode: "steamapp", workshopFolder: `${T}/wslink` }) });
r = await Promise.race([download("710000005"), sleep(20000).then(() => null)]);
body = r ? await r.json() : null;
const vp = body?.videoPath ?? "";
const linked = /\/library\/local\/710000005(\/|$)/.test(vp) && fs.lstatSync(vp.replace(/\/[^/]*$/, "")).isSymbolicLink();
out(r?.status === 200 && linked, "a Workshop folder setting through a symlink: the item is LINKED (local/), not copied", vp || (r ? String(r.status) : "timed out"));
// f. owner 2026-11-11 ("clicked the unsubscribe button but for some reason it took me to the steam page instead of handling it
// itself"): Delete from source under "Use the Steam app" → the Steam client unsubscribes; nothing opens in the Steam app
const unsub = []; ws.addEventListener("message", (m) => { const e = JSON.parse(m.data); if (e.type === "unsub-progress") unsub.push(e.payload); });
const item = async (id) => (await lib()).find((i) => i.workshopId === id);
const queue = async () => (await (await fetch(U + "/workshop/queue")).json()).pending;
const dropAndDrain = async (id) => {
  const it = await item(id); if (!it) return false;
  await fetch(U + "/workshop/delete-from-source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [it] }) });
  unsub.length = 0;
  await fetch(U + "/workshop/drain", { method: "POST" });
  for (let i = 0; i < 100 && !unsub.some((e) => e.finished); i++) await sleep(100);
  return true;
};
n0 = urls().length;
const had = fs.existsSync(`${T}/steamlib/sub-710000005`);
const ok5 = await dropAndDrain("710000005");
out(ok5 && had && !fs.existsSync(`${T}/steamlib/sub-710000005`) && urls().length === n0 && !(await queue()).includes("710000005"),
  "Delete from source under Use the Steam app: Steam unsubscribes it, nothing opens, the queue is empty",
  `was subscribed ${had}, still ${fs.existsSync(`${T}/steamlib/sub-710000005`)}, opened ${urls().length - n0}, finished ${JSON.stringify(unsub.at(-1) ?? null)}`);
// Steam unreachable → the old path for it: the item's page in the Steam app (no sign-in here)
fs.writeFileSync(`${T}/steamlib/fail-init`, "");
n0 = urls().length;
const ok1 = await dropAndDrain("710000001");
const opened = urls().slice(n0);
out(ok1 && opened.some((x) => x.includes("710000001")), "…Steam unreachable: the unsubscribe falls back to the item's page in the Steam app", opened.join(" ") || "nothing opened");
fs.rmSync(`${T}/steamlib/fail-init`);

// g. owner 2026-11-11 ("what if i unsubscribe + undo / does it resubscribe? it doesn't right?"): Undo after Steam already
// unsubscribed → subscribed again, the way the mode subscribes. 710000001 is the latest batch (its page route — Steam was
// unreachable), 710000005 the one before (the Steam client unsubscribed it).
const undo = async () => (await (await fetch(U + "/library/undo", { method: "POST" })).json());
// 710000001: Steam is reachable again → the Steam client subscribes it again. Its unsubscribe went through the PAGE route (the
// Steam to-do), so the fake never saw it: play the user's click on that page (drop the fake's subscription) + their Next in the
// to-do (only Next marks it unsubscribed) — else the check proves nothing
fs.rmSync(`${T}/steamlib/sub-710000001`, { force: true });
await post("/steam-todo/next");
await sleep(200);
const relBefore = released().length;
await undo();
for (let i = 0; i < 100 && !fs.existsSync(`${T}/steamlib/sub-710000001`); i++) await sleep(100);
// the re-subscribe's helper runs until Steam reports it installed — let it finish before Steam goes "unreachable" below
for (let i = 0; i < 100 && released().length < relBefore + 2; i++) await sleep(100);
out(fs.existsSync(`${T}/steamlib/sub-710000001`) && !(await queue()).includes("710000001") && !!(await item("710000001")),
  "Undo after Steam unsubscribed it: subscribed again through the Steam client, back in the library, off the queue",
  `subscribed ${fs.existsSync(`${T}/steamlib/sub-710000001`)}, in library ${!!(await item("710000001"))}`);
// 710000005 with Steam unreachable → its page opens for the user to click Subscribe, the status bar says so
fs.writeFileSync(`${T}/steamlib/fail-init`, "");
n0 = urls().length; unsub.length = 0;
await undo();
for (let i = 0; i < 100 && !urls().slice(n0).some((x) => x.includes("710000005")); i++) await sleep(100);
await sleep(300);
const msg = unsub.find((e) => e.message)?.message ?? "";
out(urls().slice(n0).join() === "steam://url/CommunityFilePage/710000005" && /click Subscribe/.test(msg) && !!(await item("710000005")),
  "…Steam unreachable: the item's page opens to subscribe again, the status bar says so", `${urls().slice(n0).join(" ") || "nothing opened"} | ${msg}`);
await post("/steam-todo/stop");
fs.rmSync(`${T}/steamlib/fail-init`);

// h. the Steam to-do (owner 2026-11-11, "Guided"): one page at a time, app-wide; the user's Next moves on — nothing is detected,
// and the page route never connects to the Steam client (no steam-ugc child) unless "Let the Steam app do all N" is clicked
const setMode = async (mode) => { const c = await (await fetch(U + "/settings")).json(); await post("/settings", { ...c, workshopDownloadMode: mode }); };
const helpersLog = () => fs.existsSync(`${T}/steamlib/helpers.log`) ? fs.readFileSync(`${T}/steamlib/helpers.log`, "utf8").split("\n").filter(Boolean) : [];
const lastTodo = () => todo.at(-1) ?? null;
const waitTodo = async (pred, ms = 5000) => { for (let i = 0; i < ms / 50 && !pred(lastTodo()); i++) await sleep(50); return lastTodo(); };
const waitUrl = async (id, from, ms = 5000) => { for (let i = 0; i < ms / 50; i++) { if (urls().slice(from).some((x) => x.includes(id))) return true; await sleep(50); } return false; };
const dropItem = (id) => { const d = `${T}/steamlib/${id}`; /* the WE folder setting is $T/wslink → steamlib since e. */ fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(`${T}/clip.mp4`, `${d}/v.mp4`); fs.writeFileSync(`${d}/project.json`, JSON.stringify({ type: "video", file: "v.mp4", title: `ws-${id}` })); };
const settle = (p, ms = 15000) => Promise.race([p.then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })), sleep(ms).then(() => null)]);
const statuses = (id) => (ev[pageUrl(id)] ?? []).map((e) => e.status).filter(Boolean);

await setMode("steampage");
let h0 = helpersLog().length;
n0 = urls().length; todo.length = 0;
const ids3 = ["720000001", "720000002", "720000003"];
// started one after another (each in the to-do before the next request): concurrent requests reach the to-do in any order
const dl3 = [];
for (const [k, id] of ids3.entries()) { dl3.push(download(id)); await waitTodo((x) => x?.total === k + 1); }
let t = await waitTodo((x) => x?.total === 3);
await sleep(800);
out(urls().slice(n0).join(" ") === "steam://url/CommunityFilePage/720000001",
  "bulk download of 3 (Open in the Steam app): only the FIRST page opens", urls().slice(n0).join(" ") || "nothing opened");
out(t?.action === "subscribe" && t.index === 1 && t.total === 3 && t.remaining === 3 && t.current?.id === "720000001" && t.current?.title === "ws-720000001",
  "…WS steam-todo: subscribe, 1 of 3, the first item's id + title", JSON.stringify(t));
out(statuses("720000002").at(-1)?.includes("Steam to-do") && statuses("720000003").at(-1)?.includes("Steam to-do") && /click Subscribe/i.test(statuses("720000001").at(-1) ?? ""),
  "…the queued ones say \"In the Steam to-do\", the current one \"click Subscribe\"", ids3.map((id) => statuses(id).at(-1)).join(" | "));
out(t?.autoNext === true, "…item 1 wasn't on disk when its page opened → autoNext", JSON.stringify(t));
dropItem("720000001"); // Steam delivers item 1 (the user clicked Subscribe)
const r1 = await settle(dl3[0]);
out(r1?.status === 200 && r1.body?.workshopId === "720000001", "…item 1 arrives in the Workshop folder → its download finishes", JSON.stringify(r1)?.slice(0, 120));
// owner 2026-11-11 ("make it auto detect then if its flawless"): files that weren't there when its page opened = Steam downloading
// it = subscribed → the to-do moves on by itself, no POST /steam-todo/next
const opened2 = await waitUrl("720000002", n0);
t = await waitTodo((x) => x?.current?.id === "720000002");
out(opened2 && urls().length === n0 + 2 && t?.index === 2 && t?.total === 3 && t?.remaining === 2,
  "Steam delivered item 1 after its page opened → the second page opens by itself (no Next), 2 of 3", `${urls().slice(n0).join(" ")} | ${JSON.stringify(t)}`);
const tSkip = Date.now();
await post("/steam-todo/skip");
const r2 = await settle(dl3[1], 5000);
const opened3 = await waitUrl("720000003", n0);
out(opened3 && urls().length === n0 + 3 && lastTodo()?.current?.id === "720000003" && lastTodo()?.index === 3, "Skip → the third page opens, 3 of 3", urls().slice(n0).join(" "));
out(r2?.status === 200 && r2.body?.skipped === true && Date.now() - tSkip < 3000 && !(await item("720000002")),
  "…the skipped item's /download ends at once as skipped (not after 10 min), nothing imported", `${JSON.stringify(r2)} in ${Date.now() - tSkip} ms`);
await post("/steam-todo/stop");
const r3 = await settle(dl3[2], 5000);
t = await waitTodo((x) => x?.finished);
await sleep(300);
out(r3?.body?.skipped === true && t?.finished === true && urls().length === n0 + 3, "Stop → the rest ends as skipped, the to-do finished, nothing more opens", `${JSON.stringify(r3)} | ${JSON.stringify(t)}`);
out(helpersLog().length === h0, "…the page route never started a Steam-client helper", `${helpersLog().length - h0} helper log lines`);

// Delete from source of 3 (Open in the Steam app): the two Steam has in its Workshop folder (720000001 dropped there, 710000001
// installed by the fake during g.) get their pages, one at a time; 710000004 has no folder in any Steam root now (it came from
// $T/ws3, no longer the WE folder setting since e. — like an owned steamcmd copy, never a subscription: owner 2026-11-11) →
// no page, blocked at once. Next = unsubscribed (blocked), Skip = kept subscribed (out of pending + blocked).
const delItems = [await item("720000001"), await item("710000004"), await item("710000001")].filter(Boolean);
h0 = helpersLog().length; n0 = urls().length; todo.length = 0; unsub.length = 0;
await post("/workshop/delete-from-source", { items: delItems });
await post("/workshop/drain");
await waitTodo((x) => x?.total >= 2);
await sleep(600);
out(delItems.length === 3 && urls().slice(n0).join(" ") === "steam://url/CommunityFilePage/720000001" && lastTodo()?.action === "unsubscribe" && lastTodo()?.total === 2,
  "bulk Delete from source of 3 (Open in the Steam app): ONE page — the first item's, never the subscriptions list; Unsubscribe 1 of 2", `${urls().slice(n0).join(" ")} | ${JSON.stringify(lastTodo())}`);
out(!(await queue()).includes("710000004") && !urls().slice(n0).some((x) => x.includes("710000004")),
  "…the one with no Steam folder (a steamcmd-style copy): no page, no entry, off pending");
out((await queue()).includes("720000001"), "…the current one's id stays pending until Next");
await post("/steam-todo/next");
out(await waitUrl("710000001", n0) && !(await queue()).includes("720000001") && lastTodo()?.index === 2,
  "Next → unsubscribed (off pending) + the second page opens, 2 of 2", urls().slice(n0).join(" "));
await post("/steam-todo/skip");
t = await waitTodo((x) => x?.finished);
out(t?.finished === true && !(await queue()).includes("710000001"), "Skip → kept subscribed: off pending (and blocked), the to-do finished");
out(helpersLog().length === h0, "…no Steam-client helper for the page route's unsubscribes either");

// "Let the Steam app do all N": the remaining entries go through the (fake) Steam client — the saved mode stays steampage.
// First with Steam unreachable: the panel says so and the to-do stays as it was.
n0 = urls().length; todo.length = 0;
const idsU = ["730000001", "730000002"];
const dlU = idsU.map((id) => download(id));
await waitTodo((x) => x?.total === 2);
fs.writeFileSync(`${T}/steamlib/fail-init`, "");
let ru = await (await post("/steam-todo/use-steam-app")).json();
t = await waitTodo((x) => !!x?.message && !x.busy);
out(!!ru.error && t?.total === 2 && t?.remaining === 2 && /couldn't be reached/.test(t?.message ?? ""),
  "Let the Steam app do all 2 — Steam unreachable: the panel says so, the to-do stays as it was", `${JSON.stringify(ru)} | ${JSON.stringify(t)}`);
fs.rmSync(`${T}/steamlib/fail-init`);
ru = await (await post("/steam-todo/use-steam-app")).json();
const ra = await Promise.all(dlU.map((p) => settle(p, 20000)));
out(!ru.error && ra.every((x, i) => x?.status === 200 && x.body?.workshopId === idsU[i]) && idsU.every((id) => fs.existsSync(`${T}/steamlib/sub-${id}`)),
  "…Steam reachable: both downloads finish through the Steam client (subscribed there)", JSON.stringify(ra.map((x) => x?.status)));
out(lastTodo()?.finished === true && urls().length === n0 + 1, "…the to-do finished, no further page opened", JSON.stringify(lastTodo()));
out(idsU.some((id) => statuses(id).includes("Waiting for the Steam app…")), "…one waited its turn: \"Waiting for the Steam app…\"",
  idsU.map((id) => statuses(id).join(" > ")).join(" || "));
out((await (await fetch(U + "/settings")).json()).workshopDownloadMode === "steampage", "…the saved mode is unchanged (steampage)");
// the same for unsubscribes: Delete from source → the to-do → "Let the Steam app do all 2" → the Steam client unsubscribes
todo.length = 0;
await post("/workshop/delete-from-source", { items: [await item("730000001"), await item("730000002")].filter(Boolean) });
await post("/workshop/drain");
await waitTodo((x) => x?.total === 2 && x.action === "unsubscribe");
await post("/steam-todo/use-steam-app");
for (let i = 0; i < 100 && idsU.some((id) => fs.existsSync(`${T}/steamlib/sub-${id}`) || false); i++) await sleep(100);
await sleep(300);
const qU = await queue();
out(idsU.every((id) => !fs.existsSync(`${T}/steamlib/sub-${id}`) && !qU.includes(id)) && lastTodo()?.finished === true,
  "…Delete from source of 2 → Let the Steam app do all 2: the Steam client unsubscribed both, the queue is empty", `pending [${qU}]`);

// "Use the Steam app" (steamapp) bulk: ONE helper child at a time, app-wide — no two subscribe/unsubscribe helpers connected at once
await setMode("steamapp");
const idsC = ["740000001", "740000002", "740000003"];
const rc = await Promise.all(idsC.map((id) => settle(download(id), 30000)));
out(rc.every((x) => x?.status === 200), "steamapp: 3 downloads at once all finish", JSON.stringify(rc.map((x) => x?.status)));
const spans = {}; const users = new Set();
for (const l of helpersLog()) { const [k, pid, ts] = l.split(" "); if (k === "use") users.add(pid); else (spans[pid] ??= {})[k] = +ts; }
const iv = [...users].map((p) => spans[p]).filter((x) => x?.open && x?.close).sort((a, b) => a.open - b.open);
const overlaps = iv.filter((x, i) => i > 0 && x.open < iv[i - 1].close).length;
out(iv.length >= 3 && overlaps === 0, "…no two Steam-client helpers ever ran at the same time (the fake's start/end log)", `${iv.length} helpers, ${overlaps} overlaps`);
out(idsC.filter((id) => statuses(id).includes("Waiting for the Steam app…")).length >= 2, "…the queued ones said \"Waiting for the Steam app…\"",
  idsC.map((id) => statuses(id).join(" > ")).join(" || "));

// i. the Browse sidebar (owner 2026-11-11: "open on steam doesn't open in real steam, and make it so browse > wallpaper engine
// (local) has option to unsubscribe / same for browse > workshop / … a button that lets you subscribe/unsubscribe in the sidebar")
const subEv = []; ws.addEventListener("message", (m) => { const e = JSON.parse(m.data); if (e.type === "subscribe-progress") subEv.push(e.payload); });
const state = async (ids) => (await post("/workshop/state", { ids })).json();
const undoDepth = async () => (await (await fetch(U + "/library/undo-depth")).json()).depth;
const unsubDone = async () => { for (let i = 0; i < 100 && !unsub.some((e) => e.finished); i++) await sleep(100); };
// Open on Steam → the Steam CLIENT (steam://), its own route; /open stays http(s)-only
n0 = urls().length;
const ro = await post("/steam/open-page", { workshopId: "760000001" });
const bo = await ro.json().catch(() => null);
await waitUrl("760000001", n0, 3000);
out(ro.status === 200 && bo?.ok === true && urls().slice(n0).join(" ") === "steam://url/CommunityFilePage/760000001",
  "Open on Steam: POST /steam/open-page opens steam://url/CommunityFilePage/<id> in the Steam app", `${ro.status} ${JSON.stringify(bo)} | ${urls().slice(n0).join(" ")}`);
n0 = urls().length;
const badIds = ["76x", "1;id", "", "https://example.com", "../1", "123456789012345678901234"];
const rb = await Promise.all(badIds.map((id) => post("/steam/open-page", { workshopId: id })));
const rb2 = await post("/open", { url: "steam://url/CommunityFilePage/760000001" });
await sleep(500);
out(rb.every((x) => x.status === 400) && rb2.status === 400 && urls().length === n0,
  "…a non-digit id → 400 and nothing opens; /open still refuses a steam:// URL", `${rb.map((x) => x.status)} /open ${rb2.status}, ${urls().length - n0} opened`);

// Subscribe without importing — steamapp: through the (fake) Steam client
await setMode("steamapp");
let libN = (await lib()).length;
let rs = await post("/workshop/subscribe", { workshopId: "760000002", title: "sub-only 2" });
let bs = await rs.json().catch(() => null);
out(rs.status === 200 && bs?.subscribed === true && fs.existsSync(`${T}/steamlib/sub-760000002`) && (await lib()).length === libN && !(await item("760000002")),
  "Subscribe (Use the Steam app): subscribed through the Steam client, nothing imported into /library", `${rs.status} ${JSON.stringify(bs)}`);
out(subEv.some((e) => e.id === "760000002" && e.done && !e.error), "…WS subscribe-progress ends done", JSON.stringify(subEv.filter((e) => e.id === "760000002").at(-1) ?? null));
let st = await state(["760000002", "799999999", "740000001"]);
out(st["760000002"]?.subscribed === true && st["760000002"].pending === null && st["760000002"].inLibrary === false,
  "/workshop/state: subscribed, not in the library", JSON.stringify(st["760000002"]));
out(st["799999999"]?.subscribed === false && st["799999999"].pending === null && st["799999999"].inLibrary === false,
  "/workshop/state: not subscribed (no folder in any Steam root)", JSON.stringify(st["799999999"]));
out(st["740000001"]?.subscribed === true && st["740000001"].inLibrary === true, "/workshop/state: subscribed + in the library", JSON.stringify(st["740000001"]));
const stBad = await state(["abc", "1;2"]);
out(Object.keys(stBad).length === 0, "/workshop/state ignores non-digit ids", JSON.stringify(stBad));

// Unsubscribe of an item NOT in the library (a WE-local folder): no trash, the Steam client unsubscribes it
let ud = await undoDepth();
unsub.length = 0;
ru = await post("/workshop/unsubscribe", { workshopId: "760000002", title: "sub-only 2" });
let bu = await ru.json().catch(() => null);
await unsubDone();
st = await state(["760000002"]);
out(ru.status === 200 && bu?.inLibrary === false && !fs.existsSync(`${T}/steamlib/sub-760000002`) && (await undoDepth()) === ud && (await lib()).length === libN,
  "Unsubscribe (not in the library): unsubscribed through the Steam client, nothing trashed, no undo batch", `${JSON.stringify(bu)}, sub ${fs.existsSync(`${T}/steamlib/sub-760000002`)}`);
out(st["760000002"]?.subscribed === false && st["760000002"].pending === null && st["760000002"].onDisk === true,
  "…state: not subscribed while its folder lingers (Steam deletes it later)", JSON.stringify(st["760000002"]));

// Unsubscribe of a library item = Delete from source: trashed + unsubscribed, undoable; Undo subscribes it again
ud = await undoDepth();
unsub.length = 0;
ru = await post("/workshop/unsubscribe", { workshopId: "740000001", title: "ws-740000001" });
bu = await ru.json().catch(() => null);
await unsubDone();
out(bu?.inLibrary === true && !!bu.batch && !(await item("740000001")) && !fs.existsSync(`${T}/steamlib/sub-740000001`) && (await undoDepth()) === ud + 1,
  "Unsubscribe (in the library): trashed like Delete from source + unsubscribed through the Steam client, one undo batch", `${JSON.stringify(bu)}, sub ${fs.existsSync(`${T}/steamlib/sub-740000001`)}`);
await post("/library/undo");
for (let i = 0; i < 100 && !fs.existsSync(`${T}/steamlib/sub-740000001`); i++) await sleep(100);
out(!!(await item("740000001")) && fs.existsSync(`${T}/steamlib/sub-740000001`) && !(await queue()).includes("740000001"),
  "…Undo: back in the library and subscribed again through the Steam client", `in library ${!!(await item("740000001"))}, sub ${fs.existsSync(`${T}/steamlib/sub-740000001`)}`);
await sleep(1500); // the re-subscribe's helper lets go before the mode changes

// "Open in the Steam app" (steampage): the toggle goes through the Steam to-do — never the Steam client
await setMode("steampage");
h0 = helpersLog().length; todo.length = 0;
n0 = urls().length;
ru = await post("/workshop/unsubscribe", { workshopId: "740000002", title: "ws-740000002" });
t = await waitTodo((x) => x?.current?.id === "740000002");
st = await state(["740000002"]);
out(t?.action === "unsubscribe" && urls().slice(n0).includes("steam://url/CommunityFilePage/740000002") && st["740000002"]?.pending === "unsubscribe",
  "Unsubscribe (Open in the Steam app): a Steam to-do unsubscribe entry, its page opened, state pending unsubscribe", `${JSON.stringify(t)} | ${JSON.stringify(st["740000002"])}`);
await post("/steam-todo/next");
t = await waitTodo((x) => x?.finished);
st = await state(["740000002"]);
out(t?.finished === true && !(await queue()).includes("740000002") && st["740000002"]?.subscribed === false && st["740000002"].pending === null,
  "…Next → unsubscribed (off pending), state not subscribed", JSON.stringify(st["740000002"]));

// Subscribe (Open in the Steam app): a to-do subscribe entry without a download; Next finishes it, nothing imported
libN = (await lib()).length; n0 = urls().length; todo.length = 0;
rs = await post("/workshop/subscribe", { workshopId: "760000003", title: "sub-only 3" });
bs = await rs.json().catch(() => null);
t = await waitTodo((x) => x?.current?.id === "760000003");
await waitUrl("760000003", n0); // the stub xdg-open runs detached (setsid) — its line lands a moment later
st = await state(["760000003"]);
out(rs.status === 200 && bs?.inSteamTodo === true && bs.subscribed === false && t?.action === "subscribe" && t?.autoNext === true
  && urls().slice(n0).join(" ") === "steam://url/CommunityFilePage/760000003" && st["760000003"]?.pending === "subscribe",
  "Subscribe (Open in the Steam app): a Steam to-do subscribe entry (no download), its page opened, state pending subscribe", `${JSON.stringify(bs)} | ${JSON.stringify(t)}`);
await post("/steam-todo/next");
t = await waitTodo((x) => x?.finished);
for (let i = 0; i < 40 && !subEv.some((e) => e.id === "760000003" && e.done); i++) await sleep(50);
st = await state(["760000003"]);
out(t?.finished === true && subEv.some((e) => e.id === "760000003" && e.done && !e.skipped) && st["760000003"]?.subscribed === true
  && (await lib()).length === libN && helpersLog().length === h0,
  "…Next finishes it: subscribed, nothing imported, no Steam-client helper", JSON.stringify(st["760000003"]));

// owner 2026-11-11 ("make it auto detect then if its flawless"): a subscribe-only entry moves on by itself when its folder appears
todo.length = 0; n0 = urls().length;
await post("/workshop/subscribe", { workshopId: "760000004", title: "sub-only 4" });
t = await waitTodo((x) => x?.current?.id === "760000004");
const absentFirst = t?.autoNext === true;
await sleep(400);
fs.mkdirSync(`${T}/steamlib/760000004`, { recursive: true }); // Steam starts downloading it
t = await waitTodo((x) => x?.finished, 5000);
out(absentFirst && t?.finished === true, "Subscribe-only: its Steam folder appears after its page opened → the to-do moves on by itself (no Next)", JSON.stringify(t));
// …and one whose folder was there before its turn (a lingering folder) does NOT: it waits for Next even after Steam delivers
const pre = `${T}/steamlib/760000005`; fs.mkdirSync(pre, { recursive: true });
fs.writeFileSync(`${pre}/project.json`, JSON.stringify({ type: "video", file: "v.mp4", title: "ws-760000005" })); // no media yet
todo.length = 0;
const d5 = download("760000005");
t = await waitTodo((x) => x?.current?.id === "760000005");
const autoFlag = t?.autoNext;
fs.copyFileSync(`${T}/clip.mp4`, `${pre}/v.mp4`);
const r5 = await settle(d5);
await sleep(1500);
t = lastTodo();
out(autoFlag === false && r5?.status === 200 && t?.current?.id === "760000005" && t?.delivered === true,
  "…a download whose folder existed before its turn: delivered, but the to-do waits for Next (no proof)", `${JSON.stringify(r5)?.slice(0, 80)} | ${JSON.stringify(t)}`);
await post("/steam-todo/next");
t = await waitTodo((x) => x?.finished);
out(t?.finished === true, "…Next moves on");
ws.close();
