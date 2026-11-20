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
using Liascape.Models;
using Liascape.Scrapers;
using SteamKit2;

namespace Liascape.Web;

// hidden `liascape-backend steam-selftest` (PASS/FAIL, exit 1 on a failure): the password sign-in's plumbing — SteamOps'
// endpoints' calls, the WS events, the code steps, errors, cancel, the rate-limit hold, what gets saved, and that the
// password shows up NOWHERE (events, console) — with a scripted sign-in in place of SteamKit2 (never a real Steam account),
// plus unsubscribes and the sign-in (WorkshopDownloader.UnsubscribeBlocked per mode; signed out one in its Undo window or due is
// dropped like its Undo, never a page; "Open in the Steam app" → the Steam to-do, one page at a time, Next / Open again / Skip /
// Stop) with a stub `xdg-open` that only records the URL. Needs a private HOME under /tmp (it writes settings.json, workshop_unsub.json and fake Steam folders there).
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

    // THE rule (WorkshopDownloader.BlockedFor), per mode × sign-in × action: each mode only its own way. "Subscribe with
    // Steam login" without a usable sign-in: every action off, "Sign in to Steam to …"; a Steam page: no one-off; "Use the
    // Steam app": nothing off
    private static void ActionRule()
    {
        foreach (var mode in new[] { "steamapp", "steampage", "subscribe" })
            foreach (bool signIn in new[] { false, true })
                foreach (var a in Enum.GetValues<WorkshopDownloader.WorkshopAction>())
                {
                    string? want = (mode, signIn, a) switch
                    {
                        ("subscribe", false, WorkshopDownloader.WorkshopAction.Download) => "Sign in to Steam to download",
                        ("subscribe", false, WorkshopDownloader.WorkshopAction.Subscribe) => "Sign in to Steam to subscribe",
                        ("subscribe", false, WorkshopDownloader.WorkshopAction.Unsubscribe) => "Sign in to Steam to unsubscribe",
                        ("subscribe", false, WorkshopDownloader.WorkshopAction.OneOff) => "Sign in to Steam to download without subscribing",
                        ("steampage", _, WorkshopDownloader.WorkshopAction.OneOff) => "A Steam page can only subscribe",
                        _ => null,
                    };
                    var got = WorkshopDownloader.BlockedFor(mode, signIn, a);
                    Check(got == want, $"action rule: {mode}, sign-in {(signIn ? "usable" : "none")}, {a} → {got ?? "allowed"}");
                }
    }

    // "Download without subscribing"'s route (WorkshopDownloader.OneOffRouteOf), per mode × sign-in: the mode's own way — the
    // Steam client, the sign-in (none signed out: "Sign in to Steam…"); never in the page mode (a page can only subscribe)
    private static void OneOffRoutes()
    {
        foreach (var mode in new[] { "steamapp", "subscribe", "steampage" })
            foreach (bool signIn in new[] { false, true })
            {
                var r = WorkshopDownloader.OneOffRouteOf(mode, signIn);
                string? want = mode switch
                {
                    "steamapp" => "steamapp",
                    "subscribe" => signIn ? "subscribe" : null,
                    _ => null,
                };
                bool ok = r.Route == want && (want == null) == (r.Missing != null);
                if (want == null && mode == "subscribe") ok &= r.Missing == "Sign in to Steam to download without subscribing";
                if (want == null && mode == "steampage") ok &= r.Missing == "A Steam page can only subscribe";
                Check(ok, $"one-off route: {mode}, sign-in {(signIn ? "usable" : "none")} → {r.Route ?? "none"} ({r.Missing ?? "-"})");
            }
        // a mode no longer offered (the dropped "steamcmd") or any unknown one reads as the default
        foreach (var stored in new[] { "steamcmd", "bogus" })
        {
            var s = JsonSerializer.Deserialize<AppSettings>($$"""{"WorkshopDownloadMode":"{{stored}}"}""")!;
            Check(s.WorkshopDownloadMode == "subscribe", $"stored mode \"{stored}\" reads as {s.WorkshopDownloadMode}, the default");
        }
    }

    private static async Task<(string Type, JsonElement Payload)> NextEvent(string? type = null, int ms = 5000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(ms);
        while (DateTime.UtcNow < until)
        {
            while (Events.TryDequeue(out var e))
            {
                if (!e.Type.StartsWith("steam-") && !e.Type.StartsWith("unsub-")) continue;
                if (e.Type == "steam-status" && type != "steam-status") continue; // every sign-out sends one (SteamOps.SignInLost)
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

    // The Browse warm-up (SteamAnonymous.Warm) never reaches Steam from a test: while a fixture answers for Steam, or the
    // Workshop fallback is forced, it does nothing at all. This self-test isn't network-isolated, so only those gates run here.
    private static void WarmUp()
    {
        string? fx = Environment.GetEnvironmentVariable("LIASCAPE_STEAM_CM_FIXTURE"), fb = Environment.GetEnvironmentVariable("LIASCAPE_WORKSHOP_FALLBACK");
        try
        {
            Environment.SetEnvironmentVariable("LIASCAPE_WORKSHOP_FALLBACK", null);
            Environment.SetEnvironmentVariable("LIASCAPE_STEAM_CM_FIXTURE", "/nonexistent/steam-cm.json");
            var a = SteamAnonymous.Warm(); var b = SteamAnonymous.Warm();
            Check(a == "test" && b == "test", $"warm-up: a Steam fixture → nothing, every time ({a}, {b})");
            Environment.SetEnvironmentVariable("LIASCAPE_STEAM_CM_FIXTURE", null);
            Environment.SetEnvironmentVariable("LIASCAPE_WORKSHOP_FALLBACK", "1");
            Check(SteamAnonymous.Warm() == "test", "warm-up: the forced Workshop fallback → nothing");
        }
        finally
        {
            Environment.SetEnvironmentVariable("LIASCAPE_STEAM_CM_FIXTURE", fx);
            Environment.SetEnvironmentVariable("LIASCAPE_WORKSHOP_FALLBACK", fb);
        }
    }

    // A hermetic stack's Browse: the Workshop's pages from the fixture's "@query" (Steam's matching done roughly: search,
    // tag groups, page), and with LIASCAPE_TEST_NO_NETWORK=1 every real connection refused before it is made — the shared
    // HTTP connect (loopback still connects: the tests' fake servers) and Steam's client protocol (no fixture → null, no
    // session). Guard for the UI matrix's hermetic Browse (probe-steam browse:fixture).
    private static async Task NoNetwork()
    {
        string? fx = Environment.GetEnvironmentVariable("LIASCAPE_STEAM_CM_FIXTURE"), nn = Environment.GetEnvironmentVariable("LIASCAPE_TEST_NO_NETWORK");
        string file = Path.Combine(Environment.GetEnvironmentVariable("HOME")!, "steam-cm-query.json");
        File.WriteAllText(file, """
            {"@query": [{"publishedfileid": "1001", "title": "Query One", "tags": ["Video", "Everyone", "Nature"]},
                        {"publishedfileid": "1002", "title": "Query Two", "tags": ["Video", "Mature", "Anime"]},
                        {"publishedfileid": "1003", "title": "Query Scene", "tags": ["Scene", "Everyone", "Anime"]},
                        {"publishedfileid": "2001", "title": "Preset One", "tags": ["Preset", "Scene", "Everyone"], "children": ["1003"]},
                        {"publishedfileid": "2002", "title": "Preset Two", "tags": ["Preset", "Scene", "Anime"], "children": ["1003"]},
                        {"publishedfileid": "2003", "title": "Preset Video", "tags": ["Preset", "Video"], "children": ["1001"]},
                        {"publishedfileid": "2004", "title": "Preset Web", "tags": ["Preset", "Web"], "children": ["1003"]}],
             "2001": {"tags": ["Preset", "Scene"], "title": "Preset One", "children": ["1003"]},
             "1003": {"tags": ["Scene"], "title": "Query Scene"}}
            """);
        var t = TimeSpan.FromSeconds(5);
        async Task<string> Q(WorkshopFilter f, bool scenes, string? q, int page) =>
            await SteamWorkshopDetails.QueryAsync(f, WorkshopTags.Build(f, scenes), q, page, 100, t) is { } r ? string.Join(",", r.Select((d) => d.Id)) : "null";
        try
        {
            Environment.SetEnvironmentVariable("LIASCAPE_TEST_NO_NETWORK", "1");
            Environment.SetEnvironmentVariable("LIASCAPE_STEAM_CM_FIXTURE", file);
            var all = new WorkshopFilter();
            Check(await Q(all, true, null, 1) == "1001,1002,1003", $"fixture query: the whole list in order ({await Q(all, true, null, 1)})");
            Check(await Q(all, false, null, 1) == "1001,1002", $"fixture query: scenes off drops the scene ({await Q(all, false, null, 1)})");
            Check(await Q(all, true, "two", 1) == "1002", $"fixture query: a search matches titles ({await Q(all, true, "two", 1)})");
            var anime = new WorkshopFilter { Include = ["Anime"] };
            Check(await Q(anime, true, null, 1) == "1002,1003", $"fixture query: an included tag ({await Q(anime, true, null, 1)})");
            Check(await Q(all, true, null, 2) == "", $"fixture query: page 2 is empty ({await Q(all, true, null, 2)})");

            // Presets: their own Type option, only with scenes + allowPresets; a preset carries Preset AND its base's type
            // tag, so an unticked Preset is excluded outright and a web-based preset stays out with Web
            async Task<string> QP(WorkshopFilter f, bool scenes, bool presets) =>
                await SteamWorkshopDetails.QueryAsync(f, WorkshopTags.Build(f, scenes, presets), null, 1, 100, t) is { } r ? string.Join(",", r.Select((d) => d.Id)) : "null";
            var plan0 = WorkshopTags.Build(all, true, true);
            Check(plan0.TagGroups.Any((g) => g.Order().SequenceEqual(new[] { "Scene", "Video" }))
                && new[] { "Web", "Application", "Preset" }.All(plan0.Excluded.Contains), $"presets: unticked → type Video + Scene, Preset excluded ({WorkshopTags.Describe(plan0)})");
            Check(await QP(all, true, true) == "1001,1002,1003", $"presets: the default list has none ({await QP(all, true, true)})");
            var incPreset = new WorkshopFilter { Include = ["Preset"] };
            Check(await QP(incPreset, true, true) == "2001,2002,2003", $"presets: Preset ticked → every preset but the web-based one ({await QP(incPreset, true, true)})");
            var incScenePreset = new WorkshopFilter { Include = ["Scene", "Preset"] };
            Check(await QP(incScenePreset, true, true) == "1003,2001,2002,2003", $"presets: Scene + Preset ticked ({await QP(incScenePreset, true, true)})");
            Check(await QP(new WorkshopFilter { Include = ["Scene"] }, true, true) == "1003", "presets: Scene alone ticked keeps presets out");
            Check(WorkshopTags.Build(incPreset, true, false).Empty, "presets: Preset ticked without presets allowed → nothing can match");
            Check(WorkshopTags.Build(incPreset, false, true).Empty, "presets: Preset ticked with scenes off → nothing can match");
            Check(WorkshopTags.Unplayable.SequenceEqual(new[] { "Web", "Application" }), $"presets: Unplayable = Web, Application ({string.Join(",", WorkshopTags.Unplayable)})");
            async Task<string> Kids(ulong parent, WorkshopFilter? f, string sort = "lastupdated") =>
                await SteamWorkshopDetails.QueryChildrenAsync(parent, WorkshopTags.ForPresets(f), sort, 1, 100, t) is { } r ? string.Join(",", r.Select((d) => d.Id)) : "null";
            Check(await Kids(1003, null) == "2001,2002", $"presets of a scene: exactly the presets naming it, the web-based one left out ({await Kids(1003, null)})");
            Check(await Kids(1002, null) == "", $"presets of a scene with none: empty ({await Kids(1002, null)})");
            Check(await Kids(1003, new WorkshopFilter { Include = ["Anime", "Video"] }, "toprated") == "2002",
                $"presets of a scene: the filter's other groups apply, its type doesn't ({await Kids(1003, new WorkshopFilter { Include = ["Anime", "Video"] }, "toprated")})");
            var kidsDetail = (await SteamWorkshopDetails.QueryChildrenAsync(1003, WorkshopTags.ForPresets(null), "lastupdated", 1, 100, t))?.FirstOrDefault();
            Check(kidsDetail?.Children.SequenceEqual(new ulong[] { 1003 }) == true, "presets of a scene: each result names its children");
            var det = await SteamWorkshopDetails.GetDetailsAsync([2001]);
            Check(det != null && det.TryGetValue(2001, out var d2001) && d2001.Title == "Preset One" && d2001.Children?.SequenceEqual(new ulong[] { 1003 }) == true,
                $"presets: GetDetails carries the title and the children ({(det != null && det.TryGetValue(2001, out var dd) ? $"{dd.Title} [{string.Join(",", dd.Children ?? [])}]" : "none")})");
            var pd = new Dictionary<string, SteamWorkshopScraper.PublishedFileDetail>
            {
                ["2001"] = new() { Id = "2001", Title = "p", Tags = ["Preset", "Scene"] },
                ["2004"] = new() { Id = "2004", Title = "w", Tags = ["Preset", "Web"] },
                ["1003"] = new() { Id = "1003", Title = "s", Tags = ["Scene"] },
            };
            string Ids(List<WallpaperResult> rs) => string.Join(",", rs.Select((x) => x.WorkshopId + (x.IsPreset ? "p" : "") + (x.IsScene ? "s" : "")));
            Check(Ids(SteamWorkshopScraper.MapToResults(["2001", "2004", "1003"], pd, true)) == "1003s", "presets: mapped results drop a preset without allowPresets");
            Check(Ids(SteamWorkshopScraper.MapToResults(["2001", "2004", "1003"], pd, true, true)) == "2001ps,1003s",
                $"presets: with allowPresets a preset is IsPreset + IsScene, a web-based one still dropped ({Ids(SteamWorkshopScraper.MapToResults(["2001", "2004", "1003"], pd, true, true))})");
            Check(Ids(SteamWorkshopScraper.MapToResults(["2001", "1003"], pd, false, true)) == "", "presets: scenes off drops presets too");
            Environment.SetEnvironmentVariable("LIASCAPE_STEAM_CM_FIXTURE", Path.Combine(Path.GetDirectoryName(file)!, "no-such-fixture.json"));
            Check(await Q(all, true, null, 1) == "null", "fixture query: no fixture file = Steam unreachable (the fallback's cue)");
            // no fixture at all: the client protocol's session is refused before it connects
            Environment.SetEnvironmentVariable("LIASCAPE_STEAM_CM_FIXTURE", null);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var q = await Q(all, true, null, 1);
            Check(q == "null" && sw.ElapsedMilliseconds < 2000, $"no network: Steam's client protocol refused at once ({q}, {sw.ElapsedMilliseconds} ms)");
            using var http = new System.Net.Http.HttpClient(new System.Net.Http.SocketsHttpHandler { ConnectCallback = TestNetwork.ConnectCallback });
            string Err(Exception? e) => e == null ? "connected" : e.ToString();
            Exception? real = null, loop = null;
            try { await http.GetAsync("https://steamcommunity.com/"); } catch (Exception e) { real = e; }
            try { await http.GetAsync("http://127.0.0.1:1/"); } catch (Exception e) { loop = e; }
            Check(real is System.Net.Http.HttpRequestException && real.Message.Contains("LIASCAPE_TEST_NO_NETWORK"), $"no network: a real host is refused ({Err(real)})");
            Check(loop != null && !Err(loop).Contains("LIASCAPE_TEST_NO_NETWORK"), $"no network: loopback still connects (refused by the port, not the guard: {Err(loop)})");
        }
        finally
        {
            Environment.SetEnvironmentVariable("LIASCAPE_STEAM_CM_FIXTURE", fx);
            Environment.SetEnvironmentVariable("LIASCAPE_TEST_NO_NETWORK", nn);
            File.Delete(file);
        }
    }

    private static async Task RunAll()
    {
        Check(SecretStore.Backend == ExpectBackend, $"secrets: the {ExpectBackend} backend is in use ({SecretStore.Backend})");
        ActionRule();
        OneOffRoutes();
        ReconcileSkipsBlocked();
        WarmUp();
        await NoNetwork();
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

    // Unsubscribes and the sign-in: signed out the app stays disconnected from Steam for unsubscribes (WorkshopDownloader.
    // UnsubscribeBlocked): an unsubscribe due or still in its Undo window is dropped like its Undo, never a page, never queued.
    // "Open in the Steam app" unsubscribes through each item's page, one at a time (stub xdg-open records the URL).
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

        UnsubAllowed();
        await UnsubDropped(Urls, Pending, Blocked);

        // "Open in the Steam app" (its whole job is pages), signed out: the item's page opens
        SteamOps.SignOut();
        SettingsService.Update(x => x.WorkshopDownloadMode = "steampage");
        WorkshopUnsubQueue.AddPending(["800000001"]);
        var r = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), null, CancellationToken.None);
        var urls = await Urls(1);
        Check(urls.LastOrDefault() == "steam://url/CommunityFilePage/800000001", $"unsub, Open in the Steam app, signed out, 1 item: its page opens in Steam ({string.Join(" ", urls)})");
        Check(r.OpenedInSteam == 1 && (r.Message ?? "") == "Click Unsubscribe on the page Steam opened, then Next.", $"…the message says what to click ({r.Message})");
        var tp = Todo();
        Check(Str(tp ?? default, "action") == "unsubscribe" && I(tp, "index") == 1 && I(tp, "total") == 1 && CurId(tp) == "800000001",
            $"…WS steam-todo: unsubscribe 1 of 1, the item ({Show(tp)})");
        Check(Pending("800000001"), "…still pending while its page waits (blocked only on Next)");
        SteamTodo.Next();
        tp = Todo();
        Check(!Pending("800000001") && Blocked("800000001") && tp is { } f1 && f1.TryGetProperty("finished", out _), $"Next: pending → blocked, the to-do finished ({Show(tp)})");

        // three Steam has (+1 it hasn't — an owned one-off copy, never a subscription: no page, blocked at once): one page at
        // a time, Next / Open again / Skip / Stop. Signed in, the mode still opens pages (it never switches to the sign-in)
        SecretStore.Set(SecretStore.RefreshToken, FakeJwt(76561190000000001));
        SettingsService.Update(x => { x.SteamId = 76561190000000001; x.SteamSignInRejected = false; });
        WorkshopUnsubQueue.AddPending(["800000002", "800000099", "800000003", "800000004"]);
        r = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), null, CancellationToken.None);
        urls = await Urls(2);
        await Task.Delay(200);
        urls = await Urls(0);
        Check(urls.Count == 2 && urls[^1] == "steam://url/CommunityFilePage/800000002",
            $"unsub, Open in the Steam app, signed in, 3 items Steam has: only the first page opens — never the subscriptions list ({string.Join(" ", urls)})");
        Check(r.OpenedInSteam == 3 && (r.Message ?? "").StartsWith("Steam opens the 3 wallpapers one at a time"), $"…3 in the to-do, the message says what to click ({r.Message})");
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
        await ResubscribeSignedOut(Urls);
        SteamOps.SignOut();
        SettingsService.Update(x => x.WorkshopDownloadMode = "subscribe");
    }

    // WorkshopDownloader.UnsubscribeBlocked, per mode × sign-in: "Use the Steam app" (the running client is its sign-in),
    // "Open in the Steam app" (the item's Steam page) always may; the sign-in's mode only with a usable sign-in
    private static void UnsubAllowed()
    {
        foreach (var (state, setUp) in new (string, Action)[]
        {
            ("signed out", () => SteamOps.SignOut()),
            ("signed in", () => { SecretStore.Set(SecretStore.RefreshToken, FakeJwt(76561190000000001)); SettingsService.Update(x => { x.SteamId = 76561190000000001; x.SteamSignInRejected = false; }); }),
            ("sign-in rejected", () => SettingsService.Update(x => x.SteamSignInRejected = true)),
        })
        {
            setUp();
            bool usable = state == "signed in";
            foreach (var mode in new[] { "steamapp", "steampage", "subscribe" })
            {
                SettingsService.Update(x => x.WorkshopDownloadMode = mode);
                var why = WorkshopDownloader.UnsubscribeBlocked(SettingsService.Load());
                string? want = mode == "subscribe" && !usable ? "Sign in to Steam to unsubscribe" : null;
                Check(why == want, $"unsub allowed: {mode}, {state} → {(want == null ? "yes" : "no")} ({why ?? "null"})");
            }
        }
        SteamOps.SignOut();
        SettingsService.Update(x => x.WorkshopDownloadMode = "subscribe");
    }

    // A Workshop item in the library (+ its Steam folder), as auto-import would have it; a plain imported one beside it
    private static LibraryItem LibItem(string key, string? workshopId)
    {
        string source = workshopId != null ? LibraryStore.Workshop : LibraryStore.Imported;
        string dir = Path.Combine(LibraryStore.SourceDir(source), key);
        Directory.CreateDirectory(dir);
        File.WriteAllBytes(Path.Combine(dir, key + ".mp4"), [0, 0, 0, 0]);
        LibraryStore.UpdateIndex(source, idx => { idx[key] = new LibMeta { Title = "selftest " + key, WorkshopId = workshopId }; return true; });
        return LibraryService.LoadAll().First(i => i.VideoPath.StartsWith(dir + "/", StringComparison.Ordinal));
    }
    private static bool InLibrary(string key) => LibraryService.LoadAll().Any(i => Path.GetFileName(Path.GetDirectoryName(i.VideoPath)) == key);

    // the latest WS unsub-progress message since the last call (other events are dropped here)
    private static async Task<string?> UnsubMessage(int ms = 1500)
    {
        string? msg = null;
        for (var until = DateTime.UtcNow.AddMilliseconds(ms); DateTime.UtcNow < until && msg == null; await Task.Delay(30))
            while (Events.TryDequeue(out var e))
                if (e.Type == "unsub-progress")
                {
                    using var d = JsonDocument.Parse(e.Json);
                    if (d.RootElement.GetProperty("payload").TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String) msg = m.GetString();
                }
        return msg;
    }

    // Signed out, nothing reaches Steam for an unsubscribe and nothing waits for a later sign-in: one still inside its Undo
    // window when the sign-in ends (signed out here, or Steam turning it down) and one due when no usable sign-in is there are
    // dropped like their Undo — the item back in the library, off the queue (still subscribed), no page, no to-do entry.
    private static async Task UnsubDropped(Func<int, Task<List<string>>> urls, Func<string, bool> pending, Func<string, bool> blocked)
    {
        SettingsService.Update(x => x.WorkshopDownloadMode = "subscribe");
        string steamWs = Path.Combine(Environment.GetEnvironmentVariable("HOME")!, ".local/share/Steam/steamapps/workshop/content/431960");
        int opened0 = (await urls(0)).Count;
        async Task<bool> NothingOpened() => SteamTodo.QueuedUnsubscribes().Count == 0 && (await urls(0)).Count == opened0;
        void SignIn() { SecretStore.Set(SecretStore.RefreshToken, FakeJwt(76561190000000001)); SettingsService.Update(x => { x.SteamId = 76561190000000001; x.SteamSignInRejected = false; }); }
        await UnsubMessage(0);

        // sign-out inside the Undo window
        foreach (var id in new[] { "800000011", "800000012", "800000013", "800000014" }) Directory.CreateDirectory(Path.Combine(steamWs, id));
        SignIn();
        var w1 = LibItem("800000011", "800000011");
        int depth0 = AppOps.UndoDepth();
        AppOps.DeleteFromSource([w1]);
        Check(!InLibrary("800000011") && pending("800000011") && AppOps.UndoDepth() == depth0 + 1, "sign-out in the Undo window: (set-up) Delete from source trashed it and queued the unsubscribe");
        SteamOps.SignOut();
        var msg = await UnsubMessage();
        Check(InLibrary("800000011") && !pending("800000011") && !blocked("800000011") && AppOps.UndoDepth() == depth0,
            "sign-out in the Undo window: the unsubscribe is dropped like its Undo — back in the library, off the queue, no undo batch left");
        Check(msg != null && msg.Contains("back in your library") && msg.Contains("Sign in to Steam to unsubscribe") && await NothingOpened(),
            $"…the status says so, nothing opened in Steam, no to-do entry ({msg})");

        // Steam turning the sign-in down inside the window (what SteamAuthService does when it can't make the cookie)
        SignIn();
        var w2 = LibItem("800000012", "800000012");
        AppOps.DeleteFromSource([w2]);
        SettingsService.Update(x => x.SteamSignInRejected = true);
        SteamOps.SignInLost();
        msg = await UnsubMessage();
        Check(InLibrary("800000012") && !pending("800000012") && !blocked("800000012") && msg != null && await NothingOpened(),
            $"sign-in rejected in the Undo window: dropped like its Undo, back in the library, nothing opened ({msg})");
        // the window's end (its timer) finds nothing to send
        await Task.Delay(SteamOps.UnsubUndoWindow + TimeSpan.FromMilliseconds(600));
        Check(!pending("800000011") && !pending("800000012") && await NothingOpened(), "…and the Undo window's end sends nothing");

        // "Use the Steam app" keeps its unsubscribe through a sign-out (the running client is its sign-in)
        SignIn();
        SettingsService.Update(x => x.WorkshopDownloadMode = "steamapp");
        WorkshopUnsubQueue.AddPending(["800000015"]);
        WorkshopUnsubQueue.Hold(["800000015"], TimeSpan.FromSeconds(30));
        SteamOps.SignOut();
        Check(pending("800000015"), "sign-out in the Undo window, Use the Steam app: the unsubscribe stays (the Steam client does it)");
        WorkshopUnsubQueue.Restore("800000015");
        SettingsService.Update(x => x.WorkshopDownloadMode = "subscribe");

        // due with no sign-in (queued before a restart, say): dropped by the drain, the item back, no page; only its own item of a
        // batch comes back (a plain item deleted with it stays undoable)
        SteamOps.SignOut();
        var w3 = LibItem("800000013", "800000013");
        var plain = LibItem("selftest-plain", null);
        WorkshopUnsubQueue.AddPending(["800000013"]);
        AppOps.Trash([w3, plain]);
        depth0 = AppOps.UndoDepth();
        var r = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), null, CancellationToken.None);
        Check(r.OpenedInSteam == 0 && (r.Message ?? "").Contains("Sign in to Steam to unsubscribe") && await NothingOpened(),
            $"unsub, signed out: nothing opens in Steam, no to-do entry, the message says to sign in ({r.Message})");
        Check(InLibrary("800000013") && !pending("800000013") && !blocked("800000013"), "…dropped like its Undo: back in the library, off the queue (still subscribed)");
        Check(!InLibrary("selftest-plain") && AppOps.UndoDepth() == depth0, "…only its own item came back: the plain one deleted with it stays in the trash, still undoable");
        AppOps.Undo();
        Check(InLibrary("selftest-plain"), "…and Undo brings that one back");

        // a sign-in Steam turned down: the same, for an id the library doesn't hold (the Browse sidebar's Unsubscribe)
        SignIn();
        SettingsService.Update(x => x.SteamSignInRejected = true);
        WorkshopUnsubQueue.AddPending(["800000014"]);
        r = await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), null, CancellationToken.None);
        Check(r.OpenedInSteam == 0 && (r.Message ?? "").Contains("stays subscribed") && (r.Message ?? "").Contains("Sign in to Steam to unsubscribe")
            && !pending("800000014") && !blocked("800000014") && await NothingOpened(),
            $"unsub, sign-in rejected: nothing opens, off the queue, it stays subscribed ({r.Message})");
        SteamOps.SignOut();
        await UnsubMessage(0);
    }
    // Undo's re-subscribe (WorkshopDownloader.ResubscribeAsync) under "Subscribe with Steam login" without a usable sign-in
    // (signed out, or one Steam turned down): nothing reaches Steam and no page opens or waits in the to-do (that mode never
    // opens pages); the status bar's words say the undo happened, what it costs and to sign in
    private static async Task ResubscribeSignedOut(Func<int, Task<List<string>>> urls)
    {
        SettingsService.Update(x => x.WorkshopDownloadMode = "subscribe");
        int opened0 = (await urls(0)).Count;
        foreach (var (state, setUp) in new (string, Action)[]
        {
            ("signed out", () => SteamOps.SignOut()),
            ("sign-in rejected", () => { SecretStore.Set(SecretStore.RefreshToken, FakeJwt(76561190000000001)); SettingsService.Update(x => { x.SteamId = 76561190000000001; x.SteamSignInRejected = true; }); }),
        })
        {
            setUp();
            foreach (var ids in new[] { new[] { "800000016" }, new[] { "800000016", "800000017" } })
            {
                var msg = await WorkshopDownloader.ResubscribeAsync(ids, SettingsService.Load(), CancellationToken.None);
                await Task.Delay(300);
                bool quiet = SteamTodo.QueuedSubscribes().Count == 0 && (await urls(0)).Count == opened0;
                Check(msg != null && msg.StartsWith("Undone, but") && msg.EndsWith("Sign in to Steam to subscribe.") && (ids.Length == 1 ? msg.Contains("it isn't") : msg.Contains("they aren't")) && quiet,
                    $"undo's re-subscribe, {state}, {ids.Length} item(s): no page, no to-do entry, the status says to sign in ({msg})");
                if (!quiet) SteamTodo.Stop();
            }
        }
        SteamOps.SignOut();
    }

    // A library-owned workshop/<id> copy whose id is blocked (Steam's folder for it lingers but isn't a subscription: an
    // unsubscribed item, a one-off download's) is never swapped for a link into that folder, which Steam deletes; an unblocked
    // one still is (ReplaceDirectWithWorkshop). Guard for LibraryService.ReconcileDirectDownloads
    private static void ReconcileSkipsBlocked()
    {
        string we = Path.Combine(Environment.GetEnvironmentVariable("HOME")!, "reconcile-ws", "431960");
        foreach (var id in new[] { "800000021", "800000022" })
        {
            Directory.CreateDirectory(Path.Combine(we, id));
            File.WriteAllBytes(Path.Combine(we, id, "v.mp4"), [0, 0, 0, 0]);
            LibItem(id, id);
        }
        WorkshopUnsubQueue.AddPending(["800000021"]);
        WorkshopUnsubQueue.MarkBlocked("800000021");
        LibraryService.ReconcileDirectDownloads(we, copyFilesInsteadOfSymlinking: false);
        string own(string id) => Path.Combine(LibraryStore.SourceDir(LibraryStore.Workshop), id);
        string link(string id) => Path.Combine(LibraryStore.SourceDir(LibraryStore.Local), id);
        bool isLink(string p) => (File.Exists(p) || Directory.Exists(p)) && new FileInfo(p).LinkTarget != null;
        Check(Directory.Exists(own("800000021")) && !isLink(own("800000021")) && !isLink(link("800000021")),
            "reconcile: a blocked id's own workshop/<id> copy stays, no link into Steam's lingering folder");
        Check(!Directory.Exists(own("800000022")) && isLink(link("800000022")), "reconcile: an unblocked id's copy still gives way to Steam's folder");
        WorkshopUnsubQueue.Unblock("800000021");
    }
}
