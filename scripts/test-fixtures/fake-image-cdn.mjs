// A stand-in for Steam's image CDN (images.steamusercontent.com) on loopback, for scripts/test-card-pictures.sh: every
// GET /ugc/<n>/<name>.gif answers <dir>/<name>.gif after `latencyMs`, its bytes paced through ONE shared link of
// `bytesPerSec` (every response's chunks queue for it in turn, as downloads share a home connection). Each request is a
// JSON line on stdout: {ev: "start" | "end" | "abort", path, bytes, ms}. GET /stats → {gets: {path: n}, bytes: total sent}.
// Usage: node fake-image-cdn.mjs <port file> <dir> <bytesPerSec> <latencyMs>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [portFile, dir, bpsArg, latArg] = process.argv.slice(2);
const BPS = Number(bpsArg), LAT = Number(latArg), CHUNK = 16384;
const gets = {};
let sent = 0, linkFree = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the shared link: a chunk leaves when the link is free, and holds it for its own length
async function take(n) {
  const now = Date.now(), at = Math.max(now, linkFree);
  linkFree = at + (n / BPS) * 1000;
  if (at > now) await sleep(at - now);
}
const log = (o) => process.stdout.write(JSON.stringify({ t: Date.now(), ...o }) + "\n");

http.createServer(async (req, res) => {
  const p = req.url.split("?")[0];
  if (p === "/stats") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ gets, bytes: sent })); return; }
  const m = /^\/ugc\/\d+\/([a-z]+)\.gif$/.exec(p);
  const file = m && path.join(dir, `${m[1]}.gif`);
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  gets[p] = (gets[p] ?? 0) + 1;
  const t0 = Date.now();
  let bytes = 0, gone = false;
  req.on("close", () => { if (!res.writableFinished) gone = true; });
  log({ ev: "start", path: p });
  await sleep(LAT);
  const data = fs.readFileSync(file);
  if (gone) { log({ ev: "abort", path: p, bytes, ms: Date.now() - t0 }); return; }
  res.writeHead(200, { "Content-Type": "image/gif", "Content-Length": data.length });
  for (let i = 0; i < data.length && !gone; i += CHUNK) {
    const part = data.subarray(i, i + CHUNK);
    await take(part.length);
    if (gone) break;
    res.write(part);
    bytes += part.length; sent += part.length;
  }
  if (gone) { log({ ev: "abort", path: p, bytes, ms: Date.now() - t0 }); res.destroy(); return; }
  res.end();
  log({ ev: "end", path: p, bytes, ms: Date.now() - t0 });
}).listen(0, "127.0.0.1", function () { fs.writeFileSync(portFile, String(this.address().port)); });
