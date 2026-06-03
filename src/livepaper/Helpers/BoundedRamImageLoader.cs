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

    // Card thumbnails display at ~280-360px wide but the source files are full-res (library thumbs
    // are ~1024-1388px, remote previews larger). Decoding to the card's actual pixel width instead
    // means the GPU samples a small bitmap per card per frame, not a 1MP+ one — far cheaper scroll,
    // far less RAM per cached bitmap, with zero visible quality loss (decode width >= display px).
    // The width is driven from the live card size × display scaling (see SetDecodeWidth); changing it
    // clears the RAM cache so on-screen thumbnails re-decode at the new size.
    private static volatile int _decodeWidth = 512;
    private static BoundedRamImageLoader? _instance;

    public BoundedRamImageLoader() => _instance = this;

    // width = card pixel width (logical × DPI scale) + headroom. Rounded to a 64px bucket so small
    // window resizes don't thrash; only a real card-size/scale change re-decodes.
    public static void SetDecodeWidth(int width)
    {
        int bucket = Math.Clamp(((width + 63) / 64) * 64, 256, 2048);
        if (bucket == _decodeWidth) return;
        _decodeWidth = bucket;
        _instance?.ClearRamCache();
    }

    private readonly object _gate = new();
    private readonly LinkedList<string> _lru = new();
    private readonly Dictionary<string, (LinkedListNode<string> Node, Task<Bitmap?> Task)> _cache = new();

    public override Task<Bitmap?> ProvideImageAsync(string url)
        => GetOrLoad(url, () => LoadSizedAsync(url, null));

    public override Task<Bitmap?> ProvideImageAsync(string url, IStorageProvider? storageProvider = null)
        => GetOrLoad(url, () => LoadSizedAsync(url, storageProvider));

    // Local files (library thumbnails) are decoded straight to DecodeWidth here. Remote URLs defer to
    // the base download/cache pipeline; the disk-cache reload path (LoadFromGlobalCache) also decodes
    // to DecodeWidth, so a re-shown remote thumb is downsized too.
    private Task<Bitmap?> LoadSizedAsync(string url, IStorageProvider? storageProvider)
    {
        if (TryLocalPath(url, out var path))
            return Task.Run(() => DecodeToWidth(path));
        return storageProvider == null ? LoadAsync(url) : LoadAsync(url, storageProvider);
    }

    private static bool TryLocalPath(string url, out string path)
    {
        path = "";
        try
        {
            if (url.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
            {
                path = new Uri(url).LocalPath;
                return File.Exists(path);
            }
            if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase) && File.Exists(url))
            {
                path = url;
                return true;
            }
        }
        catch { }
        return false;
    }

    private static Bitmap? DecodeToWidth(string path)
    {
        try
        {
            using var fs = File.OpenRead(path);
            return Bitmap.DecodeToWidth(fs, _decodeWidth, BitmapInterpolationMode.MediumQuality);
        }
        catch { return null; }
    }

    private void ClearRamCache()
    {
        lock (_gate) { _cache.Clear(); _lru.Clear(); }
    }

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
                    using var fs = File.OpenRead(path);
                    return Bitmap.DecodeToWidth(fs, _decodeWidth, BitmapInterpolationMode.MediumQuality);
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
