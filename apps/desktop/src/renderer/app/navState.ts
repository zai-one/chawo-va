// The page list on the left can shrink to a rail of icons (Ctrl+B or the button at its foot) and its
// open width follows a drag of its right edge. Both are view preferences of this computer (zai-brand
// workbench-shell: never a fact about data), so they live in this window's localStorage. Anything
// unreadable opens the list at its usual width.
import { createStore } from './store';

const KEY = 'chawo.nav';
const WIDTH_KEY = 'chawo.nav.width';

/** Open width: the usual one, and the range a drag of the edge keeps to (the window is at least 720 wide). */
const NAV_WIDTH = 220;
export const NAV_MIN = 168;
export const NAV_MAX = 360;
/** Width of the folded rail (tokens.css --nav-rail). */
export const NAV_RAIL = 56;
/** Dragged narrower than this, the list folds to the rail of icons; dragged wider from the rail, it opens. */
const NAV_FOLD = 120;

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function readWidth(): number {
  try {
    const n = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isInteger(n) && n >= NAV_MIN && n <= NAV_MAX ? n : NAV_WIDTH;
  } catch {
    return NAV_WIDTH;
  }
}

export const navCollapsed = createStore<boolean>(read());
export const navWidth = createStore<number>(readWidth());

function save(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage off: the choice lasts until the window closes */
  }
}

function setNavCollapsed(collapsed: boolean): void {
  navCollapsed.set(collapsed);
  save(KEY, collapsed ? 'collapsed' : 'expanded');
}

export function toggleNav(): void {
  setNavCollapsed(!navCollapsed.get());
}

/** The list at `px` wide, as a drag of its edge or the arrow keys on it ask: folded below NAV_FOLD, else open within range. */
export function resizeNav(px: number): void {
  if (px < NAV_FOLD) {
    if (!navCollapsed.get()) setNavCollapsed(true);
    return;
  }
  const width = Math.round(Math.min(NAV_MAX, Math.max(NAV_MIN, px)));
  navWidth.set(width);
  save(WIDTH_KEY, String(width));
  if (navCollapsed.get()) setNavCollapsed(false);
}

/** Double-click on the edge: open at the usual width. */
export function resetNavWidth(): void {
  resizeNav(NAV_WIDTH);
}

/** Ctrl+B (⌘B on macOS) toggles the list, as in the other ZAI products. */
export function isNavShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyB';
}
