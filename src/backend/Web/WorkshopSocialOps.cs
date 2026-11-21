using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Microsoft.AspNetCore.Http;

namespace Liascape.Web;

// The Workshop community pieces of the Browse and Library sidebars — the creator (name + avatar), the favourite toggle, the
// comment thread, the item's current counts, a preset's base — behind thin endpoints (ServerHost): the calls are Helpers/SteamCommunity.cs'.
// Reading works signed out; favouriting and posting need the sign-in (403 {error, signIn: true}, the UI's "Sign in to …").
// Steam's cooldown → 429 (the error middleware), Steam unreachable or refusing → 502 {error}: the sidebar shows a quiet line,
// never a crash.
public static class WorkshopSocialOps
{
    // an item's creator for this run (the comment thread is addressed by it; an item never changes creator)
    static readonly ConcurrentDictionary<string, string> _owners = new();
    // An item's details from Steam's client protocol (its creator, its counts) — one GetDetails per item however many asks
    // land together (the Library sidebar asks for the creator and the counts at once), kept DetailsFreshFor: the counts are
    // "current", and Steam's servers aren't the rate-limited community site, so a reopened sidebar a while later asks again.
    // A failed ask is dropped at once (asked again next time; SteamAnonymous waits out its own retry gap).
    // Guard: scripts/test-workshop-social.sh § counts, § 5 (a preset's base)
    static readonly TimeSpan DetailsFreshFor = TimeSpan.FromMinutes(15);
    // Lazy: ConcurrentDictionary may run a value factory on two racing threads (keeping one result); only the stored entry's
    // ask is ever started
    static readonly ConcurrentDictionary<ulong, (DateTime At, Lazy<Task<SteamWorkshopDetails.Details?>> Task)> _details = new();

    static async Task<SteamWorkshopDetails.Details?> DetailsAsync(ulong id, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var e = _details.AddOrUpdate(id, (_) => (now, new(() => Ask(id))), (_, old) => now - old.At < DetailsFreshFor ? old : (now, new(() => Ask(id))));
        // the ask itself isn't the request's: a closed sidebar mustn't cancel the answer another one is waiting for
        var d = await e.Task.Value.WaitAsync(ct).ConfigureAwait(false);
        if (d == null) _details.TryRemove(new(id, e));
        return d;
    }

    static async Task<SteamWorkshopDetails.Details?> Ask(ulong id)
    {
        var got = await SteamWorkshopDetails.GetDetailsAsync([id]).ConfigureAwait(false);
        // Steam answered and has no such public item: a real answer (kept); unreachable: null (not kept)
        if (got == null) return null;
        if (!got.TryGetValue(id, out var d)) return new SteamWorkshopDetails.Details(false, null, []);
        // an opened Library sidebar's fresh counts update the cached copy a local sort of a list reads
        // Guard: scripts/test-workshop-social.sh § 6 "a Library sidebar's counts refresh the cached copy"
        if (d.Found && d.File is { } f) WorkshopDetailsCache.Refresh(f with { Id = id.ToString() });
        return d;
    }

    static IResult Fail(Exception e) => e switch
    {
        SteamCommunity.SignInRequiredException => Results.Json(new { error = e.Message, signIn = true }, statusCode: 403),
        ArgumentException => Results.Json(new { error = e.Message }, statusCode: 400),
        SteamCooldownException => Results.Json(new { error = e.Message }, statusCode: 429),
        HttpRequestException or TaskCanceledException => Results.Json(new { error = "Couldn't reach Steam" }, statusCode: 502),
        _ => Results.Json(new { error = e.Message }, statusCode: 502),
    };

    // The item's creator: the caller's (a Workshop result carries it), else asked of Steam's client protocol once per run.
    static async Task<string?> OwnerAsync(string workshopId, string? hint, CancellationToken ct)
    {
        if (SteamCommunity.ValidSteamId(hint)) return _owners[workshopId] = hint!;
        if (_owners.TryGetValue(workshopId, out var o)) return o;
        if (!ulong.TryParse(workshopId, out var n)) return null;
        if (await DetailsAsync(n, ct).ConfigureAwait(false) is not { Found: true, Creator: > 0 } d) return null;
        return _owners[workshopId] = d.Creator.ToString();
    }

    /// GET /workshop/counts?id= → {subscriptions, favorites}: Steam's current counts (the Library sidebar's stat pills; a Browse
    /// result carries its own). 404 = Steam has no public item with that id; 502 = Steam's servers couldn't be asked.
    public static async Task<IResult> CountsAsync(string? id, CancellationToken ct)
    {
        if (!WorkshopSubOps.ValidId(id) || !ulong.TryParse(id, out var n)) return Results.BadRequest(new { error = "id must be digits" });
        try
        {
            return await DetailsAsync(n, ct).ConfigureAwait(false) switch
            {
                null => Results.Json(new { error = "Couldn't reach Steam" }, statusCode: 502),
                { Found: false } => Results.Json(new { error = "Steam has no public item with this id" }, statusCode: 404),
                var d => Results.Json(new { subscriptions = d.Value.Subscriptions, favorites = d.Value.Favorites }),
            };
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested) { return Fail(e); }
    }

