using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Liascape.Helpers;

public static class AudioMonitor
{
    private static string MonitorPidPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".config", "liascape", "monitor.pid");

    public static void KillDetachedMonitor()
    {
        try
        {
            if (!File.Exists(MonitorPidPath)) return;
            var pidText = File.ReadAllText(MonitorPidPath).Trim();
            if (int.TryParse(pidText, out int pid))
            {
                try { Process.GetProcessById(pid).Kill(entireProcessTree: true); } catch { }
            }
            File.Delete(MonitorPidPath);
        }
        catch { }
    }

    public static void SpawnDetachedMonitor()
    {
        KillDetachedMonitor();
        try
        {
            var selfArgs = PlayerHelper.GetSelfInvocationArgs();
            if (selfArgs.Count == 0) return;
            var psi = new ProcessStartInfo("setsid")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var a in selfArgs) psi.ArgumentList.Add(a);
            psi.ArgumentList.Add("monitor-daemon");
            var proc = Process.Start(psi);
            if (proc != null)
            {
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                // Daemon writes its own PID from RunDaemon — proc.Id here is
                // the setsid wrapper, which may exec or fork depending on
                // whether liascape is a process group leader.
            }
        }
        catch { }
    }

    // 8000 Hz, 160 samples = 20ms per poll tick per stream
    private const int SampleRateHz = 8000;
    private const int ChunkSamples = 160;
    private const int ChunkBytes = ChunkSamples * sizeof(float);
    private const int MsPerTick = ChunkSamples * 1000 / SampleRateHz;

    private static CancellationTokenSource? _cts;
    private static volatile bool _isMuted;
    public static bool IsMuted => _isMuted;
    // this process runs the monitor itself (a `serve` backend with AutoMute on, a `monitor-daemon`)
    public static bool RunsHere => _cts != null;
    private static int _aboveThresholdCount;
    private static volatile bool _onlyIfMprisActive;

    // Entry point for the detached `liascape monitor-daemon` daemon process.
    public static void RunDaemon()
    {
        WriteMonitorPid();
        PlayerHelper.InstallShutdownReaper(); // SIGTERM on system-shutdown → reap mpvpaper (see method)
        var settings = SettingsService.Load();
        if (settings.AutoMute)
            Start(settings.AutoMuteDelayMs, settings.AutoUnmuteDelayMs, settings.AutoMuteMinLevelDb, settings.AutoMuteOnlyIfMprisActive);
        Thread.Sleep(Timeout.Infinite);
    }

    private static void WriteMonitorPid()
    {
        try
        {
            var path = MonitorPidPath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            AtomicFile.WriteAllText(path, Environment.ProcessId.ToString()); // a reader mid-write saw no owner
        }
        catch { }
    }

    public static void Start(int muteDelayMs, int unmuteDelayMs, double thresholdDb, bool onlyIfMprisActive = false)
    {
        Stop();
        _onlyIfMprisActive = onlyIfMprisActive;
        _cts = new CancellationTokenSource();
        var ct = _cts.Token;
        Task.Run(() => WatchStreamsAsync(thresholdDb, ct));
        Task.Run(() => WatchMuteAsync(muteDelayMs, unmuteDelayMs, ct));
    }

    public static void Stop()
    {
        _cts?.Cancel();
        _cts?.Dispose();
        _cts = null;
        if (_isMuted)
        {
            PlayerHelper.SetMute(false);
            _isMuted = false;
        }
    }

    // One watched sink-input: its parec monitor runs from the stream's first event (parec needs ~65-76 ms to its
    // first chunk, so it warms up meanwhile), but its level COUNTS only once the stream is classified foreign.
    private sealed class StreamWatch(CancellationTokenSource cts)
    {
        public readonly CancellationTokenSource Cts = cts;
        public volatile bool Foreign;
    }

    // Watches pactl subscribe and maintains one parec --monitor-stream per foreign (not-ours) stream.
    // Classify-then-count: a stream's level never counts before `ClassifyAsync` says it isn't ours, and a stream
    // classified ours is remembered until its `remove` — its later `change` events (uncork, relink, a volume or
    // property change) never open another window. Before (owner report, 2026-10-28): a new stream was counted at
    // once and checked 100 ms later, and every `change` re-added an already-checked own stream → each switch's
    // incoming source (liascape-player's mpv `liascape-player` / scene worker `liascape-player-scene.<id>` stream, ramping in at
    // −62 dB > the −70 dB threshold) auto-muted the wallpaper for a hitch — for the whole unmute delay when > 0.
    private static async Task WatchStreamsAsync(double thresholdDb, CancellationToken ct)
    {
        Interlocked.Exchange(ref _aboveThresholdCount, 0);
        var watches = new Dictionary<uint, StreamWatch>();
        var own = new HashSet<uint>();   // classified ours; forgotten at `remove` (a sink-input index can be reused)
        var gate = new object();

        static void Drop(StreamWatch w)
        {
            w.Cts.Cancel();
            w.Cts.Dispose();
        }

        void OnStream(uint id, bool? knownForeign = null)
        {
            StreamWatch w;
            lock (gate)
            {
                if (own.Contains(id) || watches.ContainsKey(id)) return;
                w = new StreamWatch(CancellationTokenSource.CreateLinkedTokenSource(ct)) { Foreign = knownForeign == true };
                watches[id] = w;
            }
            var token = w.Cts.Token;
            _ = Task.Run(() => MonitorStreamAsync(id, thresholdDb, w, token));
            if (knownForeign == true) return;
            _ = Task.Run(async () =>
            {
                try
                {
                    // a stream not listed yet (its event raced the listing) is asked again a few times, never counted
                    for (int attempt = 0; attempt < 4; attempt++)
                    {
                        if (attempt > 0) await Task.Delay(50, token);
                        var verdict = await ClassifyAsync(id, token);
                        if (verdict == null) continue;
                        lock (gate)
                        {
                            if (!watches.TryGetValue(id, out var cur) || cur != w) return;   // removed meanwhile
                            if (verdict == true) { w.Foreign = true; return; }
                            watches.Remove(id);
                            own.Add(id);
                        }
                        Drop(w);
                        return;
                    }
                    lock (gate) { if (watches.TryGetValue(id, out var cur) && cur == w) watches.Remove(id); else return; }
                    Drop(w);   // never listed: gone before it could be judged
                }
                catch (OperationCanceledException) { }
                catch (ObjectDisposedException) { }   // removed (cancelled + disposed) mid-classification
            });
        }

        void OnRemove(uint id)
        {
            StreamWatch? w;
            lock (gate)
            {
                own.Remove(id);
                if (!watches.Remove(id, out w)) return;
            }
            Drop(w);
        }

        // Initial reconciliation for streams already active before we started
        var (listed, foreign) = await ListStreamsAsync(ct);
        foreach (var id in listed)
        {
            if (foreign.Contains(id)) OnStream(id, knownForeign: true);
            else lock (gate) own.Add(id);
        }

        var psi = new ProcessStartInfo("pactl")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add("subscribe");

        Process? proc;
        try { proc = Process.Start(psi); }
        catch { return; }
        if (proc == null) return;

        try
        {
            while (true)
            {
                var line = await proc.StandardOutput.ReadLineAsync(ct);
                if (line == null) break;
                if (!line.Contains("sink-input")) continue;

                if ((line.Contains("'new'") || line.Contains("'change'")) && TryParseStreamId(line, out uint newId))
                    OnStream(newId);
                else if (line.Contains("'remove'") && TryParseStreamId(line, out uint removeId))
                    OnRemove(removeId);
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            List<StreamWatch> left;
            lock (gate) { left = [.. watches.Values]; watches.Clear(); own.Clear(); }
            foreach (var w in left) Drop(w);
            try { proc.Kill(); } catch { }
            proc.Dispose();
        }
    }

    // true = foreign (counts), false = ours (never counts), null = not listed (yet).
    private static async Task<bool?> ClassifyAsync(uint id, CancellationToken ct)
    {
        var (listed, foreign) = await ListStreamsAsync(ct);
        return !listed.Contains(id) ? null : foreign.Contains(id);
    }

    // Monitors a single stream's actual audio level via parec --monitor-stream.
    // Its level counts toward `_aboveThresholdCount` only while `watch.Foreign` (classified not ours).
    private static async Task MonitorStreamAsync(uint streamId, double thresholdDb, StreamWatch watch, CancellationToken ct)
    {
        var psi = new ProcessStartInfo("parec")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add($"--monitor-stream={streamId}");
        psi.ArgumentList.Add("--format=float32le");
        psi.ArgumentList.Add("--channels=1");
        psi.ArgumentList.Add($"--rate={SampleRateHz}");
        psi.ArgumentList.Add("--raw");
        // a small fragment: parec's default buffering held the first data back ~2 s (measured 2023 ms →
        // 65 ms first byte, 76 ms first 20 ms chunk — scripts/measure-automute-latency.py), so auto-mute
        // reacted ~2 s late to every new stream. Only this monitor's own record stream is affected.
        psi.ArgumentList.Add("--latency-msec=10");

        Process? proc;
        try { proc = Process.Start(psi); }
        catch { return; }
        if (proc == null) return;

        bool isAbove = false;
        var buffer = new byte[ChunkBytes];

        try
        {
            var stream = proc.StandardOutput.BaseStream;
            while (!ct.IsCancellationRequested)
            {
                int filled = 0;
                while (filled < ChunkBytes)
                {
                    int n = await stream.ReadAsync(buffer.AsMemory(filled), ct);
                    if (n == 0) return;
                    filled += n;
                }

                float peak = 0;
                for (int i = 0; i < ChunkBytes; i += sizeof(float))
                {
                    float s = MathF.Abs(BitConverter.ToSingle(buffer, i));
                    if (s > peak) peak = s;
                }
                double db = peak > 1e-9f ? 20.0 * Math.Log10(peak) : -100.0;
                bool nowAbove = watch.Foreign && db > thresholdDb;

                if (nowAbove && !isAbove) { Interlocked.Increment(ref _aboveThresholdCount); isAbove = true; }
                else if (!nowAbove && isAbove) { Interlocked.Decrement(ref _aboveThresholdCount); isAbove = false; }
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            if (isAbove) Interlocked.Decrement(ref _aboveThresholdCount);
            try { proc.Kill(); } catch { }
            proc.Dispose();
        }
    }

    // Polls _aboveThresholdCount every 20ms and applies mute/unmute with configured delays.
    private static async Task WatchMuteAsync(int muteDelayMs, int unmuteDelayMs, CancellationToken ct)
    {
        int muteTicksNeeded = Math.Max(1, muteDelayMs / MsPerTick);
        int unmuteTicksNeeded = Math.Max(1, unmuteDelayMs / MsPerTick);
        int aboveCount = 0;
        int belowCount = 0;
        bool wasPlaying = PlayerHelper.IsPlaying;

        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(MsPerTick, ct);

            bool isPlaying = PlayerHelper.IsPlaying;
            if (isPlaying && !wasPlaying && _isMuted)
                PlayerHelper.SetMute(true);
            wasPlaying = isPlaying;

            bool hasAudio = Volatile.Read(ref _aboveThresholdCount) > 0;

            if (hasAudio && !_isMuted)
            {
                aboveCount++;
                belowCount = 0;
                if (aboveCount >= muteTicksNeeded)
                {
                    if (!_onlyIfMprisActive || await IsAnyMprisPlayerActiveAsync(ct))
                    {
                        PlayerHelper.SetMute(true);
                        _isMuted = true;
                    }
                    aboveCount = 0;
                }
            }
            else if (!hasAudio && _isMuted)
            {
                belowCount++;
                aboveCount = 0;
                if (belowCount >= unmuteTicksNeeded)
                {
                    PlayerHelper.SetMute(false);
                    _isMuted = false;
                    belowCount = 0;
                }
            }
            else
            {
                aboveCount = 0;
                belowCount = 0;
            }
        }
    }

    private static async Task<bool> IsAnyMprisPlayerActiveAsync(CancellationToken ct = default)
    {
        try
        {
            var psi = new ProcessStartInfo("playerctl", "status")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using var proc = Process.Start(psi);
            if (proc == null) return false;
            using var cts = new CancellationTokenSource(500);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, cts.Token);
            try
            {
                var stdoutTask = proc.StandardOutput.ReadToEndAsync(linked.Token);
                var stderrTask = proc.StandardError.ReadToEndAsync(linked.Token);
                await proc.WaitForExitAsync(linked.Token);
                var output = (await stdoutTask).Trim();
                return output
                    .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
                    .Any(line => string.Equals(line.Trim(), "Playing", StringComparison.OrdinalIgnoreCase));
            }
            catch (OperationCanceledException)
            {
                try { proc.Kill(); } catch { }
                return false;
            }
        }
        catch { return false; }
    }

    // Every listed sink-input + the foreign ones among them (one `pactl list sink-inputs`; liascape-player's ownership
    // filter — itself a `pactl list short sinks` + maybe a `hello` — and the LWE client ids built concurrently, so
    // classifying costs one round trip, inside parec's own start-up).
    private static async Task<(HashSet<uint> listed, HashSet<uint> foreign)> ListStreamsAsync(CancellationToken ct)
    {
        var psi = new ProcessStartInfo("pactl")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add("list");
        psi.ArgumentList.Add("sink-inputs");

        // liascape-player: its own streams are excluded by OWNERSHIP (pid / bus node / bus sink / name, R69)
        var isOwnTask = Liascape.Player.PlayerEngine.IsLiascapePlayer
            ? Task.Run<Func<string, bool>?>(Liascape.Player.LiascapePlayerMedia.OwnStreamFilter, ct)
            : Task.FromResult<Func<string, bool>?>(null);
        var lweTask = Task.Run(PlayerHelper.GetLweClientObjectIds, ct);
        Process? proc;
        try { proc = Process.Start(psi); }
        catch { return ([], []); }
        if (proc == null) return ([], []);

        using (proc)
        {
            var output = await proc.StandardOutput.ReadToEndAsync(ct);
            await proc.WaitForExitAsync(ct);
            HashSet<string>? lweClientIds;
            try { lweClientIds = await lweTask; } catch (OperationCanceledException) { throw; } catch { lweClientIds = null; }
            Func<string, bool>? isOwn;
            try { isOwn = await isOwnTask; } catch (OperationCanceledException) { throw; } catch { isOwn = null; }
            return ParseStreams(output, lweClientIds, isOwn);
        }
    }

    internal static (HashSet<uint> listed, HashSet<uint> foreign) ParseStreams(string output, HashSet<string>? lweClientIds = null, Func<string, bool>? isOwn = null)
    {
        var listed = new HashSet<uint>();
        var result = new HashSet<uint>();
        var blocks = output.Split("Sink Input #", StringSplitOptions.RemoveEmptyEntries);
        foreach (var block in blocks)
        {
            if (!uint.TryParse(block.Split('\n')[0].Trim(), out uint blockId)) continue;
            listed.Add(blockId);
            if (block.Contains("application.process.binary = \"mpv\"")) continue;
            if (block.Contains("application.name = \"mpv\"")) continue;
            if (block.Contains("application.process.binary = \"linux-wallpaperengine\"")) continue;
            if (block.Contains("application.name = \"linux-wallpaperengine\"")) continue;
            if (isOwn != null && isOwn(block)) continue;
            if (lweClientIds != null)
            {
                string? clientId = null;
                foreach (var line in block.Split('\n'))
                {
                    var t = line.Trim();
                    if (t.StartsWith("client.id = \""))
                    {
                        clientId = t.Substring("client.id = \"".Length).TrimEnd('"');
                        break;
                    }
                }
                if (clientId != null && lweClientIds.Contains(clientId)) continue;
            }
            result.Add(blockId);
        }
        return (listed, result);
    }

    // Parses "Event 'new' on sink-input #42" → 42
    private static bool TryParseStreamId(string line, out uint id)
    {
        var hashIdx = line.LastIndexOf('#');
        if (hashIdx >= 0 && uint.TryParse(line.AsSpan(hashIdx + 1).Trim(), out id))
            return true;
        id = 0;
        return false;
    }
}
