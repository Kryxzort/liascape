using CommunityToolkit.Mvvm.ComponentModel;

namespace livepaper.ViewModels;

public partial class WorkshopGenreItem : ObservableObject
{
    public string Name { get; }

    [ObservableProperty] private bool _isSelected;

    public WorkshopGenreItem(string name) => Name = name;
}
