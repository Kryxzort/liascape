using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Xml.Linq;
using HtmlAgilityPack;

namespace Liascape.Helpers;

// The Browse sidebar's Workshop community calls on steamcommunity.com — what Steam's client protocol doesn't offer
// anonymously and the keyless web API doesn't offer at all: an item's favourite (read from its page with the sign-in's cookie,
// set through sharedfiles/favorite | unfavorite like WorkshopDownloader.SubscribeAsync), its comment thread (read without a
// sign-in, posted with one) and a Steam profile's name + avatar (its public XML). Every request goes through SteamGate
// (spaced, and nothing is sent during Steam's cooldown); the cookie is only ever a header value, never logged.
// LIASCAPE_STEAM_COMMUNITY=<base URL> points every call here at another server (the hermetic tests' fake community).
public static class SteamCommunity
{
    public const string AppId = "431960";
    // a comment longer than Steam's own box takes is refused by Steam anyway; refusing it here sends nothing
    public const int MaxCommentChars = 1000;
    const string RealBase = "https://steamcommunity.com";
    // the 64-bit id of account id 0 (a comment's author carries its 32-bit account id)
    const ulong IndividualBase = 76561197960265728UL;

    public static string Base => Environment.GetEnvironmentVariable("LIASCAPE_STEAM_COMMUNITY") is { Length: > 0 } b ? b.TrimEnd('/') : RealBase;

    public sealed record Profile(string SteamId, string? Name, string? Avatar);
    public sealed record Comment(string Id, string Author, string? AuthorId, string? Avatar, long Time, string Text);
    public sealed record CommentPage(int Total, int Start, List<Comment> Comments);

    /// Thrown when an action needs the Steam sign-in and there is no usable one (the UI offers "Sign in to …").
    public sealed class SignInRequiredException(string message) : Exception(message);

    // a profile's name and avatar for this run of the backend (a name changes rarely; a restart reads it again)
    static readonly ConcurrentDictionary<string, Profile> _profiles = new();
    static readonly ConcurrentDictionary<string, Task<Profile?>> _profileReads = new();
    // the favourite state per (signed-in account, item), set by a read or by this app's own toggle
    static readonly ConcurrentDictionary<string, bool> _favorites = new();

    public static bool ValidSteamId(string? id) => !string.IsNullOrEmpty(id) && id.Length is >= 15 and <= 20 && id.All(char.IsAsciiDigit) && ulong.TryParse(id, out var n) && n > IndividualBase;

    // ---- the sign-in --------------------------------------------------------------------------------------------------
    /// The usable sign-in's cookie value (URL-encoded once, as the browser sends it) and its Steam ID, else null.
    public static async Task<(string Cookie, ulong SteamId)?> SignInAsync(CancellationToken ct = default)
    {
        var s = SettingsService.Load();
        if (!SteamAuthService.HasUsableSignIn(s)) return null;
        string? raw;
        try { raw = await SteamAuthService.GetCookieAsync(s, ct).ConfigureAwait(false); }
        catch (SteamSignInRejectedException) { return null; }
        catch (Exception e) when (e is not OperationCanceledException) { Console.WriteLine($"community: the sign-in couldn't be used ({e.GetType().Name})"); return null; }
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var plain = Uri.UnescapeDataString(raw.Trim());
        ulong id = s.SteamId;
        if (id == 0)
        {
            // a pasted cookie: "<steamid>||<token>"
            var head = plain.Split("||", 2)[0];
            if (!ulong.TryParse(head, out id)) id = 0;
        }
        return (Uri.EscapeDataString(plain), id);
    }

    public static bool HasSignIn() => SteamAuthService.HasUsableSignIn(SettingsService.Load());

    // ---- requests -----------------------------------------------------------------------------------------------------
    static HttpRequestMessage Request(HttpMethod m, string path, string? cookie, string? sessionId, IDictionary<string, string>? form)
    {
        var req = new HttpRequestMessage(m, Base + path);
        req.Headers.Add("User-Agent", HttpClientProvider.UserAgent);
        if (cookie != null) req.Headers.Add("Cookie", sessionId != null ? $"sessionid={sessionId}; steamLoginSecure={cookie}" : $"steamLoginSecure={cookie}");
        if (form != null) req.Content = new FormUrlEncodedContent(form);
        return req;
    }

