#!/usr/bin/env bash
# Hermetic test of the Steam paths that need no Steam account (a password sign-in beside the QR; Workshop downloads through
# the sign-in, the Steam app's page or the Steam client, each the user's pick, and each failing with its reason, never
# switching to another):
#  1. `liascape-backend steam-selftest` — the password sign-in's plumbing with a scripted sign-in in place of SteamKit2
#     (email / authenticator / approve-in-the-app steps, a wrong code, cancel, replace, timeout, wrong password, Steam's
#     rate limit + the hold after it, what's saved, the password nowhere in the events / console / settings.json); who may
#     unsubscribe per mode and sign-in; signed out an unsubscribe in its Undo window (a sign-out, Steam turning the sign-in
#     down) or due is dropped like its Undo (the item back, still subscribed, no page, no to-do); and "Open in the Steam app"'s
#     unsubscribe through the Steam to-do (Web/SteamTodo.cs: one page at a time — never the subscriptions list —, pending
#     until Next → blocked, Open again, Skip / Stop → kept subscribed, an item Steam doesn't have → no page, a second drain
#     leaves the to-do's ids alone, WS steam-todo).
#  2. A private backend whose PATH puts a stub `xdg-open` first (it only records the URL — the real Steam client is never
#     started) and whose Workshop folder is a temp dir: POST /download of a Workshop item (no network: the result carries
#     `trailerKnown`) under "Subscribe with Steam login" with no sign-in, then with a sign-in Steam turned down → refused up
#     front, 400 "Sign in to Steam to download" (merged: "… to subscribe"), nothing opened in Steam, nothing in the to-do or
#     the library (POST /workshop/subscribe: "Sign in to Steam to subscribe"), an item already on disk too ("Open in the Steam
#     app" imports it, nothing opened). No mode borrows another's way (WorkshopDownloader.Blocked): the page mode's one-off is
#     refused even signed in. Under "Open in the Steam app" the item's page is
#     "opened in Steam" (steam://url/CommunityFilePage/<id>), `download-progress` says "click Subscribe", the test then drops
#     the item into the Workshop folder (like Steam would) and the download finishes into the library; a download cancelled
#     from the page stops waiting and imports nothing. "Download without subscribing" (one-off: GET /workshop/one-off, POST
#     /download {oneOff}) takes each mode's own way: its route per mode × sign-in; signed out under "Subscribe with
#     Steam login" → none, the download refused (400 "Sign in to Steam…"), nothing sent; signed in (a pasted cookie, the sign-in's subscribe / unsubscribe answered by a fake
#     community, scripts/test-fixtures/fake-steam-community.mjs) → subscribe, the test drops Steam's files, the library's own
#     copy, unsubscribed at once (no unsub-progress for the UI), the lingering folder blocked; an item already subscribed is copied, its subscription untouched. Without a usable sign-in the unsubscribe endpoints refuse (400
#     + "Sign in to Steam to unsubscribe") under "Subscribe with Steam login": nothing queued, trashed or opened. A stored
#     "steamcmd" mode (dropped) reads as "subscribe". Presets (Web/PresetDownloads.cs; real Workshop ids from
#     scripts/test-fixtures/presets/, Steam's details from a CM fixture): a preset's download brings its base scene by the same
#     mode and action — the page mode opens only the preset's page and imports the base once Steam delivers it (a base that
#     never comes: given up, "Needs its base scene"); signed in the base is subscribed after the preset, a one-off's base is a
#     one-off too; a download & apply waits for the base, then applies (or says why not); a base in the library is reused;
#     a web base is never asked for; a Subscribe of a preset subscribes its base; unsubscribing the preset leaves the base alone.
#  3. "Subscribe through the Steam client" (Helpers/SteamClientUgc.cs) against a FAKE steamclient.so
#     (scripts/test-fixtures/fake_steamclient.c, built here; driver drive-steam-client.mjs): a real percent between 0 and 1,
#     "Steam is downloading it…", imported from the folder Steam reported, nothing opened in the Steam app, the helper
#     released Steam + exited; Steam refusing → the download fails with the reason; a cancel → the helper
#     releases Steam + exits, nothing imported. Then the Steam to-do (h.): a bulk download of 3 under "Open in the Steam app"
#     opens only the first page, a delivered item 1 doesn't advance it, Next opens page 2, Skip page 3 and ends item 2's
#     /download as skipped at once, Stop the rest; a bulk Delete from source (one page at a time, no page for an item with no
#     Steam folder, Next / Skip); "Let the Steam app do all 2" with Steam unreachable (unchanged + the message) and reachable
#     (downloads and unsubscribes through the fake client, the saved mode unchanged); the page route never starts a
#     `steam-ugc` child (the fake's helpers.log); 3 steamapp downloads at once never run two helpers at the same time. A
#     subscribe entry whose files weren't on disk when its page opened finishes by itself once Steam delivers (no Next); one
#     whose folder was already there waits for Next. Then (i.) the Browse sidebar: POST /steam/open-page → steam://url/
#     CommunityFilePage/<id> (a non-digit id → 400, nothing opened), /workshop/state, Subscribe without importing (the Steam
#     client; the to-do), Unsubscribe of a library item (trash + unsubscribe + Undo re-subscribes; an Undo while the drain
#     waits for the Steam client never reaches Steam, one while the client unsubscribes it is too late, says so and changes
#     nothing: the fake's hold-install / hold-unsub pin each side of that race) and of a non-library one,
#     and Unsubscribe without deleting (POST /workshop/unsubscribe-keep: the local/<id> link becomes the library's own copy at
#     the same path, Steam's folder untouched, nothing trashed; a copy that fails unsubscribes nothing; GET /library's
#     `subscribed` true before, false after). Then (j.) "Download without subscribing" through the client: DownloadItem, no
#     subscription, the library's own copy, the lingering folder blocked; a client that refuses DownloadItem → subscribe, copy,
#     unsubscribe through the client; an item already subscribed stays so; Steam unreachable → the reason. Then (k.) presets
#     through the client (the fake installs $FAKE_UGC_DIR/template-<id>/): the preset then its base subscribed, a one-off's
#     both DownloadItem'd, a Subscribe of a preset subscribes its base, a Delete from source of the preset keeps the base; under
#     "Open in the Steam app" a preset's download or Subscribe handed to "Let the Steam app do all 1" brings its base through
#     the client too (no page for it).
#  Where the sign-in's secrets live (Helpers/SecretStore.cs; never plaintext in settings.json): § 1 also
#     checks settings.json never holds a token, the 0600 steam-auth.json fallback (no session bus here), sign-out, and the
#     keyring path against a STUB secret-tool (the value on stdin, never argv; a refused lookup → signed out, not asked
#     again); § 2 a token in the running backend's store is read, never shown.
#  4. The selftest again against a PRIVATE Secret Service: dbus-run-session + gnome-keyring-daemon in the test's HOME /
#     XDG_RUNTIME_DIR (skipped when either is missing). The session's bus and keyring are never reached (DBUS_SESSION_BUS_ADDRESS
#     is a dead path everywhere else).
# Never signs in to Steam, never subscribes anything, never talks to steamcommunity.com, never touches ~/.config/liascape
# (temp HOME + every XDG dir), never prints settings.json. Everything it started is stopped on exit.
#
# Usage: scripts/test-steam-signin.sh [--no-build]     Needs: dotnet (or DOTNET=…), node (≥ 22: WebSocket), ffmpeg, curl, jq.
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs / screenshots and prints where (last line).
#   FAKE_UGC_OPEN_DELAY_MS=<ms>: every § 3 Steam-client helper takes that long to connect — a loaded or freshly booted machine,
#   where starting one takes seconds, made repeatable (§ 3 waits on events, never on a time; 5500 outlasts the Undo window).
# Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/test-lock.sh" # one heavy test run at a time on this machine
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
. "$ROOT/scripts/test-no-network.sh"   # lp_real_network: a call to a real server fails the run
BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
for t in node ffmpeg curl jq timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
# LIASCAPE_SS_DLL: another backend build to test (e.g. an older commit's, for a RED run of new checks; with --no-build)
DLL=${LIASCAPE_SS_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
if [ $BUILD = 1 ]; then
  "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
  [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
fi
[ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }

T=$(mktemp -d /tmp/liascape-steam-XXXXXX)
mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
DLL=$T/backend/liascape-backend.dll
BP=""; BP3=""; FP=""
stopbe() { [ -n "$1" ] && { kill "$1" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$1" 2>/dev/null || break; sleep 0.1; done; kill -9 "$1" 2>/dev/null; }; }
cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  stopbe "$BP"; stopbe "$BP3"; stopbe "$FP"
  lp_tmp_done "$T" /tmp/liascape-steam- "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
unset LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT LIASCAPE_PLAYER_SOCKET
unset LIASCAPE_SECRETS LIASCAPE_SECRET_TOOL LIASCAPE_TEST_EXPECT_SECRETS
# the Steam secrets (Helpers/SecretStore.cs) must never reach the session's keyring: a dead bus → the file fallback here;
# § 4 starts its own private Secret Service
export DBUS_SESSION_BUS_ADDRESS=unix:path=$T/no-bus
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
# the player: a stub that never plays (a download & apply here reaches the apply, which can't play a scene)
printf '#!/bin/sh\nexit 1\n' > "$T/bin/liascape-player"; chmod +x "$T/bin/liascape-player"; export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player
cat > "$XDG_CONFIG_HOME/liascape/settings.json" <<EOF
{"WorkshopDownloadMode":"subscribe","WorkshopFolder":"$T/ws/431960","AutoAddWeWallpapersToLibrary":false,"NoAudio":true}
EOF
ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=320x180:rate=30" -t 1 -c:v libx264 -pix_fmt yuv420p "$T/clip.mp4"
# Steam's item details for every backend here (LIASCAPE_STEAM_CM_FIXTURE: no CM session, no network): the presets and their
# bases (Web/PresetDownloads.cs asks for a preset's base and its kind). Real Workshop ids for the fixtures' pairs
# (scripts/test-fixtures/presets/); 910000101, 910000103, 910000104 and 910000105 are made up, each a fixture with its base id
# rewritten (a base that never arrives, comes through the Steam to-do or is waited for by a download & apply, a web base). An id not listed = no such public item.
cat > "$T/cm.json" <<'EOF'
{"3583880694": {"tags": ["Preset", "Scene"], "title": "Preset fixture 4", "children": ["3354740764"]},
 "3520333138": {"tags": ["Preset", "Scene"], "title": "Preset fixture 3", "children": ["3354740764"]},
 "3420428971": {"tags": ["Preset", "Scene"], "title": "Preset fixture 2", "children": ["3419466417"]},
 "3009121253": {"tags": ["Preset", "Scene"], "title": "Preset fixture 1", "children": ["2932157836"]},
 "3354740764": {"tags": ["Scene"], "title": "Base scene A"},
 "3419466417": {"tags": ["Scene"], "title": "Base scene B"},
 "2932157836": {"tags": ["Scene"], "title": "Base scene C"},
 "910000101": {"tags": ["Preset", "Scene"], "title": "Preset, base never arrives", "children": ["900000001"]},
 "900000001": {"tags": ["Scene"], "title": "Base scene D"},
 "910000103": {"tags": ["Preset", "Web"], "title": "Preset of a web wallpaper", "children": ["900000005"]},
 "900000005": {"tags": ["Web"], "title": "A web wallpaper"},
 "910000104": {"tags": ["Preset", "Scene"], "title": "Preset, subscribed through the to-do", "children": ["900000006"]},
 "900000006": {"tags": ["Scene"], "title": "Base scene E"},
 "910000105": {"tags": ["Preset", "Scene"], "title": "Preset, download & apply", "children": ["900000007"]},
 "900000007": {"tags": ["Scene"], "title": "Base scene F"}}
EOF
# "Download without subscribing" signed in (§ 2, one-off): the sign-in's subscribe / unsubscribe go to a fake community
# (scripts/test-fixtures/fake-steam-community.mjs, LIASCAPE_STEAM_COMMUNITY); a made-up account and cookie token
FAKE_ME=76561190000000042; FAKE_TOKEN=probe-cookie-token-not-real
node "$ROOT/scripts/test-fixtures/fake-steam-community.mjs" "$T/fake.port" "$FAKE_ME" "$FAKE_TOKEN" > "$T/fake.log" 2>&1 & FP=$!
for _ in $(seq 1 50); do [ -s "$T/fake.port" ] && break; sleep 0.1; done
[ -s "$T/fake.port" ] || { bad "the fake community server didn't start"; cat "$T/fake.log"; exit 1; }
FAKE=http://127.0.0.1:$(cat "$T/fake.port")
# LIASCAPE_WORKSHOP_WAIT_MS: a preset's base that never arrives is given up after 10 s, not 10 min
(cd /tmp && LIASCAPE_TEST_NO_NETWORK=1 LIASCAPE_WORKSHOP_POLL_MS=300 LIASCAPE_WORKSHOP_WAIT_MS=10000 LIASCAPE_STEAM_CM_FIXTURE=$T/cm.json LIASCAPE_STEAM_COMMUNITY=$FAKE exec "$DOTNET" "$DLL" serve > "$T/backend.log" 2>&1) & BP=$!
for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { wait $BP; echo "backend rc=$?"; BP=""; bad "backend didn't start"; tail -15 "$T/backend.log"; exit 1; }
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
cat > "$T/drive.mjs" <<'EOF'
// drives the private backend: POST /download of fake Workshop items, watches WS download-progress, plays Steam's part
// (drops the item into the Workshop folder once its page was "opened")
import fs from "node:fs";
const [U, T] = [process.env.U, process.env.T];
// the backend's API token (serve.token beside serve.port; .claude/rules/backend/api.md § Security) on every request + the WS
const TOKEN = fs.readFileSync(`${process.env.XDG_CONFIG_HOME}/liascape/serve.token`, "utf8").trim();
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o = {}) => realFetch(u, { ...o, headers: { ...(o.headers || {}), "X-Liascape-Token": TOKEN } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (ok, name, extra = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
const urls = () => (fs.existsSync(`${T}/xdg-open.urls`) ? fs.readFileSync(`${T}/xdg-open.urls`, "utf8").trim().split("\n").filter(Boolean) : []);
const status = {}; // workshop id → the statuses seen
const ws = new WebSocket(U.replace("http", "ws") + "/events?token=" + encodeURIComponent(TOKEN));
const todo = []; // WS steam-todo payloads
const unsubEv = []; // WS unsub-progress payloads (the held message at its end)
const dlErr = {}; // workshop page URL → the download-progress error it ended with
ws.onmessage = (m) => { const e = JSON.parse(m.data); if (e.type === "download-progress" && e.payload.status) (status[e.payload.id] ??= []).push(e.payload.status);
  if (e.type === "download-progress" && e.payload.error) dlErr[e.payload.id] = e.payload.error;
  if (e.type === "steam-todo") todo.push(e.payload);
  if (e.type === "unsub-progress") unsubEv.push(e.payload); };
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

const setMode = async (mode) => { await fetch(U + "/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workshopDownloadMode: mode }) }); };
// "Subscribe with Steam login" without a usable sign-in: the download (and a plain Subscribe) is refused up front, 400 with the
// one rule's words (WorkshopDownloader.Blocked) — never the item's page in the Steam app (that's "Open in the Steam app"'s
// job), nothing sent, queued or imported
async function noSignIn(id, label) {
  const n0 = urls().length, t0 = todo.length;
  const r = await Promise.race([download(id), sleep(15000).then(() => null)]);
  const body = r ? await r.json().catch(() => null) : null;
  await sleep(500);
  out(r && r.status === 400 && body?.error === "Sign in to Steam to download",
    `${label}: the download is refused, 400 "Sign in to Steam to download"`, r ? `${r.status} ${JSON.stringify(body).slice(0, 200)}` : "timed out (waiting on a page?)");
  out(urls().length === n0 && !todo.slice(t0).some((x) => x.current?.id === id) && !(await inLib(id)),
    `${label}: nothing opened in Steam, nothing in the to-do, nothing imported`, `${urls().length - n0} opened, to-do ${JSON.stringify(todo.slice(t0).at(-1) ?? null)}`);
  const rs = await fetch(U + "/workshop/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workshopId: id, title: `ws-${id}` }) });
  const bs = await rs.json().catch(() => null);
  await sleep(300);
  out(rs.status === 400 && bs?.error === "Sign in to Steam to subscribe" && urls().length === n0,
    `${label}: Subscribe (the sidebar's) is refused, 400 "Sign in to Steam to subscribe", nothing opened`, `${rs.status} ${JSON.stringify(bs).slice(0, 160)}`);
}

// "Open in the Steam app": the item's page in the Steam app, through the to-do
async function viaSteam(id, label) {
  const n0 = urls().length;
  const p = download(id);
  let u = null;
  for (let i = 0; i < 100 && !u; i++) { await sleep(100); u = urls().slice(n0).find((x) => x.includes(id)) ?? null; }
  out(u === `steam://url/CommunityFilePage/${id}`, `${label}: the item's page opens in the Steam app`, u ?? "nothing opened");
  await sleep(300);
  const st = (status[pageUrl(id)] ?? []).join(" | ");
  out(st.includes("Click Subscribe in Steam"), `${label}: download-progress says "Click Subscribe in Steam"`, st);
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
  // the Steam to-do (Web/SteamTodo.cs): a queue of 1 whose files weren't there when its page opened — Steam delivering them is
  // the proof it's subscribed → it finishes by itself, no Next
  for (let i = 0; i < 40 && !todo.at(-1)?.finished; i++) await sleep(50);
  const mine = todo.filter((x) => x.current?.id === id);
  out(mine.length > 0 && mine.every((x) => x.index === 1 && x.total === 1 && x.autoNext === true) && todo.at(-1)?.finished === true,
    `${label}: the Steam to-do (1 of 1, autoNext) finished by itself once Steam delivered — no Next`, JSON.stringify(mine.at(-1) ?? null));
}

await noSignIn("700000001", "no sign-in");
// a sign-in Steam turned down (the flag the cookie mint sets): no request to Steam, straight to the app. The token sits in the
// secret store's file fallback (no Secret Service here: steam-auth.json, 0600), the flag in settings.json (never printed)
const sf = `${process.env.XDG_CONFIG_HOME}/liascape/settings.json`;
const af = `${process.env.XDG_CONFIG_HOME}/liascape/steam-auth.json`;
const fakeJwt = "e30." + Buffer.from(JSON.stringify({ sub: "76561190000000001", exp: Math.floor(Date.now() / 1000) + 9e6 })).toString("base64url") + ".c2ln";
fs.writeFileSync(af, JSON.stringify({ "steam-refresh-token": fakeJwt }), { mode: 0o600 });
const s = JSON.parse(fs.readFileSync(sf, "utf8"));
Object.assign(s, { SteamId: 76561190000000001, SteamAccountName: "fake", SteamSignInRejected: true });
fs.writeFileSync(sf + ".t", JSON.stringify(s)); fs.renameSync(sf + ".t", sf);
const st = await (await fetch(U + "/steam/status")).json();
out(st.signedIn && st.rejected, "/steam/status: signedIn + rejected");
out(!fs.readFileSync(sf, "utf8").includes(fakeJwt), "settings.json never holds the token");
const gs = await (await fetch(U + "/settings")).text();
out(!gs.includes(fakeJwt), "GET /settings carries no token");
const bl = fs.readFileSync(`${T}/backend.log`, "utf8");
out(bl.includes("secrets: file fallback") && !bl.includes(fakeJwt), "backend log: says which store, never the token");
await noSignIn("700000002", "sign-in rejected");
// merged (auto-import on + "subscribe": the Download button says Subscribe): the same refusal in the button's words
await fetch(U + "/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoAddWeWallpapersToLibrary: true }) });
{
  const rMerged = await download("700000001"), bMerged = await rMerged.json().catch(() => null);
  out(rMerged.status === 400 && bMerged?.error === "Sign in to Steam to subscribe", "merged (auto-import on), signed out: the download is refused in the Subscribe button's words",
    `${rMerged.status} ${JSON.stringify(bMerged).slice(0, 160)}`);
}
await fetch(U + "/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoAddWeWallpapersToLibrary: false }) });

// already on disk: refused up front all the same under "Subscribe with Steam login" signed out (one rule, every action);
// "Open in the Steam app" imports it from disk, nothing opened
drop("700000003");
let n0 = urls().length;
let r = await download("700000003");
out(r.status === 400 && !(await inLib("700000003")), "already on disk, signed out (Subscribe with Steam login): refused, nothing imported", String(r.status));
await setMode("steampage");
r = await download("700000003");
out(r.status === 200 && urls().length === n0, "already on disk (Open in the Steam app): imported, nothing opened in Steam",
  `${r.status}, ${urls().length - n0} opened`);
await setMode("subscribe");
// a stored "steamcmd" (the dropped mode) reads as the default
await setMode("steamcmd");
{
  const m = (await (await fetch(U + "/settings")).json()).workshopDownloadMode;
  out(m === "subscribe", "a \"steamcmd\" download mode (dropped) saves and reads as \"subscribe\"", String(m));
}
await setMode("subscribe");

// unsubscribe refused: without a usable sign-in (here one Steam turned down) the sign-in's mode stays disconnected from Steam
// — every unsubscribe endpoint answers 400 with the reason before anything is trashed, copied or queued, and nothing opens in
// Steam (WorkshopDownloader.Blocked; the CLI / API can't get round the UI's disabled Unsubscribe)
for (const [mode, why] of [["subscribe", "Sign in to Steam to unsubscribe"]]) {
  await setMode(mode);
  const it = (await lib()).find((i) => i.workshopId === "700000003");
  const post = (p, b) => fetch(U + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  n0 = urls().length;
  const got = [];
  for (const [p, b] of [["/workshop/unsubscribe", { workshopId: "700000003", title: "ws" }], ["/workshop/unsubscribe-keep", { workshopId: "700000003", title: "ws" }],
    ["/workshop/delete-from-source", { items: [it] }]]) {
    const rr = await post(p, b); got.push(`${p} ${rr.status} ${(await rr.json().catch(() => ({}))).error ?? ""}`);
  }
  await sleep(300);
  const q = await (await fetch(U + "/workshop/queue")).json();
  out(!!it && got.every((g) => g.endsWith(` 400 ${why}`)) && q.pending.length === 0 && urls().length === n0 && (await inLib("700000003")),
    `unsubscribe refused (${mode}, sign-in rejected): each endpoint 400 "${why}", nothing queued, trashed or opened`, `${got.join(" | ")} | pending [${q.pending}]`);
}

// "Download without subscribing" (POST /download {oneOff}; WorkshopDownloader.OneOffRouteFor / AcquireOneOffAsync): each
// download mode's own way (GET /workshop/one-off, asked before the menu opens) — "Subscribe with Steam login" signed in:
// subscribe → Steam's copy → the library's own copy → unsubscribe (no Undo window); signed out: none, "Sign in to Steam…";
// "Open in the Steam app": none ("A Steam page can only subscribe"); "Use the Steam app": the client's own (§ 3 j.).
// Never a page in Steam or the to-do; the copy is the library's own workshop/<id> folder; an item already subscribed stays so
{
  const json = { "Content-Type": "application/json" };
  const setS = (patch) => fetch(U + "/settings", { method: "POST", headers: json, body: JSON.stringify(patch) });
  const route = async () => { const r = await fetch(U + "/workshop/one-off"); return r.ok ? r.json() : { status: r.status }; };
  const oneOff = (id) => fetch(U + "/download", { method: "POST", headers: json, body: JSON.stringify({ source: src, result: result(id), apply: false, oneOff: true }) });
  const fakeLog = async () => (await realFetch(process.env.FAKE + "/__log")).json();
  const subCalls = async (id) => (await fakeLog()).filter((e) => /^\/sharedfiles\/(un)?subscribe$/.test(e.path) && e.form.id === id).map((e) => `${e.path.slice(13)}${e.signedIn && e.sessionPair ? "" : "(no sign-in)"}`);
  const SIGN_IN = "Sign in to Steam to download without subscribing";
  const uf = `${process.env.XDG_CONFIG_HOME}/liascape/workshop_unsub.json`;
  const unsubState = () => { try { return JSON.parse(fs.readFileSync(uf, "utf8")); } catch { return { Pending: [], Blocked: [] }; } };
  const libDir = (id) => `${process.env.XDG_DATA_HOME}/liascape/library/workshop/${id}`;
  const ownCopy = (b, id) => fs.existsSync(libDir(id)) && !fs.lstatSync(libDir(id)).isSymbolicLink() && (b?.videoPath ?? "").startsWith(libDir(id) + "/");
  const wsState = async (id) => (await (await fetch(U + "/workshop/state", { method: "POST", headers: json, body: JSON.stringify({ ids: [id] }) })).json())[id];
  // the route per mode (here a sign-in Steam turned down: not usable)
  const routes = {};
  for (const mode of ["steampage", "subscribe", "steamapp"]) {
    await setS({ workshopDownloadMode: mode });
    routes[mode] = await route();
  }
  const R = (k) => JSON.stringify(routes[k]);
  out(routes.steampage.route === null && routes.steampage.missing === "A Steam page can only subscribe",
    "one-off route, Open in the Steam app: none, \"A Steam page can only subscribe\" (never another mode's way)", R("steampage"));
  out(routes.subscribe.route === null && routes.subscribe.missing === SIGN_IN,
    "one-off route, Subscribe with Steam login, no usable sign-in: none, \"Sign in to Steam to download without subscribing\"", R("subscribe"));
  out(routes.steamapp.route === "steamapp" && routes.steamapp.missing == null, "one-off route, Use the Steam app: the Steam client's own", R("steamapp"));
  // no usable sign-in under "Subscribe with Steam login": the download fails with the reason, nothing sent, opened or imported
  await setS({ workshopDownloadMode: "subscribe" });
  const n1 = urls().length;
  let r1 = await oneOff("700000007"), b1 = await r1.json().catch(() => null);
  out(r1.status === 400 && (b1?.error ?? "") === SIGN_IN && urls().length === n1 && !(await inLib("700000007")) && (await subCalls("700000007")).length === 0,
    "one-off signed out (Subscribe with Steam login): refused, 400 + the reason — nothing sent to Steam, opened or imported", `${r1.status} ${JSON.stringify(b1).slice(0, 200)}`);
  // "Subscribe with Steam login" signed in (a pasted cookie in the file secret store): subscribe → Steam delivers (this test
  // drops its files into the Workshop folder) → the library's own copy, even though the folder is under the Workshop folder
  // setting → unsubscribe at once (no 5 s Undo window); the lingering folder blocked, never called subscribed
  const authBefore = fs.readFileSync(af, "utf8");
  fs.writeFileSync(af, JSON.stringify({ "steam-login-secure": `${process.env.FAKE_ME}||${process.env.FAKE_TOKEN}` }), { mode: 0o600 });
  await setS({ workshopDownloadMode: "subscribe" });
  const rs = await route();
  out(rs.route === "subscribe" && rs.missing == null, "one-off route, Subscribe with Steam login, signed in: the sign-in's own", JSON.stringify(rs));
  // "Open in the Steam app"'s one-off refused even with a usable sign-in (never another mode's way)
  {
    await setS({ workshopDownloadMode: "steampage" });
    const rp = await oneOff("700000013"), bp = await rp.json().catch(() => null);
    out(rp.status === 400 && bp?.error === "A Steam page can only subscribe" && !(await inLib("700000013")),
      "one-off under Open in the Steam app, signed in: refused, 400 \"A Steam page can only subscribe\"", `${rp.status} ${JSON.stringify(bp)}`);
    await setS({ workshopDownloadMode: "subscribe" });
  }
  const n2 = urls().length, t2 = todo.length;
  const p9 = oneOff("700000009");
  unsubEv.length = 0;
  let subscribed9 = false;
  for (let i = 0; i < 100 && !subscribed9; i++) { await sleep(100); subscribed9 = (await subCalls("700000009")).includes("subscribe"); }
  const queued9 = !(unsubState().Pending ?? []).includes("700000009") && (unsubState().Blocked ?? []).includes("700000009");
  drop("700000009");
  const t9 = Date.now();
  const r9 = await Promise.race([p9, sleep(20000).then(() => null)]);
  const b9 = r9 ? await r9.json().catch(() => null) : null;
  let calls9 = [];
  for (let i = 0; i < 60; i++) { calls9 = await subCalls("700000009"); if (calls9.includes("unsubscribe")) break; await sleep(100); }
  const tUnsub9 = Date.now() - t9;
  await sleep(300);
  out(r9?.status === 200 && b9?.workshopId === "700000009" && ownCopy(b9, "700000009"),
    "one-off signed in (Subscribe with Steam login): the library's own workshop/<id> copy, not a link into Steam's folder", r9 ? `${r9.status} ${b9?.videoPath ?? JSON.stringify(b9)}` : "timed out");
  out(subscribed9 && queued9 && calls9.join(" ") === "subscribe unsubscribe" && tUnsub9 < 4500,
    "…subscribed with the sign-in, kept out of auto-import meanwhile, unsubscribed once copied (no 5 s Undo window)", `${calls9.join(" ")} after ${tUnsub9} ms, blocked while fetching ${queued9} | ${fs.readFileSync(`${T}/backend.log`, "utf8").split("\n").filter((l) => /700000009|unsubscribe|drain/.test(l)).slice(-6).join(" / ")}`);
  // its unsubscribe is part of the download: the UI is sent no progress for it (only the finish, which shows nothing)
  for (let i = 0; i < 50 && !unsubEv.some((e) => e.finished); i++) await sleep(100);
  out(unsubEv.some((e) => e.finished) && !unsubEv.some((e) => !e.finished),
    "…its unsubscribe sends no unsub-progress (nothing for the top bar's \"Unsubscribing\" count), only the finishing event", JSON.stringify(unsubEv));
  const st9 = await wsState("700000009"), q9 = unsubState();
  out((q9.Blocked ?? []).includes("700000009") && !(q9.Pending ?? []).includes("700000009") && st9?.subscribed === false && st9.onDisk === true,
    "…Steam's lingering folder blocked from auto-import, not called subscribed, nothing left queued", JSON.stringify({ q9, st9 }));
  out(urls().length === n2 && !todo.slice(t2).some((x) => x.current?.id === "700000009"), "…nothing opened in Steam, nothing in the Steam to-do", `${urls().length - n2} opened`);
  // an item already subscribed (its folder in the Workshop folder, nothing queued): copied, never subscribed or unsubscribed
  drop("700000010");
  const r10 = await oneOff("700000010"), b10 = await r10.json().catch(() => null);
  await sleep(500);
  out(r10.status === 200 && ownCopy(b10, "700000010") && (await subCalls("700000010")).length === 0 && !(unsubState().Blocked ?? []).includes("700000010")
    && (await wsState("700000010"))?.subscribed === true,
    "one-off of a subscribed item (Subscribe with Steam login): its own copy, the subscription untouched", `${r10.status} ${JSON.stringify(b10).slice(0, 160)} | ${(await subCalls("700000010")).join(" ")}`);
  fs.writeFileSync(af, authBefore, { mode: 0o600 });
}

// "Open in the Steam app": the page, then Steam's files finish the download
await setMode("steampage");
await viaSteam("700000006", "Open in the Steam app");

// cancelled from the page (the UI's Cancel aborts the request): the wait stops, a later download of it by Steam imports nothing
n0 = urls().length;
const ac = new AbortController();
const p = download("700000004", ac.signal).catch(() => "aborted");
for (let i = 0; i < 50 && urls().length === n0; i++) await sleep(100);
ac.abort(); await p; await sleep(800);
drop("700000004"); await sleep(1500);
out(urls().length === n0 + 1 && !(await inLib("700000004")), "cancelled: its page had opened, nothing imported after Steam delivers");

// a download must not hang on "Downloading…": Steam's own Workshop folder a SYMLINK to another library's — the
// standard ~/.local/share/Steam root and the WE folder setting name one folder, both polled; one shared "last size" slot
// would alternate between the two paths and never match twice. So: per path.
const std = `${process.env.HOME}/.local/share/Steam/steamapps/workshop/content`;
fs.mkdirSync(std, { recursive: true }); fs.symlinkSync(`${T}/ws/431960`, `${std}/431960`);
await viaSteam("700000005", "Workshop folder reached through a symlink");

// A preset brings its base scene (Web/PresetDownloads.cs), by the preset's own mode and action, never another route: "Open in
// the Steam app" opens only the preset's page (Steam's required-items prompt fetches the base) and waits for the base with no
// page; the sign-in subscribes the base after the preset; a one-off gets a one-off base; a base in the library is reused; a
// base that isn't a scene is never asked for. The test plays Steam's part: it drops each folder into the Workshop folder.
{
  const json = { "Content-Type": "application/json" };
  const setS = (patch) => fetch(U + "/settings", { method: "POST", headers: json, body: JSON.stringify(patch) });
  const FIX = `${process.env.ROOT}/scripts/test-fixtures/presets`;
  const wsDir = (id) => `${T}/ws/431960/${id}`;
  // a preset as Steam delivers it: one of scripts/test-fixtures/presets/ (its own id, or `fixture` with the base id rewritten to `dep`)
  const dropPreset = (id, fixture = id, dep = null) => {
    const stage = `${T}/stage-${id}`; fs.cpSync(`${FIX}/${fixture}`, stage, { recursive: true });
    if (dep) { const pj = JSON.parse(fs.readFileSync(`${stage}/project.json`, "utf8")); pj.dependency = dep; fs.writeFileSync(`${stage}/project.json`, JSON.stringify(pj)); }
    fs.renameSync(stage, wsDir(id));
  };
  const dropBase = (id) => { const stage = `${T}/stage-${id}`; fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(`${stage}/project.json`, JSON.stringify({ type: "scene", title: `base-${id}`, file: "scene.json" }));
    fs.writeFileSync(`${stage}/scene.pkg`, Buffer.alloc(16)); fs.renameSync(stage, wsDir(id)); };
  const presetResult = (id) => ({ ...result(id), isScene: true, isPreset: true });
  const dl = (id, oneOff = false, apply = false) => fetch(U + "/download", { method: "POST", headers: json, body: JSON.stringify({ source: src, result: presetResult(id), apply, oneOff }) });
  const item = async (id) => (await lib()).find((i) => i.workshopId === id);
  const until = async (pred, ms) => { for (let i = 0; i < ms / 100; i++) { if (await pred()) return true; await sleep(100); } return !!(await pred()); };
  const settle = (p, ms = 30000) => Promise.race([p.then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })), sleep(ms).then(() => null)]);
  const fakeLog = async () => (await realFetch(process.env.FAKE + "/__log")).json();
  const subCalls = async (id) => (await fakeLog()).filter((e) => /^\/sharedfiles\/(un)?subscribe$/.test(e.path) && e.form.id === id).map((e) => e.path.slice(13));
  const order = async () => (await fakeLog()).filter((e) => /^\/sharedfiles\/(un)?subscribe$/.test(e.path)).map((e) => `${e.path.slice(13)} ${e.form.id}`);
  const beLog = () => fs.readFileSync(`${T}/backend.log`, "utf8");
  const PLAYS = null; // a preset's presetReason once its base scene is here: it plays
  const libDir = (src, id) => `${process.env.XDG_DATA_HOME}/liascape/library/${src}/${id}`;
  const own = (id) => fs.existsSync(libDir("workshop", id)) && !fs.lstatSync(libDir("workshop", id)).isSymbolicLink();

  // "Open in the Steam app": the preset's page only; the base arrives by Steam's prompt (the test drops it) → both imported
  await setS({ workshopDownloadMode: "steampage" });
  let n0 = urls().length;
  const pA = settle(dl("3583880694"));
  await until(() => urls().slice(n0).includes("steam://url/CommunityFilePage/3583880694"), 10000);
  dropPreset("3583880694");
  const rA = await pA;
  const waitingA = await until(() => (status[pageUrl("3354740764")] ?? []).includes("Waiting for Steam to download its base scene…"), 10000);
  dropBase("3354740764");
  await until(async () => (await item("3354740764")) && (await item("3583880694"))?.presetReason === PLAYS, 15000);
  const pa = await item("3583880694"), ba = await item("3354740764");
  out(rA?.status === 200 && pa?.isPreset === true && !!ba && pa.presetReason === PLAYS,
    "preset (Open in the Steam app): the preset, then its base scene once Steam delivers it — both in the library, the preset no longer needs its base",
    `${rA?.status} | preset ${JSON.stringify(pa && { r: pa.presetReason, b: pa.baseWorkshopId })} base ${!!ba}`);
  out(waitingA && urls().slice(n0).join(" ") === "steam://url/CommunityFilePage/3583880694",
    "…only the preset's page opened (Steam's required-items prompt brings the base); the base waited with no page", `${waitingA} | ${urls().slice(n0).join(" ")}`);
  // a base that never arrives: given up after LIASCAPE_WORKSHOP_WAIT_MS, the preset "Needs its base scene", no page for it
  n0 = urls().length;
  const pB = settle(dl("910000101"));
  await until(() => urls().slice(n0).includes("steam://url/CommunityFilePage/910000101"), 10000);
  dropPreset("910000101", "3009121253", "900000001");
  const rB = await pB;
  const gaveUp = await until(() => !!dlErr[pageUrl("900000001")], 30000);
  const pb = await item("910000101");
  out(rB?.status === 200 && gaveUp && pb?.presetReason === "Needs its base scene" && !(await item("900000001"))
    && urls().slice(n0).join(" ") === "steam://url/CommunityFilePage/910000101",
    "…a base Steam never delivers: given up (the wait's limit), the preset reads \"Needs its base scene\", no page for the base",
    `${rB?.status} | ${dlErr[pageUrl("900000001")] ?? "no error"} | ${pb?.presetReason} | ${urls().slice(n0).join(" ")}`);

  // "Subscribe with Steam login", signed in (the fake community): the preset subscribed, then its base
  const authBefore = fs.readFileSync(af, "utf8");
  fs.writeFileSync(af, JSON.stringify({ "steam-login-secure": `${process.env.FAKE_ME}||${process.env.FAKE_TOKEN}` }), { mode: 0o600 });
  await setS({ workshopDownloadMode: "subscribe" });
  n0 = urls().length;
  const pC = settle(dl("3420428971"));
  await until(async () => (await subCalls("3420428971")).includes("subscribe"), 10000);
  dropPreset("3420428971");
  const rC = await pC;
  const subB = await until(async () => (await subCalls("3419466417")).includes("subscribe"), 10000);
  dropBase("3419466417");
  await until(async () => (await item("3419466417")) && (await item("3420428971"))?.presetReason === PLAYS, 15000);
  const ord = await order();
  const iP = ord.indexOf("subscribe 3420428971"), iB = ord.indexOf("subscribe 3419466417");
  out(rC?.status === 200 && subB && iP >= 0 && iB > iP && !!(await item("3419466417")) && (await item("3420428971"))?.presetReason === PLAYS && urls().length === n0,
    "preset (Subscribe with Steam login): Steam is asked to subscribe the preset, then its base; both imported, nothing opened", `${rC?.status} | ${ord.join(", ")}`);
  // "Download & apply" of a preset whose base isn't here: the answer waits for the base its download fetches, then applies;
  // scene support is off here (and the player a stub), so the apply refuses: it answers the item with why it isn't applied
  // — never a 500 "Download failed"
  const pG = settle(dl("910000105", false, true));
  await until(async () => (await subCalls("910000105")).includes("subscribe"), 10000);
  dropPreset("910000105", "3420428971", "900000007");
  const subG = await until(async () => (await subCalls("900000007")).includes("subscribe"), 10000);
  const early = await Promise.race([pG.then(() => "answered"), sleep(1500).then(() => "waiting")]);
  dropBase("900000007");
  const rG = await pG;
  out(rG?.status === 200 && subG && early === "waiting" && rG.body?.videoPath?.endsWith("/910000105") && rG.body?.notApplied === 'Turn on "Play scenes" in Settings to play scenes'
    && (status[pageUrl("910000105")] ?? []).includes("Getting its base scene…") && !!(await item("900000007")),
    "…download & apply: waits for its base (\"Getting its base scene…\"), then answers the preset with why it isn't applied, not a failure",
    `${rG?.status} ${early} | ${JSON.stringify(rG?.body && { error: rG.body.error, notApplied: rG.body.notApplied })} | ${(status[pageUrl("910000105")] ?? []).join(" / ")}`);
  // its base already in the library (3354740764, above): reused — never subscribed, downloaded or duplicated
  const pE = settle(dl("3520333138"));
  await until(async () => (await subCalls("3520333138")).includes("subscribe"), 10000);
  dropPreset("3520333138");
  const rE = await pE;
  const reused = await until(() => /3520333138: its base 3354740764 is in the library/.test(beLog()), 10000);
  await sleep(500);
  out(rE?.status === 200 && reused && (await subCalls("3354740764")).length === 0 && (await lib()).filter((i) => i.workshopId === "3354740764").length === 1
    && (await item("3520333138"))?.presetReason === PLAYS,
    "…a base already in the library: reused, never subscribed again or duplicated", `${rE?.status} | reused ${reused} | ${(await subCalls("3354740764")).join(" ")}`);
  // a base that isn't a scene: never asked for; the preset reads why
  const pF = settle(dl("910000103"));
  await until(async () => (await subCalls("910000103")).includes("subscribe"), 10000);
  dropPreset("910000103", "3583880694", "900000005");
  const rF = await pF;
  await until(async () => (await item("910000103"))?.presetReason === "Its base is a web wallpaper, not a scene", 10000);
  await sleep(500);
  out(rF?.status === 200 && (await item("910000103"))?.presetReason === "Its base is a web wallpaper, not a scene" && (await subCalls("900000005")).length === 0
    && !(await item("900000005")),
    "…a web base: never asked for, the preset reads \"Its base is a web wallpaper, not a scene\"", `${rF?.status} | ${(await item("910000103"))?.presetReason} | ${(await subCalls("900000005")).join(" ")}`);
  // "Download without subscribing": a one-off preset gets a one-off base — both the library's own copies, both let go
  const pD = settle(dl("3009121253", true));
  await until(async () => (await subCalls("3009121253")).includes("subscribe"), 10000);
  dropPreset("3009121253");
  const rD = await pD;
  const subD = await until(async () => (await subCalls("2932157836")).includes("subscribe"), 10000);
  dropBase("2932157836");
  await until(async () => (await item("2932157836")) && (await subCalls("2932157836")).includes("unsubscribe") && (await subCalls("3009121253")).includes("unsubscribe"), 15000);
  out(rD?.status === 200 && subD && own("3009121253") && own("2932157836") && !fs.existsSync(libDir("local", "2932157836"))
    && (await subCalls("3009121253")).join(" ") === "subscribe unsubscribe" && (await subCalls("2932157836")).join(" ") === "subscribe unsubscribe"
    && (await item("3009121253"))?.presetReason === PLAYS,
    "…one-off: the preset and its base each the library's own workshop/<id> copy, each unsubscribed once copied",
    `${rD?.status} | own ${own("3009121253")} ${own("2932157836")} | ${(await subCalls("3009121253")).join(" ")} / ${(await subCalls("2932157836")).join(" ")}`);
  // Subscribe (the sidebar's, nothing imported) of a preset whose base is neither subscribed nor in the library: its base too
  const rS = await fetch(U + "/workshop/subscribe", { method: "POST", headers: json, body: JSON.stringify({ workshopId: "910000101", title: "p" }) });
  const subS = await until(async () => (await subCalls("900000001")).includes("subscribe"), 10000);
  out(rS.status === 200 && (await subCalls("910000101")).includes("subscribe") && subS,
    "Subscribe of a preset (Subscribe with Steam login): its base scene is subscribed too", `${rS.status} | ${(await subCalls("900000001")).join(" ")}`);
  // unsubscribing the preset (the Browse sidebar's Unsubscribe: Delete from source for a library item) never unsubscribes its base
  const rU = await fetch(U + "/workshop/unsubscribe", { method: "POST", headers: json, body: JSON.stringify({ workshopId: "3420428971", title: "p" }) });
  const unsubP = await until(async () => (await subCalls("3420428971")).includes("unsubscribe"), 15000);
  await sleep(1000);
  out(rU.status === 200 && unsubP && !(await subCalls("3419466417")).includes("unsubscribe") && !!(await item("3419466417")),
    "unsubscribing a preset (Unsubscribe = Delete from source): its base stays subscribed and in the library", `${(await subCalls("3420428971")).join(" ")} / base ${(await subCalls("3419466417")).join(" ")}`);
  fs.writeFileSync(af, authBefore, { mode: 0o600 });
}
ws.close();
EOF
(cd "$T" && U=$U T=$T ROOT=$ROOT FAKE=$FAKE FAKE_ME=$FAKE_ME FAKE_TOKEN=$FAKE_TOKEN XDG_CONFIG_HOME=$XDG_CONFIG_HOME timeout 240 node drive.mjs) > "$T/drive.log" 2>&1; rc=$?
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
printf '{"WorkshopDownloadMode":"steamapp","WorkshopFolder":"%s","AutoAddWeWallpapersToLibrary":false,"NoAudio":true}\n' \
  "$T/ws3/431960" > "$XDG_CONFIG_HOME/liascape/settings.json"
# no linger: with no page saying the Workshop shows, every Steam-client child lets go right after its operation, so the
# checks below see one connection per operation (how long it is held otherwise: scripts/test-steam-app-hold.sh)
(cd /tmp && LIASCAPE_TEST_NO_NETWORK=1 LIASCAPE_STEAM_APP_LINGER_MS=0 LIASCAPE_WORKSHOP_POLL_MS=300 LIASCAPE_STEAM_CM_FIXTURE=$T/cm.json LIASCAPE_STEAM_CLIENT_LIB=$T/steamclient.so FAKE_UGC_DIR=$T/steamlib FAKE_UGC_CLIP=$T/clip.mp4 \
  exec "$DOTNET" "$DLL" serve > "$T/backend3.log" 2>&1) & BP3=$!
for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP3 2>/dev/null || break; sleep 0.1; done
U3=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port" 2>/dev/null)
for _ in $(seq 1 50); do curl -sf -m 2 "$U3/health" >/dev/null && break; sleep 0.1; done
cp "$ROOT/scripts/test-fixtures/drive-steam-client.mjs" "$T/drive3.mjs"
(cd "$T" && U=$U3 T=$T ROOT=$ROOT XDG_CONFIG_HOME=$XDG_CONFIG_HOME timeout $((420 + 50 * ${FAKE_UGC_OPEN_DELAY_MS:-0} / 1000)) node drive3.mjs) > "$T/drive3.log" 2>&1; rc=$?
sed 's/^/      /' "$T/drive3.log"
p=$(grep -c '^PASS' "$T/drive3.log"); f=$(grep -c '^FAIL' "$T/drive3.log")
PASS=$((PASS + p)); FAIL=$((FAIL + f))
[ $rc = 0 ] || bad "drive3.mjs exited $rc"
echo "== backend 3 log (workshop lines)"; grep -E "workshop:|error:" "$T/backend3.log" | sed 's/^/      /' | tail -8
fi

echo "== 4. steam-selftest against a PRIVATE Secret Service (dbus-run-session + gnome-keyring-daemon — never the session's)"
if command -v secret-tool >/dev/null && command -v gnome-keyring-daemon >/dev/null && command -v dbus-run-session >/dev/null \
   && command -v dbus-send >/dev/null; then
  privhome "$T/h4"; chmod 700 "$XDG_RUNTIME_DIR"
  # its own bus (dbus-run-session's, under /tmp) and its own keyring daemon (HOME / XDG_RUNTIME_DIR private: its keyrings and
  # control socket are this test's); the login keyring created + unlocked with a throwaway password (an empty one makes none)
  (unset DBUS_SESSION_BUS_ADDRESS GNOME_KEYRING_CONTROL SSH_AUTH_SOCK; cd /tmp && timeout 240 dbus-run-session -- bash -c '
    printf "hermetic-test-pw" | gnome-keyring-daemon --foreground --unlock --components=secrets > "$HOME/gkd.log" 2>&1 & K=$!
    for _ in $(seq 1 50); do
      dbus-send --session --print-reply --dest=org.freedesktop.DBus / org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets 2>/dev/null \
        | grep -q "boolean true" && break; sleep 0.1
    done
    LIASCAPE_TEST_EXPECT_SECRETS=keyring "$0" "$1" steam-selftest; rc=$?
    # after the selftest signed out: nothing of ours left in the keyring
    for n in steam-refresh-token steam-access-token steam-login-secure; do
      secret-tool lookup application liascape name $n >/dev/null 2>&1 && { echo "LEFT IN KEYRING: $n"; rc=1; }
    done
    kill $K; wait $K 2>/dev/null; exit $rc' "$DOTNET" "$DLL") > "$T/selftest4.log" 2>&1; rc=$?
  grep -E "^(ok|FAIL)|LEFT IN KEYRING|secrets:" "$T/selftest4.log" | grep -iE "secret|keyring|FAIL|migration|sign-out|stub" | sed 's/^/      /'
  [ $rc = 0 ] && grep -q "STEAM-SELFTEST PASS" "$T/selftest4.log" && grep -q "secrets: Secret Service" "$T/selftest4.log" \
    && ok "steam-selftest on a private Secret Service (gnome-keyring)" || { bad "steam-selftest on a private Secret Service (rc $rc)"; tail -8 "$T/selftest4.log"; }
  [ -f "$T/h4/.local/share/keyrings/login.keyring" ] && ok "…the private keyring was the one used (\$HOME/.local/share/keyrings/login.keyring)" \
    || bad "…no private login.keyring was created"
else
  echo "      SKIP — needs secret-tool (libsecret), gnome-keyring-daemon, dbus-run-session, dbus-send (the stub-secret-tool part of § 1 still ran)"
fi
# the backends only (LIASCAPE_TEST_NO_NETWORK=1 on their serve lines): steam-selftest checks its own refusals ("no network")
echo "== no real network"
rn=$(lp_real_network "$T/backend.log" "$T/backend3.log")
[ -z "$rn" ] && ok "no call to a real server (none refused, no Steam session)" \
  || { bad "real network: $(awk '{n += $1} END {print n}' <<<"$rn") call(s) to real servers:"; echo "$rn"; }
echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
