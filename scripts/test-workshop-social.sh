#!/usr/bin/env bash
# Hermetic test of the Browse sidebar's Workshop community pieces (Web/WorkshopSocialOps.cs over Helpers/SteamCommunity.cs)
# and Browse's Workshop lists (Services/SteamWorkshopService.cs ListAsync): a private backend whose steamcommunity.com and
# api.steampowered.com are a fake server (scripts/test-fixtures/fake-steam-community.mjs; LIASCAPE_STEAM_COMMUNITY /
# LIASCAPE_STEAM_API) and whose Steam client-protocol answers are a fixture file (LIASCAPE_STEAM_CM_FIXTURE), all in its own
# network namespace (`unshare -rn`: loopback only — nothing can reach Steam; no real favourite, no real comment).
#  1. signed out: the creator's name + avatar (profile XML, markup stripped, read once per run; the creator of an item
#     without one asked of the client protocol); the favourite state "signed out" with no request; favourite and post → 403
#     {signIn} with nothing sent; the comment thread (newest first, paged, total) as plain text — no script, no handler, an
#     entity decoded once, a line break kept, an emoticon by name — sent without any cookie; the favourites list → 403 {signIn}.
#  1b. an item's counts (/workshop/counts, the Library sidebar's stat pills): Steam's CURRENT subscriber / favourite counts
#     from the client protocol (not the lifetime ones); one GetDetails per item however many asks (the counts and the creator
#     at once, again later); no such item → 404, a bad id → 400, Steam unreachable → 502 and asked again once it answers.
#  2. a creator's items (/browse `list`): the client protocol's user files, the CURRENT subscriber / favourite counts (not the
#     lifetime ones), web / application items left out, paged 100 at a time to the end, top rated → Steam's "score" order,
#     the filter's tags matched.
#  3. signed in (a pasted cookie, file secret store): the favourite state read from the item page with the cookie (toggled →
#     true), favourite / unfavourite (the cookie + a matching sessionid pair, id + appid), a comment posted (the new one on top,
#     its text back as typed), an empty / too-long comment refused without a request, the favourites list (client protocol),
#     a private profile's favourites from the community page + the keyless details (current counts again); the cookie's token
#     in no log line and not in settings.json; every request with the Firefox User-Agent.
#  4. Steam's 429: the comments answer 429 "try again in N min", the cooldown file is written and the next read sends nothing.
#  5. a scene's presets (/browse `list` kind "presets", QueryFiles' child lookup; the engine is liascape-player through a
#     stub binary that never runs): exactly the presets naming it (a web-based one left out), paged 100 at a time, sorted
#     as asked; the whole Workshop's default list holds none, Preset ticked holds only presets; a preset's base
#     (/workshop/base: Steam's one child, its title and kind, the library's folder, one GetDetails per item; 404 / 400);
#     scene support off or the legacy engine → no presets.
#  6. the shared Workshop details cache (POST /workshop/details, Helpers/WorkshopDetailsCache.cs): the found items in the
#     asked order with their created time and score, the missing ones in one GetDetails, a second ask sends nothing (an id
#     Steam has none of remembered for the run, not on disk), kept in $XDG_CACHE_HOME/liascape/workshop/details.json (saves
#     at most once a second), Steam unreachable → only what's cached, 2001 ids / a non-digit id → 400 with nothing asked, a
#     Library sidebar's counts refresh a cached copy (an uncached one isn't added); after a restart the same ask sends nothing.
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
  timeout -k 10 300 unshare -rn bash -c 'ip link set lo up && exec bash "$0"' "${BASH_SOURCE[0]}"
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
# the engine is liascape-player (presets are offered only there), its binary a stub: nothing here ever plays
mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 1\n' > "$T/bin/liascape-player"; chmod +x "$T/bin/liascape-player"
export LIASCAPE_PLAYER_BIN=$T/bin/liascape-player
printf '{"PlayerEngine":"liascape-player","NoAudio":true,"AllowScenes":true,"AutoAddWeWallpapersToLibrary":false}\n' > "$XDG_CONFIG_HOME/liascape/settings.json"
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
r = await browse({ kind: "favorites" });
out(r.status === 403 && r.json?.signIn === true, "favourites list signed out: 403 {signIn}", J(r));

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
r = await browse({ kind: "favorites" });
out(r.status === 200 && J(r.json.map((w) => w.title)) === J(["fav-a", "fav-b"]), "favourites list signed in: the account's favourites (client protocol)", J(r));
// a private profile: the client protocol sees no favourites → the community's favourites page with the cookie
const fx = JSON.parse(fs.readFileSync(`${T}/steam-cm.json`, "utf8")); delete fx["@userfiles"][`${ME}:myfavorites`];
fs.writeFileSync(`${T}/steam-cm.json`, J(fx));
n0 = (await fakeLog()).length;
r = await browse({ kind: "favorites", sort: "toprated" });
reqs = await since(n0);
out(r.status === 200 && J(r.json.map((w) => w.title)) === J(["fav-3100000001", "fav-3100000002", "fav-3100000003"])
  && reqs.some((x) => x.path === `/profiles/${ME}/myworkshopfiles/` && x.signedIn) && reqs.some((x) => x.path === "/ISteamRemoteStorage/GetPublishedFileDetails/v1/"),
  "favourites of a private profile: the community page (with the cookie) + the keyless details", J({ r: r.json?.map?.((w) => w.title) ?? r, reqs: reqs.map((x) => x.path) }));
out(r.json.every((w) => w.subscriptions === 692 && w.favorites === 34), "keyless details: the CURRENT counts (692 / 34), never the lifetime ones", J(r.json.map((w) => [w.subscriptions, w.favorites])));
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
out(r.status === 200 && rl.status === 200 && rl.json?.length === 0, "the legacy engine: no presets list", J([r.status, rl]));

// ---- 6. the shared Workshop details cache (POST /workshop/details) ----
let before = count(/GetDetails of/);
r = await post("/workshop/details", { ids: ["5001", "5002", "9999"] });
out(r.status === 200 && J(wids({ json: r.json?.items })) === J(["5001", "5002"]) && r.json.items[0].createdAt && r.json.items[0].score === 0.75,
  "details: the found items in order, with created / score", J(r));
out(count(/GetDetails of 3 id/) === 1 && count(/GetDetails of/) === before + 1, "details: one GetDetails for the missing ids", J(count(/GetDetails of/) - before));
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
sed 's/^/      /' "$T/drive.log"
p=$(grep -c '^PASS' "$T/drive.log"); f=$(grep -c '^FAIL' "$T/drive.log")
PASS=$((PASS + p)); FAIL=$((FAIL + f))
[ $rc = 0 ] || { echo "FAIL  drive.mjs exited $rc"; FAIL=$((FAIL + 1)); }
echo "== backend log (community / steam-cm / error lines)"; grep -E "community:|steam-cm:|error:|browse:" "$T/backend.log" | sed 's/^/      /' | tail -14
echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
