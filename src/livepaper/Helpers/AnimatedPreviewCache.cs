using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace livepaper.Helpers;

/// Downloads animated-preview bytes (GIF/WebP/APNG) OFF the UI thread, with a concurrency
/// gate + in-memory and on-disk caches. Needed because AnimatedImage.Avalonia's URI source
/// does a synchronous `GetStreamAsync(uri).Result` on the UI thread when the AnimatedSource
/// property is set — fetching dozens of full-res previews that way freezes the app. We instead
/// pre-fetch the bytes here and feed the library an in-memory AnimatedImageSourceStream.
public static class AnimatedPreviewCache
{
    // Limit simultaneous downloads so a grid full of cards doesn't open dozens of sockets at once.
    private static readonly SemaphoreSlim _gate = new(6, 6);
    // Coalesce concurrent requests for the same URL into a single download.
    private static readonly ConcurrentDictionary<string, Task<byte[]?>> _inflight = new();
    // Small bounded RAM cache of recently used previews.
    private static readonly ConcurrentDictionary<string, byte[]> _mem = new();
    private const int MemCap = 48;

    // Disk cache is also bounded (least-recently-written evicted) so it can't grow forever.
    private const int DiskFileCap = 400;
    private static int _writesSinceTrim;

    private static string DiskDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".cache", "livepaper", "workshop_previews");

    public static Task<byte[]?> GetBytesAsync(string url, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(url)) return Task.FromResult<byte[]?>(null);
        if (_mem.TryGetValue(url, out var cached)) return Task.FromResult<byte[]?>(cached);
        // Share one download across concurrent callers for the same URL.
        return _inflight.GetOrAdd(url, u => DownloadAsync(u, ct));
    }

    private static async Task<byte[]?> DownloadAsync(string url, CancellationToken ct)
    {
        try
        {
            if (_mem.TryGetValue(url, out var hit)) return hit;

            string diskPath = Path.Combine(DiskDir, Hash(url));
            if (File.Exists(diskPath))
            {
                try
                {
                    var disk = await File.ReadAllBytesAsync(diskPath, ct).ConfigureAwait(false);
                    if (disk.Length > 0) { Store(url, disk); return disk; }
                }
                catch { /* corrupt cache entry — re-fetch */ }
            }

            await _gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (_mem.TryGetValue(url, out hit)) return hit;
                using var req = new HttpRequestMessage(HttpMethod.Get, url);
                req.Headers.Add("User-Agent", HttpClientProvider.UserAgent);
                using var resp = await HttpClientProvider.Client
                    .SendAsync(req, HttpCompletionOption.ResponseContentRead, ct).ConfigureAwait(false);
                resp.EnsureSuccessStatusCode();
                var bytes = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);

                try
                {
                    Directory.CreateDirectory(DiskDir);
                    await File.WriteAllBytesAsync(diskPath, bytes, ct).ConfigureAwait(false);
                    if (Interlocked.Increment(ref _writesSinceTrim) % 50 == 0)
                        _ = Task.Run(TrimDisk);
                }
                catch { /* disk cache is best-effort */ }

                Store(url, bytes);
                return bytes;
            }
            finally
            {
                _gate.Release();
            }
        }
        catch
        {
            return null;
        }
        finally
        {
            _inflight.TryRemove(url, out _);
        }
    }

    private static void Store(string url, byte[] bytes)
    {
        _mem[url] = bytes;
        if (_mem.Count > MemCap)
        {
            // Crude eviction: drop an arbitrary entry. Disk cache still backs it.
            foreach (var key in _mem.Keys)
            {
                if (key == url) continue;
                _mem.TryRemove(key, out _);
                break;
            }
        }
    }

    private static void TrimDisk()
    {
        try
        {
            var dir = new DirectoryInfo(DiskDir);
            if (!dir.Exists) return;
            var files = dir.GetFiles();
            if (files.Length <= DiskFileCap) return;
            Array.Sort(files, (a, b) => a.LastWriteTimeUtc.CompareTo(b.LastWriteTimeUtc));
            int remove = files.Length - DiskFileCap;
            for (int i = 0; i < remove; i++)
            {
                try { files[i].Delete(); } catch { }
            }
        }
        catch { }
    }

    private static string Hash(string url)
    {
        var bytes = SHA1.HashData(Encoding.UTF8.GetBytes(url));
        var sb = new StringBuilder(bytes.Length * 2);
        foreach (var b in bytes) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }
}
