import type { ApiError } from '../../src/shared/sync/protocol';

/**
 * Response helpers. Every error body is `{error, message}` where `message` is written for a
 * human, because the client shows it verbatim in a toast rather than inventing its own copy.
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // Never let a browser or intermediary cache an authenticated response.
  'cache-control': 'no-store',
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

export function fail(status: number, error: string, message: string): Response {
  return json({ error, message } satisfies ApiError, { status });
}

export const unauthorized = () =>
  fail(401, 'unauthorized', 'You are not signed in on this device.');

/** Bodies are small by design; a huge one is refused before it is parsed. */
export async function readJson<T>(request: Request, maxBytes = 8 * 1024 * 1024): Promise<T | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return null;
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = 'offbook_session';

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * `SameSite=Lax` rather than `Strict`: the app is a single origin, and Strict would drop the
 * cookie on a cold navigation from an external link, silently signing the user out.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Best-effort client address for rate limiting. Spoofable, so it is never an authz input. */
export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
}