    // the most ids one /workshop/details takes: a whole favourites list in one ask (GetDetailsAsync splits it into Steam's
    // 1000-id requests); a bigger one is a caller's bug
    // Guard: scripts/test-workshop-social.sh § 6 "details: 2001 ids → 400"
    const int DetailsBatchMax = 2000;

    /// POST /workshop/details {ids} → {items: WallpaperResult[]} in the asked order: each item's details from the on-disk cache,
    /// the rest asked of Steam in one go (Helpers/WorkshopDetailsCache.cs). Ids Steam has no public item for, or that
    /// couldn't be asked (Steam unreachable), and unplayable items are left out. More than 2000 ids or a non-digit id → 400,
    /// nothing asked.
    /// Guard: scripts/test-workshop-social.sh § 6
    public static async Task<IResult> DetailsBatchAsync(List<string>? ids, CancellationToken ct)
    {
        ids ??= [];
        if (ids.Count > DetailsBatchMax) return Results.BadRequest(new { error = $"at most {DetailsBatchMax} ids" });
        if (!ids.All(WorkshopSubOps.ValidId)) return Results.BadRequest(new { error = "ids must be digits" });
        var got = await WorkshopDetailsCache.GetAsync(ids, ct).ConfigureAwait(false);
        return Results.Json(new { items = Scrapers.SteamWorkshopScraper.MapToResults(ids, got, allowScenes: true, allowPresets: true) });
    }

    /// GET /workshop/my-favorites?sync=none|open|check → {signedIn: false} without a usable sign-in (nothing sent), else
    /// {signedIn: true, version, loading: {done, total} | null, error, items}: the signed-in account's own cached favourites
    /// (Helpers/WorkshopFavorites.cs) that have details in the details cache, in the list's order, web / application left
    /// out, each with its creator's name only when this run already knows it. `open` and `check` start a sync in the
    /// background; the page follows it through the `workshop-favorites` event and re-reads with `none`.
    // Guard: scripts/test-workshop-social.sh § 7
    public static Task<IResult> MyFavoritesAsync(string? sync, CancellationToken ct)
    {
        sync ??= "none";
        if (sync is not ("none" or "open" or "check")) return Task.FromResult(Results.BadRequest(new { error = "sync must be none, open or check" }));
        var account = SteamCommunity.SignedInAccount();
        if (account == 0) return Task.FromResult(Results.Json(new { signedIn = false }));
        if (sync != "none") WorkshopFavorites.Sync(account);
        var v = WorkshopFavorites.Get(account);
        var details = new Dictionary<string, Scrapers.SteamWorkshopScraper.PublishedFileDetail>();
        foreach (var id in v.Ids)
            if (WorkshopDetailsCache.TryGet(id, out var d)) details[id] = d;
        var items = Scrapers.SteamWorkshopScraper.MapToResults(v.Ids, details, allowScenes: true, allowPresets: true, authorName: SteamCommunity.KnownName);
        return Task.FromResult(Results.Json(new { signedIn = true, version = v.Version, loading = v.Loading, error = v.Error, items }));
    }

    public sealed record PresetBaseInfo(string BaseId, string? Title, string? Kind);

    // A Workshop preset's base: the item Steam lists as the preset's required one (its first child; a preset names one),
    // with the base's title and kind (`KindOf` its tags). null = not a preset, or one naming no base. Both asks go through
    // the details cache above (kept DetailsFreshFor, a failed ask not kept); Steam unreachable → HttpRequestException (502).
    // Guard: scripts/test-workshop-social.sh § 5
    public static async Task<PresetBaseInfo?> BaseOfAsync(string presetId, CancellationToken ct)
    {
        if (!ulong.TryParse(presetId, out var id)) return null;
        var preset = await DetailsAsync(id, ct).ConfigureAwait(false) ?? throw new HttpRequestException("Couldn't reach Steam");
        if (!preset.Found || !WorkshopTags.IsPreset(preset.Tags) || preset.Children is not [var baseId, ..]) return null;
        var b = await DetailsAsync(baseId, ct).ConfigureAwait(false) ?? throw new HttpRequestException("Couldn't reach Steam");
        return new(baseId.ToString(), b.Found ? b.Title : null, b.Found ? KindOf(b.Tags) : null);
    }

