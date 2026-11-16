export const GRAPH_VERSION = 'v21.0';
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How the publisher should react to a failure (PRD section 9):
 * - auth: token revoked/expired; never retry, ask the user to reconnect
 * - rate_limited / transient: safe to retry later with backoff
 * - permanent: the request itself is wrong; surface as NEEDS_ACTION
 * - ambiguous: the request may have reached Meta; reconcile before any retry
 */
export type FailureKind = 'auth' | 'rate_limited' | 'transient' | 'permanent' | 'ambiguous';

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly providerCode?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const AUTH_CODES = new Set([102, 190]);
const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80004]);
const TRANSIENT_CODES = new Set([1, 2]);

type GraphErrorBody = {
  error?: {message?: string; code?: number; error_subcode?: number; is_transient?: boolean};
};

function classify(status: number, body: GraphErrorBody, retryAfter: string | null): PlatformError {
  const err = body.error || {};
  const code = err.code;
  const sub = err.error_subcode;
  const providerCode = code !== undefined ? `${code}${sub ? `/${sub}` : ''}` : `http_${status}`;
  const message = err.message || `Meta API error (${status})`;
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;

  if ((code !== undefined && AUTH_CODES.has(code)) || (sub !== undefined && AUTH_SUBCODES.has(sub))) {
    return new PlatformError(message, 'auth', providerCode);
  }
  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
    return new PlatformError(message, 'rate_limited', providerCode, retryAfterMs);
  }
  if (status >= 500 || err.is_transient || (code !== undefined && TRANSIENT_CODES.has(code))) {
    return new PlatformError(message, 'transient', providerCode, retryAfterMs);
  }
  return new PlatformError(message, 'permanent', providerCode);
}

/**
 * Calls the Graph API. A network failure or timeout on a write is `ambiguous` because Meta may
 * already have acted on it; on a read it is `transient`.
 */
export async function graphRequest<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<T> {
  const query = new URLSearchParams({...params, access_token: token});
  const url = method === 'POST' ? `${GRAPH_BASE}${path}` : `${GRAPH_BASE}${path}?${query}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: method === 'POST' ? {'Content-Type': 'application/x-www-form-urlencoded'} : undefined,
      body: method === 'POST' ? query.toString() : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PlatformError(
      `No response from Meta (${reason})`,
      method === 'GET' ? 'transient' : 'ambiguous',
      'network',
    );
  }
  const body = (await response.json().catch(() => ({}))) as T & GraphErrorBody;
  if (!response.ok || body?.error) {
    throw classify(response.status, body, response.headers.get('retry-after'));
  }
  return body;
}
