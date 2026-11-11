using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Liascape.Models;

namespace Liascape.Helpers;

// Workshop through the RUNNING Steam client, the way Wallpaper Engine itself does it (owner 2026-11-11: "do you think we could
// like embed steam or like drive steam" → "yeah, try it"). Steam's ISteamUGC lets a program that is "the game" subscribe to
// an item and read Steam's own download progress (bytes done / total) and the item's real install folder. Opt-in
// (`WorkshopDownloadMode` "steamapp", Settings "Use the Steam app" — owner 2026-11-11 "why is this a checkbox": a third way
// to get wallpapers, so a third radio, not a switch inside "Subscribe via Steam"): the helper presents itself as Wallpaper Engine (431960) — Steam checks the account
// owns it, and shows "Playing Wallpaper Engine" while connected.
//
// - Straight through the Steam client's OWN steamclient.so (every Steam install has it: ~/.steam/sdk64/steamclient.so) —
//   NOT Valve's libsteam_api.so, which is only a thin adapter over it and isn't ours to ship (owner: "what if other users dont
//   got steamvr?" — a copy came only with SteamVR / old Protons). steamclient.so exports CreateInterface; the interfaces
//   are C++ vtables called by SLOT. The slots are Valve's public interface versions, which Steam keeps serving for old games;
//   read from Valve's own libsteam_api wrappers (objdump: `mov (%rdi),%rax; jmp *0x220(%rax)` = slot 68), not guessed:
//   ISteamClient "SteamClient020" CreateSteamPipe 0, BReleaseSteamPipe 1, ConnectToGlobalUser 2, ReleaseUser 4,
//   GetISteamGenericInterface 12; ISteamUGC "STEAMUGC_INTERFACE_VERSION018" SubscribeItem 68, UnsubscribeItem 69, GetItemState 72,
//   GetItemInstallInfo 73, GetItemDownloadInfo 74.
// - In a SHORT-LIVED CHILD (`liascape-backend steam-ugc subscribe <id> <steamclient.so>…`, SteamAppId=431960 in ITS
//   environment only): connected for the download's seconds, not the backend's lifetime, and a crash in Steam's library
//   can't take the backend down. JSON lines on stdout; the parent closes its stdin to stop it (release → exit).
// - Any failure before Steam accepts the subscribe (Steam not running, WE not owned) → null + the reason, and the caller
//   falls back to the existing paths (the signed-in web subscribe / the item's page in the Steam app).
// - ONE subscribe/unsubscribe child at a time, app-wide (`Turn`; a bulk download waits with "Waiting for the Steam app…").
//   `steam-ugc probe` (connect, release, exit) answers the Steam to-do's "Let the Steam app do all N" (Web/SteamTodo.cs).
// Measured on the owner's machine (prototype, 2026-11-11): a 2.1 MB item subscribed 0.5 s, bytes 0.8 → 1.1 → 2.1 MB,
// installed 4.5 s, the folder on the library Steam chose (/mnt/Games/… — no symlink guessing).
public static class SteamClientUgc
{
    public const uint WallpaperEngineAppId = 431960;
    const uint StateSubscribed = 1, StateInstalled = 4, StateNeedsUpdate = 8, StateDownloading = 16, StateDownloadPending = 32;

    // ---- the parent side ---------------------------------------------------------------------------------------------

