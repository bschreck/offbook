import { beforeEach, describe, expect, it } from 'vitest';
import type { Ctx, Env } from '../../../functions/_lib/env';
import { SESSION_COOKIE, sessionCookie } from '../../../functions/_lib/http';
import { RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS } from '../../../functions/_lib/ratelimit';
import { hashSessionToken, requireUser, SESSION_TTL_MS } from '../../../functions/_lib/session';
import { readCredentials } from '../../../functions/_lib/users';
import { onRequestPost as login } from '../../../functions/api/auth/login';
import { onRequestPost as logout } from '../../../functions/api/auth/logout';
import { onRequestGet as me } from '../../../functions/api/auth/me';
import { onRequestPost as register } from '../../../functions/api/auth/register';
import { AUTH_KDF_VERSION, toBase64 } from '../../../src/shared/auth/kdf';
import type { AccountInfo, ApiError } from '../../../src/shared/sync/protocol';
import { USERNAME_RE } from '../../../src/shared/sync/protocol';

/**
 * A fake D1 rather than a dependency or a real database file. It understands exactly the
 * statements `functions/_lib/**` issues and nothing else — an unrecognised statement throws,
 * so a query added without a matching branch here fails loudly instead of silently passing.
 */

interface UserRecord {
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

interface SessionRecord {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

interface AttemptRecord {
  key: string;
  count: number;
  window_start: number;
}

type Row = Record<string, unknown>;

class FakeDb {
  users: UserRecord[] = [];
  sessions: SessionRecord[] = [];
  attempts: AttemptRecord[] = [];
  /** Every statement executed, so a test can assert that a write did NOT happen. */
  log: string[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql, []);
  }

  async batch<T>(statements: FakeStatement[]): Promise<{ results: T[] }[]> {
    const out: { results: T[] }[] = [];
    for (const statement of statements) out.push({ results: statement.exec() as T[] });
    return out;
  }
}

class FakeStatement {
  constructor(
    private readonly db: FakeDb,
    private readonly sql: string,
    private readonly args: readonly unknown[],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.exec()[0] as T | undefined) ?? null;
  }

  async run<T>(): Promise<{ results: T[] }> {
    return { results: this.exec() as T[] };
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.exec() as T[] };
  }

  exec(): Row[] {
    const sql = this.sql;
    const a = this.args;
    this.db.log.push(sql);

    if (sql.includes('FROM users WHERE username')) {
      const found = this.db.users.find((u) => u.username === a[0]);
      return found ? [{ ...found }] : [];
    }
    if (sql.includes('FROM users WHERE id')) {
      const found = this.db.users.find((u) => u.id === a[0]);
      return found ? [{ ...found }] : [];
    }
    if (sql.startsWith('INSERT INTO users')) {
      const username = a[1] as string;
      if (this.db.users.some((u) => u.username === username)) {
        throw new Error('D1_ERROR: UNIQUE constraint failed: users.username');
      }
      this.db.users.push({
        id: a[0] as string,
        username,
        username_display: a[2] as string,
        pw_hash: a[3] as string,
        server_salt: a[4] as string,
        kdf_version: a[5] as number,
        created_at: a[6] as number,
        rev: 0,
        usage_bytes: 0,
      });
      return [];
    }
    if (sql.startsWith('INSERT INTO sessions')) {
      this.db.sessions.push({
        token_hash: a[0] as string,
        user_id: a[1] as string,
        created_at: a[2] as number,
        expires_at: a[3] as number,
        last_seen_at: a[2] as number,
      });
      return [];
    }
    if (sql.startsWith('DELETE FROM sessions WHERE expires_at')) {
      const now = a[0] as number;
      this.db.sessions = this.db.sessions.filter((s) => s.expires_at > now);
      return [];
    }
    if (sql.startsWith('DELETE FROM sessions WHERE token_hash')) {
      this.db.sessions = this.db.sessions.filter((s) => s.token_hash !== a[0]);
      return [];
    }
    if (sql.startsWith('UPDATE sessions SET last_seen_at')) {
      for (const s of this.db.sessions) {
        if (s.token_hash === a[0]) s.last_seen_at = a[1] as number;
      }
      return [];
    }
    if (sql.includes('FROM sessions s JOIN users')) {
      const session = this.db.sessions.find((s) => s.token_hash === a[0]);
      if (!session) return [];
      const user = this.db.users.find((u) => u.id === session.user_id);
      if (!user) return [];
      return [
        {
          id: user.id,
          username: user.username,
          username_display: user.username_display,
          usage_bytes: user.usage_bytes,
          rev: user.rev,
          expires_at: session.expires_at,
          last_seen_at: session.last_seen_at,
        },
      ];
    }
    if (sql.startsWith('INSERT INTO login_attempts')) {
      const key = a[0] as string;
      const now = a[1] as number;
      const windowFloor = a[2] as number;
      const existing = this.db.attempts.find((r) => r.key === key);
      if (!existing) {
        const created: AttemptRecord = { key, count: 1, window_start: now };
        this.db.attempts.push(created);
        return [{ count: created.count, window_start: created.window_start }];
      }
      if (existing.window_start <= windowFloor) {
        existing.count = 1;
        existing.window_start = now;
      } else {
        existing.count += 1;
      }
      return [{ count: existing.count, window_start: existing.window_start }];
    }
    if (sql.startsWith('DELETE FROM login_attempts')) {
      this.db.attempts = this.db.attempts.filter((r) => r.key !== a[0]);
      return [];
    }

    throw new Error(`fake D1 has no branch for: ${sql}`);
  }
}

