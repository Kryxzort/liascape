using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Liascape.Helpers;
using Liascape.Models;

namespace Liascape.Player;

// The adapter's program half (Phase 3 Task 7; plan docs/superpowers/plans/2026-10-29-liascape-player-phase3-programs.md,
// player-adapter.md § Rotation). Under PlayerEngine=liascape-player a rotation session — Play / play-from of a playlist,
// a timed or advance-on-end one, Play All with more than one item — is ONE player program, `prog:main` on `out:*`:
// the player keeps its clock, its order, its history and every rule of § Rotation (recipes/program/), and keeps
// rotating with the app closed. The backend only (a) turns the playlist + the settings into the program's spec
// (`BuildSpec` — the settings stay the backend's: R61's resolver writes `defaults` and the per-item props), (b) sends
// the user switches as thin verbs, (c) sends every live edit as a `set prog:main.<prop>` (coalescible, ordered with
// every other player mutation on LiascapePlayerMedia's queue) and (d) mirrors what plays from the program's events
// (`program.current` → the UI's `wallpaper-changed`). A single applied wallpaper stays a plain `transition`.
//
// The mirror (`IsActive`, `CurrentPath`, `CurrentIndex`) is seeded from `state.programs` (`Sync`: serve start, a
// player restart, the first question in a fresh process) and then follows the events. The MODEL (`_model`) is what
// this backend last loaded — R81 (`Reapply`) re-loads it into a player that lost it (a restart without its snapshot)
// and puts back a prop that differs; a backend that didn't load the program (it restarted) has no model and leaves the
// player's program as it is.
public static class LiascapePlayerProgram
{
    public const string Id = "prog:main";

    public sealed record Item(string Path, Dictionary<string, object?> Props, bool Skip);

    public sealed record Spec(List<Item> Items, Dictionary<string, object?> Defaults, string Order /*sequential|shuffle*/,
        string Mode /*timer|on_end*/, long IntervalMs, long MaxMs, bool SeparateScenes, long ScenesAfterMs,
        Dictionary<string, object?> Transition /*enabled, effects, shuffle, duration_ms, duration_max_ms, method*/,
        string Key /*name:<saved> | bar*/, string StartMode /*start_over|resume*/, string WhileParked /*rotate|hold*/);

    // ---- the spec ---------------------------------------------------------------------------------------------
    // `paths` in the playlist bar's order (the player shuffles: `order`), `p` the playlist's settings (its override, its
    // transitions — null = the globals), `intervalSeconds` the timer (advance off) or the minimum (advance on). The
    // maximum and the scene timing come from EffectiveRotation (override ?? global), the transition from
    // TransitionService.Effective + the TransitionMethod setting. `Defaults` = DesiredGlobal; each item carries only
    // what differs from them (an override, its own `af`, a scene's kind/preview/normalization/props/seed, an image's
    // kind) and `Skip` = the pickers' rule (IsSkippedPath: a scene that can't play, a crashed one not whitelisted).
    public static Spec BuildSpec(IReadOnlyList<string> paths, AppSettings s, PlaylistSettings? p, bool shuffle, int intervalSeconds, bool advance,
        string? key = null)
    {
        var rot = PlayerHelper.EffectiveRotation(s, p);
        var defaults = LiascapePlayerMedia.DesiredGlobal(s);
        return new Spec(BuildItems(paths, s, defaults), defaults, shuffle ? "shuffle" : "sequential", advance ? "on_end" : "timer",
            Ms(intervalSeconds), Ms(rot.Max), rot.SeparateScenes, Ms(rot.ScenesAfter), TransitionMap(s, p),
            key ?? KeyOf(PlaylistService.LoadCurrentState()?.Name), PlayerHelper.EffectiveStart(s, p), "rotate");
    }

    // The playlist's identity (§ Playlist start): `name:<saved name>` for a loaded/saved playlist, else `bar`.
    public static string KeyOf(string? playlistName) =>
        string.IsNullOrWhiteSpace(playlistName) ? "bar" : "name:" + playlistName.Trim();

