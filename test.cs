using System;
using System.Diagnostics;
using System.Threading;
class P { static void Main() {
    var psi = new ProcessStartInfo("mpvpaper") {
        Arguments = "-o \"--loop-file=inf\" * /dev/null",
        UseShellExecute = false,
        RedirectStandardOutput = false
    };
    var p = Process.Start(psi);
    Console.WriteLine("Started " + p.Id);
    Thread.Sleep(2000);
    Console.WriteLine("Exiting");
}}