    /// The Steam client's steamclient.so, most likely first (existing files only; nothing is loaded here).
    public static List<string> Candidates(AppSettings s)
    {
        var list = new List<string>();
        void Add(string? p) { if (!string.IsNullOrWhiteSpace(p) && File.Exists(p) && !list.Contains(p)) list.Add(p); }
        Add(s.SteamClientLibPath);
        Add(Environment.GetEnvironmentVariable("LIASCAPE_STEAM_CLIENT_LIB")); // the hermetic test's fake
        if (list.Count > 0) return list; // an explicit choice is the only one
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        Add(Path.Combine(home, ".steam/sdk64/steamclient.so"));                  // what libsteam_api itself loads
        Add(Path.Combine(home, ".local/share/Steam/linux64/steamclient.so"));
        Add(Path.Combine(home, ".steam/steam/linux64/steamclient.so"));
        Add(Path.Combine(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam/linux64/steamclient.so")); // Flatpak
        return list;
    }

    public sealed record Result(string? Folder, string? Fallback);

    /// What the user reads when the Steam app couldn't do it — the mode FAILS there, it never switches to the sign-in or the
    /// page (owner 2026-11-11: "instead of fallbacks for when direct steam connection fails, i want failures there").
    public static string FailureMessage(string? why) =>
        $"Couldn't use the Steam app: {(string.IsNullOrWhiteSpace(why) ? "Steam didn't answer" : why)}. Start Steam (signed in to an " +
        "account that owns Wallpaper Engine), or pick another way under Settings → Getting Workshop wallpapers.";

    /// Subscribe + wait for Steam to install it. Folder = done; Fallback = why this route couldn't be used (the caller
    /// carries on the old way). Throws only for cancellation and for failures AFTER Steam took the subscribe.
    public static async Task<Result> SubscribeAsync(string workshopId, AppSettings s, IProgress<(double, string)>? progress, CancellationToken ct)
    {
        await TakeTurnAsync(progress, ct);
        try { return await SubscribeCoreAsync(workshopId, s, progress, ct); }
        finally { Turn.Release(); }
    }

    /// The card's words while a download waits for its turn with the Steam client (another helper is running).
    public const string WaitingForSteamApp = "Waiting for the Steam app…";

    // ONE helper child at a time, app-wide (a bulk download under "Use the Steam app" spawned a child per item at once — N
    // processes each presenting themselves as Wallpaper Engine to one Steam client). The queued ones say so on their card.
    // The connect-only probe (ProbeAsync) is exempt: it holds no turn's worth of work and must answer while a long download runs.
    static readonly SemaphoreSlim Turn = new(1, 1);
    static async Task TakeTurnAsync(IProgress<(double, string)>? progress, CancellationToken ct)
    {
        if (Turn.Wait(0)) return;
        progress?.Report((-1, WaitingForSteamApp));
        await Turn.WaitAsync(ct);
    }

    static async Task<Result> SubscribeCoreAsync(string workshopId, AppSettings s, IProgress<(double, string)>? progress, CancellationToken ct)
    {
        var libs = Candidates(s);
        if (libs.Count == 0) return new(null, "the Steam client's steamclient.so wasn't found — is Steam installed?");
        var self = PlayerHelper.GetSelfInvocationArgs();
        if (self.Count == 0) return new(null, "can't start the helper");
        var psi = new ProcessStartInfo(self[0]) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var a in self.Skip(1)) psi.ArgumentList.Add(a);
        psi.ArgumentList.Add("steam-ugc"); psi.ArgumentList.Add("subscribe"); psi.ArgumentList.Add(workshopId);
        foreach (var l in libs) psi.ArgumentList.Add(l);
        psi.Environment["SteamAppId"] = WallpaperEngineAppId.ToString();
        psi.Environment["SteamGameId"] = WallpaperEngineAppId.ToString();
        psi.Environment.Remove("LD_LIBRARY_PATH"); // the backend's (a dev shell's) must not shadow Steam's client library's

        progress?.Report((-1, "Subscribing through Steam…"));
        using var proc = Process.Start(psi);
        if (proc == null) return new(null, "can't start the helper");
        _ = proc.StandardError.ReadToEndAsync(); // drained; Valve's library chats on stderr
        bool accepted = false; string? folder = null, error = null; var shown = "";
        using var reg = ct.Register(() => { try { proc.StandardInput.Close(); } catch { } }); // the child shuts down + exits
        try
        {
            string? line;
            while ((line = await proc.StandardOutput.ReadLineAsync()) != null)
            {
                JsonElement e;
                try { e = JsonDocument.Parse(line).RootElement; } catch { continue; }
                switch (e.GetProperty("event").GetString())
                {
                    case "subscribed": accepted = true; break;
                    case "progress":
                        long done = e.GetProperty("done").GetInt64(), total = e.GetProperty("total").GetInt64();
                        if (total > 0) { shown = "bytes"; progress?.Report((Math.Clamp((double)done / total, 0.001, 0.999), WorkshopDownloader.SteamDownloading)); }
                        // 0 / 0 before the first byte = queued; after it = installed (Steam zeroes it) — never "waiting" again
                        else if (shown == "") { shown = "wait"; progress?.Report((-1, "Waiting for Steam…")); }
                        break;
                    case "installed": folder = e.GetProperty("folder").GetString(); break;
                    case "error": error = e.GetProperty("message").GetString(); break;
                }
            }
        }
        finally
        {
            if (!proc.WaitForExit(3000)) { try { proc.Kill(); } catch { } } // a wedged library: it had its chance to shut down
        }
        ct.ThrowIfCancellationRequested();
        if (folder != null) return new(folder, null);
        if (!accepted) return new(null, error ?? "Steam didn't answer");
        throw new InvalidOperationException($"Steam took the subscription but didn't install it: {error ?? "no reason given"}");
    }

    /// Unsubscribe through the running Steam client. Done = the ids Steam confirmed (no longer subscribed); Fallback = why the
    /// Steam client couldn't be used at all (the caller carries on the old way for every id); ids neither done nor failed-
    /// with-a-connection are the caller's to retry the old way too.
    public static async Task<(HashSet<string> Done, string? Fallback)> UnsubscribeAsync(IReadOnlyList<string> ids, AppSettings s,
        Action<string>? onDone, CancellationToken ct)
    {
        await TakeTurnAsync(null, ct);
        try { return await UnsubscribeCoreAsync(ids, s, onDone, ct); }
        finally { Turn.Release(); }
    }

    /// Can the Steam client be used right now (running, signed in to an account that owns Wallpaper Engine)? A helper that only
    /// connects and lets go (`steam-ugc probe`) — the Steam to-do's "Let the Steam app do all N" asks before it converts
    /// anything, so a Steam that can't answer leaves the to-do as it was. Null = yes; else why not.
    public static async Task<string?> ProbeAsync(AppSettings s, CancellationToken ct)
    {
        var libs = Candidates(s);
        if (libs.Count == 0) return "the Steam client's steamclient.so wasn't found — is Steam installed?";
        var self = PlayerHelper.GetSelfInvocationArgs();
        if (self.Count == 0) return "can't start the helper";
        var psi = new ProcessStartInfo(self[0]) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var a in self.Skip(1)) psi.ArgumentList.Add(a);
        psi.ArgumentList.Add("steam-ugc"); psi.ArgumentList.Add("probe");
        foreach (var l in libs) psi.ArgumentList.Add(l);
        psi.Environment["SteamAppId"] = WallpaperEngineAppId.ToString();
        psi.Environment["SteamGameId"] = WallpaperEngineAppId.ToString();
        psi.Environment.Remove("LD_LIBRARY_PATH");
        using var proc = Process.Start(psi);
        if (proc == null) return "can't start the helper";
        _ = proc.StandardError.ReadToEndAsync();
        try { proc.StandardInput.Close(); } catch { }
        string? why = "Steam didn't answer";
        try
        {
            using var to = CancellationTokenSource.CreateLinkedTokenSource(ct);
            to.CancelAfter(15000);
            string? line;
            while ((line = await proc.StandardOutput.ReadLineAsync(to.Token)) != null)
            {
                JsonElement e;
                try { e = JsonDocument.Parse(line).RootElement; } catch { continue; }
                var ev = e.GetProperty("event").GetString();
                if (ev == "ready") why = null;
                else if (ev == "error") why = e.GetProperty("message").GetString() ?? why;
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
        finally { if (!proc.WaitForExit(3000)) { try { proc.Kill(); } catch { } } }
        return why;
    }

    static async Task<(HashSet<string> Done, string? Fallback)> UnsubscribeCoreAsync(IReadOnlyList<string> ids, AppSettings s,
        Action<string>? onDone, CancellationToken ct)
    {
        var done = new HashSet<string>();
        var libs = Candidates(s);
        if (libs.Count == 0) return (done, "the Steam client's steamclient.so wasn't found — is Steam installed?");
        var self = PlayerHelper.GetSelfInvocationArgs();
        if (self.Count == 0) return (done, "can't start the helper");
        var psi = new ProcessStartInfo(self[0]) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var a in self.Skip(1)) psi.ArgumentList.Add(a);
        psi.ArgumentList.Add("steam-ugc"); psi.ArgumentList.Add("unsubscribe"); psi.ArgumentList.Add(string.Join(",", ids));
        foreach (var l in libs) psi.ArgumentList.Add(l);
        psi.Environment["SteamAppId"] = WallpaperEngineAppId.ToString();
        psi.Environment["SteamGameId"] = WallpaperEngineAppId.ToString();
        psi.Environment.Remove("LD_LIBRARY_PATH");
        using var proc = Process.Start(psi);
        if (proc == null) return (done, "can't start the helper");
        _ = proc.StandardError.ReadToEndAsync();
        string? error = null;
        using var reg = ct.Register(() => { try { proc.StandardInput.Close(); } catch { } });
        try
        {
            string? line;
            while ((line = await proc.StandardOutput.ReadLineAsync()) != null)
            {
                JsonElement e;
                try { e = JsonDocument.Parse(line).RootElement; } catch { continue; }
                var ev = e.GetProperty("event").GetString();
                if (ev == "unsubscribed" && e.GetProperty("id").GetString() is string id) { done.Add(id); onDone?.Invoke(id); }
                else if (ev == "error") error = e.GetProperty("message").GetString();
            }
        }
        finally { if (!proc.WaitForExit(3000)) { try { proc.Kill(); } catch { } } }
        return (done, done.Count == 0 && error != null ? error : null);
    }

    // ---- the child side (`steam-ugc …`, its own process) -------------------------------------------------------------

    const int ClientCreatePipe = 0, ClientReleasePipe = 1, ClientConnectUser = 2, ClientReleaseUser = 4, ClientGenericInterface = 12;
    const int UgcSubscribe = 68, UgcUnsubscribe = 69, UgcState = 72, UgcInstallInfo = 73, UgcDownloadInfo = 74;

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr CreateInterfaceFn([MarshalAs(UnmanagedType.LPStr)] string version, IntPtr ret);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int PipeFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int UserFn(IntPtr self, int pipe);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr GenericFn(IntPtr self, int user, int pipe, [MarshalAs(UnmanagedType.LPStr)] string version);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void ReleaseUserFn(IntPtr self, int pipe, int user);
    // C++ `bool` is ONE byte: without I1 the marshaller reads a 4-byte BOOL (garbage in the upper bytes → true)
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool ReleasePipeFn(IntPtr self, int pipe);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate ulong SubscribeFn(IntPtr self, ulong id);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate uint StateFn(IntPtr self, ulong id);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool DlInfoFn(IntPtr self, ulong id, out ulong done, out ulong total);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool InstallInfoFn(IntPtr self, ulong id, out ulong size, byte[] folder, uint folderSize, out uint timestamp);
    // steamclient.so's own exports: the pipe's callback queue (drained so it never grows while we poll)
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool GetCallbackFn(int pipe, IntPtr msg);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool FreeCallbackFn(int pipe);

    static void Emit(object o) { Console.Out.WriteLine(JsonSerializer.Serialize(o)); Console.Out.Flush(); }

    // a C++ virtual call: the object's first word is its vtable; slot i is the i-th function pointer, `this` the first argument
    static T Slot<T>(IntPtr obj, int i) where T : Delegate
        => Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), i * IntPtr.Size));

    sealed record Session(IntPtr Client, IntPtr Lib, int Pipe, int User, IntPtr Ugc);

    // load steamclient.so, connect to the running Steam as this process's SteamAppId, get ISteamUGC; null + the reason
    static Session? Connect(IEnumerable<string> libs, out string why)
    {
        why = "the Steam client's steamclient.so couldn't be loaded";
        IntPtr client = IntPtr.Zero, lib = IntPtr.Zero;
        foreach (var path in libs)
        {
            if (!NativeLibrary.TryLoad(path, out var h)) { why = $"{path}: can't load"; continue; }
            if (!NativeLibrary.TryGetExport(h, "CreateInterface", out var ci)) { why = $"{path}: not Steam's client library"; NativeLibrary.Free(h); continue; }
            client = Marshal.GetDelegateForFunctionPointer<CreateInterfaceFn>(ci)("SteamClient020", IntPtr.Zero);
            if (client == IntPtr.Zero) { why = $"{path}: no SteamClient020"; NativeLibrary.Free(h); continue; }
            lib = h; break;
        }
        if (client == IntPtr.Zero) return null;
        int pipe = Slot<PipeFn>(client, ClientCreatePipe)(client);
        int user = pipe == 0 ? 0 : Slot<UserFn>(client, ClientConnectUser)(client, pipe);
        if (pipe == 0 || user == 0)
        {
            if (pipe != 0) Slot<ReleasePipeFn>(client, ClientReleasePipe)(client, pipe);
            why = "Steam isn't running, or this account doesn't own Wallpaper Engine"; return null;
        }
        var ugc = Slot<GenericFn>(client, ClientGenericInterface)(client, user, pipe, "STEAMUGC_INTERFACE_VERSION018");
        if (ugc == IntPtr.Zero) { Release(new Session(client, lib, pipe, user, IntPtr.Zero)); why = "this Steam has no STEAMUGC_INTERFACE_VERSION018"; return null; }
        return new Session(client, lib, pipe, user, ugc);
    }

    static void Release(Session s)
    {
        Slot<ReleaseUserFn>(s.Client, ClientReleaseUser)(s.Client, s.Pipe, s.User);
        Slot<ReleasePipeFn>(s.Client, ClientReleasePipe)(s.Client, s.Pipe);
    }

    // drain the pipe's callback queue so it never grows while we poll
    static Action Pump(Session s)
    {
        GetCallbackFn? getCb = NativeLibrary.TryGetExport(s.Lib, "Steam_BGetCallback", out var g) ? Marshal.GetDelegateForFunctionPointer<GetCallbackFn>(g) : null;
        FreeCallbackFn? freeCb = NativeLibrary.TryGetExport(s.Lib, "Steam_FreeLastCallback", out var f) ? Marshal.GetDelegateForFunctionPointer<FreeCallbackFn>(f) : null;
        var msg = Marshal.AllocHGlobal(64); // CallbackMsg_t is 24 bytes — kept for the child's lifetime
        return () => { if (getCb != null && freeCb != null) for (int n = 0; n < 64 && getCb(s.Pipe, msg); n++) freeCb(s.Pipe); };
    }

    public static int RunChild(string[] args)
    {
        if (args.Length >= 2 && args[0] == "probe")
        {
            var probe = Connect(args.Skip(1), out var whyNot);
            if (probe == null) { Emit(new { @event = "error", message = whyNot }); return 3; }
            Release(probe);
            Emit(new { @event = "ready" });
            return 0;
        }
        if (args.Length < 3 || args[0] is not ("subscribe" or "unsubscribe"))
        { Emit(new { @event = "error", message = "usage: steam-ugc subscribe <id> | unsubscribe <id,id,…> | probe  <steamclient.so>…" }); return 2; }
        var ids = new List<ulong>();
        foreach (var part in args[1].Split(',', StringSplitOptions.RemoveEmptyEntries))
            if (ulong.TryParse(part, out var v)) ids.Add(v);
            else { Emit(new { @event = "error", message = $"not a Workshop id: {part}" }); return 2; }
        if (ids.Count == 0 || (args[0] == "subscribe" && ids.Count != 1)) { Emit(new { @event = "error", message = "one id to subscribe, one or more to unsubscribe" }); return 2; }

        var session = Connect(args.Skip(2), out var why);
        if (session == null) { Emit(new { @event = "error", message = why }); return 3; }
        // the parent closes our stdin to stop us (a cancel)
        var stop = new ManualResetEventSlim();
        new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch { } stop.Set(); }) { IsBackground = true }.Start();
        try { return args[0] == "subscribe" ? Subscribe(session, ids[0], stop) : Unsubscribe(session, ids, stop); }
        finally { Release(session); }
    }

    static int Unsubscribe(Session s, List<ulong> ids, ManualResetEventSlim stop)
    {
        var unsubscribe = Slot<SubscribeFn>(s.Ugc, UgcUnsubscribe); // same shape: SteamAPICall_t (this, id)
        var state = Slot<StateFn>(s.Ugc, UgcState);
        var pump = Pump(s);
        int failed = 0;
        foreach (var id in ids)
        {
            if (stop.IsSet) break;
            if ((state(s.Ugc, id) & StateSubscribed) == 0) { Emit(new { @event = "unsubscribed", id = id.ToString(), already = true }); continue; }
            unsubscribe(s.Ugc, id);
            var sw = Stopwatch.StartNew();
            bool gone = false;
            while (sw.Elapsed < TimeSpan.FromSeconds(10) && !stop.IsSet)
            {
                pump();
                if ((state(s.Ugc, id) & StateSubscribed) == 0) { gone = true; break; }
                stop.Wait(200);
            }
            if (gone) Emit(new { @event = "unsubscribed", id = id.ToString() });
            else { failed++; Emit(new { @event = "failed", id = id.ToString(), message = stop.IsSet ? "cancelled" : "Steam didn't confirm the unsubscribe within 10 s" }); }
        }
        return failed == 0 ? 0 : 1;
    }

    static int Subscribe(Session s, ulong id, ManualResetEventSlim stop)
    {
        int rc = 1;
        var subscribe = Slot<SubscribeFn>(s.Ugc, UgcSubscribe);
        var state = Slot<StateFn>(s.Ugc, UgcState);
        var dlInfo = Slot<DlInfoFn>(s.Ugc, UgcDownloadInfo);
        var install = Slot<InstallInfoFn>(s.Ugc, UgcInstallInfo);
        var pump = Pump(s);
        subscribe(s.Ugc, id);
        var sw = Stopwatch.StartNew();
        bool seen = false; string last = "";
        while (sw.Elapsed < TimeSpan.FromMinutes(30) && !stop.IsSet)
        {
            pump();
            uint st = state(s.Ugc, id);
            if (!seen && (st & StateSubscribed) != 0) { seen = true; Emit(new { @event = "subscribed" }); }
            dlInfo(s.Ugc, id, out var done, out var total);
            var now = $"{st}:{done}:{total}";
            if (now != last) { last = now; Emit(new { @event = "progress", state = st, done, total }); }
            if (seen && (st & StateInstalled) != 0 && (st & (StateDownloading | StateDownloadPending | StateNeedsUpdate)) == 0)
            {
                var buf = new byte[4096];
                if (install(s.Ugc, id, out var size, buf, (uint)buf.Length, out _))
                {
                    var folder = System.Text.Encoding.UTF8.GetString(buf, 0, Math.Max(0, Array.IndexOf(buf, (byte)0)));
                    Emit(new { @event = "installed", folder, size }); rc = 0; break;
                }
            }
            if (!seen && sw.Elapsed > TimeSpan.FromSeconds(20)) { Emit(new { @event = "error", message = "Steam didn't take the subscription" }); rc = 4; break; }
            stop.Wait(250);
        }
        if (rc == 1) Emit(new { @event = "error", message = stop.IsSet ? "cancelled" : "Steam didn't install it within 30 minutes" });
        return rc;
    }
}
