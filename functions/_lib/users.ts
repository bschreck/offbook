import {
  AUTH_KDF_VERSION,
  fromBase64,
  hashAuthKey,
  normalizeUsername,
  randomSaltB64,
  timingSafeEqual,
  toBase64,
} from '../../src/shared/auth/kdf';
import { type AccountInfo, MAX_ACCOUNT_BYTES, USERNAME_RE } from '../../src/shared/sync/protocol';
import type { Env } from './env';

/**
 * User creation and lookup. The server only ever sees `authKey`, never a password
 * (ADR-0008 "Why the password KDF runs in the browser"), and stores only
 * PBKDF2(authKey, per-user salt).
 */

export interface UserRow {
  id: string;
  username: string;
  username_display: string;
  pw_hash: string;
  server_salt: string;
  kdf_version: number;
  created_at: number;
  rev: number;
  usage_bytes: number;
}

const USER_COLUMNS =
  'id, username, username_display, pw_hash, server_salt, kdf_version, created_at, rev, usage_bytes';

/** 32 bytes of base64 is 43 characters plus one pad. Anything else is not an authKey. */
const AUTH_KEY_B64_RE = /^[A-Za-z0-9+/]{43}=$/;
const AUTH_KEY_BYTES = 32;

/** A raw username longer than this is rejected before it is normalised or hashed. */
const MAX_USERNAME_INPUT = 64;

/**
 * A wrong password and an unknown username must cost the same, so the unknown-username path
 * still runs a real PBKDF2 against these. Both are the right length, so `timingSafeEqual`
 * does not take its length-mismatch shortcut either.
 */
const DUMMY_SALT = toBase64(new Uint8Array(16));
const DUMMY_HASH = toBase64(new Uint8Array(AUTH_KEY_BYTES));

export interface Credentials {
  /** Normalised: the identity, the unique index and the KDF salt all use this exact value. */
  username: string;
  /** What the user typed, kept for display only. */
  usernameDisplay: string;
  authKey: string;
}

export type CredentialCheck =
  | { ok: true; credentials: Credentials }
  | { ok: false; error: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidAuthKey(value: unknown): value is string {
  if (typeof value !== 'string' || !AUTH_KEY_B64_RE.test(value)) return false;
  try {
    return fromBase64(value).length === AUTH_KEY_BYTES;
  } catch {
    return false;
  }
}

const badUsernameMessage =
  'A username is 3 to 32 characters, lower case letters, digits, dots, dashes or underscores,' +
  ' starting and ending with a letter or digit.';

/**
 * Shape validation for both register and login. Messages describe the rule, never the value —
 * an authKey must not appear in a response body or a log line.
 */
export function readCredentials(body: unknown): CredentialCheck {
  if (!isRecord(body)) {
    return { ok: false, error: 'malformed', message: 'That request could not be read.' };
  }

  const rawUsername = body.username;
  if (typeof rawUsername !== 'string' || rawUsername.length > MAX_USERNAME_INPUT) {
    return { ok: false, error: 'bad-username', message: badUsernameMessage };
  }
  const username = normalizeUsername(rawUsername);
  if (!USERNAME_RE.test(username)) {
    return { ok: false, error: 'bad-username', message: badUsernameMessage };
  }

  if (!isValidAuthKey(body.authKey)) {
    return {
      ok: false,
      error: 'malformed',
      message: 'That sign-in could not be read. Please try again.',
    };
  }

  // Login omits the version (the client only sends it on register), so it is checked when
  // present. A mismatch means the two sides disagree about the KDF and nothing can match.
  const version = body.kdfVersion;
  if (version !== undefined && version !== AUTH_KDF_VERSION) {
    return {
      ok: false,
      error: 'kdf-version',
      message: 'This app is out of date. Please reload and try again.',
    };
  }

  return {
    ok: true,
    credentials: { username, usernameDisplay: rawUsername.trim(), authKey: body.authKey },
  };
}

export async function findUser(env: Env, username: string): Promise<UserRow | null> {
  return await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?1`)
    .bind(username)
    .first<UserRow>();
}

/**
 * A second read after `requireUser`, because `AuthedUser` deliberately does not carry
 * `createdAt` — it exists to authorise a request, and only `/auth/me` needs the whole
 * account. One extra indexed point read is cheaper than widening the authorisation path.
 */
export async function findUserById(env: Env, id: string): Promise<UserRow | null> {
  return await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?1`)
    .bind(id)
    .first<UserRow>();
}

export type CreateUserResult = { ok: true; user: UserRow } | { ok: false; reason: 'taken' };

export async function createUser(
  env: Env,
  credentials: Credentials,
  now: number,
): Promise<CreateUserResult> {
  const existing = await findUser(env, credentials.username);
  if (existing) return { ok: false, reason: 'taken' };

  const serverSalt = randomSaltB64();
  const pwHash = await hashAuthKey(credentials.authKey, serverSalt);
  const user: UserRow = {
    id: crypto.randomUUID(),
    username: credentials.username,
    username_display: credentials.usernameDisplay || credentials.username,
    pw_hash: pwHash,
    server_salt: serverSalt,
    kdf_version: AUTH_KDF_VERSION,
    created_at: now,
    rev: 0,
    usage_bytes: 0,
  };

  try {
    await env.DB.prepare(
      `INSERT INTO users (${USER_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0)`,
    )
      .bind(
        user.id,
        user.username,
        user.username_display,
        user.pw_hash,
        user.server_salt,
        user.kdf_version,
        user.created_at,
      )
      .run();
  } catch (error) {
    // Two registrations for the same name in the same instant: the unique index is the
    // arbiter, not the read above. Anything else is a real failure and must not be swallowed.
    if (isUniqueViolation(error)) return { ok: false, reason: 'taken' };
    throw error;
  }

  return { ok: true, user };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/**
 * Verifies an authKey, taking the same work whether or not the user exists. The caller must
 * pass the null row rather than short-circuiting, or login becomes a username oracle by
 * timing — see the security requirements in ADR-0008.
 */
export async function verifyAuthKey(row: UserRow | null, authKey: string): Promise<boolean> {
  const salt = row?.server_salt ?? DUMMY_SALT;
  const expected = row?.pw_hash ?? DUMMY_HASH;
  const actual = await hashAuthKey(authKey, salt);
  const matches = timingSafeEqual(actual, expected);
  // A stored hash from another KDF version cannot be compared against this authKey. Only
  // version 1 exists, so this is unreachable today; when it is not, the fix is to re-derive
  // on the next successful sign-in, not to relax the check.
  return row !== null && row.kdf_version === AUTH_KDF_VERSION && matches;
}

export function accountInfo(user: {
  username_display: string;
  created_at: number;
  usage_bytes: number;
}): AccountInfo {
  return {
    username: user.username_display,
    createdAt: user.created_at,
    usageBytes: user.usage_bytes,
    quotaBytes: MAX_ACCOUNT_BYTES,
  };
}
