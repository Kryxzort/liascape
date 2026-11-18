using System.Collections.Generic;

namespace Liascape.Models;

// One folder the library follows (AppSettings.WatchedFolders, Web/FolderWatch.cs).
public class WatchedFolder
{
    public string Path { get; set; } = "";
    // "Copy files instead of linking", per folder: copies what it imports from then on; what it already brought in keeps its form
    public bool Copy { get; set; } = false;
    // the sources the user left unticked when the folder was added: never imported by the watch
    public List<string> Skip { get; set; } = [];
}