    // Through SteamGate (Interactive: the user opened it or clicked it). Steam's 429 or 403 "too many" → the app-wide
    // cooldown, thrown as SteamCooldownException (the endpoint answers 429 with its "try again in N min").
    static async Task<(int Status, string Body)> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        using var _req = req;
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(15));
        using var resp = await SteamGate.SendAsync(req, SteamGate.Kind.Interactive, cts.Token).ConfigureAwait(false);
        var body = await resp.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false);
        int status = (int)resp.StatusCode;
        if (status == 429) throw new SteamCooldownException(SteamGate.CooldownRemaining);
        if (status == 403 && body.Contains("too many", StringComparison.OrdinalIgnoreCase))
        { SteamGate.Trip(); throw new SteamCooldownException(SteamGate.CooldownRemaining); }
        return (status, body);
    }

    static string NewSessionId() => Guid.NewGuid().ToString("N")[..24];

    // ---- favourites ---------------------------------------------------------------------------------------------------
    static readonly Regex _pageSteamId = new(@"g_steamID\s*=\s*(""(\d+)""|false)", RegexOptions.Compiled);

    /// The signed-in account's favourite of the item: true / false, null = couldn't tell (no sign-in, an unreadable page).
    /// `signedIn` false = no usable sign-in here, or Steam no longer accepts it.
    public static async Task<(bool SignedIn, bool? Favorited)> FavoriteStateAsync(string workshopId, CancellationToken ct = default)
    {
        var who = await SignInAsync(ct).ConfigureAwait(false);
        if (who is not { } w) return (false, null);
        var key = $"{w.SteamId}:{workshopId}";
        if (_favorites.TryGetValue(key, out var known)) return (true, known);
        var (status, html) = await SendAsync(Request(HttpMethod.Get, $"/sharedfiles/filedetails/?id={workshopId}", w.Cookie, null, null), ct).ConfigureAwait(false);
        if (status is < 200 or >= 300) { Console.WriteLine($"community: {workshopId}: its page answered {status} — favourite unknown"); return (true, null); }
        var who2 = _pageSteamId.Match(html);
        // the page was served to a visitor: Steam doesn't take this sign-in any more
        if (who2.Success && who2.Groups[1].Value == "false") { Console.WriteLine($"community: {workshopId}: Steam served the page signed out — favourite unknown"); return (false, null); }
        var fav = ParseFavorite(html);
        if (fav is bool f) _favorites[key] = f;
        return (true, fav);
    }

    // The item page's favourite button (#FavoriteItemBtn): `toggled` while the visitor has it in their favourites, and the
    // "Favorited" face (#FavoriteItemOptionFavorited) `selected`. null = no button (not an item page, or not signed in).
    public static bool? ParseFavorite(string html)
    {
        var doc = new HtmlDocument();
        doc.LoadHtml(html);
        var btn = doc.GetElementbyId("FavoriteItemBtn");
        if (btn == null) return null;
        static bool Has(HtmlNode? n, string cls) => n != null && n.GetAttributeValue("class", "").Split(' ', StringSplitOptions.RemoveEmptyEntries).Contains(cls);
        return Has(btn, "toggled") || Has(doc.GetElementbyId("FavoriteItemOptionFavorited"), "selected");
    }

    /// Adds the item to (or removes it from) the signed-in account's Workshop favourites. Throws SignInRequiredException
    /// without a usable sign-in, InvalidOperationException when Steam turns it down.
    public static async Task<bool> SetFavoriteAsync(string workshopId, bool favorite, CancellationToken ct = default)
    {
        var who = await SignInAsync(ct).ConfigureAwait(false) ?? throw new SignInRequiredException("Sign in to Steam to favourite Workshop items (Settings → Getting Workshop wallpapers).");
        var sid = NewSessionId();
        var (status, body) = await SendAsync(Request(HttpMethod.Post, $"/sharedfiles/{(favorite ? "favorite" : "unfavorite")}", who.Cookie, sid,
            new Dictionary<string, string> { ["id"] = workshopId, ["appid"] = AppId, ["sessionid"] = sid }), ct).ConfigureAwait(false);
        // Steam answers an empty 200 (or {"success":1}); a page instead (a sign-in Steam no longer takes is sent to its login
        // page) or any other status means it didn't take
        var t = body.Trim();
        bool ok = status is >= 200 and < 300 && (t.Length == 0 || t == "1" || JsonSuccess(t) == true);
        if (!ok)
        {
            Console.WriteLine($"community: {workshopId}: Steam turned the {(favorite ? "favourite" : "unfavourite")} down ({status})");
            throw new InvalidOperationException("Steam turned that down — your sign-in may have expired. Sign in again under Settings → Getting Workshop wallpapers.");
        }
        _favorites[$"{who.SteamId}:{workshopId}"] = favorite;
        Console.WriteLine($"community: {workshopId}: {(favorite ? "added to" : "removed from")} the Workshop favourites");
        return favorite;
    }

    static bool? JsonSuccess(string body)
    {
        if (!body.StartsWith('{')) return null;
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("success", out var s)) return null;
            return s.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, JsonValueKind.Number => s.GetInt32() == 1, _ => null };
        }
        catch (JsonException) { return null; }
    }

    // ---- comments -----------------------------------------------------------------------------------------------------
    /// One page of the item's comments, newest first (Steam's order): `start` = how many newer ones come before it.
    public static async Task<CommentPage> CommentsAsync(string ownerId, string workshopId, int start, int count, CancellationToken ct = default)
    {
        var (status, body) = await SendAsync(Request(HttpMethod.Post, $"/comment/PublishedFile_Public/render/{ownerId}/{workshopId}/", null, null,
            new Dictionary<string, string> { ["start"] = Math.Max(0, start).ToString(), ["count"] = Math.Clamp(count, 1, 50).ToString(), ["feature2"] = "-1" }), ct).ConfigureAwait(false);
        if (status is < 200 or >= 300) throw new InvalidOperationException($"Steam didn't return the comments ({status})");
        return ParseThread(body, start) ?? throw new InvalidOperationException("Steam didn't return the comments");
    }

    /// Posts a comment as the signed-in account; the answer is the thread's first page (the new comment on top).
    public static async Task<CommentPage> PostCommentAsync(string ownerId, string workshopId, string text, int count, CancellationToken ct = default)
    {
        text = text.Trim();
        if (text.Length == 0) throw new ArgumentException("The comment is empty.");
        if (text.Length > MaxCommentChars) throw new ArgumentException($"A comment holds up to {MaxCommentChars} characters.");
        var who = await SignInAsync(ct).ConfigureAwait(false) ?? throw new SignInRequiredException("Sign in to Steam to comment (Settings → Getting Workshop wallpapers).");
        var sid = NewSessionId();
        var (status, body) = await SendAsync(Request(HttpMethod.Post, $"/comment/PublishedFile_Public/post/{ownerId}/{workshopId}/", who.Cookie, sid,
            new Dictionary<string, string> { ["comment"] = text, ["count"] = Math.Clamp(count, 1, 50).ToString(), ["sessionid"] = sid, ["feature2"] = "-1" }), ct).ConfigureAwait(false);
        if (status is >= 200 and < 300 && JsonSuccess(body.Trim()) == true && ParseThread(body, 0) is { } page)
        {
            Console.WriteLine($"community: {workshopId}: comment posted");
            return page;
        }
        // Steam's own reason when it gives one (too fast, a link it refuses, …); never the request itself
        string? why = null;
        try { using var d = JsonDocument.Parse(body); if (d.RootElement.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String) why = e.GetString(); }
        catch (JsonException) { }
        Console.WriteLine($"community: {workshopId}: Steam turned the comment down ({status})");
        throw new InvalidOperationException(string.IsNullOrWhiteSpace(why)
            ? "Steam turned the comment down — your sign-in may have expired. Sign in again under Settings → Getting Workshop wallpapers."
            : $"Steam turned the comment down: {Plain(why!)}");
    }

    // Steam's thread JSON: {success, start, total_count, comments_html}. The HTML is untrusted: only plain text, the author's
    // name, an http(s) avatar URL, a numeric id and time come out of it.
    static CommentPage? ParseThread(string body, int start)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var r = doc.RootElement;
            if (r.TryGetProperty("success", out var ok) && ok.ValueKind == JsonValueKind.False) return null;
            int total = r.TryGetProperty("total_count", out var tc) && tc.TryGetInt32(out var t) ? t : 0;
            int st = r.TryGetProperty("start", out var s) && s.TryGetInt32(out var si) ? si : start;
            var html = r.TryGetProperty("comments_html", out var h) && h.ValueKind == JsonValueKind.String ? h.GetString() ?? "" : "";
            return new CommentPage(total, st, ParseComments(html));
        }
        catch (JsonException) { return null; }
    }

    public static List<Comment> ParseComments(string html)
    {
        var list = new List<Comment>();
        if (string.IsNullOrWhiteSpace(html)) return list;
        var doc = new HtmlDocument();
        doc.LoadHtml(html);
        var nodes = doc.DocumentNode.SelectNodes("//div[contains(concat(' ', normalize-space(@class), ' '), ' commentthread_comment ')]");
        if (nodes == null) return list;
        foreach (var n in nodes)
        {
            var id = new string(n.GetAttributeValue("id", "").Where(char.IsAsciiDigit).ToArray());
            var author = n.SelectSingleNode(".//a[contains(@class,'commentthread_author_link')]");
            var name = author == null ? "" : Plain(HtmlEntity.DeEntitize(author.InnerText));
            string? authorId = null;
            if (author != null && ulong.TryParse(author.GetAttributeValue("data-miniprofile", ""), out var acct) && acct is > 0 and <= uint.MaxValue)
                authorId = (IndividualBase + acct).ToString();
            var img = n.SelectSingleNode(".//div[contains(@class,'commentthread_comment_avatar')]//img");
            var avatar = img?.GetAttributeValue("src", "") is { } src && Uri.TryCreate(src, UriKind.Absolute, out var au) && au.Scheme is "https" or "http" ? au.ToString() : null;
            var ts = n.SelectSingleNode(".//*[contains(@class,'commentthread_comment_timestamp')]");
            long time = long.TryParse(ts?.GetAttributeValue("data-timestamp", ""), out var tt) ? tt : 0;
            var textNode = n.SelectSingleNode(".//div[contains(@class,'commentthread_comment_text')]");
            var text = textNode == null ? "" : TextOf(textNode);
            if (id.Length == 0 && text.Length == 0) continue;
            list.Add(new Comment(id, name.Length > 0 ? name : "Steam user", authorId, avatar, time, text));
        }
        return list;
    }

    // A comment's text as plain text: line breaks kept (<br>, block elements), an emoticon as its name, every other tag
    // dropped and entities decoded once — nothing of its markup reaches the page.
    static string TextOf(HtmlNode root)
    {
        var sb = new StringBuilder();
        void Walk(HtmlNode n)
        {
            foreach (var c in n.ChildNodes)
            {
                switch (c.NodeType)
                {
                    case HtmlNodeType.Text:
                        sb.Append(Regex.Replace(HtmlEntity.DeEntitize(((HtmlTextNode)c).Text), @"\s+", " "));
                        break;
                    case HtmlNodeType.Element:
                        var tag = c.Name.ToLowerInvariant();
                        if (tag is "script" or "style") break;
                        if (tag == "br") { sb.Append('\n'); break; }
                        if (tag == "img") { var alt = c.GetAttributeValue("alt", ""); if (alt.Length > 0) sb.Append(HtmlEntity.DeEntitize(alt)); break; }
                        bool block = tag is "div" or "p" or "blockquote" or "ul" or "ol" or "li";
                        if (block) sb.Append('\n');
                        Walk(c);
                        if (block) sb.Append('\n');
                        break;
                }
            }
        }
        Walk(root);
        // a dropped tag leaves its neighbours' spaces side by side
        var lines = sb.ToString().Split('\n').Select((l) => Regex.Replace(l, @" {2,}", " ").Trim());
        return Regex.Replace(string.Join("\n", lines), @"\n{3,}", "\n\n").Trim();
    }

    // one line of plain text: no control characters, no markup left by a careless caller
    static string Plain(string s) => Regex.Replace(Regex.Replace(s, @"<[^>]*>", ""), @"[\x00-\x1f\x7f]+", " ").Trim();

    // ---- profiles -----------------------------------------------------------------------------------------------------
    /// A Steam account's name and avatar (its profile's public XML), once per run; null = couldn't read it (not cached).
    public static Task<Profile?> ProfileAsync(string steamId, CancellationToken ct = default)
    {
        if (_profiles.TryGetValue(steamId, out var p)) return Task.FromResult<Profile?>(p);
        // one read per account at a time: the sidebar and the Browse pill can ask together
        return _profileReads.GetOrAdd(steamId, (id) => Task.Run(async () =>
        {
            try
            {
                var (status, xml) = await SendAsync(Request(HttpMethod.Get, $"/profiles/{id}/?xml=1", null, null, null), CancellationToken.None).ConfigureAwait(false);
                if (status is < 200 or >= 300) return null;
                var prof = ParseProfile(id, xml);
                if (prof != null) _profiles[id] = prof;
                return prof;
            }
            catch (SteamCooldownException) { return null; }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException or System.Xml.XmlException)
            { Console.WriteLine($"community: profile {id}: couldn't read it ({e.GetType().Name})"); return null; }
            finally { _profileReads.TryRemove(id, out _); }
        }));
    }

    public static Profile? ParseProfile(string steamId, string xml)
    {
        var doc = XDocument.Parse(xml, LoadOptions.None);
        var root = doc.Root;
        if (root == null || root.Name.LocalName != "profile") return null;
        string? Val(string n) => root.Element(n)?.Value is { } v && v.Trim().Length > 0 ? v.Trim() : null;
        var name = Val("steamID") is { } nm ? Plain(nm) : null;
        var av = Val("avatarMedium") ?? Val("avatarFull") ?? Val("avatarIcon");
        if (av != null && !(Uri.TryCreate(av, UriKind.Absolute, out var u) && u.Scheme is "https" or "http")) av = null;
        return new Profile(steamId, name, av);
    }

    // ---- the signed-in account's favourites page (a private profile's: Steam's client protocol only sees public ones) ----
    static readonly Regex _idRe = new(@"filedetails/\?id=(\d+)", RegexOptions.Compiled);

    /// One page (30) of the signed-in account's Workshop favourites for Wallpaper Engine, as Workshop ids in Steam's order.
    public static async Task<List<string>> MyFavoritesPageAsync(int page, CancellationToken ct = default)
    {
        var who = await SignInAsync(ct).ConfigureAwait(false) ?? throw new SignInRequiredException("Sign in to Steam to see your Workshop favourites (Settings → Getting Workshop wallpapers).");
        var (status, html) = await SendAsync(Request(HttpMethod.Get,
            $"/profiles/{who.SteamId}/myworkshopfiles/?appid={AppId}&browsefilter=myfavorites&numperpage=30&p={Math.Max(1, page)}", who.Cookie, null, null), ct).ConfigureAwait(false);
        if (status is < 200 or >= 300) throw new InvalidOperationException($"Steam didn't return your favourites ({status})");
        var seen = new HashSet<string>();
        return _idRe.Matches(html).Select((m) => m.Groups[1].Value).Where(seen.Add).ToList();
    }
}
