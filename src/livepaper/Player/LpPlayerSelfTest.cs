using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using livepaper.Helpers;
using livepaper.Models;

namespace livepaper.Player;

// Hidden `livepaper --lp-player-selftest`: MpvPropertyMap + stream-ownership assertions, then a
// protocol round-trip against a PRIVATE `lp-player serve --headless --clock stepped --ao null`
// (temp XDG_RUNTIME_DIR/XDG_STATE_HOME + its own socket, killed at the end). It never touches a
// real running player: the shared client is pointed at the temp socket and never auto-spawns.
// Prints `PASS` or `FAIL <reasons>`, exit 0/1.
public static class LpPlayerSelfTest
{
    public static int Run()
    {
        var fails = new List<string>();
        try
        {
            MapAssertions(fails);
            OwnershipAssertions(fails);
            SceneSkipAssertions(fails);
            SceneAdapterAssertions(fails);
            if (fails.Count == 0) QueueDepthAssertions(fails);
            if (fails.Count == 0) RoundTrip(fails);
        }
        catch (Exception e) { fails.Add($"{e.GetType().Name}: {e.Message}"); }
        if (fails.Count == 0) { Console.WriteLine("PASS"); return 0; }
        Console.WriteLine("FAIL " + string.Join("; ", fails));
        return 1;
    }

    // ---- MpvPropertyMap ----------------------------------------------------------------------
    private static void MapAssertions(List<string> fails)
    {
        void Num(object[] mpv, string prop, double want, double tol = 1e-3)
        {
            var t = MpvPropertyMap.Translate(mpv);
            string label = string.Join(" ", mpv);
            if (t == null) { fails.Add($"map `{label}` → null, want {prop}={want}"); return; }
            if (t.Value.prop != prop) { fails.Add($"map `{label}` → prop {t.Value.prop}, want {prop}"); return; }
            double got = Convert.ToDouble(t.Value.value, System.Globalization.CultureInfo.InvariantCulture);
            if (Math.Abs(got - want) > tol) fails.Add($"map `{label}` → {prop}={got}, want {want}±{tol}");
        }
        void Eq(object[] mpv, string prop, object want)
        {
            var t = MpvPropertyMap.Translate(mpv);
            string label = string.Join(" ", mpv);
            if (t == null) { fails.Add($"map `{label}` → null, want {prop}={want}"); return; }
            if (t.Value.prop != prop || !Equals(t.Value.value, want))
                fails.Add($"map `{label}` → {t.Value.prop}={t.Value.value}, want {prop}={want}");
        }
        Num(["set_property", "volume", 50], "gain.user", -18.0618);
        Num(["set_property", "volume", 100.0], "gain.user", 0);
        Num(["set_property", "volume", 0], "gain.user", -96);
        Eq(["set_property", "panscan", 0.0], "fit", "fit");
        Eq(["set_property", "panscan", 1.0], "fit", "fill");
        Eq(["set", "aid", "no"], "no_audio", true);
        Eq(["set", "aid", "auto"], "no_audio", false);
        Num(["set_property", "mute", true], "gain.mute", -96);
        Num(["set_property", "mute", false], "gain.mute", 0);
        Num(["set_property", "speed", 1.5], "speed", 1.5);
        Eq(["set_property", "pause", true], "player.paused", true);
        Eq(["set", "loop-file", "inf"], "loop", true);
        Eq(["set", "loop-file", "no"], "loop", false);
        Num(["set", "vf", "fps=30"], "fps_cap", 30);
        Num(["set", "vf", ""], "fps_cap", 0);
        Eq(["set", "hwdec", "vaapi"], "hwdec", "vaapi");
        Eq(["set", "cache", "no"], "cache", false);
        Eq(["set", "cache", "auto"], "cache", true);
        Num(["set", "demuxer-max-bytes", "20MiB"], "demuxer_max_mib", 20);
        Num(["set", "demuxer-max-back-bytes", "5MiB"], "demuxer_back_mib", 5);
        Eq(["set", "af", "loudnorm=I=-14"], "af", "loudnorm=I=-14");
        if (MpvPropertyMap.Translate(["set_property", "osd-level", 1]) != null)
            fails.Add("map `set_property osd-level 1` → non-null, want null (unknown)");
    }

    // ---- R69: auto-mute excludes lp-player's OWN streams (by ownership, not just by name) ------
    private static void OwnershipAssertions(List<string> fails)
    {
        static string Block(string app, string pid, string node, string sink) =>
            $"7\n\tDriver: PipeWire\n\tSink: {sink}\n\tProperties:\n\t\tapplication.name = \"{app}\"\n" +
            $"\t\tapplication.process.id = \"{pid}\"\n\t\tnode.name = \"{node}\"\n";
        void Own(string label, string block, bool want)
        {
            bool got = LpPlayerMedia.IsOwnStream(block, playerPid: 4242, busSinkIndex: "57");
            if (got != want) fails.Add($"ownership {label}: got {got}, want {want}");
        }
        Own("by pid", Block("mpv", "4242", "mpv", "12"), true);
        Own("bus playback node", Block("x", "1", "lp-player-bus.playback", "12"), true);
        Own("targets the bus sink", Block("x", "1", "y", "57"), true);
        Own("application.name lp-player", Block("lp-player", "1", "y", "12"), true);
        // Phase 2: a scene worker's own stream (its own process, its own app name here) — by node name
        Own("scene worker stream", Block("x", "1", "lp-player-scene.src4", "12"), true);
        Own("another app", Block("Firefox", "1", "Firefox", "12"), false);
    }

