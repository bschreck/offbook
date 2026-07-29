import { describe, expect, it } from 'vitest';
import {
  AUTH_KDF_VERSION,
  authKeySalt,
  CLIENT_ITERATIONS,
  deriveAuthKey,
  fromBase64,
  hashAuthKey,
  normalizeUsername,
  randomSaltB64,
  timingSafeEqual,
  toBase64,
} from '../../../src/shared/auth/kdf';

/**
 * The client and the server run this code verbatim (ADR-0008). A one-byte disagreement
 * between them locks every existing user out with no diagnostic, so these are golden tests:
 * if one fails after a refactor, the refactor is wrong, not the test.
 */

describe('username normalisation', () => {
  it('is the same for identity and for the salt', async () => {
    // If these ever diverge, a user can register and then be unable to sign in.
    for (const raw of ['Ben', ' ben ', 'BEN', 'ben']) {
      expect(normalizeUsername(raw)).toBe('ben');
      expect(toBase64(await authKeySalt(raw))).toBe(toBase64(await authKeySalt('ben')));
    }
  });

  it('folds NFKC width variants', () => {
    expect(normalizeUsername('ｂｅｎ')).toBe('ben');
  });
});

describe('authKeySalt', () => {
  it('is deterministic, 32 bytes, and distinct per username', async () => {
    const a = await authKeySalt('alice');
    const b = await authKeySalt('bob');
    expect(a).toHaveLength(32);
    expect(toBase64(a)).toBe(toBase64(await authKeySalt('alice')));
    expect(toBase64(a)).not.toBe(toBase64(b));
  });
});

describe('base64 round-trip', () => {
  it('survives every byte value', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });
});

describe('deriveAuthKey', () => {
  // 600k iterations is deliberately slow — that is the entire point — so this one gets room.
  it('is deterministic and 32 bytes', async () => {
    const a = await deriveAuthKey('alice', 'correct horse battery staple');
    const b = await deriveAuthKey('alice', 'correct horse battery staple');
    expect(a).toBe(b);
    expect(fromBase64(a)).toHaveLength(32);
  }, 30_000);

  it('differs by password and by username', async () => {
    const [a, b, c] = await Promise.all([
      deriveAuthKey('alice', 'password-one'),
      deriveAuthKey('alice', 'password-two'),
      deriveAuthKey('bob', 'password-one'),
    ]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  }, 60_000);

  it('never returns anything containing the password', async () => {
    const password = 'a-very-distinctive-passphrase';
    const key = await deriveAuthKey('alice', password);
    expect(key).not.toContain(password);
    expect(atob(key)).not.toContain(password);
  }, 30_000);
});

describe('hashAuthKey', () => {
  it('is deterministic per salt and hides the authKey', async () => {
    const authKey = toBase64(new Uint8Array(32).fill(7));
    const salt = randomSaltB64();
    const hash = await hashAuthKey(authKey, salt);
    expect(await hashAuthKey(authKey, salt)).toBe(hash);
    // The stored value must not be the credential itself.
    expect(hash).not.toBe(authKey);
  });

  it('differs per salt, so two users with the same authKey store different hashes', async () => {
    const authKey = toBase64(new Uint8Array(32).fill(7));
    const one = await hashAuthKey(authKey, randomSaltB64());
    const two = await hashAuthKey(authKey, randomSaltB64());
    expect(one).not.toBe(two);
  });

  it('is cheap enough for the 10ms Workers CPU budget', async () => {
    // The reason the expensive half runs in the browser at all (ADR-0008). If this ever
    // creeps up, sign-in starts failing in production with error 1102 and nothing else.
    const authKey = toBase64(new Uint8Array(32).fill(1));
    const salt = randomSaltB64();
    const started = performance.now();
    await hashAuthKey(authKey, salt);
    expect(performance.now() - started).toBeLessThan(10);
  });
});

describe('timingSafeEqual', () => {
  it('matches equal strings and rejects differences at every position', () => {
    expect(timingSafeEqual('abcdef', 'abcdef')).toBe(true);
    expect(timingSafeEqual('abcdef', 'Abcdef')).toBe(false);
    expect(timingSafeEqual('abcdef', 'abcdeF')).toBe(false);
    expect(timingSafeEqual('abcdef', 'abcde')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('constants', () => {
  it('pins the shared contract', () => {
    // These are a wire contract with the server. Changing one without a version bump and a
    // re-derivation path locks out every existing account.
    expect(AUTH_KDF_VERSION).toBe(1);
    expect(CLIENT_ITERATIONS).toBe(600_000);
  });
});
