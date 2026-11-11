using System;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using QRCoder;

namespace Liascape.Web;

// Steam sign-in (QR / password) / sign-out / workshop unsub-drain. The QR, the password sign-in's code steps and the
// drain's progress are pushed over WS.
public static class SteamOps
{
    private static CancellationTokenSource? _qrCts;
    private static int _draining; // Interlocked guard — one drain at a time

    public static object Status()
    {
        var s = SettingsService.Load();
        return new
        {
            signedIn = !string.IsNullOrEmpty(s.SteamRefreshToken),
            rejected = !string.IsNullOrEmpty(s.SteamRefreshToken) && s.SteamSignInRejected, // Steam ended it: sign in again
            accountName = s.SteamAccountName,
            daysLeft = SteamAuthService.RefreshTokenDaysRemaining(s),
            mode = s.WorkshopDownloadMode,
        };
    }

    public static void StartQr()
    {
        _qrCts?.Cancel();
        _qrCts = new CancellationTokenSource();
        var ct = _qrCts.Token;
        _ = Task.Run(async () =>
        {
            try
            {
                var (refreshToken, steamId, accountName) = await SteamAuthService.LoginViaQrAsync(url =>
                {
                    // render the steam challenge URL to a PNG and push it
                    using var gen = new QRCodeGenerator();
                    using var data = gen.CreateQrCode(url, QRCodeGenerator.ECCLevel.Q);
                    var png = new PngByteQRCode(data).GetGraphic(8);
                    EventBus.Broadcast("steam-qr", new { png = "data:image/png;base64," + Convert.ToBase64String(png) });
                }, ct);

                SteamAuthService.SaveSignIn(refreshToken, steamId, accountName);
                EventBus.Broadcast("steam-signed-in", Status());
            }
            catch (OperationCanceledException) { EventBus.Broadcast("steam-qr-cancelled"); }
            catch (Exception e) { EventBus.Broadcast("steam-qr-error", new { message = e.Message }); }
        });
    }

    public static void CancelQr() => _qrCts?.Cancel();

    // ---- password sign-in (owner 2026-11-11: "is it a dead end for users without mobile guard?") ---------------------
    // POST /steam/login {username, password} → (WS steam-login-code {kind: email|device|confirm, hint, retry} → POST
    // /steam/login/code {code})* → WS steam-signed-in | steam-login-error {message, rateLimited} | steam-login-cancelled.
    // The password goes to Steam once (LoginViaCredentialsAsync takes it out of the box below, which is then empty); it is
    // never logged, broadcast, stored, or held past that first step.

    private static readonly object _pwLock = new();
    private static CancellationTokenSource? _pwCts;
    private static LoginPrompt? _pwPrompt;
    private static DateTime _loginHoldUntil = DateTime.MinValue; // after Steam's rate limit: no new attempt before this
    public static readonly TimeSpan LoginHold = TimeSpan.FromMinutes(15);
    public static TimeSpan LoginTimeout = TimeSpan.FromMinutes(10);

    public delegate Task<(string RefreshToken, ulong SteamId, string AccountName)> LoginDriverFn(
        string username, Func<string> takePassword, SteamAuthService.ILoginPrompt prompt, CancellationToken ct);
    // the real sign-in; the hidden `steam-selftest` swaps in a scripted one (never a real Steam account in a test)
    internal static LoginDriverFn LoginDriver = SteamAuthService.LoginViaCredentialsAsync;

    /// Starts a password sign-in (replacing one already running). Null = started; else why not (the endpoint's 400).
    public static string? StartPasswordLogin(string? username, string? password)
    {
        username = username?.Trim();
        if (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password)) return "Enter your Steam account name and password.";
        if (username.Length > 64 || password.Length > 256) return "That account name or password is too long.";
        if (DateTime.UtcNow < _loginHoldUntil)
            return $"Steam is limiting sign-in attempts from this connection — try again after {_loginHoldUntil.ToLocalTime():HH:mm}.";

        var box = new string?[] { password };
        password = null;
        string TakePassword() { var p = box[0] ?? throw new InvalidOperationException("the password was already used"); box[0] = null; return p; }

        CancellationTokenSource cts; LoginPrompt prompt;
        lock (_pwLock)
        {
            if (_pwPrompt is { } old) { old.UserCancelled = true; old.Replaced = true; } // a replaced sign-in ends quietly (its events would land in the new one)
            _pwCts?.Cancel();
            _pwCts = cts = new CancellationTokenSource(LoginTimeout);
            _pwPrompt = prompt = new LoginPrompt(cts.Token);
        }
        var driver = LoginDriver;
        string user = username;
        _ = Task.Run(async () =>
        {
            try
            {
                Console.WriteLine("steam: password sign-in started");
                var (refreshToken, steamId, accountName) = await driver(user, TakePassword, prompt, cts.Token);
                box[0] = null;
                if (string.IsNullOrEmpty(refreshToken)) throw new SteamLoginException("Steam didn't hand over a sign-in — try again.");
                if (prompt.UserCancelled) throw new OperationCanceledException();
                SteamAuthService.SaveSignIn(refreshToken, steamId, accountName);
                Console.WriteLine("steam: signed in with a password");
                EventBus.Broadcast("steam-signed-in", Status());
            }
            catch (OperationCanceledException)
            {
                if (prompt.Replaced) { }
                else if (prompt.UserCancelled) EventBus.Broadcast("steam-login-cancelled");
                else Fail("The sign-in timed out — start again.", false);
            }
            catch (SteamLoginException e)
            {
                if (e.RateLimited) _loginHoldUntil = DateTime.UtcNow + LoginHold;
                if (!prompt.UserCancelled) Fail(e.Message, e.RateLimited);
            }
            catch (Exception e) { if (!prompt.UserCancelled) Fail($"The sign-in failed: {e.Message}", false); }
            finally
            {
                box[0] = null;
                lock (_pwLock)
                {
                    if (ReferenceEquals(_pwPrompt, prompt)) _pwPrompt = null;
                    if (ReferenceEquals(_pwCts, cts)) _pwCts = null;
                }
                cts.Dispose();
            }
        });
        return null;

