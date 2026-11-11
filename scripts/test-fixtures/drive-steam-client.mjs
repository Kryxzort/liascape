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
const ws = new WebSocket(U.replace("http", "ws") + "/events?token=" + encodeURIComponent(TOKEN));
ws.onmessage = (m) => { const e = JSON.parse(m.data); if (e.type === "download-progress") (ev[e.payload.id] ??= []).push(e.payload); };
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
ws.close();
