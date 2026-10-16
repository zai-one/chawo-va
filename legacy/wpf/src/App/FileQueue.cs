// The list on the File transcription page. Files and folders come from the buttons or
// from drag-and-drop onto the window; the runner takes queued items one by one, so
// files dropped during a run are picked up by the same run.

namespace ChawoVA.App;

public enum FileItemState { Queued, Running, Done, Failed, Stopped }

public sealed class FileQueueItem
{
    public FileQueueItem(string path) => Path = path;
    public string Path { get; }
    public FileItemState State { get; set; } = FileItemState.Queued;
    /// <summary>Short per-file note: error, "мозг пропущен", elapsed time.</summary>
    public string Note { get; set; } = "";
    /// <summary>The raw .txt once written.</summary>
    public string? OutputPath { get; set; }
}

public sealed class FileQueue
{
    private readonly object _gate = new();
    private readonly List<FileQueueItem> _items = new();

    /// <summary>Raised on any thread after a change. Subscribers marshal to the UI themselves.</summary>
    public event Action? Changed;

    /// <summary>The .txt of the file that finished last; «Открыть папку» selects it.</summary>
    public string? LastOutput { get; private set; }

    public IReadOnlyList<FileQueueItem> Snapshot()
    {
        lock (_gate) return _items.ToList();
    }

    public int QueuedCount
    {
        get { lock (_gate) return _items.Count(i => i.State == FileItemState.Queued); }
    }

    /// <summary>
    /// Adds files; folders are expanded (top level, supported extensions only).
    /// onlyAudio drops files with an unknown extension (used for drag-and-drop).
    /// A path already waiting or running is not added twice. Returns (added, skipped).
    /// </summary>
    public (int added, int skipped) Add(IEnumerable<string> paths, bool onlyAudio)
    {
        int added = 0, skipped = 0;
        lock (_gate)
        {
            foreach (var raw in paths)
            {
                var p = (raw ?? "").Trim().Trim('"');
                if (p.Length == 0) continue;
                IEnumerable<string> files;
                if (Directory.Exists(p))
                {
                    files = FileTranscript.CollectFromFolder(p);
                    if (!files.Any()) { skipped++; continue; }
                }
                else if (onlyAudio && !FileTranscript.HasSupportedExtension(p))
                {
                    skipped++;
                    continue;
                }
                else files = new[] { p };

                foreach (var f in files)
                {
                    string full;
                    try { full = System.IO.Path.GetFullPath(f); } catch { full = f; }
                    bool pending = _items.Any(i => i.State is FileItemState.Queued or FileItemState.Running
                        && string.Equals(i.Path, full, StringComparison.OrdinalIgnoreCase));
                    if (pending) { skipped++; continue; }
                    // A finished row for the same file is replaced, so the list does not grow with repeats.
                    _items.RemoveAll(i => i.State is not (FileItemState.Queued or FileItemState.Running)
                        && string.Equals(i.Path, full, StringComparison.OrdinalIgnoreCase));
                    _items.Add(new FileQueueItem(full));
                    added++;
                }
            }
        }
        if (added > 0 || skipped > 0) Changed?.Invoke();
        return (added, skipped);
    }

    /// <summary>Removes a row unless it is the one running now.</summary>
    public bool Remove(FileQueueItem item)
    {
        bool removed;
        lock (_gate) removed = item.State != FileItemState.Running && _items.Remove(item);
        if (removed) Changed?.Invoke();
        return removed;
    }

    /// <summary>Next queued item, marked Running; null when nothing waits.</summary>
    public FileQueueItem? TakeNext()
    {
        FileQueueItem? next;
        lock (_gate)
        {
            next = _items.FirstOrDefault(i => i.State == FileItemState.Queued);
            if (next != null) { next.State = FileItemState.Running; next.Note = ""; }
        }
        if (next != null) Changed?.Invoke();
        return next;
    }

    /// <summary>The item TakeNext would return, without taking it (for decoding ahead).</summary>
    public FileQueueItem? PeekNext()
    {
        lock (_gate) return _items.FirstOrDefault(i => i.State == FileItemState.Queued);
    }

    public void Finish(FileQueueItem item, FileItemState state, string note, string? output = null)
    {
        lock (_gate)
        {
            item.State = state;
            item.Note = note;
            if (output != null)
            {
                item.OutputPath = output;
                LastOutput = output;
            }
        }
        Changed?.Invoke();
    }

    /// <summary>After Stop: the running row becomes Stopped; queued rows stay queued for the next run.</summary>
    public void MarkRunningStopped(string note)
    {
        bool any = false;
        lock (_gate)
        {
            foreach (var i in _items.Where(i => i.State == FileItemState.Running))
            {
                i.State = FileItemState.Stopped;
                i.Note = note;
                any = true;
            }
        }
        if (any) Changed?.Invoke();
    }
}
