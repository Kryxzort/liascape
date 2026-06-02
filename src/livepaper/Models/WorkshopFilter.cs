using System.Collections.Generic;

namespace livepaper.Models;

public class WorkshopFilter
{
    public string Sort { get; set; } = "trend";
    public int TrendDays { get; set; } = 7;
    public HashSet<string> Genres { get; set; } = [];
    public HashSet<string> Features { get; set; } = [];
    public string Type { get; set; } = "";
    public string AgeRating { get; set; } = "";
    public string Resolution { get; set; } = "";

    public bool HasActiveFilters =>
        Genres.Count > 0 ||
        Features.Count > 0 ||
        !string.IsNullOrEmpty(Type) ||
        !string.IsNullOrEmpty(AgeRating) ||
        !string.IsNullOrEmpty(Resolution) ||
        Sort != "trend";

    public WorkshopFilter Clone() => new()
    {
        Sort = Sort,
        TrendDays = TrendDays,
        Genres = new HashSet<string>(Genres),
        Features = new HashSet<string>(Features),
        Type = Type,
        AgeRating = AgeRating,
        Resolution = Resolution
    };
}
