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
#  2. a creator's items (/browse `list`): the client protocol's user files, the CURRENT subscriber / favourite counts (not the
#     lifetime ones), web / application items left out, paged 100 at a time to the end, top rated → Steam's "score" order,
#     the filter's tags matched.
#  3. signed in (a pasted cookie, file secret store): the favourite state read from the item page with the cookie (toggled →
#     true), favourite / unfavourite (the cookie + a matching sessionid pair, id + appid), a comment posted (the new one on top,
#     its text back as typed), an empty / too-long comment refused without a request, the favourites list (client protocol),
#     a private profile's favourites from the community page + the keyless details (current counts again); the cookie's token
#     in no log line and not in settings.json; every request with the Firefox User-Agent.
#  4. Steam's 429: the comments answer 429 "try again in N min", the cooldown file is written and the next read sends nothing.
# Never touches ~/.config/liascape or the real library; everything it started is stopped on exit.
#
# Usage: scripts/test-workshop-social.sh [--no-build]   LIASCAPE_BACKEND_DLL=<dll>: another backend build (a RED run).
# Needs: dotnet (or DOTNET=…), node, unshare + ip (iproute2), curl, jq. Last line `RESULT pass=N fail=M`, exit 0 = pass.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
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
  cleanup() { trap - EXIT INT TERM HUP; case "$T" in /tmp/liascape-social-*) if command -v trash >/dev/null; then trash "$T" 2>/dev/null; else rm -rf -- "$T"; fi ;; esac; }
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
const fx = { "3000000001": { tags: ["Video"], creator: OWNER }, "3000000002": { tags: ["Video"], creator: OWNER },
  "@userfiles": { [`${OWNER}:myfiles`]: Array.from({ length: 130 }, (_, i) => item(i)),
                  [`${ME}:myfavorites`]: [item(500, { title: "fav-a" }), item(501, { title: "fav-b" })] } };
require("fs").writeFileSync(process.env.T + "/steam-cm.json", JSON.stringify(fx));'
export LIASCAPE_STEAM_CM_FIXTURE=$T/steam-cm.json

PASS=0; FAIL=0
node "$ROOT/scripts/test-fixtures/fake-steam-community.mjs" "$T/fake.port" "$ME" "$TOKEN" > "$T/fake.log" 2>&1 & FP=$!
for _ in $(seq 1 50); do [ -s "$T/fake.port" ] && break; sleep 0.1; done
[ -s "$T/fake.port" ] || { echo "FAIL  the fake community server didn't start"; cat "$T/fake.log"; exit 1; }
export FAKE=http://127.0.0.1:$(cat "$T/fake.port")
printf '{"PlayerEngine":"legacy","NoAudio":true,"AllowScenes":true,"AutoAddWeWallpapersToLibrary":false}\n' > "$XDG_CONFIG_HOME/liascape/settings.json"
(cd /tmp && LIASCAPE_STEAM_COMMUNITY=$FAKE LIASCAPE_STEAM_API=$FAKE exec "$DOTNET" "$DLL" serve > "$T/backend.log" 2>&1) & BP=$!
for _ in $(seq 1 300); do [ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] && break; kill -0 $BP 2>/dev/null || break; sleep 0.1; done
[ -s "$XDG_CONFIG_HOME/liascape/serve.port" ] || { echo "FAIL  backend didn't start"; tail -15 "$T/backend.log"; exit 1; }
export U=http://127.0.0.1:$(cat "$XDG_CONFIG_HOME/liascape/serve.port")
for _ in $(seq 1 50); do curl -sf -m 2 "$U/health" >/dev/null && break; sleep 0.1; done

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

// ---- 1. signed out ----
let n0 = (await fakeLog()).length;
let r = await get(`/workshop/creator?id=${ITEM}&owner=${OWNER}`);
out(r.status === 200 && r.json?.steamId === OWNER && r.json?.name === `Creator Bold ${OWNER.slice(-2)}` && r.json?.avatar === `https://avatars.example.invalid/${OWNER}_medium.jpg`,
  "creator: name (its markup stripped) + avatar from the profile XML", J(r));
r = await get(`/workshop/creator?id=3000000002`);
out(r.status === 200 && r.json?.steamId === OWNER && !!r.json?.name, "creator of an item without one: asked of the client protocol (the fixture)", J(r));
let reqs = await since(n0);
out(reqs.filter((x) => x.path === `/profiles/${OWNER}/`).length === 1, "creator: the profile read once per run", J(reqs.map((x) => x.path)));
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
EOF
(cd "$T" && timeout 200 node drive.mjs) > "$T/drive.log" 2>&1; rc=$?
sed 's/^/      /' "$T/drive.log"
p=$(grep -c '^PASS' "$T/drive.log"); f=$(grep -c '^FAIL' "$T/drive.log")
PASS=$((PASS + p)); FAIL=$((FAIL + f))
[ $rc = 0 ] || { echo "FAIL  drive.mjs exited $rc"; FAIL=$((FAIL + 1)); }
echo "== backend log (community / steam-cm / error lines)"; grep -E "community:|steam-cm:|error:|browse:" "$T/backend.log" | sed 's/^/      /' | tail -14
echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL = 0 ]
