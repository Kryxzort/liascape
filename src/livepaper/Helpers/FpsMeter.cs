using System;
using System.Collections.Generic;
using Avalonia.Controls;

namespace livepaper.Helpers;

/// Debug-only frame-rate meter. Driven off `TopLevel.RequestAnimationFrame` (re-requested every
/// frame, same hook the SmoothScroller uses), so it counts the actual present cadence — capped at
/// the display refresh on Wayland. Re-requesting each frame keeps the render loop continuously
/// active, which is what we want while benchmarking the scroll ceiling.
///
/// Values are written on the UI thread; reading them from the DebugBridge thread is fine (racy but
/// harmless for metrics).
public static class FpsMeter
{
    public static double CurrentFps { get; private set; }
    public static double LastFrameMs { get; private set; }
    /// Worst frametime over the last ~1s expressed as fps (a conservative low-percentile signal).
    public static double LowFps { get; private set; }

    /// Fired ~4x/sec on the UI thread so an overlay can refresh its text without per-frame churn.
    public static Action? Updated;

    private static TopLevel? _tl;
    private static TimeSpan? _last;
    private static int _frames;
    private static double _accumMs;
    private static readonly Queue<double> _window = new();
    private static double _windowMs;

    public static void Start(TopLevel tl)
    {
        if (_tl != null) return;
        _tl = tl;
        _last = null;
        tl.RequestAnimationFrame(OnFrame);
    }

    private static void OnFrame(TimeSpan t)
    {
        if (_tl == null) return;

        if (_last.HasValue)
        {
            double dt = (t - _last.Value).TotalMilliseconds;
            if (dt > 0 && dt < 1000)
            {
                LastFrameMs = dt;
                _frames++;
                _accumMs += dt;

                _window.Enqueue(dt);
                _windowMs += dt;
                while (_windowMs > 1000 && _window.Count > 1)
                    _windowMs -= _window.Dequeue();

                if (_accumMs >= 250)
                {
                    CurrentFps = _frames * 1000.0 / _accumMs;
                    _frames = 0;
                    _accumMs = 0;

                    double worst = 0;
                    foreach (var f in _window)
                        if (f > worst) worst = f;
                    LowFps = worst > 0 ? 1000.0 / worst : 0;

                    Updated?.Invoke();
                }
            }
        }

        _last = t;
        _tl.RequestAnimationFrame(OnFrame);
    }
}
