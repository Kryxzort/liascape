using System.Collections.Generic;

namespace Liascape.Models;

// What `liascape restore` puts back when the player shows nothing (.claude/rules/backend/state-files.md § LastSession):
// the wallpaper last applied, or the playlist last played. A playlist's order, rotation and transitions are not kept
// here: a restore reads them from the playlist bar and the settings as they are then, like every live edit leaves them.
public class LastSession
{
    // the wallpaper, or the playlist's items in the bar's order
    public List<string> Paths { get; set; } = [];
    public bool Playlist { get; set; }
}
