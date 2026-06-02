using System;
using System.IO;
using System.Threading;
using AnimatedImage;
using AnimatedImage.Avalonia;

namespace livepaper.Helpers;

/// Builds a fully-parsed animated image source OFF the UI thread.
///
/// AnimatedImage.Avalonia normally parses the GIF/WebP/APNG (allocating several width×height
/// frame buffers) inside the AnimatedSource property-changed handler, which runs on the UI
/// thread. Doing that for a grid of cards causes a multi-hundred-ms stall. Here we run
/// FrameRenderer.TryCreate (public) on a background thread and wrap the ready renderer in a
/// source whose TryCreate() returns instantly — so the UI thread only wires up the timeline.
public static class GifRendererBuilder
{
    // WriteableBitmapFaceFactory is internal to AnimatedImage.Avalonia; grab it once via reflection.
    private static readonly IBitmapFaceFactory? _factory = CreateFactory();

    private static IBitmapFaceFactory? CreateFactory()
    {
        try
        {
            var t = typeof(AnimatedImageSource).Assembly
                .GetType("AnimatedImage.Avalonia.WriteableBitmapFaceFactory");
            return t == null ? null : Activator.CreateInstance(t) as IBitmapFaceFactory;
        }
        catch { return null; }
    }

    public static bool IsAvailable => _factory != null;

    // Parse bytes into a brand-new renderer (own compositing buffers AND own frame objects).
    private static FrameRenderer? Parse(byte[] bytes)
    {
        if (_factory == null) return null;
        try
        {
            var ms = new MemoryStream(bytes, writable: false);
            return FrameRenderer.TryCreate(ms, _factory, out var r) && r != null ? r : null;
        }
        catch { return null; }
    }

    /// Parses bytes into a ready-to-play source. MUST be called off the UI thread (inside Task.Run).
    /// Returns null if the bytes aren't a supported animated format or reflection failed.
    public static AnimatedImageSource? TryBuild(byte[]? bytes)
    {
        if (bytes == null || bytes.Length == 0) return null;
        var first = Parse(bytes);                       // off-thread build for the first consumer
        return first == null ? null : new PrebuiltAnimatedSource(bytes, first);
    }

    // The grid card and the preview modal can both bind this source at once, each calling TryCreate.
    // They must get INDEPENDENT renderers: FrameRenderer.Clone() shares the same GifRendererFrame
    // objects (and their lazily-decoded pixel buffers), so two concurrent animation loops corrupt
    // that shared frame state → patchwork of different frames. Instead, hand the off-thread-built
    // renderer to the first consumer and re-parse fresh (new frame objects) for any subsequent one.
    private sealed record PrebuiltAnimatedSource : AnimatedImageSource
    {
        private readonly byte[] _bytes;
        private FrameRenderer? _first;

        public PrebuiltAnimatedSource(byte[] bytes, FrameRenderer first)
        {
            _bytes = bytes;
            _first = first;
        }

        // null => the property-changed handler skips the synchronous first-frame Bitmap decode.
        public override Stream? SourceSeekable => null;

        public override FrameRenderer? TryCreate()
            => Interlocked.Exchange(ref _first, null) ?? Parse(_bytes);
    }
}