    // The program's `transition` map: the effective config (the playlist's when it overrides, else the globals) + method.
    public static Dictionary<string, object?> TransitionMap(AppSettings s, PlaylistSettings? p)
    {
        var c = TransitionService.Effective(s, p);
        string method = (s.TransitionMethod ?? "reveal").Trim().ToLowerInvariant();
        if (method is not ("frozen" or "full-live" or "reveal")) method = "reveal";
        return new Dictionary<string, object?>
        {
            ["enabled"] = c.Enabled,
            ["effects"] = (c.EffectIds ?? []).Distinct().ToList(),
            ["shuffle"] = c.Shuffle,
            ["duration_ms"] = (double)Math.Clamp(c.DurationMs, 0, 10000),
            ["duration_max_ms"] = (double)Math.Clamp(c.DurationMaxMs, 0, 10000),
            ["method"] = method,
        };
    }

    public static List<Item> BuildItems(IReadOnlyList<string> paths, AppSettings s, Dictionary<string, object?>? defaults = null)
    {
        defaults ??= LiascapePlayerMedia.DesiredGlobal(s);
        bool scenesOk = PlayerEngine.ScenesPlayable(s);
        // DesiredItem kicks a loudness measure for an unmeasured video (normalization on): the program measures nothing
        return BuildItems(paths, defaults, path => LiascapePlayerMedia.DesiredItem(path, s), path => PlayerHelper.SkippedForRotation(path, scenesOk));
    }

    // The rule alone (self-test): each item = what a new source of it gets, minus what `defaults` already says.
    internal static List<Item> BuildItems(IReadOnlyList<string> paths, Dictionary<string, object?> defaults,
        Func<string, Dictionary<string, object?>> itemProps, Func<string, bool> skip)
    {
        var items = new List<Item>(paths.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var path in paths)
        {
            if (string.IsNullOrEmpty(path) || !seen.Add(path)) continue; // the player's items are a set of paths
            var props = new Dictionary<string, object?>();
            foreach (var (k, v) in itemProps(path))
                if (k != "path" && (!defaults.TryGetValue(k, out var d) || !SameValue(d, v))) props[k] = v;
            items.Add(new Item(path, props, skip(path)));
        }
        return items;
    }

    private static long Ms(int seconds) => Math.Max(0, (long)seconds) * 1000;

    private static JsonElement J(object? v) => JsonSerializer.SerializeToElement(v);
    private static bool SameValue(object? a, object? b) => LiascapePlayerMedia.JsonSame(J(a), J(b));

    // The program node's settable props for `spec` (`key` first: a new key keeps the old playlist's resume point — the
    // player puts it when the key changes, before the items do).
    private static List<(string prop, object? value)> Props(Spec spec) =>
    [
        ("key", spec.Key),
        ("items", ItemsJson(spec.Items)),
        ("defaults", spec.Defaults),
        ("order", spec.Order),
        ("mode", spec.Mode),
        ("interval_ms", (double)spec.IntervalMs),
        ("max_ms", (double)spec.MaxMs),
        ("separate_scenes", spec.SeparateScenes),
        ("scenes_after_ms", (double)spec.ScenesAfterMs),
        ("transition", spec.Transition),
        ("start_mode", spec.StartMode),
        ("while_parked", spec.WhileParked),
    ];

    private static List<Dictionary<string, object?>> ItemsJson(IEnumerable<Item> items) =>
        items.Select(i => new Dictionary<string, object?> { ["path"] = i.Path, ["props"] = i.Props, ["skip"] = i.Skip }).ToList();

    // ---- the mirror (what the player's program is doing) + the model (what this backend loaded) ----------------
    private static readonly object _lock = new();
    private static bool _known;            // the mirror was seeded for this player process (`_gen`)
    private static int _gen = -1;
    private static bool _exists;           // prog:main exists in the player
    private static string? _path;          // what it plays (its last `program.current`)
    private static int _index = -1;
    private static string? _key;           // its `key`, as last set / read
    private static Spec? _model;           // what this backend last loaded (null: nothing of ours — R81 leaves it alone)
    private static List<string>? _paths;   // its items, as this backend knows them (the model's, or read by Sync)
    private static string? _wantKey;       // a key to set before the next items push (another playlist into the bar)
    private static JsonElement? _sentItems, _sentDefaults; // the last items / defaults sent (a push that changes nothing sends nothing)

    private static LiascapePlayerClient C => LiascapePlayerClient.Shared;

