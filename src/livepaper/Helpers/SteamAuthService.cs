using System;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SteamKit2;
using SteamKit2.Authentication;
using livepaper.Models;

namespace livepaper.Helpers;

/// Steam authentication via SteamKit2 for the workshop "Subscribe via Steam" flow.
///
/// QR login (one-time) yields a refresh_token valid ~1 year. From it we mint short-lived
/// access_tokens (~24h) on demand; the steamLoginSecure cookie used by the community
/// subscribe endpoint is `{steamid}||{access_token}`. So the user signs in once a year, and
/// the cookie is always kept fresh automatically — no daily re-paste.
public static class SteamAuthService
{
    private static readonly SemaphoreSlim _mintGate = new(1, 1);

    /// Begins a QR auth session. Invokes onQrUrl with the challenge URL (and again whenever Steam
    /// refreshes it), then blocks until the user approves in the Steam mobile app. Returns the
    /// long-lived refresh token + the account's SteamID and name.
    public static async Task<(string RefreshToken, ulong SteamId, string AccountName)> LoginViaQrAsync(
        Action<string> onQrUrl, CancellationToken ct)
    {
        var steamClient = new SteamClient();
        var manager = new CallbackManager(steamClient);
        var tcs = new TaskCompletionSource<(string, ulong, string)>(TaskCreationOptions.RunContinuationsAsynchronously);

        manager.Subscribe<SteamClient.ConnectedCallback>(cb => { _ = RunQrAsync(); });
        manager.Subscribe<SteamClient.DisconnectedCallback>(_ =>
            tcs.TrySetException(new InvalidOperationException("Disconnected from Steam before sign-in completed.")));

        async Task RunQrAsync()
        {
            try
            {
                // WebBrowser platform → the refresh token can derive web-session cookies via
                // finalizelogin (required for community subscribe; the SteamClient token's
                // steamid||accesstoken shortcut is rejected by the website).
                var auth = await steamClient.Authentication.BeginAuthSessionViaQRAsync(new AuthSessionDetails
                {
                    PlatformType = SteamKit2.Internal.EAuthTokenPlatformType.k_EAuthTokenPlatformType_WebBrowser,
                    WebsiteID = "Community",
                });
                auth.ChallengeURLChanged = () => onQrUrl(auth.ChallengeURL);
                onQrUrl(auth.ChallengeURL);
                var poll = await auth.PollingWaitForResultAsync(ct);
                ulong steamId = SteamIdFromJwt(poll.RefreshToken);
                tcs.TrySetResult((poll.RefreshToken, steamId, poll.AccountName));
            }
            catch (Exception ex) { tcs.TrySetException(ex); }
        }

        steamClient.Connect();
        using var reg = ct.Register(() => tcs.TrySetCanceled());
        _ = Task.Run(() =>
        {
            while (!tcs.Task.IsCompleted)
                manager.RunWaitCallbacks(TimeSpan.FromMilliseconds(500));
        });

        try { return await tcs.Task; }
        finally { try { steamClient.Disconnect(); } catch { } }
    }

