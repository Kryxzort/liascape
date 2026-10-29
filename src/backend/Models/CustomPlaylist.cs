using System;
using System.Collections.Generic;

namespace Liascape.Models;

public enum PlaylistOrder { Sequential, Shuffle }

public class PlaylistSettings
{
    public PlaylistOrder Order { get; set; } = PlaylistOrder.Sequential;
    public bool OverrideGlobalSettings { get; set; } = false;
    // The rotation (gated by OverrideGlobalSettings; PlayerHelper § Rotation): SwitchWhenVideoEnds ("Switch when video
    // ends") off → IntervalSeconds is a plain timer ("Switch every"); on → IntervalSeconds is the minimum play time and
    // MaxPlaySeconds the maximum, and SeparateSceneTiming gives scenes + still images their own SwitchScenesAfterSeconds
    // (wall-clock seconds, 0 = off). The defaults = the global ones (a video to its end, a scene / image 30 min).
    public int IntervalSeconds { get; set; } = 0;
    public bool SwitchWhenVideoEnds { get; set; } = true;
    private int _maxPlaySeconds = 0;
    public int MaxPlaySeconds { get => _maxPlaySeconds; set => _maxPlaySeconds = AppSettings.PlayLimit(value); }
    public bool SeparateSceneTiming { get; set; } = true;
    private int _switchScenesAfterSeconds = 1800;
    public int SwitchScenesAfterSeconds { get => _switchScenesAfterSeconds; set => _switchScenesAfterSeconds = AppSettings.PlayLimit(value); }
    // "When the playlist starts again" (gated by OverrideGlobalSettings like the rotation): start_over | resume
    private string _playlistStart = "start_over";
    public string PlaylistStart { get => _playlistStart; set => _playlistStart = AppSettings.PlaylistStartMode(value); }

    // Transitions (gated by OverrideGlobalSettings, like the rotation fields above; else the
    // AppSettings.GlobalTransition* fallbacks apply). TransitionEffectIds = manifest ids the user
    // enabled; empty or !Enabled => instant cut. DurationMaxMs > DurationMs => randomize per switch.
    public bool TransitionEnabled { get; set; } = false;
    public List<string> TransitionEffectIds { get; set; } = [];
    public int TransitionDurationMs { get; set; } = 600;
    public int TransitionDurationMaxMs { get; set; } = 0;
    public bool TransitionShuffle { get; set; } = true;

    // Every field — new ones included — so a caller that only changes Order (play-from) or the
    // rotation fields can never silently drop the transition settings (it did, twice).
    public PlaylistSettings Clone()
    {
        var c = (PlaylistSettings)MemberwiseClone();
        c.TransitionEffectIds = [.. TransitionEffectIds];
        return c;
    }
}

public class CustomPlaylist
{
    public List<string> VideoPaths { get; set; } = [];
    public PlaylistSettings Settings { get; set; } = new();
    public string? Name { get; set; }
}