    // A rotation session runs in the player (the UI's `/current.timed`, IsTimedPlaylistActive under liascape-player).
    public static bool IsActive
    {
        get
        {
            if (!PlayerEngine.IsLiascapePlayer || !C.SocketExists) return false;
            EnsureSynced();
            lock (_lock) return _exists;
        }
    }

    // No I/O: the program owns what shows (ReconcileShown must not put a backend switch back over it).
    internal static bool Owns { get { lock (_lock) return _exists || _model != null; } }

    public static string? CurrentPath { get { EnsureSynced(); lock (_lock) return _exists ? _path : null; } }
    // its items' paths as this backend knows them (null: not known — e.g. nothing loaded since a backend restart)
    public static IReadOnlyList<string>? Paths { get { lock (_lock) return _paths?.ToList(); } }
    public static int CurrentIndex { get { EnsureSynced(); lock (_lock) return _exists ? _index : -1; } }

    private static void EnsureSynced()
    {
        bool need;
        lock (_lock) need = !_known || _gen != C.Generation;
        if (need) Sync();
    }

    // serve start / a reconnect / a new player process: seed the mirror from `state.programs` (no writes). Subscribes
    // the events so the mirror (and the UI's `wallpaper-changed`) follows the program from here.
    public static void Sync()
    {
        var client = C;
        if (!PlayerEngine.IsLiascapePlayer) return;
        if (!client.SocketExists)
        {
            lock (_lock) { _known = true; _gen = client.Generation; _exists = false; _path = null; _index = -1; }
            return;
        }
        client.StartEvents();
        JsonElement st;
        try { st = client.Call("state", null, LiascapePlayerClient.QuickMs); }
        catch (LiascapePlayerException e) { LiascapePlayerClient.Log($"program sync: state failed — {e}"); return; }
        bool exists = false; string? path = null; int index = -1;
        if (st.TryGetProperty("programs", out var progs) && progs.ValueKind == JsonValueKind.Array)
            foreach (var pr in progs.EnumerateArray())
                if (Str(pr, "id") == Id)
                {
                    exists = true;
                    path = pr.TryGetProperty("path", out var pp) && pp.ValueKind == JsonValueKind.String ? pp.GetString() : null;
                    index = pr.TryGetProperty("index", out var ix) && ix.ValueKind == JsonValueKind.Number ? ix.GetInt32() : -1;
                }
        string? key = null; List<string>? paths = null;
        if (exists)
        {
            key = Get(client, "key") is { ValueKind: JsonValueKind.String } k ? k.GetString() : null;
            if (Get(client, "items") is { ValueKind: JsonValueKind.Array } items)
                paths = items.EnumerateArray().Select(i => Str(i, "path")).Where(x => x.Length > 0).ToList();
        }
        lock (_lock)
        {
            _known = true; _gen = client.Generation;
            _exists = exists; _path = path; _index = index; _key = key;
            if (_model == null) _paths = paths; // ours stays ours (the model's paths)
            _sentItems = _sentDefaults = null;   // a new process: compare against what it really holds
        }
    }

    // `serve` start under liascape-player: the mirror, then a legacy rotation still described by timed_state.json
    // (a backend before Task 7, or the legacy engine) becomes the player's program at the item it was on (designer
    // call 10). A program already in the player (an app restart: it never stopped) is left alone.
    public static void Startup()
    {
        Sync();
        if (IsActive) { LiascapePlayerClient.Log($"program: the player's rotation plays on ({Path.GetFileName(CurrentPath ?? "")})"); return; }
        if (PlayerHelper.LoadFromTimedState()) LiascapePlayerClient.Log("program: took over the legacy timed playlist (timed_state.json) as the player's program");
    }

    private static JsonElement? Get(LiascapePlayerClient client, string prop)
    {
        try { return client.Call("get", new Dictionary<string, object?> { ["path"] = $"{Id}.{prop}" }, LiascapePlayerClient.QuickMs).GetProperty("value"); }
        catch (LiascapePlayerException) { return null; }
    }

    // Whether the player has prog:main: false only on its own `no_such_node`; null = no answer (a slow or stalled player
    // is not a player that lost the rotation — re-creating or re-playing on a timeout would restart what plays).
    private static bool? Exists(LiascapePlayerClient client, int timeoutMs)
    {
        try { client.Call("get", new Dictionary<string, object?> { ["path"] = $"{Id}.key" }, timeoutMs); return true; }
        catch (LiascapePlayerException e) when (e.Code == "no_such_node") { return false; }
        catch (LiascapePlayerException) { return null; }
    }

