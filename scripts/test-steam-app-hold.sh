#!/usr/bin/env bash
# Hermetic test of how long "Use the Steam app" stays connected to Steam (Helpers/SteamClientHold.cs): one `steam-ugc
# session` child, held while the Liascape window is open (its page's heartbeat, POST /steam/app-presence), then a tail of
# three beats (SteamClientHold.Tail).
# A private backend whose Steam client is the FAKE steamclient.so (scripts/test-fixtures/fake_steamclient.c, built here: its
# helpers.log says when each child connected, used Steam and let go), the heartbeat (and so the tail) shortened
# (LIASCAPE_STEAM_APP_BEAT_MS):
#  a. the window open, nothing downloaded: no child, /steam/status `appConnected` false; each beat's answer names the interval
#  b. four downloads (two after each other, two at once) while the window is open: ONE child serves them all, and stays past
#     the tail while the window beats
#  c. the beats stop for less than the tail (a reload, a renderer recovery) and come back: the same child stays
#  d. the window closes (the beats just stop): the child releases Steam (its user + pipe) and exits a tail after the last
#     beat, not before
#  e. no window at all (a download from the CLI): the child goes a tail after the operation
#  f. the child killed: `appConnected` false at once; the next download starts a fresh child and finishes
#  h. the held child hangs (the fake's hang-once): its ping before the next download goes unanswered, one fresh child does it
#  i. Steam refuses a one-off's DownloadItem (refuse-download): subscribe, copy, unsubscribe, all on the same held child
#  j. a download cancelled midway (hold-install): the held child stays and the next download reads its own answer
#  k. "Favourite on Steam" (POST /steam/open-page {watch: "favorite"}), no sign-in: the page opens in the Steam app, and the
#     watch (Helpers/SteamFavoriteWatch.cs) reads the Steam app's favourites: a favourite and an unfavourite made there, a
#     second apart, each reach the account's favourites cache within its window, never through the cache's count check
#     (no `count check` in the log); a plain open-page starts no watch
#  l. the watch's window over: no more reads, a later flip stays out of the cache; the child it held (the UI gone meanwhile)
#     stayed connected for the window, past the tail, then released Steam a tail after its last read
#  m. no Steam app (fail-init): the page still opens, no watch: one helper tried, none held, nothing read; Steam offline
#     (no account): the page opens, no favourites query sent
#  n. "Use the Steam app" turned off mid-watch: the watch stops at its next read
#  o. a download holds the Steam client's turn (hold-install) from a watch's first read until past its window: the read
#     queued behind it never goes out, nothing is applied
#  p. a hung Steam library mid-watch (hang-query): the read is cut off after its bound, its child killed, and the next
#     download gets the turn and finishes
#  g. SIGTERM with the child held: serve exits within 3 s and the child released Steam first
# Never touches Steam, the network (LIASCAPE_TEST_NO_NETWORK) or ~/.config/liascape (temp HOME + every XDG dir); everything
# it started is stopped on exit.
#
# Usage: scripts/test-steam-app-hold.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs and prints where (last line).
# Needs: dotnet (or DOTNET=…), node (≥ 22), a C compiler, ffmpeg, curl. Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/test-lock.sh" # one heavy test run at a time on this machine
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"
BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
DOTNET=${DOTNET:-$(command -v dotnet || true)}
[ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
CC=${CC:-$(command -v cc || command -v gcc || true)}
[ -n "$CC" ] || { echo "no C compiler for the fake steamclient.so"; exit 2; }
for t in node ffmpeg curl timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
DLL=${LIASCAPE_BACKEND_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
if [ $BUILD = 1 ] && [ -z "${LIASCAPE_BACKEND_DLL:-}" ]; then
  "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
  [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
fi
[ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }

T=$(mktemp -d /tmp/liascape-hold-XXXXXX)
BP=""
stopbe() { [ -n "$1" ] && { kill "$1" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$1" 2>/dev/null || break; sleep 0.1; done; kill -9 "$1" 2>/dev/null; }; }
cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  stopbe "$BP"
  [ -s "$T/steamlib/child.pid" ] && kill -9 "$(cat "$T/steamlib/child.pid")" 2>/dev/null
  lp_tmp_done "$T" /tmp/liascape-hold- "$rc"
}
trap cleanup EXIT
# copied after the trap so a copy that fails partway still leaves no temp root behind
mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
DLL=$T/backend/liascape-backend.dll
trap 'exit 130' INT TERM HUP
unset LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT LIASCAPE_PLAYER_SOCKET
export DBUS_SESSION_BUS_ADDRESS=unix:path=$T/no-bus DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 LIASCAPE_SECRETS=file
# the player: an `exit 1` stub, so no real liascape-player ever starts here
mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 1\n' > "$T/bin/liascape-player"; chmod +x "$T/bin/liascape-player"
export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player
PASS=0; FAIL=0
ok() { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }
H=$T/h; mkdir -p "$H/.config/liascape" "$H/.cache" "$H/.local/share" "$H/rt" "$H/st" "$T/ws/431960" "$T/steamlib" "$T/bin"
export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_CACHE_HOME=$H/.cache XDG_DATA_HOME=$H/.local/share XDG_RUNTIME_DIR=$H/rt XDG_STATE_HOME=$H/st
# nothing may open a Steam page here: a stub xdg-open records any
printf '#!/bin/sh\nprintf "%%s\\n" "$1" >> "%s/xdg-open.urls"\n' "$T" > "$T/bin/xdg-open"; chmod +x "$T/bin/xdg-open"; : > "$T/xdg-open.urls"
export PATH=$T/bin:$PATH

"$CC" -shared -fPIC -O1 -o "$T/steamclient.so" "$ROOT/scripts/test-fixtures/fake_steamclient.c" || { echo "the fake steamclient.so didn't build"; exit 2; }
ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc2=size=320x180:rate=30" -t 1 -c:v libx264 -pix_fmt yuv420p "$T/clip.mp4"
echo '{}' > "$T/cm.json"
printf '{"WorkshopDownloadMode":"steamapp","WorkshopFolder":"%s","AutoAddWeWallpapersToLibrary":false,"NoAudio":true}\n' \
  "$T/ws/431960" > "$XDG_CONFIG_HOME/liascape/settings.json"
BEAT=800 TAIL=2400 # the tail is three beats (SteamClientHold.TailBeats)
WATCH=6000 WATCH_POLL=400 WATCH_READ=2000
(cd /tmp && LIASCAPE_TEST_NO_NETWORK=1 LIASCAPE_STEAM_APP_BEAT_MS=$BEAT LIASCAPE_WORKSHOP_POLL_MS=300 \
  LIASCAPE_FAV_WATCH_MS=$WATCH LIASCAPE_FAV_WATCH_POLL_MS=$WATCH_POLL LIASCAPE_FAV_WATCH_READ_MS=$WATCH_READ \
  LIASCAPE_STEAM_CM_FIXTURE=$T/cm.json LIASCAPE_STEAM_CLIENT_LIB=$T/steamclient.so FAKE_UGC_DIR=$T/steamlib FAKE_UGC_CLIP=$T/clip.mp4 \
  exec "$DOTNET" "$DLL" serve > "$T/backend.log" 2>&1) & BP=$!
for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { bad "backend didn't start"; tail -15 "$T/backend.log"; exit 1; }
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done

cat > "$T/drive.mjs" <<'EOF'
import fs from "node:fs";
const { U, T } = process.env, TAIL = +process.env.TAIL, BEAT = +process.env.BEAT;
const TOKEN = fs.readFileSync(`${process.env.XDG_CONFIG_HOME}/liascape/serve.token`, "utf8").trim();
const H = { "X-Liascape-Token": TOKEN, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a race's give-up (null), unref'd: a pending one would keep node (and g.'s held child, past its heartbeat) alive at the end
const ceiling = (ms) => new Promise((r) => setTimeout(() => r(null), ms).unref());
const out = (ok, name, extra = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
const until = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return Date.now() - t0; await sleep(50); } return (await pred()) ? Date.now() - t0 : null; };
const lines = (f) => fs.existsSync(`${T}/steamlib/${f}`) ? fs.readFileSync(`${T}/steamlib/${f}`, "utf8").split("\n").filter(Boolean) : [];
const opens = () => lines("helpers.log").filter((l) => l.startsWith("open ")).map((l) => l.split(" ")[1]);
const users = () => [...new Set(lines("helpers.log").filter((l) => l.startsWith("use ")).map((l) => l.split(" ")[1]))];
const childPid = () => fs.existsSync(`${T}/steamlib/child.pid`) ? +fs.readFileSync(`${T}/steamlib/child.pid`, "utf8").trim() : 0;
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); } catch { return false; }
  try { return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, "utf8")); } catch { return false; } };
