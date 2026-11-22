#!/usr/bin/env bash
# Hermetic test of how long "Use the Steam app" stays connected to Steam (Helpers/SteamClientHold.cs): one `steam-ugc
# session` child, held while the UI says the Workshop shows on Browse (POST /steam/app-presence, a heartbeat), then a linger.
# A private backend whose Steam client is the FAKE steamclient.so (scripts/test-fixtures/fake_steamclient.c, built here: its
# helpers.log says when each child connected, used Steam and let go), the linger and heartbeat timeout shortened
# (LIASCAPE_STEAM_APP_LINGER_MS / LIASCAPE_STEAM_APP_HEARTBEAT_MS):
#  a. the Workshop showing, nothing downloaded: no child, /steam/status `appConnected` false
#  b. four downloads (two after each other, two at once) on Browse: ONE child serves them all, and stays while the UI beats
#  c. the UI leaves: inside the linger the child stays; it comes back: past the linger's end the child is still there
#  d. the UI leaves for good: the child releases Steam (its user + pipe) and exits once the linger is over, not before
#  e. the UI stops beating without a word (a crashed page): the heartbeat times out, then the linger, then the release
#  f. the child killed: `appConnected` false at once; the next download starts a fresh child and finishes
#  h. the held child hangs (the fake's hang-once): its ping before the next download goes unanswered, one fresh child does it
#  i. Steam refuses a one-off's DownloadItem (refuse-download): subscribe, copy, unsubscribe, all on the same held child
#  j. a download cancelled midway (hold-install): the held child stays and the next download reads its own answer
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
printf '{"PlayerEngine":"legacy","WorkshopDownloadMode":"steamapp","WorkshopFolder":"%s","AutoAddWeWallpapersToLibrary":false,"NoAudio":true}\n' \
  "$T/ws/431960" > "$XDG_CONFIG_HOME/liascape/settings.json"
LINGER=2500 BEAT=4000
(cd /tmp && LIASCAPE_TEST_NO_NETWORK=1 LIASCAPE_STEAM_APP_LINGER_MS=$LINGER LIASCAPE_STEAM_APP_HEARTBEAT_MS=$BEAT LIASCAPE_WORKSHOP_POLL_MS=300 \
  LIASCAPE_STEAM_CM_FIXTURE=$T/cm.json LIASCAPE_STEAM_CLIENT_LIB=$T/steamclient.so FAKE_UGC_DIR=$T/steamlib FAKE_UGC_CLIP=$T/clip.mp4 \
  exec "$DOTNET" "$DLL" serve > "$T/backend.log" 2>&1) & BP=$!
for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { bad "backend didn't start"; tail -15 "$T/backend.log"; exit 1; }
U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done

cat > "$T/drive.mjs" <<'EOF'
import fs from "node:fs";
const { U, T } = process.env, LINGER = +process.env.LINGER, BEAT = +process.env.BEAT;
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
let presStatus = 0;
const presence = async (showing) => { presStatus = (await fetch(U + "/steam/app-presence", { method: "POST", headers: H, body: JSON.stringify({ showing }) })).status; };
// the page's heartbeat while the Workshop shows (every BEAT / 4)
let beating = null;
const beat = (on) => { clearInterval(beating); beating = null; if (on) { presence(true); beating = setInterval(() => presence(true), BEAT / 4); } };

// a. on Browse with nothing downloaded: no connection
beat(true); await sleep(1500);
out(opens().length === 0 && !(await connected()) && presStatus === 200, "a. the Workshop showing, nothing downloaded: no Steam connection",
  `presence ${presStatus}, ${opens().length} children connected, appConnected ${await connected()}`);

// b. downloads on Browse: one child for all of them, held while the UI beats
const rb = [await download("720000001"), await download("720000002"), ...(await Promise.all([download("720000003"), download("720000004")]))];
const pidB = childPid();
out(rb.every((s) => s === 200) && opens().length === 1 && users().length === 1 && users()[0] === String(pidB),
  "b. four downloads (two at once) while the Workshop shows: one child served them all", `statuses ${rb}, children ${opens()}, used by ${users()}`);
await sleep(LINGER + 1000);
out(alive(pidB) && await connected() && opens().length === 1, "b. …and stays connected past the linger while the UI beats",
  `alive ${alive(pidB)}, appConnected ${await connected()}`);

// c. leave, come back inside the linger: still the same child after the linger would have ended
beat(false); await presence(false); const tLeft = Date.now();
await sleep(LINGER / 2);
const midLinger = alive(pidB);
beat(true);
await sleep(Math.max(0, tLeft + LINGER + 1500 - Date.now()));
out(midLinger && alive(pidB) && opens().length === 1 && await connected(), "c. left, back within the linger: the linger cancelled, the same child held",
  `mid-linger alive ${midLinger}, now alive ${alive(pidB)}, children ${opens().length}`);

// d. leave for good: released after the linger, not before
const rel0 = lines("released").length;
beat(false); await presence(false); const tD = Date.now();
await sleep(LINGER - 800);
const early = alive(pidB);
const gone = await until(() => !alive(pidB), 8000);
const dt = Date.now() - tD, rel = lines("released").slice(rel0);
out(early && gone !== null && dt >= LINGER - 300 && rel.includes("user") && rel.includes("pipe") && !(await connected()),
  "d. left for good: the child released Steam (user + pipe) and exited once the linger was over",
  `alive at ${LINGER - 800} ms ${early}, gone after ${dt} ms (linger ${LINGER}), released [${rel}], appConnected ${await connected()}`);

// e. the page stops beating without a word: heartbeat timeout, then the linger
beat(true); const re = await download("720000005"); const pidE = childPid();
beat(false); const tE = Date.now(); // the last beat went out just now
await sleep(BEAT - 1000);
const eHeld = alive(pidE);
await until(() => !alive(pidE), BEAT + LINGER + 6000);
const dE = Date.now() - tE;
out(re === 200 && pidE !== pidB && eHeld && !alive(pidE) && dE >= BEAT + LINGER - 1500 && dE < BEAT + LINGER + 5000,
  "e. no heartbeat: counted as left after the timeout, released after the linger",
  `download ${re}, new child ${pidE !== pidB}, alive at ${BEAT - 1000} ms ${eHeld}, gone after ${dE} ms (timeout ${BEAT} + linger ${LINGER})`);

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

fs.writeFileSync(`${T}/held.pid`, String(childPid()));
fs.writeFileSync(`${T}/released.before`, String(lines("released").length));
beat(false);
EOF
(cd "$T" && U=$U T=$T LINGER=$LINGER BEAT=$BEAT timeout 300 node drive.mjs) > "$T/drive.log" 2>&1; rc=$?
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