        static void Fail(string message, bool rateLimited)
        {
            Console.WriteLine($"steam: password sign-in failed — {message}");
            EventBus.Broadcast("steam-login-error", new { message, rateLimited });
        }
    }

    /// The code the user typed for the step Steam asked for. Null = handed on; else why not (409).
    public static Task<string?> SubmitLoginCode(string? code)
    {
        code = (code ?? "").Replace(" ", "").Replace("-", "").Trim().ToUpperInvariant();
        if (code.Length is 0 or > 16) return Task.FromResult<string?>("Enter the code.");
        LoginPrompt? p; lock (_pwLock) p = _pwPrompt;
        return p == null ? Task.FromResult<string?>("No sign-in is waiting for a code.") : p.SubmitAsync(code);
    }

    public static void CancelPasswordLogin()
    {
        lock (_pwLock)
        {
            if (_pwPrompt is { } p) p.UserCancelled = true;
            _pwCts?.Cancel();
        }
    }

    // The UI side of SteamKit2's IAuthenticator: each question → WS steam-login-code, answered by POST /steam/login/code.
    private sealed class LoginPrompt(CancellationToken ct) : SteamAuthService.ILoginPrompt
    {
        private readonly object _gate = new();
        private TaskCompletionSource<string>? _code;          // an email / device code step waiting
        private Func<string, Task<bool>>? _sendConfirmCode;   // the approve-in-the-app step: a typed code goes to Steam
        public volatile bool UserCancelled, Replaced;

        public Task<string> AskCodeAsync(string kind, string? hint, bool retry, CancellationToken _)
        {
            var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_gate) { _code = tcs; _sendConfirmCode = null; }
            ct.Register(() => tcs.TrySetCanceled());
            hint = string.IsNullOrWhiteSpace(hint) ? null : hint.Trim() is { Length: > 100 } h ? h[..100] : hint.Trim();
            Console.WriteLine($"steam: password sign-in — Steam asks for {(kind == "email" ? "the code it emailed" : "the authenticator's code")}{(retry ? " (the last one was wrong)" : "")}");
            EventBus.Broadcast("steam-login-code", new { kind, hint, retry });
            return tcs.Task;
        }

        public void AwaitConfirmation(Func<string, Task<bool>> sendCode)
        {
            lock (_gate) { _sendConfirmCode = sendCode; _code = null; }
            Console.WriteLine("steam: password sign-in — waiting for the approval in the Steam app");
            EventBus.Broadcast("steam-login-code", new { kind = "confirm", hint = (string?)null, retry = false });
        }

        public async Task<string?> SubmitAsync(string code)
        {
            TaskCompletionSource<string>? tcs; Func<string, Task<bool>>? send;
            lock (_gate) { tcs = _code; send = _sendConfirmCode; if (tcs != null) _code = null; }
            if (tcs != null) { tcs.TrySetResult(code); return null; }
            if (send == null) return "Steam isn't waiting for a code right now.";
            bool ok;
            try { ok = await send(code); }
            catch (Exception e) { return $"Steam didn't take the code: {e.Message}"; }
            if (!ok) EventBus.Broadcast("steam-login-code", new { kind = "confirm", hint = (string?)null, retry = true });
            return null;
        }
    }

    public static void SignOut()
    {
        SettingsService.Update(s =>
        {
            s.SteamRefreshToken = ""; s.SteamId = 0; s.SteamAccessToken = "";
            s.SteamAccountName = ""; s.SteamLoginSecure = ""; s.SteamSignInRejected = false;
        });
    }

    // The drain modal is a view onto this; dismissing it doesn't stop the drain. One drain at a time. Without a usable
    // sign-in the drain opens the item (or the subscriptions list) in the Steam app instead — `openedInSteam` + `message`
    // on the finishing event say so (WorkshopDownloader.DrainUnsubQueueAsync).
    public static void StartDrain()
    {
        if (Interlocked.CompareExchange(ref _draining, 1, 0) != 0) return;
        _ = Task.Run(async () =>
        {
            try
            {
                var progress = new Progress<(int Done, int Total, string CurrentId)>(t =>
                    EventBus.Broadcast("unsub-progress", new { done = t.Done, total = t.Total, currentId = t.CurrentId }));
                var r = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), progress, CancellationToken.None);
                EventBus.Broadcast("unsub-progress", new { done = 0, total = 0, currentId = "", finished = true, openedInSteam = r.OpenedInSteam, message = r.Message });
            }
            catch (Exception e) { EventBus.Broadcast("unsub-progress", new { error = e.Message, finished = true }); }
            finally { Interlocked.Exchange(ref _draining, 0); }
        });
    }
}
