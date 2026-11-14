using System;
using System.Collections.Concurrent;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Microsoft.AspNetCore.Http;

namespace Liascape.Web;

// The Browse sidebar's Workshop community pieces — the creator (name + avatar), the favourite toggle, the comment thread —
// behind thin endpoints (ServerHost): the calls are Helpers/SteamCommunity.cs'. Reading works signed out; favouriting and
// posting need the sign-in (403 {error, signIn: true}, the UI's "Sign in to …"). Steam's cooldown → 429 (the error middleware),
// Steam unreachable or refusing → 502 {error}: the sidebar shows a quiet line, never a crash.
public static class WorkshopSocialOps
{
    // an item's creator for this run (the comment thread is addressed by it; an item never changes creator)
    static readonly ConcurrentDictionary<string, string> _owners = new();

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
        var got = await SteamWorkshopDetails.GetDetailsAsync([n], ct).ConfigureAwait(false);
        if (got == null || !got.TryGetValue(n, out var d) || !d.Found || d.Creator == 0) return null;
        return _owners[workshopId] = d.Creator.ToString();
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
