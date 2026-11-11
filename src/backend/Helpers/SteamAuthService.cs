using System;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SteamKit2;
using SteamKit2.Authentication;
using Liascape.Models;

namespace Liascape.Helpers;

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

    /// What a password sign-in asks of the user while it runs (docs/decisions.md § "Offer a password sign-in beside the
    /// QR" — the QR needs the Steam mobile app). Web/SteamOps turns each call into a WS event and
    /// waits for the user's answer (POST /steam/login/code).
    public interface ILoginPrompt
    {
        /// Steam wants a code: `email` (Steam Guard by email; `hint` = the address's domain Steam names) or `device` (the
        /// mobile authenticator's code). `retry` = the previous one was wrong. Returns the code the user typed.
        Task<string> AskCodeAsync(string kind, string? hint, bool retry, CancellationToken ct);
        /// Steam wants the sign-in approved in the Steam mobile app; the user may type the app's code instead
        /// (<paramref name="sendCode"/> hands it to Steam: false = it was wrong).
        void AwaitConfirmation(Func<string, Task<bool>> sendCode);
    }

    /// Username + password sign-in (WebBrowser platform + the "Community" website, like the QR one, so finalizelogin can mint
    /// the steamLoginSecure cookie from the refresh token). The password is handed to Steam once — SteamKit2 encrypts it with
    /// Steam's RSA key in BeginAuthSessionViaCredentials — and this method drops its reference right after (<paramref
    /// name="takePassword"/> is called once and the caller clears its copy then); it is never logged, stored or kept
    /// for the rest of the sign-in. Throws <see cref="SteamLoginException"/> with a message for the user.
    public static async Task<(string RefreshToken, ulong SteamId, string AccountName)> LoginViaCredentialsAsync(
        string username, Func<string> takePassword, ILoginPrompt prompt, CancellationToken ct)
    {
        var steamClient = new SteamClient();
        var manager = new CallbackManager(steamClient);
        var tcs = new TaskCompletionSource<(string, ulong, string)>(TaskCreationOptions.RunContinuationsAsynchronously);

        bool connected = false;
        manager.Subscribe<SteamClient.ConnectedCallback>(cb => { connected = true; _ = RunAsync(); });
        manager.Subscribe<SteamClient.DisconnectedCallback>(_ =>
            tcs.TrySetException(new SteamLoginException(connected
                ? "Lost the connection to Steam before the sign-in finished — try again."
                : "Couldn't reach Steam — check the connection and try again.")));

        async Task RunAsync()
        {
            try
            {
                var details = new AuthSessionDetails
                {
                    Username = username,
                    Password = takePassword(),
                    PlatformType = SteamKit2.Internal.EAuthTokenPlatformType.k_EAuthTokenPlatformType_WebBrowser,
                    WebsiteID = "Community",
                    IsPersistentSession = true, // "remember me": a long-lived refresh token like the QR sign-in's
                    DeviceFriendlyName = "Liascape",
                    Authenticator = new PromptAuthenticator(prompt, ct),
                };
                CredentialsAuthSession session;
                try { session = await steamClient.Authentication.BeginAuthSessionViaCredentialsAsync(details); }
                finally { details.Password = null; } // Steam has it (encrypted); nothing here keeps it
                ((PromptAuthenticator)details.Authenticator).Session = session;
                var poll = await session.PollingWaitForResultAsync(ct);
                ulong steamId = SteamIdFromJwt(poll.RefreshToken);
                if (steamId == 0) steamId = session.SteamID.ConvertToUInt64();
                tcs.TrySetResult((poll.RefreshToken, steamId, string.IsNullOrEmpty(poll.AccountName) ? username : poll.AccountName));
            }
            catch (OperationCanceledException) { tcs.TrySetCanceled(); }
            catch (AuthenticationException e) { tcs.TrySetException(new SteamLoginException(LoginMessage(e.Result), e.Result)); }
            catch (NotImplementedException) // a confirmation kind SteamKit2 can't drive (e.g. an emailed link)
            { tcs.TrySetException(new SteamLoginException("Steam wants this sign-in confirmed in a way Liascape can't handle — use Sign in with QR.")); }
            catch (SteamLoginException e) { tcs.TrySetException(e); }
            catch (Exception e) { tcs.TrySetException(new SteamLoginException($"The sign-in failed: {e.Message}")); }
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

    /// Steam's answer to a password sign-in, in the user's words. The rate limit is said as such — the UI never retries
    /// on its own, and <see cref="IsRateLimit"/> makes SteamOps refuse new attempts for a while.
    public static string LoginMessage(EResult r) => r switch
    {
        EResult.InvalidPassword or EResult.InvalidName => "Wrong account name or password.",
        _ when IsRateLimit(r) => "Steam is limiting sign-in attempts from this connection. Wait a while (often half an hour or more) before trying again.",
        EResult.InvalidLoginAuthCode or EResult.TwoFactorCodeMismatch => "That code wasn't accepted — start the sign-in again.",
        EResult.Expired or EResult.FileNotFound => "The sign-in request expired — start again.",
        EResult.AccessDenied or EResult.AccountDisabled or EResult.AccountLockedDown or EResult.Suspended
            => $"Steam refused the sign-in ({r}).",
        EResult.ServiceUnavailable or EResult.Timeout or EResult.TryAnotherCM or EResult.NoConnection
            => "Couldn't reach Steam — try again in a moment.",
        _ => $"Steam turned down the sign-in ({r}).",
    };

    public static bool IsRateLimit(EResult r) =>
        r is EResult.RateLimitExceeded or EResult.AccountLoginDeniedThrottle or EResult.LimitExceeded
            or EResult.AccountActivityLimitExceeded;

    // SteamKit2's IAuthenticator over the UI prompt
    private sealed class PromptAuthenticator(ILoginPrompt prompt, CancellationToken ct) : IAuthenticator
    {
        public CredentialsAuthSession? Session;
        public Task<string> GetEmailCodeAsync(string email, bool previousCodeWasIncorrect) =>
            prompt.AskCodeAsync("email", string.IsNullOrWhiteSpace(email) ? null : email, previousCodeWasIncorrect, ct);
        public Task<string> GetDeviceCodeAsync(bool previousCodeWasIncorrect) =>
            prompt.AskCodeAsync("device", null, previousCodeWasIncorrect, ct);
        public Task<bool> AcceptDeviceConfirmationAsync()
        {
            // poll for the app's approval; a code typed meanwhile goes to Steam as the authenticator's code (the poll then
            // finds the sign-in done)
            prompt.AwaitConfirmation(async code =>
            {
                if (Session is not { } s) return false;
                try { await s.SendSteamGuardCodeAsync(code, SteamKit2.Internal.EAuthSessionGuardType.k_EAuthSessionGuardType_DeviceCode); return true; }
                catch (AuthenticationException e) when (e.Result is EResult.TwoFactorCodeMismatch or EResult.InvalidLoginAuthCode) { return false; }
            });
            return Task.FromResult(true);
        }
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
        {
            // AccessDenied (15) / Revoked (26) / Expired (27) on a well-formed, unexpired WebBrowser token = Steam ended that sign-in
            // (e.g. an old `aud web` token never renewed): say what to do rather than a bare EResult
            if (err.GetInt32() is 15 or 26 or 27) throw new SteamSignInRejectedException();
            throw new InvalidOperationException($"Steam finalizelogin failed (EResult {err.GetInt32()}).");
        }
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
        // the secrets live in SecretStore (the keyring, else steam-auth.json) — never in AppSettings / settings.json
        var rt = SecretStore.Get(SecretStore.RefreshToken);
        // A sign-in whose SteamId is 0 while the refresh token is there (Settings reads the token and says "Signed in as …"
        // while a Workshop download fails "Not signed in to Steam"): an older settings save could write the UI's stale
        // `SteamId: 0`, and `SettingsService.Patch` keeps it. The id is the refresh
        // token's own `sub` claim, so restore it from there instead of sending the user through the QR sign-in again.
        if (!string.IsNullOrWhiteSpace(rt) && settings.SteamId == 0)
        {
            ulong id = 0;
            try { id = SteamIdFromJwt(rt); } catch { /* not a readable token → the paths below */ }
            if (id != 0)
            {
                settings.SteamId = id;
                SettingsService.Update(s => { if (s.SteamId == 0) s.SteamId = id; });
                Console.WriteLine("steam: the Steam ID was missing — restored from the sign-in token");
            }
        }
        // No QR sign-in → use manual cookie paste if present (back-compat / advanced).
        if (string.IsNullOrWhiteSpace(rt) || settings.SteamId == 0)
        {
            var pasted = SecretStore.Get(SecretStore.LoginSecure);
            return string.IsNullOrWhiteSpace(pasted) ? null : pasted.Trim();
        }

        // Steam already turned this sign-in down: asking again only costs a request (it stays refused until a new sign-in)
        if (settings.SteamSignInRejected) throw new SteamSignInRejectedException();

        await _mintGate.WaitAsync(ct);
        try
        {
            // Reuse cached cookie until ~5 min before the embedded token's expiry.
            var cached = SecretStore.Get(SecretStore.AccessToken);
            if (!string.IsNullOrEmpty(cached)
                && JwtExpiryUtc(TokenPart(cached)) is DateTime exp
                && exp > DateTime.UtcNow.AddMinutes(5))
            {
                return cached;
            }

            string cookie;
            try { cookie = await GetWebCookieAsync(rt, settings.SteamId, ct); }
            catch (SteamSignInRejectedException)
            {
                // remembered, so Settings stops saying "Signed in as …" (/steam/status `rejected`)
                settings.SteamSignInRejected = true;
                SettingsService.Update(s => s.SteamSignInRejected = true);
                SecretStore.Delete(SecretStore.AccessToken);
                Console.WriteLine("steam: Steam turned down the saved sign-in — the user has to sign in again");
                throw;
            }
            SecretStore.Set(SecretStore.AccessToken, cookie); // full steamLoginSecure value (steamid||webtoken)
            MaybeRenewRefreshTokenInBackground(rt, settings.SteamId, settings.SteamAccountName);
            return cookie;
        }
        finally { _mintGate.Release(); }
    }

    /// Is there a sign-in a subscribe / unsubscribe can use without asking the user — a refresh token Steam hasn't turned down,
    /// or a pasted cookie? (Without one, Workshop downloads go through the Steam app: WorkshopDownloader.)
    public static bool HasUsableSignIn(AppSettings s)
    {
        if (HasRefreshToken()) return !s.SteamSignInRejected;
        return !string.IsNullOrWhiteSpace(SecretStore.Get(SecretStore.LoginSecure));
    }

    /// A refresh token is stored (signed in — or signed out by Steam: AppSettings.SteamSignInRejected).
    public static bool HasRefreshToken() => !string.IsNullOrWhiteSpace(SecretStore.Get(SecretStore.RefreshToken));

    /// Stores a fresh sign-in (QR or password) — the one place a sign-in's tokens are written. Throws when no store took it.
    public static void SaveSignIn(string refreshToken, ulong steamId, string accountName)
    {
        if (!SecretStore.Set(SecretStore.RefreshToken, refreshToken))
            throw new InvalidOperationException("Couldn't save the Steam sign-in (neither the system keyring nor ~/.config/liascape took it).");
        SecretStore.Delete(SecretStore.AccessToken); // the previous sign-in's cookie
        SettingsService.Update(s =>
        {
            s.SteamId = steamId;
            s.SteamAccountName = accountName;
            s.SteamSignInRejected = false;
        });
    }

    /// Signs out: every secret out of the store, the account fields out of settings.json.
    public static void SignOut()
    {
        SecretStore.Clear();
        SettingsService.Update(s => { s.SteamId = 0; s.SteamAccountName = ""; s.SteamSignInRejected = false; });
    }

    /// Days until the stored refresh token expires (null if unknown / not signed in). When this hits
    /// 0 the user must re-sign-in; renewal below tries to keep it well above 0.
    public static int? RefreshTokenDaysRemaining()
    {
        var rt = SecretStore.Get(SecretStore.RefreshToken);
        if (string.IsNullOrEmpty(rt)) return null;
        if (JwtExpiryUtc(rt) is not DateTime exp) return null;
        return Math.Max(0, (int)Math.Ceiling((exp - DateTime.UtcNow).TotalDays));
    }

    private static int _renewing;

    /// Best-effort refresh-token renewal: when the stored refresh token is within 90 days of expiry,
    /// log on with it and ask Steam for a renewed one (rolls the ~200-day window forward). Validated
    /// before adoption (later expiry, same SteamID) and fully swallows errors — if Steam won't renew
    /// (or won't log on a WebBrowser token), nothing changes and normal expiry + re-login applies.
    private static void MaybeRenewRefreshTokenInBackground(string refreshToken, ulong steamId, string accountName)
    {
        if (JwtExpiryUtc(refreshToken) is not DateTime exp) return;
        if (exp > DateTime.UtcNow.AddDays(90)) return;
        if (Interlocked.CompareExchange(ref _renewing, 1, 0) != 0) return;

        _ = Task.Run(async () =>
        {
            try { await TryRenewAsync(refreshToken, steamId, accountName); }
            catch { }
            finally { Interlocked.Exchange(ref _renewing, 0); }
        });
    }

    private static async Task TryRenewAsync(string refreshToken, ulong steamId, string accountName)
    {
        var steamClient = new SteamClient();
        var manager = new CallbackManager(steamClient);
        var steamUser = steamClient.GetHandler<SteamUser>()!;
        var tcs = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        manager.Subscribe<SteamClient.ConnectedCallback>(cb =>
            steamUser.LogOn(new SteamUser.LogOnDetails { Username = accountName, AccessToken = refreshToken }));
        manager.Subscribe<SteamClient.DisconnectedCallback>(cb => tcs.TrySetResult(null));
        manager.Subscribe<SteamUser.LoggedOnCallback>(cb => { _ = OnLoggedOn(cb); });

        async Task OnLoggedOn(SteamUser.LoggedOnCallback cb)
        {
            try
            {
                if (cb.Result != EResult.OK) { tcs.TrySetResult(null); return; }
                var res = await steamClient.Authentication.GenerateAccessTokenForAppAsync(
                    cb.ClientSteamID, refreshToken, allowRenewal: true);
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

        // Adopt only if the renewed token is genuinely better and ours — and the stored one is still the one renewed (no sign-out
        // or other account meanwhile).
        var newExp = JwtExpiryUtc(newRt);
        var oldExp = JwtExpiryUtc(refreshToken);
        if (newExp == null || (oldExp != null && newExp <= oldExp)) return;
        if (SteamIdFromJwt(newRt) != steamId) return;
        if (SecretStore.Get(SecretStore.RefreshToken) != refreshToken) return;
        SecretStore.Set(SecretStore.RefreshToken, newRt);
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

/// A password sign-in that didn't go through, in words for the user (never with the password in them).
public sealed class SteamLoginException(string message, EResult? result = null) : Exception(message)
{
    public EResult? Result { get; } = result;
    public bool RateLimited => Result is { } r && SteamAuthService.IsRateLimit(r);
}

public sealed class SteamSignInRejectedException() : Exception(
    "Steam has signed this app out (a password change or \"sign out of all devices\" on Steam does that). " +
    "Sign in again: Settings → Getting Workshop wallpapers → Sign in with QR or with your password.");
