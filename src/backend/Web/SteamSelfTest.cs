using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using SteamKit2;

namespace Liascape.Web;

// hidden `liascape-backend steam-selftest` (PASS/FAIL, exit 1 on a failure): the password sign-in's plumbing — SteamOps'
// endpoints' calls, the WS events, the code steps, errors, cancel, the rate-limit hold, what gets saved, and that the
// password shows up NOWHERE (events, console) — with a scripted sign-in in place of SteamKit2 (never a real Steam account),
// plus the no-sign-in unsubscribe (WorkshopDownloader.DrainUnsubQueueAsync → the Steam app) with a stub `xdg-open` that only
// records the URL. Needs a private HOME under /tmp (it writes settings.json, workshop_unsub.json and fake Steam folders there).
public static class SteamSelfTest
{
    private const string Password = "pw-SELFTEST-c0rrect-h0rse";
    private static readonly ConcurrentQueue<(string Type, string Json)> Events = new();
    private static readonly List<string> Fails = [];

    public static int Run()
    {
        string home = Environment.GetEnvironmentVariable("HOME") ?? "";
        string? xdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
        if (!home.StartsWith("/tmp/", StringComparison.Ordinal) || (xdg != null && !xdg.StartsWith("/tmp/", StringComparison.Ordinal)))
        {
            Console.Error.WriteLine("steam-selftest: refusing — HOME (and XDG_CONFIG_HOME) must be a private dir under /tmp");
            return 2;
        }
        var realOut = Console.Out;
        var captured = new StringWriter();
        Console.SetOut(captured);
        EventBus.Tap = (t, j) => Events.Enqueue((t, j));
        SteamOps.LoginTimeout = TimeSpan.FromSeconds(20);
        try { RunAll().GetAwaiter().GetResult(); }
        catch (Exception e) { Fails.Add($"crashed: {e}"); }
        finally { Console.SetOut(realOut); EventBus.Tap = null; }

        string log = captured.ToString();
        if (log.Contains(Password)) Fails.Add("the password appears in the console output");
        foreach (var (t, j) in Events) if (j.Contains(Password)) Fails.Add($"the password appears in a WS event ({t})");
        string settingsFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "liascape", "settings.json");
        if (File.Exists(settingsFile) && File.ReadAllText(settingsFile).Contains(Password)) Fails.Add("the password was saved in settings.json");
        Console.WriteLine("--- backend console during the test ---");
        Console.Write(log);
        Console.WriteLine("---");
        foreach (var f in Fails) Console.WriteLine($"FAIL {f}");
        Console.WriteLine(Fails.Count == 0 ? "STEAM-SELFTEST PASS" : $"STEAM-SELFTEST FAIL ({Fails.Count})");
        return Fails.Count == 0 ? 0 : 1;
    }

    private static void Check(bool ok, string what) { if (!ok) Fails.Add(what); else Console.WriteLine($"ok   {what}"); }

    private static async Task<(string Type, JsonElement Payload)> NextEvent(string? type = null, int ms = 5000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(ms);
        while (DateTime.UtcNow < until)
        {
            while (Events.TryDequeue(out var e))
            {
                if (!e.Type.StartsWith("steam-") && !e.Type.StartsWith("unsub-")) continue;
                using var d = JsonDocument.Parse(e.Json);
                var p = d.RootElement.GetProperty("payload").Clone();
                if (type == null || e.Type == type) return (e.Type, p);
                Fails.Add($"expected WS {type}, got {e.Type} {e.Json}");
                return (e.Type, p);
            }
            await Task.Delay(20);
        }
        Fails.Add($"no WS {type ?? "event"} within {ms} ms");
        return ("", default);
    }

    private static string Str(JsonElement p, string k) => p.ValueKind == JsonValueKind.Object && p.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
    private static bool Bool(JsonElement p, string k) => p.ValueKind == JsonValueKind.Object && p.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.True;

    private static readonly long Exp = DateTimeOffset.UtcNow.AddDays(200).ToUnixTimeSeconds();
    private static string FakeJwt(ulong sub) =>
        "eyJhbGciOiJFZERTQSJ9." + Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
        { sub = sub.ToString(), exp = Exp, aud = new[] { "web", "community" } })))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".c2ln";

    private static int _driverCalls;
    private static string? _passwordSeen;

    // A scripted SteamKit2: asks what `kind` says through the prompt, like PollingWaitForResultAsync would.
    private static SteamOps.LoginDriverFn Script(string kind, string rightCode = "ABCDE", Exception? fail = null) =>
        async (user, takePassword, prompt, ct) =>
        {
            Interlocked.Increment(ref _driverCalls);
            _passwordSeen = takePassword();
            try { takePassword(); Fails.Add($"{kind}: the password could be taken twice"); } catch (InvalidOperationException) { }
            if (fail != null) throw fail;
            if (kind is "email" or "device")
            {
                bool retry = false;
                while (true)
                {
                    var code = await prompt.AskCodeAsync(kind, kind == "email" ? "example.com" : null, retry, ct);
                    if (code == rightCode) break;
                    retry = true;
                }
            }
            else if (kind == "confirm")
            {
                var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                prompt.AwaitConfirmation(code => { bool ok = code == rightCode; if (ok) done.TrySetResult(); return Task.FromResult(ok); });
                await done.Task.WaitAsync(ct);
            }
            else if (kind == "hang") await Task.Delay(Timeout.Infinite, ct);
            return (FakeJwt(76561190000000001), 76561190000000001UL, user + "-acct");
        };

    private static async Task RunAll()
    {
        SteamOps.SignOut();
        SettingsService.Update(s => { s.SteamRefreshToken = FakeJwt(76561190000000009); s.SteamId = 76561190000000009; s.SteamAccountName = "old"; s.SteamSignInRejected = true; });

        // validation: nothing reaches the sign-in
        Check(SteamOps.StartPasswordLogin("someone", "") is { Length: > 0 }, "an empty password is refused before Steam");
        Check(SteamOps.StartPasswordLogin("  ", Password) is { Length: > 0 }, "an empty account name is refused before Steam");
        Check(_driverCalls == 0, "…and the sign-in never ran");
        Check(await SteamOps.SubmitLoginCode("ABCDE") is { Length: > 0 }, "a code with no sign-in waiting → an error (409)");

        // email code: a wrong one → asked again (retry), the right one → signed in, saved like the QR path
        SteamOps.LoginDriver = Script("email");
        Check(SteamOps.StartPasswordLogin("tester", Password) == null, "email: started");
        var (t, p) = await NextEvent("steam-login-code");
        Check(Str(p, "kind") == "email" && Str(p, "hint") == "example.com" && !Bool(p, "retry"), $"email: steam-login-code {{kind: email, hint: example.com}} ({p})");
        Check(_passwordSeen == Password, "email: the sign-in got the password");
        Check(await SteamOps.SubmitLoginCode("wrong") == null, "email: a wrong code is handed on");
        (t, p) = await NextEvent("steam-login-code");
        Check(Str(p, "kind") == "email" && Bool(p, "retry"), "email: a wrong code → asked again with retry");
        Check(await SteamOps.SubmitLoginCode(" ab cde ") == null, "email: the right code (spaces / case forgiven) is handed on");
        (t, p) = await NextEvent("steam-signed-in");
        var s = SettingsService.Load();
        Check(Bool(p, "signedIn") && Str(p, "accountName") == "tester-acct" && !Bool(p, "rejected"), $"email: steam-signed-in with the account ({p})");
        Check(s.SteamRefreshToken == FakeJwt(76561190000000001) && s.SteamId == 76561190000000001 && s.SteamAccountName == "tester-acct",
            "email: the refresh token, Steam ID and account name are saved");
        Check(!s.SteamSignInRejected && s.SteamAccessToken == "", "email: a new sign-in clears SteamSignInRejected and the old cookie");

        // device (authenticator) code
        SteamOps.LoginDriver = Script("device", "F00D5");
        Check(SteamOps.StartPasswordLogin("tester2", Password) == null, "device: started");
        (t, p) = await NextEvent("steam-login-code");
        Check(Str(p, "kind") == "device" && Str(p, "hint") == "", $"device: steam-login-code {{kind: device}} ({p})");
        await SteamOps.SubmitLoginCode("f00d5");
        (t, p) = await NextEvent("steam-signed-in");
        Check(Str(p, "accountName") == "tester2-acct", "device: signed in");

        // approve in the app — or type the app's code: a wrong one → retry, the right one → signed in
        SteamOps.LoginDriver = Script("confirm", "C0DE1");
        Check(SteamOps.StartPasswordLogin("tester3", Password) == null, "confirm: started");
        (t, p) = await NextEvent("steam-login-code");
        Check(Str(p, "kind") == "confirm", $"confirm: steam-login-code {{kind: confirm}} ({p})");
        await SteamOps.SubmitLoginCode("nope1");
        (t, p) = await NextEvent("steam-login-code");
        Check(Str(p, "kind") == "confirm" && Bool(p, "retry"), "confirm: a wrong app code → retry");
        await SteamOps.SubmitLoginCode("C0DE1");
        (t, p) = await NextEvent("steam-signed-in");
        Check(Str(p, "accountName") == "tester3-acct", "confirm: signed in via the app's code");

        // cancel while Steam waits for a code: nothing saved
        var before = SettingsService.Load().SteamAccountName;
        SteamOps.LoginDriver = Script("email");
        SteamOps.StartPasswordLogin("tester4", Password);
        await NextEvent("steam-login-code");
        SteamOps.CancelPasswordLogin();
        await NextEvent("steam-login-cancelled");
        Check(SettingsService.Load().SteamAccountName == before, "cancel: steam-login-cancelled, the saved sign-in unchanged");
        Check(await SteamOps.SubmitLoginCode("ABCDE") is { Length: > 0 }, "cancel: a late code → an error (nothing waiting)");

        // a second Sign in replaces a running one (the first is dropped quietly)
        SteamOps.LoginDriver = Script("hang");
        SteamOps.StartPasswordLogin("tester5", Password);
        SteamOps.LoginDriver = Script("device", "AAAAA");
        SteamOps.StartPasswordLogin("tester6", Password);
        (t, p) = await NextEvent("steam-login-code");
        Check(Str(p, "kind") == "device", "replace: the new sign-in's step arrives, the old one is dropped without an error event");
        SteamOps.CancelPasswordLogin();
        await NextEvent("steam-login-cancelled");

        // timeout
        SteamOps.LoginTimeout = TimeSpan.FromMilliseconds(600);
        SteamOps.LoginDriver = Script("email");
        SteamOps.StartPasswordLogin("tester7", Password);
        await NextEvent("steam-login-code");
        (t, p) = await NextEvent("steam-login-error", 3000);
        Check(Str(p, "message").Contains("timed out"), $"timeout: steam-login-error \"timed out\" ({Str(p, "message")})");
        SteamOps.LoginTimeout = TimeSpan.FromSeconds(20);

        // wrong password: Steam's answer in words, no retry
        int calls = _driverCalls;
        SteamOps.LoginDriver = Script("x", fail: new SteamLoginException(SteamAuthService.LoginMessage(EResult.InvalidPassword), EResult.InvalidPassword));
        SteamOps.StartPasswordLogin("tester8", Password);
        (t, p) = await NextEvent("steam-login-error");
        Check(Str(p, "message") == "Wrong account name or password." && !Bool(p, "rateLimited"), $"wrong password: \"{Str(p, "message")}\"");
        await Task.Delay(300);
        Check(_driverCalls == calls + 1, "wrong password: tried once, never again on its own");

        // rate limit: said as such, and new attempts are refused for a while (no driver call)
        SteamOps.LoginDriver = Script("x", fail: new SteamLoginException(SteamAuthService.LoginMessage(EResult.RateLimitExceeded), EResult.RateLimitExceeded));
        SteamOps.StartPasswordLogin("tester9", Password);
        (t, p) = await NextEvent("steam-login-error");
        Check(Bool(p, "rateLimited") && Str(p, "message").Contains("limiting"), $"rate limit: rateLimited + \"{Str(p, "message")}\"");
        calls = _driverCalls;
        var held = SteamOps.StartPasswordLogin("tester9", Password);
        Check(held is { } h && h.Contains("limiting") && _driverCalls == calls, $"rate limit: the next attempt is refused before Steam ({held})");

        await DrainTests();
    }

    // The no-sign-in unsubscribe: what Steam still has on disk opens in the Steam app (stub xdg-open records the URL).
    private static async Task DrainTests()
    {
        string home = Environment.GetEnvironmentVariable("HOME")!;
        string bin = Path.Combine(home, "selftest-bin"), rec = Path.Combine(home, "xdg-open.urls");
        Directory.CreateDirectory(bin);
        File.WriteAllText(Path.Combine(bin, "xdg-open"), $"#!/bin/sh\nprintf '%s\\n' \"$1\" >> '{rec}'\n");
        File.SetUnixFileMode(Path.Combine(bin, "xdg-open"), UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        Environment.SetEnvironmentVariable("PATH", bin + ":" + Environment.GetEnvironmentVariable("PATH"));
        string steamWs = Path.Combine(home, ".local/share/Steam/steamapps/workshop/content/431960");
        foreach (var id in new[] { "800000001", "800000002", "800000003" }) Directory.CreateDirectory(Path.Combine(steamWs, id));
        async Task<List<string>> Urls(int n)
        {
            for (int i = 0; i < 100 && (File.Exists(rec) ? File.ReadAllLines(rec).Length : 0) < n; i++) await Task.Delay(30);
            return File.Exists(rec) ? [.. File.ReadAllLines(rec)] : [];
        }

        SteamOps.SignOut();
        WorkshopUnsubQueue.AddPending(["800000001"]);
        var r = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), null, CancellationToken.None);
        var urls = await Urls(1);
        Check(urls.LastOrDefault() == "steam://url/CommunityFilePage/800000001", $"unsub, signed out, 1 item: its page opens in Steam ({string.Join(" ", urls)})");
        Check(r.OpenedInSteam == 1 && (r.Message ?? "").Contains("Not signed in") && (r.Message ?? "").Contains("Unsubscribe"), $"…the message says why + what to click ({r.Message})");
        Check(!WorkshopUnsubQueue.HasPending() && WorkshopUnsubQueue.SnapshotBlockedSet().Contains("800000001"), "…pending → blocked");

        SettingsService.Update(x => { x.SteamRefreshToken = FakeJwt(76561190000000001); x.SteamId = 76561190000000001; x.SteamSignInRejected = true; });
        WorkshopUnsubQueue.AddPending(["800000002", "800000003", "800000099"]);
        r = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), null, CancellationToken.None);
        urls = await Urls(2);
        Check(urls.LastOrDefault() == "steam://openurl/https://steamcommunity.com/my/myworkshopfiles/?appid=431960&browsefilter=mysubscriptions",
            $"unsub, sign-in rejected, 2 items Steam has (+1 it hasn't): the subscriptions list opens ({urls.LastOrDefault()})");
        Check(r.OpenedInSteam == 2 && (r.Message ?? "").Contains("signed this app out"), $"…2 of them, the message says Steam signed out ({r.Message})");
        Check(!WorkshopUnsubQueue.HasPending(), "…all three leave pending");

        WorkshopUnsubQueue.AddPending(["800000099"]);
        r = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), null, CancellationToken.None);
        await Task.Delay(300);
        Check(r.OpenedInSteam == 0 && r.Message == null && (await Urls(0)).Count == 2, "unsub of an item Steam doesn't have: nothing opens, no message");
        SteamOps.SignOut();
    }
}
