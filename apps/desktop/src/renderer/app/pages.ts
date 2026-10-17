import type { IconName } from '@chawo/ui/Icon';
import { invoke } from '../bridge';
import { createStore } from './store';

export const PAGES = ['dictation', 'file', 'history', 'speech', 'dictionary', 'sales', 'brain', 'voice', 'network'] as const;
export type PageName = (typeof PAGES)[number];

export const TITLES: Record<PageName, [string, string]> = {
  dictation: ['Диктовка', 'Dictation'],
  file: ['Расшифровка файла', 'File transcription'],
  history: ['История', 'History'],
  speech: ['Распознавание', 'Speech'],
  dictionary: ['Словарь', 'Dictionary'],
  sales: ['Продажи', 'Sales'],
  brain: ['Мозг', 'Brain'],
  voice: ['Голос', 'Voice'],
  network: ['Сеть', 'Network'],
};

/** One Product UI icon per page (zai-brand sprite names), shown beside the title and alone in the rail. */
export const ICONS: Record<PageName, IconName> = {
  dictation: 'mic',
  file: 'file-audio',
  history: 'history',
  speech: 'audio-waveform',
  dictionary: 'book-open',
  sales: 'briefcase',
  brain: 'brain',
  voice: 'volume',
  network: 'network',
};

export const currentPage = createStore<PageName>('dictation');
/** Counts page openings: a click on the open page's button opens it again (reloads its state), as before. */
export const pageVisit = createStore(0);

export function isPage(name: string | undefined): name is PageName {
  return (PAGES as readonly string[]).includes(name ?? '');
}

/** Switches the page. Leaving «Мозг» lets main stop what that page started (model list refresh). */
export function showPage(name: PageName): void {
  if (currentPage.get() === 'brain' && name !== 'brain') void invoke('brain:close');
  currentPage.set(name);
  pageVisit.update((n) => n + 1);
}
