// The window: the page list on the left, the open page on the right. Dark only.
import { useEffect, type ReactElement } from 'react';
import { invoke, chawo } from './bridge';
import { useL } from './app/i18n';
import { currentPage, PAGES, pageVisit, showPage, TITLES, type PageName } from './app/pages';
import { applyFile } from './app/state';
import { useStore } from './app/store';
import { BrainPage } from './pages/BrainPage';
import { DictationPage } from './pages/DictationPage';
import { DictionaryPage } from './pages/DictionaryPage';
import { FilePage } from './pages/FilePage';
import { HistoryPage } from './pages/HistoryPage';
import { NetworkPage } from './pages/NetworkPage';
import { SalesPage } from './pages/SalesPage';
import { SpeechPage } from './pages/SpeechPage';
import { VoicePage } from './pages/VoicePage';

const VIEWS: Record<PageName, () => ReactElement> = {
  dictation: DictationPage,
  file: FilePage,
  history: HistoryPage,
  speech: SpeechPage,
  dictionary: DictionaryPage,
  sales: SalesPage,
  brain: BrainPage,
  voice: VoicePage,
  network: NetworkPage,
};

/** Drop anywhere on the window: files and folders go into the file queue and that page opens. */
function useDropFiles(): void {
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      void invoke('file:add', files.map((f) => chawo.pathForFile(f)).filter(Boolean), true).then((s) => {
        showPage('file');
        applyFile(s);
      });
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);
}

export function App() {
  const page = useStore(currentPage);
  const visit = useStore(pageVisit);
  const L = useL();
  useDropFiles();
  const View = VIEWS[page];
  return (
    <>
      <aside className="nav">
        <div className="brand">Chawo</div>
        {PAGES.map((p) => (
          <button key={p} type="button" className={p === page ? 'active' : undefined} data-page={p} onClick={() => showPage(p)}>
            {L(...TITLES[p])}
          </button>
        ))}
      </aside>
      <main id="page">
        {/* A page mounts fresh each time it is opened (also again) and asks main for its state. */}
        <View key={`${page}#${visit}`} />
      </main>
    </>
  );
}
