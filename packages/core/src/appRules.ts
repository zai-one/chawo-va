// Per-app modes (IDEAS.md №4, after VoiceInk Power Modes): a rule says how a take is edited when a
// given program had the focus at key press. A rule only overrides; with no rules, or none matching,
// the global Brain and simple-syntax settings apply unchanged. No Electron imports.

export type AppRuleEdit = 'Default' | 'Off' | 'Custom';
export type AppRuleToggle = 'Default' | 'On' | 'Off';

export interface AppRule {
  /** Program name (telegram, winword.exe) or a piece of the window title; several separated by , or ;. */
  Match: string;
  /** Default: as on the Brain page. Off: no rewrite of every take («Чаво, …» still works). Custom: rewrite every take with Instruction. */
  Edit: AppRuleEdit;
  /** For Edit = Custom; empty means the standard cleanup. */
  Instruction: string;
  /** Simple syntax (lowercase, no closing period) for this program. */
  SimpleSyntax: AppRuleToggle;
}

/** The program that had the focus when the key went down. Title stays in memory only. */
export interface ForegroundApp {
  /** Executable file name as the OS reports it, e.g. "Telegram.exe" or "telegram-desktop". */
  exe: string;
  title: string;
}

export const MAX_APP_RULES = 50;
const MAX_FIELD = 4000;

export function emptyRule(match = ''): AppRule {
  return { Match: match, Edit: 'Off', Instruction: '', SimpleSyntax: 'Default' };
}

function str(v: unknown, max = MAX_FIELD): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** settings.json → rules; junk entries are dropped, unknown values fall back to Default. */
export function parseAppRules(raw: unknown): AppRule[] {
  if (!Array.isArray(raw)) return [];
  const out: AppRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    out.push({
      Match: str(o.Match, 500),
      Edit: oneOf(o.Edit, ['Default', 'Off', 'Custom'] as const, 'Default'),
      Instruction: str(o.Instruction),
      SimpleSyntax: oneOf(o.SimpleSyntax, ['Default', 'On', 'Off'] as const, 'Default'),
    });
    if (out.length >= MAX_APP_RULES) break;
  }
  return out;
}

/** "Telegram.exe" → "telegram"; paths and the Windows/mac suffixes go. */
export function exeKey(exe: string): string {
  const base = exe.trim().split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(exe|app)$/i, '').toLowerCase();
}

/** Tokens of a rule's Match: split on , and ;, trimmed, lowercased, empty ones dropped. */
export function matchTokens(match: string): string[] {
  return match.split(/[,;]/).map((x) => x.trim().toLowerCase()).filter((x) => x.length > 0);
}

/** A rule with at least one token. Rules with an empty Match never fire (a half-filled row). */
export function isActive(rule: AppRule): boolean {
  return matchTokens(rule.Match).length > 0;
}

export function hasActiveRules(rules: readonly AppRule[] | undefined): boolean {
  return (rules ?? []).some(isActive);
}

/**
 * A token matches the program name exactly (with or without .exe), or is a piece of the window
 * title (case-insensitive, ё = е). Program names are matched exactly so "code" does not hit "vscode-…".
 */
export function ruleMatches(rule: AppRule, app: ForegroundApp): boolean {
  const name = exeKey(app.exe);
  const title = fold(app.title);
  for (const token of matchTokens(rule.Match)) {
    if (name.length > 0 && exeKey(token) === name) return true;
    if (title.length > 0 && token.length >= 2 && title.includes(fold(token))) return true;
  }
  return false;
}

function fold(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

/** First matching rule wins (the list order is the user's priority). */
export function findRule(rules: readonly AppRule[] | undefined, app: ForegroundApp | null): { rule: AppRule; index: number } | null {
  if (!app || !rules) return null;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (isActive(rule) && ruleMatches(rule, app)) return { rule, index: i };
  }
  return null;
}

export interface EditSettings {
  BrainEveryTake: boolean;
  BrainInstruction: string;
  SimpleSyntax: boolean;
}

/** The edit settings a take uses under a rule; the input object is not changed. */
export function applyRule<T extends EditSettings>(s: T, rule: AppRule | null): T {
  if (!rule) return s;
  const out = { ...s };
  if (rule.Edit === 'Off') out.BrainEveryTake = false;
  else if (rule.Edit === 'Custom') {
    out.BrainEveryTake = true;
    out.BrainInstruction = rule.Instruction;
  }
  if (rule.SimpleSyntax === 'On') out.SimpleSyntax = true;
  else if (rule.SimpleSyntax === 'Off') out.SimpleSyntax = false;
  return out;
}

/** What to prefill when the user adds a rule for the last program seen: "telegram". */
export function suggestedMatch(app: ForegroundApp | null): string {
  return app ? exeKey(app.exe) : '';
}