    /// Derives a real web-session steamLoginSecure cookie from a WebBrowser refresh token, via
    /// Steam's finalizelogin → settokens flow (the same calls a browser login performs). The
    /// resulting cookie value (steamid||webtoken, URL-encoded) is what steamcommunity.com accepts.
    private static async Task<string> GetWebCookieAsync(string refreshToken, ulong steamId, CancellationToken ct)
    {
        string sessionId = Guid.NewGuid().ToString("N")[..24];

        // 1) finalizelogin: exchange the refresh token for transfer params.
        using var finalizeReq = new HttpRequestMessage(HttpMethod.Post,
            "https://login.steampowered.com/jwt/finalizelogin");
        finalizeReq.Headers.Add("User-Agent", HttpClientProvider.UserAgent);
        finalizeReq.Headers.Add("Origin", "https://steamcommunity.com");
        finalizeReq.Headers.Referrer = new Uri("https://steamcommunity.com/");
        finalizeReq.Content = new MultipartFormDataContent
        {
            { new StringContent(refreshToken), "nonce" },
            { new StringContent(sessionId), "sessionid" },
            { new StringContent("https://steamcommunity.com/login/home/?goto="), "redir" },
        };

        using var finalizeResp = await HttpClientProvider.Client.SendAsync(finalizeReq, ct);
        var finalizeJson = await finalizeResp.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(finalizeJson);
        var root = doc.RootElement;
        if (root.TryGetProperty("error", out var err) && err.GetInt32() != 0)
            throw new InvalidOperationException($"Steam finalizelogin failed (EResult {err.GetInt32()}).");
        if (!root.TryGetProperty("transfer_info", out var transfers))
            throw new InvalidOperationException("Steam finalizelogin returned no transfer_info.");

        // 2) settokens: POST the steamcommunity transfer to receive the steamLoginSecure cookie.
        foreach (var t in transfers.EnumerateArray())
        {
            var url = t.GetProperty("url").GetString() ?? "";
            if (!url.Contains("steamcommunity.com", StringComparison.OrdinalIgnoreCase)) continue;

            var form = new MultipartFormDataContent { { new StringContent(steamId.ToString()), "steamID" } };
            if (t.TryGetProperty("params", out var prms))
                foreach (var p in prms.EnumerateObject())
                    form.Add(new StringContent(p.Value.GetString() ?? ""), p.Name);

            using var setReq = new HttpRequestMessage(HttpMethod.Post, url) { Content = form };
            setReq.Headers.Add("User-Agent", HttpClientProvider.UserAgent);
            using var setResp = await HttpClientProvider.Client.SendAsync(setReq, ct);

            if (setResp.Headers.TryGetValues("Set-Cookie", out var cookies))
                foreach (var c in cookies)
                    if (c.StartsWith("steamLoginSecure=", StringComparison.OrdinalIgnoreCase))
                    {
                        var val = c.Substring("steamLoginSecure=".Length);
                        int semi = val.IndexOf(';');
                        return semi >= 0 ? val[..semi] : val;
                    }
        }
        throw new InvalidOperationException("Steam settokens returned no steamLoginSecure cookie.");
    }

    /// Returns a currently-valid steamLoginSecure cookie value, refreshing it via finalizelogin when
    /// the cached one is missing/expired. Falls back to a manually-pasted cookie when no refresh
    /// token is stored. Returns null if no auth is configured. Persists the refreshed cookie.
    public static async Task<string?> GetCookieAsync(AppSettings settings, CancellationToken ct = default)
    {
        // No QR sign-in → use manual cookie paste if present (back-compat / advanced).
        if (string.IsNullOrWhiteSpace(settings.SteamRefreshToken) || settings.SteamId == 0)
            return string.IsNullOrWhiteSpace(settings.SteamLoginSecure) ? null : settings.SteamLoginSecure.Trim();

        await _mintGate.WaitAsync(ct);
        try
        {
            // Reuse cached cookie until ~5 min before the embedded token's expiry.
            if (!string.IsNullOrEmpty(settings.SteamAccessToken)
                && JwtExpiryUtc(TokenPart(settings.SteamAccessToken)) is DateTime exp
                && exp > DateTime.UtcNow.AddMinutes(5))
            {
                return settings.SteamAccessToken;
            }

            var cookie = await GetWebCookieAsync(settings.SteamRefreshToken, settings.SteamId, ct);
            settings.SteamAccessToken = cookie; // full steamLoginSecure value (steamid||webtoken)
            SettingsService.Save(settings);
            MaybeRenewRefreshTokenInBackground(settings);
            return cookie;
        }
        finally { _mintGate.Release(); }
    }

    /// Days until the stored refresh token expires (null if unknown / not signed in). When this hits
    /// 0 the user must re-sign-in; renewal below tries to keep it well above 0.
    public static int? RefreshTokenDaysRemaining(AppSettings settings)
    {
        if (string.IsNullOrEmpty(settings.SteamRefreshToken)) return null;
        if (JwtExpiryUtc(settings.SteamRefreshToken) is not DateTime exp) return null;
        return Math.Max(0, (int)Math.Ceiling((exp - DateTime.UtcNow).TotalDays));
    }

    private static int _renewing;

