// A fake steamcommunity.com + api.steampowered.com for scripts/test-workshop-social.sh (and test-steam-signin.sh § 2): the backend's
// LIASCAPE_STEAM_COMMUNITY / LIASCAPE_STEAM_API point here, so nothing reaches Steam. It answers the calls the Browse
// sidebar's Workshop pieces make (Helpers/SteamCommunity.cs) the way Steam's site does, and records every request
// (method, path, form, cookie names, whether the sign-in cookie and the sessionid pair matched) for the test to check:
//   GET  /sharedfiles/filedetails/?id=N            an item page: g_steamID + #FavoriteItemBtn (toggled = favourited)
//   POST /sharedfiles/favorite | unfavorite         id, appid, sessionid (= the sessionid cookie) + the sign-in → 200 ""
//   POST /sharedfiles/subscribe | unsubscribe       id, appid, sessionid + the sign-in → {"success":1} (Steam's own files are the
//                                                   test's to drop: nothing here writes a Workshop folder)
//   POST /comment/PublishedFile_Public/render/O/N/  start, count → {success, start, total_count, comments_html}, newest first
//   POST /comment/PublishedFile_Public/post/O/N/    comment, count, sessionid + the sign-in → the first page, the new one on top
//   GET  /profiles/S/?xml=1                         a profile's XML (steamID, avatarMedium)
//   GET  /profiles/S/myworkshopfiles/?…myfavorites  a favourites page (filedetails links + Steam's "Showing a-b of N entries"), 30 a page
//   POST /ISteamRemoteStorage/GetPublishedFileDetails/v1/  the keyless details, current AND lifetime counts
//   GET  /__log  the requests so far     POST /__ratelimit  the next request answers 429     /__fav?id=N  favourited on "Steam"
//   POST /__myfavs {ids: string[]}  the signed-in account's favourites page list, in its order (default: three ids)
//        Guard: the default list, test-workshop-social.sh "favourites of a private profile: the community page …"; a set
//        list is for the favourites cache's tests, which call this route
// Usage: node fake-steam-community.mjs <port file> <signed-in steamid> <cookie token>
import http from "node:http";
import fs from "node:fs";

const [portFile, ME, TOKEN] = process.argv.slice(2);
const OWNER = "76561198000000007";        // the creator of the items with comments
const ITEM = "3000000001";
const log = [];
const favs = new Set();                   // `${steamid}:${id}`
let rateLimitNext = false;
let myFavs = ["3100000001", "3100000002", "3100000003"];
let n = 0;

