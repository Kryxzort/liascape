using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Helpers;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.FileProviders;

namespace Liascape.Web;

#pragma warning disable CA1416 // Unix file modes: this backend is Linux-only

// The loopback API is the app's own. Loopback is NOT private:
// every web page open in the user's browser can send requests to 127.0.0.1 (and read the answers when CORS lets it, or
// via DNS rebinding), and every other local user can connect. So (.claude/rules/backend/api.md § Security):
//  • a secret token in ~/.config/liascape/serve.token (0600, beside serve.port) on every request — header
//    X-Liascape-Token, or ?token= on a GET (an <img>/<video> src, the WebSocket) — the static UI files and /health excepted;
//  • the Host header must be 127.0.0.1:<port> / localhost:<port> (DNS rebinding: a foreign name pointing at us);
//  • a cross-origin request only from the dev UI's origin (Vite :5173 — only while this backend serves no UI itself) or
//    LIASCAPE_DEV_ORIGINS; any other Origin is refused outright;
//  • local files only from where the app keeps / finds wallpapers (MediaAllowed), remote fetches only to public addresses
//    (PublicOnlyHttp — the image proxy never reaches the LAN or this machine).
public static class ApiSecurity
{
    public const string Header = "X-Liascape-Token";
    public const string Query = "token";

