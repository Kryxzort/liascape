#!/usr/bin/env bash
# Hermetic test of the Browse sidebar's Workshop community pieces (Web/WorkshopSocialOps.cs over Helpers/SteamCommunity.cs)
# and Browse's Workshop lists (Services/SteamWorkshopService.cs ListAsync: a creator's, a scene's presets), the details cache
# and the signed-in account's favourites cache (Helpers/WorkshopDetailsCache.cs, WorkshopFavorites.cs): a private backend
# whose steamcommunity.com and api.steampowered.com are a fake server (scripts/test-fixtures/fake-steam-community.mjs;
# LIASCAPE_STEAM_COMMUNITY / LIASCAPE_STEAM_API) and whose Steam client-protocol answers are a fixture file
# (LIASCAPE_STEAM_CM_FIXTURE), all in its own network namespace (`unshare -rnm` + `scripts/test-netns.sh`: loopback only — nothing can reach Steam;
# no real favourite, no real comment).
#  1. signed out: the creator's name + avatar (profile XML, markup stripped, read once per run; the creator of an item
#     without one asked of the client protocol); the favourite state "signed out" with no request; favourite and post → 403
#     {signIn} with nothing sent; the comment thread (newest first, paged, total) as plain text — no script, no handler, an
#     entity decoded once, a line break kept, an emoticon by name — sent without any cookie; /workshop/my-favorites →
#     {signedIn:false} with nothing sent.
#  1b. an item's counts (/workshop/counts, the Library sidebar's stat pills): Steam's CURRENT subscriber / favourite counts
#     from the client protocol (not the lifetime ones); one GetDetails per item however many asks (the counts and the creator
#     at once, again later); no such item → 404, a bad id → 400, Steam unreachable → 502 and asked again once it answers.
#  2. a creator's items (/browse `list`): the client protocol's user files, the CURRENT subscriber / favourite counts (not the
#     lifetime ones), web / application items left out, paged 100 at a time to the end, top rated → Steam's "score" order,
#     the filter's tags matched.
#  3. signed in (a pasted cookie, file secret store): the favourite state read from the item page with the cookie (toggled →
#     true), favourite / unfavourite (the cookie + a matching sessionid pair, id + appid), a comment posted (the new one on top,
#     its text back as typed), an empty / too-long comment refused without a request, /workshop/my-favorites (the client
#     protocol's list; a /browse list of kind "favorites" is the whole Workshop), a private profile's favourites from the
#     community page + the items' details (current counts again);
#     the cookie's token in no log line and not in settings.json; every request with the Firefox User-Agent.
#  4. Steam's 429: the comments answer 429 "try again in N min", the cooldown file is written and the next read sends nothing.
#  5. a scene's presets (/browse `list` kind "presets", QueryFiles' child lookup; the player is a
#     stub binary that never runs): exactly the presets naming it (a web-based one left out), paged 100 at a time, sorted
#     as asked; the whole Workshop's default list holds none, Preset ticked holds only presets; a preset's base
#     (/workshop/base: Steam's one child, its title and kind, the library's folder, one GetDetails per item; 404 / 400);
#     scene support off → no presets; a legacy settings file's PlayerEngine changes nothing.
#  6. the shared Workshop details cache (POST /workshop/details, Helpers/WorkshopDetailsCache.cs): the found items in the
#     asked order with their created time and score, the missing ones in one GetDetails, a second ask sends nothing (an id
#     Steam has none of remembered for the run, not on disk), kept in $XDG_CACHE_HOME/liascape/workshop/details.json (saves
#     at most once a second), Steam unreachable → only what's cached, 2001 ids / a non-digit id → 400 with nothing asked, a
#     Library sidebar's counts refresh a cached copy (an uncached one isn't added); after a restart the same ask sends nothing.
#  7. the signed-in account's favourites cache (GET /workshop/my-favorites, Helpers/WorkshopFavorites.cs), on a backend
#     without § 4's cooldown: signed out → {signedIn:false} with nothing asked; Steam gone between page 1 and page 2 of a
#     first load → the error line, page 1's items kept, nothing written; the first load streamed as `workshop-favorites`
#     events (no ids in them) up to 250, then 248 items (web left out) in Steam's order with their created times, the
#     creator's name only when this run already read it; no Steam ID or item id in the log; sync=none and a restart ask
#     nothing; another account sees none of these, signed out again → {signedIn:false}; a private profile → the community
#     pages with the cookie (3 of them for 65 ids), then the items' details in one GetDetails; a sign-in switched to
#     another account between two of those pages → no page asked as it, none of its favourites kept, nothing written.
#     Keeping it current: sync=check with no whole list asks nothing; the count check (sync=check, at most once per 50 s)
#     asks the total alone and diffs only on a change; sync=open diffs the ids (one ids-only ask, the details of the new id
#     alone); a star / unstar set in Liascape changes the list at once (an event, no Steam call to read it, the new item's
#     details in the background) and holds against a later diff whose Steam answer lacks it; a private profile's check
#     reads page 1 only, and a grown page 1 → the pages again, with any listed id still missing its details asked again;
#     a 200 page that isn't the favourites page (a login page as page 1, a blank page 2) is no answer: the list is kept.
#     Every favourite removed on Steam: a private list (the count check's page 1, then the diff) and a public one (no ids,
#     then the community page) empty on the account's own empty favourites page, written; a failed read before each (Steam's
#     error page or login page, a 429, the client protocol not answering) keeps the list.
#     The list's file is 0600; a restarted backend's version counts above the last run's; a diff keeps Steam's own total
#     (a count check right after finds no change); a private profile read whole lately gets the page-1 check on a visit.
# Never touches ~/.config/liascape or the real library; everything it started is stopped on exit.
#
# Usage: scripts/test-workshop-social.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
#   LIASCAPE_KEEP_TMP=1 keeps the temp folder; a failed run keeps only its logs / screenshots and prints where (last line).
# Needs: dotnet (or DOTNET=…), node, unshare + ip (iproute2), curl, jq. Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
. "$ROOT/scripts/test-tmp.sh"   # lp_tmp_done: the temp folder goes on exit; LIASCAPE_KEEP_TMP=1 keeps it
if [ -z "${LIASCAPE_SOCIAL_T:-}" ]; then
  . "$ROOT/scripts/test-lock.sh" # one heavy test run at a time on this machine
  BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
  DOTNET=${DOTNET:-$(command -v dotnet || true)}
  [ -n "$DOTNET" ] || { echo "dotnet not found — set DOTNET=/path/to/dotnet"; exit 2; }
  for t in node unshare ip curl jq timeout; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
  DLL=${LIASCAPE_BACKEND_DLL:-$ROOT/src/backend/bin/Debug/net10.0/liascape-backend.dll}
  if [ $BUILD = 1 ] && [ -z "${LIASCAPE_BACKEND_DLL:-}" ]; then
    "$DOTNET" build "$ROOT/src/backend" -nologo -v q 2>&1 | grep -E " error |Build succeeded" | sort -u
    [ ${PIPESTATUS[0]} = 0 ] || { echo "dotnet build failed"; exit 2; }
  fi
  [ -f "$DLL" ] || { echo "not built: $DLL (drop --no-build)"; exit 2; }
  T=$(mktemp -d /tmp/liascape-social-XXXXXX)
  mkdir -p "$T/backend"; cp -a "$(dirname "$DLL")/." "$T/backend/" || { echo "ABORT: can't copy the backend build"; exit 2; }
  cleanup() { rc=$?; trap - EXIT INT TERM HUP; lp_tmp_done "$T" /tmp/liascape-social- "$rc"; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  export DOTNET LIASCAPE_SOCIAL_T=$T
  timeout -k 10 300 unshare -rnm bash "$ROOT/scripts/test-netns.sh" "$T" bash "${BASH_SOURCE[0]}"
  exit $?
fi

T=$LIASCAPE_SOCIAL_T
DLL=$T/backend/liascape-backend.dll
BP=""; FP=""
stopall() {
  for p in $BP $FP; do kill "$p" 2>/dev/null; done
  for p in $BP $FP; do for _ in $(seq 1 30); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done; kill -9 "$p" 2>/dev/null; done
  BP=""; FP=""
}
trap stopall EXIT
trap 'exit 130' INT TERM HUP
unset LD_LIBRARY_PATH WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK LIASCAPE_UI_DIR LIASCAPE_PORT LIASCAPE_PLAYER_SOCKET LIASCAPE_WORKSHOP_FALLBACK
H=$T/home
mkdir -p "$H/.config/liascape" "$H/.cache" "$H/.local/share" "$H/rt" "$H/st"
export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_CACHE_HOME=$H/.cache XDG_DATA_HOME=$H/.local/share XDG_RUNTIME_DIR=$H/rt XDG_STATE_HOME=$H/st
export DBUS_SESSION_BUS_ADDRESS=unix:path=$T/no-bus LIASCAPE_SECRETS=file DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

# a made-up account: its Steam ID and the token half of its cookie (never a real one)
ME=76561198000000042
TOKEN=fake-community-token-$RANDOM$RANDOM
OWNER=76561198000000007
export ME TOKEN OWNER T

# the client protocol's answers: two items' creators, a creator's 130 files (the first 20 web / application ones Browse
# leaves out; every 3rd one Anime; scores rising with the index, so "score" reverses the order) and the signed-in account's
# 2 favourites — Steam's own field names, current counts beside lifetime ones that must not be shown
node -e '
const [ME, OWNER] = [process.env.ME, process.env.OWNER];
const item = (i, extra = {}) => ({ publishedfileid: String(3200000000 + i), title: `made-${i}`, preview_url: `https://images.example.invalid/${i}.jpg`,
  creator: OWNER, file_size: 1000 + i, time_updated: 1780000000 - i, subscriptions: 692, lifetime_subscriptions: 876, favorited: 34,
  lifetime_favorited: 35, views: 100, score: i / 1000,
  tags: [i < 10 ? "Web" : i < 20 ? "Application" : i % 2 ? "Scene" : "Video", ...(i % 3 === 0 ? ["Anime"] : []), "1920 x 1080"], ...extra });
const counts = { subscriptions: 692, lifetime_subscriptions: 876, favorited: 34, lifetime_favorited: 35 };
const fx = { "3000000001": { tags: ["Video"], creator: OWNER, ...counts }, "3000000002": { tags: ["Video"], creator: OWNER },
  "3000000003": { tags: ["Video"], creator: OWNER, ...counts }, "3000000004": { tags: ["Video"], creator: OWNER, ...counts },
  "@userfiles": { [`${OWNER}:myfiles`]: Array.from({ length: 130 }, (_, i) => item(i)),
                  [`${ME}:myfavorites`]: [item(500, { title: "fav-a" }), item(501, { title: "fav-b" })] },
  // the whole Workshop (QueryFiles): a video, a scene, its two presets (Steam tags a preset Preset + the type of its base), a
  // video-based preset, a web-based preset of the scene (never listed), and a second scene with 150 presets
  "@query": [
    { publishedfileid: "1001", title: "q-video", tags: ["Video"] }, { publishedfileid: "1003", title: "Query Scene", tags: ["Scene"] },
    { publishedfileid: "2001", title: "preset-a", tags: ["Preset", "Scene"], children: ["1003"] },
    { publishedfileid: "2002", title: "preset-b", tags: ["Preset", "Scene"], children: ["1003"] },
    { publishedfileid: "2003", title: "preset-of-video", tags: ["Preset", "Video"], children: ["1001"] },
    { publishedfileid: "2004", title: "preset-web", tags: ["Preset", "Web"], children: ["1003"] },
    { publishedfileid: "1004", title: "busy scene", tags: ["Scene"] },
    ...Array.from({ length: 150 }, (_, i) => ({ publishedfileid: String(4000 + i), title: `busy-preset-${i}`, tags: ["Preset", "Scene"], children: ["1004"] }))] };
fx["2001"] = { tags: ["Preset", "Scene"], title: "preset-a", children: ["1003"] };
fx["1003"] = { tags: ["Scene"], title: "Query Scene" };
fx["1001"] = { tags: ["Video"], title: "q-video" };
// the details cache (§ 6): Steam field names, created times and vote scores
fx["5001"] = { tags: ["Video"], title: "d-5001", time_created: 1700000001, score: 0.75, preview_url: "https://images.example.invalid/5001.jpg", subscriptions: 10 };
fx["5002"] = { tags: ["Scene"], title: "d-5002", time_created: 1700000002, score: 0.5, preview_url: "https://images.example.invalid/5002.jpg" };
fx["5003"] = { tags: ["Video"], title: "d-5003", time_created: 1700000003, score: 0.25, preview_url: "https://images.example.invalid/5003.jpg" };
require("fs").writeFileSync(process.env.T + "/steam-cm.json", JSON.stringify(fx));'
export LIASCAPE_STEAM_CM_FIXTURE=$T/steam-cm.json

PASS=0; FAIL=0
node "$ROOT/scripts/test-fixtures/fake-steam-community.mjs" "$T/fake.port" "$ME" "$TOKEN" > "$T/fake.log" 2>&1 & FP=$!
for _ in $(seq 1 50); do [ -s "$T/fake.port" ] && break; sleep 0.1; done
[ -s "$T/fake.port" ] || { echo "FAIL  the fake community server didn't start"; cat "$T/fake.log"; exit 1; }
export FAKE=http://127.0.0.1:$(cat "$T/fake.port")
# the player's binary is a stub: nothing here ever plays
mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 1\n' > "$T/bin/liascape-player"; chmod +x "$T/bin/liascape-player"
export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player
printf '{"NoAudio":true,"AllowScenes":true,"AutoAddWeWallpapersToLibrary":false}\n' > "$XDG_CONFIG_HOME/liascape/settings.json"
# the backend's log is appended to across a restart (§ 6 counts its GetDetails lines over both runs)
start_backend() {
  rm -f "$XDG_CONFIG_HOME/liascape/serve.port"
  (cd /tmp && LIASCAPE_STEAM_COMMUNITY=$FAKE LIASCAPE_STEAM_API=$FAKE exec "$DOTNET" "$DLL" serve >> "$T/backend.log" 2>&1) & BP=$!
  for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
  [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { echo "FAIL  backend didn't start"; tail -15 "$T/backend.log"; exit 1; }
  export U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
  for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done
}
stop_backend() {
  kill "$BP" 2>/dev/null
  for _ in $(seq 1 30); do kill -0 "$BP" 2>/dev/null || break; sleep 0.1; done; kill -9 "$BP" 2>/dev/null
}
start_backend

cat > "$T/drive.mjs" <<'EOF'
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const { U, FAKE, ME, TOKEN, OWNER, T } = process.env;
const TOKEN_API = fs.readFileSync(`${process.env.XDG_CONFIG_HOME}/liascape/serve.token`, "utf8").trim();
const H = { "X-Liascape-Token": TOKEN_API, "Content-Type": "application/json" };
const out = (ok, name, extra = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra && !ok ? " — " + extra : ""}`);
const get = async (p) => { const r = await fetch(U + p, { headers: H }); return { status: r.status, json: await r.json().catch(() => null) }; };
const post = async (p, b) => { const r = await fetch(U + p, { method: "POST", headers: H, body: JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const fakeLog = async () => (await fetch(FAKE + "/__log")).json();
const since = async (n0) => (await fakeLog()).slice(n0);
const J = JSON.stringify;
const ITEM = "3000000001";
const sources = (await get("/sources")).json;
const WS = sources.find((s) => s.supportsTagFilter).index;
const filter = (p = {}) => ({ sort: "trend", trendDays: 7, include: [], exclude: [], featureMatch: "all", genreMatch: "any", ...p });
const browse = (list, page = 1, f = filter()) => post("/browse", { source: WS, page, filter: f, list });
const wids = (x) => (Array.isArray(x.json) ? x.json.map((w) => w.workshopId) : []);
const blog = () => fs.readFileSync(`${T}/backend.log`, "utf8");
const count = (re) => (blog().match(new RegExp(re.source, "g")) ?? []).length;
const countIn = (s, re) => (s.match(new RegExp(re.source, "g")) ?? []).length;
const DF = `${process.env.XDG_CACHE_HOME}/liascape/workshop/details.json`;
const onDisk = () => { try { return JSON.parse(fs.readFileSync(DF, "utf8")); } catch { return null; } };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (f, ms = 4000) => { for (let t = 0; t < ms && !f(); t += 50) await sleep(50); return !!f(); };

if (process.argv[2] === "after-restart") {
  // ---- 6 (after a restart). the details cache read back from disk ----
  let before = count(/GetDetails of/);
  let r = await post("/workshop/details", { ids: ["5001", "5002"] });
  out(r.status === 200 && J(wids({ json: r.json?.items })) === J(["5001", "5002"]) && r.json.items[0].subscriptions === 99 && count(/GetDetails of/) === before,
    "details after a restart: the same ask sends nothing (read from disk, the sidebar's refreshed counts kept)", J({ r, asks: count(/GetDetails of/) - before }));
  before = count(/GetDetails of/);
  r = await post("/workshop/details", { ids: ["5001", "9999"] });
  out(r.status === 200 && J(wids({ json: r.json?.items })) === J(["5001"]) && count(/GetDetails of/) === before + 1 && count(/GetDetails of 1 id\(s\).*fixture: 9999\)/) === 1,
    "details after a restart: an id Steam had no public item for is asked again (remembered for a run, not on disk)", J({ r, asks: count(/GetDetails of/) - before }));
  process.exit(0);
}

// ---- 7. the signed-in account's favourites cache (three phases, a backend restart before each of the last two) ----
if (process.argv[2]?.startsWith("fav")) {
  const MODE = process.argv[2];
  const ME2 = "76561198000000043", OWNER2 = "76561198000000008";
  const FX = `${T}/steam-cm.json`;
  // 250 favourites in Steam's lastupdated order, 2 of them web (left out), 5 by a creator this run never reads
  const FAVS = Array.from({ length: 250 }, (_, i) => String(3200000500 + i));
  const WEB = new Set([150, 249]);
  const shown = FAVS.map((_, i) => i).filter((i) => !WEB.has(i)).map((i) => `fav-${i}`);
  // a private profile's 65 favourites (the community page's list) and their details
  const PRIV = Array.from({ length: 65 }, (_, i) => String(3300000000 + i));
  // another account's (ME2's) 40 favourites on its own community page
  const OTHER = Array.from({ length: 40 }, (_, i) => String(3400000000 + i));
  const FF = (id) => `${process.env.XDG_CACHE_HOME}/liascape/workshop/favorites-${id}.json`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const AUTH = `${process.env.XDG_CONFIG_HOME}/liascape/steam-auth.json`;
  const signIn = (id) => fs.writeFileSync(AUTH, J({ "steam-login-secure": `${id}||${TOKEN}` }), { mode: 0o600 });
  const signOut = () => fs.rmSync(AUTH, { force: true });
  const L0 = blog().length, logNow = () => blog().slice(L0);
  const favs = (sync = "none") => get(`/workshop/my-favorites?sync=${sync}`);
  const titles = (x) => (x.json?.items ?? []).map((w) => w.title);
  const waitAsync = async (f, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await f()) return true; await sleep(100); } return !!(await f()); };
  const evs = [];
  const ws = new WebSocket(U.replace("http", "ws") + "/events?token=" + encodeURIComponent(TOKEN_API));
  await new Promise((res) => { ws.onopen = res; ws.onerror = res; setTimeout(res, 3000); });
  ws.onmessage = (m) => { try { const e = JSON.parse(m.data); if (e.type === "workshop-favorites") evs.push(e.payload); } catch { } };

  if (MODE === "fav") {
    const fx = JSON.parse(fs.readFileSync(FX, "utf8"));
    fx["@userfiles"][`${ME}:myfavorites`] = FAVS.map((id, i) => ({ publishedfileid: id, title: `fav-${i}`, preview_url: `https://images.example.invalid/f${i}.jpg`,
      creator: i % 50 === 7 ? OWNER2 : OWNER, time_created: 1700000000 + i, time_updated: 1790000000 - i, subscriptions: 692, favorited: 34, score: 0.5,
      tags: [WEB.has(i) ? "Web" : "Video"] }));
    fs.writeFileSync(FX, J(fx));
    // a. signed out
    signOut();
    let n0 = (await fakeLog()).length;
    let r = await favs("open");
    await sleep(300);
    out(r.status === 200 && r.json?.signedIn === false && !("items" in r.json) && (await since(n0)).length === 0 && !/GetUserFiles myfavorites/.test(logNow()),
      "my-favorites signed out: {signedIn:false}, nothing asked", J(r));
    signIn(ME);
    // k. Steam gone mid-load: the fixture becomes a FIFO the test feeds, so page 1 reads the fixture and page 2 an empty
    // file (unreadable = Steam unreachable) exactly between the two
    fs.renameSync(FX, `${T}/steam-cm.real`);
    execFileSync("mkfifo", [FX]);
    const feed = fs.promises.writeFile(FX, fs.readFileSync(`${T}/steam-cm.real`));
    r = await favs("open");
    const fed = await Promise.race([feed.then(() => true), sleep(5000).then(() => false)]);
    const page1 = fed && waitFor(() => evs.some((e) => e.loading?.done === 100), 5000);
    const cut = (await page1) && await Promise.race([fs.promises.writeFile(FX, "").then(() => true), sleep(5000).then(() => false)]);
    // a write the backend never read (it didn't load) waits on the FIFO for ever: read it here so it ends
    if (!fed || !cut) { try { execFileSync("timeout", ["5", "sh", "-c", 'cat "$0" > /dev/null', FX]); } catch { } }
    fs.rmSync(FX, { force: true }); fs.renameSync(`${T}/steam-cm.real`, FX);
    await waitAsync(async () => (await favs()).json?.error);
    r = await favs();
    out(r.status === 200 && fed && cut && r.json?.error === "Couldn't load your favourites from Steam. Try again in a moment." && r.json.loading === null
      && titles(r).length === 100 && titles(r)[0] === "fav-0" && !fs.existsSync(FF(ME)),
      "first load cut off by Steam mid-load: the error line, page 1's items kept, no favorites-<id>.json written", J({ fed, cut, r: { ...r.json, items: titles(r).length } }));
    // the count check with no whole list: nothing (the first load is sync=open's, the user's own Browse)
    let Lc = blog().length;
    n0 = (await fakeLog()).length;
    r = await favs("check");
    await sleep(500);
    out(r.json?.signedIn === true && r.json.loading === null && !/GetUserFiles/.test(blog().slice(Lc)) && (await since(n0)).length === 0 && (await favs()).json?.loading === null,
      "sync=check with no whole list: nothing asked, no load started", J({ loading: r.json?.loading, log: blog().slice(Lc) }));
    // b. the first load again, streamed
    evs.length = 0;
    const L1 = blog().length;
    r = await favs("open");
    await waitFor(() => evs.at(-1)?.loading === null && evs.length > 1, 8000);
    r = await favs();
    const dones = evs.filter((e) => e.loading).map((e) => e.loading.done);
    out(evs.length >= 3 && evs.at(-1).loading === null && evs.some((e) => e.loading?.total === 250) && dones.every((d, i) => i === 0 || d >= dones[i - 1]) && dones.at(-1) === 250,
      "first load: progress streamed, rising to 250 of 250", J(evs));
    out(evs.length > 0 && evs.every((e) => J(Object.keys(e).sort()) === J(["loading", "version"])) && !evs.some((e) => /3200000|7656119/.test(J(e)))
      && evs.every((e, i) => i === 0 || e.version > evs[i - 1].version) && r.json?.version === evs.at(-1).version,
      "first load: the events carry a rising version and the progress, no ids", J(evs.slice(-2)));
    out(r.json?.signedIn === true && r.json.error === null && r.json.loading === null && J(titles(r)) === J(shown) && r.json.items.every((w) => w.createdAt),
      "first load: the list, web left out (248 in Steam's order, with created times)", J({ n: titles(r).length, first: titles(r).slice(0, 3), e: r.json?.error }));
    const saved = readJson(FF(ME));
    out(J(saved?.ids) === J(FAVS) && saved.viaPage === false && saved.total === 250, "first load: the whole list kept on disk ({ids, viaPage, total})", J(saved && { n: saved.ids?.length, v: saved.viaPage, t: saved.total }));
    const mode = fs.existsSync(FF(ME)) ? (fs.statSync(FF(ME)).mode & 0o777).toString(8) : null;
    out(mode === "600", "first load: the list's file is the user's alone (0600)", J({ mode }));
    out(!logNow().includes(ME) && !FAVS.some((id) => logNow().includes(id)) && /GetUserFiles myfavorites sort=lastupdated page 3/.test(blog().slice(L1)),
      "first load: no Steam ID or item ID in the log", J(logNow().split("\n").filter((l) => l.includes(ME) || /32000005/.test(l)).slice(0, 3)));
    // the creator's name: one this run already read (the sidebar's creator), never a profile read for the list
    await get(`/workshop/creator?id=${FAVS[0]}&owner=${OWNER}`);
    n0 = (await fakeLog()).length;
    r = await favs();
    const byTitle = Object.fromEntries((r.json?.items ?? []).map((w) => [w.title, w]));
    out(byTitle["fav-0"]?.authorName === `Creator Bold ${OWNER.slice(-2)}` && byTitle["fav-7"] && byTitle["fav-7"].authorName == null && (await since(n0)).length === 0,
      "authorName: a creator this run read by name, another null, no profile read for it", J([byTitle["fav-0"]?.authorName, byTitle["fav-7"]?.authorName]));
    // c. sync=none: nothing asked
    n0 = (await fakeLog()).length;
    const L2 = blog().length;
    r = await favs("none");
    await sleep(300);
    out(J(titles(r)) === J(shown) && (await since(n0)).length === 0 && !/GetUserFiles|GetDetails/.test(blog().slice(L2)),
      "sync=none: the cached list, no Steam call", J({ n: titles(r).length, log: blog().slice(L2) }));
    // f (no change). the count check, Steam's count unchanged: the total alone, no diff
    Lc = blog().length;
    r = await favs("check");
    await waitFor(() => /count check/.test(blog().slice(Lc)), 4000);
    await sleep(300);
    out(countIn(blog().slice(Lc), /GetUserFiles myfavorites total-only/) === 1 && /count check: no change/.test(blog().slice(Lc)) && !/ids-only|GetUserFiles myfavorites sort=/.test(blog().slice(Lc))
      && J(titles(await favs())) === J(shown),
      "sync=check, Steam's count unchanged: one total-only ask, no diff", J({ log: blog().slice(Lc) }));
    // what an open page holds now: the next phase's restarted backend must count above it
    fs.writeFileSync(`${T}/fav-version`, String((await favs()).json?.version ?? ""));
    process.exit(0);
  }

  if (MODE === "fav-total") {
    // a page left open across a backend restart drops any read older than its copy: the new run's version must be higher
    const before = Number(fs.readFileSync(`${T}/fav-version`, "utf8"));
    let r = await favs("none");
    out(r.json?.signedIn === true && before > 0 && r.json.version > before, "after a backend restart: the version read is above the one read before it",
      J({ before, after: r.json?.version }));
    // Steam's total above the ids it lists (an item it counts but shows no one): a diff keeps Steam's total, so the count
    // check right after compares like with like and finds no change
    const fx = JSON.parse(fs.readFileSync(FX, "utf8"));
    fx["@userfilestotal"] = { [`${ME}:myfavorites`]: 251 };
    fs.writeFileSync(FX, J(fx));
    let L = blog().length;
    await favs("open");
    await waitFor(() => /id diff (done|stopped)/.test(blog().slice(L)), 8000);
    const total = readJson(FF(ME))?.total;
    L = blog().length;
    await favs("check");
    await waitFor(() => /count check/.test(blog().slice(L)), 4000);
    await sleep(300);
    const le = blog().slice(L);
    out(total === 251 && /count check: no change/.test(le) && !/ids-only/.test(le) && J(titles(await favs())) === J(shown),
      "a diff keeps Steam's own total: the count check right after finds no change (a total of 251 over 250 listed ids)",
      J({ total, log: le.split("\n").filter((l) => /steam-cm|count check/.test(l)) }));
    delete fx["@userfilestotal"];
    fs.writeFileSync(FX, J(fx));
    process.exit(0);
  }

  if (MODE === "fav-restart") {
    // d. after a restart: the list and its details read back from disk
    const n0 = (await fakeLog()).length;
    let r = await favs("none");
    await sleep(300);
    out(r.json?.signedIn === true && J(titles(r)) === J(shown) && r.json.items.every((w) => w.createdAt) && (await since(n0)).length === 0 && !/GetUserFiles|GetDetails/.test(logNow()),
      "after a backend restart: the same items, no Steam call", J({ n: titles(r).length, log: logNow().split("\n").filter((l) => /steam-cm/.test(l)) }));
    // e. Steam's list changed at the same count (an old favourite back at the end, fav-10 gone): sync=open diffs the ids
    const OLD = "3200000900", STAR = "3200000901";
    let fx = JSON.parse(fs.readFileSync(FX, "utf8"));
    let list = fx["@userfiles"][`${ME}:myfavorites`];
    list.splice(10, 1);
    list.push({ publishedfileid: OLD, title: "fav-old", time_created: 1600000000, time_updated: 1600000000, tags: ["Video"], creator: OWNER });
    fx[OLD] = { tags: ["Video"], title: "fav-old", time_created: 1600000000, creator: OWNER };
    fx[STAR] = { tags: ["Video"], title: "fav-new", time_created: 1600000001, creator: OWNER };
    fs.writeFileSync(FX, J(fx));
    let want = shown.filter((t) => t !== "fav-10").concat("fav-old");
    let L = blog().length;
    evs.length = 0;
    r = await favs("open");
    await waitAsync(async () => J(titles(await favs())) === J(want));
    await sleep(300);
    r = await favs();
    let le = blog().slice(L), saved = readJson(FF(ME));
    out(J(titles(r)) === J(want) && countIn(le, /GetUserFiles myfavorites ids-only page 1 /) === 1 && !/GetUserFiles myfavorites sort=/.test(le)
      && countIn(le, /GetDetails of/) === 1 && countIn(le, /GetDetails of 1 id\(s\)/) === 1 && evs.length >= 1
      && saved?.ids?.at(-1) === OLD && !saved.ids.includes(FAVS[10]) && saved.ids.length === 250,
      "sync=open with a cached list: one ids-only ask, only the new id's details (one GetDetails of 1 id), the list in Steam's new order, kept on disk",
      J({ n: titles(r).length, last: titles(r).slice(-2), log: le.split("\n").filter((l) => /steam-cm/.test(l)), saved: saved && saved.ids?.length }));
    // f. Steam's count changed (fav-20 gone too): the count check (twice in a row) asks the total once, then diffs
    fx = JSON.parse(fs.readFileSync(FX, "utf8"));
    list = fx["@userfiles"][`${ME}:myfavorites`];
    list.splice(list.findIndex((x) => x.publishedfileid === FAVS[20]), 1);
    fs.writeFileSync(FX, J(fx));
    want = want.filter((t) => t !== "fav-20");
    L = blog().length;
    await favs("check");
    await favs("check");
    await waitAsync(async () => J(titles(await favs())) === J(want));
    await favs("check");
    await sleep(300);
    r = await favs();
    le = blog().slice(L);
    out(J(titles(r)) === J(want) && countIn(le, /GetUserFiles myfavorites total-only/) === 1 && countIn(le, /GetUserFiles myfavorites ids-only page 1 /) === 1
      && /count check: changed/.test(le) && readJson(FF(ME))?.total === 249,
      "sync=check twice in a row (and once after): one total-only ask; the count changed → one ids diff, the item gone",
      J({ n: titles(r).length, log: le.split("\n").filter((l) => /steam-cm|count check/.test(l)) }));
    // g. a star set in Liascape: in the list at once (written, an event), first; its details fetched in the background
    // (another event); read with sync=none, no Steam call
    L = blog().length;
    evs.length = 0;
    const n1 = (await fakeLog()).length;
    r = await post("/workshop/favorite", { workshopId: STAR, favorite: true });
    const atOnce = readJson(FF(ME))?.ids?.[0] === STAR;
    const ev1 = evs.length;
    await waitFor(() => evs.length >= 2, 4000);
    await waitFor(() => /GetDetails of 1 id/.test(blog().slice(L)), 4000);
    const L4 = blog().length, n2 = (await fakeLog()).length;
    let rs = await favs("none");
    await sleep(300);
    out(r.status === 200 && r.json?.favorited === true && atOnce && titles(rs)[0] === "fav-new" && titles(rs).length === want.length + 1
      && J((await since(n1)).map((x) => x.path)) === J(["/sharedfiles/favorite"]) && (await since(n2)).length === 0 && !/GetUserFiles|GetDetails/.test(blog().slice(L4))
      && countIn(blog().slice(L), /GetDetails of 1 id/) === 1 && evs.length >= 2,
      "a star set in Liascape: first in the list at once (on disk, a workshop-favorites event), its details in the background (another event), read with no Steam call",
      J({ status: r.status, atOnce, ev1, evs: evs.length, first: titles(rs).slice(0, 2), fake: (await since(n1)).map((x) => x.path) }));
    out(!blog().slice(L).split("\n").filter((l) => !/\(fixture/.test(l)).some((l) => l.includes(STAR) || l.includes(ME)),
      "a star set in Liascape: no Steam ID or item ID in the log", J(blog().slice(L).split("\n").filter((l) => l.includes(STAR)).slice(0, 3)));
    // Review Focus: a diff that starts after the star, Steam's (cached) answer still without it → the star stays
    L = blog().length;
    await favs("open");
    await waitFor(() => /id diff done/.test(blog().slice(L)), 4000);
    rs = await favs();
    out(/ids-only page 1 /.test(blog().slice(L)) && titles(rs)[0] === "fav-new" && readJson(FF(ME))?.ids?.[0] === STAR,
      "a star set in Liascape: a later diff whose Steam answer lacks it keeps it", J({ first: titles(rs).slice(0, 2), log: blog().slice(L) }));
    // h. an unstar set in Liascape: gone at once, and a later diff whose Steam answer still lists it keeps it gone
    evs.length = 0;
    r = await post("/workshop/favorite", { workshopId: FAVS[1], favorite: false });
    rs = await favs("none");
    const goneAtOnce = r.json?.favorited === false && !titles(rs).includes("fav-1") && titles(rs).length === want.length && evs.length >= 1;
    L = blog().length;
    await favs("open");
    await waitFor(() => /id diff done/.test(blog().slice(L)), 4000);
    rs = await favs();
    out(goneAtOnce && /ids-only page 1 /.test(blog().slice(L)) && !titles(rs).includes("fav-1") && !readJson(FF(ME))?.ids?.includes(FAVS[1]),
      "an unstar set in Liascape: gone at once (an event), and a later diff whose Steam answer still lists it keeps it gone",
      J({ goneAtOnce, evs: evs.length, has: titles(rs).includes("fav-1") }));
    // j. another account: none of these; signed out again: nothing
    signIn(ME2);
    r = await favs("none");
    const other = (x) => (x.json?.items ?? []).filter((w) => FAVS.includes(w.workshopId)).length;
    const r1 = r;
    r = await favs("open");
    await waitAsync(async () => (await favs()).json?.loading === null);
    const r2 = await favs();
    out(r1.json?.signedIn === true && r1.json.items?.length === 0 && other(r) === 0 && r2.json?.signedIn === true && other(r2) === 0 && r2.json.items.length === 0,
      "another account: none of the first account's favourites, before or after its own load", J([r1.json, r2.json]));
    signOut();
    r = await favs("open");
    out(r.json?.signedIn === false && !("items" in r.json), "signed out again: {signedIn:false}, no list", J(r.json));
    // set up the private profile: the account's list gone from the client protocol, 65 on its community page; no cached list
    signIn(ME);
    fx = JSON.parse(fs.readFileSync(FX, "utf8"));
    delete fx["@userfiles"][`${ME}:myfavorites`];
    PRIV.forEach((id, i) => { fx[id] = { tags: ["Video"], title: `pfav-${i}`, time_created: 1700000000 + i, creator: OWNER }; });
    OTHER.forEach((id, i) => { fx[id] = { tags: ["Video"], title: `other-${i}`, time_created: 1700000000 + i, creator: OWNER }; });
    fs.writeFileSync(FX, J(fx));
    await fetch(`${FAKE}/__myfavs`, { method: "POST", body: J({ steamid: ME2, ids: OTHER }) });
    // the account's page 1 waits for the test's /__release (the switch below)
    await fetch(`${FAKE}/__myfavs`, { method: "POST", body: J({ ids: PRIV, hold: 1 }) });
    fs.rmSync(FF(ME), { force: true });
    process.exit(0);
  }

  if (MODE === "fav-private") {
    // the sign-in switches to another account while the first load reads the community pages: page 1 is held until the
    // test has signed in as ME2, so the next page would go out with ME2's cookie
    let n0 = (await fakeLog()).length;
    await favs("open");
    const held = await waitAsync(async () => (await since(n0)).some((x) => x.path === `/profiles/${ME}/myworkshopfiles/` && x.query.p === "1"));
    signIn(ME2);
    await fetch(`${FAKE}/__release`);
    await waitFor(() => evs.at(-1)?.loading === null, 8000);
    const asked = (await since(n0)).map((x) => x.path);
    signIn(ME);
    const rs = await favs();
    out(held && evs.at(-1)?.loading === null && !fs.existsSync(FF(ME)) && !asked.includes(`/profiles/${ME2}/myworkshopfiles/`) && rs.json?.signedIn === true
      && !(rs.json.items ?? []).some((w) => OTHER.includes(w.workshopId)) && rs.json.error,
      "a sign-in switched mid-load: no page asked as the other account, none of its favourites in this account's list, nothing written",
      J({ held, asked, file: fs.existsSync(FF(ME)), err: rs.json?.error, other: (rs.json?.items ?? []).filter((w) => OTHER.includes(w.workshopId)).length }));
    // i. a private profile: the community pages with the cookie, then the details in one GetDetails
    evs.length = 0;
    n0 = (await fakeLog()).length;
    let r = await favs("open");
    await waitFor(() => evs.at(-1)?.loading === null, 8000);
    r = await favs();
    const pages = (await since(n0)).filter((x) => x.path === `/profiles/${ME}/myworkshopfiles/`);
    out(J(titles(r)) === J(PRIV.map((_, i) => `pfav-${i}`)) && pages.length === 3 && pages.every((x) => x.signedIn) && J(pages.map((x) => x.query.p)) === J(["1", "2", "3"])
      && /GetDetails of 65 id\(s\)/.test(logNow()),
      "private profile: 3 community pages with the cookie, the 65 items' details via GetDetails, in the page's order", J({ n: titles(r).length, pages: pages.map((x) => [x.query.p, x.signedIn]) }));
    out(evs.some((e) => e.loading?.total === null && e.loading.done === 30) && evs.some((e) => e.loading?.total === 65) && evs.at(-1)?.loading === null,
      "private profile: progress 'so far' while paging, then of 65 for the details", J(evs));
    const saved = readJson(FF(ME));
    out(J(saved?.ids) === J(PRIV) && saved.viaPage === true, "private profile: the list kept on disk as viaPage", J(saved && { n: saved.ids?.length, v: saved.viaPage }));
    out(pages.length > 0 && !logNow().includes(ME), "private profile: no Steam ID in the log", J(logNow().split("\n").filter((l) => l.includes(ME)).slice(0, 3)));
    // the count check of a private profile: page 1 alone (Background: after the gate's quiet time), compared with the list
    n0 = (await fakeLog()).length;
    const Lc = blog().length;
    await favs("check");
    await waitFor(() => /count check/.test(blog().slice(Lc)), 25000);
    const asked1 = (await since(n0)).filter((x) => x.path === `/profiles/${ME}/myworkshopfiles/`);
    out(asked1.length === 1 && asked1[0].query.p === "1" && asked1[0].signedIn && /count check: no change/.test(blog().slice(Lc)) && J(titles(await favs())) === J(PRIV.map((_, i) => `pfav-${i}`)),
      "private profile: sync=check reads page 1 only (one myworkshopfiles request), no change", J({ asked: asked1.map((x) => x.query.p), log: blog().slice(Lc) }));
    // two quick visits to Browse after that whole read: the page-1 check (held by its 50 s: one just ran), never the
    // community pages again
    n0 = (await fakeLog()).length;
    const Lo = blog().length;
    await favs("open");
    await favs("open");
    await waitFor(() => countIn(blog().slice(Lo), /the page-1 check instead/) === 2 || /id diff (done|stopped)/.test(blog().slice(Lo)), 20000);
    await sleep(500);
    const asked2 = (await since(n0)).filter((x) => x.path === `/profiles/${ME}/myworkshopfiles/`);
    out(asked2.length === 0 && countIn(blog().slice(Lo), /the page-1 check instead/) === 2 && !/id diff/.test(blog().slice(Lo)),
      "private profile: two quick sync=open after a whole read → no community page asked again (the page-1 check instead, held by its 50 s)",
      J({ asked: asked2.map((x) => x.query.p), log: blog().slice(Lo).split("\n").filter((l) => /workshop-favorites|community/.test(l)) }));
    // the next phase (a restarted backend, so its count check isn't held off): a favourite new on page 1
    const fx = JSON.parse(fs.readFileSync(FX, "utf8"));
    fx["3300000999"] = { tags: ["Video"], title: "pfav-new", time_created: 1700000999, creator: OWNER };
    fs.writeFileSync(FX, J(fx));
    await fetch(`${FAKE}/__myfavs`, { method: "POST", body: J({ ids: ["3300000999", ...PRIV] }) });
    process.exit(0);
  }

  if (MODE === "fav-private-grow") {
    // an id listed without details (a details fetch that failed during a load): pfav-5 taken out of the details cache
    // before this run reads it (the cache file is read on first use)
    const dc = readJson(DF);
    delete dc[PRIV[5]];
    fs.writeFileSync(DF, J(dc));
    let r = await favs("none");
    const hidden = r.json?.items?.length === 64 && !titles(r).includes("pfav-5");
    const n0 = (await fakeLog()).length;
    await favs("check");
    await waitAsync(async () => { const t = titles(await favs()); return t[0] === "pfav-new" && t.includes("pfav-5"); }, 30000);
    r = await favs();
    const pages = (await since(n0)).filter((x) => x.path === `/profiles/${ME}/myworkshopfiles/`);
    const saved = readJson(FF(ME));
    out(hidden && /count check: changed/.test(logNow()) && J(pages.map((x) => x.query.p)) === J(["1", "2", "3"]) && pages.every((x) => x.signedIn)
      && J(titles(r)) === J(["pfav-new", ...PRIV.map((_, i) => `pfav-${i}`)]) && J(saved?.ids) === J(["3300000999", ...PRIV]) && saved.viaPage === true,
      "private profile: a grown page 1 → the community pages again (page 1 not asked twice), the new favourite first, kept on disk",
      J({ hidden, pages: pages.map((x) => x.query.p), n: titles(r).length, first: titles(r).slice(0, 2) }));
    out(hidden && countIn(logNow(), /GetDetails of 2 id\(s\)/) === 1 && countIn(logNow(), /GetDetails of/) === 1 && titles(r).includes("pfav-5"),
      "private profile: the diff asks the details of every listed id still missing them (the new one and pfav-5, one GetDetails of 2)",
      J({ hidden, log: logNow().split("\n").filter((l) => /GetDetails/.test(l)) }));
    out(!logNow().split("\n").filter((l) => !/\(fixture/.test(l)).some((l) => l.includes(ME) || l.includes("3300000999")),
      "private profile diff: no Steam ID or item ID in the log", J(logNow().split("\n").filter((l) => l.includes(ME)).slice(0, 3)));
    process.exit(0);
  }

  if (MODE === "fav-private-odd") {
    // Steam answering 200 with a page that isn't the favourites page: its login page (an expired sign-in) or an empty
    // page (a glitch) has no item links, and must read as no answer, never as favourites removed
    const want = ["pfav-new", ...PRIV.map((_, i) => `pfav-${i}`)];
    const before = fs.readFileSync(FF(ME), "utf8");
    const ownPages = async (n) => (await since(n)).filter((x) => x.path === `/profiles/${ME}/myworkshopfiles/`).map((x) => x.query.p);
    const same = async () => J(titles(await favs())) === J(want) && fs.readFileSync(FF(ME), "utf8") === before;
    // the count check meets a login page as page 1
    await fetch(`${FAKE}/__oddpage?p=1&kind=login`);
    let n0 = (await fakeLog()).length, L = blog().length;
    await favs("check");
    await waitFor(() => /count check/.test(blog().slice(L)), 15000);
    await sleep(300);
    out(J(await ownPages(n0)) === J(["1"]) && /count check: not the favourites page/.test(blog().slice(L)) && !/id diff/.test(blog().slice(L)) && await same(),
      "private profile: a 200 login page as page 1 → the count check keeps the list (no diff, nothing written)", J({ pages: await ownPages(n0), log: blog().slice(L), n: titles(await favs()).length }));
    // a diff meets the login page as page 1
    await fetch(`${FAKE}/__oddpage?p=1&kind=login`);
    n0 = (await fakeLog()).length; L = blog().length;
    await favs("open");
    await waitFor(() => /id diff (stopped|done)/.test(blog().slice(L)), 15000);
    out(J(await ownPages(n0)) === J(["1"]) && /id diff stopped/.test(blog().slice(L)) && await same(),
      "private profile: a 200 login page as a diff's page 1 → the list kept, nothing written", J({ pages: await ownPages(n0), log: blog().slice(L), n: titles(await favs()).length }));
    // a diff meets a blank page 2: not the list's end
    await fetch(`${FAKE}/__oddpage?p=2&kind=blank`);
    n0 = (await fakeLog()).length; L = blog().length;
    await favs("open");
    await waitFor(() => /id diff (stopped|done)/.test(blog().slice(L)), 20000);
    out(J(await ownPages(n0)) === J(["1", "2"]) && /id diff stopped/.test(blog().slice(L)) && await same(),
      "private profile: a blank 200 page 2 in a diff → not the list's end: the list kept, nothing written", J({ pages: await ownPages(n0), log: blog().slice(L), n: titles(await favs()).length }));
    // the pages answer again: the next diff reads them to the last page (its paging text says so) and keeps the same list
    n0 = (await fakeLog()).length; L = blog().length;
    await favs("open");
    await waitFor(() => /id diff (stopped|done)/.test(blog().slice(L)), 20000);
    out(J(await ownPages(n0)) === J(["1", "2", "3"]) && /id diff done — 66 item\(s\), 0 added, 0 removed/.test(blog().slice(L)) && J(titles(await favs())) === J(want),
      "private profile: the pages answering again → the next diff reads all three and keeps the same 66", J({ pages: await ownPages(n0), log: blog().slice(L) }));
    process.exit(0);
  }

  // every favourite removed on Steam: the list empties on the account's own empty favourites page, and only there — a
  // failed read (Steam's error page, its login page, a 429, the client protocol not answering) keeps it. Phases: two
  // failed reads of the private list (the 429's cooldown ends with the backend restart), the private list emptied, then a
  // public list's failed reads and its emptying.
  const ownPages = async (n) => (await since(n)).filter((x) => x.path === `/profiles/${ME}/myworkshopfiles/`).map((x) => x.query.p);
  const PRIV66 = ["pfav-new", ...PRIV.map((_, i) => `pfav-${i}`)];
  const PUB = ["3500000001", "3500000002", "3500000003"];
  if (MODE === "fav-gone-private") {
    const before = fs.readFileSync(FF(ME), "utf8");
    const same = async () => J(titles(await favs())) === J(PRIV66) && fs.readFileSync(FF(ME), "utf8") === before;
    await fetch(`${FAKE}/__myfavs`, { method: "POST", body: J({ ids: [] }) });
    // Steam's error page, served signed in, as a diff's page 1: no favourites tab, so no answer
    await fetch(`${FAKE}/__oddpage?p=1&kind=error`);
    let n0 = (await fakeLog()).length, L = blog().length;
    await favs("open");
    await waitFor(() => /id diff (stopped|done)/.test(blog().slice(L)), 15000);
    out(J(await ownPages(n0)) === J(["1"]) && /id diff stopped/.test(blog().slice(L)) && await same(),
      "every favourite removed on Steam, private profile: a failed read (Steam's error page, signed in, as page 1) → the list kept, nothing written",
      J({ pages: await ownPages(n0), log: blog().slice(L), n: titles(await favs()).length }));
    // a 429 on page 1
    await fetch(`${FAKE}/__ratelimit`);
    n0 = (await fakeLog()).length; L = blog().length;
    await favs("open");
    await waitFor(() => /id diff (stopped|done)/.test(blog().slice(L)), 15000);
    out(J(await ownPages(n0)) === J(["1"]) && /id diff stopped, the list kept \(SteamCooldownException\)/.test(blog().slice(L)) && await same(),
      "every favourite removed on Steam, private profile: a rate-limited read (429 on page 1) → the list kept, nothing written",
      J({ pages: await ownPages(n0), log: blog().slice(L), n: titles(await favs()).length }));
    process.exit(0);
  }

  if (MODE === "fav-gone-private-empty") {
    // the count check (this run's first) reads page 1: the account's own favourites tab, listing nothing → the diff takes it
    const n0 = (await fakeLog()).length, L = blog().length;
    await favs("check");
    await waitFor(() => /count check: not the favourites page|count check stopped|id diff (stopped|done)/.test(blog().slice(L)), 30000);
    const r = await favs(), saved = readJson(FF(ME));
    out(J(await ownPages(n0)) === J(["1"]) && /count check: changed/.test(blog().slice(L)) && /id diff done — 0 item\(s\), 0 added, 66 removed/.test(blog().slice(L))
      && r.json?.signedIn === true && r.json.items?.length === 0 && r.json.error === null && J(saved?.ids) === "[]" && saved.viaPage === true,
      "every favourite removed on Steam, private profile: the count check finds page 1 emptied, the diff takes the empty favourites page → no favourites, kept on disk",
      J({ pages: await ownPages(n0), log: blog().slice(L), n: r.json?.items?.length, saved }));
    // the next phase: a public list of 3 (the client protocol's), no cached list
    const fx = JSON.parse(fs.readFileSync(FX, "utf8"));
    fx["@userfiles"][`${ME}:myfavorites`] = PUB.map((id, i) => ({ publishedfileid: id, title: `pub-${i}`, creator: OWNER, time_created: 1700000000 + i,
      time_updated: 1790000000 - i, tags: ["Video"] }));
    fs.writeFileSync(FX, J(fx));
    fs.rmSync(FF(ME), { force: true });
    process.exit(0);
  }

  if (MODE === "fav-gone-public") {
    evs.length = 0;
    await favs("open");
    await waitAsync(async () => (await favs()).json?.loading === null && fs.existsSync(FF(ME)));
    const loaded = J(titles(await favs())) === J(["pub-0", "pub-1", "pub-2"]) && readJson(FF(ME))?.viaPage === false;
    const before = fs.readFileSync(FF(ME), "utf8");
    const same = async () => J(titles(await favs())) === J(["pub-0", "pub-1", "pub-2"]) && fs.readFileSync(FF(ME), "utf8") === before;
    // every favourite removed: the client protocol lists none, the community page is the empty favourites tab
    const fx = JSON.parse(fs.readFileSync(FX, "utf8"));
    fx["@userfiles"][`${ME}:myfavorites`] = [];
    // a failed read: the client protocol not answering (an unreadable fixture)
    fs.writeFileSync(FX, "");
    let n0 = (await fakeLog()).length, L = blog().length;
    await favs("open");
    await waitFor(() => /id diff: Steam didn't answer|id diff (stopped|done)/.test(blog().slice(L)), 15000);
    out(loaded && /the id diff: Steam didn't answer, the list kept/.test(blog().slice(L)) && (await ownPages(n0)).length === 0 && await same(),
      "every favourite removed on Steam, public profile: a failed read (the client protocol not answering) → the list kept, nothing written",
      J({ loaded, log: blog().slice(L), n: titles(await favs()).length }));
    fs.writeFileSync(FX, J(fx));
    // a failed read: no ids, then Steam's login page as the community page 1
    await fetch(`${FAKE}/__oddpage?p=1&kind=login`);
    n0 = (await fakeLog()).length; L = blog().length;
    await favs("open");
    await waitFor(() => /id diff (stopped|done)/.test(blog().slice(L)), 15000);
    out(J(await ownPages(n0)) === J(["1"]) && /id diff stopped/.test(blog().slice(L)) && await same(),
      "every favourite removed on Steam, public profile: a failed read (no ids, a login page as the community page) → the list kept, nothing written",
      J({ pages: await ownPages(n0), log: blog().slice(L), n: titles(await favs()).length }));
    // the diff: no ids, the community page the empty favourites tab → no favourites
    n0 = (await fakeLog()).length; L = blog().length;
    await favs("open");
    await waitFor(() => /id diff (stopped|done)/.test(blog().slice(L)), 15000);
    const r = await favs(), saved = readJson(FF(ME));
    out(/ids-only page 1 /.test(blog().slice(L)) && J(await ownPages(n0)) === J(["1"]) && /id diff done — 0 item\(s\), 0 added, 3 removed/.test(blog().slice(L))
      && r.json?.items?.length === 0 && r.json.error === null && J(saved?.ids) === "[]",
      "every favourite removed on Steam, public profile: the ids come back empty, the community page is the empty favourites tab → no favourites, kept on disk",
      J({ pages: await ownPages(n0), log: blog().slice(L), n: r.json?.items?.length, saved }));
    process.exit(0);
  }
}

// ---- 1. signed out ----
let n0 = (await fakeLog()).length;
let r = await get(`/workshop/creator?id=${ITEM}&owner=${OWNER}`);
out(r.status === 200 && r.json?.steamId === OWNER && r.json?.name === `Creator Bold ${OWNER.slice(-2)}` && r.json?.avatar === `https://avatars.example.invalid/${OWNER}_medium.jpg`,
  "creator: name (its markup stripped) + avatar from the profile XML", J(r));
r = await get(`/workshop/creator?id=3000000002`);
out(r.status === 200 && r.json?.steamId === OWNER && !!r.json?.name, "creator of an item without one: asked of the client protocol (the fixture)", J(r));
let reqs = await since(n0);
out(reqs.filter((x) => x.path === `/profiles/${OWNER}/`).length === 1, "creator: the profile read once per run", J(reqs.map((x) => x.path)));

// ---- 1b. an item's counts ----
const cmAsks = (id) => (fs.readFileSync(`${T}/backend.log`, "utf8").match(new RegExp(`GetDetails of [0-9]+ id\\(s\\).*fixture: [0-9,]*\\b${id}\\b`, "g")) ?? []).length;
r = await get(`/workshop/counts?id=${ITEM}`);
out(r.status === 200 && r.json?.subscriptions === 692 && r.json?.favorites === 34, "counts: the CURRENT subscribers and favourites (692 / 34), never the lifetime ones (876 / 35)", J(r));
r = await get(`/workshop/counts?id=${ITEM}`);
const rc = await get(`/workshop/creator?id=${ITEM}`);
out(r.status === 200 && rc.status === 200 && rc.json?.steamId === OWNER && cmAsks(ITEM) === 1, "counts asked again + the creator without an owner: still one GetDetails of the item", J({ asks: cmAsks(ITEM), rc }));
r = await get(`/workshop/counts?id=3000000002`);
out(r.status === 200 && cmAsks("3000000002") === 1, "counts of an item whose creator was asked of the client protocol: no second GetDetails", J({ r, asks: cmAsks("3000000002") }));
const both = await Promise.all([get(`/workshop/counts?id=3000000003`), get(`/workshop/creator?id=3000000003`)]);
out(both.every((x) => x.status === 200) && cmAsks("3000000003") === 1, "the counts and the creator asked at once: one GetDetails", J({ both, asks: cmAsks("3000000003") }));
r = await get(`/workshop/counts?id=3000000099`);
const rb = await get(`/workshop/counts?id=12ab`);
out(r.status === 404 && rb.status === 400, "counts: no such public item → 404, a non-digit id → 400", J([r, rb]));
fs.renameSync(`${T}/steam-cm.json`, `${T}/steam-cm.off`);
r = await get(`/workshop/counts?id=3000000004`);
fs.renameSync(`${T}/steam-cm.off`, `${T}/steam-cm.json`);
const r4 = await get(`/workshop/counts?id=3000000004`);
out(r.status === 502 && r4.status === 200 && r4.json?.subscriptions === 692, "counts with Steam unreachable → 502, not kept: asked again once it answers", J([r, r4]));

n0 = (await fakeLog()).length;
r = await get(`/workshop/favorite?id=${ITEM}`);
out(r.status === 200 && r.json?.signedIn === false && r.json?.favorited === null && (await since(n0)).length === 0, "favourite state signed out: no sign-in, nothing sent", J(r));
r = await post("/workshop/favorite", { workshopId: ITEM, favorite: true });
out(r.status === 403 && r.json?.signIn === true && /Sign in/.test(r.json?.error) && (await since(n0)).length === 0, "favourite signed out: 403 {signIn}, nothing sent", J(r));
r = await get(`/workshop/comments?id=${ITEM}&owner=${OWNER}&start=0&count=10`);
const c0 = r.json?.comments?.[0];
out(r.status === 200 && r.json.total === 23 && r.json.comments.length === 10 && r.json.signedIn === false, "comments: the first page of 10, total 23, signedIn false", J({ s: r.status, t: r.json?.total, n: r.json?.comments?.length }));
out(c0?.id === "900023" && r.json.comments.every((c, i, a) => i === 0 || a[i - 1].time > c.time), "comments: newest first", J(r.json?.comments?.map((c) => c.time)));
out(c0?.text === "First line\nsecond <b>line</b> :steamhappy: a link", "comments: plain text — a <br> kept, an entity decoded once, an emoticon by name, a link's words", J(c0?.text));
const whole = J(r.json);
out(!/script|onerror|onclick|pwned|linkfilter|evil/i.test(whole), "comments: no script, handler or link target anywhere in the answer", whole.slice(0, 300));
out(c0?.author === "Fan & friend x" && c0?.authorId === "76561198000000100" && c0?.avatar === "https://avatars.example.invalid/0_medium.jpg" && c0?.time === 1790000000,
  "comments: author (plain), author id, avatar, time", J(c0));
reqs = await since(n0);
const render = reqs.find((x) => x.path.startsWith("/comment/PublishedFile_Public/render/"));
out(render && render.path === `/comment/PublishedFile_Public/render/${OWNER}/${ITEM}/` && render.cookieNames.length === 0 && render.form.start === "0" && render.form.count === "10",
  "comments: read from the creator's thread, without any cookie", J(render));
r = await get(`/workshop/comments?id=${ITEM}&owner=${OWNER}&start=20&count=10`);
out(r.status === 200 && r.json.start === 20 && r.json.comments.length === 3 && r.json.comments[2].text === "comment number 1", "comments: the last page (start 20) holds the oldest 3", J(r.json?.comments?.map((c) => c.text)));
n0 = (await fakeLog()).length;
r = await post("/workshop/comment", { workshopId: ITEM, owner: OWNER, text: "hi" });
out(r.status === 403 && r.json?.signIn === true && (await since(n0)).length === 0, "post signed out: 403 {signIn}, nothing sent", J(r));
n0 = (await fakeLog()).length;
r = await get("/workshop/my-favorites?sync=open");
out(r.status === 200 && r.json?.signedIn === false && !("items" in r.json) && (await since(n0)).length === 0, "my-favorites signed out: {signedIn:false}, nothing sent", J(r));

// ---- 2. a creator's items ----
r = await browse({ kind: "creator", id: OWNER });
const p1 = r.json ?? [];
out(r.status === 200 && p1.length === 80 && p1[0].title === "made-20", "creator list page 1: Steam's first 100 minus 20 web / application items", J({ s: r.status, n: p1.length, first: p1[0]?.title }));
out(p1.every((w) => w.subscriptions === 692 && w.favorites === 34), "creator list: the CURRENT subscriber and favourite counts (692 / 34), never the lifetime ones (876 / 35)",
  J(p1.slice(0, 2).map((w) => [w.subscriptions, w.favorites])));
out(p1.every((w) => !(w.tags || []).some((t) => t === "Web" || t === "Application")), "creator list: no web / application items");
out(p1.every((w) => !("views" in w)), "creator list: no view count sent (the sidebar shows none)", J(Object.keys(p1[0] ?? {})));
r = await browse({ kind: "creator", id: OWNER }, 2);
out(r.status === 200 && r.json?.length === 30 && r.json[29].title === "made-129", "creator list page 2: the last 30", J({ n: r.json?.length }));
r = await browse({ kind: "creator", id: OWNER }, 3);
out(r.status === 200 && r.json?.length === 0, "creator list page 3: the end", J({ n: r.json?.length }));
r = await browse({ kind: "creator", id: OWNER, sort: "toprated" });
out(r.status === 200 && r.json?.[0]?.title === "made-129", "creator list, top rated: Steam's score order", J(r.json?.slice(0, 2).map((w) => w.title)));
r = await browse({ kind: "creator", id: OWNER }, 1, filter({ include: ["Anime"] }));
out(r.status === 200 && r.json.length > 0 && r.json.every((w) => w.tags.includes("Anime")), "creator list + the filter's tags: only Anime items", J(r.json?.length));
const bl0 = fs.readFileSync(`${T}/backend.log`, "utf8");
out(/GetUserFiles myfiles sort=score/.test(bl0) && /GetUserFiles myfiles sort=lastupdated/.test(bl0), "creator list: lastupdated / score asked of Steam (backend log)");

// ---- 3. signed in (a pasted cookie in the file secret store) ----
fs.writeFileSync(`${process.env.XDG_CONFIG_HOME}/liascape/steam-auth.json`, J({ "steam-login-secure": `${ME}||${TOKEN}` }), { mode: 0o600 });
n0 = (await fakeLog()).length;
r = await get(`/workshop/favorite?id=${ITEM}`);
reqs = await since(n0);
out(r.json?.signedIn === true && r.json?.favorited === false && reqs.length === 1 && reqs[0].path === "/sharedfiles/filedetails/" && reqs[0].signedIn,
  "favourite state signed in: the item page read with the cookie → false", J({ r: r.json, reqs }));
await fetch(`${FAKE}/__fav?id=3000000009`);
r = await get(`/workshop/favorite?id=3000000009`);
out(r.json?.favorited === true, "favourite state: a page whose button is toggled → true", J(r.json));
n0 = (await fakeLog()).length;
r = await post("/workshop/favorite", { workshopId: ITEM, favorite: true });
reqs = await since(n0);
const fav = reqs.find((x) => x.path === "/sharedfiles/favorite");
out(r.status === 200 && r.json?.favorited === true && fav?.signedIn && fav?.sessionPair && fav.form.id === ITEM && fav.form.appid === "431960",
  "favourite: POST sharedfiles/favorite with the cookie + matching sessionid, id + appid", J({ r, fav }));
r = await get(`/workshop/favorite?id=${ITEM}`);
out(r.json?.favorited === true, "favourite state after favouriting: true", J(r.json));
n0 = (await fakeLog()).length;
r = await post("/workshop/favorite", { workshopId: ITEM, favorite: false });
reqs = await since(n0);
out(r.status === 200 && r.json?.favorited === false && reqs.some((x) => x.path === "/sharedfiles/unfavorite" && x.signedIn && x.sessionPair), "unfavourite: POST sharedfiles/unfavorite", J({ r, reqs }));
r = await post("/workshop/favorite", { workshopId: "12ab", favorite: true });
out(r.status === 400, "favourite of a non-digit id: 400", J(r));
n0 = (await fakeLog()).length;
const typed = "hello <b>world</b> & co\nline two";
r = await post("/workshop/comment", { workshopId: ITEM, owner: OWNER, text: typed });
reqs = await since(n0);
const pst = reqs.find((x) => x.path.startsWith("/comment/PublishedFile_Public/post/"));
out(r.status === 200 && r.json?.total === 24 && r.json?.comments?.[0]?.text === typed && pst?.signedIn && pst?.sessionPair && pst.form.comment === typed,
  "post: the comment sent with the cookie + sessionid pair; the answer's first comment is it, as typed", J({ s: r.status, t: r.json?.total, c: r.json?.comments?.[0], pst }));
n0 = (await fakeLog()).length;
r = await post("/workshop/comment", { workshopId: ITEM, owner: OWNER, text: "x".repeat(1001) });
const r2 = await post("/workshop/comment", { workshopId: ITEM, owner: OWNER, text: "   " });
out(r.status === 400 && r2.status === 400 && (await since(n0)).length === 0, "post: too long / empty → 400, nothing sent", J([r, r2]));
// the account's favourites (GET /workshop/my-favorites, Helpers/WorkshopFavorites.cs; § 7 in depth): the first load runs in
// the background, the page reads again until it's in
const myFavs = async (want) => {
  let r = await get("/workshop/my-favorites?sync=open");
  for (let t = 0; t < 15000 && !(r.json?.loading == null && J((r.json?.items ?? []).map((w) => w.title)) === J(want)); t += 100) {
    await sleep(100); r = await get("/workshop/my-favorites?sync=none"); }
  return r;
};
r = await myFavs(["fav-a", "fav-b"]);
out(r.status === 200 && r.json?.signedIn === true && J(r.json.items.map((w) => w.title)) === J(["fav-a", "fav-b"]) && r.json.error == null,
  "my-favorites signed in: the account's favourites (client protocol)", J(r));
// the favourites are no /browse list any more: that kind answers the whole Workshop, asking Steam for no user files
const uf0 = count(/GetUserFiles myfavorites/);
r = await browse({ kind: "favorites" });
const wholeWs = await browse(undefined);
out(r.status === 200 && wids(wholeWs).length > 0 && J(wids(r)) === J(wids(wholeWs)) && count(/GetUserFiles myfavorites/) === uf0,
  "/browse list kind favorites: the whole Workshop (no list), no user files asked", J({ r: wids(r), whole: wids(wholeWs) }));
// a private profile: the client protocol sees no favourites → the community's favourites page with the cookie, then the
// items' details (GetDetails on the client protocol: the fixture's entries below)
const fx = JSON.parse(fs.readFileSync(`${T}/steam-cm.json`, "utf8")); delete fx["@userfiles"][`${ME}:myfavorites`];
for (const id of ["3100000001", "3100000002", "3100000003"])
  fx[id] = { title: `fav-${id}`, tags: ["Video"], creator: OWNER, subscriptions: 692, lifetime_subscriptions: 876, favorited: 34, lifetime_favorited: 35 };
fs.writeFileSync(`${T}/steam-cm.json`, J(fx));
n0 = (await fakeLog()).length;
const gd0 = count(/GetDetails of 3 id/);
r = await myFavs(["fav-3100000001", "fav-3100000002", "fav-3100000003"]);
reqs = await since(n0);
out(r.status === 200 && J(r.json.items.map((w) => w.title)) === J(["fav-3100000001", "fav-3100000002", "fav-3100000003"])
  && reqs.some((x) => x.path === `/profiles/${ME}/myworkshopfiles/` && x.signedIn) && count(/GetDetails of 3 id/) > gd0,
  "favourites of a private profile: the community page (with the cookie) + the items' details", J({ r: r.json?.items?.map?.((w) => w.title) ?? r, reqs: reqs.map((x) => x.path) }));
out(r.json.items.every((w) => w.subscriptions === 692 && w.favorites === 34), "the private favourites' details: the CURRENT counts (692 / 34), never the lifetime ones", J(r.json.items.map((w) => [w.subscriptions, w.favorites])));
// § 7 starts this account's cache afresh
fs.rmSync(`${process.env.XDG_CACHE_HOME}/liascape/workshop/favorites-${ME}.json`, { force: true });
const all = await fakeLog();
out(all.every((x) => /Firefox/.test(x.ua)), "every request carries the Firefox User-Agent", J(all.filter((x) => !/Firefox/.test(x.ua)).map((x) => x.path)));
const bl = fs.readFileSync(`${T}/backend.log`, "utf8"), st = fs.readFileSync(`${process.env.XDG_CONFIG_HOME}/liascape/settings.json`, "utf8");
out(!bl.includes(TOKEN) && !st.includes(TOKEN), "the cookie's token is in no log line and not in settings.json");

// ---- 4. Steam's 429 ----
await fetch(`${FAKE}/__ratelimit`);
r = await get(`/workshop/comments?id=${ITEM}&owner=${OWNER}&start=0&count=10`);
out(r.status === 429 && /try again in/.test(r.json?.error ?? ""), "Steam's 429: the comments answer 429 'try again in N min'", J(r));
out(fs.existsSync(`${process.env.XDG_CACHE_HOME}/liascape/steam-cooldown.json`), "Steam's 429: the cooldown is saved (steam-cooldown.json)");
n0 = (await fakeLog()).length;
r = await get(`/workshop/comments?id=${ITEM}&owner=${OWNER}&start=10&count=10`);
const r3 = await post("/workshop/favorite", { workshopId: ITEM, favorite: true });
out(r.status === 429 && r3.status === 429 && (await since(n0)).length === 0, "during the cooldown: 429 and nothing sent", J([r.status, r3.status]));

// ---- 5. a scene's presets (list kind "presets": QueryFiles' child lookup) and a preset's base ----
r = await browse({ kind: "presets", id: "1003" });
out(r.status === 200 && J(wids(r)) === J(["2001", "2002"]) && r.json.every((w) => w.isPreset === true && w.isScene === true),
  "presets list: exactly the scene's presets, each isPreset + isScene (the web-based one left out)", J({ s: r.status, ids: wids(r), r: r.json?.error }));
r = await browse({ kind: "presets", id: "1002" });
out(r.status === 200 && r.json?.length === 0, "presets list of an item with none: []", J(r));
const pp1 = await browse({ kind: "presets", id: "1004" }), pp2 = await browse({ kind: "presets", id: "1004" }, 2), pp3 = await browse({ kind: "presets", id: "1004" }, 3);
out(wids(pp1).length === 100 && wids(pp2).length === 50 && pp3.json?.length === 0 && new Set([...wids(pp1), ...wids(pp2)]).size === 150,
  "presets list paged: 100, then 50, then the end", J([wids(pp1).length, wids(pp2).length, pp3.json?.length ?? pp3]));
r = await browse({ kind: "presets", id: "1003", sort: "toprated" });
const bl5 = fs.readFileSync(`${T}/backend.log`, "utf8");
out(r.status === 200 && /QueryFiles children of 1003 query_type=21\b/.test(bl5) && /QueryFiles children of 1003 query_type=0\b/.test(bl5),
  "presets list: last updated / top rated asked of Steam as query_type 21 / 0 (backend log)", J(bl5.match(/QueryFiles children[^\n]*/g)));
r = await browse(undefined);
out(r.status === 200 && r.json.length > 0 && r.json.every((w) => !w.isPreset && !(w.tags ?? []).includes("Preset")), "the whole Workshop's default list: no preset", J(wids(r)));
r = await browse(undefined, 1, filter({ include: ["Preset"] }));
out(r.status === 200 && r.json.length === 100 && r.json.every((w) => w.isPreset && w.isScene) && wids(r).includes("2003") && !wids(r).includes("2004"),
  "the whole Workshop, Preset ticked: presets only (incl. a video-based one), never a web-based one", J({ n: r.json?.length, first: wids(r).slice(0, 5) }));

r = await get("/workshop/base?id=2001");
out(r.status === 200 && r.json?.baseId === "1003" && r.json?.kind === "scene" && r.json?.title === "Query Scene" && r.json?.libraryPath === null,
  "base of a preset: its one child on Steam, the base's title and kind, not in the library", J(r));
const libBase = `${process.env.XDG_DATA_HOME}/liascape/library/workshop/1003`;
fs.mkdirSync(libBase, { recursive: true });
r = await get("/workshop/base?id=2001");
out(r.status === 200 && r.json?.libraryPath === libBase && cmAsks("2001") === 1 && cmAsks("1003") === 1,
  "base of a preset again: the library's folder, Steam asked once per item (the details cache)", J({ r, asks: [cmAsks("2001"), cmAsks("1003")] }));
const rv = await get("/workshop/base?id=1001"), rx = await get("/workshop/base?id=x");
out(rv.status === 404 && rx.status === 400, "base of a non-preset → 404, a non-digit id → 400", J([rv, rx]));

const SF = `${process.env.XDG_CONFIG_HOME}/liascape/settings.json`;
const setFile = (p) => fs.writeFileSync(SF, J({ ...JSON.parse(fs.readFileSync(SF, "utf8")), ...p }));
setFile({ AllowScenes: false });
r = await browse({ kind: "presets", id: "1003" });
const rf = await browse(undefined, 1, filter({ include: ["Preset"] }));
setFile({ AllowScenes: true });
out(r.status === 200 && r.json?.length === 0 && rf.status === 200 && rf.json?.length === 0, "scene support off: no presets list, Preset ticked finds nothing", J([r, rf.json?.length]));
r = await post("/settings", { PlayerEngine: "legacy" });
const rl = await browse({ kind: "presets", id: "1003" });
out(r.status === 200 && rl.status === 200 && J(wids(rl)) === J(["2001", "2002"]), "PlayerEngine legacy (an old settings key, ignored): the presets list as before", J([r.status, wids(rl)]));

// ---- 6. the shared Workshop details cache (POST /workshop/details) ----
let before = count(/GetDetails of/);
const before3 = count(/GetDetails of 3 id/); // § 3's private favourites asked theirs too
r = await post("/workshop/details", { ids: ["5001", "5002", "9999"] });
out(r.status === 200 && J(wids({ json: r.json?.items })) === J(["5001", "5002"]) && r.json.items[0].createdAt && r.json.items[0].score === 0.75,
  "details: the found items in order, with created / score", J(r));
out(count(/GetDetails of 3 id/) === before3 + 1 && count(/GetDetails of/) === before + 1, "details: one GetDetails for the missing ids", J(count(/GetDetails of/) - before));
before = count(/GetDetails of/);
r = await post("/workshop/details", { ids: ["5002", "5001", "9999"] });
out(r.status === 200 && J(wids({ json: r.json?.items })) === J(["5002", "5001"]) && count(/GetDetails of/) === before,
  "details: a second ask (in another order) sends nothing, the id Steam has none of included", J({ r, asks: count(/GetDetails of/) - before }));
out(await waitFor(() => onDisk()?.["5001"] && onDisk()?.["5002"]), "details: kept on disk");
const disk = onDisk();
out(!!disk && !("9999" in disk), "details: an id Steam has no public item for isn't kept on disk", J(Object.keys(disk ?? {})));
out(!!disk && !(ITEM in disk), "details: a sidebar's counts of an uncached item don't add it to the cache", J(Object.keys(disk ?? {})));
// writes coalesced: three items cached one after another → one save (at most one a second; never three)
const saves0 = count(/workshop-details: saved/);
for (const id of ["5003", "3000000002", "3000000003"]) await post("/workshop/details", { ids: [id] });
await waitFor(() => ["5003", "3000000002", "3000000003"].every((id) => onDisk()?.[id]));
await sleep(1300);
const saves = count(/workshop-details: saved/) - saves0;
out(saves >= 1 && saves <= 2 && ["5003", "3000000002", "3000000003"].every((id) => onDisk()?.[id]), "details: three asks in a row saved at most once a second", J({ saves }));
// Steam unreachable: what's cached, the rest left out and asked again once it answers
fs.renameSync(`${T}/steam-cm.json`, `${T}/steam-cm.off`);
r = await post("/workshop/details", { ids: ["5001", "3000000004"] });
fs.renameSync(`${T}/steam-cm.off`, `${T}/steam-cm.json`);
before = count(/GetDetails of/);
const r6 = await post("/workshop/details", { ids: ["5001", "3000000004"] });
out(r.status === 200 && J(wids({ json: r.json?.items })) === J(["5001"]) && J(wids({ json: r6.json?.items })) === J(["5001", "3000000004"]) && count(/GetDetails of/) === before + 1,
  "details with Steam unreachable: only what's cached; the rest asked again once it answers", J([r, r6]));
before = count(/GetDetails of/);
const big = await post("/workshop/details", { ids: Array.from({ length: 2001 }, (_, i) => String(i + 1)) });
const bad = await post("/workshop/details", { ids: ["5001", "12a"] });
out(big.status === 400 && bad.status === 400 && count(/GetDetails of/) === before, "details: 2001 ids → 400, a non-digit id → 400, nothing asked", J([big.status, bad.status]));
// a Library sidebar's counts (fixture 5001 subscriptions 10 → 99) refresh the cached copy
const fx6 = JSON.parse(fs.readFileSync(`${T}/steam-cm.json`, "utf8")); fx6["5001"].subscriptions = 99;
fs.writeFileSync(`${T}/steam-cm.json`, J(fx6));
const rcnt = await get("/workshop/counts?id=5001");
before = count(/GetDetails of/);
r = await post("/workshop/details", { ids: ["5001"] });
out(rcnt.json?.subscriptions === 99 && r.json?.items?.[0]?.subscriptions === 99 && count(/GetDetails of/) === before
  && await waitFor(() => onDisk()?.["5001"]?.Subscriptions === 99),
  "details: a Library sidebar's counts refresh the cached copy (in memory and on disk)", J({ rcnt, r }));
EOF
(cd "$T" && timeout 200 node drive.mjs) > "$T/drive.log" 2>&1; rc=$?
# § 6 after a restart: what the details cache kept on disk
stop_backend; start_backend
(cd "$T" && timeout 60 node drive.mjs after-restart) >> "$T/drive.log" 2>&1 || rc=$?
# § 7 on a backend without § 4's cooldown (a private profile's community pages must go out), restarted before each phase
# (and without the cooldown a phase's own 429 started)
stop_backend; rm -f "$XDG_CACHE_HOME/liascape/steam-cooldown.json"; start_backend
for phase in fav fav-total fav-restart fav-private fav-private-grow fav-private-odd fav-gone-private fav-gone-private-empty fav-gone-public; do
  [ $phase = fav ] || { stop_backend; rm -f "$XDG_CACHE_HOME/liascape/steam-cooldown.json"; start_backend; }
  (cd "$T" && timeout 60 node drive.mjs $phase) >> "$T/drive.log" 2>&1 || rc=$?
done
sed 's/^/      /' "$T/drive.log"
p=$(grep -c '^PASS' "$T/drive.log"); f=$(grep -c '^FAIL' "$T/drive.log")
PASS=$((PASS + p)); FAIL=$((FAIL + f))
[ $rc = 0 ] || { echo "FAIL  drive.mjs exited $rc"; FAIL=$((FAIL + 1)); }
echo "== backend log (community / steam-cm / error lines)"; grep -E "community:|steam-cm:|error:|browse:" "$T/backend.log" | sed 's/^/      /' | tail -14
echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
