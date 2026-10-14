// UI language: follows the system by default (Russian system -> Russian UI,
// anything else -> English) and can be forced in settings. Port of src/App/Strings.cs.

export type UiLanguageChoice = 'Auto' | 'Russian' | 'English';

let russian = true;

/** systemLocale: e.g. app.getLocale() in Electron or Intl default in a CLI. */
export function applyLanguage(choice: UiLanguageChoice, systemLocale?: string): void {
  if (choice === 'Russian') russian = true;
  else if (choice === 'English') russian = false;
  else {
    const loc = (systemLocale ?? Intl.DateTimeFormat().resolvedOptions().locale ?? '').toLowerCase();
    russian = loc.split(/[-_]/)[0] === 'ru';
  }
}

export function isRussian(): boolean {
  return russian;
}

/** Picks the Russian or English text for the current UI language. */
export function t(ru: string, en: string): string {
  return russian ? ru : en;
}