    // ---- Phase 2 Task 11: scenes under lp-player (pure decisions + a scene's create props) ------
    private static void SceneAdapterAssertions(List<string> fails)
    {
        // Task 8: AppSettings → the player's GPU / VRAM props (the limit is 0 = off while its toggle is off)
        string G(AppSettings s) => string.Join(" ", LpPlayerMedia.GpuProps(s).Select(p => $"{p.prop}={p.value}"));
        foreach (var (s, want) in new (AppSettings, string)[] {
            (new AppSettings(), "scene_throttle=True scene_vram_limit_mib=0 vram_low_mode=stop"),
            (new AppSettings { SceneThrottle = false, SceneVramLimitEnabled = true, SceneVramLimitMib = 1536, VramLowMode = "pause" }, "scene_throttle=False scene_vram_limit_mib=1536 vram_low_mode=pause"),
            (new AppSettings { SceneVramLimitMib = 2048, VramLowMode = "bogus" }, "scene_throttle=True scene_vram_limit_mib=0 vram_low_mode=stop"),
            (new AppSettings { SceneVramLimitEnabled = true, SceneVramLimitMib = 1, VramLowMode = "off" }, "scene_throttle=True scene_vram_limit_mib=64 vram_low_mode=off") })
            if (G(s) != want) fails.Add($"GpuProps → {G(s)}, want {want}");
        // ScenesPlayable: AllowScenes × engine × (lp-player: the player's `scene` capability | legacy: LWE)
        foreach (var allow in new[] { false, true })
        foreach (var lp in new[] { false, true })
        foreach (var cap in new[] { false, true })
        foreach (var lwe in new[] { false, true })
        {
            bool want = allow && (lp ? cap : lwe);
            bool got = PlayerEngine.ScenesPlayableFor(allow, lp, () => cap, () => lwe);
            if (got != want) fails.Add($"ScenesPlayable(AllowScenes={allow}, lp-player={lp}, scene capability={cap}, LWE={lwe}) = {got}, want {want}");
        }
        // D6: a scene marked crashed is skipped unless whitelisted; a video never
        foreach (var crashed in new[] { false, true })
        foreach (var wl in new[] { false, true })
        {
            bool want = crashed && !wl;
            if (PlayerHelper.SkipScene(true, true, crashed, wl) != want) fails.Add($"D6: a playable scene crashed={crashed} whitelisted={wl}: skipped={!want}, want {want}");
            if (!PlayerHelper.SkipScene(true, false, crashed, wl)) fails.Add($"an unplayable scene (crashed={crashed}, whitelisted={wl}) must be skipped");
            if (PlayerHelper.SkipScene(false, true, crashed, wl) || PlayerHelper.SkipScene(false, false, crashed, wl)) fails.Add("a video must never be skipped");
        }
        // a scene folder's create props: kind scene, its preview image, no audio filter
        var dir = Path.Combine("/tmp", "lpst-scene-" + Guid.NewGuid().ToString("N")[..8], "workshop", "900000001");
        try
        {
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "project.json"), "{\"type\":\"scene\"}");
            File.WriteAllBytes(Path.Combine(dir, "preview.png"), [0x89, 0x50, 0x4e, 0x47]);
            var props = LpPlayerMedia.SourceProps(dir, new AppSettings { NormalizeAudio = true, Volume = 50 });
            string P(string k) => props.TryGetValue(k, out var v) ? v?.ToString() ?? "null" : "<absent>";
            if (P("kind") != "scene") fails.Add($"SourceProps(scene folder).kind = {P("kind")}, want scene");
            if (P("preview") != Path.Combine(dir, "preview.png")) fails.Add($"SourceProps(scene folder).preview = {P("preview")}, want its preview.png");
            if (P("af") != "") fails.Add($"SourceProps(scene folder).af = {P("af")}, want \"\" (no loudnorm on a scene)");
            if (props.TryGetValue("gain.user", out var gu) && Math.Abs(Convert.ToDouble(gu) - MpvPropertyMap.VolumeDb(50)) > 1e-3)
                fails.Add($"SourceProps(scene folder).gain.user = {gu}, want {MpvPropertyMap.VolumeDb(50):0.###} (Volume 50)");
            var vid = LpPlayerMedia.SourceProps(Path.Combine(dir, "x.mp4"), new AppSettings());
            if (vid["kind"] as string != "video" || vid.ContainsKey("preview")) fails.Add($"SourceProps(.mp4) = kind {vid["kind"]}, preview {(vid.ContainsKey("preview") ? "set" : "absent")}; want video, absent");
        }
        finally { try { Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(dir))!, true); } catch { } }
    }

    // ---- Task 20c: next/prev/random's scene-skip decision point ------------------------------
    // TryStepLibrary/ApplyRandom/AdvanceToNext (PlayerHelper) skip a path exactly when
    // `IsScenePath(path) && !PlayerEngine.ScenesPlayable(settings)` — the same formula the
    // private IsSkippedPath uses, reused here rather than invented (.claude/rules/player.md /
    // player-adapter.md: "skipped exactly like AllowScenes=false"). Needs no player, no
    // mpvpaper, no `--serve` — pure decision logic, so this also covers the "legacy engine
    // check that scenes are still reachable when AllowScenes=true" requirement without needing
    // linux-wallpaperengine installed on the test box (it stops at the decision point when LWE
    // isn't on PATH here — documented below, same allowance task-20c gives the IT script).
    private static void SceneSkipAssertions(List<string> fails)
    {
        const string scenePath = "/tmp/lp-selftest-lib/workshop/123";   // no extension → a scene
        const string videoPath = "/tmp/lp-selftest-lib/imported/v1/v1.mp4";

        if (!PlayerHelper.IsScenePath(scenePath)) fails.Add("IsScenePath(workshop dir) should be true");
        if (PlayerHelper.IsScenePath(videoPath)) fails.Add("IsScenePath(.mp4) should be false");

        static bool WouldSkip(string path, AppSettings s) =>
            PlayerHelper.IsScenePath(path) && !PlayerEngine.ScenesPlayable(s);

        try
        {
            // lp-player (Phase 2): playable exactly when the player has the `scene` capability — the
            // capability half is SceneAdapterAssertions' truth table (pure: asking the shared client
            // here would greet whatever player owns the default socket)
            static bool LpSkip(string path, bool cap) =>
                PlayerHelper.IsScenePath(path) && !PlayerEngine.ScenesPlayableFor(true, true, () => cap, () => false);
            if (!LpSkip(scenePath, cap: false)) fails.Add("lp-player without the scene capability should skip a scene");
            if (LpSkip(scenePath, cap: true)) fails.Add("lp-player with the scene capability + AllowScenes should play a scene");
            if (LpSkip(videoPath, cap: false)) fails.Add("lp-player should never skip a video");

            var legacyOff = new AppSettings { PlayerEngine = PlayerEngine.Legacy, AllowScenes = false };
            PlayerEngine.Refresh(legacyOff);
            if (!WouldSkip(scenePath, legacyOff))
                fails.Add("legacy + AllowScenes=false should still skip a scene (unchanged contract)");

            // legacy + AllowScenes=true: ACTUALLY reaching a scene additionally needs
            // linux-wallpaperengine on PATH (ScenesPlayable → PlayerHelper.IsLweAvailable, a real
            // `which`) — orthogonal to this fix and not faked here. What this proves without it:
            // the skip formula has no lp-player-only special case — it's driven purely by
            // ScenesPlayable, so whenever that's true (LWE present, e.g. a real install) a scene
            // is reached, never skipped — identical to the pre-fix TryStepLibrary, which picked
            // library[idx] unconditionally (WouldSkip is false for every candidate in that case).
            var legacyOn = new AppSettings { PlayerEngine = PlayerEngine.Legacy, AllowScenes = true };
            PlayerEngine.Refresh(legacyOn);
            bool lweHere = PlayerEngine.ScenesPlayable(legacyOn);
            if (lweHere && WouldSkip(scenePath, legacyOn))
                fails.Add("legacy + AllowScenes=true + LWE present should NOT skip a scene (regression)");
            Console.WriteLine(lweHere
                ? "  scene-skip: linux-wallpaperengine found on PATH — legacy+AllowScenes=true scene reachability verified live"
                : "  scene-skip: no linux-wallpaperengine on PATH here — stopped at the decision point (task-20c); " +
                  "verified the skip formula has no engine-specific case instead");
        }
        finally { PlayerEngine.Refresh(SettingsService.Load()); } // restore the real cached engine for RoundTrip
    }

    // ---- item 6: queue depth cap, never blocks a caller --------------------------------------
    // Needs no player at all — LpPlayerMedia.Queue is pure in-process chaining. One slow item clogs
    // the single-worker FIFO deterministically (no timing race needed to "win" against the drain), so
    // a burst enqueued right behind it piles up — the cap must bound it, and enqueueing itself must
    // never block regardless of how clogged the chain is.
    private static void QueueDepthAssertions(List<string> fails)
    {
        _ = LpPlayerMedia.Queue(() => { Thread.Sleep(1500); return 0; });
        var sw = Stopwatch.StartNew();
        for (int i = 0; i < LpPlayerMedia.MaxQueueDepth + 60; i++) LpPlayerMedia.Queue(() => 0);
        sw.Stop();
        if (sw.ElapsedMilliseconds > 500) fails.Add($"enqueueing behind a clogged queue took {sw.ElapsedMilliseconds} ms (must never block the caller)");
        if (LpPlayerMedia.QueueDepth > LpPlayerMedia.MaxQueueDepth) fails.Add($"queue depth {LpPlayerMedia.QueueDepth} exceeds the cap {LpPlayerMedia.MaxQueueDepth}");
        try { LpPlayerMedia.Drain().Wait(8000); } catch { }
        if (LpPlayerMedia.QueueDepth != 0) fails.Add($"queue depth {LpPlayerMedia.QueueDepth} after draining, want 0");

        // Coalescing (speed storm): the newest command of a key replaces a still-pending one, the rest
        // keep their order, and nothing coalesces across an essential command (a switch/stop barrier).
        var ran = new List<string>();
        void Rec(string s) { lock (ran) ran.Add(s); }
        _ = LpPlayerMedia.Queue(() => { Thread.Sleep(300); return 0; }); // clog: everything below piles up
        var a1 = LpPlayerMedia.QueueSet("t:a", () => Rec("a1"));
        LpPlayerMedia.QueueSet("t:b", () => Rec("b1"));
        LpPlayerMedia.QueueSet("t:a", () => Rec("a2"));   // replaces a1; b1 keeps its place before it
        LpPlayerMedia.QueueEssential(() => Rec("E1"));    // barrier
        LpPlayerMedia.QueueSet("t:a", () => Rec("a3"));   // after the barrier: never merged into a2
        LpPlayerMedia.QueueSet("t:a", () => Rec("a4"));   // replaces a3
        try { LpPlayerMedia.Drain().Wait(5000); } catch { }
        var want = "b1 a2 E1 a4";
        lock (ran) if (string.Join(" ", ran) != want) fails.Add($"coalescing order: ran `{string.Join(" ", ran)}`, want `{want}`");
        if (!a1.IsCompleted) fails.Add("a replaced command's task didn't complete with its replacement");

        // At the cap: a set whose key is pending still lands (the newest value, not dropped), an
        // essential command is admitted anyway, and a NEW key that can't coalesce is refused.
        ran.Clear();
        _ = LpPlayerMedia.Queue(() => { Thread.Sleep(600); return 0; });
        LpPlayerMedia.QueueSet("t:c", () => Rec("c1"));
        for (int i = 0; i < LpPlayerMedia.MaxQueueDepth + 20; i++) { int k = i; LpPlayerMedia.QueueSet($"t:d{k}", () => Rec("d")); }
        int atCap = LpPlayerMedia.QueueDepth;
        LpPlayerMedia.QueueSet("t:c", () => Rec("c2"));
        LpPlayerMedia.QueueSet("t:new", () => Rec("new"));
        LpPlayerMedia.QueueEssential(() => Rec("E2"));
        try { LpPlayerMedia.Drain().Wait(8000); } catch { }
        lock (ran)
        {
            if (atCap != LpPlayerMedia.MaxQueueDepth) fails.Add($"distinct keys past the cap: depth {atCap}, want {LpPlayerMedia.MaxQueueDepth}");
            if (ran.Contains("c1") || !ran.Contains("c2")) fails.Add($"at the cap the newest set of a pending key must replace it (c1 ran {ran.Contains("c1")}, c2 ran {ran.Contains("c2")})");
            if (ran.Contains("new")) fails.Add("at the cap a new key that can't coalesce was admitted");
            if (ran.LastOrDefault() != "E2") fails.Add($"an essential command at the cap didn't run last (last: {ran.LastOrDefault() ?? "none"})");
        }
        if (LpPlayerMedia.QueueDepth != 0) fails.Add($"queue depth {LpPlayerMedia.QueueDepth} after the coalescing checks, want 0");
    }

    // ---- protocol round-trip -----------------------------------------------------------------
    private static void RoundTrip(List<string> fails)
    {
        var bin = PlayerEngine.ResolveBinary();
        if (bin == null) { fails.Add("lp-player binary not found (set LP_PLAYER_BIN)"); return; }
        var tmp = Path.Combine("/tmp", "lpst-" + Guid.NewGuid().ToString("N")[..8]); // socket path < 108 bytes
        Directory.CreateDirectory(Path.Combine(tmp, "rt"));
        Directory.CreateDirectory(Path.Combine(tmp, "st"));
        var sock = Path.Combine(tmp, "rt", "lp.sock");
        Process? serve = null;
        try
        {
            string a = Path.Combine(tmp, "a.mp4"), b = Path.Combine(tmp, "b.mp4");
            if (!Clip(a, "testsrc2") || !Clip(b, "smptebars")) { fails.Add("ffmpeg could not make the test clips"); return; }

            var psi = new ProcessStartInfo(bin) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var x in new[] { "serve", "--headless", "--outputs", "640x360@60", "--clock", "stepped", "--ao", "null", "--socket", sock })
                psi.ArgumentList.Add(x);
            psi.Environment["XDG_RUNTIME_DIR"] = Path.Combine(tmp, "rt");
            psi.Environment["XDG_STATE_HOME"] = Path.Combine(tmp, "st");
            psi.Environment.Remove("LP_PLAYER_SOCKET");
            psi.Environment.Remove("LD_LIBRARY_PATH"); // a stray one on this machine breaks the Nix binary's libs
            psi.Environment["LP_PLAYER_ALLOW_SYNTHETIC_SCENES"] = "1"; // the scene round trip below (a synthetic scene)
            if (TransitionService.ResolveDir() is { } tdir) psi.Environment["LP_TRANSITIONS_DIR"] = tdir;
            var logPath = Path.Combine(tmp, "serve.log");
            serve = Process.Start(psi)!;
            serve.OutputDataReceived += (_, e) => { if (e.Data != null) try { File.AppendAllText(logPath, e.Data + "\n"); } catch { } };
            serve.ErrorDataReceived += (_, e) => { if (e.Data != null) try { File.AppendAllText(logPath, e.Data + "\n"); } catch { } };
            serve.BeginOutputReadLine(); serve.BeginErrorReadLine();

            var client = new LpPlayerClient(sock) { AutoSpawn = false };
            LpPlayerClient.Shared = client; // LpPlayerMedia talks to the private server only
            if (!client.WaitForSocket(5000)) { fails.Add($"headless serve never opened its socket (exit={(serve.HasExited ? serve.ExitCode : -1)})"); return; }

            // `serve` is the SUPERVISOR we spawned (serve forks+execs the compositor before anything else
            // runs) — hello.pid is the compositor CHILD, a different pid; hello.supervisor_pid is serve.Id.
            var hello = client.Call("hello", null);
            if (hello.GetProperty("protocol").GetInt32() != 1) fails.Add("hello: protocol != 1");
            int helloPid = hello.GetProperty("pid").GetInt32();
            int? helloSup = hello.TryGetProperty("supervisor_pid", out var supEl) && supEl.ValueKind == JsonValueKind.Number ? supEl.GetInt32() : (int?)null;
            if (helloPid == serve.Id) fails.Add("hello: pid equals the spawned supervisor pid — expected the compositor child's own pid");
            if (helloSup != serve.Id) fails.Add($"hello: supervisor_pid {helloSup?.ToString() ?? "null"} != spawned supervisor {serve.Id}");
            if (client.PlayerPid != helloPid) fails.Add($"client.PlayerPid {client.PlayerPid} != hello.pid {helloPid}");
            if (client.SupervisorPid != helloSup) fails.Add($"client.SupervisorPid {client.SupervisorPid} != hello.supervisor_pid {helloSup}");
            // Phase 2: the capabilities `hello` lists (this private player allows synthetic scenes, so it
            // has `scene` whenever lp-scene-worker resolves — next to lp-player in the dev tree)
            var caps = hello.GetProperty("capabilities").EnumerateArray().Select(x => x.GetString()).ToHashSet();
            if (!client.Capabilities.Contains("video")) fails.Add($"client.Capabilities = [{string.Join(",", client.Capabilities)}], want hello's [{string.Join(",", caps)}]");
            if (!caps.Contains("scene")) fails.Add($"the private player (synthetic scenes allowed) has no `scene` capability [{string.Join(",", caps)}] — is lp-scene-worker built next to {bin}?");
            if (client.ScenesAvailable != caps.Contains("scene")) fails.Add($"client.ScenesAvailable = {client.ScenesAvailable}, hello says scene={caps.Contains("scene")}");

            // the stepped clock only moves on `step` → a pump on its own connection (pausable)
            var stepper = new LpPlayerClient(sock) { AutoSpawn = false };
            var stepping = new ManualResetEventSlim(true);
            using var stop = new CancellationTokenSource();
            var pump = Task.Run(() =>
            {
                while (!stop.IsCancellationRequested)
                {
                    stepping.Wait(stop.Token);
                    try { stepper.Call("step", new Dictionary<string, object?> { ["ms"] = 40 }, 10000); }
                    catch (Exception e) when (!stop.IsCancellationRequested) { Thread.Sleep(20); _ = e; }
                }
            });
            var sw = Stopwatch.StartNew();
            void Phase(string what) { Console.Error.WriteLine($"  selftest {sw.ElapsedMilliseconds,6} ms  {what}"); }
            try
            {
                var s = new AppSettings { Loop = true, NoAudio = false, Volume = 100 };

                // A = colour (no previous picture), align now
                var red = client.Call("transition", new Dictionary<string, object?>
                {
                    ["outputs"] = "out:*",
                    ["to"] = new Dictionary<string, object?> { ["kind"] = "color", ["color"] = new[] { 1.0, 0.0, 0.0 } },
                });
                var redCorr = red.GetProperty("corr").GetString()!;
                var redOut = LpPlayerMedia.WaitCorr(redCorr, CancellationToken.None, 10000).GetAwaiter().GetResult();
                Phase("colour handoff");
                if (redOut != "handoff") { fails.Add($"colour transition {redCorr}: {redOut}"); return; }

                if (LpPlayerMedia.EventOutcomes != 0) fails.Add("an outcome arrived as an event before anything subscribed");
                // colour → clip, align now, an effect when the catalogue resolves → transition.handoff
                var cfg = new TransitionService.Config(true, ["fade"], 200, 0, false);
                using (var to = new CancellationTokenSource(20000))
                {
                    bool ok = LpPlayerMedia.SwitchAndWaitHandoff(a, s, cfg, alignEnd: false, to.Token).GetAwaiter().GetResult();
                    if (!ok) { fails.Add($"colour→clip (align now): no transition.handoff (corr {LpPlayerMedia.LastCorr})"); return; }
                }
                Phase("colour→clip handoff (align now)");
                if (LpPlayerMedia.EventOutcomes < 1) fails.Add("colour→clip handoff came from the log poll, not the subscribed event");
                if (LpPlayerMedia.CurrentPath() != a) fails.Add($"CurrentPath after colour→clip = {LpPlayerMedia.CurrentPath() ?? "null"}, want a.mp4");

                // dispatch-level translation end to end: mpv `volume 50` → srcs:*.gain.user −18.06 dB
                LpPlayerMedia.Mpv(["set_property", "volume", 50]);
                LpPlayerMedia.Drain().Wait(5000); // property sets are queued (never on the caller's thread)
                var gu = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.gain.user" }).GetProperty("value").GetDouble();
                if (Math.Abs(gu - (-18.0618)) > 1e-3) fails.Add($"volume 50 via Mpv → cur gain.user {gu}, want -18.06");
                if (LpPlayerMedia.Query("time_pos") is not double) fails.Add("Query(time_pos) = null on a playing clip");

                // Speed storm leftover: a slider burst past the queue cap behind a slow command — the
                // NEWEST value must be the one that lands (coalesced per target + property), never
                // dropped at the cap (RED before: sets past 256 were refused, the last one included).
                _ = LpPlayerMedia.Queue(() => { Thread.Sleep(600); return 0; });
                for (int i = 0; i < LpPlayerMedia.MaxQueueDepth + 60; i++) LpPlayerMedia.Mpv(["set_property", "volume", 20 + i % 40]);
                LpPlayerMedia.Mpv(["set_property", "volume", 77]);
                int depthAtBurst = LpPlayerMedia.QueueDepth;
                LpPlayerMedia.Drain().Wait(20000);
                var gu77 = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.gain.user" }).GetProperty("value").GetDouble();
                if (Math.Abs(gu77 - MpvPropertyMap.VolumeDb(77)) > 1e-3)
                    fails.Add($"queue cap: the newest volume set didn't land — gain.user {gu77:0.###}, want {MpvPropertyMap.VolumeDb(77):0.###} (depth at the burst {depthAtBurst})");
                if (depthAtBurst > 3) fails.Add($"queue cap: a burst of {LpPlayerMedia.MaxQueueDepth + 61} sets of ONE property queued {depthAtBurst} commands (want them coalesced: the slow one + 1)");
                Phase($"coalesced slider burst: depth {depthAtBurst}, landed gain.user {gu77:0.##}");

                // /preview round trips (speed storm): a drag value costs ONE `set` per source — not a
                // `state` read for the path → source ids (+ `get cur:*.path` without paths) every time.
                // The map is cached until the graph changes (RED before: 2 requests per value).
                LpPlayerMedia.Preview(30, null, [a]); LpPlayerMedia.Drain().Wait(2000); // may (re)read the map once
                long req0 = client.RequestCount; int reads0 = LpPlayerMedia.SourceMapReads;
                const int nPrev = 20;
                for (int i = 0; i < nPrev; i++) { LpPlayerMedia.Preview(31 + i, null, [a]); LpPlayerMedia.Drain().Wait(2000); }
                double perPreview = (client.RequestCount - req0) / (double)nPrev;
                var guPrev = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.gain.user" }).GetProperty("value").GetDouble();
                if (perPreview > 1.05) fails.Add($"/preview costs {perPreview:0.##} requests per value (want 1: one `set` on the cached source; map reads {LpPlayerMedia.SourceMapReads - reads0})");
                if (Math.Abs(guPrev - MpvPropertyMap.VolumeDb(50)) > 1e-3) fails.Add($"/preview's last value didn't land: gain.user {guPrev:0.###}, want {MpvPropertyMap.VolumeDb(50):0.###}");
                Phase($"/preview: {perPreview:0.##} requests per value over {nPrev} (map reads {LpPlayerMedia.SourceMapReads - reads0})");

                // the effective-settings resolver's diff (player-adapter.md § Targeting): a full pass over a source
                // that already runs every effective value costs its one `state` read and sends nothing; a value
                // another client changed behind our back is put back by the next full pass
                var spBefore = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.speed" }).GetProperty("value").GetDouble();
                LpPlayerMedia.ApplyEffective(); LpPlayerMedia.Drain().Wait(2000); // A now runs the settings' own values
                long rq0 = client.RequestCount;
                LpPlayerMedia.ApplyEffective(); LpPlayerMedia.Drain().Wait(2000);
                long noop = client.RequestCount - rq0;
                if (noop != 1) fails.Add($"a no-op resolver pass cost {noop} requests (want 1: the `state` read, no `set`)");
                var behind = new LpPlayerClient(sock) { AutoSpawn = false };
                behind.Call("set", new Dictionary<string, object?> { ["path"] = "cur:*.speed", ["value"] = 2.5 });
                LpPlayerMedia.ApplyEffective(); LpPlayerMedia.Drain().Wait(2000);
                var spBack = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.speed" }).GetProperty("value").GetDouble();
                double spWant = Math.Clamp(SettingsService.Load().Speed, 0.1, 4.0);
                if (Math.Abs(spBack - spWant) > 1e-6) fails.Add($"a full resolver pass left another client's speed 2.5 (speed {spBack}, want {spWant})");
                else Phase($"resolver: a no-op pass costs {noop} request; another client's speed change put back");
                behind.Call("set", new Dictionary<string, object?> { ["path"] = "cur:*.speed", ["value"] = spBefore }); // the clip's timing below stays as it was
                LpPlayerMedia.InvalidateSources(); // …and no cached value pretends otherwise
                LpPlayerMedia.Mpv(["set_property", "volume", 50]); LpPlayerMedia.Drain().Wait(2000); // back to the global (srcs:*)

                // transitions OFF + video end (the gapless branch): cut at A's end
                using (var to = new CancellationTokenSource(30000))
                {
                    bool ok = LpPlayerMedia.SwitchAndWaitHandoff(b, s, null, alignEnd: true, to.Token).GetAwaiter().GetResult();
                    if (!ok) { fails.Add($"clip→clip cut (align end): no transition.handoff (corr {LpPlayerMedia.LastCorr})"); return; }
                }
                Phase("clip→clip cut handoff (align end)");
                if (LpPlayerMedia.CurrentPath() != b) fails.Add($"CurrentPath after cut = {LpPlayerMedia.CurrentPath() ?? "null"}, want b.mp4");

                // the source map is invalidated by a switch: b's NEW source (absent from the map read
                // while a played) gets the preview
                LpPlayerMedia.Preview(44, null, [b]); LpPlayerMedia.Drain().Wait(2000);
                var guB = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.gain.user" }).GetProperty("value").GetDouble();
                if (Math.Abs(guB - MpvPropertyMap.VolumeDb(44)) > 1e-3) fails.Add($"/preview after a switch missed the new source: gain.user {guB:0.###}, want {MpvPropertyMap.VolumeDb(44):0.###}");
                // …and by ANOTHER client's switch (a pending B nobody here requested), through its event
                var foreign = new LpPlayerClient(sock) { AutoSpawn = false };
                int epoch0 = LpPlayerMedia.SourceEpoch;
                var fr = foreign.Call("transition", new Dictionary<string, object?>
                {
                    ["outputs"] = "out:*",
                    ["to"] = new Dictionary<string, object?> { ["path"] = a, ["loop"] = true },
                    ["align"] = "end",
                });
                string fCorr = fr.GetProperty("corr").GetString()!, fB = fr.GetProperty("to").GetString()!;
                var esw = Stopwatch.StartNew();
                while (LpPlayerMedia.SourceEpoch == epoch0 && esw.ElapsedMilliseconds < 3000) Thread.Sleep(10);
                LpPlayerMedia.Preview(55, null, [a]); LpPlayerMedia.Drain().Wait(2000);
                var guF = client.Call("get", new Dictionary<string, object?> { ["path"] = $"{fB}.gain.user" }).GetProperty("value").GetDouble();
                if (LpPlayerMedia.SourceEpoch == epoch0) fails.Add("another client's switch never invalidated the source map (no event within 3 s)");
                if (Math.Abs(guF - MpvPropertyMap.VolumeDb(55)) > 1e-3) fails.Add($"/preview missed another client's pending B {fB}: gain.user {guF:0.###}, want {MpvPropertyMap.VolumeDb(55):0.###}");
                else Phase($"/preview reached a new source after our switch and another client's pending B ({fB})");
                try { foreign.Call("cancel", new Dictionary<string, object?> { ["corr"] = fCorr }); } catch (LpPlayerException) { }
                Thread.Sleep(100);
                LpPlayerMedia.Mpv(["set_property", "volume", 50]); LpPlayerMedia.Drain().Wait(2000);

                // caller cancel → `cancel {corr}` → false, and the player reports it cancelled
                stepping.Reset(); // clock frozen → A never ends → the aligned switch stays pending
                using (var cts = new CancellationTokenSource(400))
                {
                    bool ok = LpPlayerMedia.SwitchAndWaitHandoff(a, s, cfg, alignEnd: true, cts.Token).GetAwaiter().GetResult();
                    if (ok) fails.Add("cancelled aligned switch returned true");
                }
                Phase("cancelled aligned switch returned");
                var corr = LpPlayerMedia.LastCorr;
                var logs = client.Call("logs", new Dictionary<string, object?> { ["corr"] = corr, ["kind_prefix"] = "transition." });
                bool cancelled = logs.GetProperty("events").EnumerateArray().Any(e => e.GetProperty("kind").GetString() == "transition.cancelled");
                if (!cancelled) fails.Add($"cancel {corr}: no transition.cancelled in its log");
                stepping.Set();
                if (LpPlayerMedia.CurrentPath() != b) fails.Add("cancel didn't leave A (b.mp4) on screen");

                // Phase 2 Task 11: a scene folder plays as `kind: scene` (a synthetic one), takes the
                // settings like a video, and the per-monitor scene fps reaches its output live
                var scene = Path.Combine(tmp, "workshop", "900000001");
                SyntheticScene(scene);
                using (var to = new CancellationTokenSource(20000))
                {
                    bool ok = LpPlayerMedia.SwitchAndWaitHandoff(scene, s, cfg, alignEnd: false, to.Token).GetAwaiter().GetResult();
                    if (!ok) fails.Add($"clip→scene fade: no transition.handoff (corr {LpPlayerMedia.LastCorr})");
                }
                string? Cur(string prop) { try { var v = client.Call("get", new Dictionary<string, object?> { ["path"] = $"cur:*.{prop}" }).GetProperty("value"); return v.ValueKind == JsonValueKind.String ? v.GetString() : v.GetRawText(); } catch (LpPlayerException e) { return e.Code; } }
                if (Cur("kind") != "scene" || Cur("ready") != "true" || Cur("preview") != Path.Combine(scene, "preview.png"))
                    fails.Add($"the scene folder plays as kind={Cur("kind")} ready={Cur("ready")} preview={Cur("preview")}, want scene/true/its preview.png");
                else Phase("clip→scene fade: kind scene, ready, preview set");
                LpPlayerMedia.ApplySceneFps([], [new LweMonitorSettings { Name = "VIRTUAL-1", Fps = 45 }]);
                LpPlayerMedia.Drain().Wait(2000);
                double Fps() => client.Call("get", new Dictionary<string, object?> { ["path"] = "out:VIRTUAL-1.scene_fps" }).GetProperty("value").GetDouble();
                if (Math.Abs(Fps() - 45) > 1e-6) fails.Add($"ApplySceneFps(VIRTUAL-1 45) → out:VIRTUAL-1.scene_fps {Fps()}, want 45");
                LpPlayerMedia.ApplySceneFps([new LweMonitorSettings { Name = "VIRTUAL-1", Fps = 45 }], []);
                LpPlayerMedia.Drain().Wait(2000);
                if (Math.Abs(Fps() - 30) > 1e-6) fails.Add($"removing VIRTUAL-1 from LweMonitors → scene_fps {Fps()}, want the default 30");
                else Phase("ApplySceneFps: VIRTUAL-1 45 live, back to 30 when removed");
                // Task 8: the GPU / VRAM settings → the player props, live, diffed
                string PlayerProp(string p) { var v = client.Call("get", new Dictionary<string, object?> { ["path"] = $"player.{p}" }).GetProperty("value"); return v.ValueKind == JsonValueKind.String ? v.GetString()! : v.GetRawText(); }
                var g0 = new AppSettings();
                var g1 = new AppSettings { SceneThrottle = false, SceneVramLimitEnabled = true, SceneVramLimitMib = 1536, VramLowMode = "pause" };
                LpPlayerMedia.ApplyGpuSettings(g0, g1); LpPlayerMedia.Drain().Wait(2000);
                string Gpu() => $"{PlayerProp("scene_throttle")} {PlayerProp("scene_vram_limit_mib")} {PlayerProp("vram_low_mode")}";
                if (Gpu() != "false 1536.0 pause" && Gpu() != "false 1536 pause") fails.Add($"ApplyGpuSettings → {Gpu()}, want false 1536 pause");
                LpPlayerMedia.ApplyGpuSettings(g1, g0); LpPlayerMedia.Drain().Wait(2000);
                if (Gpu() != "true 0.0 stop" && Gpu() != "true 0 stop") fails.Add($"ApplyGpuSettings back to the defaults → {Gpu()}, want true 0 stop");
                else Phase("ApplyGpuSettings: scene_throttle / scene_vram_limit_mib / vram_low_mode live and back");
                using (var to = new CancellationTokenSource(20000))
                {
                    bool ok = LpPlayerMedia.SwitchAndWaitHandoff(b, s, null, alignEnd: false, to.Token).GetAwaiter().GetResult();
                    if (!ok || LpPlayerMedia.CurrentPath() != b) fails.Add($"scene→clip cut: handoff={ok}, cur {LpPlayerMedia.CurrentPath() ?? "null"}");
                }
                LpPlayerMedia.Mpv(["set_property", "volume", 50]); LpPlayerMedia.Drain().Wait(2000);

                // a STOPPED player costs one quick timeout, then the stall breaker answers at once.
                // The COMPOSITOR holds the socket (the supervisor never does) — SIGSTOP/SIGCONT it, never
                // the supervisor, which would see no effect at all and prove nothing.
                int compositorPid = client.PlayerPid ?? serve.Id;
                stepping.Reset(); Thread.Sleep(300);
                kill(compositorPid, 19); // SIGSTOP the compositor
                try
                {
                    var q = Stopwatch.StartNew();
                    var p1 = LpPlayerMedia.CurrentPath(); long t1 = q.ElapsedMilliseconds; q.Restart();
                    var p2 = LpPlayerMedia.CurrentPath(); long t2 = q.ElapsedMilliseconds;
                    LpPlayerMedia.Mpv(["set_property", "volume", 80]); long t3 = q.ElapsedMilliseconds - t2;
                    if (p1 != null || p2 != null) fails.Add("a stopped player still answered");
                    if (t1 > 450) fails.Add($"first query to a stopped player took {t1} ms (want ≤ 450: QuickMs + slack)");
                    if (t2 > 50) fails.Add($"query after the timeout took {t2} ms (want the stall breaker: ≤ 50)");
                    if (t3 > 50) fails.Add($"a property set blocked its caller {t3} ms (want queued: ≤ 50)");
                    Phase($"stopped player: query {t1} ms, then {t2} ms (breaker), set returned in {t3} ms");
                }
                finally { kill(compositorPid, 18); } // SIGCONT
                stepping.Set();
                Thread.Sleep(3300); // the breaker re-opens the line 3 s after the timeout
                if (LpPlayerMedia.CurrentPath() != b) fails.Add("no recovery after SIGCONT (+3 s breaker window)");
                Phase("recovered after SIGCONT");
                // R81: the breaker closing (this is exactly that — the first query above after it
                // reopened) must have fired a reapply, catching up whatever the `volume 80` set during
                // the stall (above) dropped. OnRecovered's Queue(...) is fire-and-forget (by design — it
                // must never block the caller that happened to be the one to notice the recovery), so
                // wait for the chain here before checking/moving on — otherwise this reapply races the
                // NEXT phase's compositor kill below and runs against a player that's already dead again.
                LpPlayerMedia.Drain().Wait(2000);
                if (LpPlayerMedia.ReapplyCount < 1) fails.Add("R81: no settings reapply after the stall recovered (OnRecovered)");
                else Phase($"R81: stall recovery triggered a reapply ({LpPlayerMedia.ReapplyCount}x so far)");

                // I3 (final review): the pause is toggled by ANOTHER process (a keybind's one-shot
                // `livepaper --action=toggle-pause` — here a second, independent client): this
                // backend has no memory of it, and must never re-assert one. After the supervised
                // restart below (whose snapshot restores `player.paused`) and its R81 reapply, the
                // pause must still be on — not flipped.
                var other = new LpPlayerClient(sock) { AutoSpawn = false };
                other.Call("set", new Dictionary<string, object?> { ["path"] = "player.paused", ["value"] = true }, 2000);
                Thread.Sleep(600); // the snapshot is written 250 ms after a change

                // Supervised restart (Task 17 fix): SIGKILL the COMPOSITOR directly, never the supervisor
                // — the supervisor must see this as a crash and restart its child with a NEW hello.pid
                // (same supervisor_pid) within ~1.5 s (measured on-machine: 150-260 ms).
                int reapplyBeforeRestart = LpPlayerMedia.ReapplyCount;
                int deadCompositor = client.PlayerPid ?? -1;
                int priorSupervisor = client.SupervisorPid ?? serve.Id;
                kill(deadCompositor, 9);
                int newCompositor = -1;
                var rsw = Stopwatch.StartNew();
                // Polled with a FRESH client per attempt: a hello that reaches the new compositor before
                // it serves times out, and the shared client's stall breaker would then fail every
                // further attempt for 3 s (under load that alone used to fail this check).
                while (rsw.ElapsedMilliseconds < 1500)
                {
                    try
                    {
                        var h = new LpPlayerClient(sock) { AutoSpawn = false }.Call("hello", null, 300);
                        int hp = h.GetProperty("pid").GetInt32();
                        if (hp != deadCompositor) { newCompositor = hp; break; }
                    }
                    catch (LpPlayerException) { }
                    Thread.Sleep(30);
                }
                Phase($"supervised restart: compositor {deadCompositor} -> {newCompositor} in {rsw.ElapsedMilliseconds} ms");
                // …then the shared client must notice it too (its breaker may still be open for ≤ 3 s)
                var nsw = Stopwatch.StartNew();
                while (newCompositor >= 0 && client.PlayerPid != newCompositor && nsw.ElapsedMilliseconds < 4000)
                {
                    try { client.Call("hello", null, 300); } catch (LpPlayerException) { }
                    if (client.PlayerPid != newCompositor) Thread.Sleep(50);
                }
                if (newCompositor < 0) fails.Add($"killing the compositor (pid {deadCompositor}) did not yield a new hello.pid within 1.5 s");
                else if (client.PlayerPid != newCompositor) fails.Add($"the shared client never saw the restarted compositor {newCompositor} (still {client.PlayerPid})");
                else if (client.SupervisorPid != priorSupervisor) fails.Add($"after the supervised restart, supervisor_pid {client.SupervisorPid} != {priorSupervisor} (expected the SAME supervisor)");

                // R81: OnRestarted must have queued a reapply of the backend's current effective settings.
                if (newCompositor >= 0)
                {
                    LpPlayerMedia.Drain().Wait(2000);
                    if (LpPlayerMedia.ReapplyCount <= reapplyBeforeRestart) fails.Add("R81: no settings reapply after the supervised restart (OnRestarted)");
                    else Phase($"R81: supervised restart triggered a reapply ({LpPlayerMedia.ReapplyCount}x so far)");
                    var pausedAfter = client.Call("get", new Dictionary<string, object?> { ["path"] = "player.paused" }).GetProperty("value").ValueKind;
                    if (pausedAfter != JsonValueKind.True) fails.Add($"I3: player.paused after the restart + reapply = {pausedAfter}, want true (a pause from another process must survive, never be flipped)");
                    else Phase("I3: a pause set by another process survived the restart + reapply");
                    // and the toggle reads the player's truth: one toggle un-pauses
                    if (!LpPlayerMedia.TogglePause()) fails.Add("I3: TogglePause failed after the restart");
                    var pausedToggled = client.Call("get", new Dictionary<string, object?> { ["path"] = "player.paused" }).GetProperty("value").ValueKind;
                    if (pausedToggled != JsonValueKind.False) fails.Add($"I3: one TogglePause after the restart left player.paused = {pausedToggled}, want false");
                }

                // StopAndQuit afterwards must leave NO lp-player process — neither the (new) compositor
                // nor the supervisor (the old adapter bug: signalling the compositor pid alone while its
                // supervisor lived just made the supervisor restart it again).
                LpPlayerMedia.StopAndQuit();
                bool compositorAlive = StillRunning(newCompositor >= 0 ? newCompositor : deadCompositor);
                bool supervisorAlive = StillRunning(priorSupervisor);
                if (compositorAlive || supervisorAlive) fails.Add($"StopAndQuit left a process alive (compositor={compositorAlive}, supervisor={supervisorAlive})");
                else Phase("StopAndQuit left no lp-player process (compositor and supervisor both gone)");
            }
            finally
            {
                stop.Cancel(); stepping.Set();
                try { pump.Wait(3000); } catch { }
            }
        }
        finally
        {
            try { if (serve is { HasExited: false }) new LpPlayerClient(sock) { AutoSpawn = false }.Call("quit", null, 2000); } catch { }
            try { if (serve is { HasExited: false } && !serve.WaitForExit(3000)) serve.Kill(true); } catch { }
            LpPlayerClient.ResetShared();
            try { Directory.Delete(tmp, true); } catch { }
        }
    }

    [System.Runtime.InteropServices.DllImport("libc")] private static extern int kill(int pid, int sig);

    // Is `pid` (still) an lp-player process? item 5: via `/proc/<pid>/exe`'s link target (the real
    // resolved binary path), never a cmdline substring — same check as LpPlayerClient.IsPlayerProcess,
    // duplicated here since that one is private.
    private static bool StillRunning(int pid)
    {
        try { return Path.GetFileName(new FileInfo($"/proc/{pid}/exe").LinkTarget) == "lp-player"; } catch { return false; }
    }

    // A synthetic scene item folder (what lp-player's tests/common::synthetic_scene writes): plays the
    // worker's synthetic renderer only when the player runs with LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1.
    internal static void SyntheticScene(string dir, string spec = "{\"pattern\":\"solid\",\"rgb\":[0,128,255],\"native\":[640,360]}")
    {
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "project.json"), "{\"type\":\"scene\",\"title\":\"synthetic\",\"file\":\"scene.json\",\"preview\":\"preview.png\"}");
        File.WriteAllBytes(Path.Combine(dir, "scene.pkg"), new byte[16]);
        File.WriteAllText(Path.Combine(dir, "lp-synthetic.json"), spec);
        File.WriteAllBytes(Path.Combine(dir, "preview.png"), Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC"));
    }

    private static bool Clip(string path, string pattern)
    {
        try
        {
            var psi = new ProcessStartInfo("ffmpeg") { UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true };
            foreach (var x in new[] { "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", $"{pattern}=size=320x180:rate=30",
                         "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "libx264",
                         "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path })
                psi.ArgumentList.Add(x);
            using var p = Process.Start(psi)!;
            p.StandardOutput.ReadToEnd(); p.StandardError.ReadToEnd();
            p.WaitForExit(20000);
            return p.ExitCode == 0 && File.Exists(path);
        }
        catch { return false; }
    }
}
