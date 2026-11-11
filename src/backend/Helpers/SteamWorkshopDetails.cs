using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using SteamKit2;
using SteamKit2.Internal;

namespace Liascape.Helpers;

// Workshop item details over Steam's own client connection (the CM protocol the Steam client — and so Wallpaper Engine —
// talks), ANONYMOUSLY: no account, no Web API key, no web page. `PublishedFile.GetDetails` with
// `includeadditionalpreviews` carries each item's YouTube preview ids, 100 items a request (owner 2026-11-11 asked for
// faster trailer lookups: tested 2026-11-11 — an anonymous session returned all 6 known trailers in one 355 ms request;
// the web API's `IPublishedFileService/GetDetails` needs a key or a signed-in token, the keyless
// `GetPublishedFileDetails` has no previews, and reading Workshop pages trips steamcommunity.com's per-IP limit).
// One short session per call: connect, log on anonymously, the batches (BatchSize apart by BatchGapMs), log off.
// Returns null when Steam's servers can't be reached / refuse the logon (the caller falls back to page reading).
public static class SteamWorkshopDetails
{
    private const int BatchSize = 100, BatchGapMs = 1000, TimeoutSeconds = 60;

    // per item: Found = Steam answered for it (result 1), Youtube = its first YouTube preview id (null = none).
    // An item Steam couldn't answer for (removed, private: result ≠ 1) is Found=false.
    public readonly record struct Trailer(bool Found, string? Youtube);

    public static async Task<Dictionary<ulong, Trailer>?> GetTrailersAsync(IReadOnlyList<ulong> ids, CancellationToken ct = default)
    {
        if (ids.Count == 0) return [];
        var client = new SteamClient();
        var manager = new CallbackManager(client);
        var user = client.GetHandler<SteamUser>()!;
        var pub = client.GetHandler<SteamUnifiedMessages>()!.CreateService<PublishedFile>();
        var tcs = new TaskCompletionSource<Dictionary<ulong, Trailer>?>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(TimeoutSeconds));

        manager.Subscribe<SteamClient.ConnectedCallback>(_ => user.LogOnAnonymous());
        manager.Subscribe<SteamClient.DisconnectedCallback>(_ => tcs.TrySetResult(null));
        manager.Subscribe<SteamUser.LoggedOnCallback>(cb => { _ = OnLoggedOn(cb); });

        async Task OnLoggedOn(SteamUser.LoggedOnCallback cb)
        {
            try
            {
                if (cb.Result != EResult.OK) { tcs.TrySetResult(null); return; }
                var all = new Dictionary<ulong, Trailer>();
                for (int i = 0; i < ids.Count; i += BatchSize)
                {
                    if (i > 0) await Task.Delay(BatchGapMs, timeout.Token).ConfigureAwait(false);
                    var req = new CPublishedFile_GetDetails_Request { includeadditionalpreviews = true, appid = 431960 };
                    req.publishedfileids.AddRange(ids.Skip(i).Take(BatchSize));
                    var resp = await pub.GetDetails(req); // an AsyncJob (no ConfigureAwait)
                    if (resp.Result != EResult.OK) { tcs.TrySetResult(all.Count > 0 ? all : null); return; }
                    foreach (var d in resp.Body.publishedfiledetails)
                        all[d.publishedfileid] = d.result == (int)EResult.OK
                            ? new Trailer(true, d.previews.FirstOrDefault(p => !string.IsNullOrEmpty(p.youtubevideoid))?.youtubevideoid)
                            : new Trailer(false, null);
                }
                tcs.TrySetResult(all);
            }
            catch { tcs.TrySetResult(null); }
            finally { try { user.LogOff(); client.Disconnect(); } catch { } }
        }

        using var reg = timeout.Token.Register(() => tcs.TrySetResult(null));
        client.Connect();
        _ = Task.Run(() =>
        {
            while (!tcs.Task.IsCompleted) manager.RunWaitCallbacks(TimeSpan.FromMilliseconds(250));
        });
        var result = await tcs.Task.ConfigureAwait(false);
        try { client.Disconnect(); } catch { }
        return result;
    }
}
