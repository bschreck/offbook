import { beforeAll, describe, expect, it } from 'vitest';
import { AUTH_KDF_VERSION, deriveAuthKey } from '../../src/shared/auth/kdf';
import type { PullResponse, PushResponse, SyncRecord } from '../../src/shared/sync/protocol';

/**
 * End-to-end verification against a REAL running server, exercising the real shared KDF —
 * which is the only way to catch a client/server disagreement in it (ADR-0008), because a
 * unit test on either side alone would pass.
 *
 * Skipped by default; CI has no server. To run:
 *
 *   npx wrangler d1 migrations apply offbook --local
 *   npm run build && npx wrangler pages dev dist --port 8788
 *   OFFBOOK_E2E=http://localhost:8788 npx vitest run tests/integration
 *
 * Point OFFBOOK_E2E at the deployed origin to verify a release the same way.
 */

const BASE = process.env.OFFBOOK_E2E;

// A throwaway account created solely to exercise this code path. Never a real credential.
const suffix = Math.random().toString(36).slice(2, 10);
const USERNAME = `e2e-${suffix}`;
const PASSWORD = `e2e-only-${suffix}-not-a-real-secret`;

let cookie = '';

async function call<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0] ?? cookie;
  const text = await res.text();
  if (res.status === 429) {
    throw new Error(
      `Rate limited by ${path}. The limiter is working; the test ran too many attempts. ` +
        "Clear it with: npx wrangler d1 execute offbook --local --command 'DELETE FROM login_attempts'",
    );
  }
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

describe.skipIf(!BASE)('accounts and sync, end to end', () => {
  let authKey = '';

  beforeAll(async () => {
    authKey = await deriveAuthKey(USERNAME, PASSWORD);
  }, 60_000);

  it('refuses an unauthenticated pull', async () => {
    const { status } = await call('/api/sync/pull', { sinceRev: 0 });
    expect(status).toBe(401);
  });

  it('registers a new account', async () => {
    const { status, data } = await call<{ username: string; quotaBytes: number }>(
      '/api/auth/register',
      { username: USERNAME, authKey, kdfVersion: AUTH_KDF_VERSION },
    );
    // 201, because registration creates a resource.
    expect(status).toBe(201);
    expect(data.username).toBe(USERNAME);
    expect(data.quotaBytes).toBeGreaterThan(0);
  });

  it('rejects a duplicate username', async () => {
    const { status } = await call('/api/auth/register', {
      username: USERNAME,
      authKey,
      kdfVersion: AUTH_KDF_VERSION,
    });
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a wrong password, and does not reveal whether a username exists', async () => {
    const wrongKey = await deriveAuthKey(USERNAME, `${PASSWORD}-wrong`);

    const wrongPw = await call<{ message: string }>('/api/auth/login', {
      username: USERNAME,
      authKey: wrongKey,
    });
    const missing = await call<{ message: string }>('/api/auth/login', {
      username: `e2e-nobody-${suffix}`,
      authKey: wrongKey,
    });

    // Asserted explicitly rather than just compared: two 429s are also equal to each other,
    // so an equality-only check would pass while proving nothing at all.
    expect(wrongPw.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(missing.data.message).toBe(wrongPw.data.message);
  }, 120_000);

  it('signs in with the derived key', async () => {
    const ok = await call('/api/auth/login', { username: USERNAME, authKey });
    expect(ok.status).toBe(200);
  }, 60_000);

  it('pushes records and pulls them back', async () => {
    const now = Date.now();
    const records: SyncRecord[] = [
      {
        store: 'documents',
        id: 'doc-e2e-1',
        updatedAt: now,
        payload: { id: 'doc-e2e-1', title: 'A test text', wordCount: 3 },
      },
      {
        store: 'docText',
        id: 'doc-e2e-1',
        updatedAt: now,
        payload: { docId: 'doc-e2e-1', sourceText: 'one two three' },
      },
    ];

    const push = await call<PushResponse>('/api/sync/push', { deviceId: 'e2e-device', records });
    expect(push.status).toBe(200);
    expect(push.data.applied).toBe(2);
    expect(push.data.rejected).toEqual([]);

    const pull = await call<PullResponse>('/api/sync/pull', { sinceRev: 0 });
    expect(pull.status).toBe(200);
    const ids = pull.data.records.map((r) => `${r.store}:${r.id}`).sort();
    expect(ids).toContain('docText:doc-e2e-1');
    expect(ids).toContain('documents:doc-e2e-1');
    // The cursor must never exceed what was actually delivered.
    const maxRev = Math.max(...pull.data.records.map((r) => r.rev ?? 0));
    expect(pull.data.rev).toBe(maxRev);
  });

  it('gives an incremental pull nothing new', async () => {
    const first = await call<PullResponse>('/api/sync/pull', { sinceRev: 0 });
    const again = await call<PullResponse>('/api/sync/pull', { sinceRev: first.data.rev });
    expect(again.data.records).toEqual([]);
    expect(again.data.more).toBe(false);
  });

  it('treats an immutable docText re-push as a no-op rather than an error', async () => {
    const push = await call<PushResponse>('/api/sync/push', {
      deviceId: 'e2e-device',
      records: [
        {
          store: 'docText',
          id: 'doc-e2e-1',
          updatedAt: Date.now(),
          payload: { docId: 'doc-e2e-1', sourceText: 'one two three' },
        },
      ],
    });
    expect(push.status).toBe(200);
    expect(push.data.rejected).toEqual([]);
    expect(push.data.applied).toBe(0);
  });

  it('rejects an oversized record with a readable message', async () => {
    const push = await call<PushResponse>('/api/sync/push', {
      deviceId: 'e2e-device',
      records: [
        {
          store: 'docText',
          id: 'doc-e2e-huge',
          updatedAt: Date.now(),
          payload: { docId: 'doc-e2e-huge', sourceText: 'x'.repeat(1024 * 1024 + 64) },
        },
      ],
    });
    expect(push.data.applied).toBe(0);
    expect(push.data.rejected[0]?.reason).toBe('record-too-large');
    expect(push.data.rejected[0]?.message.length).toBeGreaterThan(10);
  });

  it('signs out, after which sync is refused again', async () => {
    expect((await call('/api/auth/logout', {})).status).toBeLessThan(400);
    const after = await call('/api/sync/pull', { sinceRev: 0 });
    expect(after.status).toBe(401);
  });
});
