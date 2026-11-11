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
//   GetISteamGenericInterface 12; ISteamUGC "STEAMUGC_INTERFACE_VERSION018" SubscribeItem 68, GetItemState 72,
//   GetItemInstallInfo 73, GetItemDownloadInfo 74.
// - In a SHORT-LIVED CHILD (`liascape-backend steam-ugc subscribe <id> <steamclient.so>…`, SteamAppId=431960 in ITS
//   environment only): connected for the download's seconds, not the backend's lifetime, and a crash in Steam's library
//   can't take the backend down. JSON lines on stdout; the parent closes its stdin to stop it (release → exit).
// - Any failure before Steam accepts the subscribe (Steam not running, WE not owned) → null + the reason, and the caller
//   falls back to the existing paths (the signed-in web subscribe / the item's page in the Steam app).
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

    /// Subscribe + wait for Steam to install it. Folder = done; Fallback = why this route couldn't be used (the caller
    /// carries on the old way). Throws only for cancellation and for failures AFTER Steam took the subscribe.
    public static async Task<Result> SubscribeAsync(string workshopId, AppSettings s, IProgress<(double, string)>? progress, CancellationToken ct)
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

    // ---- the child side (`steam-ugc …`, its own process) -------------------------------------------------------------

    const int ClientCreatePipe = 0, ClientReleasePipe = 1, ClientConnectUser = 2, ClientReleaseUser = 4, ClientGenericInterface = 12;
    const int UgcSubscribe = 68, UgcState = 72, UgcInstallInfo = 73, UgcDownloadInfo = 74;

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

    public static int RunChild(string[] args)
    {
        if (args.Length < 3 || args[0] != "subscribe" || !ulong.TryParse(args[1], out var id))
        { Emit(new { @event = "error", message = "usage: steam-ugc subscribe <workshop id> <steamclient.so>…" }); return 2; }

        IntPtr client = IntPtr.Zero, lib = IntPtr.Zero; string why = "the Steam client's steamclient.so couldn't be loaded";
        foreach (var path in args.Skip(2))
        {
            if (!NativeLibrary.TryLoad(path, out var h)) { why = $"{path}: can't load"; continue; }
            if (!NativeLibrary.TryGetExport(h, "CreateInterface", out var ci)) { why = $"{path}: not Steam's client library"; NativeLibrary.Free(h); continue; }
            client = Marshal.GetDelegateForFunctionPointer<CreateInterfaceFn>(ci)("SteamClient020", IntPtr.Zero);
            if (client == IntPtr.Zero) { why = $"{path}: no SteamClient020"; NativeLibrary.Free(h); continue; }
            lib = h; break;
        }
        if (client == IntPtr.Zero) { Emit(new { @event = "error", message = why }); return 3; }

        int pipe = Slot<PipeFn>(client, ClientCreatePipe)(client);
        int user = pipe == 0 ? 0 : Slot<UserFn>(client, ClientConnectUser)(client, pipe);
        if (pipe == 0 || user == 0)
        {
            if (pipe != 0) Slot<ReleasePipeFn>(client, ClientReleasePipe)(client, pipe);
            Emit(new { @event = "error", message = "Steam isn't running, or this account doesn't own Wallpaper Engine" }); return 3;
        }
        int rc = 1;
        var msg = Marshal.AllocHGlobal(64); // CallbackMsg_t is 24 bytes
        try
        {
            var ugc = Slot<GenericFn>(client, ClientGenericInterface)(client, user, pipe, "STEAMUGC_INTERFACE_VERSION018");
            if (ugc == IntPtr.Zero) { Emit(new { @event = "error", message = "this Steam has no STEAMUGC_INTERFACE_VERSION018" }); return 3; }
            var subscribe = Slot<SubscribeFn>(ugc, UgcSubscribe);
            var state = Slot<StateFn>(ugc, UgcState);
            var dlInfo = Slot<DlInfoFn>(ugc, UgcDownloadInfo);
            var install = Slot<InstallInfoFn>(ugc, UgcInstallInfo);
            GetCallbackFn? getCb = NativeLibrary.TryGetExport(lib, "Steam_BGetCallback", out var g) ? Marshal.GetDelegateForFunctionPointer<GetCallbackFn>(g) : null;
            FreeCallbackFn? freeCb = NativeLibrary.TryGetExport(lib, "Steam_FreeLastCallback", out var f) ? Marshal.GetDelegateForFunctionPointer<FreeCallbackFn>(f) : null;
            // the parent closes our stdin to stop us (a cancel)
            var stop = new ManualResetEventSlim();
            new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch { } stop.Set(); }) { IsBackground = true }.Start();

            subscribe(ugc, id);
            var sw = Stopwatch.StartNew();
            bool seen = false; string last = "";
            while (sw.Elapsed < TimeSpan.FromMinutes(30) && !stop.IsSet)
            {
                if (getCb != null && freeCb != null) for (int n = 0; n < 64 && getCb(pipe, msg); n++) freeCb(pipe);
                uint st = state(ugc, id);
                if (!seen && (st & StateSubscribed) != 0) { seen = true; Emit(new { @event = "subscribed" }); }
                dlInfo(ugc, id, out var done, out var total);
                var now = $"{st}:{done}:{total}";
                if (now != last) { last = now; Emit(new { @event = "progress", state = st, done, total }); }
                if (seen && (st & StateInstalled) != 0 && (st & (StateDownloading | StateDownloadPending | StateNeedsUpdate)) == 0)
                {
                    var buf = new byte[4096];
                    if (install(ugc, id, out var size, buf, (uint)buf.Length, out _))
                    {
                        var folder = System.Text.Encoding.UTF8.GetString(buf, 0, Math.Max(0, Array.IndexOf(buf, (byte)0)));
                        Emit(new { @event = "installed", folder, size }); rc = 0; break;
                    }
                }
                if (!seen && sw.Elapsed > TimeSpan.FromSeconds(20)) { Emit(new { @event = "error", message = "Steam didn't take the subscription" }); rc = 4; break; }
                stop.Wait(250);
            }
            if (rc == 1) Emit(new { @event = "error", message = stop.IsSet ? "cancelled" : "Steam didn't install it within 30 minutes" });
        }
        finally
        {
            Marshal.FreeHGlobal(msg);
            Slot<ReleaseUserFn>(client, ClientReleaseUser)(client, pipe, user);
            Slot<ReleasePipeFn>(client, ClientReleasePipe)(client, pipe);
        }
        return rc;
    }
}
