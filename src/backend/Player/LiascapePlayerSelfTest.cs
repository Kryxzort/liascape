using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;

namespace Liascape.Player;

// Hidden `liascape player-selftest`: MpvPropertyMap + stream-ownership assertions, then a
// protocol round-trip against a PRIVATE `liascape-player serve --headless --clock stepped --ao null`
// (temp XDG_RUNTIME_DIR/XDG_STATE_HOME + its own socket, killed at the end). It never touches a
// real running player: the shared client is pointed at the temp socket and never auto-spawns.
// Prints `PASS` or `FAIL <reasons>`, exit 0/1.
public static class LiascapePlayerSelfTest
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
            TransitionDurationAssertions(fails);
            FeatureHealthAssertions(fails);
            ScenePropertyAssertions(fails);
            PresetAssertions(fails);
            PlayLimitAssertions(fails);
            ProgramSpecAssertions(fails);
            OutboxAckAssertions(fails);
            StaleThroughWrapperAssertions(fails);
            BinaryResolutionAssertions(fails);
            StartupGraceAssertions(fails);
            StartArgsAssertions(fails);
            RendererLatchAssertions(fails);
            if (fails.Count == 0) QueueDepthAssertions(fails);
            if (fails.Count == 0) RoundTrip(fails);
        }
        catch (Exception e) { fails.Add($"{e.GetType().Name}: {e.Message}"); }
        if (fails.Count == 0) { Console.WriteLine("PASS"); return 0; }
        Console.WriteLine("FAIL " + string.Join("; ", fails));
        return 1;
    }

    // ---- what a live ack may cover: only an unbroken run of handled seqs after the last ack ----------------------------
    private static void OutboxAckAssertions(List<string> fails)
    {
        void Check(string what, long done, long[] handled, long want, long[] left)
        {
            var set = new SortedSet<long>(handled);
            long got = LiascapePlayerClient.AdvanceAcked(set, done);
            if (got != want || !set.SetEquals(left))
                fails.Add($"outbox ack {what}: {got} left [{string.Join(",", set)}], want {want} left [{string.Join(",", left)}]");
        }
        Check("the next seq", 5, [6], 6, []);
        Check("a run, handled out of order", 5, [8, 6, 7], 8, []);
        Check("a gap holds (#7 not handled: its store is running or threw)", 5, [6, 8], 6, [8]);
        Check("nothing next", 5, [7], 5, [7]);
        Check("already covered by the drain", 5, [3, 5], 5, []);
    }

    // ---- a rotation session → the player's program spec (LiascapePlayerProgram.BuildSpec) -----------------------------
    private static void ProgramSpecAssertions(List<string> fails)
    {
        var dir = Path.Combine(Path.GetTempPath(), $"lia-selftest-prog-{Environment.ProcessId}"); // never created: no file is read
        {
            string a = Path.Combine(dir, "a.mp4"), b = Path.Combine(dir, "b.mp4"), img = Path.Combine(dir, "c.png");
            var g = new AppSettings
            {
                AllowScenes = false, Volume = 50, Speed = 1.5, NoAudio = false, TransitionMethod = "frozen",
                GlobalIntervalSeconds = 30, GlobalSwitchWhenVideoEnds = true, GlobalMaxPlaySeconds = 600,
                GlobalSeparateSceneTiming = true, GlobalSwitchScenesAfterSeconds = 90,
                GlobalTransitionEnabled = true, GlobalTransitionEffectIds = ["fade", "wipe"], GlobalTransitionDurationMs = 400,
                GlobalTransitionDurationMaxMs = 900, GlobalTransitionShuffle = false, GlobalPlaylistStart = "resume",
            };
            var own = new PlaylistSettings
            {
                OverrideGlobalSettings = true, IntervalSeconds = 5, SwitchWhenVideoEnds = false, MaxPlaySeconds = 7,
                SeparateSceneTiming = false, SwitchScenesAfterSeconds = 12, TransitionEnabled = false, TransitionDurationMs = 0,
                PlaylistStart = "start_over",
            };
            var follows = new PlaylistSettings { OverrideGlobalSettings = false, MaxPlaySeconds = 7, PlaylistStart = "start_over" };
            string J(object? v) => JsonSerializer.Serialize(v);
            void Want(string what, object? got, object? want) { if (J(got) != J(want)) fails.Add($"program spec {what} = {J(got)}, want {J(want)}"); }

            // on_end (advance) vs timer: the interval → interval_ms; max / scene timing from EffectiveRotation
            var sp = LiascapePlayerProgram.BuildSpec([a, b, img], g, follows, shuffle: true, intervalSeconds: 30, advance: true, key: "name:Mix");
            Want("mode (advance)", sp.Mode, "on_end"); Want("interval_ms", sp.IntervalMs, 30_000L); Want("order", sp.Order, "shuffle");
            Want("max_ms (follows)", sp.MaxMs, 600_000L); Want("separate_scenes", sp.SeparateScenes, true); Want("scenes_after_ms", sp.ScenesAfterMs, 90_000L);
            Want("key", sp.Key, "name:Mix"); Want("start_mode (follows the global)", sp.StartMode, "resume"); Want("while_parked", sp.WhileParked, "rotate");
            Want("transition (globals)", sp.Transition, new Dictionary<string, object?> { ["enabled"] = true, ["effects"] = new[] { "fade", "wipe" },
                ["shuffle"] = false, ["duration_ms"] = 400.0, ["duration_max_ms"] = 900.0, ["method"] = "frozen" });
            var so = LiascapePlayerProgram.BuildSpec([a, b], g, own, shuffle: false, intervalSeconds: 5, advance: false, key: "bar");
            Want("mode (timer)", so.Mode, "timer"); Want("interval_ms (timer)", so.IntervalMs, 5_000L); Want("order", so.Order, "sequential");
            Want("max_ms (override)", so.MaxMs, 7_000L); Want("separate_scenes (override)", so.SeparateScenes, false); Want("scenes_after_ms (override)", so.ScenesAfterMs, 12_000L);
            Want("start_mode (override)", so.StartMode, "start_over");
            Want("transition (override: off, 0 ms)", (so.Transition["enabled"], so.Transition["duration_ms"]), (false, 0.0));
            g.TransitionMethod = "nonsense";
            Want("method (unknown → reveal)", LiascapePlayerProgram.TransitionMap(g, null)["method"], "reveal");
            Want("key of a saved playlist / the bar", (LiascapePlayerProgram.KeyOf("Chill"), LiascapePlayerProgram.KeyOf(null), LiascapePlayerProgram.KeyOf(" ")), ("name:Chill", "bar", "bar"));
            Want("start mode normalized", (AppSettings.PlaylistStartMode("RESUME"), AppSettings.PlaylistStartMode("whatever"), new PlaylistSettings().PlaylistStart, new AppSettings().GlobalPlaylistStart),
                ("resume", "start_over", "start_over", "start_over"));
            Want("cover mode normalized", (AppSettings.CoverMode("OFF"), AppSettings.CoverMode(" Fullscreen "), AppSettings.CoverMode("bogus"), AppSettings.CoverMode(null), new AppSettings().PauseWhenCovered),
                ("off", "fullscreen", "maximized", "maximized", "maximized"));
            g.RotateWhileParked = false;
            Want("while_parked (RotateWhileParked off)", LiascapePlayerProgram.BuildSpec([a, b], g, follows, shuffle: false, intervalSeconds: 30, advance: true, key: "bar").WhileParked, "hold");
            g.RotateWhileParked = true;

            // defaults = DesiredGlobal: the globals' values, kind video, Loop; no af (loudnorm is per item)
            var d = sp.Defaults;
            Want("defaults.gain.user", Math.Round((double)d["gain.user"]!, 2), -18.06); Want("defaults.speed", d["speed"], 1.5);
            Want("defaults.kind/loop/af", (d["kind"], d["loop"], d["af"]), ("video", true, ""));
            if (!d.ContainsKey("gain.mute") || !d.ContainsKey("hwdec") || !d.ContainsKey("no_audio")) fails.Add($"program defaults lack gain.mute/hwdec/no_audio: {J(d)}");
            // a plain video (nothing of its own) carries nothing; an image its kind; nothing is skipped (no scenes)
            Want("item a (a plain video)", sp.Items[0].Props, new Dictionary<string, object?>());
            Want("item c (an image)", sp.Items[2].Props, new Dictionary<string, object?> { ["kind"] = "image" });
            Want("skips (no scenes)", sp.Items.Select(i => i.Skip), new[] { false, false, false });
            // the rule over fake items: an item's own volume → only gain.user; a scene its kind/preview/normalize/props; the skip flag
            Dictionary<string, object?> Item(string path) => path switch
            {
                "v" => new(d) { ["path"] = "v", ["gain.user"] = -6.0 },
                "s" => new(d) { ["path"] = "s", ["kind"] = "scene", ["preview"] = "/p.jpg", ["gain.normalize"] = 3.5, ["scene_props"] = new Dictionary<string, object?> { ["x"] = 1 } },
                _ => new(d) { ["path"] = path },
            };
            var items = LiascapePlayerProgram.BuildItems(["v", "s", "z", "v"], d, Item, p => p == "s");
            Want("items (deduplicated)", items.Select(i => i.Path), new[] { "v", "s", "z" });
            Want("an item with its own volume", items[0].Props, new Dictionary<string, object?> { ["gain.user"] = -6.0 });
            Want("a scene item", items[1].Props.Keys.Order(), new[] { "gain.normalize", "kind", "preview", "scene_props" });
            Want("a crashed scene's skip", (items[1].Skip, items[0].Skip), (true, false));
            Want("an item like the defaults", items[2].Props, new Dictionary<string, object?>());
        }
    }

    // ---- the rotation: advance-on-end's minimum (= the interval field) / maximum (player-adapter.md § Rotation) ---------
    private static void PlayLimitAssertions(List<string> fails)
    {
        // effective: the playlist's own rotation only when it overrides the global one
        var g = new AppSettings { GlobalIntervalSeconds = 30, GlobalSwitchWhenVideoEnds = true, GlobalMaxPlaySeconds = 600,
                                  GlobalSeparateSceneTiming = true, GlobalSwitchScenesAfterSeconds = 90 };
        var own = new PlaylistSettings { OverrideGlobalSettings = true, IntervalSeconds = 5, SwitchWhenVideoEnds = false, MaxPlaySeconds = 0,
                                         SeparateSceneTiming = false, SwitchScenesAfterSeconds = 12 };
        var follows = new PlaylistSettings { OverrideGlobalSettings = false, IntervalSeconds = 5, SwitchWhenVideoEnds = false, MaxPlaySeconds = 7,
                                             SeparateSceneTiming = false, SwitchScenesAfterSeconds = 12 };
        void Eff(PlaylistSettings? p, (int, bool, int, bool, int) want, string what)
        {
            var got = PlayerHelper.EffectiveRotation(g, p);
            if (got != want) fails.Add($"EffectiveRotation({what}) = {got}, want {want}");
        }
        Eff(own, (5, false, 0, false, 12), "override"); Eff(follows, (30, true, 600, true, 90), "follows the globals");
        Eff(null, (30, true, 600, true, 90), "no playlist state");
        // the defaults ("0 = off unless set"): a video plays to its end however long — no minimum, no
        // maximum —, a scene / still image (they never end) switches after its own 30 min; globally and per playlist
        var d = new AppSettings(); var dp = new PlaylistSettings();
        var dG = (d.GlobalIntervalSeconds, d.GlobalSwitchWhenVideoEnds, d.GlobalMaxPlaySeconds, d.GlobalSeparateSceneTiming, d.GlobalSwitchScenesAfterSeconds);
        var dP = (dp.IntervalSeconds, dp.SwitchWhenVideoEnds, dp.MaxPlaySeconds, dp.SeparateSceneTiming, dp.SwitchScenesAfterSeconds);
        if (dG != (0, true, 0, true, 1800)) fails.Add($"default global rotation = {dG}, want (0, True, 0, True, 1800)");
        if (dP != (0, true, 0, true, 1800)) fails.Add($"default playlist rotation = {dP}, want (0, True, 0, True, 1800)");
        // a file written before the scene toggle loads with its defaults; an explicit value loads as written
        var pre = JsonSerializer.Deserialize<AppSettings>("""{"GlobalIntervalSeconds":0,"GlobalSwitchWhenVideoEnds":true,"GlobalMaxPlaySeconds":0}""")!;
        if ((pre.GlobalSeparateSceneTiming, pre.GlobalSwitchScenesAfterSeconds) != (true, 1800))
            fails.Add($"a settings.json without the scene keys loads them as {(pre.GlobalSeparateSceneTiming, pre.GlobalSwitchScenesAfterSeconds)}, want (True, 1800)");
        var exp = JsonSerializer.Deserialize<PlaylistSettings>("""{"SeparateSceneTiming":false,"SwitchScenesAfterSeconds":45}""")!;
        if ((exp.SeparateSceneTiming, exp.SwitchScenesAfterSeconds) != (false, 45))
            fails.Add($"a playlist's own scene timing loads as {(exp.SeparateSceneTiming, exp.SwitchScenesAfterSeconds)}, want (False, 45)");
        // the removed wait toggle / separate minimum: gone from the models (an old file's keys load as unknown ones)
        foreach (var t in new[] { typeof(AppSettings), typeof(PlaylistSettings), typeof(LastSession) })
            foreach (var name in new[] { "GlobalWaitForVideoEnd", "PlaylistWaitForVideoEnd", "WaitForVideoEnd", "GlobalMinPlaySeconds", "MinPlaySeconds" })
                if (t.GetProperty(name) != null) fails.Add($"{t.Name}.{name} still exists (the rotation redesign removed it)");
        var old = JsonSerializer.Deserialize<AppSettings>("""{"GlobalIntervalSeconds":20,"GlobalSwitchWhenVideoEnds":true,"GlobalWaitForVideoEnd":true,"GlobalMinPlaySeconds":9,"GlobalMaxPlaySeconds":0}""")!;
        if ((old.GlobalIntervalSeconds, old.GlobalSwitchWhenVideoEnds, old.GlobalMaxPlaySeconds) != (20, true, 0))
            fails.Add($"an old-model settings.json loads as {(old.GlobalIntervalSeconds, old.GlobalSwitchWhenVideoEnds, old.GlobalMaxPlaySeconds)}, want (20, True, 0) — its removed keys ignored");
        // the maximum is clamped 0…359999 (negative = off); "switch scenes after" 1…359999 (never 0)
        foreach (var (v, want, wantAfter) in new[] { (-5, 0, 1), (0, 0, 1), (1, 1, 1), (90, 90, 90), (359999, 359999, 359999), (400000, 359999, 359999) })
        {
            var s = new AppSettings { GlobalMaxPlaySeconds = v }; var p = new PlaylistSettings { MaxPlaySeconds = v };
            if (s.GlobalMaxPlaySeconds != want || p.MaxPlaySeconds != want) fails.Add($"max play time {v} → {s.GlobalMaxPlaySeconds}/{p.MaxPlaySeconds}, want {want}");
            var s2 = new AppSettings { GlobalSwitchScenesAfterSeconds = v }; var p2 = new PlaylistSettings { SwitchScenesAfterSeconds = v };
            if (s2.GlobalSwitchScenesAfterSeconds != wantAfter || p2.SwitchScenesAfterSeconds != wantAfter)
                fails.Add($"switch scenes after {v} → {s2.GlobalSwitchScenesAfterSeconds}/{p2.SwitchScenesAfterSeconds}, want {wantAfter}");
        }
        // the maximum is 0 (off) or at least the minimum under advance-on-end (it follows the minimum up); with
        // advance-on-end off the interval is a timer and the maximum is left alone
        foreach (var (adv, min, max, want) in new[] { (true, 60, 30, 60), (true, 60, 0, 0), (true, 60, 90, 90), (true, 60, 60, 60),
                                                      (true, 0, 5, 5), (false, 600, 40, 40), (true, 400000, 5, 359999) })
            if (AppSettings.RotationMax(adv, min, max) != want) fails.Add($"RotationMax(advance {adv}, min {min}, max {max}) = {AppSettings.RotationMax(adv, min, max)}, want {want}");
        var under = new PlaylistSettings { OverrideGlobalSettings = true, SwitchWhenVideoEnds = true, IntervalSeconds = 50, MaxPlaySeconds = 20 };
        if (PlayerHelper.EffectiveRotation(g, under).Max != 50) fails.Add($"EffectiveRotation of a playlist's own maximum 20 under its minimum 50 = {PlayerHelper.EffectiveRotation(g, under).Max}, want 50");
        var gUnder = new AppSettings { GlobalSwitchWhenVideoEnds = true, GlobalIntervalSeconds = 40, GlobalMaxPlaySeconds = 10 };
        if (PlayerHelper.EffectiveRotation(gUnder, null).Max != 40) fails.Add($"EffectiveRotation of a global maximum 10 under the minimum 40 = {PlayerHelper.EffectiveRotation(gUnder, null).Max}, want 40");
        under.NormalizeRotation(); gUnder.NormalizeRotation();
        if ((under.MaxPlaySeconds, gUnder.GlobalMaxPlaySeconds) != (50, 40)) fails.Add($"NormalizeRotation left the maximums {(under.MaxPlaySeconds, gUnder.GlobalMaxPlaySeconds)}, want (50, 40)");
        // the kind a source is created with (`kind: image` | scene | video), which picks the item's rule in the player
        foreach (var (path, image, scene) in new[] { ("/x/a.mp4", false, false), ("/x/a.PNG", true, false), ("/x/b.webp", true, false),
                                                     ("/lib/workshop/900000001", false, true),
                                                     // an import keeps its source's extension (Helpers/ImportService.cs): a gif plays
                                                     // as a video (mpv loops it), so do the other containers
                                                     ("/lib/imported/g/g.gif", false, false), ("/lib/imported/w/w.webm", false, false),
                                                     ("/lib/imported/m/m.mkv", false, false) })
            if ((LiascapePlayerMedia.IsImagePath(path), PlayerHelper.IsScenePath(path)) != (image, scene))
                fails.Add($"{path}: image {LiascapePlayerMedia.IsImagePath(path)}, scene {PlayerHelper.IsScenePath(path)}, want image {image}, scene {scene}");
    }

    // ---- /health/features (FeatureHealth.Build): every missing piece → its feature not ok, with a reason ----------
    private static void FeatureHealthAssertions(List<string> fails)
    {
        using var good = JsonDocument.Parse("""{"effects":{"ok":true,"reason":null},"vram":{"ok":true,"reason":null},"hwdec_interop":{"ok":true,"reason":null},"cover":{"ok":true,"reason":null,"source":"hyprland"},"scenes":{"ok":true,"reason":null},"automute":{"ok":true,"reason":null},"bus":{"ok":true,"reason":null,"state":"up"}}""");
        using var bad = JsonDocument.Parse("""{"effects":{"ok":false,"reason":"no catalogue"},"vram":{"ok":false,"reason":"no VRAM measurement here"},"hwdec_interop":{"ok":null,"reason":null},"cover":{"ok":false,"reason":"no window-state source here (no compositor IPC) — \"Pause behind windows\" can't act","source":"unavailable"},"automute":{"ok":false,"reason":"the player's audio bus is down"},"bus":{"ok":false,"reason":"the player's audio bus is down (no session manager) — sources play on mpv's default device instead","state":"down"}}""");
        FeatureHealth.Feature F(List<FeatureHealth.Feature> l, string id) => l.FirstOrDefault(x => x.id == id) ?? new(id, id, null, "MISSING FEATURE", []);
        var all = FeatureHealth.Build(new(null, good.RootElement, (true, null), _ => true));
        foreach (var x in all) if (x.ok != true) fails.Add($"health (everything present): {x.id} ok={x.ok} ({x.reason})");
        var none = FeatureHealth.Build(new(null, bad.RootElement, (false, "liascape-scene-worker not found"), t => t is not ("pactl" or "playerctl" or "ffprobe")));
        void Want(string id, bool? ok, string? inReason, string affects)
        {
            var x = F(none, id);
            if (x.ok != ok) fails.Add($"health: {id} ok={x.ok}, want {ok}");
            if (inReason != null && !(x.reason ?? "").Contains(inReason)) fails.Add($"health: {id} reason \"{x.reason}\" lacks \"{inReason}\"");
            if (!x.affects.Contains(affects)) fails.Add($"health: {id} affects [{string.Join(",", x.affects)}], want {affects}");
        }
        Want("scenes", false, "liascape-scene-worker", "allowScenes");
        Want("transitions", false, "no catalogue", "globalTransitionEnabled");
        Want("vram", false, "VRAM", "limitVramPerScene");
        Want("hwdec-interop", null, null, "hwDec");
        Want("cover", false, "Pause behind windows", "pauseWhenCovered");
        // the audio bus: down → a warning with the reason (affects no setting row: the summary only); unknown with no answer
        if (F(none, "audio-bus").ok != false || !(F(none, "audio-bus").reason ?? "").Contains("default device") || F(none, "audio-bus").affects.Length != 0)
            fails.Add($"health: audio-bus with the bus down: ok={F(none, "audio-bus").ok} ({F(none, "audio-bus").reason}), affects [{string.Join(",", F(none, "audio-bus").affects)}]");
        Want("auto-mute", false, "pactl", "autoMute");
        Want("mpris", false, "playerctl", "autoMuteOnlyIfMprisActive");
        Want("ffmpeg", false, "ffprobe", "normalizeAudio");
        if ((F(none, "auto-mute").reason ?? "").Contains("parec")) fails.Add("health: auto-mute names parec, which is present");
        if (!(F(none, "auto-mute").reason ?? "").Contains("only while the app is open")) fails.Add($"health: a player without automute doesn't say the app-closed limit: {F(none, "auto-mute").reason}");
        // the Signal: pactl / parec / playerctl all missing don't matter; MPRIS needs a session bus; no player ran → unknown
        var sig = FeatureHealth.Build(new(null, good.RootElement, (true, null), t => t is not ("pactl" or "parec" or "playerctl"), SessionBus: false));
        if (F(sig, "auto-mute").ok != true) fails.Add($"health: the Signal without pactl/parec: auto-mute ok={F(sig, "auto-mute").ok} ({F(sig, "auto-mute").reason})");
        if (F(sig, "mpris").ok != false || !(F(sig, "mpris").reason ?? "").Contains("session bus")) fails.Add($"health: the Signal without a session bus: mpris ok={F(sig, "mpris").ok} ({F(sig, "mpris").reason})");
        var sigBus = FeatureHealth.Build(new(null, good.RootElement, (true, null), t => t is not "playerctl"));
        if (F(sigBus, "mpris").ok != true) fails.Add($"health: the Signal with a session bus, no playerctl: mpris ok={F(sigBus, "mpris").ok} ({F(sigBus, "mpris").reason})");
        using var gateOn = JsonDocument.Parse("""{"automute":{"ok":null,"reason":null}}""");
        var unk = FeatureHealth.Build(new(null, gateOn.RootElement, (true, null), _ => false));
        if (F(unk, "audio-bus").ok != null || F(unk, "audio-bus").reason != null) fails.Add($"health: no bus answer: audio-bus ok={F(unk, "audio-bus").ok} ({F(unk, "audio-bus").reason}), want unknown without a reason");
        if (F(unk, "auto-mute").ok != null || F(unk, "mpris").ok != null) fails.Add($"health: no player ran (the gate on): auto-mute ok={F(unk, "auto-mute").ok}, mpris ok={F(unk, "mpris").ok}, want unknown");
        // no player binary: AudioMonitor's tools decide auto-mute (pactl + parec, playerctl for MPRIS)
        var noTools = FeatureHealth.Build(new("liascape-player not found", null, (false, "liascape-player not found"), t => t is not ("parec" or "playerctl")));
        if (F(noTools, "auto-mute").ok != false || !(F(noTools, "auto-mute").reason ?? "").Contains("parec") || F(noTools, "mpris").ok != false)
            fails.Add($"health: no player, no parec/playerctl: auto-mute ok={F(noTools, "auto-mute").ok} ({F(noTools, "auto-mute").reason}), mpris ok={F(noTools, "mpris").ok}");
        var noBin = FeatureHealth.Build(new("liascape-player not found", null, (false, "liascape-player not found"), _ => true));
        if (F(noBin, "liascape-player").ok != false || noBin.Any(x => x.id == "vram" || x.id == "audio-bus")) fails.Add("health: a missing liascape-player → its feature false, no player-side features");
        // the only engine: no setting picks it, so its row marks none (the summary only), and it is always in use
        if (F(noBin, "liascape-player").affects.Length != 0) fails.Add($"health: liascape-player affects [{string.Join(",", F(noBin, "liascape-player").affects)}], want none");
        var d = new AppSettings();
        foreach (var (id, want) in new[] { ("auto-mute", false), ("mpris", false), ("scenes", false), ("ffmpeg", true), ("vram", true), ("hwdec-interop", true), ("cover", true), ("audio-bus", true), ("liascape-player", true) })
            if (FeatureHealth.InUse(id, d) != want) fails.Add($"health: InUse({id}) with the defaults = {!want}, want {want}");
    }

    // ---- the scene-renderer latch: the running player's word wins over a scene-check that started before it -------
    private static void RendererLatchAssertions(List<string> fails)
    {
        const string Missing = "The scene renderer is missing — rebuild or reinstall Liascape";
        var c = new LiascapePlayerClient("/nonexistent/liascape-selftest.sock") { AutoSpawn = false };
        long mark = c.PlayerWordMark();
        if (!c.ApplyNoPlayerWord(Missing, mark) || c.RendererMissing != Missing)
            fails.Add($"latch: with no player, scene-check's word should latch; got {c.RendererMissing ?? "null"}");
        // a scene-check starts with no player; a player comes up meanwhile and its hello says the renderer loads; the check ends
        mark = c.PlayerWordMark();
        c.ApplyPlayerWord(null);
        if (c.ApplyNoPlayerWord(Missing, mark) || c.RendererMissing != null)
            fails.Add($"latch: a scene-check started before the player's hello overwrote its word ({c.RendererMissing ?? "null"})");
        c.ApplyPlayerWord(Missing);
        if (c.RendererMissing != Missing) fails.Add("latch: the player's word didn't latch");
    }

    // ---- what a player is started with (`liascape restore` = a session start; a restart never is) --------------------
    private static void StartArgsAssertions(List<string> fails)
    {
        static string J(IEnumerable<string>? a) => a == null ? "null" : string.Join(" ", a);
        void Want(string what, IEnumerable<string>? got, string want) { if (J(got) != want) fails.Add($"{what}: `{J(got)}`, want `{want}`"); }
        const string sock = "/run/user/1/x/liascape-player.sock";
        Want("first start", LiascapePlayerClient.StartArgs(null, sock, true, false, false), "serve");
        Want("first start, own socket", LiascapePlayerClient.StartArgs(null, sock, false, false, false), $"serve --socket {sock}");
        Want("restore (boot)", LiascapePlayerClient.StartArgs(null, sock, true, true, true), "serve --restore --session-start");
        Want("restore, own socket", LiascapePlayerClient.StartArgs(null, sock, false, true, true), $"serve --socket {sock} --restore --session-start");
        Want("restore, no session start", LiascapePlayerClient.StartArgs(null, sock, true, true, false), "serve --restore");
        // a player that went away comes back with its own arguments + --restore, never as a session start
        var known = new List<string> { "serve", "--headless", "--ao", "null" };
        Want("known args", LiascapePlayerClient.StartArgs(known, sock, true, false, false), "serve --headless --ao null --restore");
        Want("known args × restore", LiascapePlayerClient.StartArgs(known, sock, true, true, true), "serve --headless --ao null --restore");
        // the restart plumbing (and a boot's --session-start) never survives into an upgrade's / a restart's arguments
        Want("supervisor argv", LiascapePlayerClient.UserServeArgs(["serve", "--headless", "--restore", "--session-start"]), "serve --headless");
        Want("child argv", LiascapePlayerClient.UserServeArgs(["serve", "--supervised", "--restarted", "3:1", "--ao", "null", "--session-start"]), "serve --ao null");
        Want("not serve", LiascapePlayerClient.UserServeArgs(["ctl", "state"]), "null");
    }

    // ---- transition duration floor (0 = a cut; 1–49 ms allowed — the floor was 50) ----------------
    private static void TransitionDurationAssertions(List<string> fails)
    {
        static TransitionService.Config C(int min, int max) => new(true, ["fade"], min, max, false);
        foreach (var (min, max, want) in new[] { (0, 0, 0), (1, 0, 1), (20, 0, 20), (49, 0, 49), (-5, 0, 0), (600, 0, 600), (99999, 0, 10000) })
            if (TransitionService.PickDuration(C(min, max)) is var got && got != want) fails.Add($"PickDuration({min}, max {max}) = {got}, want {want}");
        for (int i = 0; i < 20; i++)
            if (TransitionService.PickDuration(C(30, 40)) is var r && (r < 30 || r > 40)) fails.Add($"PickDuration(30..40) = {r}");
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

    // ---- auto-mute excludes liascape-player's OWN streams (by ownership, not just by name) ------------
    private static void OwnershipAssertions(List<string> fails)
    {
        static string Block(string app, string pid, string node, string sink) =>
            $"7\n\tDriver: PipeWire\n\tSink: {sink}\n\tProperties:\n\t\tapplication.name = \"{app}\"\n" +
            $"\t\tapplication.process.id = \"{pid}\"\n\t\tnode.name = \"{node}\"\n";
        void Own(string label, string block, bool want)
        {
            bool got = LiascapePlayerMedia.IsOwnStream(block, playerPid: 4242, busSinkIndex: "57");
            if (got != want) fails.Add($"ownership {label}: got {got}, want {want}");
        }
        Own("by pid", Block("mpv", "4242", "mpv", "12"), true);
        Own("bus playback node", Block("x", "1", "liascape-player-bus.playback", "12"), true);
        Own("targets the bus sink", Block("x", "1", "y", "57"), true);
        Own("application.name liascape-player", Block("liascape-player", "1", "y", "12"), true);
        // a scene worker's own stream (its own process, its own app name here) — by node name
        Own("scene worker stream", Block("x", "1", "liascape-player-scene.src4", "12"), true);
        Own("another app", Block("Firefox", "1", "Firefox", "12"), false);
        // AudioMonitor counts every stream that isn't ours: a user's own mpv is foreign like any other app, ours by
        // ownership only. Guard for AudioMonitor.ParseStreams
        var listing = "Sink Input #" + Block("mpv", "77", "mpv", "12") + "Sink Input #" + Block("mpv", "4242", "mpv", "12").Replace("7\n", "8\n");
        var (listed, foreignIds) = AudioMonitor.ParseStreams(listing, b => LiascapePlayerMedia.IsOwnStream(b, playerPid: 4242, busSinkIndex: "57"));
        if (string.Join(",", listed.Order()) != "7,8" || string.Join(",", foreignIds) != "7")
            fails.Add($"ParseStreams: listed [{string.Join(",", listed.Order())}], foreign [{string.Join(",", foreignIds)}], want listed [7,8], foreign [7] (a user's mpv counts, the player's own doesn't)");
    }

    // ---- scenes under liascape-player (pure decisions + a scene's create props) ---------------------
    private static void SceneAdapterAssertions(List<string> fails)
    {
        // AppSettings → the player's GPU / VRAM props (the limit is 0 = off while its toggle is off)
        string G(AppSettings s) => string.Join(" ", LiascapePlayerMedia.GpuProps(s).Select(p => $"{p.prop}={p.value}"));
        foreach (var (s, want) in new (AppSettings, string)[] {
            (new AppSettings(), "scene_throttle=True scene_vram_limit_mib=0 scene_vram_stop_shows=last_frame vram_low_mode=stop scene_spare=False"),
            (new AppSettings { AutoThrottleScenes = false, LimitVramPerScene = true, SceneVramLimitMib = 1536, SceneVramStopShows = "nothing", VramLowMode = "pause" }, "scene_throttle=False scene_vram_limit_mib=1536 scene_vram_stop_shows=nothing vram_low_mode=pause scene_spare=False"),
            (new AppSettings { SceneVramLimitMib = 2048, SceneVramStopShows = "bogus", VramLowMode = "bogus" }, "scene_throttle=True scene_vram_limit_mib=0 scene_vram_stop_shows=last_frame vram_low_mode=stop scene_spare=False"),
            (new AppSettings { LimitVramPerScene = true, SceneVramLimitMib = 1, SceneVramStopShows = "NOTHING", VramLowMode = "off" }, "scene_throttle=True scene_vram_limit_mib=64 scene_vram_stop_shows=nothing vram_low_mode=off scene_spare=False"),
            (new AppSettings { AllowScenes = true }, "scene_throttle=True scene_vram_limit_mib=0 scene_vram_stop_shows=last_frame vram_low_mode=stop scene_spare=True"),
            (new AppSettings { AllowScenes = true, SceneSpareWorker = false }, "scene_throttle=True scene_vram_limit_mib=0 scene_vram_stop_shows=last_frame vram_low_mode=stop scene_spare=False") })
            if (G(s) != want) fails.Add($"GpuProps → {G(s)}, want {want}");
        // ScenesPlayable: AllowScenes × the player's `scene` capability (asked only with scene support on)
        foreach (var allow in new[] { false, true })
        foreach (var cap in new[] { false, true })
        {
            bool asked = false;
            bool got = PlayerStatus.ScenesPlayableFor(allow, () => { asked = true; return cap; });
            if (got != (allow && cap) || asked != allow)
                fails.Add($"ScenesPlayable(AllowScenes={allow}, scene capability={cap}) = {got} (capability asked: {asked}), want {allow && cap} (asked: {allow})");
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
            var props = LiascapePlayerMedia.SourceProps(dir, new AppSettings { NormalizeAudio = true, Volume = 50 });
            string P(string k) => props.TryGetValue(k, out var v) ? v?.ToString() ?? "null" : "<absent>";
            if (P("kind") != "scene") fails.Add($"SourceProps(scene folder).kind = {P("kind")}, want scene");
            if (P("preview") != Path.Combine(dir, "preview.png")) fails.Add($"SourceProps(scene folder).preview = {P("preview")}, want its preview.png");
            if (P("af") != "") fails.Add($"SourceProps(scene folder).af = {P("af")}, want \"\" (no loudnorm on a scene)");
            if (props.TryGetValue("gain.user", out var gu) && Math.Abs(Convert.ToDouble(gu) - MpvPropertyMap.VolumeDb(50)) > 1e-3)
                fails.Add($"SourceProps(scene folder).gain.user = {gu}, want {MpvPropertyMap.VolumeDb(50):0.###} (Volume 50)");
            var vid = LiascapePlayerMedia.SourceProps(Path.Combine(dir, "x.mp4"), new AppSettings());
            if (vid["kind"] as string != "video" || vid.ContainsKey("preview")) fails.Add($"SourceProps(.mp4) = kind {vid["kind"]}, preview {(vid.ContainsKey("preview") ? "set" : "absent")}; want video, absent");
            // scene loudness: an unlearned scene opens at gain.normalize 0; a video never carries the slot (its af does it)
            if (P("gain.normalize") is var gn && (gn == "<absent>" || Math.Abs(Convert.ToDouble(props["gain.normalize"])) > 1e-9))
                fails.Add($"SourceProps(unlearned scene).gain.normalize = {gn}, want 0");
            if (vid.ContainsKey("gain.normalize")) fails.Add("SourceProps(.mp4) carries gain.normalize — a video normalizes through af");
            // an imported gif / webm / mkv keeps its own name (Helpers/ImportService.cs) and the player opens each as a video
            foreach (var f in new[] { "x.gif", "x.webm", "x.mkv" })
                if (LiascapePlayerMedia.SourceProps(Path.Combine(dir, f), new AppSettings())["kind"] as string is var k && k != "video")
                    fails.Add($"SourceProps({f}) = kind {k}; want video");
        }
        finally { try { Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(dir))!, true); } catch { } }
        PresetSourceAssertions(fails);
        SceneLoudnessAssertions(fails);
        FontStandInAssertions(fails);
    }

    // A preset plays as its own scene source: its identity (`path`, its own preview) is its folder, the folder the worker
    // loads (`scene_dir`) its base's. The base lookup is the table's own (`loadDirOf`): the real one reads the library,
    // which the self-test never touches; the adapter IT § presets covers it end to end.
    private static void PresetSourceAssertions(List<string> fails)
    {
        var root = Path.Combine("/tmp", "lpst-preset-src-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            string baseDir = Path.Combine(root, "workshop", "900000001"), presetDir = Path.Combine(root, "workshop", "910000101");
            Directory.CreateDirectory(baseDir); Directory.CreateDirectory(presetDir);
            File.WriteAllText(Path.Combine(baseDir, "project.json"), "{\"type\":\"scene\",\"file\":\"scene.json\",\"preview\":\"preview.png\"}");
            File.WriteAllBytes(Path.Combine(baseDir, "preview.png"), [0x89, 0x50, 0x4e, 0x47]);
            File.WriteAllText(Path.Combine(presetDir, "project.json"),
                "{\"dependency\":\"900000001\",\"preset\":{\"color\":\"0 0 1\"},\"preview\":\"preview.jpg\",\"title\":\"P\"}");
            File.WriteAllBytes(Path.Combine(presetDir, "preview.jpg"), [0xff, 0xd8, 0xff]);
            var s = new AppSettings();
            var p = LiascapePlayerMedia.SourceProps(presetDir, s, d => d == presetDir ? baseDir : d);
            string P(Dictionary<string, object?> m, string k) => m.TryGetValue(k, out var v) ? v?.ToString() ?? "null" : "<absent>";
            if (P(p, "path") != presetDir) fails.Add($"SourceProps(preset).path = {P(p, "path")}, want the preset's own folder");
            if (P(p, "kind") != "scene") fails.Add($"SourceProps(preset).kind = {P(p, "kind")}, want scene");
            if (P(p, "preview") != Path.Combine(presetDir, "preview.jpg")) fails.Add($"SourceProps(preset).preview = {P(p, "preview")}, want its own preview.jpg (never its base's)");
            if (P(p, "scene_dir") != baseDir) fails.Add($"SourceProps(preset).scene_dir = {P(p, "scene_dir")}, want its base's folder {baseDir}");
            var plain = LiascapePlayerMedia.SourceProps(baseDir, s, d => d);
            if (plain.ContainsKey("scene_dir")) fails.Add($"SourceProps(a plain scene) carries scene_dir {P(plain, "scene_dir")}: it loads its own folder");
            var gone = LiascapePlayerMedia.SourceProps(presetDir, s, _ => null);
            if (gone.ContainsKey("scene_dir")) fails.Add($"SourceProps(a preset whose base is gone) carries scene_dir {P(gone, "scene_dir")}");
        }
        catch (Exception e) { fails.Add($"preset source assertions threw {e.GetType().Name}: {e.Message}"); }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    // Scene loudness learned on first play (`scene.loudness` → LibMeta → `gain.normalize`): what's stored when, and
    // the gain the resolver gives a scene.
    // `scene.fonts` → the index entry (LiascapePlayerMedia.FontStandInsOf, LibraryService.MergeFontStandIns): parsed, stored
    // once, unchanged on a repeat, cleared by an empty report; a malformed event stores nothing
    private static void FontStandInAssertions(List<string> fails)
    {
        JsonElement Ev(string json) => JsonDocument.Parse(json).RootElement.Clone();
        var one = LiascapePlayerMedia.FontStandInsOf(Ev("{\"path\":\"/x\",\"stand_ins\":[{\"font\":\"Consolas\",\"shown\":\"Cascadia Mono\"},{\"font\":\"\",\"shown\":\"y\"}]}"));
        if (one is not [{ Font: "Consolas", Shown: "Cascadia Mono" }]) fails.Add($"FontStandInsOf → {JsonSerializer.Serialize(one)}, want one Consolas → Cascadia Mono (a nameless entry dropped)");
        if (LiascapePlayerMedia.FontStandInsOf(Ev("{\"path\":\"/x\"}")) != null) fails.Add("FontStandInsOf(no stand_ins) isn't null");
        var m = new LibMeta();
        if (!LibraryService.MergeFontStandIns(m, one ?? [])) fails.Add("MergeFontStandIns: the first report didn't change the entry");
        if (LibraryService.MergeFontStandIns(m, [new FontStandIn { Font = "Consolas", Shown = "Cascadia Mono" }])) fails.Add("MergeFontStandIns: the same report again changed the entry");
        if (!LibraryService.MergeFontStandIns(m, []) || m.FontStandIns != null) fails.Add($"MergeFontStandIns: an empty report didn't clear ({JsonSerializer.Serialize(m.FontStandIns)})");
        if (LibraryService.MergeFontStandIns(new LibMeta(), [])) fails.Add("MergeFontStandIns: an empty report on an empty entry changed it");
    }

    private static void SceneLoudnessAssertions(List<string> fails)
    {
        // MergeSceneLoudness (refined across plays, per audio configuration): the report covering
        // MORE audible seconds replaces its configuration's live measurement (state, seconds, partial); the applied I/TP
        // move only by ≥ 0.5 LU/dB
        var m = new LibMeta();
        JsonElement St(int n) => JsonSerializer.SerializeToElement(new { v = 1, first = 500, counts = new[] { n } });
        SceneLoudnessLive? Live(string fp = "") => LibraryService.SceneLoudnessEntryOf(m, fp)?.Live;
        void Merge(double lufs, double? peak, double secs, bool complete, (bool, bool) want, string what, JsonElement? state = null, string? key = null)
        {
            var got = LibraryService.MergeSceneLoudness(m, key, lufs, peak, secs, complete, state ?? St((int)(secs * 10)));
            if (got != want) fails.Add($"MergeSceneLoudness({what}) = {got}, want {want} (now I={m.LoudnessI}, TP={m.LoudnessTP}, live={JsonSerializer.Serialize(Live(key ?? m.SceneLoudnessFp ?? ""))})");
        }
        Merge(-30, -12, 25, false, (true, true), "first partial on an empty entry");
        if (m.LoudnessI != -30 || m.LoudnessTP != -12 || Live() is not { Partial: true, Seconds: 25 } l0 || m.LoudnessLRA != null
            || l0.State?.GetProperty("counts")[0].GetInt32() != 250)
            fails.Add($"a partial stored as I={m.LoudnessI} TP={m.LoudnessTP} live={JsonSerializer.Serialize(Live())} LRA={m.LoudnessLRA}");
        Merge(-31, -12, 22, false, (false, false), "a shorter report (two sources at once: the longer stays)");
        Merge(-28, -11, 40, false, (true, true), "a longer partial");
        Merge(-27, -10, 60, true, (true, true), "a complete one over a partial");
        if (m.LoudnessI != -27 || Live() is not { Partial: null, Seconds: 60 }) fails.Add($"complete stored as I={m.LoudnessI} live={JsonSerializer.Serialize(Live())}");
        Merge(-27.3, -9.8, 120, true, (true, false), "refined by 0.3 LU: stored, not applied");
        if (m.LoudnessI != -27 || m.LoudnessTP != -10 || Live() is not { Seconds: 120 } l1 || l1.State?.GetProperty("counts")[0].GetInt32() != 1200)
            fails.Add($"a sub-0.5 refinement: I={m.LoudnessI} TP={m.LoudnessTP} live={JsonSerializer.Serialize(Live())} (want I −27 TP −10 kept, s 120 + its state)");
        Merge(-27.6, -9.8, 180, true, (true, true), "refined to 0.6 LU from the applied value (drift accumulates)");
        if (m.LoudnessI != -27.6 || m.LoudnessTP != -10) fails.Add($"applied I={m.LoudnessI} TP={m.LoudnessTP}, want −27.6 / −10");
        Merge(-27.6, -9.0, 240, true, (true, true), "the peak rose ≥ 0.5 dB");
        if (m.LoudnessTP != -9.0) fails.Add($"TP {m.LoudnessTP}, want −9");
        Merge(-20, -5, 240, true, (false, false), "the same seconds again (a duplicate report)");
        Merge(-20, -5, 200, false, (false, false), "a shorter partial after a complete one");
        Merge(double.NegativeInfinity, null, 60, true, (false, false), "-inf (silence)");
        if (LibraryService.MergeSceneLoudness(new LibMeta(), null, double.NaN, null, 60, true) != (false, false)) fails.Add("MergeSceneLoudness(NaN) stored");
        if (LibraryService.MergeSceneLoudness(new LibMeta(), null, -20, null, 0, true) != (false, false)) fails.Add("MergeSceneLoudness(0 s) stored");
        if (LibraryService.SceneLoudnessSeedOf(m)?.GetProperty("counts")[0].GetInt32() != 2400) fails.Add("the seed = the current configuration's live state");
        // a video's ffmpeg measurement (all four fields) is never read as a scene's — and vice versa
        var sceneOnly = new LibMeta { LoudnessI = -20, LoudnessTP = -10 };
        if (sceneOnly.LoudnessLRA != null) fails.Add("a scene measurement must not look like a video's (LRA set)");

        // Per audio configuration (MergeSceneEstimate; docs/TODO.md "Offline scene loudness → integration"): the first
        // estimate hands an un-keyed measurement to its fingerprint; a new configuration jumps to its own value (its
        // estimate, never-played) and seeds from the estimate; its first live report takes over (0.5 LU rule vs the
        // estimate); toggled back, the first configuration's measurement applies again; an estimate never displaces a
        // live measurement; a report of a configuration that isn't current is stored and applies nothing.
        JsonElement Seed(int n) => JsonSerializer.SerializeToElement(new { v = 1, first = 600, counts = new[] { n } });
        SceneLoudnessEstimate Est(double? lufs, double? peak = null, int seed = 100) => new() { Lufs = lufs, PeakDbfs = peak, Seed = Seed(seed), Confidence = "high", Model = "lwe" };
        void MergeEst(string fp, SceneLoudnessEstimate e, (bool, bool) want, string what)
        {
            var got = LibraryService.MergeSceneEstimate(m, fp, e);
            if (got != want) fails.Add($"MergeSceneEstimate({what}) = {got}, want {want} (now fp={m.SceneLoudnessFp} I={m.LoudnessI} TP={m.LoudnessTP})");
        }
        MergeEst("A", Est(-25, -8), (true, false), "the first estimate of a measured scene: the un-keyed measurement is A's, it stays applied");
        if (m.SceneLoudnessFp != "A" || Live("A") is not { Seconds: 240 } || m.SceneLoudness!.ContainsKey("") || m.LoudnessI != -27.6)
            fails.Add($"un-keyed → A: fp={m.SceneLoudnessFp} A.live={JsonSerializer.Serialize(Live("A"))} keys={string.Join(",", m.SceneLoudness!.Keys)} I={m.LoudnessI}");
        if (LibraryService.SceneLoudnessInfoOf(m) is not { Estimated: false, Seconds: 240 }) fails.Add($"A's info: {LibraryService.SceneLoudnessInfoOf(m)}");
        MergeEst("B", Est(-18, -4), (true, true), "props changed → B (never played): jumps to B's estimate");
        if (m.LoudnessI != -18 || m.LoudnessTP != -4 || LibraryService.SceneLoudnessSeedOf(m)?.GetProperty("counts")[0].GetInt32() != 100
            || LibraryService.SceneLoudnessInfoOf(m) is not { Estimated: true, Seconds: null })
            fails.Add($"on B: I={m.LoudnessI} TP={m.LoudnessTP} seed={LibraryService.SceneLoudnessSeedOf(m)} info={LibraryService.SceneLoudnessInfoOf(m)}");
        Merge(-27.4, -9, 260, true, (true, false), "A's end report after the switch to B: stored under A, nothing applied", key: "A");
        if (Live("A")?.Seconds != 260 || m.LoudnessI != -18) fails.Add($"A's late report: A.live={JsonSerializer.Serialize(Live("A"))} I={m.LoudnessI}");
        Merge(-18.3, -4.2, 20, true, (true, false), "B's first live report, 0.3 LU from its estimate: live now, not applied", key: "B");
        if (LibraryService.SceneLoudnessInfoOf(m).Estimated != false || m.LoudnessI != -18) fails.Add($"B live: {LibraryService.SceneLoudnessInfoOf(m)} I={m.LoudnessI}");
        MergeEst("B", Est(-12, -1), (true, false), "a re-estimate of B never displaces B's live measurement");
        if (m.LoudnessI != -18 || LibraryService.SceneLoudnessSeedOf(m)?.GetProperty("counts")[0].GetInt32() != 200) fails.Add($"B re-estimated: I={m.LoudnessI} seed={LibraryService.SceneLoudnessSeedOf(m)}");
        MergeEst("A", Est(-25, -8), (true, true), "toggled back → A: its own measurement again");
        if (m.LoudnessI != -27.4 || m.LoudnessTP != -9 || LibraryService.SceneLoudnessSeedOf(m)?.GetProperty("counts")[0].GetInt32() != 2600)
            fails.Add($"back on A: I={m.LoudnessI} TP={m.LoudnessTP} seed={LibraryService.SceneLoudnessSeedOf(m)}");
        MergeEst("S", Est(null), (true, true), "a configuration with no sound: nothing applied");
        if (m.LoudnessI != null || m.LoudnessTP != null || LiascapePlayerMedia.SceneNormalizeDb(m, new AppSettings { NormalizeAudio = true }) != 0)
            fails.Add($"silent configuration: I={m.LoudnessI} TP={m.LoudnessTP}");
        m = new LibMeta();
        MergeEst("C", Est(-20, -6), (true, true), "a fresh scene's estimate is applied at once");
        if (m.LoudnessI != -20 || LibraryService.SceneLoudnessInfoOf(m) is not { Estimated: true, Lufs: -20 }) fails.Add($"fresh estimate: I={m.LoudnessI}");
        Merge(-23, -6, 60, true, (true, true), "its first live report (key-less: the current configuration's) moves ≥ 0.5 LU");
        if (Live("C")?.Seconds != 60 || m.LoudnessI != -23) fails.Add($"C live: {JsonSerializer.Serialize(Live("C"))} I={m.LoudnessI}");
        if (LibraryService.MergeSceneEstimate(m, "", Est(-1)) != (false, false)) fails.Add("an empty fingerprint stored");
        m = new LibMeta { SceneLoudness = new() { ["L"] = new SceneLoudnessEntry { Estimate = Est(-15, -3), } }, SceneLoudnessFp = "L" };
        m.SceneLoudness["L"].Estimate!.Confidence = "low";
        m.SceneLoudness["L"].Estimate!.Notes = ["two versions of one song play at once"];
        if (LibraryService.SceneLoudnessInfoOf(m).Note != "two versions of one song play at once") fails.Add("a low estimate's first note is the card's note");

        // Set once per play (docs/decisions.md § "Set scene normalization once per play"): WindowReached = the report that
        // completes the CURRENT configuration's first
        // window (before: no live measurement or a partial) — the one moment a live source's gain.normalize moves; every
        // later report only changes the next play's value
        m = new LibMeta();
        MergeEst("W", Est(-20, -10), (true, true), "W's estimate");
        void Reached(string? key, double lufs, double secs, bool complete, bool want, string what)
        {
            var got = LibraryService.MergeSceneLoudnessReport(m, key, lufs, -10, secs, complete, St((int)(secs * 10)));
            if (got.WindowReached != want) fails.Add($"WindowReached({what}) = {got.WindowReached}, want {want} ({got})");
        }
        Reached(null, -24, 30, false, false, "a partial (switched away early)");
        Reached(null, -24, 60, true, true, "the window completed over a partial");
        Reached(null, -26, 120, true, false, "a further window: refines the next play's value only");
        Reached(null, -26, 130, true, false, "the end of the play");
        MergeEst("X", Est(-18, -8), (true, true), "another configuration (a property commit)");
        Reached("W", -27, 190, true, false, "W's late report after the switch to X (not current)");
        Reached("X", -19, 60, true, true, "X's own window: X's play sets its normalization once");
        m = new LibMeta();
        Reached(null, -22, 60, true, true, "a scene never estimated: its first window");

        // PinNormalize: a live source keeps the gain.normalize it plays with; only a landing / a property commit's new
        // configuration (repin) or the user's normalization settings move it to the index's value
        var s14 = new AppSettings { NormalizeAudio = true, NormalizeTargetLufs = -14 };
        var p0 = LiascapePlayerMedia.PinNormalize(null, "/s", 3.0, 5.0, s14, repin: false);
        if (p0.Db != 3.0) fails.Add($"first sight pins what the source runs: {p0.Db}, want 3");
        if (LiascapePlayerMedia.PinNormalize(null, "/s", null, 5.0, s14, repin: false).Db != 5.0) fails.Add("first sight without a running value: the index's");
        if (LiascapePlayerMedia.PinNormalize(p0, "/s", 3.0, 7.5, s14, repin: false) is not { Db: 3.0 } kept || !ReferenceEquals(kept, p0))
            fails.Add("the index moved (a refinement): the play keeps its value");
        if (LiascapePlayerMedia.PinNormalize(p0, "/s", 3.0, 7.5, s14, repin: true).Db != 7.5) fails.Add("a window landing re-pins to the index");
        if (LiascapePlayerMedia.PinNormalize(p0, "/s", 3.0, -2.0, new AppSettings { NormalizeAudio = true, NormalizeTargetLufs = -23 }, repin: false).Db != -2.0)
            fails.Add("a target change re-pins to the index");
        if (LiascapePlayerMedia.PinNormalize(p0, "/s", 3.0, 0.0, new AppSettings { NormalizeAudio = false, NormalizeTargetLufs = -14 }, repin: false).Db != 0.0)
            fails.Add("normalization off re-pins (0)");
        if (LiascapePlayerMedia.PinNormalize(p0, "/other", 1.0, 9.0, s14, repin: false).Db != 1.0) fails.Add("a reused source id on another path: what it runs");

        // SceneNormalizeDb: target − I, never boosting the sample peak past −1.5 dBFS, clamped −60…+24; 0 when off / unlearned
        var on = new AppSettings { NormalizeAudio = true, NormalizeTargetLufs = -14 };
        (LibMeta? meta, AppSettings s, double want, string what)[] rows =
        [
            (new LibMeta { LoudnessI = -20, LoudnessTP = -20 }, on, 6.0, "−20 LUFS, peak −20 → +6"),
            (new LibMeta { LoudnessI = -30, LoudnessTP = -6 }, on, 4.5, "boost capped by the peak: −1.5 − (−6)"),
            (new LibMeta { LoudnessI = -10, LoudnessTP = -1 }, on, -4.0, "a loud scene is turned down (no cap)"),
            (new LibMeta { LoudnessI = -30 }, on, 16.0, "no peak known → target − I"),
            (new LibMeta { LoudnessI = -120, LoudnessTP = -100 }, on, 24.0, "clamped at +24"),
            (new LibMeta { LoudnessI = 40, LoudnessTP = 0 }, on, -54.0, "turned down far"),
            (new LibMeta { LoudnessI = -20, LoudnessTP = -20 }, new AppSettings { NormalizeAudio = false, NormalizeTargetLufs = -14 }, 0.0, "normalization off"),
            (new LibMeta(), on, 0.0, "not learned yet"),
            (null, on, 0.0, "no index entry"),
            (new LibMeta { LoudnessI = -20, LoudnessTP = -20 }, new AppSettings { NormalizeAudio = true, NormalizeTargetLufs = -23, NoAudio = true }, -3.0, "NoAudio keeps it (silent anyway)"),
        ];
        foreach (var (meta, s, want, what) in rows)
        {
            double got = LiascapePlayerMedia.SceneNormalizeDb(meta, s);
            if (Math.Abs(got - want) > 1e-6) fails.Add($"SceneNormalizeDb({what}) = {got}, want {want}");
        }
    }

    // ---- scene user properties (SceneProperties): parsing, values, conditions, encodings ------
    // A project.json with the corpus's odd cases (96 SFW scenes surveyed: a BOM, untyped / "Text" HTML labels,
    // `ui_*` keys, combo values as numbers, slider fraction false, 0–255 colours, conditions with || ( ) ! and a
    // stray `=`, usershortcut / scenetexture, order vs index, a trailing comma); then — when the SFW Workshop
    // folder exists (read-only) — every real scene's properties: parse, defaults round-trip, conditions parse.
    private static void ScenePropertyAssertions(List<string> fails)
    {
        const string pj = "﻿{\"type\":\"Scene\",\"general\":{\"properties\":{"
            + "\"schemecolor\":{\"order\":0,\"text\":\"ui_browse_properties_scheme_color\",\"type\":\"color\",\"value\":\"0.5 0.25 1\"},"
            + "\"clock\":{\"order\":101,\"text\":\"<hr><h4>Show clock</h4><hr>\",\"type\":\"bool\",\"value\":true},"
            + "\"style\":{\"order\":102,\"text\":\"Style\",\"type\":\"combo\",\"value\":2,\"options\":[{\"label\":\"A\",\"value\":1},{\"label\":\"B\",\"value\":2},{\"label\":\"C &amp; D\",\"value\":\"x\"}],\"condition\":\"clock.value\"},"
            + "\"bars\":{\"order\":103,\"text\":\"Bar Count\",\"type\":\"slider\",\"value\":64,\"min\":16,\"max\":64,\"fraction\":false,\"condition\":\"clock.value && style.value == 2\"},"
            + "\"opacity\":{\"order\":104,\"text\":\"Opacity\",\"type\":\"slider\",\"value\":0.85,\"min\":0,\"max\":1,\"step\":0.01,\"precision\":3,\"fraction\":true,\"condition\":\"(clock.value || style.value == 'x') && !hidden.value\"},"
            + "\"name\":{\"index\":5,\"text\":\"Name\",\"type\":\"textinput\",\"value\":\"YOURNAME\"},"
            + "\"hdr\":{\"order\":99,\"text\":\"<a href='https://x'><img src='https://y'></a>\"},"
            + "\"lbl\":{\"order\":98,\"text\":\"<p>Info&nbsp;text</p>\",\"type\":\"Text\"},"
            + "\"grp\":{\"order\":97,\"text\":\"Clock\",\"type\":\"group\",\"value\":\"\"},"
            + "\"launch\":{\"order\":110,\"text\":\"‎ ‎ <small>#1</small>\",\"type\":\"usershortcut\",\"value\":\"\"},"
            + "\"tex\":{\"order\":111,\"text\":\"Custom\",\"type\":\"scenetexture\",\"value\":\"\"},"
            + "\"tint\":{\"order\":112,\"text\":\"Tint\",\"type\":\"color\",\"value\":\"255 0 0\",\"condition\":\"rain.value=true\"},"
            + "\"weird\":{\"order\":113,\"text\":\"W\",\"type\":\"hologram\",\"value\":1},"
            + "}}}";
        var props = SceneProperties.Parse(pj);
        SceneProp? P(string n) => props.FirstOrDefault(p => p.Name == n);
        string order = string.Join(",", props.Select(p => p.Name));
        const string wantOrder = "schemecolor,name,grp,lbl,clock,style,bars,opacity,launch,tex,tint,weird";
        if (order != wantOrder) fails.Add($"scene props order {order}, want {wantOrder} (`order`, else `index`; \"hdr\": an image-only label is dropped)");
        void Is(string n, string type, string label, bool editable, string? def)
        {
            if (P(n) is not { } p) { fails.Add($"scene prop {n}: missing"); return; }
            var d = p.Default?.ToJsonString();
            if (p.Type != type || p.Label != label || p.Editable != editable || d != def)
                fails.Add($"scene prop {n}: type {p.Type} label \"{p.Label}\" editable {p.Editable} default {d}; want {type} \"{label}\" {editable} {def}");
        }
        Is("schemecolor", "color", "Scheme color", true, "\"0.5 0.25 1\"");
        Is("clock", "bool", "Show clock", true, "true");
        Is("style", "combo", "Style", true, "\"2\"");
        Is("bars", "slider", "Bar Count", true, "64");
        Is("opacity", "slider", "Opacity", true, "0.85");
        Is("name", "textinput", "Name", true, "\"YOURNAME\"");
        Is("lbl", "text", "Info text", false, null);
        Is("grp", "group", "Clock", false, null);
        Is("launch", "usershortcut", "#1", false, null);
        Is("tex", "scenetexture", "Custom", false, null);
        Is("tint", "color", "Tint", true, "\"1 0 0\""); // a 0–255 colour → 0–1
        Is("weird", "hologram", "W", false, null);
        if (P("style")?.Options is not { } so || string.Join("|", so.Select(o => $"{o.Label}={o.Value}")) != "A=1|B=2|C & D=x")
            fails.Add($"combo options {string.Join("|", P("style")?.Options?.Select(o => $"{o.Label}={o.Value}") ?? [])}, want A=1|B=2|C & D=x");
        if (P("bars") is { Fraction: true } || P("opacity") is not { Precision: 3, Step: 0.01 })
            fails.Add("slider fraction/precision/step not parsed");
        if (P("launch")?.Unsupported == null || P("tex")?.Unsupported == null) fails.Add("usershortcut / scenetexture need an unsupported reason");
        if (SceneProperties.Parse("{not json").Count != 0 || SceneProperties.Parse("{\"general\":{\"properties\":[1]}}").Count != 0)
            fails.Add("a malformed project.json must parse to no properties, never throw");

        // values: Coerce (UI → WE encoding), ToPlayer (→ scene_props)
        void Co(string n, string json, string? want, string? player = null)
        {
            var p = P(n)!;
            var (v, err) = SceneProperties.Coerce(p, JsonDocument.Parse(json).RootElement);
            var got = err != null ? null : v?.ToJsonString();
            if (got != want) { fails.Add($"Coerce({n}, {json}) = {got ?? "error: " + err}, want {want ?? "an error"}"); return; }
            if (v == null) return;
            var pl = JsonSerializer.Serialize(SceneProperties.ToPlayer(p, v));
            if (player != null && pl != player) fails.Add($"ToPlayer({n}, {got}) = {pl}, want {player}");
        }
        Co("clock", "false", "false", "false");
        Co("clock", "\"1\"", "true", "true");
        Co("clock", "\"maybe\"", null);
        Co("bars", "70", "64", "64");            // clamped to max
        Co("bars", "20.6", "21", "21");          // fraction false → whole
        Co("opacity", "\"0.5\"", "0.5", "0.5");
        Co("opacity", "\"x\"", null);
        Co("schemecolor", "\"#ff8000\"", "\"1 0.501961 0\"", "[1,0.501961,0]");
        Co("schemecolor", "[0, 1, 0]", "\"0 1 0\"", "[0,1,0]");
        Co("schemecolor", "\"0 128 255\"", "\"0 0.501961 1\"");
        Co("schemecolor", "\"red\"", null);
        Co("style", "1", "\"1\"", "\"1\"");
        Co("style", "\"x\"", "\"x\"", "\"x\"");
        Co("style", "\"3\"", null);
        Co("name", "\"Ada\"", "\"Ada\"", "\"Ada\"");
        Co("name", "5", null);
        if (SceneProperties.Coerce(P("launch")!, JsonDocument.Parse("\"x\"").RootElement).Error == null) fails.Add("a usershortcut must refuse a value");
        if (!SceneProperties.SameValue(P("schemecolor")!, System.Text.Json.Nodes.JsonValue.Create("0.5 0.25 1.0"), P("schemecolor")!.Default))
            fails.Add("SameValue: \"0.5 0.25 1.0\" vs the default \"0.5 0.25 1\" must be equal");

        // conditions over the effective values (defaults here: clock true, style "2", hidden unknown)
        var eff = SceneProperties.Effective(props, null);
        void Vis(string? cond, bool want, Dictionary<string, System.Text.Json.Nodes.JsonNode?>? vals = null)
        {
            bool got = SceneProperties.Visible(cond, vals ?? eff);
            if (got != want) fails.Add($"Visible(\"{cond}\") = {got}, want {want}");
        }
        Vis(null, true);
        Vis("clock.value", true);
        Vis("clock.value && style.value == 2", true);       // combo key "2" == 2 (loose)
        Vis("style.value === 2", false);                     // strict: "2" !== 2
        Vis("style.value == \"2\" && bars.value >= 64", true);
        Vis("(clock.value || style.value == 'x') && !hidden.value", true);
        Vis("!clock.value", false);
        Vis("!dibu.value==0", false);                        // (!undefined) == 0 → true == 0 → false
        Vis("clock.value == true", true);
        Vis("clock.value == false", false);
        Vis("raineffects.value=true", true);                  // WE's JS: an assignment → its value
        Vis("false", false);
        Vis("opacity.value < 0.5 || opacity.value > 0.8", true);
        Vis("clock.value &&", true);                          // unparseable → shown
        Vis("clock. value == true && style .value == 2", true); // JS allows whitespace around `.` (corpus)
        Vis("ds+media.value", true);                          // a bare identifier (a ReferenceError in JS) → shown
        Vis("clock.value + 1 == 2", true);                    // true + 1 == 2
        if (SceneProperties.ConditionParses("a.value &&") || !SceneProperties.ConditionParses("ds+media.value"))
            fails.Add("ConditionParses: syntax only (a bare identifier parses, a dangling && doesn't)");
        var off = new Dictionary<string, System.Text.Json.Nodes.JsonNode?>(eff) { ["clock"] = false };
        Vis("clock.value && style.value == 2", false, off);
        Vis("sds.value && (clock.value || date.value)", false, off);

        PresetLayerAssertions(fails, props);

        // the player's map, only for overrides that name an editable property
        var dir = Path.Combine("/tmp", "lpst-props-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "project.json"), pj);
            var ov = new Dictionary<string, JsonElement>
            {
                ["clock"] = JsonDocument.Parse("false").RootElement, ["schemecolor"] = JsonDocument.Parse("\"0 1 0\"").RootElement,
                ["launch"] = JsonDocument.Parse("\"x\"").RootElement, ["gone"] = JsonDocument.Parse("1").RootElement,
            };
            var map = JsonSerializer.Serialize(SceneProperties.PlayerMap(dir, ov));
            if (map != "{\"clock\":false,\"schemecolor\":[0,1,0]}") fails.Add($"PlayerMap = {map}, want {{\"clock\":false,\"schemecolor\":[0,1,0]}}");
            if (JsonSerializer.Serialize(SceneProperties.PlayerDefault(dir, "schemecolor")) != "[0.5,0.25,1]") fails.Add("PlayerDefault(schemecolor) wrong");
        }
        finally { try { Directory.Delete(dir, true); } catch { } }

        // the real corpus (read-only; skipped without it) — never a copy elsewhere
        var corpus = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local/share/Steam/steamapps/workshop/content/431960");
        if (!Directory.Exists(corpus)) return;
        int scenes = 0, n = 0, conds = 0;
        foreach (var d in Directory.EnumerateDirectories(corpus))
        {
            var f = Path.Combine(d, "project.json");
            string text;
            try { text = File.ReadAllText(f); } catch { continue; }
            if (!text.Contains("\"scene\"", StringComparison.OrdinalIgnoreCase)) continue;
            List<SceneProp> ps;
            try { ps = SceneProperties.Parse(text); } catch (Exception e) { fails.Add($"corpus {Path.GetFileName(d)}: Parse threw {e.Message}"); continue; }
            scenes++;
            foreach (var p in ps)
            {
                n++;
                if (p.Condition is { } c) { conds++; if (!SceneProperties.ConditionParses(c)) fails.Add($"corpus {Path.GetFileName(d)}/{p.Name}: condition \"{c}\" doesn't parse"); }
                if (!p.Editable) continue;
                var (v, err) = SceneProperties.Coerce(p, JsonSerializer.SerializeToElement(p.Default));
                if (err != null || !SceneProperties.SameValue(p, v, p.Default))
                    fails.Add($"corpus {Path.GetFileName(d)}/{p.Name} ({p.Type}): default {p.Default?.ToJsonString()} doesn't round-trip ({err})");
            }
        }
        Console.WriteLine($"scene properties corpus: {scenes} project.json, {n} properties, {conds} conditions — all parsed");
    }

    // ---- a preset's values layered over its base scene's properties (pure: WithPreset, PlayerMap over a list) -----------
    private static void PresetLayerAssertions(List<string> fails, List<SceneProp> scene)
    {
        static JsonElement J(string json) => JsonDocument.Parse(json).RootElement;
        static Dictionary<string, JsonElement> Vals(params (string Name, string Json)[] v) =>
            v.ToDictionary(x => x.Name, x => J(x.Json));
        string D(List<SceneProp> ps, string n) => ps.FirstOrDefault(p => p.Name == n)?.Default?.ToJsonString() ?? "missing";
        string SD(List<SceneProp> ps, string n) => ps.FirstOrDefault(p => p.Name == n)?.SceneDefault?.ToJsonString() ?? "missing";
        string Map(List<SceneProp> ps, Dictionary<string, JsonElement>? ov = null, Dictionary<string, JsonElement>? tr = null) =>
            JsonSerializer.Serialize(SceneProperties.PlayerMap(ps, ov, tr));
        string sceneBefore = string.Join(",", scene.Select(p => $"{p.Name}={p.Default?.ToJsonString()}"));

        // the preset's values become the defaults; the scene's own stay beside them
        var a = SceneProperties.WithPreset(scene, Vals(("schemecolor", "\"0 0 1\""), ("clock", "false")));
        if (D(a, "schemecolor") != "\"0 0 1\"" || SD(a, "schemecolor") != "\"0.5 0.25 1\"")
            fails.Add($"WithPreset schemecolor: default {D(a, "schemecolor")} scene default {SD(a, "schemecolor")}, want \"0 0 1\" / \"0.5 0.25 1\"");
        if (D(a, "clock") != "false" || SD(a, "clock") != "true")
            fails.Add($"WithPreset clock: default {D(a, "clock")} scene default {SD(a, "clock")}, want false / true");
        if (D(a, "name") != "\"YOURNAME\"" || SD(a, "name") != "\"YOURNAME\"")
            fails.Add($"WithPreset name (no preset value): default {D(a, "name")} scene default {SD(a, "name")}, want the scene's \"YOURNAME\" for both");
        if (string.Join(",", a.Select(p => p.Name)) != string.Join(",", scene.Select(p => p.Name)))
            fails.Add("WithPreset must keep the base's properties, in its order");
        if (string.Join(",", scene.Select(p => $"{p.Name}={p.Default?.ToJsonString()}")) != sceneBefore)
            fails.Add("WithPreset changed the base scene's own list (it is ForItem's cached copy, shared with the base's card)");
        if (scene.FirstOrDefault(p => p.Name == "schemecolor") is { } sc && sc.SceneDefault?.ToJsonString() != sc.Default?.ToJsonString())
            fails.Add("a plain scene's SceneDefault must be its Default");
        // its conditions see the preset's values: `style` shows only while `clock` is on
        if (SceneProperties.Visible(a.First(p => p.Name == "style").Condition, SceneProperties.Effective(a, null)))
            fails.Add("under the preset (clock false) `style` must be hidden");

        // values saved against an older base: a name it no longer has, a value its type refuses, a combo option gone, a
        // value of another JSON type (a number for a bool), WE's own settings — each dropped alone, the rest applied
        var b = SceneProperties.WithPreset(scene, Vals(("gone", "1"), ("clock", "\"notabool\""), ("style", "\"9\""),
            ("opacity", "0.5"), ("_d0", "null"), ("wec_brs", "50"), ("alignmentx", "50"), ("rate", "100")));
        if (D(b, "clock") != "true" || D(b, "style") != "\"2\"" || D(b, "opacity") != "0.5")
            fails.Add($"WithPreset stale values: clock {D(b, "clock")} style {D(b, "style")} opacity {D(b, "opacity")}, want true / \"2\" / 0.5");
        if (b.Any(p => p.Name is "gone" or "_d0" or "wec_brs" or "alignmentx" or "rate") || b.Count != scene.Count)
            fails.Add("WithPreset must never add a property the base doesn't define");
        // WE saves a bool as true/false or as 0/1; any other number for a bool means its type changed
        if (D(SceneProperties.WithPreset(scene, Vals(("clock", "0"))), "clock") != "false"
            || D(SceneProperties.WithPreset(scene, Vals(("clock", "1"))), "clock") != "true"
            || D(SceneProperties.WithPreset(scene, Vals(("opacity", "0.5"), ("clock", "0"))), "clock") != "false")
            fails.Add($"WithPreset: a bool saved as 0 / 1 must read as false / true (0 → {D(SceneProperties.WithPreset(scene, Vals(("clock", "0"))), "clock")})");
        if (D(SceneProperties.WithPreset(scene, Vals(("clock", "2"))), "clock") != "true"
            || D(SceneProperties.WithPreset(scene, Vals(("clock", "0.5"))), "clock") != "true")
            fails.Add("WithPreset: a number other than 0 / 1 for a bool property (its type changed) must be dropped");

        PresetImageAssertions(fails, scene);

        // a slider beyond its range is clamped like a user's value (64 is also the scene's default: 3 → 16 proves it applied)
        if (D(SceneProperties.WithPreset(scene, Vals(("bars", "999"))), "bars") != "64"
            || D(SceneProperties.WithPreset(scene, Vals(("bars", "3"))), "bars") != "16")
            fails.Add($"WithPreset bars 999 → {D(SceneProperties.WithPreset(scene, Vals(("bars", "999"))), "bars")}, 3 → "
                + $"{D(SceneProperties.WithPreset(scene, Vals(("bars", "3"))), "bars")}; want 64 and 16 (clamped)");

        // the player's map: scene defaults never sent → the preset's values → the card's tweaks → a drag's transient value
        var c = SceneProperties.WithPreset(scene, Vals(("schemecolor", "\"0 0 1\""), ("clock", "false"), ("opacity", "0.85")));
        void M(string what, string got, string want) { if (got != want) fails.Add($"PlayerMap {what} = {got}, want {want}"); }
        M("of a plain scene, no overrides", Map(scene), "{}");
        M("of a preset", Map(c), "{\"clock\":false,\"schemecolor\":[0,0,1]}"); // opacity = the scene's own: not sent
        M("of a preset + the card's tweak", Map(c, Vals(("clock", "true"))), "{\"clock\":true,\"schemecolor\":[0,0,1]}");
        M("of a preset + a tweak + a drag", Map(c, Vals(("clock", "true")), Vals(("schemecolor", "\"0 1 0\""))),
            "{\"clock\":true,\"schemecolor\":[0,1,0]}");
        M("of a preset + a refused tweak", Map(c, Vals(("clock", "\"maybe\""))), "{\"clock\":false,\"schemecolor\":[0,0,1]}");
    }

    // ---- a preset's own image for a scenetexture slot (`tex` in the test scene) -----------------------------------------
    private static void PresetImageAssertions(List<string> fails, List<SceneProp> scene)
    {
        static Dictionary<string, JsonElement> Tex(string json) => new() { ["tex"] = JsonDocument.Parse(json).RootElement };
        var root = Path.Combine("/tmp", "lpst-preset-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            string dir = Path.Combine(root, "preset"), files = Path.Combine(dir, "files");
            Directory.CreateDirectory(files);
            File.WriteAllBytes(Path.Combine(files, "tint.png"), [0x89, (byte)'P', (byte)'N', (byte)'G']);
            File.WriteAllBytes(Path.Combine(files, "Anim.GIF"), [(byte)'G', (byte)'I', (byte)'F']);
            File.WriteAllText(Path.Combine(files, "notes.txt"), "not an image");
            File.WriteAllBytes(Path.Combine(root, "outside.png"), [0x89]);
            File.CreateSymbolicLink(Path.Combine(files, "out.png"), Path.Combine(root, "outside.png"));
            Directory.CreateDirectory(Path.Combine(files, "dir.png"));
            // a video where the base has an image slot (WE plays it there; the core streams it): the core's video
            // extensions in any case, the spaces and brackets of a Workshop file name
            File.WriteAllBytes(Path.Combine(files, "Intros [HD].mp4"), [0, 0, 0, 0x18]);
            File.WriteAllBytes(Path.Combine(files, "loop.WebM"), [0x1a, 0x45, 0xdf, 0xa3]);
            File.WriteAllBytes(Path.Combine(root, "outside.mp4"), [0]);
            File.CreateSymbolicLink(Path.Combine(files, "out.mp4"), Path.Combine(root, "outside.mp4"));
            // the preset folder reached through a link (a `local/<id>` link to Steam's folder): its files are still inside it
            var link = Path.Combine(root, "link");
            File.CreateSymbolicLink(link, dir);
            var real = Liascape.Web.ApiSecurity.RealPath(Path.Combine(files, "tint.png"))!;

            string? Default(string json, string? presetDir) =>
                SceneProperties.WithPreset(scene, Tex(json), presetDir).First(p => p.Name == "tex").Default?.GetValue<string>();
            string Map(string json, string? presetDir, Dictionary<string, JsonElement>? ov = null) =>
                JsonSerializer.Serialize(SceneProperties.PlayerMap(SceneProperties.WithPreset(scene, Tex(json), presetDir), ov));
            void Want(string what, string? got, string? want) { if (got != want) fails.Add($"preset image {what}: {got ?? "none"}, want {want ?? "none"}"); }

            Want("files/tint.png → its real path", Default("\"files/tint.png\"", dir), real);
            Want("through a linked preset folder", Default("\"files/tint.png\"", link), real);
            Want("a GIF (any case)", Default("\"files/Anim.GIF\"", dir), Liascape.Web.ApiSecurity.RealPath(Path.Combine(files, "Anim.GIF")));
            Want("PlayerMap sends it", Map("\"files/tint.png\"", dir), JsonSerializer.Serialize(new Dictionary<string, string> { ["tex"] = real }));
            var video = Liascape.Web.ApiSecurity.RealPath(Path.Combine(files, "Intros [HD].mp4"))!;
            Want("a video → its real path", Default("\"files/Intros [HD].mp4\"", dir), video);
            Want("a WebM (any case)", Default("\"files/loop.WebM\"", dir), Liascape.Web.ApiSecurity.RealPath(Path.Combine(files, "loop.WebM")));
            Want("PlayerMap sends the video", Map("\"files/Intros [HD].mp4\"", dir),
                JsonSerializer.Serialize(new Dictionary<string, string> { ["tex"] = video }));
            Want("a refused tweak of the slot keeps the preset's image", Map("\"files/tint.png\"", dir, Tex("\"/etc/passwd\"")),
                JsonSerializer.Serialize(new Dictionary<string, string> { ["tex"] = real }));
            foreach (var (json, why) in new[]
            {
                ("\"files/missing.png\"", "a missing file"), ("\"files/notes.txt\"", "not an image"), ("\"files/dir.png\"", "a folder"),
                ("\"../outside.png\"", "a path out of the folder"), ("\"files/../../outside.png\"", "a path through .."),
                ("\"files/out.png\"", "a link out of the folder"), ($"\"{Path.Combine(root, "outside.png")}\"", "an absolute path"),
                ("\"files/out.mp4\"", "a video linked out of the folder"), ("\"../outside.mp4\"", "a video out of the folder"),
                ("\"files/missing.mp4\"", "a missing video"),
                ("\"\"", "an empty value"), ("5", "a number"), ("\"files\\\\tint.png\"", "a backslash path"),
            })
            {
                Want(why + " is not sent", Default(json, dir), null);
                Want(why + ": PlayerMap", Map(json, dir), "{}");
            }
            // why each is refused: the adapter logs it beside the preset and slot (`DroppedPresetImages`)
            foreach (var (json, want) in new[]
            {
                ("\"files/out.mp4\"", "outside the preset's folder"), ("\"../outside.mp4\"", "outside the preset's folder"),
                ("\"files/missing.mp4\"", "missing"), ("\"files/notes.txt\"", "not an image or a video"),
                ("\"files/dir.png\"", "not a file"), ("\"\"", null),
            })
            {
                SceneProperties.PresetImage(dir, JsonDocument.Parse(json).RootElement, out var why);
                Want($"why {json} is refused", why, want);
            }
            Want("without the preset's folder nothing resolves", Default("\"files/tint.png\"", null), null);
            Want("the base's own (empty) value is never sent", JsonSerializer.Serialize(SceneProperties.PlayerMap(scene, null)), "{}");
            // a scene's own default that happens to name an existing file (an absolute path written into a downloaded
            // project.json) is never sent: only an image WithPreset resolved inside a preset's folder goes to the core
            var own = scene.Select(p => p.Name == "tex" ? p with { Default = System.Text.Json.Nodes.JsonValue.Create(Path.Combine(root, "outside.png")) } : p).ToList();
            Want("a scene's own existing-file default is never sent", JsonSerializer.Serialize(SceneProperties.PlayerMap(own, null)), "{}");
            Want("…nor on a preset that leaves that slot alone",
                JsonSerializer.Serialize(SceneProperties.PlayerMap(SceneProperties.WithPreset(own, Tex("\"files/missing.png\""), dir), null)), "{}");
        }
        catch (Exception e) { fails.Add($"preset image assertions threw {e.GetType().Name}: {e.Message}"); }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    // ---- next/prev/random's scene-skip decision point -----------------------------------------
    // StepLibrary/ApplyRandom (PlayerHelper) skip a path exactly when
    // `IsScenePath(path) && !PlayerStatus.ScenesPlayable(settings)` — the same formula the
    // private IsSkippedPath uses, reused here rather than invented (player-adapter.md § Scenes and loudness). Needs no
    // player and no `serve` — pure decision logic.
    private static void SceneSkipAssertions(List<string> fails)
    {
        const string scenePath = "/tmp/liascape-selftest-lib/workshop/123";   // no extension → a scene
        const string videoPath = "/tmp/liascape-selftest-lib/imported/v1/v1.mp4";

        if (!PlayerHelper.IsScenePath(scenePath)) fails.Add("IsScenePath(workshop dir) should be true");
        if (PlayerHelper.IsScenePath(videoPath)) fails.Add("IsScenePath(.mp4) should be false");

        static bool WouldSkip(string path, AppSettings s) =>
            PlayerHelper.IsScenePath(path) && !PlayerStatus.ScenesPlayable(s);

        // liascape-player: playable exactly when the player has the `scene` capability — the
        // capability half is SceneAdapterAssertions' truth table (pure: asking the shared client
        // here would greet whatever player owns the default socket)
        static bool LiascapeSkip(string path, bool cap) =>
            PlayerHelper.IsScenePath(path) && !PlayerStatus.ScenesPlayableFor(true, () => cap);
        if (!LiascapeSkip(scenePath, cap: false)) fails.Add("liascape-player without the scene capability should skip a scene");
        if (LiascapeSkip(scenePath, cap: true)) fails.Add("liascape-player with the scene capability + AllowScenes should play a scene");
        if (LiascapeSkip(videoPath, cap: false)) fails.Add("liascape-player should never skip a video");

        var scenesOff = new AppSettings { AllowScenes = false };
        if (!WouldSkip(scenePath, scenesOff))
            fails.Add("AllowScenes=false should skip a scene");

        // a preset that can't play (here: its file names no base) is skipped by every picker and refused by Apply with
        // its reason, scenes playable or not; a plain scene folder beside it is not
        var root = Path.Combine("/tmp", "lpst-preset-skip-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            string noBase = Path.Combine(root, "910000201"), plain = Path.Combine(root, "900000001");
            Directory.CreateDirectory(noBase); Directory.CreateDirectory(plain);
            File.WriteAllText(Path.Combine(noBase, "project.json"), "{\"preset\":{\"color\":\"0 0 1\"},\"title\":\"No base\"}");
            File.WriteAllText(Path.Combine(plain, "project.json"), "{\"type\":\"scene\",\"file\":\"scene.json\"}");
            if (PlayerHelper.PresetUnplayableReason(noBase) != Presets.NoBaseReason)
                fails.Add($"PresetUnplayableReason(a preset naming no base) = {PlayerHelper.PresetUnplayableReason(noBase) ?? "null"}, want \"{Presets.NoBaseReason}\"");
            if (!PlayerHelper.SkippedForRotation(noBase, scenesPlayable: true)) fails.Add("a preset that can't play must be skipped by the pickers (scenes playable)");
            if (PlayerHelper.PresetUnplayableReason(plain) != null) fails.Add("PresetUnplayableReason(a plain scene) must be null");
            if (PlayerHelper.SkippedForRotation(plain, scenesPlayable: true)) fails.Add("a plain scene (playable, not crashed) must not be skipped");
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    // ---- presets: a preset's status (pure: StatusFor's table) and reading its project.json (Presets.Read) ---------------
    private static void PresetAssertions(List<string> fails)
    {
        static PresetFile F(string? baseId) =>
            new(baseId, new Dictionary<string, JsonElement> { ["color"] = JsonDocument.Parse("\"0 0 1\"").RootElement });
        const string baseDir = "/lib/workshop/123";
        void Row(string what, PresetFile f, string? selfId, string? baseKind, string? dir, string? kind,
            PresetProblem want, string? wantDir, string? wantReason)
        {
            var got = Presets.StatusFor(f, selfId, baseKind, id => id == f.BaseId ? dir : null, d => d == dir ? kind : null);
            if (got.Problem != want || got.BaseDir != wantDir || got.Reason != wantReason)
                fails.Add($"preset status ({what}) = {got.Problem} {got.BaseDir ?? "null"} \"{got.Reason}\", want {want} {wantDir ?? "null"} \"{wantReason}\"");
        }
        Row("base found, a scene", F("123"), "910", null, baseDir, "scene", PresetProblem.None, baseDir, null);
        Row("no base id", F(null), "910", null, baseDir, "scene", PresetProblem.NoBase, null, "Its preset file names no base scene");
        Row("its own id", F("910"), "910", null, "/lib/workshop/910", "preset", PresetProblem.NoBase, null, "Its preset file names no base scene");
        Row("the download said web, no base here", F("123"), "910", "web", null, null, PresetProblem.BaseNotScene, null, "Its base is a web wallpaper, not a scene");
        Row("the download said web, a video base here", F("123"), "910", "web", baseDir, "video", PresetProblem.BaseNotScene, null, "Its base is a web wallpaper, not a scene");
        Row("the download said web, a scene base here now", F("123"), "910", "web", baseDir, "scene", PresetProblem.None, baseDir, null);
        Row("the download said scene", F("123"), "910", "scene", baseDir, "scene", PresetProblem.None, baseDir, null);
        Row("no base folder", F("123"), "910", null, null, null, PresetProblem.NeedsBase, null, "Needs its base scene");
        Row("a base folder of no kind (not whole yet)", F("123"), "910", null, baseDir, null, PresetProblem.NeedsBase, null, "Needs its base scene");
        Row("the base is a preset", F("123"), "910", null, baseDir, "preset", PresetProblem.BaseNotScene, baseDir, "Its base is a preset wallpaper, not a scene");
        Row("the base is a video", F("123"), "910", null, baseDir, "video", PresetProblem.BaseNotScene, baseDir, "Its base is a video wallpaper, not a scene");
        Row("the download said application", F("123"), "910", "application", null, null, PresetProblem.BaseNotScene, null, "Its base is an application wallpaper, not a scene");

        // Read over Wallpaper Engine's own files (scripts/test-fixtures/presets/<id>/project.json, from real Workshop items)
        string? fx = null;
        foreach (var start in new[] { Environment.CurrentDirectory, AppContext.BaseDirectory })
            for (var d = new DirectoryInfo(start); d != null && fx == null; d = d.Parent)
                if (Directory.Exists(Path.Combine(d.FullName, "scripts/test-fixtures/presets"))) fx = Path.Combine(d.FullName, "scripts/test-fixtures/presets");
        var dirs = fx == null ? [] : Directory.GetDirectories(fx);
        if (dirs.Length == 0) fails.Add("preset fixtures not found (scripts/test-fixtures/presets: run the self-test from the checkout)");
        foreach (var d in dirs)
        {
            var f = Presets.Read(d);
            if (f == null) { fails.Add($"Presets.Read({Path.GetFileName(d)}) = null, want a preset"); continue; }
            if (f.BaseId is not { Length: > 0 } b || !b.All(char.IsAsciiDigit) || f.Values.Count == 0)
                fails.Add($"Presets.Read({Path.GetFileName(d)}): base {f.BaseId ?? "null"}, {f.Values.Count} values; want a digit id and its values");
        }
        var tmp = Directory.CreateTempSubdirectory("liascape-selftest-presets-").FullName;
        try
        {
            string Dir(string name, string pj) { var d = Path.Combine(tmp, name); Directory.CreateDirectory(d); File.WriteAllText(Path.Combine(d, "project.json"), pj); return d; }
            if (Presets.Read(Dir("scene", "{\"type\":\"scene\",\"file\":\"scene.json\",\"general\":{\"properties\":{}}}")) != null)
                fails.Add("Presets.Read(a scene's project.json) should be null");
            if (Presets.Read(Dir("typed", "{\"type\":\"scene\",\"preset\":{\"a\":1},\"dependency\":\"123\"}")) != null)
                fails.Add("Presets.Read(a project.json with a type) should be null: a preset has none");
            if (Presets.Read(Dir("bad", "{\"preset\":{\"a\":1},\"dependency\":\"12")) != null)
                fails.Add("Presets.Read(malformed JSON) should be null");
            if (Presets.Read(Path.Combine(tmp, "none")) != null) fails.Add("Presets.Read(no folder) should be null");
            if (Presets.Read(Dir("nodep", "{\"preset\":{\"a\":1},\"title\":\"x\"}")) is not { BaseId: null })
                fails.Add("Presets.Read(a preset without a dependency) should be a preset with no base id (greyed with its reason)");
            if (Presets.Read(Dir("pathdep", "{\"preset\":{\"a\":1},\"dependency\":\"../123\"}")) is not { BaseId: null })
                fails.Add("Presets.Read(a non-digit dependency) should be a preset with no base id");
            // the cache follows the file: rewritten (another size) → read again
            var c = Dir("cached", "{\"preset\":{\"a\":1},\"dependency\":\"5\"}");
            Presets.Read(c);
            File.WriteAllText(Path.Combine(c, "project.json"), "{\"preset\":{\"a\":1,\"b\":2},\"dependency\":\"777\"}");
            if (Presets.Read(c) is not { BaseId: "777", Values.Count: 2 }) fails.Add("Presets.Read must read a changed project.json again (cached by mtime + size)");
        }
        finally { try { Directory.Delete(tmp, true); } catch { } }
    }

    // ---- item 6: queue depth cap, never blocks a caller --------------------------------------
    // Needs no player at all — LiascapePlayerMedia.Queue is pure in-process chaining. One slow item clogs
    // the single-worker FIFO deterministically (no timing race needed to "win" against the drain), so
    // a burst enqueued right behind it piles up — the cap must bound it, and enqueueing itself must
    // never block regardless of how clogged the chain is.
    private static void QueueDepthAssertions(List<string> fails)
    {
        _ = LiascapePlayerMedia.Queue(() => { Thread.Sleep(1500); return 0; });
        var sw = Stopwatch.StartNew();
        for (int i = 0; i < LiascapePlayerMedia.MaxQueueDepth + 60; i++) LiascapePlayerMedia.Queue(() => 0);
        sw.Stop();
        if (sw.ElapsedMilliseconds > 500) fails.Add($"enqueueing behind a clogged queue took {sw.ElapsedMilliseconds} ms (must never block the caller)");
        if (LiascapePlayerMedia.QueueDepth > LiascapePlayerMedia.MaxQueueDepth) fails.Add($"queue depth {LiascapePlayerMedia.QueueDepth} exceeds the cap {LiascapePlayerMedia.MaxQueueDepth}");
        try { LiascapePlayerMedia.Drain().Wait(8000); } catch { }
        if (LiascapePlayerMedia.QueueDepth != 0) fails.Add($"queue depth {LiascapePlayerMedia.QueueDepth} after draining, want 0");

        // Coalescing (speed storm): the newest command of a key replaces a still-pending one, the rest
        // keep their order, and nothing coalesces across an essential command (a switch/stop barrier).
        var ran = new List<string>();
        void Rec(string s) { lock (ran) ran.Add(s); }
        _ = LiascapePlayerMedia.Queue(() => { Thread.Sleep(300); return 0; }); // clog: everything below piles up
        var a1 = LiascapePlayerMedia.QueueSet("t:a", () => Rec("a1"));
        LiascapePlayerMedia.QueueSet("t:b", () => Rec("b1"));
        LiascapePlayerMedia.QueueSet("t:a", () => Rec("a2"));   // replaces a1; b1 keeps its place before it
        LiascapePlayerMedia.QueueEssential(() => Rec("E1"));    // barrier
        LiascapePlayerMedia.QueueSet("t:a", () => Rec("a3"));   // after the barrier: never merged into a2
        LiascapePlayerMedia.QueueSet("t:a", () => Rec("a4"));   // replaces a3
        try { LiascapePlayerMedia.Drain().Wait(5000); } catch { }
        var want = "b1 a2 E1 a4";
        lock (ran) if (string.Join(" ", ran) != want) fails.Add($"coalescing order: ran `{string.Join(" ", ran)}`, want `{want}`");
        if (!a1.IsCompleted) fails.Add("a replaced command's task didn't complete with its replacement");

        // At the cap: a set whose key is pending still lands (the newest value, not dropped), an
        // essential command is admitted anyway, and a NEW key that can't coalesce is refused.
        ran.Clear();
        _ = LiascapePlayerMedia.Queue(() => { Thread.Sleep(600); return 0; });
        LiascapePlayerMedia.QueueSet("t:c", () => Rec("c1"));
        for (int i = 0; i < LiascapePlayerMedia.MaxQueueDepth + 20; i++) { int k = i; LiascapePlayerMedia.QueueSet($"t:d{k}", () => Rec("d")); }
        int atCap = LiascapePlayerMedia.QueueDepth;
        LiascapePlayerMedia.QueueSet("t:c", () => Rec("c2"));
        LiascapePlayerMedia.QueueSet("t:new", () => Rec("new"));
        LiascapePlayerMedia.QueueEssential(() => Rec("E2"));
        try { LiascapePlayerMedia.Drain().Wait(8000); } catch { }
        lock (ran)
        {
            if (atCap != LiascapePlayerMedia.MaxQueueDepth) fails.Add($"distinct keys past the cap: depth {atCap}, want {LiascapePlayerMedia.MaxQueueDepth}");
            if (ran.Contains("c1") || !ran.Contains("c2")) fails.Add($"at the cap the newest set of a pending key must replace it (c1 ran {ran.Contains("c1")}, c2 ran {ran.Contains("c2")})");
            if (ran.Contains("new")) fails.Add("at the cap a new key that can't coalesce was admitted");
            if (ran.LastOrDefault() != "E2") fails.Add($"an essential command at the cap didn't run last (last: {ran.LastOrDefault() ?? "none"})");
        }
        if (LiascapePlayerMedia.QueueDepth != 0) fails.Add($"queue depth {LiascapePlayerMedia.QueueDepth} after the coalescing checks, want 0");
        // the cap logs what filled it (a bare "dropping a queued command" can't tell which)
        if (LiascapePlayerMedia.CapDrops < 1 || LiascapePlayerMedia.LastCapHistogram is not { } hist || !hist.Contains("t:d"))
            fails.Add($"at the cap: drops {LiascapePlayerMedia.CapDrops}, histogram `{LiascapePlayerMedia.LastCapHistogram ?? "none"}` (want the pending kinds)");

        // A batch (per-item passes — /library/speed of every item): members join the pending batch of their key,
        // each once, at the tail; never across a barrier.
        ran.Clear();
        _ = LiascapePlayerMedia.Queue(() => { Thread.Sleep(300); return 0; });
        var x1 = LiascapePlayerMedia.QueueBatch("t:batch", "/x", m => Rec("B[" + string.Join(",", m.Order(StringComparer.Ordinal)) + "]"));
        LiascapePlayerMedia.QueueSet("t:e", () => Rec("e1"));
        for (int i = 0; i < LiascapePlayerMedia.MaxQueueDepth + 20; i++)
            LiascapePlayerMedia.QueueBatch("t:batch", i % 2 == 0 ? "/y" : "/x", m => Rec("B[" + string.Join(",", m.Order(StringComparer.Ordinal)) + "]"));
        int batchDepth = LiascapePlayerMedia.QueueDepth;
        LiascapePlayerMedia.QueueEssential(() => Rec("E3"));
        LiascapePlayerMedia.QueueBatch("t:batch", "/z", m => Rec("B[" + string.Join(",", m.Order(StringComparer.Ordinal)) + "]"));
        try { LiascapePlayerMedia.Drain().Wait(5000); } catch { }
        want = "e1 B[/x,/y] E3 B[/z]";
        lock (ran) if (string.Join(" ", ran) != want) fails.Add($"batch order: ran `{string.Join(" ", ran)}`, want `{want}`");
        if (batchDepth > 3) fails.Add($"a batch burst queued {batchDepth} commands, want the clog + e1 + one batch");
        if (!x1.IsCompleted) fails.Add("a merged batch's first task didn't complete");
    }

    // ---- protocol round-trip -----------------------------------------------------------------
    private static void RoundTrip(List<string> fails)
    {
        var bin = PlayerStatus.ResolveBinary();
        if (bin == null) { fails.Add("liascape-player binary not found (set LIASCAPE_PLAYER_BIN)"); return; }
        var tmp = Path.Combine("/tmp", "lpst-" + Guid.NewGuid().ToString("N")[..8]); // socket path < 108 bytes
        Directory.CreateDirectory(Path.Combine(tmp, "rt"));
        Directory.CreateDirectory(Path.Combine(tmp, "st"));
        var sock = Path.Combine(tmp, "rt", "player.sock");
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
            psi.Environment.Remove("LIASCAPE_PLAYER_SOCKET");
            psi.Environment.Remove("LD_LIBRARY_PATH"); // a stray one on this machine breaks the Nix binary's libs
            psi.Environment["LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES"] = "1"; // the scene round trip below (a synthetic scene)
            if (TransitionService.ResolveDir() is { } tdir) psi.Environment["LIASCAPE_TRANSITIONS_DIR"] = tdir;
            var logPath = Path.Combine(tmp, "serve.log");
            serve = Process.Start(psi)!;
            serve.OutputDataReceived += (_, e) => { if (e.Data != null) try { File.AppendAllText(logPath, e.Data + "\n"); } catch { } };
            serve.ErrorDataReceived += (_, e) => { if (e.Data != null) try { File.AppendAllText(logPath, e.Data + "\n"); } catch { } };
            serve.BeginOutputReadLine(); serve.BeginErrorReadLine();

            var client = new LiascapePlayerClient(sock) { AutoSpawn = false };
            LiascapePlayerClient.Shared = client; // LiascapePlayerMedia talks to the private server only
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
            // the capabilities `hello` lists (this private player allows synthetic scenes, so it
            // has `scene` whenever liascape-scene-worker resolves — next to liascape-player in the dev tree)
            var caps = hello.GetProperty("capabilities").EnumerateArray().Select(x => x.GetString()).ToHashSet();
            if (!client.Capabilities.Contains("video")) fails.Add($"client.Capabilities = [{string.Join(",", client.Capabilities)}], want hello's [{string.Join(",", caps)}]");
            if (!caps.Contains("scene")) fails.Add($"the private player (synthetic scenes allowed) has no `scene` capability [{string.Join(",", caps)}] — is liascape-scene-worker built next to {bin}?");
            if (client.ScenesAvailable != caps.Contains("scene")) fails.Add($"client.ScenesAvailable = {client.ScenesAvailable}, hello says scene={caps.Contains("scene")}");

            // the stepped clock only moves on `step` → a pump on its own connection (pausable)
            var stepper = new LiascapePlayerClient(sock) { AutoSpawn = false };
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
                var s = new AppSettings { NoAudio = false, Volume = 100 };

                // A = colour (no previous picture), align now
                var red = client.Call("transition", new Dictionary<string, object?>
                {
                    ["outputs"] = "out:*",
                    ["to"] = new Dictionary<string, object?> { ["kind"] = "color", ["color"] = new[] { 1.0, 0.0, 0.0 } },
                });
                var redCorr = red.GetProperty("corr").GetString()!;
                var redOut = LiascapePlayerMedia.WaitCorr(redCorr, CancellationToken.None, 10000).GetAwaiter().GetResult();
                Phase("colour handoff");
                if (redOut != "handoff") { fails.Add($"colour transition {redCorr}: {redOut}"); return; }

                if (LiascapePlayerMedia.EventOutcomes != 0) fails.Add("an outcome arrived as an event before anything subscribed");
                // colour → clip, align now, an effect when the catalogue resolves → transition.handoff
                var cfg = new TransitionService.Config(true, ["fade"], 200, 0, false);
                using (var to = new CancellationTokenSource(20000))
                {
                    bool ok = LiascapePlayerMedia.SwitchAndWaitHandoff(a, s, cfg, to.Token).GetAwaiter().GetResult();
                    if (!ok) { fails.Add($"colour→clip (align now): no transition.handoff (corr {LiascapePlayerMedia.LastCorr})"); return; }
                }
                Phase("colour→clip handoff (align now)");
                if (LiascapePlayerMedia.EventOutcomes < 1) fails.Add("colour→clip handoff came from the log poll, not the subscribed event");
                if (LiascapePlayerMedia.CurrentPath() != a) fails.Add($"CurrentPath after colour→clip = {LiascapePlayerMedia.CurrentPath() ?? "null"}, want a.mp4");

                // dispatch-level translation end to end: mpv `volume 50` → srcs:*.gain.user −18.06 dB
                LiascapePlayerMedia.Mpv(["set_property", "volume", 50]);
                LiascapePlayerMedia.Drain().Wait(5000); // property sets are queued (never on the caller's thread)
                var gu = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.gain.user" }).GetProperty("value").GetDouble();
                if (Math.Abs(gu - (-18.0618)) > 1e-3) fails.Add($"volume 50 via Mpv → cur gain.user {gu}, want -18.06");
                if (LiascapePlayerMedia.Query("time_pos") is not double) fails.Add("Query(time_pos) = null on a playing clip");

                // Speed storm leftover: a slider burst past the queue cap behind a slow command — the
                // NEWEST value must be the one that lands (coalesced per target + property), never
                // dropped at the cap (failing shape: sets past 256 refused, the last one included).
                _ = LiascapePlayerMedia.Queue(() => { Thread.Sleep(600); return 0; });
                for (int i = 0; i < LiascapePlayerMedia.MaxQueueDepth + 60; i++) LiascapePlayerMedia.Mpv(["set_property", "volume", 20 + i % 40]);
                LiascapePlayerMedia.Mpv(["set_property", "volume", 77]);
                int depthAtBurst = LiascapePlayerMedia.QueueDepth;
                LiascapePlayerMedia.Drain().Wait(20000);
                var gu77 = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.gain.user" }).GetProperty("value").GetDouble();
                if (Math.Abs(gu77 - MpvPropertyMap.VolumeDb(77)) > 1e-3)
                    fails.Add($"queue cap: the newest volume set didn't land — gain.user {gu77:0.###}, want {MpvPropertyMap.VolumeDb(77):0.###} (depth at the burst {depthAtBurst})");
                if (depthAtBurst > 3) fails.Add($"queue cap: a burst of {LiascapePlayerMedia.MaxQueueDepth + 61} sets of ONE property queued {depthAtBurst} commands (want them coalesced: the slow one + 1)");
                Phase($"coalesced slider burst: depth {depthAtBurst}, landed gain.user {gu77:0.##}");

                // /preview round trips (speed storm): a drag value costs ONE `set` per source — not a
                // `state` read for the path → source ids (+ `get cur:*.path` without paths) every time.
                // The map is cached until the graph changes (failing shape: 2 requests per value).
                LiascapePlayerMedia.Preview(30, null, [a]); LiascapePlayerMedia.Drain().Wait(2000); // may (re)read the map once
                long req0 = client.RequestCount; int reads0 = LiascapePlayerMedia.SourceMapReads;
                const int nPrev = 20;
                for (int i = 0; i < nPrev; i++) { LiascapePlayerMedia.Preview(31 + i, null, [a]); LiascapePlayerMedia.Drain().Wait(2000); }
                double perPreview = (client.RequestCount - req0) / (double)nPrev;
                var guPrev = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.gain.user" }).GetProperty("value").GetDouble();
                if (perPreview > 1.05) fails.Add($"/preview costs {perPreview:0.##} requests per value (want 1: one `set` on the cached source; map reads {LiascapePlayerMedia.SourceMapReads - reads0})");
                if (Math.Abs(guPrev - MpvPropertyMap.VolumeDb(50)) > 1e-3) fails.Add($"/preview's last value didn't land: gain.user {guPrev:0.###}, want {MpvPropertyMap.VolumeDb(50):0.###}");
                Phase($"/preview: {perPreview:0.##} requests per value over {nPrev} (map reads {LiascapePlayerMedia.SourceMapReads - reads0})");

                // Speed storm: the storm's global phase clears every playlist item's speed override in a loop
                // (315 × /library/speed). With a key per item (`override:<path>`, never coalescing) the queue hits its
                // cap with the player answering fast: ≥ 256 pending, and the next one dropped (whichever item it is —
                // the PLAYING one's included). A burst of per-item overrides
                // behind a slow command must stay a handful of commands and every item's pass (the playing one last
                // here) must land. Failing shape: depth 256, a's override dropped (its speed stays the preview's).
                {
                    double eff = Math.Clamp(LibraryService.ReadSpeedOverride(a) ?? SettingsService.Load().Speed, 0.1, 4.0);
                    double transient = Math.Abs(eff - 2.0) > 0.1 ? 2.0 : 3.0;
                    LiascapePlayerMedia.Preview(null, transient, [a]); LiascapePlayerMedia.Drain().Wait(2000);
                    _ = LiascapePlayerMedia.Queue(() => { Thread.Sleep(600); return 0; });
                    for (int i = 0; i < LiascapePlayerMedia.MaxQueueDepth + 60; i++)
                        LiascapePlayerMedia.ApplyOverride(Path.Combine(tmp, $"not-playing-{i}.mp4"));
                    LiascapePlayerMedia.ApplyOverride(a);
                    int depthOv = LiascapePlayerMedia.QueueDepth;
                    LiascapePlayerMedia.Drain().Wait(20000);
                    var spOv = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.speed" }).GetProperty("value").GetDouble();
                    if (depthOv > 3) fails.Add($"queue cap: {LiascapePlayerMedia.MaxQueueDepth + 61} per-item overrides (/library/speed of every item) queued {depthOv} commands (want them coalesced: the slow one + 1)");
                    if (Math.Abs(spOv - eff) > 1e-3) fails.Add($"queue cap: the playing item's override pass didn't land after a per-item burst — speed {spOv:0.###}, want {eff:0.###} (depth at the burst {depthOv})");
                    Phase($"per-item override burst: depth {depthOv}, playing speed {spOv:0.##} (want {eff:0.##})");
                }

                // the effective-settings resolver's diff (player-adapter.md § Targeting): a full pass over a source
                // that already runs every effective value costs its one `state` read and sends nothing; a value
                // another client changed behind our back is put back by the next full pass
                var spBefore = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.speed" }).GetProperty("value").GetDouble();
                LiascapePlayerMedia.ApplyEffective(); LiascapePlayerMedia.Drain().Wait(2000); // A now runs the settings' own values
                long rq0 = client.RequestCount;
                LiascapePlayerMedia.ApplyEffective(); LiascapePlayerMedia.Drain().Wait(2000);
                long noop = client.RequestCount - rq0;
                if (noop != 1) fails.Add($"a no-op resolver pass cost {noop} requests (want 1: the `state` read, no `set`)");
                var behind = new LiascapePlayerClient(sock) { AutoSpawn = false };
                behind.Call("set", new Dictionary<string, object?> { ["path"] = "cur:*.speed", ["value"] = 2.5 });
                LiascapePlayerMedia.ApplyEffective(); LiascapePlayerMedia.Drain().Wait(2000);
                var spBack = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.speed" }).GetProperty("value").GetDouble();
                double spWant = Math.Clamp(SettingsService.Load().Speed, 0.1, 4.0);
                if (Math.Abs(spBack - spWant) > 1e-6) fails.Add($"a full resolver pass left another client's speed 2.5 (speed {spBack}, want {spWant})");
                else Phase($"resolver: a no-op pass costs {noop} request; another client's speed change put back");
                behind.Call("set", new Dictionary<string, object?> { ["path"] = "cur:*.speed", ["value"] = spBefore }); // the clip's timing below stays as it was
                LiascapePlayerMedia.InvalidateSources(); // …and no cached value pretends otherwise
                LiascapePlayerMedia.Mpv(["set_property", "volume", 50]); LiascapePlayerMedia.Drain().Wait(2000); // back to the global (srcs:*)

                // transitions OFF: a cut
                using (var to = new CancellationTokenSource(30000))
                {
                    bool ok = LiascapePlayerMedia.SwitchAndWaitHandoff(b, s, null, to.Token).GetAwaiter().GetResult();
                    if (!ok) { fails.Add($"clip→clip cut: no transition.handoff (corr {LiascapePlayerMedia.LastCorr})"); return; }
                }
                Phase("clip→clip cut handoff");
                if (LiascapePlayerMedia.CurrentPath() != b) fails.Add($"CurrentPath after cut = {LiascapePlayerMedia.CurrentPath() ?? "null"}, want b.mp4");

                // the source map is invalidated by a switch: b's NEW source (absent from the map read
                // while a played) gets the preview
                LiascapePlayerMedia.Preview(44, null, [b]); LiascapePlayerMedia.Drain().Wait(2000);
                var guB = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.gain.user" }).GetProperty("value").GetDouble();
                if (Math.Abs(guB - MpvPropertyMap.VolumeDb(44)) > 1e-3) fails.Add($"/preview after a switch missed the new source: gain.user {guB:0.###}, want {MpvPropertyMap.VolumeDb(44):0.###}");
                // …and by ANOTHER client's switch (a pending B nobody here requested), through its event
                var foreign = new LiascapePlayerClient(sock) { AutoSpawn = false };
                int epoch0 = LiascapePlayerMedia.SourceEpoch;
                var fr = foreign.Call("transition", new Dictionary<string, object?>
                {
                    ["outputs"] = "out:*",
                    ["to"] = new Dictionary<string, object?> { ["path"] = a, ["loop"] = true },
                    ["align"] = "end",
                });
                string fCorr = fr.GetProperty("corr").GetString()!, fB = fr.GetProperty("to").GetString()!;
                var esw = Stopwatch.StartNew();
                while (LiascapePlayerMedia.SourceEpoch == epoch0 && esw.ElapsedMilliseconds < 3000) Thread.Sleep(10);
                LiascapePlayerMedia.Preview(55, null, [a]); LiascapePlayerMedia.Drain().Wait(2000);
                var guF = client.Call("get", new Dictionary<string, object?> { ["path"] = $"{fB}.gain.user" }).GetProperty("value").GetDouble();
                if (LiascapePlayerMedia.SourceEpoch == epoch0) fails.Add("another client's switch never invalidated the source map (no event within 3 s)");
                if (Math.Abs(guF - MpvPropertyMap.VolumeDb(55)) > 1e-3) fails.Add($"/preview missed another client's pending B {fB}: gain.user {guF:0.###}, want {MpvPropertyMap.VolumeDb(55):0.###}");
                else Phase($"/preview reached a new source after our switch and another client's pending B ({fB})");
                try { foreign.Call("cancel", new Dictionary<string, object?> { ["corr"] = fCorr }); } catch (LiascapePlayerException) { }
                Thread.Sleep(100);
                LiascapePlayerMedia.Mpv(["set_property", "volume", 50]); LiascapePlayerMedia.Drain().Wait(2000);

                // caller cancel → `cancel {corr}` → false, and the player reports it cancelled
                stepping.Reset(); // clock frozen → the effect never ends → the switch stays in flight
                using (var cts = new CancellationTokenSource(400))
                {
                    bool ok = LiascapePlayerMedia.SwitchAndWaitHandoff(a, s, cfg, cts.Token).GetAwaiter().GetResult();
                    if (ok) fails.Add("a cancelled switch returned true");
                }
                Phase("cancelled switch returned");
                var corr = LiascapePlayerMedia.LastCorr;
                var logs = client.Call("logs", new Dictionary<string, object?> { ["corr"] = corr, ["kind_prefix"] = "transition." });
                bool cancelled = logs.GetProperty("events").EnumerateArray().Any(e => e.GetProperty("kind").GetString() == "transition.cancelled");
                if (!cancelled) fails.Add($"cancel {corr}: no transition.cancelled in its log");
                stepping.Set();
                if (LiascapePlayerMedia.CurrentPath() != b) fails.Add("cancel didn't leave A (b.mp4) on screen");

                // a scene folder plays as `kind: scene` (a synthetic one), takes the
                // settings like a video, and the per-monitor scene fps reaches its output live
                var scene = Path.Combine(tmp, "workshop", "900000001");
                SyntheticScene(scene, "{\"pattern\":\"solid\",\"rgb\":[0,128,255],\"native\":[640,360],\"fonts\":[{\"font\":\"Consolas\",\"shown\":\"Cascadia Mono\"}]}");
                using (var to = new CancellationTokenSource(20000))
                {
                    bool ok = LiascapePlayerMedia.SwitchAndWaitHandoff(scene, s, cfg, to.Token).GetAwaiter().GetResult();
                    if (!ok) fails.Add($"clip→scene fade: no transition.handoff (corr {LiascapePlayerMedia.LastCorr})");
                }
                string? Cur(string prop) { try { var v = client.Call("get", new Dictionary<string, object?> { ["path"] = $"cur:*.{prop}" }).GetProperty("value"); return v.ValueKind == JsonValueKind.String ? v.GetString() : v.GetRawText(); } catch (LiascapePlayerException e) { return e.Code; } }
                if (Cur("kind") != "scene" || Cur("ready") != "true" || Cur("preview") != Path.Combine(scene, "preview.png"))
                    fails.Add($"the scene folder plays as kind={Cur("kind")} ready={Cur("ready")} preview={Cur("preview")}, want scene/true/its preview.png");
                else Phase("clip→scene fade: kind scene, ready, preview set");
                // scene.fonts reaches the backend: the synthetic scene's Ready reports a stand-in (its spec's `fonts`), the
                // player's `scene.fonts` names its path, and OnSceneFonts parses it (the path is outside the library: no write)
                var fontsBy = DateTime.UtcNow.AddSeconds(5);
                while (LiascapePlayerMedia.LastSceneFonts?.Path != scene && DateTime.UtcNow < fontsBy) Thread.Sleep(50);
                if (LiascapePlayerMedia.LastSceneFonts is not { } lf || lf.Path != scene || lf.List.Count != 1
                    || lf.List[0].Font != "Consolas" || lf.List[0].Shown != "Cascadia Mono")
                    fails.Add($"scene.fonts never reached the backend for {scene} (last: {JsonSerializer.Serialize(LiascapePlayerMedia.LastSceneFonts?.List)} for {LiascapePlayerMedia.LastSceneFonts?.Path})");
                else Phase("scene.fonts reaches the backend: Consolas shown with Cascadia Mono");
                LiascapePlayerMedia.ApplySceneFps([], [new SceneMonitor { Name = "VIRTUAL-1", Fps = 45 }]);
                LiascapePlayerMedia.Drain().Wait(2000);
                double Fps() => client.Call("get", new Dictionary<string, object?> { ["path"] = "out:VIRTUAL-1.scene_fps" }).GetProperty("value").GetDouble();
                if (Math.Abs(Fps() - 45) > 1e-6) fails.Add($"ApplySceneFps(VIRTUAL-1 45) → out:VIRTUAL-1.scene_fps {Fps()}, want 45");
                LiascapePlayerMedia.ApplySceneFps([new SceneMonitor { Name = "VIRTUAL-1", Fps = 45 }], []);
                LiascapePlayerMedia.Drain().Wait(2000);
                if (Math.Abs(Fps() - 15) > 1e-6) fails.Add($"removing VIRTUAL-1 from SceneMonitors → scene_fps {Fps()}, want the default 15");
                else Phase("ApplySceneFps: VIRTUAL-1 45 live, back to 15 when removed");
                // the GPU / VRAM settings → the player props, live, diffed
                string PlayerProp(string p) { var v = client.Call("get", new Dictionary<string, object?> { ["path"] = $"player.{p}" }).GetProperty("value"); return v.ValueKind == JsonValueKind.String ? v.GetString()! : v.GetRawText(); }
                var g0 = new AppSettings();
                var g1 = new AppSettings { AutoThrottleScenes = false, LimitVramPerScene = true, SceneVramLimitMib = 1536, SceneVramStopShows = "nothing", VramLowMode = "pause", AllowScenes = true };
                LiascapePlayerMedia.ApplyGpuSettings(g0, g1); LiascapePlayerMedia.Drain().Wait(2000);
                string Gpu() => $"{PlayerProp("scene_throttle")} {PlayerProp("scene_vram_limit_mib")} {PlayerProp("scene_vram_stop_shows")} {PlayerProp("vram_low_mode")} {PlayerProp("scene_spare")}";
                if (Gpu() != "false 1536.0 nothing pause true" && Gpu() != "false 1536 nothing pause true") fails.Add($"ApplyGpuSettings → {Gpu()}, want false 1536 nothing pause true");
                LiascapePlayerMedia.ApplyGpuSettings(g1, g0); LiascapePlayerMedia.Drain().Wait(2000);
                if (Gpu() != "true 0.0 last_frame stop false" && Gpu() != "true 0 last_frame stop false") fails.Add($"ApplyGpuSettings back to the defaults → {Gpu()}, want true 0 last_frame stop false");
                else Phase("ApplyGpuSettings: scene_throttle / scene_vram_limit_mib / scene_vram_stop_shows / vram_low_mode / scene_spare live and back");
                // pause when covered → player.pause_when_covered, live, diffed (the player's own default is off)
                LiascapePlayerMedia.ApplyCoverSetting(g0, new AppSettings { PauseWhenCovered = "fullscreen" }); LiascapePlayerMedia.Drain().Wait(2000);
                if (PlayerProp("pause_when_covered") != "fullscreen") fails.Add($"ApplyCoverSetting(fullscreen) → {PlayerProp("pause_when_covered")}");
                LiascapePlayerMedia.ApplyCoverSetting(new AppSettings { PauseWhenCovered = "fullscreen" }, g0); LiascapePlayerMedia.Drain().Wait(2000);
                if (PlayerProp("pause_when_covered") != "maximized") fails.Add($"ApplyCoverSetting back to the default → {PlayerProp("pause_when_covered")}, want maximized");
                else Phase("ApplyCoverSetting: pause_when_covered live and back");
                using (var to = new CancellationTokenSource(20000))
                {
                    bool ok = LiascapePlayerMedia.SwitchAndWaitHandoff(b, s, null, to.Token).GetAwaiter().GetResult();
                    if (!ok || LiascapePlayerMedia.CurrentPath() != b) fails.Add($"scene→clip cut: handoff={ok}, cur {LiascapePlayerMedia.CurrentPath() ?? "null"}");
                }
                LiascapePlayerMedia.Mpv(["set_property", "volume", 50]); LiascapePlayerMedia.Drain().Wait(2000);

                // a STOPPED player costs one quick timeout, then the stall breaker answers at once.
                // The COMPOSITOR holds the socket (the supervisor never does) — SIGSTOP/SIGCONT it, never
                // the supervisor, which would see no effect at all and prove nothing.
                int compositorPid = client.PlayerPid ?? serve.Id;
                stepping.Reset(); Thread.Sleep(300);
                kill(compositorPid, 19); // SIGSTOP the compositor
                try
                {
                    var q = Stopwatch.StartNew();
                    var p1 = LiascapePlayerMedia.CurrentPath(); long t1 = q.ElapsedMilliseconds; q.Restart();
                    var p2 = LiascapePlayerMedia.CurrentPath(); long t2 = q.ElapsedMilliseconds;
                    LiascapePlayerMedia.Mpv(["set_property", "volume", 80]); long t3 = q.ElapsedMilliseconds - t2;
                    if (p1 != null || p2 != null) fails.Add("a stopped player still answered");
                    if (t1 > 450) fails.Add($"first query to a stopped player took {t1} ms (want ≤ 450: QuickMs + slack)");
                    if (t2 > 50) fails.Add($"query after the timeout took {t2} ms (want the stall breaker: ≤ 50)");
                    if (t3 > 50) fails.Add($"a property set blocked its caller {t3} ms (want queued: ≤ 50)");
                    Phase($"stopped player: query {t1} ms, then {t2} ms (breaker), set returned in {t3} ms");
                }
                finally { kill(compositorPid, 18); } // SIGCONT
                stepping.Set();
                Thread.Sleep(3300); // the breaker re-opens the line 3 s after the timeout
                if (LiascapePlayerMedia.CurrentPath() != b) fails.Add("no recovery after SIGCONT (+3 s breaker window)");
                Phase("recovered after SIGCONT");
                // the reapply: the breaker closing (this is exactly that — the first query above after it
                // reopened) must have fired a reapply, catching up whatever the `volume 80` set during
                // the stall (above) dropped. OnRecovered's Queue(...) is fire-and-forget (by design — it
                // must never block the caller that happened to be the one to notice the recovery), so
                // wait for the chain here before checking/moving on — otherwise this reapply races the
                // NEXT phase's compositor kill below and runs against a player that's already dead again.
                LiascapePlayerMedia.Drain().Wait(2000);
                if (LiascapePlayerMedia.ReapplyCount < 1) fails.Add("R81: no settings reapply after the stall recovered (OnRecovered)");
                else Phase($"R81: stall recovery triggered a reapply ({LiascapePlayerMedia.ReapplyCount}x so far)");

                // I3: the pause is toggled by ANOTHER process (a keybind's one-shot
                // `liascape toggle-pause` — here a second, independent client): this
                // backend has no memory of it, and must never re-assert one. After the supervised
                // restart below (whose snapshot restores `player.paused`) and its reapply, the
                // pause must still be on — not flipped.
                var other = new LiascapePlayerClient(sock) { AutoSpawn = false };
                other.Call("set", new Dictionary<string, object?> { ["path"] = "player.paused", ["value"] = true }, 2000);
                Thread.Sleep(600); // the snapshot is written 250 ms after a change

                // Supervised restart: SIGKILL the COMPOSITOR directly, never the supervisor
                // — the supervisor must see this as a crash and restart its child with a NEW hello.pid
                // (same supervisor_pid) within ~1.5 s (measured on-machine: 150-260 ms).
                int reapplyBeforeRestart = LiascapePlayerMedia.ReapplyCount;
                int deadCompositor = client.PlayerPid ?? -1;
                int priorSupervisor = client.SupervisorPid ?? serve.Id;
                kill(deadCompositor, 9);
                int newCompositor = -1;
                var rsw = Stopwatch.StartNew();
                // Polled with a FRESH client per attempt: a hello that reaches the new compositor before
                // it serves times out, and the shared client's stall breaker would then fail every
                // further attempt for 3 s (under load that alone fails this check).
                while (rsw.ElapsedMilliseconds < 1500)
                {
                    try
                    {
                        var h = new LiascapePlayerClient(sock) { AutoSpawn = false }.Call("hello", null, 300);
                        int hp = h.GetProperty("pid").GetInt32();
                        if (hp != deadCompositor) { newCompositor = hp; break; }
                    }
                    catch (LiascapePlayerException) { }
                    Thread.Sleep(30);
                }
                Phase($"supervised restart: compositor {deadCompositor} -> {newCompositor} in {rsw.ElapsedMilliseconds} ms");
                // …then the shared client must notice it too (its breaker may still be open for ≤ 3 s)
                var nsw = Stopwatch.StartNew();
                while (newCompositor >= 0 && client.PlayerPid != newCompositor && nsw.ElapsedMilliseconds < 4000)
                {
                    try { client.Call("hello", null, 300); } catch (LiascapePlayerException) { }
                    if (client.PlayerPid != newCompositor) Thread.Sleep(50);
                }
                if (newCompositor < 0) fails.Add($"killing the compositor (pid {deadCompositor}) did not yield a new hello.pid within 1.5 s");
                else if (client.PlayerPid != newCompositor) fails.Add($"the shared client never saw the restarted compositor {newCompositor} (still {client.PlayerPid})");
                else if (client.SupervisorPid != priorSupervisor) fails.Add($"after the supervised restart, supervisor_pid {client.SupervisorPid} != {priorSupervisor} (expected the SAME supervisor)");

                // OnRestarted must have queued a reapply of the backend's current effective settings.
                if (newCompositor >= 0)
                {
                    LiascapePlayerMedia.Drain().Wait(2000);
                    if (LiascapePlayerMedia.ReapplyCount <= reapplyBeforeRestart) fails.Add("R81: no settings reapply after the supervised restart (OnRestarted)");
                    else Phase($"R81: supervised restart triggered a reapply ({LiascapePlayerMedia.ReapplyCount}x so far)");
                    var pausedAfter = client.Call("get", new Dictionary<string, object?> { ["path"] = "player.paused" }).GetProperty("value").ValueKind;
                    if (pausedAfter != JsonValueKind.True) fails.Add($"I3: player.paused after the restart + reapply = {pausedAfter}, want true (a pause from another process must survive, never be flipped)");
                    else Phase("I3: a pause set by another process survived the restart + reapply");
                    // and the toggle reads the player's truth: one toggle un-pauses
                    if (!LiascapePlayerMedia.TogglePause()) fails.Add("I3: TogglePause failed after the restart");
                    var pausedToggled = client.Call("get", new Dictionary<string, object?> { ["path"] = "player.paused" }).GetProperty("value").ValueKind;
                    if (pausedToggled != JsonValueKind.False) fails.Add($"I3: one TogglePause after the restart left player.paused = {pausedToggled}, want false");
                }

                // QuitOrKill afterwards must leave NO liascape-player process — neither the (new) compositor
                // nor the supervisor (the old adapter bug: signalling the compositor pid alone while its
                // supervisor lived just made the supervisor restart it again).
                LiascapePlayerMedia.Drain().Wait(3000);
                client.QuitOrKill();
                bool compositorAlive = StillRunning(newCompositor >= 0 ? newCompositor : deadCompositor);
                bool supervisorAlive = StillRunning(priorSupervisor);
                if (compositorAlive || supervisorAlive) fails.Add($"QuitOrKill left a process alive (compositor={compositorAlive}, supervisor={supervisorAlive})");
                else Phase("QuitOrKill left no liascape-player process (compositor and supervisor both gone)");
            }
            finally
            {
                stop.Cancel(); stepping.Set();
                try { pump.Wait(3000); } catch { }
            }
        }
        finally
        {
            try { if (serve is { HasExited: false }) new LiascapePlayerClient(sock) { AutoSpawn = false }.Call("quit", null, 2000); } catch { }
            try { if (serve is { HasExited: false } && !serve.WaitForExit(3000)) serve.Kill(true); } catch { }
            LiascapePlayerClient.ResetShared();
            try { Directory.Delete(tmp, true); } catch { }
        }
    }

    [System.Runtime.InteropServices.DllImport("libc")] private static extern int kill(int pid, int sig);

    // ---- in-place upgrade: the same build through a symlink + a wrapProgram wrapper ---------------------------------
    // The Nix layout: `liascape/libexec/liascape/liascape-player` (what the launcher's LIASCAPE_PLAYER_BIN names) is a
    // symlink into ANOTHER store path, `liascape-player/bin/liascape-player`, a wrapProgram script that execs its sibling
    // `.liascape-player-wrapped` — the running process's exe. Compared by the symlink's own store root, the player the
    // restore just started would read as "out of date" and be restarted at once. Built here as pkg-a/pkg-b in a temp dir
    // (a running process whose exe is pkg-b's `.liascape-player-wrapped`, started through pkg-a's symlink), plus the
    // real installed store paths when they exist.
    private static void StaleThroughWrapperAssertions(List<string> fails)
    {
        string? sleep = null;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(':'))
            if (dir.Length > 0 && File.Exists(Path.Combine(dir, "sleep"))) { sleep = Path.Combine(dir, "sleep"); break; }
        if (sleep == null) { fails.Add("stale: no `sleep` on PATH to stand in for a player"); return; }
        sleep = new FileInfo(sleep).ResolveLinkTarget(true)?.FullName ?? sleep; // coreutils may be a multi-call binary
        var tmp = Path.Combine(Path.GetTempPath(), $"lsp-stale-{Environment.ProcessId}");
        Process? p = null;
        try
        {
            var old = DateTime.UtcNow.AddHours(-1); // settled builds (a copy < 2 s old is never compared)
            string Wrapped(string pkg)
            {
                var bin = Path.Combine(tmp, pkg, "bin");
                Directory.CreateDirectory(bin);
                var wrapped = Path.Combine(bin, ".liascape-player-wrapped");
                File.Copy(sleep, wrapped, true);
                File.SetUnixFileMode(wrapped, (UnixFileMode)0b111_101_101); // a store copy is read-only
                File.WriteAllText(Path.Combine(bin, "liascape-player"), $"#!/bin/sh\nexec -a sleep '{wrapped}' \"$@\"\n");
                File.SetUnixFileMode(Path.Combine(bin, "liascape-player"), (UnixFileMode)0b111_101_101);
                File.SetLastWriteTimeUtc(wrapped, old);
                File.SetLastWriteTimeUtc(Path.Combine(bin, "liascape-player"), old);
                return Path.Combine(bin, "liascape-player");
            }
            var wrapperB = Wrapped("pkg-b");
            var libexec = Path.Combine(tmp, "pkg-a", "libexec", "liascape");
            Directory.CreateDirectory(libexec);
            var link = Path.Combine(libexec, "liascape-player");
            File.CreateSymbolicLink(link, wrapperB);
            // a different build: pkg-c's wrapped binary is one byte longer
            var wrapperC = Wrapped("pkg-c");
            var wrappedC = Path.Combine(tmp, "pkg-c", "bin", ".liascape-player-wrapped");
            File.AppendAllText(wrappedC, "x");
            File.SetLastWriteTimeUtc(wrappedC, old);
            // a different build with no wrapper (the dev tree's plain binary)
            var plainD = Path.Combine(tmp, "pkg-d", "liascape-player");
            Directory.CreateDirectory(Path.GetDirectoryName(plainD)!);
            File.Copy(wrappedC, plainD, true);
            File.SetUnixFileMode(plainD, (UnixFileMode)0b111_101_101);
            File.SetLastWriteTimeUtc(plainD, old);

            var psi = new ProcessStartInfo(link) { UseShellExecute = false };
            psi.ArgumentList.Add("30");
            p = Process.Start(psi)!;
            string? exe = null;
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < 3000)
            {
                try { exe = new FileInfo($"/proc/{p.Id}/exe").LinkTarget; } catch { }
                if (exe != null && Path.GetFileName(exe) == ".liascape-player-wrapped") break;
                Thread.Sleep(20);
            }
            if (exe == null || Path.GetFileName(exe) != ".liascape-player-wrapped") { fails.Add($"stale: the wrapper never exec'ed its wrapped binary (exe {exe})"); return; }
            // the round trip's "QuitOrKill left no process" reads liveness the same way: a wrapped player must count
            if (!StillRunning(p.Id)) fails.Add("StillRunning: a live `.liascape-player-wrapped` process reads as gone (QuitOrKill's check would pass vacuously)");
            foreach (var (bin, what) in new[] { (link, "the libexec symlink"), (wrapperB, "the wrapper"), (Path.Combine(tmp, "pkg-b", "bin", ".liascape-player-wrapped"), "the wrapped binary") })
                if (LiascapePlayerClient.StaleReasonFor(p.Id, bin) is string why)
                    fails.Add($"stale: the player started through {what} reads as out of date: {why}");
            if (LiascapePlayerClient.StaleReasonFor(p.Id, wrapperC) == null)
                fails.Add("stale: a different build behind another wrapper reads as current");
            if (LiascapePlayerClient.StaleReasonFor(p.Id, plainD) == null)
                fails.Add("stale: a different plain binary reads as current");

            // the real installed layout (liascape-0.1.0's libexec symlink → liascape-player-0.1.0's wrapper,
            // the process running its `.liascape-player-wrapped`) — only where such a store path exists
            if (Directory.Exists("/nix/store"))
                foreach (var pkg in Directory.EnumerateDirectories("/nix/store", "*-liascape-0.1.0").Take(8))
                {
                    var nixLink = Path.Combine(pkg, "libexec", "liascape", "liascape-player");
                    var target = File.Exists(nixLink) ? new FileInfo(nixLink).ResolveLinkTarget(true)?.FullName : null;
                    if (target == null) continue;
                    var nixWrapped = Path.Combine(Path.GetDirectoryName(target)!, ".liascape-player-wrapped");
                    if (!File.Exists(nixWrapped)) continue;
                    if (LiascapePlayerClient.StaleReasonFor(nixWrapped, nixWrapped, nixLink) is string why)
                        fails.Add($"stale: {nixLink}'s own player reads as out of date: {why}");
                }
        }
        catch (Exception e) { fails.Add($"stale: {e.GetType().Name}: {e.Message}"); }
        finally
        {
            try { p?.Kill(); p?.WaitForExit(2000); } catch { }
            try { Directory.Delete(tmp, true); } catch { }
        }
    }

    // ---- a player that is still starting is waited for, never "stalled" (a cold boot) ----------------------------
    // The player binds its socket first, then starts (PipeWire bus ≤ 500 ms, EGL, CUDA…) and answers ~1 s later. A
    // request from another process in that window (the app opening during a restore, its `IsPlaying` a 300 ms `get`) must
    // not time out its greeting `hello` and open the stall breaker (the `get` itself sent and timing out again), which
    // fails every request fast for 3 s. A fake player here binds and answers only 1 s later.
    private sealed class SlowStartPlayer : IDisposable
    {
        private readonly Socket _l;
        private readonly long _answerAt;
        public volatile bool Stalled;
        public string Path { get; }
        public SlowStartPlayer(string path, int answerAfterMs)
        {
            Path = path;
            _l = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            _l.Bind(new UnixDomainSocketEndPoint(path));
            _l.Listen(16);
            _answerAt = Environment.TickCount64 + answerAfterMs;
            new Thread(() =>
            {
                while (true)
                {
                    Socket c;
                    try { c = _l.Accept(); } catch { return; }
                    new Thread(() => Serve(c)) { IsBackground = true }.Start();
                }
            }) { IsBackground = true }.Start();
        }
        private void Serve(Socket c)
        {
            try
            {
                using var ns = new NetworkStream(c, ownsSocket: true);
                using var rd = new StreamReader(ns);
                string? line;
                while ((line = rd.ReadLine()) != null)
                {
                    var wait = _answerAt - Environment.TickCount64;
                    if (wait > 0) Thread.Sleep((int)wait);
                    while (Stalled) Thread.Sleep(10);
                    using var doc = JsonDocument.Parse(line);
                    var id = doc.RootElement.GetProperty("id").GetInt64();
                    var cmd = doc.RootElement.GetProperty("cmd").GetString();
                    var result = cmd == "hello" ? $"{{\"pid\":{Environment.ProcessId},\"capabilities\":[]}}" : "{\"value\":\"/x.mp4\"}";
                    var reply = System.Text.Encoding.UTF8.GetBytes($"{{\"id\":{id},\"ok\":true,\"result\":{result}}}\n");
                    ns.Write(reply);
                }
            }
            catch { }
        }
        public void Dispose() { try { _l.Dispose(); } catch { } try { File.Delete(Path); } catch { } }
    }

    private static void StartupGraceAssertions(List<string> fails)
    {
        var tmp = Path.Combine("/tmp", $"lsp-grace-{Environment.ProcessId}");
        Directory.CreateDirectory(tmp);
        try
        {
            var get = new Dictionary<string, object?> { ["path"] = "cur:*.path" };
            // 1. a quick query from a client (process) that never talked to this player, sent the moment its socket
            //    exists, while a second thread of the same client asks too: both wait for its first answer
            using (var fake = new SlowStartPlayer(Path.Combine(tmp, "a.sock"), 1000))
            {
                var client = new LiascapePlayerClient(fake.Path) { AutoSpawn = false };
                string? err1 = null, err2 = null;
                var sw = Stopwatch.StartNew();
                var t2 = new Thread(() =>
                {
                    Thread.Sleep(50);
                    try { client.Call("hello", null, LiascapePlayerClient.QuickMs); } catch (LiascapePlayerException e) { err2 = e.ToString(); }
                });
                t2.Start();
                try { client.Call("get", get, LiascapePlayerClient.QuickMs); } catch (LiascapePlayerException e) { err1 = e.ToString(); }
                t2.Join(10_000);
                if (err1 != null) fails.Add($"startup: a quick `get` to a starting player failed after {sw.ElapsedMilliseconds} ms: {err1}");
                if (err2 != null) fails.Add($"startup: a parallel quick `hello` to a starting player failed: {err2}");
                if (client.IsStalled) fails.Add("startup: a starting player opened the stall breaker");
                // 2. the breaker still guards a RUNNING player that stalls: one QuickMs timeout, then fail-fast
                fake.Stalled = true;
                sw.Restart();
                try { client.Call("get", get, LiascapePlayerClient.QuickMs); fails.Add("startup: a stalled running player answered?"); }
                catch (LiascapePlayerException) { }
                if (sw.ElapsedMilliseconds > 450) fails.Add($"startup: a stalled running player took {sw.ElapsedMilliseconds} ms to fail (QuickMs = {LiascapePlayerClient.QuickMs}; the startup grace must not apply to a player that answered)");
                if (!client.IsStalled) fails.Add("startup: a stalled running player did not open the stall breaker");
                fake.Stalled = false;
            }
            // 3. a request while THIS process is starting the player (EnsureRunning's spawn, the socket not bound yet)
            //    waits for the socket instead of failing with "no player"
            {
                var sock = Path.Combine(tmp, "b.sock");
                var client = new LiascapePlayerClient(sock) { AutoSpawn = false };
                client.BeginStarting(5000);
                SlowStartPlayer? fake = null;
                var binder = new Thread(() => { Thread.Sleep(300); fake = new SlowStartPlayer(sock, 700); });
                binder.Start();
                var sw = Stopwatch.StartNew();
                try { client.Call("get", get, LiascapePlayerClient.QuickMs); }
                catch (LiascapePlayerException e) { fails.Add($"startup: a quick `get` while this process starts the player failed after {sw.ElapsedMilliseconds} ms: {e}"); }
                client.EndStarting();
                binder.Join();
                fake?.Dispose();
            }
        }
        catch (Exception e) { fails.Add($"startup: {e.GetType().Name}: {e.Message}"); }
        finally { try { Directory.Delete(tmp, true); } catch { } }
    }

    // Is `pid` (still) a liascape-player process — the plain binary or a Nix `.liascape-player-wrapped`? By
    // `/proc/<pid>/exe`'s link target, never a cmdline substring: the client's own check.
    private static bool StillRunning(int pid) => LiascapePlayerClient.IsPlayerProcess(pid);

    // ---- binary resolution: a binary removed since it was found is looked for again ----------------------------------
    // A cached path whose file is gone let MissingReason pass and a switch queue a start that couldn't happen.
    private static void BinaryResolutionAssertions(List<string> fails)
    {
        var env = Environment.GetEnvironmentVariable("LIASCAPE_PLAYER_BIN");
        var tmp = Path.Combine(Path.GetTempPath(), $"lsp-bin-{Environment.ProcessId}");
        try
        {
            Directory.CreateDirectory(tmp);
            var bin = Path.Combine(tmp, "liascape-player");
            File.WriteAllText(bin, "#!/bin/sh\nexit 1\n");
            Environment.SetEnvironmentVariable("LIASCAPE_PLAYER_BIN", bin);
            if (PlayerStatus.ResolveBinary(fresh: true) != bin) fails.Add($"binary resolution: LIASCAPE_PLAYER_BIN={bin} not found ({PlayerStatus.ResolveBinary()})");
            else if (PlayerStatus.ResolveBinary() != bin) fails.Add("binary resolution: the binary found isn't kept while it's there");
            File.Delete(bin);
            if (PlayerStatus.ResolveBinary() == bin) fails.Add("binary resolution: a binary removed since it was found still resolves (the cached path)");
        }
        catch (Exception e) { fails.Add($"binary resolution: {e.GetType().Name}: {e.Message}"); }
        finally
        {
            Environment.SetEnvironmentVariable("LIASCAPE_PLAYER_BIN", env);
            PlayerStatus.ResolveBinary(fresh: true);
            try { Directory.Delete(tmp, true); } catch { }
        }
    }

    // A synthetic scene item folder (what liascape-player's tests/common::synthetic_scene writes): plays the
    // worker's synthetic renderer only when the player runs with LIASCAPE_PLAYER_ALLOW_SYNTHETIC_SCENES=1.
    internal static void SyntheticScene(string dir, string spec = "{\"pattern\":\"solid\",\"rgb\":[0,128,255],\"native\":[640,360]}")
    {
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "project.json"), "{\"type\":\"scene\",\"title\":\"synthetic\",\"file\":\"scene.json\",\"preview\":\"preview.png\"}");
        File.WriteAllBytes(Path.Combine(dir, "scene.pkg"), new byte[16]);
        File.WriteAllText(Path.Combine(dir, "liascape-synthetic.json"), spec);
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
