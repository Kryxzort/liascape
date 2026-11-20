#!/usr/bin/env bash
# Hermetic test of the shell's dev-server detection (app/shell/vite-detect.js, used by app/shell/main.js viteUp): only
# Liascape's own Vite (app/ui/vite.config.ts, marker header on /__liascape/token) puts the shell in dev mode. Cases:
#   foreign: a plain node server answering 200 on every path        → not Liascape's (the app starts its own backend)
#   foreign-403: one answering 403 on /__liascape/token, no marker   → not Liascape's
#   nothing listening                                               → not Liascape's
#   liascape: app/ui's real Vite config served by Vite's own API      → Liascape's (dev mode)
#   main.js: viteUp asks vite-detect.js, never a bare GET of the server
# Every server binds a free 127.0.0.1 port of its own (never :5173, the owner's Vite); Vite's cache and XDG_CONFIG_HOME
# go to a temp folder under /dev/shm, removed on exit.
# Usage: bash scripts/test-vite-detect.sh   Needs: node, app/ui/node_modules (npm ci). Last line `RESULT pass=N fail=M`.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"
. "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
[ -d "$ROOT/app/ui/node_modules/vite" ] || { echo "missing app/ui/node_modules (cd app/ui && npm ci)"; exit 2; }
T=$(mktemp -d /dev/shm/liascape-vitedetect-XXXXXX)
trap 'rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /dev/shm/liascape-vitedetect- "$rc"' EXIT INT TERM HUP
mkdir -p "$T/config/liascape"

cd "$ROOT/app/ui" && XDG_CONFIG_HOME="$T/config" LP_ROOT="$ROOT" LP_T="$T" timeout 120 node --input-type=module - <<'EOF'
import http from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const root = process.env.LP_ROOT, T = process.env.LP_T;
const { liascapeViteUp } = createRequire(import.meta.url)(`${root}/app/shell/vite-detect.js`);
const ask = (base) => new Promise((r) => liascapeViteUp(base, r, 5000));
let pass = 0, fail = 0;
const check = (name, ok, why = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${why ? ` — ${why}` : ""}`); };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const freePort = async () => { const s = http.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; };

// a foreign server answering 200 on every path (what another project's dev server does for `/`)
const foreign = http.createServer((_q, s) => { s.setHeader("Content-Type", "text/html"); s.end("<!doctype html>other app"); });
const fp = await listen(foreign);
const root200 = await new Promise((r) => http.get(`http://127.0.0.1:${fp}/`, (s) => { s.resume(); r(s.statusCode); }).on("error", () => r(0)));
if (root200 !== 200) check("foreign", false, `the foreign server didn't answer 200 on / (${root200}): proved nothing`);
else check("foreign", (await ask(`http://127.0.0.1:${fp}`)) === false, "a foreign server counted as Liascape's Vite");
foreign.close();

const f403 = http.createServer((_q, s) => { s.statusCode = 403; s.end(); });
const fp2 = await listen(f403);
check("foreign-403", (await ask(`http://127.0.0.1:${fp2}`)) === false, "a 403 without the marker counted");
f403.close();

const free = await freePort(); // nothing listens on it now
check("nothing listening", (await ask(`http://127.0.0.1:${free}`)) === false);

// Liascape's own dev server: app/ui's vite.config.ts through Vite's API (cache under the temp folder, no dep scan)
const { createServer } = await import("vite");
const vp = await freePort();
const vite = await createServer({ root: `${root}/app/ui`, configFile: `${root}/app/ui/vite.config.ts`, cacheDir: `${T}/vite-cache`,
  logLevel: "error", optimizeDeps: { noDiscovery: true, include: [] }, server: { host: "127.0.0.1", port: vp, strictPort: true, hmr: false, watch: null } });
await vite.listen();
check("liascape", (await ask(`http://127.0.0.1:${vp}`)) === true, "Liascape's own Vite wasn't recognised");
await vite.close();

// main.js decides dev mode through vite-detect.js (and LIASCAPE_VITE), not a bare GET of the server
const main = readFileSync(`${root}/app/shell/main.js`, "utf8");
const body = main.match(/function viteUp\(cb\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
check("main.js", /liascapeViteUp\(VITE, cb\)/.test(body) && !/http\.get\(/.test(body), "viteUp doesn't ask vite-detect.js");

console.log(`RESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
EOF
