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
            PlayLimitAssertions(fails);
            ProgramSpecAssertions(fails);
            OutboxAckAssertions(fails);
            StaleThroughWrapperAssertions(fails);
            StartupGraceAssertions(fails);
            if (fails.Count == 0) QueueDepthAssertions(fails);
            if (fails.Count == 0) RoundTrip(fails);
        }
        catch (Exception e) { fails.Add($"{e.GetType().Name}: {e.Message}"); }
        if (fails.Count == 0) { Console.WriteLine("PASS"); return 0; }
        Console.WriteLine("FAIL " + string.Join("; ", fails));
        return 1;
    }

    // ---- Phase 3 Task 9: what a live ack may cover: only an unbroken run of handled seqs after the last ack ------------
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

    // ---- Phase 3 Task 7: a rotation session → the player's program spec (LiascapePlayerProgram.BuildSpec) -------------
    private static void ProgramSpecAssertions(List<string> fails)
    {
        var dir = Path.Combine(Path.GetTempPath(), $"lia-selftest-prog-{Environment.ProcessId}"); // never created: no file is read
        {
            string a = Path.Combine(dir, "a.mp4"), b = Path.Combine(dir, "b.mp4"), img = Path.Combine(dir, "c.png");
            var g = new AppSettings
            {
                AllowScenes = false, Volume = 50, Speed = 1.5, NoAudio = false, Loop = true, TransitionMethod = "frozen",
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

    // ---- the rotation: advance-on-end's minimum (= the interval field) / maximum (PlayerHelper § Rotation) ---------------
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
        // the limits a rotation acts on: under advance-on-end the interval IS the minimum; off, the interval is the
        // timer and neither limit applies
        foreach (var (iv, adv, max, want) in new[] { (30, true, 600, (30, 600)), (0, true, 0, (0, 0)), (30, false, 600, (0, 0)),
                                                     (20, true, 2, (20, 2)), (-4, true, 400000, (0, 359999)) })
            if (PlayerHelper.PlayLimits(iv, adv, max) != want) fails.Add($"PlayLimits(interval {iv}, advance {adv}, max {max}) = {PlayerHelper.PlayLimits(iv, adv, max)}, want {want}");
        // the defaults (2026-10-28, "0 = off unless set"): a video plays to its end however long — no minimum, no
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
        // the maximum is clamped 0…359999 (negative = off)
        foreach (var (v, want) in new[] { (-5, 0), (0, 0), (90, 90), (359999, 359999), (400000, 359999) })
        {
            var s = new AppSettings { GlobalMaxPlaySeconds = v }; var p = new PlaylistSettings { MaxPlaySeconds = v };
            if (s.GlobalMaxPlaySeconds != want || p.MaxPlaySeconds != want) fails.Add($"max play time {v} → {s.GlobalMaxPlaySeconds}/{p.MaxPlaySeconds}, want {want}");
            var s2 = new AppSettings { GlobalSwitchScenesAfterSeconds = v }; var p2 = new PlaylistSettings { SwitchScenesAfterSeconds = v };
            if (s2.GlobalSwitchScenesAfterSeconds != want || p2.SwitchScenesAfterSeconds != want)
                fails.Add($"switch scenes after {v} → {s2.GlobalSwitchScenesAfterSeconds}/{p2.SwitchScenesAfterSeconds}, want {want}");
        }
        // what each kind of item plays under advance-on-end: (minimum — for an item that never ends, reaching it IS its
        // end; NeverMs = it stays —, maximum — 0 = none). 0 = off everywhere. A video: always the minimum / maximum (0/0 →
        // its end, however short or long). Separate timing for scenes OFF: a scene's end = the minimum (none → only the
        // maximum moves it, else it stays), a still image shows for the minimum (0 → it flashes by) — the old rules.
        // ON: a scene AND a still image switch after "Switch scenes after" (0 → they stay), the minimum / maximum don't
        // apply to them.
        const long N = PlayerHelper.NeverMs;
        foreach (var (kind, min, max, sep, after, want) in new (PlayerHelper.PlayKind, long, long, bool, long, (long, long))[] {
                 (PlayerHelper.PlayKind.Video, 0, 0, false, 0, (0, 0)),          // 0/0: a video switches at its end, whatever its length
                 (PlayerHelper.PlayKind.Video, 5000, 9000, false, 3000, (5000, 9000)),
                 (PlayerHelper.PlayKind.Video, 5000, 9000, true, 3000, (5000, 9000)),  // the scene timing never touches a video
                 (PlayerHelper.PlayKind.Video, 0, 0, true, 3000, (0, 0)),
                 (PlayerHelper.PlayKind.Image, 0, 0, false, 3000, (0, 0)),       // toggle off: the minimum (0 → it flashes by)
                 (PlayerHelper.PlayKind.Image, 4000, 9000, false, 3000, (4000, 9000)),
                 (PlayerHelper.PlayKind.Image, 4000, 9000, true, 3000, (3000, 0)),  // toggle on: its own time, no maximum
                 (PlayerHelper.PlayKind.Image, 0, 0, true, 0, (N, 0)),           // …0 = off → it stays
                 (PlayerHelper.PlayKind.Scene, 4000, 9000, false, 3000, (4000, 9000)),
                 (PlayerHelper.PlayKind.Scene, 0, 9000, false, 3000, (N, 9000)), // no minimum → only the maximum moves it
                 (PlayerHelper.PlayKind.Scene, 0, 0, false, 3000, (N, 0)),       // neither → it stays
                 (PlayerHelper.PlayKind.Scene, 4000, 2000, true, 3000, (3000, 0)),
                 (PlayerHelper.PlayKind.Scene, 4000, 2000, true, 0, (N, 0)) })
        {
            var got = PlayerHelper.ItemPlayRule(kind, min, max, sep, after);
            if (got != want) fails.Add($"ItemPlayRule({kind}, min {min}, max {max}, separate {sep}, scenes after {after}) = {got}, want {want}");
        }
        foreach (var (path, want) in new[] { ("/x/a.mp4", PlayerHelper.PlayKind.Video), ("/x/a.PNG", PlayerHelper.PlayKind.Image),
                                             ("/x/b.webp", PlayerHelper.PlayKind.Image), ("/lib/workshop/900000001", PlayerHelper.PlayKind.Scene) })
            if (PlayerHelper.PlayKindOf(path) != want) fails.Add($"PlayKindOf({path}) = {PlayerHelper.PlayKindOf(path)}, want {want}");
        // NeverMs never reached, never overflows the hold's arithmetic
        if (PlayerHelper.SceneMinReached(true, true, true, 359999_000L, N) || PlayerHelper.MinPlayReached(359999_000L, 12_000, N))
            fails.Add("NeverMs was reached");
        // a scene (it never ends) moves on at the minimum under advance-on-end; no minimum → never by it
        foreach (var (adv, rot, scene, played, min, want) in new[] {
                 (true, true, true, 3000L, 3000L, true), (true, true, true, 2999L, 3000L, false), (true, true, true, 9000L, 0L, false),
                 (false, true, true, 9000L, 3000L, false), (true, false, true, 9000L, 3000L, false), (true, true, false, 9000L, 3000L, false) })
            if (PlayerHelper.SceneMinReached(adv, rot, scene, played, min) != want) fails.Add($"SceneMinReached(advance {adv}, rotates {rot}, scene {scene}, played {played}, min {min}) != {want}");
        // the minimum is reached by the loop playing now: played + its remaining (+150 ms tolerance)
        foreach (var (played, rem, min, want) in new (long, long?, long, bool)[] {
                 (0, 2000, 0, true),          // off
                 (0, 2000, 5000, false),      // a 2 s clip's 1st loop ends at 2 s
                 (2000, 2000, 5000, false),   // 2nd loop: ends at 4 s
                 (4000, 2000, 5000, true),    // 3rd loop: ends at 6 s ≥ 5 s → arm now, for its end
                 (1900, 3000, 5000, true),    // within the tolerance (4.9 + 0.15)
                 (1800, 3000, 5000, false),
                 (0, 12000, 5000, true),      // a long clip: its 1st loop already reaches it (no hold)
                 (2900, null, 3000, true),    // no end known (an image): the play time alone, + tolerance
                 (2000, null, 3000, false),
                 (100, -50, 200, true) })      // a negative remainder counts as 0
            if (PlayerHelper.MinPlayReached(played, rem, min) != want) fails.Add($"MinPlayReached(played {played}, loop left {rem?.ToString() ?? "null"}, min {min}) != {want}");
        // the maximum: only under advance-on-end, never for a one-item session, 0 = off
        foreach (var (adv, rot, played, max, want) in new[] {
                 (true, true, 3000L, 3000L, true), (true, true, 2999L, 3000L, false), (false, true, 9000L, 3000L, false),
                 (true, false, 9000L, 3000L, false), (true, true, 9000L, 0L, false) })
            if (PlayerHelper.MaxPlayReached(adv, rot, played, max) != want) fails.Add($"MaxPlayReached(advance {adv}, rotates {rot}, played {played}, max {max}) != {want}");
        // the play time loaded from timed_state: + the time since its save (the player played on), unless paused
        foreach (var (saved, at, paused, now, want) in new[] {
                 (2000L, 10_000L, false, 13_000L, 5000L), (2000L, 10_000L, true, 13_000L, 2000L),
                 (2000L, 0L, false, 13_000L, 2000L),     // an older state file: no save time
                 (2000L, 14_000L, false, 13_000L, 2000L), // a clock step back: never negative
                 (-7L, 10_000L, false, 10_000L, 0L) })
            if (PlayerHelper.PlayedAfterLoad(saved, at, paused, now) != want) fails.Add($"PlayedAfterLoad({saved}, saved at {at}, paused {paused}, now {now}) = {PlayerHelper.PlayedAfterLoad(saved, at, paused, now)}, want {want}");
    }

    // ---- /health/features (FeatureHealth.Build): every missing piece → its feature not ok, with a reason ----------
    private static void FeatureHealthAssertions(List<string> fails)
    {
        using var good = JsonDocument.Parse("""{"effects":{"ok":true,"reason":null},"vram":{"ok":true,"reason":null},"hwdec_interop":{"ok":true,"reason":null},"scenes":{"ok":true,"reason":null}}""");
        using var bad = JsonDocument.Parse("""{"effects":{"ok":false,"reason":"no catalogue"},"vram":{"ok":false,"reason":"no VRAM measurement here"},"hwdec_interop":{"ok":null,"reason":null}}""");
        FeatureHealth.Feature F(List<FeatureHealth.Feature> l, string id) => l.FirstOrDefault(x => x.id == id) ?? new(id, id, null, "MISSING FEATURE", []);
        var all = FeatureHealth.Build(new(true, null, good.RootElement, (true, null), _ => true, true, false));
        foreach (var x in all) if (x.ok != true) fails.Add($"health (everything present): {x.id} ok={x.ok} ({x.reason})");
        var none = FeatureHealth.Build(new(true, null, bad.RootElement, (false, "liascape-scene-worker not found"), t => t is not ("pactl" or "playerctl" or "ffprobe"), false, false));
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
        Want("auto-mute", false, "pactl", "autoMute");
        Want("mpris", false, "playerctl", "autoMuteOnlyIfMprisActive");
        Want("ffmpeg", false, "ffprobe", "normalizeAudio");
        Want("steamcmd", false, "steamcmd", "workshopDownloadMode");
        if ((F(none, "auto-mute").reason ?? "").Contains("parec")) fails.Add("health: auto-mute names parec, which is present");
        var noBin = FeatureHealth.Build(new(true, "liascape-player not found", null, (false, "liascape-player not found"), _ => true, true, false));
        if (F(noBin, "liascape-player").ok != false || noBin.Any(x => x.id == "vram")) fails.Add("health: a missing liascape-player → its feature false, no player-side features");
        var d = new AppSettings();
        foreach (var (id, want) in new[] { ("steamcmd", false), ("auto-mute", false), ("mpris", false), ("scenes", false), ("ffmpeg", true), ("vram", true), ("hwdec-interop", true) })
            if (FeatureHealth.InUse(id, d) != want) fails.Add($"health: InUse({id}) with the defaults = {!want}, want {want}");
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

    // ---- R69: auto-mute excludes liascape-player's OWN streams (by ownership, not just by name) ------
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
        // Phase 2: a scene worker's own stream (its own process, its own app name here) — by node name
        Own("scene worker stream", Block("x", "1", "liascape-player-scene.src4", "12"), true);
        Own("another app", Block("Firefox", "1", "Firefox", "12"), false);
    }

    // ---- Phase 2 Task 11: scenes under liascape-player (pure decisions + a scene's create props) ------
    private static void SceneAdapterAssertions(List<string> fails)
    {
        // Task 8: AppSettings → the player's GPU / VRAM props (the limit is 0 = off while its toggle is off)
        string G(AppSettings s) => string.Join(" ", LiascapePlayerMedia.GpuProps(s).Select(p => $"{p.prop}={p.value}"));
        foreach (var (s, want) in new (AppSettings, string)[] {
            (new AppSettings(), "scene_throttle=True scene_vram_limit_mib=0 vram_low_mode=stop"),
            (new AppSettings { AutoThrottleScenes = false, LimitVramPerScene = true, SceneVramLimitMib = 1536, VramLowMode = "pause" }, "scene_throttle=False scene_vram_limit_mib=1536 vram_low_mode=pause"),
            (new AppSettings { SceneVramLimitMib = 2048, VramLowMode = "bogus" }, "scene_throttle=True scene_vram_limit_mib=0 vram_low_mode=stop"),
            (new AppSettings { LimitVramPerScene = true, SceneVramLimitMib = 1, VramLowMode = "off" }, "scene_throttle=True scene_vram_limit_mib=64 vram_low_mode=off") })
            if (G(s) != want) fails.Add($"GpuProps → {G(s)}, want {want}");
        // ScenesPlayable: AllowScenes × engine × (liascape-player: the player's `scene` capability | legacy: LWE)
        foreach (var allow in new[] { false, true })
        foreach (var onPlayer in new[] { false, true })
        foreach (var cap in new[] { false, true })
        foreach (var lwe in new[] { false, true })
        {
            bool want = allow && (onPlayer ? cap : lwe);
            bool got = PlayerEngine.ScenesPlayableFor(allow, onPlayer, () => cap, () => lwe);
            if (got != want) fails.Add($"ScenesPlayable(AllowScenes={allow}, liascape-player={onPlayer}, scene capability={cap}, LWE={lwe}) = {got}, want {want}");
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
        }
        finally { try { Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(dir))!, true); } catch { } }
        SceneLoudnessAssertions(fails);
    }

    // Scene loudness learned on first play (`scene.loudness` → LibMeta → `gain.normalize`): what's stored when, and
    // the gain the resolver gives a scene.
    private static void SceneLoudnessAssertions(List<string> fails)
    {
        // MergeSceneLoudness (refined across plays, 2026-10-28; per audio configuration, 2026-10-29): the report covering
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

        // values: Coerce (UI → WE encoding), ToPlayer (→ scene_props), ToCli (→ LWE --set-property)
        void Co(string n, string json, string? want, string? player = null, string? cli = null)
        {
            var p = P(n)!;
            var (v, err) = SceneProperties.Coerce(p, JsonDocument.Parse(json).RootElement);
            var got = err != null ? null : v?.ToJsonString();
            if (got != want) { fails.Add($"Coerce({n}, {json}) = {got ?? "error: " + err}, want {want ?? "an error"}"); return; }
            if (v == null) return;
            var pl = JsonSerializer.Serialize(SceneProperties.ToPlayer(p, v));
            if (player != null && pl != player) fails.Add($"ToPlayer({n}, {got}) = {pl}, want {player}");
            var c = SceneProperties.ToCli(p, v);
            if (cli != null && c != cli) fails.Add($"ToCli({n}, {got}) = {c}, want {cli}");
        }
        Co("clock", "false", "false", "false", "false");
        Co("clock", "\"1\"", "true", "true", "true");
        Co("clock", "\"maybe\"", null);
        Co("bars", "70", "64", "64", "64");            // clamped to max
        Co("bars", "20.6", "21", "21", "21");          // fraction false → whole
        Co("opacity", "\"0.5\"", "0.5", "0.5", "0.5");
        Co("opacity", "\"x\"", null);
        Co("schemecolor", "\"#ff8000\"", "\"1 0.501961 0\"", "[1,0.501961,0]", "1 0.501961 0");
        Co("schemecolor", "[0, 1, 0]", "\"0 1 0\"", "[0,1,0]", "0 1 0");
        Co("schemecolor", "\"0 128 255\"", "\"0 0.501961 1\"");
        Co("schemecolor", "\"red\"", null);
        Co("style", "1", "\"1\"", "\"1\"", "1");
        Co("style", "\"x\"", "\"x\"", "\"x\"", "x");
        Co("style", "\"3\"", null);
        Co("name", "\"Ada\"", "\"Ada\"", "\"Ada\"", "Ada");
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

        // legacy launch args, only for overrides that name an editable property
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
            var cli = string.Join(" ", SceneProperties.CliArgs(dir, ov));
            if (cli != "--set-property schemecolor=0 1 0 --set-property clock=false")
                fails.Add($"CliArgs = \"{cli}\", want \"--set-property schemecolor=0 1 0 --set-property clock=false\"");
            var map = JsonSerializer.Serialize(SceneProperties.PlayerMap(dir, ov));
            if (map != "{\"clock\":false,\"schemecolor\":[0,1,0]}") fails.Add($"PlayerMap = {map}, want {{\"clock\":false,\"schemecolor\":[0,1,0]}}");
            if (JsonSerializer.Serialize(SceneProperties.PlayerDefault(dir, "schemecolor")) != "[0.5,0.25,1]") fails.Add("PlayerDefault(schemecolor) wrong");
        }
        finally { try { Directory.Delete(dir, true); } catch { } }

        // the real corpus (read-only; skipped without it) — never the steamcmd cache
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

    // ---- Task 20c: next/prev/random's scene-skip decision point ------------------------------
    // TryStepLibrary/ApplyRandom/AdvanceToNext (PlayerHelper) skip a path exactly when
    // `IsScenePath(path) && !PlayerEngine.ScenesPlayable(settings)` — the same formula the
    // private IsSkippedPath uses, reused here rather than invented (.claude/rules/player.md /
    // player-adapter.md: "skipped exactly like AllowScenes=false"). Needs no player, no
    // mpvpaper, no `serve` — pure decision logic, so this also covers the "legacy engine
    // check that scenes are still reachable when AllowScenes=true" requirement without needing
    // linux-wallpaperengine installed on the test box (it stops at the decision point when LWE
    // isn't on PATH here — documented below, same allowance task-20c gives the IT script).
    private static void SceneSkipAssertions(List<string> fails)
    {
        const string scenePath = "/tmp/liascape-selftest-lib/workshop/123";   // no extension → a scene
        const string videoPath = "/tmp/liascape-selftest-lib/imported/v1/v1.mp4";

        if (!PlayerHelper.IsScenePath(scenePath)) fails.Add("IsScenePath(workshop dir) should be true");
        if (PlayerHelper.IsScenePath(videoPath)) fails.Add("IsScenePath(.mp4) should be false");

        static bool WouldSkip(string path, AppSettings s) =>
            PlayerHelper.IsScenePath(path) && !PlayerEngine.ScenesPlayable(s);

        try
        {
            // liascape-player (Phase 2): playable exactly when the player has the `scene` capability — the
            // capability half is SceneAdapterAssertions' truth table (pure: asking the shared client
            // here would greet whatever player owns the default socket)
            static bool LiascapeSkip(string path, bool cap) =>
                PlayerHelper.IsScenePath(path) && !PlayerEngine.ScenesPlayableFor(true, true, () => cap, () => false);
            if (!LiascapeSkip(scenePath, cap: false)) fails.Add("liascape-player without the scene capability should skip a scene");
            if (LiascapeSkip(scenePath, cap: true)) fails.Add("liascape-player with the scene capability + AllowScenes should play a scene");
            if (LiascapeSkip(videoPath, cap: false)) fails.Add("liascape-player should never skip a video");

            var legacyOff = new AppSettings { PlayerEngine = PlayerEngine.Legacy, AllowScenes = false };
            PlayerEngine.Refresh(legacyOff);
            if (!WouldSkip(scenePath, legacyOff))
                fails.Add("legacy + AllowScenes=false should still skip a scene (unchanged contract)");

            // legacy + AllowScenes=true: ACTUALLY reaching a scene additionally needs
            // linux-wallpaperengine on PATH (ScenesPlayable → PlayerHelper.IsLweAvailable, a real
            // `which`) — orthogonal to this fix and not faked here. What this proves without it:
            // the skip formula has no liascape-player-only special case — it's driven purely by
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
    }

    // ---- protocol round-trip -----------------------------------------------------------------
    private static void RoundTrip(List<string> fails)
    {
        var bin = PlayerEngine.ResolveBinary();
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
            // Phase 2: the capabilities `hello` lists (this private player allows synthetic scenes, so it
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
                var s = new AppSettings { Loop = true, NoAudio = false, Volume = 100 };

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
                    bool ok = LiascapePlayerMedia.SwitchAndWaitHandoff(a, s, cfg, alignEnd: false, to.Token).GetAwaiter().GetResult();
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
                // dropped at the cap (RED before: sets past 256 were refused, the last one included).
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
                // The map is cached until the graph changes (RED before: 2 requests per value).
                LiascapePlayerMedia.Preview(30, null, [a]); LiascapePlayerMedia.Drain().Wait(2000); // may (re)read the map once
                long req0 = client.RequestCount; int reads0 = LiascapePlayerMedia.SourceMapReads;
                const int nPrev = 20;
                for (int i = 0; i < nPrev; i++) { LiascapePlayerMedia.Preview(31 + i, null, [a]); LiascapePlayerMedia.Drain().Wait(2000); }
                double perPreview = (client.RequestCount - req0) / (double)nPrev;
                var guPrev = client.Call("get", new Dictionary<string, object?> { ["path"] = "cur:*.gain.user" }).GetProperty("value").GetDouble();
                if (perPreview > 1.05) fails.Add($"/preview costs {perPreview:0.##} requests per value (want 1: one `set` on the cached source; map reads {LiascapePlayerMedia.SourceMapReads - reads0})");
                if (Math.Abs(guPrev - MpvPropertyMap.VolumeDb(50)) > 1e-3) fails.Add($"/preview's last value didn't land: gain.user {guPrev:0.###}, want {MpvPropertyMap.VolumeDb(50):0.###}");
                Phase($"/preview: {perPreview:0.##} requests per value over {nPrev} (map reads {LiascapePlayerMedia.SourceMapReads - reads0})");

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

                // transitions OFF + video end (the gapless branch): cut at A's end
                using (var to = new CancellationTokenSource(30000))
                {
                    bool ok = LiascapePlayerMedia.SwitchAndWaitHandoff(b, s, null, alignEnd: true, to.Token).GetAwaiter().GetResult();
                    if (!ok) { fails.Add($"clip→clip cut (align end): no transition.handoff (corr {LiascapePlayerMedia.LastCorr})"); return; }
                }
                Phase("clip→clip cut handoff (align end)");
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
                stepping.Reset(); // clock frozen → A never ends → the aligned switch stays pending
                using (var cts = new CancellationTokenSource(400))
                {
                    bool ok = LiascapePlayerMedia.SwitchAndWaitHandoff(a, s, cfg, alignEnd: true, cts.Token).GetAwaiter().GetResult();
                    if (ok) fails.Add("cancelled aligned switch returned true");
                }
                Phase("cancelled aligned switch returned");
                var corr = LiascapePlayerMedia.LastCorr;
                var logs = client.Call("logs", new Dictionary<string, object?> { ["corr"] = corr, ["kind_prefix"] = "transition." });
                bool cancelled = logs.GetProperty("events").EnumerateArray().Any(e => e.GetProperty("kind").GetString() == "transition.cancelled");
                if (!cancelled) fails.Add($"cancel {corr}: no transition.cancelled in its log");
                stepping.Set();
                if (LiascapePlayerMedia.CurrentPath() != b) fails.Add("cancel didn't leave A (b.mp4) on screen");

                // Phase 2 Task 11: a scene folder plays as `kind: scene` (a synthetic one), takes the
                // settings like a video, and the per-monitor scene fps reaches its output live
                var scene = Path.Combine(tmp, "workshop", "900000001");
                SyntheticScene(scene);
                using (var to = new CancellationTokenSource(20000))
                {
                    bool ok = LiascapePlayerMedia.SwitchAndWaitHandoff(scene, s, cfg, alignEnd: false, to.Token).GetAwaiter().GetResult();
                    if (!ok) fails.Add($"clip→scene fade: no transition.handoff (corr {LiascapePlayerMedia.LastCorr})");
                }
                string? Cur(string prop) { try { var v = client.Call("get", new Dictionary<string, object?> { ["path"] = $"cur:*.{prop}" }).GetProperty("value"); return v.ValueKind == JsonValueKind.String ? v.GetString() : v.GetRawText(); } catch (LiascapePlayerException e) { return e.Code; } }
                if (Cur("kind") != "scene" || Cur("ready") != "true" || Cur("preview") != Path.Combine(scene, "preview.png"))
                    fails.Add($"the scene folder plays as kind={Cur("kind")} ready={Cur("ready")} preview={Cur("preview")}, want scene/true/its preview.png");
                else Phase("clip→scene fade: kind scene, ready, preview set");
                LiascapePlayerMedia.ApplySceneFps([], [new SceneMonitor { Name = "VIRTUAL-1", Fps = 45 }]);
                LiascapePlayerMedia.Drain().Wait(2000);
                double Fps() => client.Call("get", new Dictionary<string, object?> { ["path"] = "out:VIRTUAL-1.scene_fps" }).GetProperty("value").GetDouble();
                if (Math.Abs(Fps() - 45) > 1e-6) fails.Add($"ApplySceneFps(VIRTUAL-1 45) → out:VIRTUAL-1.scene_fps {Fps()}, want 45");
                LiascapePlayerMedia.ApplySceneFps([new SceneMonitor { Name = "VIRTUAL-1", Fps = 45 }], []);
                LiascapePlayerMedia.Drain().Wait(2000);
                if (Math.Abs(Fps() - 30) > 1e-6) fails.Add($"removing VIRTUAL-1 from SceneMonitors → scene_fps {Fps()}, want the default 30");
                else Phase("ApplySceneFps: VIRTUAL-1 45 live, back to 30 when removed");
                // Task 8: the GPU / VRAM settings → the player props, live, diffed
                string PlayerProp(string p) { var v = client.Call("get", new Dictionary<string, object?> { ["path"] = $"player.{p}" }).GetProperty("value"); return v.ValueKind == JsonValueKind.String ? v.GetString()! : v.GetRawText(); }
                var g0 = new AppSettings();
                var g1 = new AppSettings { AutoThrottleScenes = false, LimitVramPerScene = true, SceneVramLimitMib = 1536, VramLowMode = "pause" };
                LiascapePlayerMedia.ApplyGpuSettings(g0, g1); LiascapePlayerMedia.Drain().Wait(2000);
                string Gpu() => $"{PlayerProp("scene_throttle")} {PlayerProp("scene_vram_limit_mib")} {PlayerProp("vram_low_mode")}";
                if (Gpu() != "false 1536.0 pause" && Gpu() != "false 1536 pause") fails.Add($"ApplyGpuSettings → {Gpu()}, want false 1536 pause");
                LiascapePlayerMedia.ApplyGpuSettings(g1, g0); LiascapePlayerMedia.Drain().Wait(2000);
                if (Gpu() != "true 0.0 stop" && Gpu() != "true 0 stop") fails.Add($"ApplyGpuSettings back to the defaults → {Gpu()}, want true 0 stop");
                else Phase("ApplyGpuSettings: scene_throttle / scene_vram_limit_mib / vram_low_mode live and back");
                using (var to = new CancellationTokenSource(20000))
                {
                    bool ok = LiascapePlayerMedia.SwitchAndWaitHandoff(b, s, null, alignEnd: false, to.Token).GetAwaiter().GetResult();
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
                // R81: the breaker closing (this is exactly that — the first query above after it
                // reopened) must have fired a reapply, catching up whatever the `volume 80` set during
                // the stall (above) dropped. OnRecovered's Queue(...) is fire-and-forget (by design — it
                // must never block the caller that happened to be the one to notice the recovery), so
                // wait for the chain here before checking/moving on — otherwise this reapply races the
                // NEXT phase's compositor kill below and runs against a player that's already dead again.
                LiascapePlayerMedia.Drain().Wait(2000);
                if (LiascapePlayerMedia.ReapplyCount < 1) fails.Add("R81: no settings reapply after the stall recovered (OnRecovered)");
                else Phase($"R81: stall recovery triggered a reapply ({LiascapePlayerMedia.ReapplyCount}x so far)");

                // I3 (final review): the pause is toggled by ANOTHER process (a keybind's one-shot
                // `liascape toggle-pause` — here a second, independent client): this
                // backend has no memory of it, and must never re-assert one. After the supervised
                // restart below (whose snapshot restores `player.paused`) and its R81 reapply, the
                // pause must still be on — not flipped.
                var other = new LiascapePlayerClient(sock) { AutoSpawn = false };
                other.Call("set", new Dictionary<string, object?> { ["path"] = "player.paused", ["value"] = true }, 2000);
                Thread.Sleep(600); // the snapshot is written 250 ms after a change

                // Supervised restart (Task 17 fix): SIGKILL the COMPOSITOR directly, never the supervisor
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
                // further attempt for 3 s (under load that alone used to fail this check).
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

                // R81: OnRestarted must have queued a reapply of the backend's current effective settings.
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

                // StopAndQuit afterwards must leave NO liascape-player process — neither the (new) compositor
                // nor the supervisor (the old adapter bug: signalling the compositor pid alone while its
                // supervisor lived just made the supervisor restart it again).
                LiascapePlayerMedia.StopAndQuit();
                bool compositorAlive = StillRunning(newCompositor >= 0 ? newCompositor : deadCompositor);
                bool supervisorAlive = StillRunning(priorSupervisor);
                if (compositorAlive || supervisorAlive) fails.Add($"StopAndQuit left a process alive (compositor={compositorAlive}, supervisor={supervisorAlive})");
                else Phase("StopAndQuit left no liascape-player process (compositor and supervisor both gone)");
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

    // ---- in-place upgrade: the same build through a symlink + a wrapProgram wrapper (2026-10-29 cold boot) --------
    // The Nix layout: `liascape/libexec/liascape/liascape-player` (what the launcher's LIASCAPE_PLAYER_BIN names) is a
    // symlink into ANOTHER store path, `liascape-player/bin/liascape-player`, a wrapProgram script that execs its sibling
    // `.liascape-player-wrapped` — the running process's exe. Compared by the symlink's own store root, the player the
    // restore had just started read as "out of date" and was restarted at once. Built here as pkg-a/pkg-b in a temp dir
    // (a running process whose exe is pkg-b's `.liascape-player-wrapped`, started through pkg-a's symlink), plus the
    // owner's real store paths when they exist.
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
            foreach (var (bin, what) in new[] { (link, "the libexec symlink"), (wrapperB, "the wrapper"), (Path.Combine(tmp, "pkg-b", "bin", ".liascape-player-wrapped"), "the wrapped binary") })
                if (LiascapePlayerClient.StaleReasonFor(p.Id, bin) is string why)
                    fails.Add($"stale: the player started through {what} reads as out of date: {why}");
            if (LiascapePlayerClient.StaleReasonFor(p.Id, wrapperC) == null)
                fails.Add("stale: a different build behind another wrapper reads as current");
            if (LiascapePlayerClient.StaleReasonFor(p.Id, plainD) == null)
                fails.Add("stale: a different plain binary reads as current");

            // the owner's real layout (2026-10-29: liascape-0.1.0's libexec symlink → liascape-player-0.1.0's wrapper,
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

    // ---- a player that is still starting is waited for, never "stalled" (2026-10-29 cold boot) --------------------
    // The player binds its socket first, then starts (PipeWire bus ≤ 500 ms, EGL, CUDA…) and answers ~1 s later. The
    // restore's monitor-daemon — another process, its `IsPlaying` a 300 ms `get` — connected in that window: its
    // greeting `hello` timed out, the stall breaker opened (and the `get` itself was still sent and timed out again),
    // and every request failed fast for 3 s. A fake player here binds and answers only 1 s later.
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

    // Is `pid` (still) an liascape-player process? item 5: via `/proc/<pid>/exe`'s link target (the real
    // resolved binary path), never a cmdline substring — same check as LiascapePlayerClient.IsPlayerProcess,
    // duplicated here since that one is private.
    private static bool StillRunning(int pid)
    {
        try { return Path.GetFileName(new FileInfo($"/proc/{pid}/exe").LinkTarget) == "liascape-player"; } catch { return false; }
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