    // an item's kind from its Workshop tags: "preset" first (Steam tags a preset with its base's type too), then its type
    // tag lowercased (scene, video, web, application); null = no type tag
    internal static string? KindOf(IReadOnlyCollection<string> tags) =>
        WorkshopTags.IsPreset(tags) ? "preset"
        : new[] { "Scene", "Video", "Web", "Application" }.FirstOrDefault((t) => tags.Contains(t, StringComparer.OrdinalIgnoreCase))?.ToLowerInvariant();

    /// GET /workshop/base?id= → {baseId, title, kind, libraryPath}: a preset's base from Steam (title / kind null when Steam
    /// has no such public item), its library folder (Presets.BaseDirOf; null = not in the library). 404 = not a preset.
    public static async Task<IResult> BaseAsync(string? id, CancellationToken ct)
    {
        if (!WorkshopSubOps.ValidId(id)) return Results.BadRequest(new { error = "id must be digits" });
        try
        {
            if (await BaseOfAsync(id!, ct).ConfigureAwait(false) is not { } b)
                return Results.Json(new { error = "Steam lists no base for this item: it isn't a preset" }, statusCode: 404);
            return Results.Json(new { baseId = b.BaseId, title = b.Title, kind = b.Kind, libraryPath = Presets.BaseDirOf(b.BaseId) });
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested) { return Fail(e); }
    }

    /// GET /workshop/creator?id=&owner= → {steamId, name, avatar}; name / avatar null when the profile couldn't be read.
    public static async Task<IResult> CreatorAsync(string? id, string? owner, CancellationToken ct)
    {
        if (!WorkshopSubOps.ValidId(id)) return Results.BadRequest(new { error = "id must be digits" });
        try
        {
            var who = await OwnerAsync(id!, owner, ct).ConfigureAwait(false);
            if (who == null) return Results.Json(new { error = "The creator isn't known" }, statusCode: 404);
            var p = await SteamCommunity.ProfileAsync(who, ct).ConfigureAwait(false);
            return Results.Json(new { steamId = who, name = p?.Name, avatar = p?.Avatar });
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested) { return Fail(e); }
    }

    /// GET /workshop/favorite?id= → {signedIn, favorited (null = unknown)}
    public static async Task<IResult> FavoriteStateAsync(string? id, CancellationToken ct)
    {
        if (!WorkshopSubOps.ValidId(id)) return Results.BadRequest(new { error = "id must be digits" });
        try
        {
            var (signedIn, fav) = await SteamCommunity.FavoriteStateAsync(id!, ct).ConfigureAwait(false);
            return Results.Json(new { signedIn, favorited = fav });
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested) { return Fail(e); }
    }

    /// POST /workshop/favorite {workshopId, favorite} → {favorited}
    public static async Task<IResult> SetFavoriteAsync(string? id, bool favorite, CancellationToken ct)
    {
        if (!WorkshopSubOps.ValidId(id)) return Results.BadRequest(new { error = "workshopId must be digits" });
        try { return Results.Json(new { favorited = await SteamCommunity.SetFavoriteAsync(id!, favorite, ct).ConfigureAwait(false) }); }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested) { return Fail(e); }
    }

    /// GET /workshop/comments?id=&owner=&start=&count= → {signedIn, total, start, comments: [{id, author, authorId, avatar, time, text}]}
    public static async Task<IResult> CommentsAsync(string? id, string? owner, int start, int count, CancellationToken ct)
    {
        if (!WorkshopSubOps.ValidId(id)) return Results.BadRequest(new { error = "id must be digits" });
        try
        {
            var who = await OwnerAsync(id!, owner, ct).ConfigureAwait(false);
            if (who == null) return Results.Json(new { error = "Steam didn't say who made this item" }, statusCode: 404);
            var page = await SteamCommunity.CommentsAsync(who, id!, start, count <= 0 ? 10 : count, ct).ConfigureAwait(false);
            return Results.Json(new { signedIn = SteamCommunity.HasSignIn(), owner = who, total = page.Total, start = page.Start, comments = page.Comments });
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested) { return Fail(e); }
    }

    /// POST /workshop/comment {workshopId, owner, text, count} → the thread's first page, the new comment on top
    public static async Task<IResult> PostCommentAsync(string? id, string? owner, string? text, int count, CancellationToken ct)
    {
        if (!WorkshopSubOps.ValidId(id)) return Results.BadRequest(new { error = "workshopId must be digits" });
        try
        {
            var who = await OwnerAsync(id!, owner, ct).ConfigureAwait(false);
            if (who == null) return Results.Json(new { error = "Steam didn't say who made this item" }, statusCode: 404);
            var page = await SteamCommunity.PostCommentAsync(who, id!, text ?? "", count <= 0 ? 10 : count, ct).ConfigureAwait(false);
            return Results.Json(new { signedIn = true, owner = who, total = page.Total, start = page.Start, comments = page.Comments });
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested) { return Fail(e); }
    }
}
