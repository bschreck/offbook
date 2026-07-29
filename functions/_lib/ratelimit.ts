import type { ApiError } from '../../src/shared/sync/protocol';
import type { Env } from './env';
import { json } from './http';

/**
 * Fixed-window attempt counters in D1. ADR-0008 "Sessions": credential stuffing should be
 * expensive even though the expensive KDF runs on the client, where we cannot charge for it.
 *
 * Keyed separately by username and by address so neither shape of attack is cheap: a
 * targeted attack burns the `u:` budget, a spray across many usernames burns the `ip:` one.
 *
 * A fixed window rather than a sliding one because the whole thing is two integers per key
 * and the imprecision at a window boundary buys an attacker at most one extra burst.
 */

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_MAX_ATTEMPTS = 10;

export function usernameKey(normalizedUsername: string): string {
  return `u:${normalizedUsername}`;
}

export function ipKey(ip: string): string {
  return `ip:${ip}`;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the most restrictive tripped window rolls over. 0 when allowed. */
  retryAfterSeconds: number;
}

interface CounterRow {
  count: number;
  window_start: number;
}

/**
 * Counts the attempt and reports whether it is allowed, in one round trip. Counting before
 * verifying is deliberate: an attempt that we refuse to answer must still cost the attacker
 * budget, otherwise the limiter can be sidestepped by never completing a request.
 */
export async function countAttempt(
  env: Env,
  keys: readonly string[],
  now: number,
): Promise<RateLimitVerdict> {
  const windowFloor = now - RATE_LIMIT_WINDOW_MS;

  // ON CONFLICT ... RETURNING makes increment-and-read atomic, so two concurrent attempts
  // cannot both read the pre-increment count.
  const statements = keys.map((key) =>
    env.DB.prepare(
      'INSERT INTO login_attempts (key, count, window_start) VALUES (?1, 1, ?2)' +
        ' ON CONFLICT(key) DO UPDATE SET' +
        ' count = CASE WHEN login_attempts.window_start <= ?3 THEN 1' +
        ' ELSE login_attempts.count + 1 END,' +
        ' window_start = CASE WHEN login_attempts.window_start <= ?3 THEN ?2' +
        ' ELSE login_attempts.window_start END' +
        ' RETURNING count, window_start',
    ).bind(key, now, windowFloor),
  );

  const batched = await env.DB.batch<CounterRow>(statements);

  let retryAfterMs = 0;
  for (const result of batched) {
    const row = result.results[0];
    if (!row) continue;
    if (row.count <= RATE_LIMIT_MAX_ATTEMPTS) continue;
    retryAfterMs = Math.max(retryAfterMs, row.window_start + RATE_LIMIT_WINDOW_MS - now);
  }

  if (retryAfterMs <= 0) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
}

/**
 * Clears a key after a genuine success. Only ever called with the username key: clearing the
 * address key would let an attacker who holds one valid account reset the spray budget.
 */
export async function clearAttempts(env: Env, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await env.DB.batch(
    keys.map((key) => env.DB.prepare('DELETE FROM login_attempts WHERE key = ?1').bind(key)),
  );
}

function humanDelay(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return 'in about a minute';
  return `in about ${minutes} minutes`;
}

/**
 * The message says when to come back and nothing else. In particular it must not vary with
 * whether the username exists, or the limiter becomes an enumeration oracle.
 */
export function tooManyAttempts(retryAfterSeconds: number): Response {
  const body: ApiError = {
    error: 'rate-limited',
    message: `Too many attempts. Please try again ${humanDelay(retryAfterSeconds)}.`,
  };
  return json(body, {
    status: 429,
    headers: { 'retry-after': String(retryAfterSeconds) },
  });
}
