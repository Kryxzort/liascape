using System.Collections.Generic;

namespace livepaper.Models;

public enum PlaylistOrder { Sequential, Shuffle }

public class PlaylistSettings
{
    public PlaylistOrder Order { get; set; } = PlaylistOrder.Sequential;
    public bool OverrideGlobalSettings { get; set; } = false;
    public int IntervalSeconds { get; set; } = 1800;
    public bool AdvanceOnVideoEnd { get; set; } = true;
    public bool WaitForVideoEnd { get; set; } = false;

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
