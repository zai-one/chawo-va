// Call → PC binding → CRM boundary → card. No network. Port of src/App/SalesFlow.cs.
// In the future service the PC is bound once (manager session or softphone/handset id) and a webhook,
// softphone event or hotkey matches that binding; nobody types an extension at popup time. The local
// CRM boundary always answers "no client". standIn() is only the hand-filled stand-in panel.

import type { SalesCatalogItem } from '../settings';
import { findSnippet } from './salesRag';
import { hasToken, match, nameIsClose, withRag, type SalesHit } from './salesCatalog';

export interface TelephonyEvent {
  callId: string;
  trunk: string;
  extension: string;
  callerNumber: string;
  direction: 'inbound' | 'outbound';
}

export interface HandsetBinding {
  trunk: string;
  extension: string;
  managerName: string;
  pcId: string;
}

export interface CrmClient {
  phone: string;
  name: string;
  company: string;
  openDeal: string;
  dealStage: string;
  stageScript: string;
  lastOrder: string;
  spokenProducts: readonly string[];
}

export interface SalesCardView {
  hasCall: boolean;
  whoLine: string;
  scriptLine: string;
  hit: SalesHit | null;
}

export const LOCAL_PC_ID = 'local';

/** CRM boundary. This build has no CRM, so the snapshot is always missing; missing is not an error. */
export function lookupClient(_callerNumber: string): CrmClient | null {
  return null;
}

/** One handset row. An empty extension or an empty manager name is a missing map. */
export function resolve(extension: string, managerName: string, trunk = ''): HandsetBinding | null {
  const ext = extension.trim();
  const manager = managerName.trim();
  if (ext.length === 0 || manager.length === 0) return null;
  return { trunk: trunk.trim(), extension: ext, managerName: manager, pcId: LOCAL_PC_ID };
}

/**
 * Local stand-in only: the same event shape a telephony source fills later (trunk empty, inbound,
 * local call id). Null when the handset map is missing.
 */
export function standIn(extension: string, callerNumber: string, managerName: string, now = Date.now()): { event: TelephonyEvent; binding: HandsetBinding } | null {
  const binding = resolve(extension, managerName);
  if (!binding) return null;
  return {
    event: { callId: `local-${now}`, trunk: '', extension: binding.extension, callerNumber: callerNumber.trim(), direction: 'inbound' },
    binding,
  };
}

/** Catalog hit for the live text; a «похоже» hit also gets the nearest materials paragraph. */
export function hitFor(transcript: string | null | undefined, catalog: readonly SalesCatalogItem[], ragFolder: string | null | undefined, spoken?: readonly string[] | null): SalesHit | null {
  if (!transcript || !transcript.trim()) return null;
  let hit = match(transcript, catalog);
  hit = preferSpokenHistory(transcript, catalog, hit, spoken ?? null);
  if (!hit) return null;
  // Exact code is enough. When the code is missing, also look in the local materials folder.
  if (hit.kind === 'Similar') {
    const snip = findSnippet(transcript, ragFolder);
    if (snip) hit = withRag(hit, snip.text);
  }
  return hit;
}

export function compose(
  ev: TelephonyEvent,
  binding: HandsetBinding,
  transcript: string | null | undefined,
  catalog: readonly SalesCatalogItem[],
  ragFolder: string | null | undefined,
  lookup: (number: string) => CrmClient | null = lookupClient,
): SalesCardView {
  const client = lookup(ev.callerNumber);
  return {
    hasCall: true,
    whoLine: formatWho(ev, binding, client),
    scriptLine: formatScript(client),
    hit: hitFor(transcript, catalog, ragFolder, client?.spokenProducts),
  };
}

/**
 * Exact heard code wins. A heard similar-code wins over history. Otherwise a spoken product that is
 * also close to the live text replaces a weak name hit. History never upgrades a row to exact.
 * With no CRM snapshot this does nothing.
 */
export function preferSpokenHistory(
  transcript: string,
  items: readonly SalesCatalogItem[],
  hit: SalesHit | null,
  spoken: readonly string[] | null,
): SalesHit | null {
  if (hit && hit.kind === 'Exact') return hit;
  if (!spoken || spoken.length === 0) return hit;
  if (hit && heardSimilarCode(transcript, items, hit)) return hit;
  for (const item of items) {
    if (!spokenMentions(spoken, item)) continue;
    if (!nameIsClose(transcript, item.Name)) continue;
    const name = item.Name.trim();
    return { kind: 'Similar', name: name.length > 0 ? name : item.Code.trim(), line: item.Line.trim(), code: item.Code.trim(), ragSnippet: '' };
  }
  return hit;
}

const sameCi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function heardSimilarCode(transcript: string, items: readonly SalesCatalogItem[], hit: SalesHit): boolean {
  for (const item of items) {
    if (!sameCi(item.Code.trim(), hit.code)) continue;
    const code = item.SimilarCode.trim();
    if (code.length >= 2 && hasToken(transcript, code)) return true;
  }
  return false;
}

function spokenMentions(spoken: readonly string[], item: SalesCatalogItem): boolean {
  for (const raw of spoken) {
    const s = raw.trim();
    if (s.length === 0) continue;
    if (sameCi(s, item.Code.trim()) || sameCi(s, item.Name.trim())) return true;
  }
  return false;
}

export function formatWho(ev: TelephonyEvent, binding: HandsetBinding, client: CrmClient | null): string {
  const number = ev.callerNumber.length === 0 ? 'номер скрыт' : ev.callerNumber;
  const head = `${binding.managerName} · трубка ${binding.extension} · ${number}`;
  if (!client) return `${head}\nклиент по номеру не найден`;
  const bits: string[] = [];
  if (client.name.length > 0) bits.push(client.name);
  if (client.company.length > 0) bits.push(client.company);
  if (client.openDeal.length > 0) bits.push(client.openDeal);
  if (client.lastOrder.length > 0) bits.push(`заказ: ${client.lastOrder}`);
  return `${head}\n${bits.length === 0 ? 'клиент без имени' : bits.join(', ')}`;
}

export function formatScript(client: CrmClient | null): string {
  if (!client) return 'скрипт стадии: нет данных';
  const stage = client.dealStage.trim();
  const script = client.stageScript.trim();
  if (script.length > 0) return stage.length === 0 ? script : `${stage}: ${script}`;
  if (stage.length > 0) return `${stage} — текст скрипта не задан`;
  return 'скрипт стадии: нет данных';
}
