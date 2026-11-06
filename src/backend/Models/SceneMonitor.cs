namespace Liascape.Models;

public class SceneMonitor
{
    public string Name { get; set; } = "";
    public int Fps { get; set; } = 15; // WE's own default fps (wallpaper64.exe: 15 when unset; first-run preset "medium" = 15)
    public bool IsPrimary { get; set; } = false;
}
