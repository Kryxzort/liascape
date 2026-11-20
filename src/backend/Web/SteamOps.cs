using System;
using System.Collections.Generic;
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
    private static int _drainAgain; // asked again while one ran → one more pass after it

    public static object Status()
    {
        var s = SettingsService.Load();
        bool hasRt = SteamAuthService.HasRefreshToken(); // in SecretStore (the keyring / steam-auth.json), not settings.json
        return new
        {
            signedIn = hasRt,
            rejected = hasRt && s.SteamSignInRejected, // Steam ended it: sign in again
            accountName = s.SteamAccountName,
            daysLeft = SteamAuthService.RefreshTokenDaysRemaining(),
            mode = s.WorkshopDownloadMode,
            // API: what the UI's Workshop controls need to mirror WorkshopDownloader.Blocked under any mode
            // (components/subscribeMode.ts actionBlocked): a sign-in the actions can use
            usable = SteamAuthService.HasUsableSignIn(s),
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

    // ---- password sign-in (docs/decisions.md § "Offer a password sign-in beside the QR") -----------------------------
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
        SteamAuthService.SignOut();
        SignInLost();
    }

    // The sign-in is gone (signed out here, or Steam turned it down: SteamAuthService): the Unsubscribe controls follow (WS
    // steam-status), and an unsubscribe still inside its Undo window is dropped like its Undo — the app stays disconnected from
    // Steam for unsubscribes, so nothing waits for a later sign-in. The modes that don't need the sign-in keep theirs.
    // Guard: steam-selftest "sign-out in the Undo window", "sign-in rejected in the Undo window"
    public static void SignInLost()
    {
        EventBus.Broadcast("steam-status", Status());
        if (WorkshopDownloader.UnsubscribeBlocked(SettingsService.Load()) is not { } why) return;
        var held = WorkshopUnsubQueue.SnapshotHeld();
        if (held.Count == 0) return;
        int back = AppOps.DropUnsubscribes(held);
        Console.WriteLine($"workshop: unsubscribe {string.Join(", ", held)}: the Steam sign-in ended inside the Undo window — dropped");
        EventBus.Broadcast("unsub-progress", new { done = 0, total = 0, currentId = "", finished = true, openedInSteam = 0,
            message = WorkshopDownloader.DroppedMessage(held.Count, back, why) });
    }

    // How long an Unsubscribe (the Library's, the Browse sidebar's) waits before it reaches Steam: its Undo window. An Undo
    // inside it takes the id out of the queue, so Steam is never asked (nor asked to subscribe again: WorkshopUnsubQueue.Withdraw
    // sees it still pending), and so does one after it until the drain claims the id; while Steam is unsubscribing it, Undo is
    // too late and says so; after, Undo re-subscribes. Another unsubscribe inside the window restarts the wait.
    // Guard: test-steam-signin.sh § 3 i (the Undo window)
    public static readonly TimeSpan UnsubUndoWindow = TimeSpan.FromSeconds(5);
    static Timer? _undoWindowTimer;
    static readonly object _undoWindowGate = new();

    public static void DrainAfterUndoWindow(IEnumerable<string> ids)
    {
        WorkshopUnsubQueue.Hold(ids, UnsubUndoWindow);
        // a little after the hold ends, so the drain finds it due
        lock (_undoWindowGate)
        {
            _undoWindowTimer?.Dispose();
            _undoWindowTimer = new Timer(_ => { if (WorkshopUnsubQueue.HasPending()) StartDrain(); }, null,
                UnsubUndoWindow + TimeSpan.FromMilliseconds(200), Timeout.InfiniteTimeSpan);
        }
    }

    // drain now (POST /workshop/drain: the tests, a script; the UI never calls it): an explicit ask doesn't wait out the window
    public static void DrainNow()
    {
        lock (_undoWindowGate) { _undoWindowTimer?.Dispose(); _undoWindowTimer = null; }
        WorkshopUnsubQueue.ReleaseHolds();
        StartDrain();
    }

    // One drain at a time. Its count is also the library's "unsubscribe" operation (Web/LibraryOps.cs: the top bar's words and
    // progress line, which leave a single quick one out). What it did beyond the queue (pages opened under "Open in the Steam
    // app", unsubscribes dropped for want of a sign-in) → `openedInSteam` + `message` on the finishing event
    // (WorkshopDownloader.DrainUnsubQueueAsync).
    public static void StartDrain()
    {
        // asked while one runs (the Browse sidebar's Unsubscribe right after a Delete from source): that run may have read the
        // queue already — run once more after it, or the new id waited for the next launch
        Interlocked.Exchange(ref _drainAgain, 1);
        if (Interlocked.CompareExchange(ref _draining, 1, 0) != 0) return;
        _ = Task.Run(async () =>
        {
            try
            {
                while (Interlocked.Exchange(ref _drainAgain, 0) == 1)
                {
                    try
                    {
                        // reported inline, not through Progress<T>: its callbacks run later on the pool, and one landing after
                        // the End below would leave the operation showing for good
                        var progress = new InlineProgress<(int Done, int Total, string CurrentId)>(t =>
                        {
                            EventBus.Broadcast("unsub-progress", new { done = t.Done, total = t.Total, currentId = t.CurrentId });
                            LibraryOps.Set("unsubscribe", "steam", t.Done, t.Total);
                        });
                        var r = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), progress, CancellationToken.None);
                        LibraryOps.End("unsubscribe");
                        EventBus.Broadcast("unsub-progress", new { done = 0, total = 0, currentId = "", finished = true, openedInSteam = r.OpenedInSteam, message = r.Message });
                    }
                    catch (Exception e)
                    {
                        LibraryOps.End("unsubscribe");
                        EventBus.Broadcast("unsub-progress", new { error = e.Message, finished = true });
                    }
                }
            }
            finally
            {
                Interlocked.Exchange(ref _draining, 0);
                if (Volatile.Read(ref _drainAgain) == 1) StartDrain(); // asked between the loop's last check and here
            }
        });
    }

    private sealed class InlineProgress<T>(Action<T> report) : IProgress<T> { public void Report(T value) => report(value); }
}