    /// Best-effort refresh-token renewal: when the stored refresh token is within 90 days of expiry,
    /// log on with it and ask Steam for a renewed one (rolls the ~200-day window forward). Validated
    /// before adoption (later expiry, same SteamID) and fully swallows errors — if Steam won't renew
    /// (or won't log on a WebBrowser token), nothing changes and normal expiry + re-login applies.
    private static void MaybeRenewRefreshTokenInBackground(AppSettings settings)
    {
        if (JwtExpiryUtc(settings.SteamRefreshToken) is not DateTime exp) return;
        if (exp > DateTime.UtcNow.AddDays(90)) return;
        if (Interlocked.CompareExchange(ref _renewing, 1, 0) != 0) return;

        _ = Task.Run(async () =>
        {
            try { await TryRenewAsync(settings); }
            catch { }
            finally { Interlocked.Exchange(ref _renewing, 0); }
        });
    }

    private static async Task TryRenewAsync(AppSettings settings)
    {
        var steamClient = new SteamClient();
        var manager = new CallbackManager(steamClient);
        var steamUser = steamClient.GetHandler<SteamUser>()!;
        var tcs = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        manager.Subscribe<SteamClient.ConnectedCallback>(cb =>
            steamUser.LogOn(new SteamUser.LogOnDetails { Username = settings.SteamAccountName, AccessToken = settings.SteamRefreshToken }));
        manager.Subscribe<SteamClient.DisconnectedCallback>(cb => tcs.TrySetResult(null));
        manager.Subscribe<SteamUser.LoggedOnCallback>(cb => { _ = OnLoggedOn(cb); });

        async Task OnLoggedOn(SteamUser.LoggedOnCallback cb)
        {
            try
            {
                if (cb.Result != EResult.OK) { tcs.TrySetResult(null); return; }
                var res = await steamClient.Authentication.GenerateAccessTokenForAppAsync(
                    cb.ClientSteamID, settings.SteamRefreshToken, allowRenewal: true);
                tcs.TrySetResult(string.IsNullOrEmpty(res.RefreshToken) ? null : res.RefreshToken);
            }
            catch { tcs.TrySetResult(null); }
        }

        steamClient.Connect();
        using var reg = timeout.Token.Register(() => tcs.TrySetResult(null));
        _ = Task.Run(() =>
        {
            while (!tcs.Task.IsCompleted)
                manager.RunWaitCallbacks(TimeSpan.FromMilliseconds(500));
        });

        string? newRt;
        try { newRt = await tcs.Task; }
        finally { try { steamUser.LogOff(); steamClient.Disconnect(); } catch { } }
        if (newRt == null) return;

        // Adopt only if the renewed token is genuinely better and ours.
        var newExp = JwtExpiryUtc(newRt);
        var oldExp = JwtExpiryUtc(settings.SteamRefreshToken);
        if (newExp == null || (oldExp != null && newExp <= oldExp)) return;
        if (SteamIdFromJwt(newRt) != settings.SteamId) return;

        settings.SteamRefreshToken = newRt;
        SettingsService.Save(settings);
    }

    // The token portion of a `steamid||token` (or url-encoded) steamLoginSecure value.
    private static string TokenPart(string cookieValue)
    {
        var v = Uri.UnescapeDataString(cookieValue);
        int sep = v.IndexOf("||", StringComparison.Ordinal);
        return sep >= 0 ? v[(sep + 2)..] : v;
    }

    // --- JWT helpers (Steam tokens are JWTs; we only need exp + sub, no signature check) ---------

    private static ulong SteamIdFromJwt(string jwt)
    {
        var payload = DecodeJwtPayload(jwt);
        if (payload.TryGetProperty("sub", out var sub) && ulong.TryParse(sub.GetString(), out var id))
            return id;
        return 0;
    }

    private static DateTime? JwtExpiryUtc(string jwt)
    {
        try
        {
            var payload = DecodeJwtPayload(jwt);
            if (payload.TryGetProperty("exp", out var exp) && exp.TryGetInt64(out var unix))
                return DateTimeOffset.FromUnixTimeSeconds(unix).UtcDateTime;
        }
        catch { }
        return null;
    }

    private static JsonElement DecodeJwtPayload(string jwt)
    {
        var parts = jwt.Split('.');
        if (parts.Length < 2) throw new FormatException("Not a JWT");
        string b64 = parts[1].Replace('-', '+').Replace('_', '/');
        switch (b64.Length % 4) { case 2: b64 += "=="; break; case 3: b64 += "="; break; }
        var json = Encoding.UTF8.GetString(Convert.FromBase64String(b64));
        return JsonDocument.Parse(json).RootElement.Clone();
    }
}