const connected = async () => (await (await fetch(U + "/steam/status", { headers: H })).json()).appConnected === true;
const sources = await (await fetch(U + "/sources", { headers: H })).json();
const src = sources.findIndex((s) => s.supportsTagFilter);
// POST /download of a fake Workshop item → {status, body}; `extra` joins the body ({oneOff: true})
const dl = async (id, extra = {}, signal) => { const r = await fetch(U + "/download", { method: "POST", headers: H, signal, body: JSON.stringify({ source: src,
  result: { title: `ws-${id}`, thumbnailUrl: "", pageUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`, workshopId: id, isScene: false, trailerKnown: true }, apply: false, ...extra }) });
  return { status: r.status, body: await r.json().catch(() => null) }; };
const download = async (id) => (await dl(id)).status;
const inLibrary = async (id) => (await (await fetch(U + "/library", { headers: H })).json()).some((i) => i.workshopId === id);
let presStatus = 0, presBody = null, lastBeatAt = 0;
const presence = async () => { lastBeatAt = Date.now(); const r = await fetch(U + "/steam/app-presence", { method: "POST", headers: H });
  presStatus = r.status; presBody = await r.json().catch(() => null); };
// the open window's heartbeat, every BEAT (the interval the backend names in its answer)
let beating = null;
const beat = (on) => { clearInterval(beating); beating = null; if (on) { presence(); beating = setInterval(() => presence(), BEAT); } };

// a. the window open, nothing downloaded: no connection; each beat's answer names the interval to beat at
beat(true); await sleep(1500);
out(opens().length === 0 && !(await connected()) && presStatus === 200 && presBody?.beatMs === BEAT,
  "a. the window open, nothing downloaded: no Steam connection; the beat's answer names its interval",
  `presence ${presStatus} ${JSON.stringify(presBody)}, ${opens().length} children connected, appConnected ${await connected()}`);

// b. downloads while the window is open: one child for all of them, held while the window beats
const rb = [await download("720000001"), await download("720000002"), ...(await Promise.all([download("720000003"), download("720000004")]))];
const pidB = childPid();
out(rb.every((s) => s === 200) && opens().length === 1 && users().length === 1 && users()[0] === String(pidB),
  "b. four downloads (two at once) while the window is open: one child served them all", `statuses ${rb}, children ${opens()}, used by ${users()}`);
await sleep(TAIL + 1000);
out(alive(pidB) && await connected() && opens().length === 1, "b. …and stays connected past the tail while the window beats",
  `alive ${alive(pidB)}, appConnected ${await connected()}`);

// c. a reload or a renderer recovery: the beats stop for less than the tail, then come back — the same child, still held
// after the tail would have ended
beat(false); const tGap = lastBeatAt;
await sleep(TAIL / 2);
const midTail = alive(pidB);
beat(true);
await sleep(Math.max(0, tGap + TAIL + 1500 - Date.now()));
out(midTail && alive(pidB) && opens().length === 1 && await connected(), "c. the beats back within the tail (a reload): the same child held",
  `alive mid-gap ${midTail}, now alive ${alive(pidB)}, children ${opens().length}`);

// d. the window closes (no word, the beats just stop): released a tail after the last beat, not before
const rel0 = lines("released").length;
beat(false); const tD = lastBeatAt;
await sleep(Math.max(0, tD + TAIL - 700 - Date.now()));
const early = alive(pidB);
const gone = await until(() => !alive(pidB), 8000);
const dt = Date.now() - tD, rel = lines("released").slice(rel0);
out(early && gone !== null && dt >= TAIL - 300 && dt < TAIL + 2500 && rel.includes("user") && rel.includes("pipe") && !(await connected()),
  "d. the window closed: the child released Steam (user + pipe) and exited a tail after the last beat",
  `alive ${TAIL - 700} ms after the last beat ${early}, gone after ${dt} ms (tail ${TAIL}), released [${rel}], appConnected ${await connected()}`);

// e. no window at all (a download from the CLI): released a tail after the operation
const re = await download("720000005"); const tE = Date.now(); const pidE = childPid();
await sleep(TAIL - 700);
const eHeld = alive(pidE);
await until(() => !alive(pidE), TAIL + 4000);
const dE = Date.now() - tE;
out(re === 200 && pidE !== pidB && eHeld && !alive(pidE) && dE >= TAIL - 300 && dE < TAIL + 2500,
  "e. no window (a download from the CLI): released a tail after the operation",
  `download ${re}, new child ${pidE !== pidB}, alive at ${TAIL - 700} ms ${eHeld}, gone after ${dE} ms (tail ${TAIL})`);

// f. the child killed: never reported connected, the next download starts a fresh one
beat(true); const rf1 = await download("720000006"); const pidF = childPid(); const nF = opens().length;
try { process.kill(pidF, "SIGKILL"); } catch { /* already gone: the checks below say so */ }
const seen = await until(async () => !(await connected()), 2000);
const rf2 = await download("720000007"); const pidF2 = childPid();
out(rf1 === 200 && seen !== null && rf2 === 200 && pidF2 !== pidF && opens().length === nF + 1 && alive(pidF2),
  "f. the child died: not connected at once, the next download started a fresh child and finished",
  `downloads ${rf1}/${rf2}, appConnected false after ${seen} ms, pids ${pidF} → ${pidF2}, children +${opens().length - nF}`);

// h. the held child gone quiet (a hung library): its ping before the next download gets no answer, so a fresh child does it
const pidH0 = childPid(), nH = opens().length;
fs.writeFileSync(`${T}/steamlib/hang-once`, "");
const rh = await Promise.race([dl("720000008"), ceiling(40000)]);
const pidH = childPid();
out(rh?.status === 200 && rh.body?.workshopId === "720000008" && lines("hung").length === 1 && opens().length === nH + 1 && pidH !== pidH0
  && !alive(pidH0) && alive(pidH), "h. a held child that doesn't answer its ping: replaced before the download (one fresh child), which finished",
  `download ${rh ? rh.status : "never answered (40 s)"}, hung ${lines("hung").length}, children +${opens().length - nH}, pids ${pidH0} → ${pidH}, old alive ${alive(pidH0)}`);
// a backend that waited on the hung child forever holds the Steam client's turn: the hung child goes, so i. and j. still run
if (alive(pidH0)) { try { process.kill(pidH0, "SIGKILL"); } catch { /* gone meanwhile */ } await sleep(1000); }

// i. Steam refuses a one-off's DownloadItem (the item isn't subscribed): subscribe, copy, unsubscribe instead, all on the held
// child, with no fresh one for Steam's "no"
const nI = opens().length;
fs.writeFileSync(`${T}/steamlib/refuse-download`, "");
const ri = await dl("720000009", { oneOff: true });
const unsubbed = await until(() => !fs.existsSync(`${T}/steamlib/sub-720000009`) && lines("calls").includes("unsubscribe 720000009"), 20000);
fs.rmSync(`${T}/steamlib/refuse-download`);
out(ri.status === 200 && unsubbed !== null && opens().length === nI && childPid() === pidH && alive(pidH),
  "i. a refused one-off on the held child: subscribed, copied and unsubscribed on that same child",
  `download ${ri.status} ${JSON.stringify(ri.body)?.slice(0, 80)}, unsubscribed ${unsubbed !== null}, children +${opens().length - nI}, pid ${pidH} → ${childPid()}`);

// j. a download cancelled midway: the held child stays, and the next download reads its own answer, not the cancelled one's
const nJ = opens().length;
fs.writeFileSync(`${T}/steamlib/hold-install`, "");
const ac = new AbortController();
const pj = dl("720000010", {}, ac.signal).then(() => "answered", () => "aborted");
const started = await until(() => lines("calls").includes("subscribe 720000010"), 20000);
await sleep(400); ac.abort(); const pjr = await pj;
await sleep(500);
fs.rmSync(`${T}/steamlib/hold-install`);
const rj = await Promise.race([dl("720000011"), ceiling(40000)]);
out(started !== null && pjr === "aborted" && rj?.status === 200 && rj.body?.workshopId === "720000011" && childPid() === pidH && alive(pidH)
  && opens().length === nJ && !(await inLibrary("720000010")) && await inLibrary("720000011"),
  "j. cancelled midway: the held child stays, and the next download on it finished with its own item",
  `cancelled ${pjr}, next ${rj ? rj.status + " " + JSON.stringify(rj.body)?.slice(0, 80) : "never answered"}, pid ${pidH} → ${childPid()}, children +${opens().length - nJ}`);

// k. "Favourite on Steam" with no sign-in: the page opens in the Steam app and the watch reads the Steam app's favourites; a
// favourite made there, then an unfavourite a second later, each reach the account's favourites cache within the window — never
// through the cache's count check, whose 50 s hold would have kept the second out
const WATCH_POLL_GRACE = 1500; // a read in flight when the window closed lands within this
const WATCH = +process.env.WATCH, SID = "76561190000000042", FAVF = `${T}/steamlib/favorites`, ITEM = "720000200", OTHER = "720000101";
const CACHE = `${process.env.XDG_CACHE_HOME}/liascape/workshop/favorites-${SID}.json`;
fs.mkdirSync(`${process.env.XDG_CACHE_HOME}/liascape/workshop`, { recursive: true });
fs.writeFileSync(CACHE, JSON.stringify({ ids: [OTHER], viaPage: false, total: 1 }));
fs.writeFileSync(FAVF, `${OTHER}\n`);
const cacheIds = () => { try { return JSON.parse(fs.readFileSync(CACHE, "utf8")).ids ?? []; } catch { return []; } };
const urls = () => fs.readFileSync(`${T}/xdg-open.urls`, "utf8").split("\n").filter(Boolean);
const log = () => fs.readFileSync(`${T}/backend.log`, "utf8");
const openPage = async (body) => { const r = await fetch(U + "/steam/open-page", { method: "POST", headers: H, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
beat(false);
// a plain "Open on Steam" (the Steam page's own tile) watches nothing
const qPlain = lines("queries").length, plain = await openPage({ workshopId: OTHER });
await sleep(1200);
const plainQueries = lines("queries").length - qPlain;
const u0 = urls().length, q0 = lines("queries").length, tK = Date.now();
const rk = await openPage({ workshopId: ITEM, watch: "favorite" });
const opened = await until(() => urls().slice(u0).includes(`steam://url/CommunityFilePage/${ITEM}`), 3000);
const read1 = await until(() => lines("queries").length > q0, 5000);
await sleep(WATCH / 10);
fs.writeFileSync(FAVF, `${ITEM}\n${OTHER}\n`);
const fav = await until(() => cacheIds().includes(ITEM), 3000);
await sleep(1000);
fs.writeFileSync(FAVF, `${OTHER}\n`);
const unfav = await until(() => !cacheIds().includes(ITEM) && cacheIds().includes(OTHER), 3000);
const kDone = Date.now() - tK, counted = (log().match(/workshop-favorites: count check/g) ?? []).length;
const pidK = childPid();
out(plain.status === 200 && plainQueries === 0 && rk.status === 200 && rk.body?.ok === true && rk.body?.watching === true && opened !== null && read1 !== null
  && fav !== null && unfav !== null && kDone < WATCH && counted === 0,
  "k. \"Favourite on Steam\": the page opened in the Steam app; a favourite and an unfavourite made there both reached the cache within the window, no count check",
  `plain open ${plain.status} (${plainQueries} reads), open ${rk.status} ${JSON.stringify(rk.body)}, page opened ${opened !== null}, first read ${read1} ms, favourite seen ${fav} ms, `
  + `unfavourite seen ${unfav} ms, all within ${kDone} ms (window ${WATCH}), count checks ${counted}, cache ${JSON.stringify(cacheIds())}`);

// l. the window over: no more reads, a later flip stays out; the child the watch held (no UI beating since before k.) stayed
// past the tail for the window, then let go a tail after the last read
const heldMid = await (async () => { await sleep(Math.max(0, tK + WATCH - 1200 - Date.now())); return alive(pidK) && await connected(); })();
await sleep(Math.max(0, tK + WATCH + WATCH_POLL_GRACE - Date.now()));
const qEnd = lines("queries").length;
fs.writeFileSync(FAVF, `${ITEM}\n${OTHER}\n`);
const goneL = await until(() => !alive(pidK), TAIL + 4000);
await sleep(500);
const lateReads = lines("queries").length - qEnd;
out(heldMid && lateReads === 0 && !cacheIds().includes(ITEM) && goneL !== null && /favourites watch: its window is over/.test(log())
  && lines("queries").length === +lines("queries-released").length,
  "l. the watch's window over: no more reads, a later favourite stays out; Steam held through the window, released a tail after",
  `held ${WATCH - 1200} ms in (the tail ${TAIL}) ${heldMid}, reads after the window ${lateReads}, cache ${JSON.stringify(cacheIds())}, released ${goneL} ms after the window, `
  + `queries ${lines("queries").length} / released ${lines("queries-released").length}`);

// m. no Steam app: the page still opens, no watch — one helper tried and gone, nothing held, nothing read
fs.writeFileSync(`${T}/steamlib/fail-init`, "");
const nM = lines("helpers.log").filter((l) => l.startsWith("start ")).length, qM = lines("queries").length, uM = urls().length;
const rm = await openPage({ workshopId: ITEM, watch: "favorite" });
const openedM = await until(() => urls().slice(uM).includes(`steam://url/CommunityFilePage/${ITEM}`), 3000);
const noWatch = await until(() => /favourites watch: no watch — /.test(log()), 5000);
await sleep(WATCH_POLL_GRACE);
const triedM = lines("helpers.log").filter((l) => l.startsWith("start ")).length - nM;
out(rm.status === 200 && rm.body?.ok === true && openedM !== null && noWatch !== null && triedM === 1 && lines("queries").length === qM && !(await connected()),
  "m. no Steam app: the page opened, no watch (one helper tried, none held, nothing read)",
  `open ${rm.status} ${JSON.stringify(rm.body)}, page opened ${openedM !== null}, "no watch" logged ${noWatch !== null}, helpers tried ${triedM}, reads ${lines("queries").length - qM}, appConnected ${await connected()}`);
fs.rmSync(`${T}/steamlib/fail-init`);
// …and Steam running but offline (no account to watch): the page opens, no favourites query is ever sent
fs.writeFileSync(`${T}/steamlib/offline`, "");
const qO = lines("queries").length, lO = (log().match(/favourites watch: no watch — /g) ?? []).length;
const ro = await openPage({ workshopId: ITEM, watch: "favorite" });
const offNoWatch = await until(() => (log().match(/favourites watch: no watch — /g) ?? []).length > lO, 5000);
await sleep(WATCH_POLL_GRACE);
out(ro.status === 200 && ro.body?.ok === true && offNoWatch !== null && /no watch — Steam isn't signed in/.test(log()) && lines("queries").length === qO,
  "m. Steam offline: the page opened, no watch, no favourites query sent",
  `open ${ro.status} ${JSON.stringify(ro.body)}, "no watch" logged ${offNoWatch !== null}, reads ${lines("queries").length - qO}`);
fs.rmSync(`${T}/steamlib/offline`);

// n. "Use the Steam app" turned off mid-watch: the reads stop at the next one, the window not yet over
const setMode = (mode) => fetch(U + "/settings", { method: "POST", headers: H, body: JSON.stringify({ workshopDownloadMode: mode }) });
const qN = lines("queries").length, tN = Date.now();
const rn = await openPage({ workshopId: ITEM, watch: "favorite" });
const readN = await until(() => lines("queries").length > qN, 5000);
await setMode("subscribe");
const stopN = await until(() => /favourites watch: stopped — not "Use the Steam app" any more/.test(log()), 3000);
const qStop = lines("queries").length; await sleep(WATCH_POLL_GRACE);
const lateN = lines("queries").length - qStop, inWindow = Date.now() - tN < WATCH;
await setMode("steamapp");
out(rn.body?.watching === true && readN !== null && stopN !== null && lateN === 0 && inWindow,
  "n. \"Use the Steam app\" turned off mid-watch: the watch stopped, no more reads",
  `open ${JSON.stringify(rn.body)}, first read ${readN} ms, stopped ${stopN} ms after the switch, reads after it ${lateN}, still inside the window ${inWindow}`);

// o. a download takes the Steam client's turn right after a watch's first read and keeps it past the watch's window: the
// read queued behind it never goes out once the window is over, and nothing is applied
const ITEM_O = "720000300";
const qO0 = lines("queries").length, tO = Date.now();
const ro2 = await openPage({ workshopId: ITEM_O, watch: "favorite" });
const readO = await until(() => lines("queries").length > qO0, 5000);
fs.writeFileSync(`${T}/steamlib/hold-install`, "");
const dlO = dl("720000013"); // held at 50 % (hold-install): the turn stays taken
await until(() => lines("calls").includes("subscribe 720000013"), 5000);
const qHeld = lines("queries").length;
fs.writeFileSync(FAVF, `${ITEM_O}\n${OTHER}\n`); // a favourite Steam has, which only a late read could see
await sleep(Math.max(0, tO + WATCH + 800 - Date.now()));
fs.rmSync(`${T}/steamlib/hold-install`);
const dO = await Promise.race([dlO, ceiling(30000)]);
await sleep(WATCH_POLL_GRACE);
const lateO = lines("queries").length - qHeld;
out(ro2.body?.watching === true && readO !== null && dO?.status === 200 && lateO === 0 && !cacheIds().includes(ITEM_O),
  "o. a download holding the Steam client's turn past a watch's window: the queued read never went out, nothing applied",
  `first read ${readO} ms, download ${dO ? dO.status : "never answered"}, reads after the turn came free ${lateO}, cache ${JSON.stringify(cacheIds())}`);
fs.writeFileSync(FAVF, `${OTHER}\n`);

// p. a hung Steam library mid-watch: the read is cut off after its bound (the child killed), so the Steam client's turn comes
// free and the next download finishes
const WATCH_READ = +process.env.WATCH_READ, ITEM_P = "720000301";
fs.writeFileSync(`${T}/steamlib/hang-query`, "");
const rp = await openPage({ workshopId: ITEM_P, watch: "favorite" });
const hung = await until(() => lines("query-hung").length > 0, 5000);
const pidP = childPid(), tP = Date.now();
const dP = await Promise.race([dl("720000014"), ceiling(WATCH_READ + 15000)]);
const freedAfter = Date.now() - tP;
out(rp.body?.watching === true && hung !== null && dP?.status === 200 && !alive(pidP) && freedAfter < WATCH_READ + 6000,
  "p. a hung Steam library mid-watch: the read cut off after its bound, the hung child killed, the next download finished",
  `hung ${hung !== null}, download ${dP ? dP.status : `never answered (${WATCH_READ + 15000} ms)`} after ${freedAfter} ms (bound ${WATCH_READ}), hung child alive ${alive(pidP)}`);
// a backend that waited on it forever: the hung child goes, so g. still runs
if (alive(pidP)) { try { process.kill(pidP, "SIGKILL"); } catch { /* gone meanwhile */ } await sleep(1000); }

// g. below needs a held child: one more download while the UI beats
beat(true); const rg = await download("720000012");
if (rg !== 200) out(false, "a download for g.'s held child", `status ${rg}`);
fs.writeFileSync(`${T}/held.pid`, String(childPid()));
fs.writeFileSync(`${T}/released.before`, String(lines("released").length));
beat(false);
EOF
(cd "$T" && U=$U T=$T TAIL=$TAIL BEAT=$BEAT WATCH=$WATCH WATCH_READ=$WATCH_READ timeout 300 node drive.mjs) > "$T/drive.log" 2>&1; rc=$?
cat "$T/drive.log"
PASS=$((PASS + $(grep -c '^PASS' "$T/drive.log"))); FAIL=$((FAIL + $(grep -c '^FAIL' "$T/drive.log")))
[ $rc = 0 ] || bad "drive.mjs exited $rc"

# g. SIGTERM with the child held: serve gone within 3 s, the child released Steam on the way
if [ -s "$T/held.pid" ] && kill -0 "$(cat "$T/held.pid")" 2>/dev/null; then
  CP=$(cat "$T/held.pid"); r0=$(cat "$T/released.before")
  t0=$(date +%s%N); kill -TERM $BP
  for _ in $(seq 1 100); do kill -0 $BP 2>/dev/null || break; sleep 0.05; done
  ms=$(( ($(date +%s%N) - t0) / 1000000 ))
  kill -0 $BP 2>/dev/null && { bad "g. serve still running ${ms} ms after SIGTERM"; } || BP=""
  newrel=$(tail -n +$((r0 + 1)) "$T/steamlib/released" 2>/dev/null | tr '\n' ' ')
  [ -z "$BP" ] && [ $ms -le 3000 ] && ! kill -0 "$CP" 2>/dev/null && grep -q user <<<"$newrel" && grep -q pipe <<<"$newrel" \
    && ok "g. SIGTERM with Steam held: serve exited in ${ms} ms, the child released Steam [${newrel}] and exited" \
    || bad "g. SIGTERM with Steam held: serve ${ms} ms, child alive $(kill -0 "$CP" 2>/dev/null && echo yes || echo no), released since [${newrel}]"
else
  bad "g. no held child to SIGTERM with (f. didn't leave one)"
fi
echo "== backend log (steam-app lines)"; grep -E "steam-app:|error:" "$T/backend.log" | sed 's/^/      /' | tail -20
echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