    private static string Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    // ---- events (LiascapePlayerMedia.OnEvent, the event thread: never blocks) -----------------------------------
    internal static void OnEvent(string kind, JsonElement e)
    {
        if (Str(e, "id") != Id) return;
        switch (kind)
        {
            case "program.created":
                lock (_lock) _exists = true;
                break;
            case "program.destroyed":
                lock (_lock) { _exists = false; _path = null; _index = -1; }
                break;
            case "program.current":
                var path = Str(e, "path");
                int index = e.TryGetProperty("index", out var ix) && ix.ValueKind == JsonValueKind.Number ? ix.GetInt32() : -1;
                lock (_lock) { _exists = true; _path = path.Length > 0 ? path : null; _index = index; }
                if (path.Length > 0)
                    _ = Task.Run(() =>
                    {
                        try { PlayerHelper.OnProgramSwitched(path); } catch (Exception ex) { LiascapePlayerClient.Log($"OnProgramSwitched threw: {ex.Message}"); }
                        LiascapePlayerMedia.UpgradeAfterCommit(); // a stale player restarts onto the new build between switches
                    });
                break;
            case "program.empty":
                LiascapePlayerClient.Log("program: nothing in the rotation can play (program.empty) — the last frame stays");
                break;
            case "program.failed":
                LiascapePlayerClient.Log($"program: {Path.GetFileName(Str(e, "path"))} failed ({Str(e, "reason")}) — the player backs off and skips it");
                break;
        }
    }

    // A new player process (LiascapePlayerMedia.OnRestarted): re-seed the mirror when next asked, R81 for the program.
    internal static void OnRestarted()
    {
        lock (_lock) _known = false;
        Reapply();
    }

    // ---- load / end ---------------------------------------------------------------------------------------------
    // A Play (`from` start|resume — the effective start mode), a play-from (`index`), a restore. ESSENTIAL (a user's
    // intent, never dropped, a barrier): the program is created (or, when it exists, its key set first — the player
    // keeps the old playlist's resume point — then every other prop), the pause lifted (I1, unless `keepPause`), then
    // `program.play {from}`. The same key already playing + `resume` → the player keeps playing where it is.
    public static Task Load(Spec spec, string from, int index, bool keepPause)
    {
        lock (_lock)
        {
            _model = spec;
            _paths = spec.Items.Select(i => i.Path).ToList();
            _wantKey = null;
            _exists = true; // /current.timed at once; the events confirm (or LoadNow clears it on failure)
            _key = spec.Key;
        }
        return LiascapePlayerMedia.QueueEssential(() => LoadNow(spec, from, index, keepPause, unpause: !keepPause));
    }

    private static void LoadNow(Spec spec, string from, int index, bool keepPause, bool unpause)
    {
        var s = SettingsService.Load();
        if (LiascapePlayerMedia.Ready(s) is not { } client)
        {
            LiascapePlayerClient.Log("program: no liascape-player to load the rotation into");
            lock (_lock) _exists = false;
            return;
        }
        LiascapePlayerMedia.ForgetIntent();
        var props = Props(spec);
        if (Exists(client, 2000) is not bool exists)
        {
            LiascapePlayerClient.Log("program: the player didn't answer — the rotation isn't loaded (R81 re-applies when it does)");
            return;
        }
        try
        {
            if (!exists)
            {
                client.Call("create", new Dictionary<string, object?>
                {
                    ["kind"] = "program",
                    ["id"] = Id,
                    ["props"] = props.ToDictionary(x => x.prop, x => x.value),
                });
            }
            else
            {
                foreach (var (prop, value) in props) SetProp(client, prop, value, throwOnError: prop == "items");
            }
            lock (_lock) { _sentItems = J(props.First(x => x.prop == "items").value); _sentDefaults = J(spec.Defaults); _known = true; _gen = client.Generation; }
            if (unpause)
                client.TryCall("set", new Dictionary<string, object?> { ["path"] = "player.paused", ["value"] = false }, LiascapePlayerClient.QuickMs);
            var args = new Dictionary<string, object?> { ["id"] = Id, ["from"] = from, ["keep_pause"] = keepPause };
            if (from == "index") args["index"] = Math.Max(0, index);
            var res = client.Call("program.play", args);
            LiascapePlayerClient.Log($"program: {(exists ? "reloaded" : "loaded")} {spec.Items.Count} items ({spec.Key}, {spec.Mode}, {spec.Order}), play {from}"
                + (from == "index" ? $" {index}" : "") + $" → {Path.GetFileName(Str(res, "path"))}"
                + (res.TryGetProperty("resumed", out var r) && r.ValueKind == JsonValueKind.True ? " (resumed)" : ""));
        }
        catch (LiascapePlayerException e)
        {
            LiascapePlayerClient.Log($"program: loading the rotation failed — {e}");
            if (!exists) lock (_lock) _exists = Exists(client, LiascapePlayerClient.QuickMs) == true;
        }
        finally { LiascapePlayerMedia.InvalidateSources(); }
    }

