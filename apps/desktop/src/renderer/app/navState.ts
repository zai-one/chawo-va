// The page list on the left can shrink to a rail of icons (Ctrl+B or the button at its foot). Whether
// it is collapsed is a view preference of this computer (zai-brand workbench-shell: never a fact about
// data), so it lives in this window's localStorage. Anything unreadable opens the list.
import { createStore } from './store';

const KEY = 'chawo.nav';

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === 'collapsed';
  } catch {
    return false;
  }
}

export const navCollapsed = createStore<boolean>(read());

function setNavCollapsed(collapsed: boolean): void {
  navCollapsed.set(collapsed);
  try {
    window.localStorage.setItem(KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    /* storage off: the choice lasts until the window closes */
  }
}

export function toggleNav(): void {
  setNavCollapsed(!navCollapsed.get());
}

/** Ctrl+B (⌘B on macOS) toggles the list, as in the other ZAI products. */
export function isNavShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyB';
}
