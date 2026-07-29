import type { Ctx } from '../../_lib/env';
import { clientIp, fail, json, readJson, sessionCookie } from '../../_lib/http';
import {
  clearAttempts,
  countAttempt,
  ipKey,
  tooManyAttempts,
  usernameKey,
} from '../../_lib/ratelimit';
import { createSession, SESSION_TTL_SECONDS } from '../../_lib/session';
import { accountInfo, findUser, readCredentials, verifyAuthKey } from '../../_lib/users';

/**
 * One failure response for every reason: unknown username, wrong password, malformed hash.
 * Same status, same words, and the same amount of PBKDF2 work — `verifyAuthKey` hashes
 * against a dummy salt when the row is missing, so the response time does not fork and
 * cannot be used to enumerate accounts (ADR-0008).
 */
const invalidCredentials = () =>
  fail(401, 'invalid-credentials', 'That username and password do not match.');

export const onRequestPost = async (ctx: Ctx): Promise<Response> => {
  const { request, env } = ctx;
  const now = Date.now();

  const body = await readJson<unknown>(request, 8 * 1024);
  const check = readCredentials(body);
  // A malformed body is answered like a wrong password: telling a caller that its username
  // passed validation but its hash did not is a distinction worth nothing to an honest
  // client, which never sends either.
  if (!check.ok) return invalidCredentials();
  const credentials = check.credentials;

  const attemptKeys = [usernameKey(credentials.username), ipKey(clientIp(request))];
  const verdict = await countAttempt(env, attemptKeys, now);
  if (!verdict.allowed) return tooManyAttempts(verdict.retryAfterSeconds);

  const user = await findUser(env, credentials.username);
  const valid = await verifyAuthKey(user, credentials.authKey);
  if (!user || !valid) return invalidCredentials();

  // Only the username key is cleared. Clearing the address key too would let an attacker who
  // holds one valid account reset the spray budget between guesses.
  await clearAttempts(env, [usernameKey(credentials.username)]);

  const session = await createSession(env, user.id, now);
  return json(accountInfo(user), {
    headers: { 'set-cookie': sessionCookie(session.token, SESSION_TTL_SECONDS) },
  });
};
