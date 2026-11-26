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

// Workshop through the RUNNING Steam client, the way Wallpaper Engine itself does it (docs/decisions.md § "Drive the Steam
// client through its own `steamclient.so`"). Steam's ISteamUGC lets a program that is "the game" subscribe to
// an item and read Steam's own download progress (bytes done / total) and the item's real install folder. The default way
// (`WorkshopDownloadMode` "steamapp", Settings "Use the Steam app"): the helper presents itself as Wallpaper Engine (431960)
// — Steam checks the account owns it, and shows "Playing Wallpaper Engine" while connected.
//
// - Straight through the Steam client's OWN steamclient.so (every Steam install has it: ~/.steam/sdk64/steamclient.so) —
//   NOT Valve's libsteam_api.so, which is only a thin adapter over it and isn't ours to ship (a user's copy comes only with
//   SteamVR / old Protons). steamclient.so exports CreateInterface; the interfaces
//   are C++ vtables called by SLOT. The slots are Valve's public interface versions, which Steam keeps serving for old games;
//   read from Valve's own libsteam_api wrappers (objdump: `mov (%rdi),%rax; jmp *0x220(%rax)` = slot 68), not guessed:
//   ISteamClient "SteamClient020" CreateSteamPipe 0, BReleaseSteamPipe 1, ConnectToGlobalUser 2, ReleaseUser 4,
//   GetISteamGenericInterface 12; ISteamUGC "STEAMUGC_INTERFACE_VERSION018" SubscribeItem 68, UnsubscribeItem 69, GetItemState 72,
//   GetItemInstallInfo 73, GetItemDownloadInfo 74, DownloadItem 75 (the slot after GetItemDownloadInfo in every version's
//   wrappers: 014 0x210 → 0x218, 021 0x270 → 0x278). The account's favourites (`favorites`): ISteamUGC 018
//   CreateQueryUserUGCRequest 0, SendQueryUGCRequest 4, GetQueryUGCResult 5, ReleaseQueryUGCRequest 19, SetReturnOnlyIDs 23
//   (017's order, which 018 keeps up to SubscribeItem 68: 014's wrappers have 0, 4, 5, 15, 19, and the four added before
//   ReleaseQueryUGCRequest are 017's tag and content-descriptor getters); "SteamUser021" BLoggedOn 1, GetSteamID 2 (a CSteamID
//   returned in RAX: the wrapper calls it with `this` in %rdi, no hidden return pointer); "SteamUtils010" IsAPICallCompleted
//   11, GetAPICallResult 13 (014-era wrappers: `jmp *0x58` / `jmp *0x68`).
// - In a CHILD SESSION (`liascape-backend steam-ugc session <steamclient.so>…`, SteamAppId=431960 in ITS environment only),
//   so a crash in Steam's library can't take the backend down: JSON commands on its stdin, JSON lines on its stdout; a
//   closed stdin = release Steam + exit. It stays connected between operations only while the user browses the Workshop,
//   plus a linger (Helpers/SteamClientHold.cs: one connection per visit, not a "Playing" blink per download).
// - Any failure before Steam accepts the subscribe (Steam not running, WE not owned) → null + the reason; the caller takes
//   the fallback order's next step (WorkshopDownloader.AcquireViaSubscribeAsync), or fails with `FailureMessage` where no step
//   is left (a one-off without a sign-in, the Steam to-do's "Let the Steam app do all N").
// - ONE child, ONE operation on it at a time, app-wide (`Turn`; a bulk download waits with "Waiting for the Steam app…").
//   `steam-ugc probe` (connect, release, exit) answers the Steam to-do's "Let the Steam app do all N" (Web/SteamTodo.cs)
//   when no session is connected.
// Measured (prototype): a 2.1 MB item subscribed 0.5 s, bytes 0.8 → 1.1 → 2.1 MB,
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

    /// What the user reads when the Steam app couldn't do it and no other step of the fallback order could take it.
    public static string FailureMessage(string? why) =>
        $"Couldn't use the Steam app: {(string.IsNullOrWhiteSpace(why) ? "Steam didn't answer" : why)}. Start Steam (signed in to an " +
        "account that owns Wallpaper Engine), or sign in to Steam under Settings → Getting Workshop wallpapers.";

    /// Subscribe + wait for Steam to install it. Folder = done; Fallback = why this route couldn't be used (the caller
    /// fails with it). Throws only for cancellation and for failures AFTER Steam took the subscribe.
    public static async Task<Result> SubscribeAsync(string workshopId, AppSettings s, IProgress<(double, string)>? progress, CancellationToken ct)
    {
        await TakeTurnAsync(progress, ct);
        RunResult r;
        try { r = await RunItemAsync("subscribe", workshopId, s, progress, "Subscribing through Steam…", ct); }
        finally { Turn.Release(); }
        if (r.Folder != null) return new(r.Folder, null);
        if (!r.Accepted) return new(null, r.Error ?? "Steam didn't answer");
        throw new InvalidOperationException($"Steam took the subscription but didn't install it: {r.Error ?? "no reason given"}");
    }

    /// What a download without subscribing got: Folder = Steam's install folder; WasSubscribed = the user had it subscribed
    /// already; Refused = Steam won't download it unsubscribed (the caller may subscribe instead); Fallback = why the Steam
    /// client couldn't be used at all.
    public sealed record DownloadResult(string? Folder, bool WasSubscribed, bool Refused, string? Fallback);

    /// ISteamUGC::DownloadItem: Steam fetches the item into its Workshop folder WITHOUT a subscription (and keeps it there for a
    /// while, never updating it), reporting its bytes like a subscribe. Throws only for cancellation and for failures after Steam
    /// took the download. Guard: test-steam-signin.sh § 3 j.
    public static async Task<DownloadResult> DownloadAsync(string workshopId, AppSettings s, IProgress<(double, string)>? progress, CancellationToken ct)
    {
        await TakeTurnAsync(progress, ct);
        RunResult r;
        try { r = await RunItemAsync("download", workshopId, s, progress, "Asking Steam for it…", ct); }
        finally { Turn.Release(); }
        if (r.Folder != null) return new(r.Folder, r.WasSubscribed, false, null);
        if (r.Refused) return new(null, r.WasSubscribed, true, null);
        if (!r.Accepted) return new(null, r.WasSubscribed, false, r.Error ?? "Steam didn't answer");
        throw new InvalidOperationException($"Steam took the download but didn't install it: {r.Error ?? "no reason given"}");
    }

    /// The card's words while a download waits for its turn with the Steam client (another helper is running).
    public const string WaitingForSteamApp = "Waiting for the Steam app…";

    // ONE operation on ONE helper child at a time, app-wide (N children each presenting themselves as Wallpaper Engine to one
    // Steam client is what a bulk download must never start); it also guards the child's start and release
    // (SteamClientHold). The queued ones say so on their card.
    // The connect-only probe (ProbeAsync) is exempt: it holds no turn's worth of work and must answer while a long download runs.
    internal static readonly SemaphoreSlim Turn = new(1, 1);
    static async Task TakeTurnAsync(IProgress<(double, string)>? progress, CancellationToken ct)
    {
        if (Turn.Wait(0)) return;
        progress?.Report((-1, WaitingForSteamApp));
        await Turn.WaitAsync(ct);
    }

    // what a command got: Accepted = Steam took the request (an unsubscribe: confirmed one); Folder = installed there
    sealed record RunResult(bool Accepted, string? Folder, string? Error, bool Refused, bool WasSubscribed);

    // One command on the held child (SteamClientHold: a reused one answered a ping first), with the turn held. What Steam
    // says to the command is its answer: a refusal or an unconfirmed unsubscribe never costs the held child.
    static async Task<RunResult> RunItemAsync(string verb, string workshopId, AppSettings s, IProgress<(double, string)>? progress, string asking, CancellationToken ct)
    {
        progress?.Report((-1, asking));
        var (child, why) = await SteamClientHold.AcquireAsync(s, ct);
        if (child == null) return new(false, null, why, false, false);
        var cmd = new CommandState();
        try { return await RunCommandAsync(child, verb, [workshopId], progress, null, cmd, ct); }
        finally { SteamClientHold.Done(child, drop: !cmd.Ended); }
    }

    // Ended = the child's `done` for this command was read. Anything else (it died, was killed, or reading threw mid-command)
    // leaves its stdout somewhere inside the command, so the child is dropped rather than handed to the next one.
    sealed class CommandState { public bool Ended; }

    // Sends one command and reads its lines up to its `done`. Ended = the child answered `done` (false: it died or was
    // killed on the way). A cancel asks the child to stop the command; one that doesn't answer within 3 s is killed.
    static async Task<RunResult> RunCommandAsync(SteamClientHold.Child child, string verb, IReadOnlyList<string> ids,
        IProgress<(double, string)>? progress, Action<string>? onUnsubscribed, CommandState cmd, CancellationToken ct, Action<JsonElement>? onOther = null)
    {
        bool accepted = false, refused = false, wasSubscribed = false, ended = false; string? folder = null, error = null; var shown = "";
        if (ct.IsCancellationRequested) { cmd.Ended = true; ct.ThrowIfCancellationRequested(); } // nothing sent: the child is as it was
        if (!child.Send(new { op = verb, ids })) return new(false, null, "the Steam app helper stopped", false, false);
        Timer? watchdog = null; int over = 0; var overGate = new object(); // 1 = the command is over: a late cancel's watchdog kills nothing; the gate keeps its check-and-kill from straddling the end
        using var reg = ct.Register(() =>
        {
            child.Send(new { op = "cancel" });
            watchdog = new Timer(_ => { lock (overGate) { if (over == 0) child.Kill(); } }, null, 3000, Timeout.Infinite);
        });
        try
        {
            while (await child.ReadAsync() is { } e)
            {
                switch (e.GetProperty("event").GetString())
                {
                    case "done": ended = cmd.Ended = true; break;
                    case "subscribed": case "accepted": accepted = true; break;
                    case "before": wasSubscribed = e.GetProperty("subscribed").GetBoolean(); break;
                    case "refused": refused = true; break;
                    case "unsubscribed": if (e.GetProperty("id").GetString() is string id) { accepted = true; onUnsubscribed?.Invoke(id); } break;
                    case "progress":
                        long done = e.GetProperty("done").GetInt64(), total = e.GetProperty("total").GetInt64();
                        if (total > 0) { shown = "bytes"; progress?.Report((Math.Clamp((double)done / total, 0.001, 0.999), WorkshopDownloader.SteamDownloading)); }
                        // 0 / 0 before the first byte = queued; after it = installed (Steam zeroes it) — never "waiting" again
                        else if (shown == "") { shown = "wait"; progress?.Report((-1, "Waiting for Steam…")); }
                        break;
                    case "installed": folder = e.GetProperty("folder").GetString(); break;
                    case "error": error = e.GetProperty("message").GetString(); break;
                    default: onOther?.Invoke(e); break;
                }
                if (ended) break;
            }
        }
        finally { lock (overGate) over = 1; watchdog?.Dispose(); }
        if (!ended) error ??= "the Steam app helper stopped";
        ct.ThrowIfCancellationRequested();
        return new(accepted, folder, error, refused, wasSubscribed);
    }

    /// Unsubscribe through the running Steam client. `claim` names the ids to send, asked once this caller has the Steam
    /// client's turn (WorkshopUnsubQueue.Claim): an Undo while it waited for the turn takes its id back and Steam never hears
    /// of it. Sent = what was claimed; Done = the ids Steam confirmed (no longer subscribed); Fallback = why the Steam client
    /// couldn't be used at all. `onDone` runs per confirmed id (WorkshopUnsubQueue.MarkBlocked ends its claim); the claim of
    /// one sent but not confirmed ends here, so it stays queued for a later drain.
    public static async Task<(IReadOnlyList<string> Sent, HashSet<string> Done, string? Fallback)> UnsubscribeAsync(
        Func<IReadOnlyList<string>> claim, AppSettings s, Action<string>? onDone, CancellationToken ct)
    {
        await TakeTurnAsync(null, ct);
        IReadOnlyList<string> ids = [];
        try
        {
            ids = claim();
            if (ids.Count == 0) return (ids, [], null);
            var (done, fallback) = await UnsubscribeCoreAsync(ids, s, onDone, ct);
            return (ids, done, fallback);
        }
        finally { WorkshopUnsubQueue.Release(ids); Turn.Release(); }
    }

    // This backend again as the helper child (`steam-ugc <verb> <steamclient.so candidates…>`), Wallpaper Engine to the Steam
    // client; null when the running executable isn't known. A published build's executable runs its own dll; under the
    // `dotnet` host (`dotnet liascape-backend.dll`, `dotnet run`) the dll goes first.
    internal static ProcessStartInfo? ChildStart(string verb, IEnumerable<string> libs)
    {
        if (Environment.ProcessPath is not { Length: > 0 } exe) return null;
        var start = new ProcessStartInfo(exe) { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (System.Reflection.Assembly.GetEntryAssembly()?.Location is { Length: > 0 } dll
            && !string.Equals(Path.GetFileNameWithoutExtension(dll), Path.GetFileNameWithoutExtension(exe), StringComparison.OrdinalIgnoreCase))
            start.ArgumentList.Add(dll);
        foreach (var a in new[] { "steam-ugc", verb }.Concat(libs)) start.ArgumentList.Add(a);
        start.Environment["SteamAppId"] = WallpaperEngineAppId.ToString();
        start.Environment["SteamGameId"] = WallpaperEngineAppId.ToString();
        // the backend's own (a dev shell's) must not shadow the Steam client's libraries
        start.Environment.Remove("LD_LIBRARY_PATH");
        return start;
    }

    /// Can the Steam client be used right now (running, signed in to an account that owns Wallpaper Engine)? A helper that only
    /// connects and lets go (`steam-ugc probe`) — the Steam to-do's "Let the Steam app do all N" asks before it converts
    /// anything, so a Steam that can't answer leaves the to-do as it was. Null = yes; else why not.
    public static async Task<string?> ProbeAsync(AppSettings s, CancellationToken ct)
    {
        // the held connection answers for it when it answers a ping (a second connection would flicker "Playing"); busy with
        // an operation, or gone quiet, the probe connects on its own as before
        if (await SteamClientHold.PingHeldAsync() == true) return null;
        var libs = Candidates(s);
        if (libs.Count == 0) return "the Steam client's steamclient.so wasn't found — is Steam installed?";
        var psi = ChildStart("probe", libs);
        if (psi == null) return "can't start the helper";
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

    /// The Steam app's account and its favourited Wallpaper Engine items, as Steam lists them now (every page). Works for a
    /// private profile: Steam's client asks as the account itself.
    public sealed record FavoriteList(ulong SteamId, IReadOnlyList<string> Ids);

    /// The account the Steam app is signed in to (ISteamUser::GetSteamID). 0 + why when Steam can't be reached.
    public static async Task<(ulong SteamId, string? Why)> SteamIdAsync(AppSettings s, CancellationToken ct)
    {
        var (e, why) = await AskAsync("steamid", s, ct).ConfigureAwait(false);
        return e is { } a && ulong.TryParse(a.GetProperty("id").GetString(), out var id) && id != 0 ? (id, null) : (0, why ?? "Steam named no account");
    }

    /// The account's favourited Workshop items for Wallpaper Engine (ISteamUGC CreateQueryUserUGCRequest, k_EUserUGCList_Favorited,
    /// every page). Null + why when Steam can't be reached or a page didn't answer: never a partial list.
    public static async Task<(FavoriteList? List, string? Why)> FavoritesAsync(AppSettings s, CancellationToken ct)
    {
        var (e, why) = await AskAsync("favorites", s, ct).ConfigureAwait(false);
        if (e is not { } a || !ulong.TryParse(a.GetProperty("steamId").GetString(), out var id) || id == 0) return (null, why ?? "Steam named no account");
        return (new FavoriteList(id, a.GetProperty("ids").EnumerateArray().Select((x) => x.GetString() ?? "").Where((x) => x.Length > 0).ToList()), null);
    }

    // One question to the held child (`steamid`, `favorites`), with the turn held: its answer event (named like the verb), or
    // null + why. Like an item command, Steam's own "no" never costs the held child.
    static async Task<(JsonElement? Answer, string? Why)> AskAsync(string verb, AppSettings s, CancellationToken ct)
    {
        await TakeTurnAsync(null, ct).ConfigureAwait(false);
        try
        {
            var (child, why) = await SteamClientHold.AcquireAsync(s, ct).ConfigureAwait(false);
            if (child == null) return (null, why);
            var cmd = new CommandState();
            JsonElement? answer = null;
            RunResult r;
            try { r = await RunCommandAsync(child, verb, [], null, null, cmd, ct, (e) => { if (e.GetProperty("event").GetString() == verb) answer = e; }).ConfigureAwait(false); }
            finally { SteamClientHold.Done(child, drop: !cmd.Ended); }
            return answer != null ? (answer, null) : (null, r.Error ?? "Steam didn't answer");
        }
        finally { Turn.Release(); }
    }

    static async Task<(HashSet<string> Done, string? Fallback)> UnsubscribeCoreAsync(IReadOnlyList<string> ids, AppSettings s,
        Action<string>? onDone, CancellationToken ct)
    {
        var done = new HashSet<string>();
        var (child, why) = await SteamClientHold.AcquireAsync(s, ct);
        if (child == null) return (done, why);
        var cmd = new CommandState();
        RunResult r;
        try { r = await RunCommandAsync(child, "unsubscribe", ids, null, id => { done.Add(id); onDone?.Invoke(id); }, cmd, ct); }
        finally { SteamClientHold.Done(child, drop: !cmd.Ended); }
        return (done, done.Count == 0 && r.Error != null ? r.Error : null);
    }

    // ---- the child side (`steam-ugc …`, its own process) -------------------------------------------------------------

    const int ClientCreatePipe = 0, ClientReleasePipe = 1, ClientConnectUser = 2, ClientReleaseUser = 4, ClientGenericInterface = 12;
    const int UgcSubscribe = 68, UgcUnsubscribe = 69, UgcState = 72, UgcInstallInfo = 73, UgcDownloadInfo = 74, UgcDownload = 75;
    const int UgcCreateUserQuery = 0, UgcSendQuery = 4, UgcQueryResult = 5, UgcReleaseQuery = 19, UgcOnlyIds = 23;
    const int UserLoggedOn = 1, UserSteamId = 2, UtilsCallDone = 11, UtilsCallResult = 13;
    // EUserUGCList Favorited, EUGCMatchingUGCType Items, EUserUGCListSortOrder CreationOrderDesc; k_unNumUGCResultsPerPage
    const int ListFavorited = 5, MatchingItems = 0, SortCreationDesc = 0, QueryPageSize = 50, MaxQueryPages = 200;
    // SteamUGCQueryCompleted_t (k_iSteamUGCCallbacks + 1): {handle u64, EResult i32 @8, returned u32 @12, total u32 @16, cached
    // bool, cursor char[256]} = 280 bytes under Valve's 4-byte callback packing on Linux; 24 before the cursor came
    const int QueryCompleted = 3401, QueryCompletedSize = 280, QueryCompletedSizeOld = 24, EResultOk = 1;
    // SteamUGCDetails_t is ~10 KB (its description alone 8000): room to spare, only its first field (the id) is read
    const int UgcDetailsRoom = 64 * 1024;

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
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool DownloadFn(IntPtr self, ulong id, [MarshalAs(UnmanagedType.I1)] bool highPriority);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool InstallInfoFn(IntPtr self, ulong id, out ulong size, byte[] folder, uint folderSize, out uint timestamp);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool BoolFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate ulong U64Fn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate ulong UserQueryFn(IntPtr self, uint account, int list, int matching, int sort, uint creatorApp, uint consumerApp, uint page);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool QueryResultFn(IntPtr self, ulong handle, uint index, IntPtr details);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool HandleFn(IntPtr self, ulong handle);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool HandleBoolFn(IntPtr self, ulong handle, [MarshalAs(UnmanagedType.I1)] bool on);
    // the out `bool *pbFailed` as a byte: one byte, whatever the marshaller would make of a bool
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool CallDoneFn(IntPtr self, ulong call, out byte failed);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] delegate bool CallResultFn(IntPtr self, ulong call, IntPtr result, int size, int expected, out byte failed);
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

    // drain the pipe's callback queue so it never grows while we poll (one per session: its buffer lives as long as the child)
    static Action? pumpOf;
    static Action Pump(Session s) => pumpOf ??= MakePump(s);
    static Action MakePump(Session s)
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
        if (args.Length < 2 || args[0] != "session")
        { Emit(new { @event = "error", message = "usage: steam-ugc session | probe  <steamclient.so>…" }); return 2; }
        var session = Connect(args.Skip(1), out var why);
        if (session == null) { Emit(new { @event = "error", message = why }); return 3; }
        Emit(new { @event = "ready" });
        try { RunSession(session); return 0; }
        finally { Release(session); }
    }

    sealed record Command(string Op, List<ulong> Ids, int Gen);

    // The session's loop: one JSON command a line on stdin — {"op": "subscribe" | "download" | "unsubscribe", "ids": [...]},
    // {"op": "ping"} (answers `done` once Steam's library answered), {"op": "steamid"} / {"op": "favorites"} (the account, its
    // favourited items: one `steamid` / `favorites` event, or an `error`),
    // {"op": "cancel"} (stops the running command and any sent before it), {"op": "release"} — each command's events on stdout,
    // then {"event": "done", "rc": N}. A closed stdin = release: the parent's choice, or the parent gone.
    static void RunSession(Session session)
    {
        var queue = new System.Collections.Concurrent.BlockingCollection<Command>();
        var gate = new object();
        ManualResetEventSlim? current = null; int cancelGen = 0, gen = 0; bool quit = false;
        new Thread(() =>
        {
            try
            {
                string? line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    string? op = null; var ids = new List<ulong>(); bool bad = false;
                    try
                    {
                        var e = JsonDocument.Parse(line).RootElement;
                        op = e.GetProperty("op").GetString();
                        if (e.TryGetProperty("ids", out var arr))
                            foreach (var x in arr.EnumerateArray())
                                if (ulong.TryParse(x.GetString(), out var v)) ids.Add(v); else bad = true;
                    }
                    catch { bad = true; }
                    if (op == "release") break;
                    if (op == "cancel") { lock (gate) { cancelGen = gen; current?.Set(); } continue; }
                    int g; lock (gate) g = ++gen;
                    queue.Add(new Command(bad ? "" : op ?? "", ids, g));
                }
            }
            catch { }
            lock (gate) { quit = true; current?.Set(); }
            queue.CompleteAdding();
        }) { IsBackground = true }.Start();

        foreach (var cmd in queue.GetConsumingEnumerable())
        {
            var stop = new ManualResetEventSlim();
            lock (gate) { if (quit) break; current = stop; if (cancelGen >= cmd.Gen) stop.Set(); }
            int rc;
            if (stop.IsSet) { Emit(new { @event = "error", message = "cancelled" }); rc = 1; }
            else if (cmd.Op == "ping") rc = Ping(session);
            else if (cmd.Op == "steamid") rc = SteamId(session);
            else if (cmd.Op == "favorites") rc = Favorites(session, stop);
            else if (cmd.Ids.Count == 0 || cmd.Op is not ("subscribe" or "download" or "unsubscribe") || (cmd.Op != "unsubscribe" && cmd.Ids.Count != 1))
            { Emit(new { @event = "error", message = "one Workshop id to subscribe or download, one or more to unsubscribe" }); rc = 2; }
            else rc = cmd.Op switch { "subscribe" => Subscribe(session, cmd.Ids[0], stop), "download" => Download(session, cmd.Ids[0], stop), _ => Unsubscribe(session, cmd.Ids, stop) };
            lock (gate) current = null;
            Emit(new { @event = "done", rc });
        }
    }

    // the parent's "still there?" before it reuses this child: one call into Steam's library and a pump; a hung library never
    // answers, and the parent replaces the child
    static int Ping(Session s)
    {
        Slot<StateFn>(s.Ugc, UgcState)(s.Ugc, 0);
        Pump(s)();
        return 0;
    }

    // another of the session's interfaces by its version string (IntPtr.Zero = this Steam has no such version)
    static IntPtr Iface(Session s, string version) =>
        Slot<GenericFn>(s.Client, ClientGenericInterface)(s.Client, s.User, s.Pipe, version);

    // the account the Steam client is signed in to; 0 + the reason when it can't say (offline: no Workshop query answers)
    static ulong Account(Session s, out string why)
    {
        why = "this Steam has no SteamUser021";
        var user = Iface(s, "SteamUser021");
        if (user == IntPtr.Zero) return 0;
        if (!Slot<BoolFn>(user, UserLoggedOn)(user)) { why = "Steam isn't signed in (offline)"; return 0; }
        var id = Slot<U64Fn>(user, UserSteamId)(user);
        if (id == 0) why = "Steam named no account";
        return id;
    }

    static int SteamId(Session s)
    {
        var id = Account(s, out var why);
        if (id == 0) { Emit(new { @event = "error", message = why }); return 3; }
        Emit(new { @event = "steamid", id = id.ToString() });
        return 0;
    }

    // Every page of the account's favourited Wallpaper Engine items (ids only), then one `favorites` event; any page that doesn't
    // answer whole → an `error` and no list (a partial one would read as items unfavourited). Each query handle is released.
    static int Favorites(Session s, ManualResetEventSlim stop)
    {
        var id = Account(s, out var why);
        if (id == 0) { Emit(new { @event = "error", message = why }); return 3; }
        var utils = Iface(s, "SteamUtils010");
        if (utils == IntPtr.Zero) { Emit(new { @event = "error", message = "this Steam has no SteamUtils010" }); return 3; }
        var create = Slot<UserQueryFn>(s.Ugc, UgcCreateUserQuery);
        var send = Slot<SubscribeFn>(s.Ugc, UgcSendQuery); // same shape: SteamAPICall_t (this, handle)
        var result = Slot<QueryResultFn>(s.Ugc, UgcQueryResult);
        var release = Slot<HandleFn>(s.Ugc, UgcReleaseQuery);
        var onlyIds = Slot<HandleBoolFn>(s.Ugc, UgcOnlyIds);
        var callDone = Slot<CallDoneFn>(utils, UtilsCallDone);
        var callResult = Slot<CallResultFn>(utils, UtilsCallResult);
        var pump = Pump(s);
        var ids = new List<string>();
        var details = Marshal.AllocHGlobal(UgcDetailsRoom);
        var done = Marshal.AllocHGlobal(QueryCompletedSize);
        string? error = null;
        bool whole = false;
        try
        {
            for (uint page = 1; page <= MaxQueryPages && error == null && !whole; page++)
            {
                // the account id is the SteamID's low 32 bits
                var q = create(s.Ugc, (uint)(id & 0xffffffff), ListFavorited, MatchingItems, SortCreationDesc, WallpaperEngineAppId, WallpaperEngineAppId, page);
                if (q == ulong.MaxValue) { error = "Steam turned the favourites query down"; break; }
                try
                {
                    onlyIds(s.Ugc, q, true);
                    var call = send(s.Ugc, q);
                    if (call == 0) { error = "Steam turned the favourites query down"; break; }
                    var sw = Stopwatch.StartNew();
                    bool answered = false; byte failed = 0;
                    while (sw.Elapsed < TimeSpan.FromSeconds(30) && !stop.IsSet)
                    {
                        pump();
                        if (callDone(utils, call, out failed)) { answered = true; break; }
                        stop.Wait(100);
                    }
                    if (stop.IsSet) { error = "cancelled"; break; }
                    if (!answered) { error = "Steam didn't answer the favourites query within 30 s"; break; }
                    // the result's size as this Steam has it (a mismatched size is refused, not misread)
                    bool got = failed == 0 && (callResult(utils, call, done, QueryCompletedSize, QueryCompleted, out failed)
                        || callResult(utils, call, done, QueryCompletedSizeOld, QueryCompleted, out failed)) && failed == 0;
                    if (!got) { error = "Steam's favourites query failed"; break; }
                    int eresult = Marshal.ReadInt32(done, 8);
                    uint returned = (uint)Marshal.ReadInt32(done, 12), total = (uint)Marshal.ReadInt32(done, 16);
                    if (eresult != EResultOk) { error = $"Steam answered the favourites query with result {eresult}"; break; }
                    for (uint i = 0; i < returned; i++)
                    {
                        if (!result(s.Ugc, q, i, details)) { error = "Steam's favourites query lost an item"; break; }
                        ids.Add(((ulong)Marshal.ReadInt64(details)).ToString());
                    }
                    whole = returned < QueryPageSize || ids.Count >= total;
                }
                finally { release(s.Ugc, q); }
            }
        }
        finally { Marshal.FreeHGlobal(details); Marshal.FreeHGlobal(done); }
        if (error == null && !whole) error = $"more than {MaxQueryPages * QueryPageSize} favourites";
        if (error != null) { Emit(new { @event = "error", message = error }); return 4; }
        Emit(new { @event = "favorites", steamId = id.ToString(), ids });
        return 0;
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
    // DownloadItem: no subscription. "before" = whether the user had it subscribed; "refused" = Steam won't fetch it (the call
    // said no, or nothing started within 20 s); else bytes like a subscribe, then "installed" with Steam's folder.
    static int Download(Session s, ulong id, ManualResetEventSlim stop)
    {
        var download = Slot<DownloadFn>(s.Ugc, UgcDownload);
        var state = Slot<StateFn>(s.Ugc, UgcState);
        var dlInfo = Slot<DlInfoFn>(s.Ugc, UgcDownloadInfo);
        var install = Slot<InstallInfoFn>(s.Ugc, UgcInstallInfo);
        var pump = Pump(s);
        Emit(new { @event = "before", subscribed = (state(s.Ugc, id) & StateSubscribed) != 0 });
        if (!download(s.Ugc, id, true)) { Emit(new { @event = "refused" }); return 5; }
        Emit(new { @event = "accepted" });
        var sw = Stopwatch.StartNew();
        bool started = false; string last = "";
        while (sw.Elapsed < TimeSpan.FromMinutes(30) && !stop.IsSet)
        {
            pump();
            uint st = state(s.Ugc, id);
            if ((st & (StateInstalled | StateDownloading | StateDownloadPending)) != 0) started = true;
            dlInfo(s.Ugc, id, out var done, out var total);
            var now = $"{st}:{done}:{total}";
            if (now != last) { last = now; Emit(new { @event = "progress", state = st, done, total }); }
            if ((st & StateInstalled) != 0 && (st & (StateDownloading | StateDownloadPending | StateNeedsUpdate)) == 0)
            {
                var buf = new byte[4096];
                if (install(s.Ugc, id, out var size, buf, (uint)buf.Length, out _))
                {
                    var folder = System.Text.Encoding.UTF8.GetString(buf, 0, Math.Max(0, Array.IndexOf(buf, (byte)0)));
                    Emit(new { @event = "installed", folder, size }); return 0;
                }
            }
            if (!started && sw.Elapsed > TimeSpan.FromSeconds(20)) { Emit(new { @event = "refused" }); return 5; }
            stop.Wait(250);
        }
        Emit(new { @event = "error", message = stop.IsSet ? "cancelled" : "Steam didn't install it within 30 minutes" });
        return 1;
    }
}