    private static string ConfigDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "liascape");
    public static string TokenPath => Path.Combine(ConfigDir, "serve.token");

    private static byte[] _token = [];
    private static readonly Regex TokenShape = new("^[A-Za-z0-9_-]{43}$", RegexOptions.Compiled);

    // serve's startup, before Kestrel listens. The token in the file is reused while it's well-formed and private (0600): a
    // backend restarted under an open page (dotnet watch, the matrix's restart cells) keeps answering it; the Electron shell
    // deletes the file before it starts its own backend, so every app launch gets a fresh one.
    public static void InitToken()
    {
        string? tok = null;
        try
        {
            if (File.Exists(TokenPath)
                && (File.GetUnixFileMode(TokenPath) & (UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.OtherRead | UnixFileMode.OtherWrite)) == 0)
            {
                var t = File.ReadAllText(TokenPath).Trim();
                if (TokenShape.IsMatch(t)) tok = t;
            }
        }
        catch { }
        tok ??= Base64Url(RandomNumberGenerator.GetBytes(32));
        _token = Encoding.ASCII.GetBytes(tok);
        EnsurePrivateDir(ConfigDir);
        WritePrivate(TokenPath, tok + "\n");
    }

    // CLI side (ActionForward): what a running backend expects; null when there's no file.
    public static string? ReadToken()
    {
        try { var t = File.ReadAllText(TokenPath).Trim(); return t.Length > 0 ? t : null; } catch { return null; }
    }

    public static void EnsurePrivateDir(string dir)
    {
        if (!Directory.Exists(dir)) Directory.CreateDirectory(dir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    // temp file created 0600 (never readable by others, not even for a moment) and renamed over `path`
    public static void WritePrivate(string path, string text)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(path))!;
        Directory.CreateDirectory(dir);
        var tmp = Path.Combine(dir, $".{Path.GetFileName(path)}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp");
        try
        {
            using (var fs = new FileStream(tmp, new FileStreamOptions
            {
                Mode = FileMode.CreateNew, Access = FileAccess.Write,
                UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
            }))
            using (var w = new StreamWriter(fs, new UTF8Encoding(false))) w.Write(text);
            File.Move(tmp, path, overwrite: true);
        }
        finally { try { if (File.Exists(tmp)) File.Delete(tmp); } catch { } }
    }

    private static string Base64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static bool TokenOk(string? presented) =>
        presented is { Length: > 0 } && _token.Length > 0
        && CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(presented), _token);

    // ---- origins -----------------------------------------------------------------------------------------------------
    // The dev UI (Vite) lives on another origin; it's allowed only while this backend serves no UI of its own (no
    // LIASCAPE_UI_DIR: `dotnet watch -- serve`, `dotnet run -- serve`) — production loads the UI same-origin and allows
    // none. LIASCAPE_DEV_ORIGINS (comma list) adds more ("null" = a file:// page — the UI matrix's restart:initDown).
    private static HashSet<string> _devOrigins = new(StringComparer.OrdinalIgnoreCase);

    public static void InitOrigins(bool servesUi)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (!servesUi) { set.Add("http://localhost:5173"); set.Add("http://127.0.0.1:5173"); }
        foreach (var o in (Environment.GetEnvironmentVariable("LIASCAPE_DEV_ORIGINS") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            set.Add(o.TrimEnd('/'));
        _devOrigins = set;
    }

    private static bool HostOk(string host, int port) =>
        string.Equals(host, $"127.0.0.1:{port}", StringComparison.OrdinalIgnoreCase)
        || string.Equals(host, $"localhost:{port}", StringComparison.OrdinalIgnoreCase);

    // ---- the middleware ------------------------------------------------------------------------------------------------
    // First in the pipeline. `ui` = the static UI's file provider (its files need no token: they're the public bundle, and
    // the page they make gets the token from its URL — app/shell/main.js).
    public static async Task Guard(HttpContext ctx, Func<Task> next, IFileProvider? ui)
    {
        var req = ctx.Request; var res = ctx.Response;
        int port = ctx.Connection.LocalPort;
        // DNS rebinding: evil.example resolving to 127.0.0.1 arrives with Host: evil.example:<port>
        if (!HostOk(req.Host.Value ?? "", port)) { await Refuse(ctx, 403, "unexpected Host header"); return; }

        res.Headers["X-Content-Type-Options"] = "nosniff";
        res.Headers["X-Frame-Options"] = "DENY";
        var path = req.Path.Value ?? "/";
        // served bytes from disk / the internet: never a document with this origin's rights, should one be opened
        if (path is "/media" or "/clip" or "/img" or "/anim" or "/still") res.Headers["Content-Security-Policy"] = "sandbox; default-src 'none'";

        var origin = req.Headers.Origin.ToString();
        if (origin.Length > 0 && !HostOk(OriginHost(origin) ?? "", port))
        {
            if (!_devOrigins.Contains(origin.TrimEnd('/'))) { await Refuse(ctx, 403, "origin not allowed"); return; }
            res.Headers["Access-Control-Allow-Origin"] = origin;
            res.Headers.Append("Vary", "Origin");
            if (HttpMethods.IsOptions(req.Method) && req.Headers.ContainsKey("Access-Control-Request-Method"))
            {
                // a preflight never carries the token (no custom header values) — answered here, before the token check
                res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
                res.Headers["Access-Control-Allow-Headers"] = $"Content-Type, X-Liascape-Client, {Header}";
                res.Headers["Access-Control-Max-Age"] = "7200";
                res.StatusCode = 204;
                return;
            }
        }

        bool get = HttpMethods.IsGet(req.Method) || HttpMethods.IsHead(req.Method);
        bool open = get && (path == "/health" || IsUiFile(ui, path));
        if (!open)
        {
            string? presented = req.Headers[Header].FirstOrDefault();
            // a query token only on a GET: an <img>/<video> src and the WebSocket can't send headers; a write must use the
            // header (a page on another origin can't set one without a preflight it doesn't pass)
            if (string.IsNullOrEmpty(presented) && get) presented = req.Query[Query].FirstOrDefault();
            if (!TokenOk(presented)) { await Refuse(ctx, 401, $"missing or wrong API token ({Header}; see ~/.config/liascape/serve.token)"); return; }
        }
        await next();
    }

    private static string? OriginHost(string origin) =>
        Uri.TryCreate(origin, UriKind.Absolute, out var u) && u.Scheme == "http" ? $"{u.Host}:{u.Port}" : null;

    private static bool IsUiFile(IFileProvider? ui, string path)
    {
        if (ui == null) return false;
        if (path == "/") return true;
        if (path.Contains("..", StringComparison.Ordinal)) return false;
        try { var f = ui.GetFileInfo(path); return f.Exists && !f.IsDirectory; } catch { return false; }
    }

    private static async Task Refuse(HttpContext ctx, int status, string error)
    {
        ctx.Response.StatusCode = status;
        await ctx.Response.WriteAsJsonAsync(new { error });
    }

    // ---- local files ---------------------------------------------------------------------------------------------------
    // /media, /clip, /anim and /still (local), /library/duration and /open's reveal: only paths where the app keeps or finds
    // wallpapers — its data dir (the library, incl. its links into Steam's folders), its caches, the Wallpaper Engine
    // Workshop folder from the settings. Never a `..` segment (a lexical check can't see where `..` lands after a symlink —
    // the library's workshop items ARE symlinks); symlinks inside the roots are followed (the app made them).
    public static bool MediaAllowed(string? path)
    {
        if (string.IsNullOrEmpty(path) || path[0] != '/' || path.Contains('\0')) return false;
        if (path.Split('/').Any(s => s == "..")) return false;
        string full;
        try { full = Path.GetFullPath(path); } catch { return false; }
        bool Under(bool fresh) => MediaRoots(fresh).Any(r => full == r || full.StartsWith(r + "/", StringComparison.Ordinal));
        // a miss re-reads the Workshop folder first: just changed in Settings, the cached one would leave its thumbnails blank
        return Under(fresh: false) || Under(fresh: true);
    }

    private static (DateTime At, string? Folder) _weFolder;
    private static IEnumerable<string> MediaRoots(bool fresh)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var xdgCache = Environment.GetEnvironmentVariable("XDG_CACHE_HOME");
        var roots = new List<string>
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "liascape"),
            Path.Combine(home, ".cache", "liascape"),
        };
        if (!string.IsNullOrEmpty(xdgCache)) roots.Add(Path.Combine(xdgCache, "liascape"));
        // the settings are read per request elsewhere; a grid asks /media per card, so the folder is cached 2 s
        var we = _weFolder;
        if (fresh || DateTime.UtcNow - we.At > TimeSpan.FromSeconds(2))
        {
            we = (DateTime.UtcNow, SettingsService.Load().WorkshopFolder);
            _weFolder = we;
        }
        if (!string.IsNullOrWhiteSpace(we.Folder) && we.Folder.StartsWith('/')) roots.Add(we.Folder);
        foreach (var r in roots)
        {
            string full;
            try { full = Path.GetFullPath(r).TrimEnd('/'); } catch { continue; }
            if (full.Length > 1) yield return full; // never "/" (a WorkshopFolder of "/" would open everything)
        }
    }

    // ---- remote fetches --------------------------------------------------------------------------------------------------
    // The image proxy (/img) and the remote /anim + /still fetch what the page names: http(s) only, and only to public
    // addresses — never this machine or the LAN (a page could otherwise make the backend fetch the router's admin page, a
    // local service, cloud metadata). Checked twice: up front (a clear 403) and at every connect (DNS rebinding between the
    // two, a redirect to a private address). No proxy: a local proxy would be refused by the same rule.
    public static HttpClient PublicOnlyHttp(TimeSpan timeout) => new(new SocketsHttpHandler
    {
        UseProxy = false,
        ConnectCallback = async (ctx, ct) =>
        {
            var addrs = await ResolvePublic(ctx.DnsEndPoint.Host, ct)
                ?? throw new HttpRequestException($"refused: {ctx.DnsEndPoint.Host} is not a public address");
            Exception? last = null;
            foreach (var a in addrs)
            {
                var s = new Socket(a.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try { await s.ConnectAsync(new IPEndPoint(a, ctx.DnsEndPoint.Port), ct); return new NetworkStream(s, ownsSocket: true); }
                catch (Exception e) { s.Dispose(); last = e; }
            }
            throw last ?? new HttpRequestException("no address");
        },
    }) { Timeout = timeout };

    // null = refuse (not http(s), unresolvable, or ANY of its addresses is not public)
    public static async Task<string?> CheckPublicUrl(string? url, CancellationToken ct = default)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https")) return "only http(s) URLs";
        return await ResolvePublic(u.IdnHost, ct) == null ? $"{u.Host} is not a public address" : null;
    }

    private static async Task<IPAddress[]?> ResolvePublic(string host, CancellationToken ct)
    {
        IPAddress[] addrs;
        try { addrs = IPAddress.TryParse(host.Trim('[', ']'), out var ip) ? [ip] : await Dns.GetHostAddressesAsync(host, ct); }
        catch { return null; }
        return addrs.Length > 0 && addrs.All(IsPublic) ? addrs : null;
    }

    public static bool IsPublic(IPAddress a)
    {
        if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
        if (a.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = a.GetAddressBytes();
            return !(b[0] == 0 || b[0] == 10 || b[0] == 127 || b[0] >= 224
                || (b[0] == 100 && b[1] >= 64 && b[1] < 128)     // CGNAT
                || (b[0] == 169 && b[1] == 254)                  // link-local (cloud metadata)
                || (b[0] == 172 && b[1] >= 16 && b[1] < 32)
                || (b[0] == 192 && b[1] == 168)
                || (b[0] == 192 && b[1] == 0 && b[2] == 0)
                || (b[0] == 198 && (b[1] == 18 || b[1] == 19)));
        }
        if (a.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (a.Equals(IPAddress.IPv6Loopback) || a.Equals(IPAddress.IPv6None) || a.IsIPv6LinkLocal || a.IsIPv6SiteLocal || a.IsIPv6Multicast) return false;
            var b = a.GetAddressBytes();
            if ((b[0] & 0xfe) == 0xfc) return false;             // unique local fc00::/7
            if (b[0] == 0 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b) return false; // NAT64 (wraps an IPv4)
            return true;
        }
        return false;
    }
}
