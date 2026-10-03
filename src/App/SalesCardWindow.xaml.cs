// Small always-on-top card for the local sales trial. Does not take focus,
// does not touch the network, and does not call a model.

using System.Windows;
using System.Windows.Interop;

namespace GigaPisar.App;

public partial class SalesCardWindow : Window
{
    private SalesHitKind _kind;
    private string _name = "";
    private string _line = "";
    private string _rag = "";

    public SalesCardWindow()
    {
        InitializeComponent();
        SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            int ex = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
            Native.SetWindowLong(hwnd, Native.GWL_EXSTYLE, ex | Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW | Native.WS_EX_TOPMOST);
        };
    }

    public void ShowHit(SalesHit hit)
    {
        string rag = hit.RagSnippet ?? "";
        if (hit.Kind == _kind && hit.Name == _name && hit.Line == _line && rag == _rag && IsVisible) return;
        _kind = hit.Kind;
        _name = hit.Name;
        _line = hit.Line;
        _rag = rag;
        Badge.Visibility = hit.Kind == SalesHitKind.Similar ? Visibility.Visible : Visibility.Collapsed;
        NameText.Text = hit.Name;
        LineText.Text = hit.Line;
        LineText.Visibility = hit.Line.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        bool hasRag = rag.Length > 0;
        RagLabel.Visibility = hasRag ? Visibility.Visible : Visibility.Collapsed;
        RagText.Text = rag;
        RagText.Visibility = hasRag ? Visibility.Visible : Visibility.Collapsed;
        if (!IsVisible) Show();
        Place();
    }

    public void HideNow()
    {
        _name = "";
        _line = "";
        _rag = "";
        Hide();
    }

    private void Place()
    {
        var area = SystemParameters.WorkArea;
        UpdateLayout();
        Left = area.Right - ActualWidth - 12;
        Top = area.Bottom - ActualHeight - 12;
    }
}
