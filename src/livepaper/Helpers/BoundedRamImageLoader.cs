using System;
using System.Collections.Generic;
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
}
