using System.Collections.Generic;

namespace Liascape.Models;

public class LastSession
{
    public bool IsPlaylist { get; set; }
    public bool IsTimedPlaylist { get; set; }
    public bool IsRandom { get; set; }
    public List<string> Paths { get; set; } = [];
    public bool Shuffle { get; set; }
    // Sane fallback (matches AppSettings.GlobalIntervalSeconds default) for
    // legacy session files written before this property existed.
    // AdvanceOnVideoEnd → TimedIntervalSeconds is the minimum play time, else the timer (PlayerHelper § Rotation)
    public int TimedIntervalSeconds { get; set; } = 1800;
    public bool AdvanceOnVideoEnd { get; set; }
    public bool OverrideGlobalSettings { get; set; }
}
