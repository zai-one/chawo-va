// The UI language is picked in main (Auto follows the OS locale) and comes with every page state as
// `ru`; the window follows the last one it saw.
import { createStore, useStore } from './store';

export const lang = createStore<boolean>(true);

/** Russian or English text for the current UI language. */
export type Tr = (ru: string, en: string) => string;

export function useL(): Tr {
  const ru = useStore(lang);
  return (r, e) => (ru ? r : e);
}

export function useRu(): boolean {
  return useStore(lang);
}

/** Outside React (microphone code, status lines). */
export const L: Tr = (r, e) => (lang.get() ? r : e);

lang.subscribe(() => {
  document.documentElement.lang = lang.get() ? 'ru' : 'en';
});
