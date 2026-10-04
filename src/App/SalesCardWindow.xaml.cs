// Small always-on-top card for the local sales trial. Does not take focus,
// does not touch the network, and does not call a model.

using System.Windows;
using System.Windows.Interop;

namespace GigaPisar.App;

public partial class SalesCardWindow : Window
{
    private bool _hasCall;
    private string _who = "";
    private string _script = "";
    private SalesHitKind _kind;
    private string _name = "";
    private string _line = "";
    private string _rag = "";
    private bool _hasHit;

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

    public void ShowHit(SalesHit hit) => ShowModel(new SalesCardView(false, "", "", hit));

    public void ShowModel(SalesCardView view)
    {
        string rag = view.Hit?.RagSnippet ?? "";
        string name = view.Hit?.Name ?? "";
        string line = view.Hit?.Line ?? "";
        var kind = view.Hit?.Kind ?? SalesHitKind.Similar;
        bool hasHit = view.Hit != null;
        if (view.HasCall == _hasCall && view.WhoLine == _who && view.ScriptLine == _script
            && hasHit == _hasHit && kind == _kind && name == _name && line == _line && rag == _rag && IsVisible)
            return;
        _hasCall = view.HasCall;
        _who = view.WhoLine;
        _script = view.ScriptLine;
        _hasHit = hasHit;
        _kind = kind;
        _name = name;
        _line = line;
        _rag = rag;

        CallHead.Visibility = view.HasCall ? Visibility.Visible : Visibility.Collapsed;
        WhoText.Text = view.WhoLine;
        WhoText.Visibility = view.HasCall ? Visibility.Visible : Visibility.Collapsed;
        ScriptText.Text = view.ScriptLine;
        ScriptText.Visibility = view.HasCall && view.ScriptLine.Length > 0 ? Visibility.Visible : Visibility.Collapsed;

        if (view.Hit is SalesHit hit)
        {
            Badge.Visibility = hit.Kind == SalesHitKind.Similar ? Visibility.Visible : Visibility.Collapsed;
            NameText.Text = hit.Name;
            NameText.Visibility = Visibility.Visible;
            LineText.Text = hit.Line;
            LineText.Visibility = hit.Line.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
            bool hasRag = rag.Length > 0;
            RagLabel.Visibility = hasRag ? Visibility.Visible : Visibility.Collapsed;
            RagText.Text = rag;
            RagText.Visibility = hasRag ? Visibility.Visible : Visibility.Collapsed;
        }
        else
        {
            Badge.Visibility = Visibility.Collapsed;
            NameText.Text = "";
            NameText.Visibility = Visibility.Collapsed;
            LineText.Visibility = Visibility.Collapsed;
            RagLabel.Visibility = Visibility.Collapsed;
            RagText.Visibility = Visibility.Collapsed;
        }

        if (!IsVisible) Show();
        Place();
    }

    public void HideNow()
    {
        _hasCall = false;
        _who = "";
        _script = "";
        _hasHit = false;
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
