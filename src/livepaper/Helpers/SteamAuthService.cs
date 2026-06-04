using System;
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
                var auth = await steamClient.Authentication.BeginAuthSessionViaQRAsync(new AuthSessionDetails());
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

    /// Mints a fresh access token from the stored refresh token. Mirrors SteamKit2's WebCookie
    /// sample: connect → log on with the refresh token → GenerateAccessTokenForApp inside the
    /// LoggedOn callback. Generating without logging on first returns AccessDenied.
    private static async Task<(ulong SteamId, string AccessToken)> MintAsync(
        string accountName, string refreshToken, CancellationToken ct)
    {
        var steamClient = new SteamClient();
        var manager = new CallbackManager(steamClient);
        var steamUser = steamClient.GetHandler<SteamUser>()!;
        var tcs = new TaskCompletionSource<(ulong, string)>(TaskCreationOptions.RunContinuationsAsynchronously);

        manager.Subscribe<SteamClient.ConnectedCallback>(cb =>
            steamUser.LogOn(new SteamUser.LogOnDetails { Username = accountName, AccessToken = refreshToken }));
        manager.Subscribe<SteamClient.DisconnectedCallback>(cb =>
            tcs.TrySetException(new InvalidOperationException("Disconnected from Steam before token refresh completed.")));
        manager.Subscribe<SteamUser.LoggedOnCallback>(cb => { _ = OnLoggedOn(cb); });

        async Task OnLoggedOn(SteamUser.LoggedOnCallback cb)
        {
            try
            {
                if (cb.Result != EResult.OK)
                {
                    tcs.TrySetException(new InvalidOperationException($"Steam logon failed: {cb.Result}"));
                    return;
                }
                var res = await steamClient.Authentication.GenerateAccessTokenForAppAsync(
                    cb.ClientSteamID, refreshToken, allowRenewal: false);
                tcs.TrySetResult((cb.ClientSteamID.ConvertToUInt64(), res.AccessToken));
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
        finally { try { steamUser.LogOff(); steamClient.Disconnect(); } catch { } }
    }

    /// Returns a currently-valid steamLoginSecure cookie value, minting a fresh access token if the
    /// cached one is missing/expired. Falls back to a manually-pasted cookie when no refresh token
    /// is stored. Returns null if no auth is configured. Persists any newly minted token.
    public static async Task<string?> GetCookieAsync(AppSettings settings, CancellationToken ct = default)
    {
        // No QR sign-in → use manual cookie paste if present (back-compat / advanced).
        if (string.IsNullOrWhiteSpace(settings.SteamRefreshToken) || settings.SteamId == 0)
            return string.IsNullOrWhiteSpace(settings.SteamLoginSecure) ? null : settings.SteamLoginSecure.Trim();

        await _mintGate.WaitAsync(ct);
        try
        {
            // Reuse cached access token until ~5 min before expiry.
            if (!string.IsNullOrEmpty(settings.SteamAccessToken)
                && JwtExpiryUtc(settings.SteamAccessToken) is DateTime exp
                && exp > DateTime.UtcNow.AddMinutes(5))
            {
                return $"{settings.SteamId}||{settings.SteamAccessToken}";
            }

            var (steamId, token) = await MintAsync(settings.SteamAccountName, settings.SteamRefreshToken, ct);
            settings.SteamAccessToken = token;
            if (steamId != 0) settings.SteamId = steamId;
            SettingsService.Save(settings);
            return $"{settings.SteamId}||{token}";
        }
        finally { _mintGate.Release(); }
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
