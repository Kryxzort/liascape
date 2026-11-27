// The page side of scripts/test-card-pictures.sh: a page of Browse cards asking the backend's media origin for their
// pictures over 6 connections (Chromium's HTTP/1.1 limit per origin; more wait in line for one), as Card.tsx asks:
// each card's still (/still?w=640) first, its gif (/anim) once the still is in. `--old`: as the card asked before (every
// gif at once, then the stills), for the report's numbers only.
// Usage: node drive-card-pictures.mjs <media base URL> <token> <cdn base URL> <first card> <cards> [--abort-after ms] [--old]
// Prints one JSON object: {ms, screenMs, ok, failed, stills, anims, queueMed, workMed, aborted, abortedAt (epoch ms)}.
import http from "node:http";

const [base, token, cdn, firstArg, nArg, ...rest] = process.argv.slice(2);
const first = Number(firstArg), n = Number(nArg);
const abortAfter = rest.includes("--abort-after") ? Number(rest[rest.indexOf("--abort-after") + 1]) : 0;
const old = rest.includes("--old");
const SCREEN = Math.min(n, 12); // the cards on screen: the first two rows of a 1080p window's grid
const agent = new http.Agent({ keepAlive: true, maxSockets: 6 });
const ctl = new AbortController();
const t0 = Date.now();
const done = [];
let open = 0;

function get(kind, card) {
  const gif = `${cdn}/ugc/${card}/${card % 2 ? "lead" : "plain"}.gif`;
  const q = kind === "still" ? `/still?u=${encodeURIComponent(gif)}&w=640` : `/anim?u=${encodeURIComponent(gif)}`;
  const r = { kind, card, asked: Date.now() - t0 };
  open++;
  return new Promise((resolve) => {
    const req = http.get(`${base}${q}&token=${encodeURIComponent(token)}`, { agent, signal: ctl.signal }, (res) => {
      r.headers = Date.now() - t0;
      let bytes = 0, head = null;
      res.on("data", (b) => { if (!head) head = b.subarray(0, 4); bytes += b.length; });
      res.on("end", () => {
        r.end = Date.now() - t0;
        r.status = res.statusCode;
        r.bytes = bytes;
        // a still is a JPEG, a gif a GIF
        r.ok = res.statusCode === 200 && !!head && (kind === "still" ? head[0] === 0xff && head[1] === 0xd8 : head.toString("latin1", 0, 3) === "GIF");
        fin();
      });
      res.on("error", () => { r.err = "body"; fin(); });
    });
    req.on("socket", () => { r.socket = Date.now() - t0; });
    req.on("error", (e) => { r.err = e.name === "AbortError" ? "aborted" : e.message; r.end = Date.now() - t0; fin(); });
    function fin() { if (r.fin) return; r.fin = true; open--; done.push(r); resolve(r); }
  });
}

const cards = Array.from({ length: n }, (_, i) => first + i);
const all = [];
if (old) {
  for (const c of cards) all.push(get("anim", c));
  for (const c of cards) all.push(get("still", c));
} else {
  for (const c of cards) all.push(get("still", c).then((r) => (r.err === "aborted" ? r : get("anim", c))));
}
let abortedAt = null;
if (abortAfter) setTimeout(() => { abortedAt = Date.now(); ctl.abort(); }, abortAfter);
await Promise.all(all);
while (open > 0) await new Promise((r) => setTimeout(r, 10));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const good = done.filter((r) => r.ok);
const stillOf = (c) => done.find((r) => r.kind === "still" && r.card === c);
const screen = cards.slice(0, SCREEN).map((c) => stillOf(c));
console.log(JSON.stringify({
  ms: Math.max(...done.map((r) => r.end ?? 0)),
  screenMs: screen.every((r) => r?.ok) ? Math.max(...screen.map((r) => r.end)) : null,
  ok: good.length,
  failed: done.filter((r) => !r.ok && r.err !== "aborted").map((r) => `${r.kind} ${r.card}: ${r.status ?? r.err}`),
  stills: good.filter((r) => r.kind === "still").length,
  anims: good.filter((r) => r.kind === "anim").length,
  aborted: done.filter((r) => r.err === "aborted").length,
  abortedAt,
  queueMed: med(good.map((r) => r.socket - r.asked)),
  workMed: med(good.map((r) => r.headers - r.socket)),
}));
agent.destroy();
