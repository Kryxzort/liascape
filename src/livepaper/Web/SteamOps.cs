using System;
using System.Threading;
using System.Threading.Tasks;
using livepaper.Helpers;
using QRCoder;

namespace livepaper.Web;

// Steam QR sign-in / sign-out / workshop unsub-drain. QR + progress pushed over WS.
public static class SteamOps
{
    private static CancellationTokenSource? _qrCts;
    private static int _draining; // Interlocked guard — one drain at a time

    public static object Status()
    {
        var s = SettingsService.Load();
        return new
        {
            signedIn = !string.IsNullOrEmpty(s.SteamRefreshToken),
            accountName = s.SteamAccountName,
            daysLeft = SteamAuthService.RefreshTokenDaysRemaining(s),
            mode = s.WorkshopAcquireMode,
        };
    }

    public static void StartQr()
    {
        _qrCts?.Cancel();
        _qrCts = new CancellationTokenSource();
        var ct = _qrCts.Token;
        _ = Task.Run(async () =>
        {
            try
            {
                var (refreshToken, steamId, accountName) = await SteamAuthService.LoginViaQrAsync(url =>
                {
                    // render the steam challenge URL to a PNG and push it
                    using var gen = new QRCodeGenerator();
                    using var data = gen.CreateQrCode(url, QRCodeGenerator.ECCLevel.Q);
                    var png = new PngByteQRCode(data).GetGraphic(8);
                    EventBus.Broadcast("steam-qr", new { png = "data:image/png;base64," + Convert.ToBase64String(png) });
                }, ct);

                var s = SettingsService.Load();
                s.SteamRefreshToken = refreshToken;
                s.SteamId = steamId;
                s.SteamAccountName = accountName;
                SettingsService.Save(s);
                EventBus.Broadcast("steam-signed-in", Status());
            }
            catch (OperationCanceledException) { EventBus.Broadcast("steam-qr-cancelled"); }
            catch (Exception e) { EventBus.Broadcast("steam-qr-error", new { message = e.Message }); }
        });
    }

    public static void CancelQr() => _qrCts?.Cancel();

    public static void SignOut()
    {
        var s = SettingsService.Load();
        s.SteamRefreshToken = ""; s.SteamId = 0; s.SteamAccessToken = "";
        s.SteamAccountName = ""; s.SteamLoginSecure = "";
        SettingsService.Save(s);
    }

    // The drain modal is a view onto this; dismissing it doesn't stop the drain. One drain at a time.
    public static void StartDrain()
    {
        if (Interlocked.CompareExchange(ref _draining, 1, 0) != 0) return;
        _ = Task.Run(async () =>
        {
            try
            {
                var progress = new Progress<(int Done, int Total, string CurrentId)>(t =>
                    EventBus.Broadcast("unsub-progress", new { done = t.Done, total = t.Total, currentId = t.CurrentId }));
                await WorkshopDownloader.DrainUnsubQueueAsync(SettingsService.Load(), progress, CancellationToken.None);
                EventBus.Broadcast("unsub-progress", new { done = 0, total = 0, currentId = "", finished = true });
            }
            catch (Exception e) { EventBus.Broadcast("unsub-progress", new { error = e.Message, finished = true }); }
            finally { Interlocked.Exchange(ref _draining, 0); }
        });
    }
}
