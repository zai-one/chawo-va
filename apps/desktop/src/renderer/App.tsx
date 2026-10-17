// The window: the page list on the left, the open page on the right. Dark only.
import { useEffect, type ReactElement } from 'react';
import { invoke, chawo } from './bridge';
import { ChawoLogo, ChawoMark } from '@chawo/ui/ChawoLogo';
import { cx } from '@chawo/ui/cx';
import { Icon } from '@chawo/ui/Icon';
import { useL } from './app/i18n';
import { isNavShortcut, navCollapsed, toggleNav } from './app/navState';
import { currentPage, ICONS, PAGES, pageVisit, showPage, TITLES, type PageName } from './app/pages';
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

/** Ctrl+B anywhere in the window folds or unfolds the page list. */
function useNavShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isNavShortcut(e)) return;
      e.preventDefault();
      toggleNav();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** The page list: icon and title per page; folded, a rail of icons whose titles show as tooltips. */
function Nav({ page }: { page: PageName }) {
  const L = useL();
  const collapsed = useStore(navCollapsed);
  const toggleLabel = collapsed ? L('Развернуть меню', 'Expand menu') : L('Свернуть меню', 'Collapse menu');
  return (
    <aside className={cx('nav', collapsed && 'collapsed')} id="nav" aria-label={L('Разделы', 'Sections')}>
      <div className="brand">{collapsed ? <ChawoMark size={24} /> : <ChawoLogo fontSize={22} />}</div>
      {PAGES.map((p) => {
        const title = L(...TITLES[p]);
        return (
          <button
            key={p}
            type="button"
            className={p === page ? 'active' : undefined}
            aria-current={p === page ? 'page' : undefined}
            data-page={p}
            data-tip={collapsed ? title : undefined}
            onClick={() => showPage(p)}
          >
            <Icon name={ICONS[p]} />
            <span className="label">{title}</span>
          </button>
        );
      })}
      <div className="nav-foot">
        <button
          type="button"
          className="nav-toggle"
          aria-controls="nav"
          aria-expanded={!collapsed}
          aria-label={`${toggleLabel} (Ctrl+B)`}
          data-tip={collapsed ? `${toggleLabel} · Ctrl+B` : undefined}
          onClick={toggleNav}
        >
          <Icon name="panel-left" />
          <span className="label" aria-hidden="true">
            {toggleLabel}
          </span>
        </button>
      </div>
    </aside>
  );
}

export function App() {
  const page = useStore(currentPage);
  const visit = useStore(pageVisit);
  useDropFiles();
  useNavShortcut();
  const View = VIEWS[page];
  return (
    <>
      <Nav page={page} />
      <main id="page">
        {/* A page mounts fresh each time it is opened (also again) and asks main for its state. */}
        <View key={`${page}#${visit}`} />
      </main>
    </>
  );
}
