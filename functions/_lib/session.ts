import { toBase64 } from '../../src/shared/auth/kdf';
import type { AuthedUser, Env } from './env';
import { readCookie, SESSION_COOKIE } from './http';

/**
 * Opaque session tokens, not JWTs: we have a database, so revocation should be real
 * (ADR-0008 "Sessions"). Only SHA-256(token) is ever stored, so a database leak yields
 * nothing that can be replayed as a session.
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/**
 * `last_seen_at` exists for future session housekeeping, not for authorisation, so it is
 * not worth a write on every authenticated request — a sync burst would otherwise cost one
 * D1 write per call.
 */
const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000;

const TOKEN_BYTES = 32;

const SWEEP_SQL = 'DELETE FROM sessions WHERE expires_at <= ?1';

function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Exported because the test suite asserts that the stored row is not the token itself. */
export async function hashSessionToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export interface CreatedSession {
  /** The only time the plaintext token exists server-side. It goes straight into a cookie. */
  token: string;
  expiresAt: number;
}

export async function createSession(
  env: Env,
  userId: string,
  now: number,
): Promise<CreatedSession> {
  const raw = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(raw);
  const token = base64url(raw);
  const tokenHash = await hashSessionToken(token);
  const expiresAt = now + SESSION_TTL_MS;

  // One batch: the insert plus the opportunistic purge. Sign-in is already a write, so
  // sweeping dead rows here costs nothing extra and spares us a cron trigger.
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)' +
        ' VALUES (?1, ?2, ?3, ?4, ?3)',
    ).bind(tokenHash, userId, now, expiresAt),
    env.DB.prepare(SWEEP_SQL).bind(now),
  ]);

  return { token, expiresAt };
}

interface SessionJoinRow {
  id: string;
  username: string;
  username_display: string;
  usage_bytes: number;
  rev: number;
  expires_at: number;
  last_seen_at: number;
}

/**
 * The single authorisation entry point. The sync module imports this exact function, so the
 * name and signature are part of the internal contract — see the module map in ADR-0008.
 *
 * Returns null for every failure mode (no cookie, unknown token, expired row) because the
 * caller has only one thing to say about all of them, and distinguishing them in a response
 * would tell an attacker which tokens once existed.
 */
export async function requireUser(
  request: Request,
  env: Env,
  now: number,
): Promise<AuthedUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const tokenHash = await hashSessionToken(token);
  const row = await env.DB.prepare(
    'SELECT u.id AS id, u.username AS username, u.username_display AS username_display,' +
      ' u.usage_bytes AS usage_bytes, u.rev AS rev,' +
      ' s.expires_at AS expires_at, s.last_seen_at AS last_seen_at' +
      ' FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1',
  )
    .bind(tokenHash)
    .first<SessionJoinRow>();

  if (!row) return null;

  if (row.expires_at <= now) {
    // Drop it on the way past: the row is worthless and nobody else will come looking.
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
    return null;
  }

  if (now - row.last_seen_at >= LAST_SEEN_REFRESH_MS) {
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ?2 WHERE token_hash = ?1')
      .bind(tokenHash, now)
      .run();
  }

  return {
    id: row.id,
    username: row.username,
    usernameDisplay: row.username_display,
    usageBytes: row.usage_bytes,
    rev: row.rev,
  };
}

export async function destroySession(env: Env, token: string): Promise<void> {
  const tokenHash = await hashSessionToken(token);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
}

/** Opportunistic: called from the endpoints that are already writing. */
export async function purgeExpiredSessions(env: Env, now: number): Promise<void> {
  await env.DB.prepare(SWEEP_SQL).bind(now).run();
}