    private static bool SetProp(LiascapePlayerClient client, string prop, object? value, bool throwOnError = false)
    {
        try
        {
            client.Call("set", new Dictionary<string, object?> { ["path"] = $"{Id}.{prop}", ["value"] = value }, 2000);
            return true;
        }
        catch (LiascapePlayerException e) when (!throwOnError)
        {
            LiascapePlayerClient.Log($"program: set {prop} failed — {e}");
            return false;
        }
    }

    // A single wallpaper replaces the rotation (`Apply`): `destroy prog:main` (the player keeps its resume point; a
    // pre-Running armed switch is cancelled, what shows stays) — queued before the switch.
    public static void End()
    {
        bool had;
        lock (_lock) { had = _exists || _model != null; _model = null; _paths = null; _exists = false; _path = null; _index = -1; _wantKey = null; }
        if (!had || !PlayerEngine.IsLiascapePlayer) return;
        LiascapePlayerMedia.QueueEssential(() =>
        {
            var client = C;
            if (!client.SocketExists) return;
            try { client.Call("destroy", new Dictionary<string, object?> { ["id"] = Id }, LiascapePlayerClient.QuickMs); }
            catch (LiascapePlayerException e) when (e.Code == "no_such_node") { }
            catch (LiascapePlayerException e) { LiascapePlayerClient.Log($"program: destroy failed — {e}"); }
        });
    }

    // `stop` (the player destroys every program itself) / the engine switched away: forget it.
    public static void Forget()
    {
        lock (_lock) { _model = null; _paths = null; _exists = false; _path = null; _index = -1; _wantKey = null; _sentItems = _sentDefaults = null; }
    }

    // ---- user switches (thin verbs; essential — a keybind's intent) -------------------------------------------
    public static void Next(bool keepPause) => Verb("next", keepPause);
    public static void Prev(bool keepPause) => Verb("prev", keepPause);
    public static void Random(bool keepPause) => Verb("random", keepPause);

    private static void Verb(string verb, bool keepPause) => LiascapePlayerMedia.QueueEssential(() =>
    {
        var client = C;
        if (!client.SocketExists) return;
        var args = new Dictionary<string, object?> { ["id"] = Id, ["keep_pause"] = keepPause };
        try
        {
            var res = client.Call("program." + verb, args);
            if (res.TryGetProperty("corr", out var c) && c.ValueKind == JsonValueKind.Null)
                LiascapePlayerClient.Log($"program.{verb}: nothing to do" + (verb == "prev" ? " (the session's first item)" : ""));
        }
        catch (LiascapePlayerException e) when (e.Code == "no_such_node")
        {
            // the player lost it (a restart without its snapshot) and R81 hasn't caught up yet: load ours, then the verb
            Spec? model; int at;
            lock (_lock) { model = _model; at = _paths?.IndexOf(_path ?? "") ?? -1; }
            if (model == null) { LiascapePlayerClient.Log($"program.{verb}: the player has no rotation"); lock (_lock) _exists = false; return; }
            LoadNow(model, at >= 0 ? "index" : "start", Math.Max(0, at), keepPause: false, unpause: false);
            try { client.Call("program." + verb, args); } catch (LiascapePlayerException e2) { LiascapePlayerClient.Log($"program.{verb} failed — {e2}"); }
        }
        catch (LiascapePlayerException e) { LiascapePlayerClient.Log($"program.{verb} failed — {e}"); }
        finally { LiascapePlayerMedia.InvalidateSources(); }
    });

