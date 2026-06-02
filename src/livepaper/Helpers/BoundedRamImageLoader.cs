using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using AsyncImageLoader.Loaders;

namespace livepaper.Helpers;

/// Drop-in replacement for AsyncImageLoader's default RamCachedWebImageLoader, which caches every
/// decoded thumbnail forever in an unbounded dictionary. With infinite scroll that grows without
/// limit (~hundreds of MB of decoded bitmaps), driving GC pressure and steadily worsening lag.
///
/// This keeps an LRU-bounded set of decoded bitmaps. Evicted entries are simply dropped (NOT
/// disposed) so a bitmap still referenced by a visible control is never freed out from under it —
/// the GC reclaims it once nothing references it. The cap bounds the *retained* set, so memory
/// plateaus instead of climbing with scroll depth.
public sealed class BoundedRamImageLoader : BaseWebImageLoader
{
    private const int Capacity = 96;

    private readonly object _gate = new();
    private readonly LinkedList<string> _lru = new();
    private readonly Dictionary<string, (LinkedListNode<string> Node, Task<Bitmap?> Task)> _cache = new();

    public override Task<Bitmap?> ProvideImageAsync(string url)
        => GetOrLoad(url, () => LoadAsync(url));

    public override Task<Bitmap?> ProvideImageAsync(string url, IStorageProvider? storageProvider = null)
        => GetOrLoad(url, () => LoadAsync(url, storageProvider));

    private Task<Bitmap?> GetOrLoad(string url, Func<Task<Bitmap?>> loader)
    {
        lock (_gate)
        {
            if (_cache.TryGetValue(url, out var existing))
            {
                _lru.Remove(existing.Node);
                _lru.AddLast(existing.Node);
                return existing.Task;
            }

            var task = loader();
            var node = _lru.AddLast(url);
            _cache[url] = (node, task);
            EvictLocked();

            // Don't cache failed/null loads so they can be retried later.
            _ = task.ContinueWith(t =>
            {
                if (t.Status != TaskStatus.RanToCompletion || t.Result == null)
                    Remove(url);
            }, TaskScheduler.Default);

            return task;
        }
    }

    private void EvictLocked()
    {
        while (_cache.Count > Capacity)
        {
            var oldest = _lru.First;
            if (oldest == null) break;
            _lru.RemoveFirst();
            _cache.Remove(oldest.Value);
            // Intentionally NOT disposing the Bitmap — a visible control may still reference it.
            // Dropping the strong ref lets the GC reclaim it once unreferenced.
        }
    }

    private void Remove(string url)
    {
        lock (_gate)
        {
            if (_cache.Remove(url, out var e))
                _lru.Remove(e.Node);
        }
    }

    // --- Persistent on-disk cache (under the RAM LRU) ---------------------------------------
    // BaseWebImageLoader.LoadAsync checks LoadFromGlobalCache before downloading and calls
    // SaveToGlobalCache after, so overriding these adds a disk cache: thumbnails survive scroll-back
    // past the RAM cap and app restarts, with no re-download. Only remote URLs reach here (local
    // file:// thumbnails are served by LoadFromLocalAsync first).
    private const int DiskCap = 3000;
    private static int _writesSinceTrim;

    private static string DiskDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".cache", "livepaper", "thumbs");

    protected override Task<Bitmap?> LoadFromGlobalCache(string url)
    {
        try
        {
            var path = DiskPath(url);
            if (!File.Exists(path)) return Task.FromResult<Bitmap?>(null);
            return Task.Run<Bitmap?>(() =>
            {
                try
                {
                    File.SetLastWriteTimeUtc(path, DateTime.UtcNow); // touch for LRU trimming
                    return new Bitmap(path);
                }
                catch { return null; }
            });
        }
        catch { return Task.FromResult<Bitmap?>(null); }
    }

    protected override async Task SaveToGlobalCache(string url, byte[] imageBytes)
    {
        if (imageBytes.Length == 0) return;
        try
        {
            Directory.CreateDirectory(DiskDir);
            var path = DiskPath(url);
            var tmp = path + ".tmp" + Environment.CurrentManagedThreadId;
            await File.WriteAllBytesAsync(tmp, imageBytes).ConfigureAwait(false);
            File.Move(tmp, path, overwrite: true);
            if (Interlocked.Increment(ref _writesSinceTrim) % 100 == 0)
                _ = Task.Run(TrimDisk);
        }
        catch { /* disk cache is best-effort */ }
    }

    private static void TrimDisk()
    {
        try
        {
            var dir = new DirectoryInfo(DiskDir);
            if (!dir.Exists) return;
            var files = dir.GetFiles();
            if (files.Length <= DiskCap) return;
            Array.Sort(files, (a, b) => a.LastWriteTimeUtc.CompareTo(b.LastWriteTimeUtc));
            for (int i = 0; i < files.Length - DiskCap; i++)
            {
                try { files[i].Delete(); } catch { }
            }
        }
        catch { }
    }

    private static string DiskPath(string url)
    {
        var bytes = SHA1.HashData(Encoding.UTF8.GetBytes(url));
        var sb = new StringBuilder(bytes.Length * 2);
        foreach (var b in bytes) sb.Append(b.ToString("x2"));
        return Path.Combine(DiskDir, sb.ToString());
    }
}
