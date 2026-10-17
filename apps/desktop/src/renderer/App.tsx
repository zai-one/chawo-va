// The window: the page list on the left, the open page on the right. Dark only.
import { useEffect, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { invoke, chawo } from './bridge';
import { ChawoLogo, ChawoMark } from '@chawo/ui/ChawoLogo';
import { cx } from '@chawo/ui/cx';
import { Icon } from '@chawo/ui/Icon';
import { useL } from './app/i18n';
import { isNavShortcut, NAV_MAX, NAV_MIN, NAV_RAIL, navCollapsed, navWidth, resetNavWidth, resizeNav, toggleNav } from './app/navState';
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

/** The right edge of the page list: a drag sets its width (narrow folds it to the rail), a double-click
 *  brings the usual width back, the arrow keys move it from the keyboard (window splitter pattern). */
function NavEdge({ onResizing }: { onResizing: (on: boolean) => void }) {
  const L = useL();
  const collapsed = useStore(navCollapsed);
  const width = useStore(navWidth);
  const now = collapsed ? NAV_RAIL : width;
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const edge = e.currentTarget;
    const left = (edge.parentElement ?? edge).getBoundingClientRect().left;
    edge.setPointerCapture(e.pointerId);
    onResizing(true);
    document.body.classList.add('nav-resizing');
    const move = (ev: PointerEvent) => resizeNav(ev.clientX - left);
    const up = () => {
      edge.removeEventListener('pointermove', move);
      edge.removeEventListener('pointerup', up);
      edge.removeEventListener('pointercancel', up);
      document.body.classList.remove('nav-resizing');
      onResizing(false);
    };
    edge.addEventListener('pointermove', move);
    edge.addEventListener('pointerup', up);
    edge.addEventListener('pointercancel', up);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const go: Record<string, () => void> = {
      ArrowLeft: () => resizeNav(collapsed || now - step < NAV_MIN ? 0 : now - step),
      ArrowRight: () => resizeNav(collapsed ? NAV_MIN : now + step),
      Home: () => resizeNav(0),
      End: () => resizeNav(NAV_MAX),
      Enter: toggleNav,
    };
    if (!go[e.key]) return;
    e.preventDefault();
    go[e.key]();
  };
  return (
    <div
      className="nav-edge"
      role="separator"
      aria-orientation="vertical"
      aria-controls="nav"
      aria-label={L('Ширина меню', 'Menu width')}
      aria-valuemin={NAV_RAIL}
      aria-valuemax={NAV_MAX}
      aria-valuenow={now}
      tabIndex={0}
      title={L('Тяните, чтобы изменить ширину; двойной щелчок — обычная ширина', 'Drag to change the width; double-click for the usual width')}
      onPointerDown={onPointerDown}
      onDoubleClick={resetNavWidth}
      onKeyDown={onKeyDown}
    />
  );
}

/** The page list: icon and title per page; folded, a rail of icons whose titles show as tooltips. */
function Nav({ page }: { page: PageName }) {
  const L = useL();
  const collapsed = useStore(navCollapsed);
  const width = useStore(navWidth);
  const [resizing, setResizing] = useState(false);
  const toggleLabel = collapsed ? L('Развернуть меню', 'Expand menu') : L('Свернуть меню', 'Collapse menu');
  return (
    <aside
      className={cx('nav', collapsed && 'collapsed', resizing && 'resizing')}
      id="nav"
      aria-label={L('Разделы', 'Sections')}
      style={{ '--nav-width': `${width}px` } as CSSProperties}
    >
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
      <NavEdge onResizing={setResizing} />
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
