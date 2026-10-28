namespace Liascape.Models;

public record AppTheme(
    string Name,
    string BgBase, string BgMantle, string BgCrust,
    string Surface0, string Surface1, string Surface2,
    string TextColor, string Subtext, string Muted,
    string Accent, string AccentFg, string AccentHover,
    string Danger, string DangerBg, string Success
);
