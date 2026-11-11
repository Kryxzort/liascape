#!/usr/bin/env bash
# Hermetic test of the Steam paths that need no Steam account (owner 2026-11-11: "is it a dead end for users without
# mobile guard?" → a password sign-in + Workshop downloads through the Steam app when there's no usable sign-in):
#  1. `liascape-backend steam-selftest` — the password sign-in's plumbing with a scripted sign-in in place of SteamKit2
#     (email / authenticator / approve-in-the-app steps, a wrong code, cancel, replace, timeout, wrong password, Steam's
#     rate limit + the hold after it, what's saved, the password nowhere in the events / console / settings.json) and the
#     no-sign-in unsubscribe (one item → its page, several → the subscriptions list, an item Steam doesn't have → nothing).
#  2. A private backend whose PATH puts a stub `xdg-open` first (it only records the URL — the real Steam client is never
#     started) and whose Workshop folder is a temp dir: POST /download of a Workshop item (no network: the result carries
#     `trailerKnown`) with no sign-in, then with a sign-in Steam turned down → the item's page is "opened in Steam"
#     (steam://url/CommunityFilePage/<id>), `download-progress` says why + "click Subscribe", the test then drops the item
#     into the Workshop folder (like Steam would) and the download finishes into the library; an item already on disk →
#     nothing opens; a download cancelled from the page stops waiting and imports nothing.
#  3. "Subscribe through the Steam client" (Helpers/SteamClientUgc.cs) against a FAKE steamclient.so
#     (scripts/test-fixtures/fake_steamclient.c, built here; driver drive-steam-client.mjs): a real percent between 0 and 1,
#     "Steam is downloading it…", imported from the folder Steam reported, nothing opened in the Steam app, the helper
#     released Steam + exited; Steam refusing → the old path (the item's page in the Steam app); a cancel → the helper
#     releases Steam + exits, nothing imported.
# Never signs in to Steam, never subscribes anything, never talks to steamcommunity.com, never touches ~/.config/liascape
# (temp HOME + every XDG dir), never prints settings.json. Everything it started is stopped on exit.
#
# Usage: scripts/test-steam-signin.sh [--no-build]     Needs: dotnet (or DOTNET=…), node (≥ 22: WebSocket), ffmpeg, curl, jq.
# Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
for t in node ffmpeg curl jq timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
DLL=$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll
if [ $BUILD = 1 ]; then
  "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
  [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
fi
[ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }

T=$(mktemp -d /tmp/liascape-steam-XXXXXX)
mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
DLL=$T/backend/liascape-backend.dll
BP=""; BP3=""
stopbe() { [ -n "$1" ] && { kill "$1" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$1" 2>/dev/null || break; sleep 0.1; done; kill -9 "$1" 2>/dev/null; }; }
cleanup() {
  trap - EXIT INT TERM HUP
  stopbe "$BP"; stopbe "$BP3"
  case "$T" in /tmp/liascape-steam-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
unset LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT LIASCAPE_PLAYER_SOCKET
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
privhome() {   # $1 = dir: a fresh private HOME + XDG dirs
  mkdir -p "$1/.config/liascape" "$1/.cache" "$1/.local/share" "$1/rt" "$1/st"
  export HOME=$1 XDG_CONFIG_HOME=$1/.config XDG_CACHE_HOME=$1/.cache XDG_DATA_HOME=$1/.local/share XDG_RUNTIME_DIR=$1/rt XDG_STATE_HOME=$1/st
}

echo "== 1. steam-selftest (scripted sign-in, stub xdg-open)"
privhome "$T/h1"
(cd /tmp && timeout 120 "$DOTNET" "$DLL" steam-selftest) > "$T/selftest.log" 2>&1; rc=$?
grep -E "^(ok|FAIL)" "$T/selftest.log" | sed 's/^/      /'
[ $rc = 0 ] && grep -q "STEAM-SELFTEST PASS" "$T/selftest.log" && ok "steam-selftest" || { bad "steam-selftest (rc $rc)"; tail -5 "$T/selftest.log"; }

echo "== 2. Workshop download through the Steam app (private backend, stub xdg-open)"
privhome "$T/h2"
mkdir -p "$T/bin" "$T/ws/431960"
cat > "$T/bin/xdg-open" <<EOF
#!/bin/sh
printf '%s\n' "\$1" >> "$T/xdg-open.urls"
EOF
chmod +x "$T/bin/xdg-open"
export PATH=$T/bin:$PATH
[ "$(command -v xdg-open)" = "$T/bin/xdg-open" ] || { bad "the stub xdg-open isn't first on PATH"; exit 1; }
cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"PlayerEngine":"legacy","WorkshopDownloadMode":"subscribe","WorkshopFolder":"$T/ws/431960","AutoAddWeWallpapersToLibrary":false,"NoAudio":true}
EOF
ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=320x180:rate=30" -t 1 -c:v libx264 -pix_fmt yuv420p "$T/clip.mp4"
(cd /tmp && LIASCAPE_WORKSHOP_POLL_MS=300 exec "$DOTNET" "$DLL" serve > "$T/backend.log" 2>&1) & BP=$!
for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { wait $BP; echo "backend rc=$?"; BP=""; bad "backend didn't start"; tail -15 "$T/backend.log"; exit 1; }
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
cat > "$T/drive.mjs" <<'EOF'
// drives the private backend: POST /download of fake Workshop items, watches WS download-progress, plays Steam's part
// (drops the item into the Workshop folder once its page was "opened")
import fs from "node:fs";
const [U, T] = [process.env.U, process.env.T];
// the backend's API token (serve.token beside serve.port; web-backend.md § Local API security) on every request + the WS
const TOKEN = fs.readFileSync(`${process.env.XDG_CONFIG_HOME}/liascape/serve.token`, "utf8").trim();
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o = {}) => realFetch(u, { ...o, headers: { ...(o.headers || {}), "X-Liascape-Token": TOKEN } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (ok, name, extra = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
const urls = () => (fs.existsSync(`${T}/xdg-open.urls`) ? fs.readFileSync(`${T}/xdg-open.urls`, "utf8").trim().split("\n").filter(Boolean) : []);
const status = {}; // workshop id → the statuses seen
const ws = new WebSocket(U.replace("http", "ws") + "/events?token=" + encodeURIComponent(TOKEN));
ws.onmessage = (m) => { const e = JSON.parse(m.data); if (e.type === "download-progress" && e.payload.status) (status[e.payload.id] ??= []).push(e.payload.status); };
await new Promise((r) => { ws.onopen = r; });
const sources = await (await fetch(U + "/sources")).json();
const src = sources.find((s) => s.supportsTagFilter)?.index ?? sources.findIndex((s) => s.supportsTagFilter);
if (src == null || src < 0) { out(false, "a Workshop source in /sources"); process.exit(1); }
const pageUrl = (id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
const result = (id) => ({ title: `ws-${id}`, thumbnailUrl: "", pageUrl: pageUrl(id), workshopId: id, isScene: false, trailerKnown: true });
const drop = (id) => { const d = `${T}/ws/431960/${id}`; fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(`${T}/clip.mp4`, `${d}/v.mp4`); fs.writeFileSync(`${d}/project.json`, JSON.stringify({ type: "video", file: "v.mp4", title: `ws-${id}` })); };
const download = (id, signal) => fetch(U + "/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: src, result: result(id), apply: false }), signal });
const lib = async () => (await (await fetch(U + "/library")).json());
const inLib = async (id) => (await lib()).some((i) => i.workshopId === id);

async function viaSteam(id, why, label) {
  const n0 = urls().length;
  const p = download(id);
  let u = null;
  for (let i = 0; i < 100 && !u; i++) { await sleep(100); u = urls().slice(n0).find((x) => x.includes(id)) ?? null; }
  out(u === `steam://url/CommunityFilePage/${id}`, `${label}: the item's page opens in the Steam app`, u ?? "nothing opened");
  await sleep(300);
  const st = (status[pageUrl(id)] ?? []).join(" | ");
  out(st.includes(why) && st.includes("click Subscribe"), `${label}: download-progress says why + "click Subscribe"`, st);
  // Steam's staging folder (<workshop>/downloads/431960/<id>; this test's content root is $T/ws/431960 → <workshop> = $T): the
  // card's "Steam is downloading…" phase, then "Steam is finishing…" once the files are in but not yet steady
  const stage = `${T}/downloads/431960/${id}`; fs.mkdirSync(stage, { recursive: true });
  await sleep(900);
  drop(id); fs.rmSync(stage, { recursive: true });
  const r = await Promise.race([p, sleep(20000).then(() => null)]);
  const phases = (status[pageUrl(id)] ?? []);
  const iD = phases.indexOf("Steam is downloading it…"), iF = phases.indexOf("Steam is finishing…");
  out(iD >= 0 && iF > iD, `${label}: the phases "Steam is downloading it…" then "Steam is finishing…"`, phases.join(" | "));
  const body = r ? await r.json() : null;
  out(r?.status === 200 && body?.workshopId === id, `${label}: once Steam has it, the download finishes into the library`, r ? `${r.status} ${JSON.stringify(body).slice(0, 160)}` : "timed out");
  out(await inLib(id), `${label}: /library has it`);
}

await viaSteam("700000001", "Not signed in", "no sign-in");
// a sign-in Steam turned down (the flag the cookie mint sets): no request to Steam, straight to the app — written the way
// SettingsService writes (temp + rename), the settings themselves never printed
const sf = `${process.env.XDG_CONFIG_HOME}/liascape/settings.json`;
const s = JSON.parse(fs.readFileSync(sf, "utf8"));
const fakeJwt = "e30." + Buffer.from(JSON.stringify({ sub: "76561190000000001", exp: Math.floor(Date.now() / 1000) + 9e6 })).toString("base64url") + ".c2ln";
Object.assign(s, { SteamRefreshToken: fakeJwt, SteamId: 76561190000000001, SteamAccountName: "fake", SteamSignInRejected: true });
fs.writeFileSync(sf + ".t", JSON.stringify(s)); fs.renameSync(sf + ".t", sf);
const st = await (await fetch(U + "/steam/status")).json();
out(st.signedIn && st.rejected, "/steam/status: signedIn + rejected");
await viaSteam("700000002", "Steam signed this app out", "sign-in rejected");

// already on disk, no usable sign-in: nothing to click
drop("700000003");
let n0 = urls().length;
let r = await download("700000003");
out(r.status === 200 && urls().length === n0, "already on disk: imported, nothing opened in Steam", `${r.status}, ${urls().length - n0} opened`);

// cancelled from the page (the UI's Cancel aborts the request): the wait stops, a later download of it by Steam imports nothing
n0 = urls().length;
const ac = new AbortController();
const p = download("700000004", ac.signal).catch(() => "aborted");
for (let i = 0; i < 50 && urls().length === n0; i++) await sleep(100);
ac.abort(); await p; await sleep(800);
drop("700000004"); await sleep(1500);
out(urls().length === n0 + 1 && !(await inLib("700000004")), "cancelled: its page had opened, nothing imported after Steam delivers");

// owner 2026-11-11 (a download "Downloading…" forever): Steam's own Workshop folder a SYMLINK to another library's — the
// standard ~/.local/share/Steam root and the WE folder setting name one folder, both polled; one shared "last size" slot
// alternated between the two paths and never matched twice. Now: per path.
const std = `${process.env.HOME}/.local/share/Steam/steamapps/workshop/content`;
fs.mkdirSync(std, { recursive: true }); fs.symlinkSync(`${T}/ws/431960`, `${std}/431960`);
await viaSteam("700000005", "Steam signed this app out", "Workshop folder reached through a symlink");
ws.close();
EOF
(cd "$T" && U=$U T=$T XDG_CONFIG_HOME=$XDG_CONFIG_HOME timeout 120 node drive.mjs) > "$T/drive.log" 2>&1; rc=$?
cat "$T/drive.log" | sed 's/^/      /'
p=$(grep -c '^PASS' "$T/drive.log"); f=$(grep -c '^FAIL' "$T/drive.log")
PASS=$((PASS + p)); FAIL=$((FAIL + f))
[ $rc = 0 ] || bad "drive.mjs exited $rc"
grep -q "steamcommunity.com/sharedfiles/subscribe\|finalizelogin" "$T/backend.log" && bad "the backend log mentions a subscribe / finalizelogin request"
echo "== backend log (workshop lines)"; grep -E "workshop:|steam:|error:" "$T/backend.log" | sed 's/^/      /' | tail -12

echo "== 3. Workshop download through the Steam client (a FAKE steamclient.so — no Steam)"
stopbe "$BP"; BP=""
CC=${CC:-$(command -v cc || command -v gcc || true)}
if [ -z "$CC" ]; then bad "no C compiler for the fake steamclient.so"; else
"$CC" -shared -fPIC -O1 -o "$T/steamclient.so" "$ROOT/scripts/test-fixtures/fake_steamclient.c" || bad "the fake steamclient.so didn't build"
privhome "$T/h3"
mkdir -p "$T/ws3/431960" "$T/steamlib"
: > "$T/xdg-open.urls"
printf '{"PlayerEngine":"legacy","WorkshopDownloadMode":"subscribe","WorkshopFolder":"%s","AutoAddWeWallpapersToLibrary":false,"NoAudio":true,"WorkshopViaSteamClient":true}\n' \
  "$T/ws3/431960" > "$XDG_CONFIG_HOME/liascape/settings.json"
(cd /tmp && LIASCAPE_WORKSHOP_POLL_MS=300 LIASCAPE_STEAM_CLIENT_LIB=$T/steamclient.so FAKE_UGC_DIR=$T/steamlib FAKE_UGC_CLIP=$T/clip.mp4 \
  exec "$DOTNET" "$DLL" serve > "$T/backend3.log" 2>&1) & BP3=$!
for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP3 2>/dev/null || break; sleep 0.1; done
U3=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port" 2>/dev/null)
for _ in $(seq 1 50); do curl -sf -m 2 "$U3/health" >/dev/null && break; sleep 0.1; done
cp "$ROOT/scripts/test-fixtures/drive-steam-client.mjs" "$T/drive3.mjs"
(cd "$T" && U=$U3 T=$T XDG_CONFIG_HOME=$XDG_CONFIG_HOME timeout 120 node drive3.mjs) > "$T/drive3.log" 2>&1; rc=$?
sed 's/^/      /' "$T/drive3.log"
p=$(grep -c '^PASS' "$T/drive3.log"); f=$(grep -c '^FAIL' "$T/drive3.log")
PASS=$((PASS + p)); FAIL=$((FAIL + f))
[ $rc = 0 ] || bad "drive3.mjs exited $rc"
echo "== backend 3 log (workshop lines)"; grep -E "workshop:|error:" "$T/backend3.log" | sed 's/^/      /' | tail -8
fi
echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
