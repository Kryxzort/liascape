namespace Liascape.Models;

public class SceneMonitor
{
    public string Name { get; set; } = "";
    public int Fps { get; set; } = 30;
    public bool IsPrimary { get; set; } = false;
}
