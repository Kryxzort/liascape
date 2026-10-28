using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace Liascape.Helpers;

// A lock shared with every liascape PROCESS: an exclusive flock on `<file>.lock` next to the state file. The
// in-process locks (SettingsService's, LibraryStore's) don't reach the CLI (a keybind run locally when no backend
// answers, `liascape restore`'s WE sync) or the daemons, which read-modify-write the same files: 16 concurrent local
// volume-ups kept ONE of them (scripts/test-cross-process.sh). .NET takes the flock itself when a file is opened
// FileShare.None — non-blocking, a held lock throws — so this retries. Released on dispose, or by the kernel when
// the holder dies (never a stale lock). A holder that never lets go (a hung process) costs a wait of `MaxWaitMs`,
// then the write goes on unlocked (logged): a keybind must never hang on another process.
// Take it INSIDE the in-process lock for the same file: nesting on one file counts (UpdateIndex is reentrant)
// rather than opening a second descriptor, which would block on its own process's lock.
public static class FileLock
{
    private const int MaxWaitMs = 3000;
    private static readonly Dictionary<string, (FileStream? Fs, int Depth)> Held = new();
    private static readonly object Gate = new();

    public static IDisposable Hold(string file)
    {
        var path = Path.GetFullPath(file) + ".lock";
        lock (Gate)
            if (Held.TryGetValue(path, out var h)) { Held[path] = (h.Fs, h.Depth + 1); return new Release(path); }
        var fs = Open(path);
        lock (Gate) Held[path] = (fs, 1);
        return new Release(path);
    }

    private static FileStream? Open(string path)
    {
        var sw = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException) when (sw.ElapsedMilliseconds < MaxWaitMs) { Thread.Sleep(5); }
            catch (Exception e)
            {
                Console.Error.WriteLine($"FileLock: {Path.GetFileName(path)} not taken after {sw.ElapsedMilliseconds} ms ({e.Message}) — writing unlocked");
                return null;
            }
        }
    }

    private sealed class Release(string path) : IDisposable
    {
        private int _done;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _done, 1) == 1) return;
            FileStream? close = null;
            lock (Gate)
            {
                var (fs, depth) = Held[path];
                if (depth > 1) Held[path] = (fs, depth - 1);
                else { Held.Remove(path); close = fs; }
            }
            close?.Dispose();
        }
    }
}
