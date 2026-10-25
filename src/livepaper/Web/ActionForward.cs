using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;

namespace livepaper.Web;

// `livepaper --action=<name>` (a keybind) is a one-shot process. While the app runs, its `--serve`
// backend owns the session — the single-wallpaper history, the in-process timer, the mute state, the
// UI's event socket — so the action is handed to it (`POST /action`) instead of being run here against
// a stale copy of that state (a keybind next/previous/random switched the wallpaper behind the UI's
// back: the UI kept marking the old one as playing). Run locally only when no backend answers.
public static class ActionForward
{
    // true = a backend took it (`code`/`message` = its outcome); false = none answered → run it here
    public static bool TryForward(string action, out int code, out string? message)
    {
        code = 0; message = null;
        if (ReadPort() is not int port) return false;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        long healthMs = -1;
        var url = $"http://127.0.0.1:{port}";
        // the port file outlives a crashed backend and the port can be reused: only a livepaper backend
        // answering /health counts
        try
        {
            using var probe = new HttpClient { Timeout = TimeSpan.FromMilliseconds(1500) };
            var h = probe.GetAsync($"{url}/health").GetAwaiter().GetResult();
            if (!h.IsSuccessStatusCode) return false;
            using var doc = JsonDocument.Parse(h.Content.ReadAsStringAsync().GetAwaiter().GetResult());
            if (!doc.RootElement.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True) return false;
            healthMs = sw.ElapsedMilliseconds;
        }
        catch { return false; }
        // From here the backend may have acted: never fall back to running it here too (a doubled
        // next skips a wallpaper, a doubled toggle undoes itself).
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            var r = http.PostAsJsonAsync($"{url}/action", new { name = action }).GetAwaiter().GetResult();
            if (sw.ElapsedMilliseconds > 1000) // a keybind should feel instant — say where the time went
                Console.Error.WriteLine($"livepaper --action={action}: slow — /health {healthMs} ms, /action {sw.ElapsedMilliseconds - healthMs} ms (process up {(DateTime.Now - System.Diagnostics.Process.GetCurrentProcess().StartTime).TotalMilliseconds:F0} ms)");
            if (r.IsSuccessStatusCode) return true;
            code = 1;
            try
            {
                using var doc = JsonDocument.Parse(r.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                message = doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : null;
            }
            catch { }
            message ??= $"the running app answered HTTP {(int)r.StatusCode}";
            return true;
        }
        catch (Exception e)
        {
            code = 1;
            message = $"the running app didn't answer ({e.GetType().Name}) — not run again here";
            return true;
        }
    }

    private static int? ReadPort()
    {
        try
        {
            var f = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "livepaper", "serve.port");
            return int.TryParse(File.ReadAllText(f).Trim(), out var p) && p is > 0 and < 65536 ? p : null;
        }
        catch { return null; }
    }
}
