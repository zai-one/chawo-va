// The sales card's state and the main-side flow, without Electron. Port of SalesCardWindow.ShowModel /
// HideNow (state + "same as shown" check) and App.ShowSales / PresentCall / PaintCall. The card is a
// small always-on-top window that never takes focus (salesCardWindow.ts draws it). No network, no model.

import { t } from '../../core/strings';
import type { SettingsData } from '../settings';
import type { SalesHitKind } from './salesCatalog';
import { compose, hitFor, lookupClient, standIn, type CrmClient, type HandsetBinding, type SalesCardView, type TelephonyEvent } from './salesFlow';

export interface SalesCardState {
  visible: boolean;
  hasCall: boolean;
  /** «звонок» header over who/script; shown only with a call. */
  callHead: string;
  who: string;
  script: string;
  hasHit: boolean;
  /** «похоже» badge (a similar hit); hidden on an exact code. */
  badge: string;
  kind: SalesHitKind;
  name: string;
  line: string;
  ragLabel: string;
  rag: string;
}

/** What the flow calls on the card window. */
export interface SalesCardSink {
  showModel(view: SalesCardView): void;
  hideNow(): void;
}

export function hiddenCard(): SalesCardState {
  return {
    visible: false, hasCall: false, callHead: 'звонок', who: '', script: '', hasHit: false,
    badge: 'похоже', kind: 'Similar', name: '', line: '', ragLabel: 'из материалов', rag: '',
  };
}

/** SalesCardWindow state: render is called only when something visible changed. */
export class SalesCardModel implements SalesCardSink {
  private s: SalesCardState = hiddenCard();

  constructor(private readonly render: (s: SalesCardState) => void) {}

  get state(): SalesCardState {
    return { ...this.s };
  }

  showModel(view: SalesCardView): void {
    const hit = view.hit;
    const next: SalesCardState = {
      ...hiddenCard(),
      visible: true,
      hasCall: view.hasCall,
      who: view.hasCall ? view.whoLine : '',
      script: view.hasCall ? view.scriptLine : '',
      hasHit: hit !== null,
      kind: hit?.kind ?? 'Similar',
      name: hit?.name ?? '',
      line: hit?.line ?? '',
      rag: hit?.ragSnippet ?? '',
    };
    const p = this.s;
    if (p.visible && p.hasCall === next.hasCall && p.who === next.who && p.script === next.script && p.hasHit === next.hasHit
      && p.kind === next.kind && p.name === next.name && p.line === next.line && p.rag === next.rag) return;
    this.s = next;
    this.render(this.state);
  }

  hideNow(): void {
    const was = this.s.visible;
    this.s = hiddenCard();
    if (was) this.render(this.state);
  }
}

export interface SalesFlowHooks {
  settings: () => SettingsData;
  card: SalesCardSink;
  /** CRM boundary; this build always answers null. */
  lookup?: (number: string) => CrmClient | null;
  now?: () => number;
}

/** App.ShowSales / PresentCall / PaintCall and the Sales branch of ApplySettings. */
export class SalesSession {
  private openCall: TelephonyEvent | null = null;
  private openBinding: HandsetBinding | null = null;
  private transcript = '';

  constructor(private readonly h: SalesFlowHooks) {}

  get hasOpenCall(): boolean {
    return this.openCall !== null;
  }

  /** A live draft or a recognized take. Local catalog card only: no model download, no network. */
  show(transcript: string): void {
    const s = this.h.settings();
    if (s.Mode !== 'Sales') return;
    this.transcript = transcript;
    if (this.openCall && this.openBinding) {
      this.paintCall();
      return;
    }
    const hit = hitFor(transcript, s.SalesCatalog, s.RagFolder);
    if (!hit) return;
    this.h.card.showModel({ hasCall: false, whoLine: '', scriptLine: '', hit });
  }

  /**
   * Hand-filled stand-in for a call event. An empty extension or manager name is a missing binding:
   * no card. Returns the status line for the page.
   */
  presentCall(extension: string, number: string, manager: string): string {
    if (this.h.settings().Mode !== 'Sales') {
      return t('Сначала включите режим «Продажи» на вкладке «Диктовка».', 'Turn on Sales mode on the Dictation tab first.');
    }
    const stood = standIn(extension, number, manager, this.h.now?.() ?? Date.now());
    if (!stood) {
      this.closeCall();
      this.h.card.hideNow();
      return t('Стенд: нет привязки трубки к менеджеру. Карточка не показывается.', 'Stand-in: no handset-to-manager binding. No card.');
    }
    this.openCall = stood.event;
    this.openBinding = stood.binding;
    this.transcript = '';
    this.paintCall();
    return t('Стенд: карточка на этом компьютере. CRM нет, сеть не используется.', 'Stand-in: card on this PC. No CRM, no network.');
  }

  /** Settings were applied: leaving «Продажи» closes the call and hides the card. A catalog edit repaints an open call. */
  settingsChanged(): void {
    if (this.h.settings().Mode !== 'Sales') {
      this.closeCall();
      this.h.card.hideNow();
      return;
    }
    if (this.openCall) this.paintCall();
  }

  /** The card's own close button: hides it and ends the stand-in call. */
  dismiss(): void {
    this.closeCall();
    this.h.card.hideNow();
  }

  private closeCall(): void {
    this.openCall = null;
    this.openBinding = null;
  }

  private paintCall(): void {
    if (!this.openCall || !this.openBinding) return;
    const s = this.h.settings();
    this.h.card.showModel(compose(this.openCall, this.openBinding, this.transcript, s.SalesCatalog, s.RagFolder, this.h.lookup ?? lookupClient));
  }
}
