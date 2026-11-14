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
// plus the no-sign-in unsubscribe (WorkshopDownloader.DrainUnsubQueueAsync → the Steam to-do, one page at a time, Next / Open
// again / Skip / Stop) with a stub `xdg-open` that only records the URL. Needs a private HOME under /tmp (it writes settings.json, workshop_unsub.json and fake Steam folders there).
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
        // the secret store may talk to a Secret Service: only ever a private one (dbus-run-session's bus under /tmp), never the user's
        string? bus = Environment.GetEnvironmentVariable("DBUS_SESSION_BUS_ADDRESS");
        string run = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR") ?? "";
        if ((bus != null && !bus.Contains("/tmp/")) || (bus == null && !run.StartsWith("/tmp/", StringComparison.Ordinal)))
        {
            Console.Error.WriteLine("steam-selftest: refusing — DBUS_SESSION_BUS_ADDRESS (or XDG_RUNTIME_DIR) must be a private one under /tmp");
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
        foreach (var v in SecretValues) if (log.Contains(v)) Fails.Add("a secret value appears in the console output");
        foreach (var (t, j) in Events) foreach (var v in SecretValues) if (j.Contains(v)) Fails.Add($"a secret value appears in a WS event ({t})");
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
        Check(SecretStore.Backend == ExpectBackend, $"secrets: the {ExpectBackend} backend is in use ({SecretStore.Backend})");
        SteamOps.SignOut();
        SecretStore.Set(SecretStore.RefreshToken, FakeJwt(76561190000000009));
        SettingsService.Update(s => { s.SteamId = 76561190000000009; s.SteamAccountName = "old"; s.SteamSignInRejected = true; });

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
        Check(SecretStore.Get(SecretStore.RefreshToken) == FakeJwt(76561190000000001) && s.SteamId == 76561190000000001 && s.SteamAccountName == "tester-acct",
            "email: the refresh token, Steam ID and account name are saved");
        Check(!s.SteamSignInRejected && SecretStore.Get(SecretStore.AccessToken) == null, "email: a new sign-in clears SteamSignInRejected and the old cookie");
        SignedInSecretChecks(FakeJwt(76561190000000001), "email");

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
        await SecretTests();
    }

    // ---- where the secrets live (Helpers/SecretStore.cs) ----

    // the backend this run must use: LIASCAPE_TEST_EXPECT_SECRETS=keyring under a private Secret Service, else the file fallback
    private static string ExpectBackend => Environment.GetEnvironmentVariable("LIASCAPE_TEST_EXPECT_SECRETS") is "keyring" ? "keyring" : "file";
    private static string SettingsFile => SettingsService.FilePath;
    private static string Text(string f) => File.Exists(f) ? File.ReadAllText(f) : "";
    private static readonly List<string> SecretValues = [];

    // after a sign-in: settings.json has no token; the file fallback holds it 0600 (file) / doesn't (keyring)
    private static void SignedInSecretChecks(string token, string label)
    {
        SecretValues.Add(token);
        var st = Text(SettingsFile);
        Check(st.Length > 0 && !st.Contains(token) && !st.Contains("SteamRefreshToken"), $"{label}: settings.json holds no token (nor the key)");
        if (SecretStore.Backend == "file")
        {
            var f = SecretStore.FallbackPath;
            Check(File.Exists(f) && Text(f).Contains(token), $"{label}: the token is in the file fallback");
#pragma warning disable CA1416
            Check(File.Exists(f) && File.GetUnixFileMode(f) == (UnixFileMode.UserRead | UnixFileMode.UserWrite), $"{label}: the file fallback is 0600");
#pragma warning restore CA1416
        }
        else Check(!Text(SecretStore.FallbackPath).Contains(token), $"{label}: the token is in the keyring, not the file fallback");
    }

    private static async Task SecretTests()
    {
        string home = Environment.GetEnvironmentVariable("HOME")!;
        const string Rt = "FAKE-RT-eyJzdWIiOiI3NjU2MTE5MDAwMDAwMDAwMSJ9", At = "FAKE-AT-76561190000000001%7C%7Cabc", Ls = "FAKE-LS-pasted-cookie";
        SecretValues.AddRange([Rt, At, Ls]);
        bool NoneIn(string text) => !text.Contains(Rt) && !text.Contains(At) && !text.Contains(Ls);

        // stored: the three secrets live in the store, never in settings.json or GET /settings
        SteamOps.SignOut();
        SettingsService.Update(x => { x.SteamId = 76561190000000001; x.SteamAccountName = "stored"; });
        SecretStore.Set(SecretStore.RefreshToken, Rt); SecretStore.Set(SecretStore.AccessToken, At); SecretStore.Set(SecretStore.LoginSecure, Ls);
        Check(SecretStore.Get(SecretStore.RefreshToken) == Rt && SecretStore.Get(SecretStore.AccessToken) == At && SecretStore.Get(SecretStore.LoginSecure) == Ls,
            "stored: the three secrets read back from the store");
        Check(NoneIn(Text(SettingsFile)), "stored: settings.json holds none of them");
        Check(SteamAuthService.HasRefreshToken() && SteamOps.Status().ToString()!.Contains("signedIn = True"), "stored: /steam/status says signed in");
        if (ExpectBackend == "file")
            Check(Text(SecretStore.FallbackPath).Contains(Rt), "stored: …in the file fallback");
        var api = System.Text.Json.JsonSerializer.Serialize(SettingsService.Load());
        Check(NoneIn(api), "GET /settings carries none of them");

        // sign-out removes them from the store (the cache too: a fresh process view)
        SteamOps.SignOut();
        SecretStore.ResetForTest();
        Check(SecretStore.Get(SecretStore.RefreshToken) == null && SecretStore.Get(SecretStore.AccessToken) == null && SecretStore.Get(SecretStore.LoginSecure) == null,
            "sign-out: every secret is gone from the store");
        Check(NoneIn(Text(SecretStore.FallbackPath)) && NoneIn(Text(SettingsFile)), "sign-out: none left in the file fallback or settings.json");
        Check(!SteamAuthService.HasUsableSignIn(SettingsService.Load()), "sign-out: no usable sign-in");

        StubKeyringTests(home);
        SecretStore.ResetForTest();
    }

    // The Secret Service path against a STUB secret-tool (records argv + emulates store/lookup/clear in files): the value goes
    // over stdin, never argv; a lookup the keyring refuses reads as signed out and isn't repeated. Never a real keyring.
    private static void StubKeyringTests(string home)
    {
        string dir = Path.Combine(home, "stub-keyring"), tool = Path.Combine(home, "stub-bin", "secret-tool"), argv = Path.Combine(home, "secret-tool.argv");
        Directory.CreateDirectory(dir); Directory.CreateDirectory(Path.GetDirectoryName(tool)!);
        File.WriteAllText(tool, $$"""
            #!/bin/sh
            printf '%s\n' "$*" >> '{{argv}}'
            op=$1; name=; prev=
            for a in "$@"; do [ "$prev" = name ] && name=$a; prev=$a; done
            [ -f '{{dir}}/deny' ] && [ "$op" = lookup ] && { echo "secret-tool: Cannot unlock the collection" >&2; exit 1; }
            case $op in
              store) cat > '{{dir}}'/"$name" ;;
              lookup) [ -f '{{dir}}'/"$name" ] || exit 1; cat '{{dir}}'/"$name" ;;
              clear) rm -f '{{dir}}'/"$name" ;;
            esac
            """);
#pragma warning disable CA1416
        File.SetUnixFileMode(tool, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
#pragma warning restore CA1416
        string bus = Path.Combine(home, "stub-bus");
        File.WriteAllText(bus, "");
        string? oldBus = Environment.GetEnvironmentVariable("DBUS_SESSION_BUS_ADDRESS");
        Environment.SetEnvironmentVariable("DBUS_SESSION_BUS_ADDRESS", "unix:path=" + bus);
        Environment.SetEnvironmentVariable("LIASCAPE_SECRET_TOOL", tool);
        try
        {
            SecretStore.ResetForTest();
            string token = FakeJwt(76561190000000002);
            SecretValues.Add(token);
            SteamAuthService.SaveSignIn(token, 76561190000000002, "stub-acct");
            Check(SecretStore.Backend == "keyring", "stub keyring: secret-tool + a session bus → the Secret Service backend");
            SecretStore.ResetForTest();
            Check(SecretStore.Get(SecretStore.RefreshToken) == token, "stub keyring: the token stored and looked up through secret-tool");
            Check(Text(Path.Combine(dir, SecretStore.RefreshToken)) == token, "stub keyring: secret-tool got the exact value on stdin");
            Check(!Text(argv).Contains(token) && Text(argv).Contains("store --label=") && Text(argv).Contains("application liascape name steam-refresh-token"),
                "stub keyring: the value never on secret-tool's command line");
            Check(!Text(SecretStore.FallbackPath).Contains(token) && !Text(SettingsFile).Contains(token), "stub keyring: not in the file fallback or settings.json");
            // a leftover in the file fallback (a time without a keyring) moves into the keyring when read
            Environment.SetEnvironmentVariable("LIASCAPE_SECRETS", "file");
            SecretStore.ResetForTest();
            SecretStore.Set(SecretStore.LoginSecure, "FAKE-LS-leftover");
            SecretValues.Add("FAKE-LS-leftover");
            Environment.SetEnvironmentVariable("LIASCAPE_SECRETS", null);
            SecretStore.ResetForTest();
            Check(SecretStore.Get(SecretStore.LoginSecure) == "FAKE-LS-leftover" && Text(Path.Combine(dir, SecretStore.LoginSecure)) == "FAKE-LS-leftover"
                && !Text(SecretStore.FallbackPath).Contains("FAKE-LS-leftover"), "stub keyring: a file-fallback leftover moves into the keyring");
            // denied (a locked keyring whose prompt was dismissed): signed out, no crash, not asked again right away
            SecretStore.Set(SecretStore.RefreshToken, token);
            SecretStore.ResetForTest();
            Check(SecretStore.Backend == "keyring", "stub keyring: (detected before the keyring starts refusing)");
            File.WriteAllText(Path.Combine(dir, "deny"), "");
            Check(SecretStore.Get(SecretStore.RefreshToken) == null, "stub keyring: a refused lookup (stored token, locked keyring) reads as signed out, no crash");
            int calls = File.ReadAllLines(argv).Length;
            SecretStore.Get(SecretStore.RefreshToken); SecretStore.Get(SecretStore.AccessToken);
            Check(File.ReadAllLines(argv).Length == calls, "stub keyring: …and the keyring isn't asked again (no prompt loop)");
            File.Delete(Path.Combine(dir, "deny"));
            SecretStore.ResetForTest();
            SteamOps.SignOut();
            Check(!File.Exists(Path.Combine(dir, SecretStore.RefreshToken)) && !File.Exists(Path.Combine(dir, SecretStore.LoginSecure)),
                "stub keyring: sign-out clears them from the keyring");
        }
        finally
        {
            Environment.SetEnvironmentVariable("DBUS_SESSION_BUS_ADDRESS", oldBus);
            Environment.SetEnvironmentVariable("LIASCAPE_SECRET_TOOL", null);
        }
    }

    // The no-sign-in unsubscribe: every id into the Steam to-do, one page at a time (stub xdg-open records the URL).
    private static async Task DrainTests()
    {
        string home = Environment.GetEnvironmentVariable("HOME")!;
        string bin = Path.Combine(home, "selftest-bin"), rec = Path.Combine(home, "xdg-open.urls");
        Directory.CreateDirectory(bin);
        File.WriteAllText(Path.Combine(bin, "xdg-open"), $"#!/bin/sh\nprintf '%s\\n' \"$1\" >> '{rec}'\n");
        File.SetUnixFileMode(Path.Combine(bin, "xdg-open"), UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        Environment.SetEnvironmentVariable("PATH", bin + ":" + Environment.GetEnvironmentVariable("PATH"));
        string steamWs = Path.Combine(home, ".local/share/Steam/steamapps/workshop/content/431960");
        foreach (var id in new[] { "800000001", "800000002", "800000003", "800000004" }) Directory.CreateDirectory(Path.Combine(steamWs, id));
        async Task<List<string>> Urls(int n)
        {
            for (int i = 0; i < 100 && (File.Exists(rec) ? File.ReadAllLines(rec).Length : 0) < n; i++) await Task.Delay(30);
            return File.Exists(rec) ? [.. File.ReadAllLines(rec)] : [];
        }

        // the latest WS steam-todo payload (the Steam to-do — Web/SteamTodo.cs; other events are dropped here)
        JsonElement? Todo()
        {
            JsonElement? last = null;
            while (Events.TryDequeue(out var e))
                if (e.Type == "steam-todo") { using var d = JsonDocument.Parse(e.Json); last = d.RootElement.GetProperty("payload").Clone(); }
            return last;
        }
        string Show(JsonElement? p) => p?.GetRawText() ?? "none";
        int I(JsonElement? p, string k) => p is { } v && v.TryGetProperty(k, out var x) && x.ValueKind == JsonValueKind.Number ? x.GetInt32() : -1;
        string CurId(JsonElement? p) => p is { } v && v.TryGetProperty("current", out var c) ? c.GetProperty("id").GetString() ?? "" : "";
        bool Pending(string id) => WorkshopUnsubQueue.SnapshotPending().Contains(id);
        bool Blocked(string id) => WorkshopUnsubQueue.SnapshotBlockedSet().Contains(id);
        Todo();

        SteamOps.SignOut();
        WorkshopUnsubQueue.AddPending(["800000001"]);
        var r = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), null, CancellationToken.None);
        var urls = await Urls(1);
        Check(urls.LastOrDefault() == "steam://url/CommunityFilePage/800000001", $"unsub, signed out, 1 item: its page opens in Steam ({string.Join(" ", urls)})");
        Check(r.OpenedInSteam == 1 && (r.Message ?? "").Contains("Not signed in") && (r.Message ?? "").Contains("Unsubscribe"), $"…the message says why + what to click ({r.Message})");
        var tp = Todo();
        Check(Str(tp ?? default, "action") == "unsubscribe" && I(tp, "index") == 1 && I(tp, "total") == 1 && CurId(tp) == "800000001",
            $"…WS steam-todo: unsubscribe 1 of 1, the item ({Show(tp)})");
        Check(Pending("800000001"), "…still pending while its page waits (blocked only on Next)");
        SteamTodo.Next();
        tp = Todo();
        Check(!Pending("800000001") && Blocked("800000001") && tp is { } f1 && f1.TryGetProperty("finished", out _), $"Next: pending → blocked, the to-do finished ({Show(tp)})");

        // three Steam has (+1 it hasn't — an owned steamcmd-style copy, never a subscription: no page, blocked at once): one page at
        // a time, Next / Open again / Skip / Stop
        SecretStore.Set(SecretStore.RefreshToken, FakeJwt(76561190000000001));
        SettingsService.Update(x => { x.SteamId = 76561190000000001; x.SteamSignInRejected = true; });
        WorkshopUnsubQueue.AddPending(["800000002", "800000099", "800000003", "800000004"]);
        r = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), null, CancellationToken.None);
        urls = await Urls(2);
        await Task.Delay(200);
        urls = await Urls(0);
        Check(urls.Count == 2 && urls[^1] == "steam://url/CommunityFilePage/800000002",
            $"unsub, sign-in rejected, 3 items Steam has: only the first page opens — never the subscriptions list ({string.Join(" ", urls)})");
        Check(r.OpenedInSteam == 3 && (r.Message ?? "").Contains("signed this app out") && (r.Message ?? "").Contains("one at a time"), $"…3 in the to-do, the message says why ({r.Message})");
        Check(!Pending("800000099") && Blocked("800000099"), "…the one Steam doesn't have (no Steam folder): no entry, no page, blocked at once");
        tp = Todo();
        Check(I(tp, "index") == 1 && I(tp, "total") == 3 && I(tp, "remaining") == 3, $"…WS steam-todo: 1 of 3 ({Show(tp)})");
        await Task.Delay(300);
        Check((await Urls(0)).Count == 2, "…nothing else opens by itself");
        var again = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), null, CancellationToken.None);
        Check(again.OpenedInSteam == 0 && (await Urls(0)).Count == 2, "…a second drain leaves the to-do's ids alone");
        SteamTodo.Next();
        urls = await Urls(3);
        tp = Todo();
        Check(urls.Count == 3 && urls[^1] == "steam://url/CommunityFilePage/800000003" && I(tp, "index") == 2 && CurId(tp) == "800000003",
            $"Next: the second page opens, 2 of 3 ({urls.LastOrDefault()}, {Show(tp)})");
        Check(Blocked("800000002") && !Pending("800000002"), "…the first is blocked");
        SteamTodo.Reopen();
        urls = await Urls(4);
        Check(urls.Count == 4 && urls[^1] == "steam://url/CommunityFilePage/800000003", "Open again: the same page again");
        SteamTodo.Skip();
        urls = await Urls(5);
        Check(urls.Count == 5 && urls[^1] == "steam://url/CommunityFilePage/800000004", $"Skip: the third page opens ({urls.LastOrDefault()})");
        Check(!Pending("800000003") && !Blocked("800000003"), "…the skipped one stays subscribed: out of pending AND blocked");
        SteamTodo.Stop();
        tp = Todo();
        await Task.Delay(200);
        Check(!Pending("800000004") && !Blocked("800000004") && tp is { } f2 && f2.TryGetProperty("finished", out _) && (await Urls(0)).Count == 5,
            $"Stop: the rest stays subscribed, the to-do finished, nothing more opens ({Show(tp)})");

        WorkshopUnsubQueue.AddPending(["800000098"]);
        r = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), null, CancellationToken.None);
        await Task.Delay(300);
        Check(r.OpenedInSteam == 0 && r.Message == null && (await Urls(0)).Count == 5 && Todo() == null, "unsub of an item Steam doesn't have: nothing opens, no to-do, no message");
        SteamOps.SignOut();
    }
}