    // ---- live edits (coalescible per prop group: the newest wins; ordered with every other player mutation) -------
    // Each updates the model at once and sends only while the program exists. "Settings apply live": the player applies
    // each exactly as § Rotation says (a new minimum re-arms to the same B, an interval keeps the proportional
    // remaining, an edit never resets the play time — recipes/program configure).
    public static void SetRotation(int intervalSeconds, bool advance)
    {
        string mode = advance ? "on_end" : "timer"; long ms = Ms(intervalSeconds);
        Update(m => m with { Mode = mode, IntervalMs = ms });
        SetProps("program:rotation", [("mode", mode), ("interval_ms", (double)ms)]);
    }

    public static void SetLimits(int maxSeconds, bool separate, int scenesAfterSeconds)
    {
        long max = Ms(maxSeconds), after = Ms(scenesAfterSeconds);
        Update(m => m with { MaxMs = max, SeparateScenes = separate, ScenesAfterMs = after });
        SetProps("program:limits", [("max_ms", (double)max), ("separate_scenes", separate), ("scenes_after_ms", (double)after)]);
    }

    // The effective transition of the playing playlist (its own under its override, else the globals) + the method.
    public static void SetTransition()
    {
        var t = TransitionMap(SettingsService.Load(), PlaylistService.LoadCurrentState()?.Settings);
        Update(m => m with { Transition = t });
        SetProps("program:transition", [("transition", t)]);
    }

    public static void SetOrder(bool shuffle)
    {
        string order = shuffle ? "shuffle" : "sequential";
        Update(m => m with { Order = order });
        SetProps("program:order", [("order", order)]);
    }

    // "When the playlist starts again" — read at the next start only, never jumps the current play.
    public static void SetStartMode(string mode)
    {
        string sm = AppSettings.PlaylistStartMode(mode);
        Update(m => m with { StartMode = sm });
        SetProps("program:start", [("start_mode", sm)]);
    }

    // The playlist bar changed (a reorder, an add/remove, a trash/undo, another playlist loaded into it): the items,
    // rebuilt from the paths + the skip flags. `key` (the bar's playlist identity) changing → set first, so the player
    // keeps the old playlist's resume point (§ Playlist start: "Save as" / loading another playlist).
    public static void SetItems(IReadOnlyList<string> paths, string? key = null)
    {
        lock (_lock)
        {
            _paths = paths.Where(x => !string.IsNullOrEmpty(x)).Distinct().ToList();
            if (key != null && key != _key) _wantKey = key;
        }
        PushItems();
    }

    // An item's own values changed (an override, a loudness landed, scene props, a crash mark, a whitelist): its
    // props in the items → the next B of it. Coalesced with every other items push (one rebuild covers them all).
    public static void PushItem(string path)
    {
        lock (_lock)
            if (_paths == null || !_paths.Any(x => SamePath(x, path))) return;
        PushItems();
    }

    public static void PushItems()
    {
        if (!PlayerEngine.IsLiascapePlayer) return;
        lock (_lock) if (!_exists && _model == null) return;
        LiascapePlayerMedia.QueueSet("program:items", PushItemsNow);
    }

    private static void PushItemsNow()
    {
        var client = C;
        List<string>? paths; string? wantKey;
        lock (_lock) { if (!_exists) return; paths = _paths; wantKey = _wantKey; }
        if (!client.SocketExists) return;
        if (paths == null)
        {
            // a program this backend didn't load (it restarted): its own items
            if (Get(client, "items") is not { ValueKind: JsonValueKind.Array } cur) return;
            paths = cur.EnumerateArray().Select(i => Str(i, "path")).Where(x => x.Length > 0).ToList();
            lock (_lock) _paths ??= paths;
        }
        if (wantKey != null && SetProp(client, "key", wantKey))
            lock (_lock) { _key = wantKey; if (_wantKey == wantKey) _wantKey = null; if (_model != null) _model = _model with { Key = wantKey }; }
        var s = SettingsService.Load();
        var items = BuildItems(paths, s);
        var json = J(ItemsJson(items));
        JsonElement? sent;
        lock (_lock) sent = _sentItems;
        if (sent is { } prev && LiascapePlayerMedia.JsonSame(prev, json)) return;
        if (items.Count == 0) return; // an empty bar: the rotation keeps its items (a playlist emptied plays on, as today)
        if (SetProp(client, "items", ItemsJson(items)))
            lock (_lock) { _sentItems = json; if (_model != null) _model = _model with { Items = items }; }
    }

