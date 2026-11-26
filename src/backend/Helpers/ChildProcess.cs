using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace Liascape.Helpers;

// A command-line tool run to its end and read (ffmpeg, ffprobe): what each caller needs from a short-lived child, kept in
// one place so no caller forgets a part of it. Its arguments go as a list (.claude/rules/backend/api.md § Security), its
// stdin is closed (a tool that asks never waits on us), both pipes are read whole while it runs (a chatty child blocks on
// a full pipe), and one that outlives `limit` or the caller's token is killed with its children and reaped, so it never
// holds its caller's lock or lingers as a zombie.
// Guard: scripts/test-item-actions.sh § import (ffmpeg conversion and thumbnails), scripts/test-library-facts.sh (ffprobe)
public static class ChildProcess
{
    // Exit: the tool's exit code; null when it couldn't start (not installed) or ran out of `limit`. Out / Err: what it
    // printed ("" when Exit is null).
    public sealed record Result(int? Exit, string Out, string Err)
    {
        public bool Ok => Exit == 0;
        public static readonly Result None = new(null, "", "");
    }

    // Cancelling `ct` kills the tool too, then throws OperationCanceledException.
    public static async Task<Result> RunAsync(string tool, IEnumerable<string> args, TimeSpan limit, CancellationToken ct = default)
    {
        var start = new ProcessStartInfo(tool)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in args) start.ArgumentList.Add(a);
        Process? child;
        try { child = Process.Start(start); }
        catch (Win32Exception) { return Result.None; }
        if (child == null) return Result.None;
        using (child)
        {
            child.StandardInput.Close();
            Task<string> output = child.StandardOutput.ReadToEndAsync(CancellationToken.None);
            Task<string> errors = child.StandardError.ReadToEndAsync(CancellationToken.None);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(limit);
            try { await child.WaitForExitAsync(deadline.Token); }
            catch (OperationCanceledException)
            {
                // InvalidOperationException: it exited meanwhile
                try { child.Kill(entireProcessTree: true); } catch (Exception e) when (e is InvalidOperationException or Win32Exception) { }
                await child.WaitForExitAsync(CancellationToken.None);
                ct.ThrowIfCancellationRequested();
                return Result.None;
            }
            return new Result(child.ExitCode, await output, await errors);
        }
    }
}
