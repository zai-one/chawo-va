// Call → handset map → CRM boundary → card. No network.
// The local CRM boundary always answers "no client". A later SaaS adapter
// returns the same snapshot shape; this file does not name a vendor or a URL.

namespace GigaPisar.App;

public readonly record struct TelephonyEvent(
    string CallId,
    string Trunk,
    string Extension,
    string CallerNumber,
    string Direction);

public readonly record struct HandsetBinding(
    string Trunk,
    string Extension,
    string ManagerName,
    string PcId);

public readonly record struct CrmClient(
    string Phone,
    string Name,
    string Company,
    string OpenDeal,
    string DealStage,
    string StageScript,
    string LastOrder,
    IReadOnlyList<string> SpokenProducts);

public readonly record struct SalesCardView(
    bool HasCall,
    string WhoLine,
    string ScriptLine,
    SalesHit? Hit);

public static class SalesFlow
{
    public const string LocalPcId = "local";

    /// <summary>
    /// CRM boundary. This build has no CRM, so the snapshot is always missing.
    /// Missing is not an error: the card still opens for the bound manager.
    /// </summary>
    public static CrmClient? LookupClient(string callerNumber) => null;

    /// <summary>
    /// One handset row. Empty extension or empty manager name is a missing map.
    /// </summary>
    public static HandsetBinding? Resolve(string extension, string managerName, string trunk = "")
    {
        extension = extension.Trim();
        managerName = managerName.Trim();
        if (extension.Length == 0 || managerName.Length == 0) return null;
        return new HandsetBinding(trunk.Trim(), extension, managerName, LocalPcId);
    }

    /// <summary>
    /// The three fields a person types. Same shape a telephony webhook fills later:
    /// trunk stays empty, direction is inbound, call id is minted here.
    /// Returns null when the handset map is missing.
    /// </summary>
    public static (TelephonyEvent Event, HandsetBinding Binding)? StandIn(string extension, string callerNumber, string managerName)
    {
        var binding = Resolve(extension, managerName);
        if (binding == null) return null;
        var ev = new TelephonyEvent(
            "local-" + DateTime.UtcNow.Ticks,
            "",
            binding.Value.Extension,
            callerNumber.Trim(),
            "inbound");
        return (ev, binding.Value);
    }

    public static SalesCardView Compose(
        TelephonyEvent ev,
        HandsetBinding binding,
        string? transcript,
        IReadOnlyList<SalesCatalogItem> catalog,
        string? ragFolder)
    {
        var client = LookupClient(ev.CallerNumber);
        SalesHit? hit = null;
        if (!string.IsNullOrWhiteSpace(transcript))
        {
            var matched = SalesCatalog.Match(transcript, catalog);
            matched = PreferSpokenHistory(transcript, catalog, matched, client?.SpokenProducts);
            if (matched != null)
            {
                var shown = matched.Value;
                if (shown.Kind == SalesHitKind.Similar)
                {
                    var snip = SalesRag.FindSnippet(transcript, ragFolder);
                    if (snip != null) shown = SalesCatalog.WithRag(shown, snip.Value.Text);
                }
                hit = shown;
            }
        }
        return new SalesCardView(true, FormatWho(ev, binding, client), FormatScript(client), hit);
    }

    /// <summary>
    /// Exact heard code wins. A heard similar-code wins over history.
    /// Otherwise a spoken product that is also close to the live text replaces a weak name hit.
    /// History never upgrades a row to exact. With no CRM snapshot this does nothing.
    /// </summary>
    public static SalesHit? PreferSpokenHistory(
        string transcript,
        IReadOnlyList<SalesCatalogItem> items,
        SalesHit? hit,
        IReadOnlyList<string>? spoken)
    {
        if (hit is SalesHit exact && exact.Kind == SalesHitKind.Exact) return hit;
        if (spoken == null || spoken.Count == 0) return hit;
        if (hit is SalesHit sim && HeardSimilarCode(transcript, items, sim)) return hit;

        foreach (var item in items)
        {
            if (!SpokenMentions(spoken, item)) continue;
            if (!SalesCatalog.NameIsClose(transcript, item.Name)) continue;
            return new SalesHit(SalesHitKind.Similar, item.Name.Trim().Length > 0 ? item.Name.Trim() : item.Code.Trim(), item.Line.Trim(), item.Code.Trim());
        }
        return hit;
    }

    private static bool HeardSimilarCode(string transcript, IReadOnlyList<SalesCatalogItem> items, SalesHit hit)
    {
        foreach (var item in items)
        {
            if (!string.Equals(item.Code.Trim(), hit.Code, StringComparison.OrdinalIgnoreCase)) continue;
            string code = item.SimilarCode.Trim();
            if (code.Length >= 2 && SalesCatalog.HasToken(transcript, code)) return true;
        }
        return false;
    }

    private static bool SpokenMentions(IReadOnlyList<string> spoken, SalesCatalogItem item)
    {
        foreach (var raw in spoken)
        {
            string s = raw.Trim();
            if (s.Length == 0) continue;
            if (s.Equals(item.Code.Trim(), StringComparison.OrdinalIgnoreCase)) return true;
            if (s.Equals(item.Name.Trim(), StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string FormatWho(TelephonyEvent ev, HandsetBinding binding, CrmClient? client)
    {
        string number = ev.CallerNumber.Length == 0 ? "номер скрыт" : ev.CallerNumber;
        string head = $"{binding.ManagerName} · трубка {binding.Extension} · {number}";
        if (client == null) return head + "\nклиент по номеру не найден";
        var c = client.Value;
        var bits = new List<string>();
        if (c.Name.Length > 0) bits.Add(c.Name);
        if (c.Company.Length > 0) bits.Add(c.Company);
        if (c.OpenDeal.Length > 0) bits.Add(c.OpenDeal);
        if (c.LastOrder.Length > 0) bits.Add("заказ: " + c.LastOrder);
        return head + "\n" + (bits.Count == 0 ? "клиент без имени" : string.Join(", ", bits));
    }

    private static string FormatScript(CrmClient? client)
    {
        if (client == null) return "скрипт стадии: нет данных";
        var c = client.Value;
        if (c.StageScript.Trim().Length > 0)
            return c.DealStage.Trim().Length == 0 ? c.StageScript.Trim() : c.DealStage.Trim() + ": " + c.StageScript.Trim();
        if (c.DealStage.Trim().Length > 0) return c.DealStage.Trim() + " — текст скрипта не задан";
        return "скрипт стадии: нет данных";
    }
}
