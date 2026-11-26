using System;
using System.IO;

namespace Liascape.Helpers;

// Liascape's own folders under the XDG base directories, the way every reader and writer of a file there finds it: a
// hermetic test moves them all by setting XDG_CONFIG_HOME / XDG_DATA_HOME. Not checked for existence (.NET's GetFolderPath
// answers "" for a base directory that doesn't exist yet, which would put the files in the working directory).
public static class AppDirs
{
    // $XDG_CONFIG_HOME/liascape (~/.config/liascape): settings.json, playlist_state.json, serve.port / serve.token
    public static string Config =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData, Environment.SpecialFolderOption.DoNotVerify), "liascape");

    // $XDG_DATA_HOME/liascape (~/.local/share/liascape): the library, the named playlists
    public static string Data =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.DoNotVerify), "liascape");
}
