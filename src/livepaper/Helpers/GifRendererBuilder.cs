using System;
using System.IO;
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

    /// Parses bytes into a ready-to-play source. MUST be called off the UI thread (inside Task.Run).
    /// Returns null if the bytes aren't a supported animated format or reflection failed.
    public static AnimatedImageSource? TryBuild(byte[]? bytes)
    {
        if (_factory == null || bytes == null || bytes.Length == 0) return null;
        try
        {
            var ms = new MemoryStream(bytes, writable: false);
            if (FrameRenderer.TryCreate(ms, _factory, out var renderer) && renderer != null)
                return new PrebuiltAnimatedSource(renderer);
        }
        catch { }
        return null;
    }

    private sealed record PrebuiltAnimatedSource(FrameRenderer Renderer) : AnimatedImageSource
    {
        // null => the property-changed handler skips the synchronous first-frame Bitmap decode.
        // The animation timeline pushes frame 0 from the already-built renderer on its own loop.
        public override Stream? SourceSeekable => null;

        // Clone per consumer so the grid card and the preview modal each get their OWN compositing
        // buffers/frame index. The clone shares the (immutable) parsed frame data but not the render
        // state — without this, two animation loops drive one renderer's single bitmap concurrently
        // and you get patchwork regions from different frames. Clone is cheap (shares frames).
        public override FrameRenderer? TryCreate() => Renderer.Clone();
    }
}