// Steam's own markup for a comment (the parts the backend reads, as the item page serves them), user text already escaped by
// Steam: the avatar sits in the author line, under an avatar frame's picture when the commenter has one, and an empty
// timestamp block comes before the one that carries the time
const MINI = (c) => BigInt(c.author) - 76561197960265728n;
const commentHtml = (c) => `
<div data-panel="{&quot;flow-children&quot;:&quot;row&quot;}" class="commentthread_comment responsive_body_text   " id="comment_${c.id}" style="">
  <div class="commentthread_comment_content">
    <div data-panel="{&quot;flow-children&quot;:&quot;row&quot;}" class="commentthread_comment_author">
      <div class="commentthread_comment_avatar playerAvatar online">${c.frame ? `
        <div class="profile_avatar_frame"><picture><source srcset="${c.frame}"></source><img src="${c.frame}"></picture></div>` : ""}
        <a href="https://steamcommunity.com/profiles/${c.author}" data-miniprofile="${MINI(c)}">
          <img src="${c.avatar}" srcset="${c.avatar} 1x"></a>
      </div>
      <div class="author_name_group">
        <div class="flex_row">
          <a class="hoverunderline commentthread_author_link" href="https://steamcommunity.com/profiles/${c.author}" data-miniprofile="${MINI(c)}">
            <bdi>${c.name}</bdi></a>
        </div>
        <div class="commentthread_comment_timestamp">
        </div>
        <div class="commentthread_comment_timestamp" title="a date" data-timestamp="${c.time}">a while ago&nbsp;</div>
      </div>
    </div>
    <div class="commentthread_comment_text" id="comment_content_${c.id}">
\t\t\t\t${c.html}\t\t\t</div>
  </div>
</div>`;
// 23 comments, newest first; the newest carries every trap untrusted markup can hold
const comments = { [ITEM]: Array.from({ length: 23 }, (_, i) => ({
  id: String(900000 + 23 - i), author: String(76561198000000100n + BigInt(i)), name: i === 0 ? "Fan &amp; friend <i>x</i>" : `fan ${i}`,
  avatar: `https://avatars.example.invalid/${i}_medium.jpg`, time: 1790000000 - i * 3600,
  frame: i === 0 ? "https://frames.example.invalid/frame.png" : null,
  html: i === 0
    ? `First line<br>second &lt;b&gt;line&lt;/b&gt; <script>window.__pwned=1</script><img src="x" onerror="window.__pwned=2"> <img class="emoticon" alt=":steamhappy:" src="https://e.invalid/e.png"> <a class="bb_link" href="https://steamcommunity.com/linkfilter/?u=https%3A%2F%2Fevil.invalid" onclick="x()">a link</a>`
    : `comment number ${23 - i}`,
})) };

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cookies = (req) => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
// the sign-in Steam would take: "<steamid>||<token>", URL-encoded once (as the browser sends it)
const signedIn = (ck) => ck.steamLoginSecure === encodeURIComponent(`${ME}||${TOKEN}`);
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });
const thread = (id, start, count) => {
  const all = comments[id] ?? [];
  return { success: true, name: `PublishedFile_Public_${OWNER}_${id}`, start, pagesize: count, total_count: all.length,
    upvotes: 0, has_upvoted: 0, comments_html: all.slice(start, start + count).map(commentHtml).join("\n"), timelastpost: all[0]?.time ?? 0 };
};
const details = (id) => ({ publishedfileid: id, result: 1, creator: OWNER, creator_app_id: 431960, consumer_app_id: 431960,
  filename: "", file_size: 1000, preview_url: `https://images.example.invalid/${id}.jpg`, title: `fav-${id}`, description: "a favourite",
  time_created: 1780000000, time_updated: 1780000000, visibility: 0, banned: 0, ban_reason: "",
  subscriptions: 692, favorited: 34, lifetime_subscriptions: 876, lifetime_favorited: 35, views: 5000,
  tags: [{ tag: "Video" }, { tag: "Anime" }, { tag: "1920 x 1080" }] });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const ck = cookies(req);
  const raw = req.method === "POST" ? await body(req) : "";
  const form = Object.fromEntries(new URLSearchParams(raw));
  const entry = { n: ++n, method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), form,
    cookieNames: Object.keys(ck), signedIn: signedIn(ck), sessionPair: !!form.sessionid && form.sessionid === ck.sessionid,
    ua: req.headers["user-agent"] || "" };
  if (!u.pathname.startsWith("/__")) log.push(entry);
  const send = (status, b, type = "application/json") => { res.writeHead(status, { "Content-Type": type }); res.end(typeof b === "string" ? b : JSON.stringify(b)); };
  if (u.pathname === "/__log") return send(200, log);
  if (u.pathname === "/__ratelimit") { rateLimitNext = true; return send(200, {}); }
  if (u.pathname === "/__fav") { favs.add(`${ME}:${u.searchParams.get("id")}`); return send(200, {}); }
  if (u.pathname === "/__myfavs" && req.method === "POST") {
    try { myFavs = (JSON.parse(raw).ids ?? []).map(String); } catch { return send(400, { error: "body: {ids: string[]}" }); }
    return send(200, {});
  }
  if (rateLimitNext) { rateLimitNext = false; res.writeHead(429, { "Content-Type": "text/html", "Retry-After": "120" }); return res.end("Too Many Requests"); }

  let m;
  if (req.method === "GET" && u.pathname === "/sharedfiles/filedetails/") {
    const id = u.searchParams.get("id"), me = signedIn(ck);
    const on = me && favs.has(`${ME}:${id}`);
    return send(200, `<!DOCTYPE html><html><head><script>g_steamID = ${me ? `"${ME}"` : "false"};</script></head><body>
<div class="workshopItemTitle">item ${esc(id)}</div>
<a onclick="FavoriteItem();" id="FavoriteItemBtn" class="general_btn favorite tooltip${on ? " toggled" : ""}">
  <div id="FavoriteItemOptionAdd" class="favoriteOption addFavorite${on ? "" : " selected"}">Favorite</div>
  <div id="FavoriteItemOptionFavorited" class="favoriteOption favorited${on ? " selected" : ""}">Favorited</div>
  <div id="FavoriteItemOptionRemove" class="favoriteOption removeFavorite">Unfavorite</div>
</a></body></html>`, "text/html");
  }
  if (req.method === "POST" && (m = u.pathname.match(/^\/sharedfiles\/(favorite|unfavorite)$/))) {
    if (!signedIn(ck) || !entry.sessionPair) return send(401, "<html>Sign in</html>", "text/html");
    if (m[1] === "favorite") favs.add(`${ME}:${form.id}`); else favs.delete(`${ME}:${form.id}`);
    return send(200, "", "text/html");
  }
  if (req.method === "POST" && /^\/sharedfiles\/(subscribe|unsubscribe)$/.test(u.pathname)) {
    if (!signedIn(ck) || !entry.sessionPair) return send(200, { success: 2 });
    return send(200, { success: 1 });
  }
  if (req.method === "POST" && (m = u.pathname.match(/^\/comment\/PublishedFile_Public\/render\/(\d+)\/(\d+)\/$/))) {
    if (m[1] !== OWNER) return send(200, { success: false, error: "wrong owner" });
    return send(200, thread(m[2], +form.start || 0, +form.count || 10));
  }
  if (req.method === "POST" && (m = u.pathname.match(/^\/comment\/PublishedFile_Public\/post\/(\d+)\/(\d+)\/$/))) {
    if (!signedIn(ck) || !entry.sessionPair) return send(200, { success: false, error: "You must be logged in to perform that action." });
    if (m[1] !== OWNER) return send(200, { success: false, error: "wrong owner" });
    (comments[m[2]] ??= []).unshift({ id: String(990000 + n), author: ME, name: "me", avatar: "https://avatars.example.invalid/me_medium.jpg",
      time: Math.floor(Date.now() / 1000), html: esc(form.comment).replace(/\n/g, "<br>") });
    return send(200, thread(m[2], 0, +form.count || 10));
  }
  if (req.method === "GET" && (m = u.pathname.match(/^\/profiles\/(\d+)\/$/)) && u.searchParams.get("xml") === "1") {
    return send(200, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<profile><steamID64>${m[1]}</steamID64><steamID><![CDATA[Creator <b>Bold</b> ${m[1].slice(-2)}]]></steamID><onlineState>offline</onlineState>
<privacyState>public</privacyState><avatarIcon><![CDATA[https://avatars.example.invalid/${m[1]}.jpg]]></avatarIcon>
<avatarMedium><![CDATA[https://avatars.example.invalid/${m[1]}_medium.jpg]]></avatarMedium></profile>`, "text/xml");
  }
  if (req.method === "GET" && (m = u.pathname.match(/^\/profiles\/(\d+)\/myworkshopfiles\/$/))) {
    if (!signedIn(ck) || m[1] !== ME || u.searchParams.get("browsefilter") !== "myfavorites") return send(200, "<html>nothing</html>", "text/html");
    const p = Math.max(1, +u.searchParams.get("p") || 1), ids = myFavs.slice((p - 1) * 30, p * 30);
    const paging = ids.length ? `<div class="workshopBrowsePagingInfo">Showing ${(p - 1) * 30 + 1}-${(p - 1) * 30 + ids.length} of ${myFavs.length.toLocaleString("en-US")} entries</div>` : "";
    return send(200, `<html><body>${paging}${ids.map((id) => `<div class="workshopItem"><a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${id}&searchtext=">x</a></div>`).join("")}</body></html>`, "text/html");
  }
  if (req.method === "POST" && u.pathname === "/ISteamRemoteStorage/GetPublishedFileDetails/v1/") {
    const ids = Object.entries(form).filter(([k]) => k.startsWith("publishedfileids[")).map(([, v]) => v);
    return send(200, { response: { result: 1, resultcount: ids.length, publishedfiledetails: ids.map(details) } });
  }
  send(404, { error: "not faked", path: u.pathname });
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
