// Auth and bind rules for `chawo-va serve`.
// Without a token the server may only bind loopback. With a token it may bind 0.0.0.0 / a custom
// host. Non-loopback peers always need `Authorization: Bearer <token>`; loopback peers may skip
// the header (local use). Tokens never go in the query string.

import { isLoopback } from './hermesServer';

export const DEFAULT_SERVE_PORT = 17831;
export const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const ENV_TOKEN = 'CHAWO_SERVE_TOKEN';
export const ENV_DATA_DIR = 'CHAWO_SERVE_DATA_DIR';

export type BindDecision =
  | { ok: true; host: string; listenOnLan: boolean }
  | { ok: false; error: string };

/** Resolve the listen address. Non-loopback binds are refused when there is no token. */
export function resolveBind(host: string | undefined | null, token: string | null | undefined): BindDecision {
  const t = (token ?? '').trim();
  const hasToken = t.length > 0;
  const raw = (host ?? '').trim();
  const h = raw.length === 0 ? (hasToken ? '0.0.0.0' : '127.0.0.1') : raw;

  if (isLoopback(h) || h === 'localhost') {
    return { ok: true, host: h === 'localhost' ? '127.0.0.1' : h, listenOnLan: false };
  }
  // 0.0.0.0 / :: / a LAN IP — only with a token.
  if (!hasToken) {
    return {
      ok: false,
      error:
        'refusing to bind non-loopback without a token; pass --token or set CHAWO_SERVE_TOKEN, or bind 127.0.0.1',
    };
  }
  return { ok: true, host: h, listenOnLan: true };
}

/** True when the request is allowed. Loopback may skip the bearer; everyone else needs it when a token is set. */
export function authorize(
  authorizationHeader: string | undefined,
  token: string | null | undefined,
  remoteAddress: string | undefined,
): { ok: true } | { ok: false; status: 401 | 403; error: string } {
  const t = (token ?? '').trim();
  const loopback = isLoopback(remoteAddress);
  if (!t) {
    // No token configured → localhost-only server; non-loopback already blocked by bind / peer check.
    if (!loopback) return { ok: false, status: 403, error: 'localhost_only' };
    return { ok: true };
  }
  if (loopback) return { ok: true };
  const got = parseBearer(authorizationHeader);
  if (got === null) return { ok: false, status: 401, error: 'unauthorized' };
  if (got !== t) return { ok: false, status: 401, error: 'unauthorized' };
  return { ok: true };
}

export function parseBearer(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader.trim());
  return m ? m[1]! : null;
}

/** Token from CLI flag, else env. Empty string → null. */
export function resolveToken(cliToken: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromCli = (cliToken ?? '').trim();
  if (fromCli) return fromCli;
  const fromEnv = (env[ENV_TOKEN] ?? '').trim();
  return fromEnv.length > 0 ? fromEnv : null;
}