    // The globals changed (/settings, the volume key, the mute): the next B's defaults.
    public static void PushDefaults()
    {
        if (!PlayerEngine.IsLiascapePlayer) return;
        lock (_lock) if (!_exists && _model == null) return;
        LiascapePlayerMedia.QueueSet("program:defaults", () =>
        {
            var client = C;
            lock (_lock) if (!_exists) return;
            if (!client.SocketExists) return;
            var d = LiascapePlayerMedia.DesiredGlobal(SettingsService.Load());
            var json = J(d);
            JsonElement? sent;
            lock (_lock) sent = _sentDefaults;
            if (sent is { } prev && LiascapePlayerMedia.JsonSame(prev, json)) return;
            if (SetProp(client, "defaults", d))
                lock (_lock) { _sentDefaults = json; if (_model != null) _model = _model with { Defaults = d }; }
        });
    }

    private static void Update(Func<Spec, Spec> f)
    {
        lock (_lock) if (_model != null) _model = f(_model);
    }

    private static void SetProps(string key, List<(string prop, object? value)> props)
    {
        if (!PlayerEngine.IsLiascapePlayer) return;
        lock (_lock) if (!_exists && _model == null) return;
        LiascapePlayerMedia.QueueSet(key, () =>
        {
            var client = C;
            lock (_lock) if (!_exists) return;
            if (!client.SocketExists) return;
            foreach (var (prop, value) in props) SetProp(client, prop, value);
        });
    }

    // ---- R81 --------------------------------------------------------------------------------------------------
    // A new player process or the stall breaker closing: our model back on the player. Absent (a restart without its
    // snapshot — the supervisor's 4th restart in a minute) → loaded again at the item it was on; present → each prop
    // that differs from the model (with its items + defaults recomputed now) is set. No model (this backend didn't
    // load the program) → the player's own program stands.
    public static void Reapply()
    {
        if (!PlayerEngine.IsLiascapePlayer) return;
        lock (_lock) if (_model == null) return;
        LiascapePlayerMedia.QueueSet("program:reapply", ReapplyNow);
    }

    private static void ReapplyNow()
    {
        var client = C;
        Spec? model; string? path; List<string>? paths;
        lock (_lock) { model = _model; path = _path; paths = _paths; }
        if (model == null || !client.SocketExists) return;
        var s = SettingsService.Load();
        var defaults = LiascapePlayerMedia.DesiredGlobal(s);
        model = model with { Defaults = defaults, Items = BuildItems(paths ?? model.Items.Select(i => i.Path).ToList(), s, defaults) };
        lock (_lock) _model = model;
        var has = Exists(client, 2000);
        if (has == null) return; // no answer: the breaker closing runs this again
        if (has == false)
        {
            int at = path != null ? model.Items.FindIndex(i => SamePath(i.Path, path)) : -1;
            LiascapePlayerClient.Log($"program: liascape-player has no rotation any more (restarted without its snapshot) — loading it again"
                + (at >= 0 ? $" at {Path.GetFileName(path)}" : " from the start"));
            LoadNow(model, at >= 0 ? "index" : "start", Math.Max(0, at), keepPause: false, unpause: false);
            return;
        }
        int sent = 0;
        foreach (var (prop, value) in Props(model))
        {
            var want = J(value);
            if (Get(client, prop) is { } have && LiascapePlayerMedia.JsonSame(have, want)) continue;
            if (SetProp(client, prop, value)) sent++;
        }
        lock (_lock) { _sentItems = J(ItemsJson(model.Items)); _sentDefaults = J(model.Defaults); }
        if (sent > 0) LiascapePlayerClient.Log($"program: re-applied {sent} rotation setting(s) (R81)");
    }

    private static bool SamePath(string a, string b)
    {
        if (a == b) return true;
        try { return Path.GetFullPath(a).TrimEnd('/') == Path.GetFullPath(b).TrimEnd('/'); } catch { return false; }
    }
}
