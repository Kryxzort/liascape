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
        Own("another app", Block("Firefox", "1", "Firefox", "12"), false);
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

                // transitions OFF + video end (the gapless branch): cut at A's end
                using (var to = new CancellationTokenSource(30000))
                {
                    bool ok = LpPlayerMedia.SwitchAndWaitHandoff(b, s, null, alignEnd: true, to.Token).GetAwaiter().GetResult();
                    if (!ok) { fails.Add($"clip→clip cut (align end): no transition.handoff (corr {LpPlayerMedia.LastCorr})"); return; }
                }
                Phase("clip→clip cut handoff (align end)");
                if (LpPlayerMedia.CurrentPath() != b) fails.Add($"CurrentPath after cut = {LpPlayerMedia.CurrentPath() ?? "null"}, want b.mp4");

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
                while (rsw.ElapsedMilliseconds < 1500)
                {
                    try
                    {
                        var h = client.Call("hello", null, 300);
                        int hp = h.GetProperty("pid").GetInt32();
                        if (hp != deadCompositor) { newCompositor = hp; break; }
                    }
                    catch (LpPlayerException) { }
                    Thread.Sleep(30);
                }
                Phase($"supervised restart: compositor {deadCompositor} -> {newCompositor} in {rsw.ElapsedMilliseconds} ms");
                if (newCompositor < 0) fails.Add($"killing the compositor (pid {deadCompositor}) did not yield a new hello.pid within 1.5 s");
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