let db: FakeDb;
let env: Env;

beforeEach(() => {
  db = new FakeDb();
  env = { DB: db as unknown as Env['DB'] };
});

/** A pre-derived authKey fixture: 32 bytes of base64. The 600k-iteration client KDF is not
 * exercised here on purpose — it costs half a second and the server never runs it. */
function authKeyFixture(fill: number): string {
  return toBase64(new Uint8Array(32).fill(fill));
}

const GOOD_KEY = authKeyFixture(7);
const OTHER_KEY = authKeyFixture(9);

interface CallOptions {
  cookie?: string;
  ip?: string;
}

function ctxFor(path: string, body: unknown | undefined, options: CallOptions = {}): Ctx {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (options.cookie !== undefined) headers.set('cookie', options.cookie);
  headers.set('cf-connecting-ip', options.ip ?? '203.0.113.7');
  const request = new Request(`https://offbook.test/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { request, env } as unknown as Ctx;
}

function tokenFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(header);
  if (!match?.[1]) throw new Error('no session cookie was set');
  return decodeURIComponent(match[1]);
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function registerUser(username: string, authKey = GOOD_KEY, options: CallOptions = {}) {
  return await register(
    ctxFor('register', { username, authKey, kdfVersion: AUTH_KDF_VERSION }, options),
  );
}

async function loginUser(username: string, authKey = GOOD_KEY, options: CallOptions = {}) {
  return await login(ctxFor('login', { username, authKey }, options));
}

describe('register and login', () => {
  it('registers, then signs in with the same credentials', async () => {
    const created = await registerUser('rosalind');
    expect(created.status).toBe(201);
    const account = await body<AccountInfo>(created);
    expect(account.username).toBe('rosalind');
    expect(account.usageBytes).toBe(0);
    expect(account.quotaBytes).toBeGreaterThan(0);

    const signedIn = await loginUser('rosalind');
    expect(signedIn.status).toBe(200);
    expect((await body<AccountInfo>(signedIn)).username).toBe('rosalind');
  });

  it('refuses a wrong authKey', async () => {
    await registerUser('rosalind');
    const bad = await loginUser('rosalind', OTHER_KEY);
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
  });

  it('normalises the username for identity but keeps what was typed for display', async () => {
    const created = await registerUser('Rosalind');
    expect((await body<AccountInfo>(created)).username).toBe('Rosalind');
    expect(db.users[0]?.username).toBe('rosalind');

    // Any casing of the same name is the same account, because the KDF salt is derived from
    // the normalised form.
    expect((await loginUser('ROSALIND')).status).toBe(200);
  });

  it('says so when a username is taken', async () => {
    await registerUser('rosalind');
    const again = await registerUser('rosalind', OTHER_KEY);
    expect(again.status).toBe(409);
    expect((await body<ApiError>(again)).error).toBe('username-taken');
    expect(db.users).toHaveLength(1);
  });

  it('rejects a kdfVersion it does not implement', async () => {
    const response = await register(
      ctxFor('register', { username: 'rosalind', authKey: GOOD_KEY, kdfVersion: 99 }),
    );
    expect(response.status).toBe(400);
    expect((await body<ApiError>(response)).error).toBe('kdf-version');
  });

  it('rejects an authKey that is not 32 bytes of base64', async () => {
    for (const authKey of ['', 'not base64!!', toBase64(new Uint8Array(16)), GOOD_KEY.slice(1)]) {
      const response = await register(ctxFor('register', { username: 'rosalind', authKey }));
      expect(response.status).toBe(400);
      expect(db.users).toHaveLength(0);
    }
  });

  it('rejects a body that is not an object at all', async () => {
    const response = await register(ctxFor('register', 'nonsense'));
    expect(response.status).toBe(400);
  });
});

describe('what is stored', () => {
  it('stores neither the authKey nor anything derived from it reversibly', async () => {
    await registerUser('rosalind');
    const user = db.users[0];
    expect(user).toBeDefined();
    expect(user?.pw_hash).not.toBe(GOOD_KEY);
    expect(user?.pw_hash.length).toBeGreaterThan(0);
    expect(user?.server_salt).not.toBe('');
    expect(user?.kdf_version).toBe(AUTH_KDF_VERSION);
  });

  it('gives two accounts with the same authKey different stored hashes', async () => {
    await registerUser('rosalind');
    await registerUser('orlando');
    expect(db.users[0]?.server_salt).not.toBe(db.users[1]?.server_salt);
    expect(db.users[0]?.pw_hash).not.toBe(db.users[1]?.pw_hash);
  });

  it('stores the hash of the session token, never the token', async () => {
    const created = await registerUser('rosalind');
    const token = tokenFrom(created);
    const stored = db.sessions[0];
    expect(stored).toBeDefined();
    expect(stored?.token_hash).not.toBe(token);
    expect(stored?.token_hash).toBe(await hashSessionToken(token));
  });

  it('sets an httpOnly, Secure, SameSite=Lax cookie', async () => {
    const created = await registerUser('rosalind');
    const header = created.headers.get('set-cookie') ?? '';
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
  });
});

describe('login does not reveal whether a username exists', () => {
  it('answers identically for an unknown user and for a wrong password', async () => {
    await registerUser('rosalind');

    const unknownUser = await loginUser('celia', GOOD_KEY);
    const wrongPassword = await loginUser('rosalind', OTHER_KEY);

    expect(unknownUser.status).toBe(wrongPassword.status);
    expect(await body<ApiError>(unknownUser)).toEqual(await body<ApiError>(wrongPassword));
  });

  it('still hashes when the user is missing, so the two paths do the same work', async () => {
    await loginUser('nobody');
    // The only read for an unknown user is the lookup; there is no early return before the
    // KDF, which is what keeps the timing from forking. Asserting the query log is the
    // closest a unit test can honestly get to asserting timing.
    expect(db.log.filter((sql) => sql.includes('FROM users WHERE username'))).toHaveLength(1);
  });

  it('answers a malformed login exactly like a wrong password', async () => {
    await registerUser('rosalind');
    const malformed = await login(ctxFor('login', { username: 'rosalind', authKey: 'junk' }));
    const wrongPassword = await loginUser('rosalind', OTHER_KEY);
    expect(malformed.status).toBe(wrongPassword.status);
    expect(await body<ApiError>(malformed)).toEqual(await body<ApiError>(wrongPassword));
  });
});

describe('rate limiting', () => {
  it('trips after the threshold and returns 429', async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
      expect((await loginUser('rosalind', OTHER_KEY)).status).toBe(401);
    }
    const blocked = await loginUser('rosalind', OTHER_KEY);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('says when to come back without saying whether the account exists', async () => {
    await registerUser('rosalind');
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) await loginUser('rosalind', OTHER_KEY);

    const existing = await loginUser('rosalind', OTHER_KEY);
    const missing = await loginUser('rosalind', OTHER_KEY);
    const message = (await body<ApiError>(existing)).message;
    expect(message).toMatch(/try again in about \d+ minutes?\./);
    expect(message).not.toContain('rosalind');
    expect(await body<ApiError>(missing)).toEqual({
      error: 'rate-limited',
      message,
    });
  });

  it('counts usernames and addresses separately', async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS + 1; i++) {
      await loginUser('rosalind', OTHER_KEY, { ip: '198.51.100.1' });
    }
    // A different username from a different address is untouched by that run: neither a
    // targeted nor a spray attack spends the other's budget.
    await registerUser('celia', GOOD_KEY, { ip: '198.51.100.2' });
    expect((await loginUser('celia', GOOD_KEY, { ip: '198.51.100.2' })).status).toBe(200);
  });

  it('rate limits registration too, so it is not a cheap enumeration oracle', async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
      await registerUser('rosalind', GOOD_KEY);
    }
    const blocked = await registerUser('rosalind', GOOD_KEY);
    expect(blocked.status).toBe(429);
  });

  it('forgets attempts once the window has rolled over', async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS + 1; i++) await loginUser('rosalind', OTHER_KEY);
    for (const row of db.attempts) row.window_start -= RATE_LIMIT_WINDOW_MS + 1;
    expect((await loginUser('rosalind', OTHER_KEY)).status).toBe(401);
  });

  it('clears the username budget after a genuine sign-in, but not the address budget', async () => {
    await registerUser('rosalind');
    for (let i = 0; i < 5; i++) await loginUser('rosalind', OTHER_KEY);
    expect((await loginUser('rosalind')).status).toBe(200);
    expect(db.attempts.find((r) => r.key === 'u:rosalind')).toBeUndefined();
    expect(db.attempts.find((r) => r.key.startsWith('ip:'))?.count).toBeGreaterThan(0);
  });
});

describe('requireUser', () => {
  function requestWith(cookie: string | undefined): Request {
    const headers = new Headers();
    if (cookie !== undefined) headers.set('cookie', cookie);
    return new Request('https://offbook.test/api/sync/pull', { headers });
  }

  it('resolves a live session', async () => {
    const created = await registerUser('rosalind');
    const token = tokenFrom(created);
    const authed = await requireUser(requestWith(`${SESSION_COOKIE}=${token}`), env, Date.now());
    expect(authed?.username).toBe('rosalind');
    expect(authed?.usernameDisplay).toBe('rosalind');
    expect(authed?.rev).toBe(0);
  });

  it('rejects a missing cookie', async () => {
    await registerUser('rosalind');
    expect(await requireUser(requestWith(undefined), env, Date.now())).toBeNull();
  });

  it('rejects an unknown token without touching the users table', async () => {
    await registerUser('rosalind');
    db.log.length = 0;
    expect(await requireUser(requestWith(`${SESSION_COOKIE}=nope`), env, Date.now())).toBeNull();
    expect(db.log.some((sql) => sql.startsWith('UPDATE'))).toBe(false);
  });

  it('rejects an expired session and drops the dead row', async () => {
    const created = await registerUser('rosalind');
    const token = tokenFrom(created);
    const first = db.sessions[0];
    expect(first).toBeDefined();
    if (first) first.expires_at = Date.now() - 1;

    expect(
      await requireUser(requestWith(`${SESSION_COOKIE}=${token}`), env, Date.now()),
    ).toBeNull();
    expect(db.sessions).toHaveLength(0);
  });

  it('ignores a cookie of another name', async () => {
    const created = await registerUser('rosalind');
    const token = tokenFrom(created);
    expect(await requireUser(requestWith(`other=${token}`), env, Date.now())).toBeNull();
  });

  it('refreshes last_seen_at at most once an hour', async () => {
    const created = await registerUser('rosalind');
    const token = tokenFrom(created);
    const request = requestWith(`${SESSION_COOKIE}=${token}`);
    const createdAt = db.sessions[0]?.created_at ?? 0;

    await requireUser(request, env, createdAt + 60_000);
    expect(db.sessions[0]?.last_seen_at).toBe(createdAt);

    await requireUser(request, env, createdAt + 2 * 60 * 60 * 1000);
    expect(db.sessions[0]?.last_seen_at).toBe(createdAt + 2 * 60 * 60 * 1000);
  });

  it('gives a session a thirty day life', async () => {
    await registerUser('rosalind');
    const session = db.sessions[0];
    expect(session?.expires_at).toBe((session?.created_at ?? 0) + SESSION_TTL_MS);
  });
});

describe('me and logout', () => {
  it('returns the account for a signed-in device and 401 otherwise', async () => {
    const created = await registerUser('rosalind');
    const token = tokenFrom(created);

    const mine = await me(ctxFor('me', undefined, { cookie: `${SESSION_COOKIE}=${token}` }));
    expect(mine.status).toBe(200);
    expect((await body<AccountInfo>(mine)).username).toBe('rosalind');

    expect((await me(ctxFor('me', undefined))).status).toBe(401);
  });

  it('deletes the session row and clears the cookie', async () => {
    const created = await registerUser('rosalind');
    const token = tokenFrom(created);

    const out = await logout(ctxFor('logout', {}, { cookie: `${SESSION_COOKIE}=${token}` }));
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(db.sessions).toHaveLength(0);

    expect(
      (await me(ctxFor('me', undefined, { cookie: `${SESSION_COOKIE}=${token}` }))).status,
    ).toBe(401);
  });

  it('succeeds even with no session at all', async () => {
    expect((await logout(ctxFor('logout', {}))).status).toBe(204);
  });

  it('sweeps expired sessions while it is already writing', async () => {
    const created = await registerUser('rosalind');
    const token = tokenFrom(created);
    db.sessions.push({
      token_hash: 'stale',
      user_id: db.users[0]?.id ?? '',
      created_at: 0,
      expires_at: 1,
      last_seen_at: 0,
    });

    await logout(ctxFor('logout', {}, { cookie: `${SESSION_COOKIE}=${token}` }));
    expect(db.sessions).toHaveLength(0);
  });
});

describe('USERNAME_RE', () => {
  it('rejects hostile and malformed usernames', () => {
    for (const bad of [
      '',
      'a',
      'ab',
      '.rosalind',
      'rosalind.',
      '-rosalind',
      'Rosalind',
      'ros alind',
      'ros/alind',
      'ros@alind',
      'ros\nalind',
      'a'.repeat(33),
      '<script>x</script>',
      "rosalind'--",
    ]) {
      expect(USERNAME_RE.test(bad), bad).toBe(false);
    }
  });

  it('accepts ordinary usernames', () => {
    for (const good of ['abc', 'ros.alind', 'ros-alind', 'ros_alind', `a${'b'.repeat(30)}c`]) {
      expect(USERNAME_RE.test(good), good).toBe(true);
    }
  });

  it('is what readCredentials enforces, after normalisation', () => {
    expect(readCredentials({ username: '.rosalind', authKey: GOOD_KEY }).ok).toBe(false);
    expect(readCredentials({ username: 'a'.repeat(200), authKey: GOOD_KEY }).ok).toBe(false);
    expect(readCredentials({ username: 42, authKey: GOOD_KEY }).ok).toBe(false);
    // Uppercase and surrounding whitespace normalise to a legal name rather than failing.
    expect(readCredentials({ username: '  Rosalind ', authKey: GOOD_KEY }).ok).toBe(true);
  });

  it('never echoes the authKey in a rejection message', () => {
    const rejected = readCredentials({ username: '.bad', authKey: GOOD_KEY });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).not.toContain(GOOD_KEY);
  });
});

describe('the session cookie helper', () => {
  it('encodes the token, so a cookie parser round-trips it', () => {
    const header = sessionCookie('a+b/c=', 60);
    expect(header).toContain(`${SESSION_COOKIE}=a%2Bb%2Fc%3D`);
  });
});
