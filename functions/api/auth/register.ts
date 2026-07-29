import type { Ctx } from '../../_lib/env';
import { clientIp, fail, json, readJson, sessionCookie } from '../../_lib/http';
import { countAttempt, ipKey, tooManyAttempts, usernameKey } from '../../_lib/ratelimit';
import { createSession, SESSION_TTL_SECONDS } from '../../_lib/session';
import { accountInfo, createUser, readCredentials } from '../../_lib/users';

/**
 * Registration says out loud when a username is taken, because a sign-up form that refuses
 * without saying why is unusable. The counters make that answer expensive enough that it is
 * not a practical enumeration route — the same budget covers sign-in attempts, so a scan and
 * a stuffing run compete for it.
 */
export const onRequestPost = async (ctx: Ctx): Promise<Response> => {
  const { request, env } = ctx;
  const now = Date.now();

  const body = await readJson<unknown>(request, 8 * 1024);
  const check = readCredentials(body);
  if (!check.ok) return fail(400, check.error, check.message);
  const credentials = check.credentials;

  const verdict = await countAttempt(
    env,
    [usernameKey(credentials.username), ipKey(clientIp(request))],
    now,
  );
  if (!verdict.allowed) return tooManyAttempts(verdict.retryAfterSeconds);

  const created = await createUser(env, credentials, now);
  if (!created.ok) {
    return fail(409, 'username-taken', 'That username is already taken. Please pick another.');
  }

  const session = await createSession(env, created.user.id, now);
  return json(accountInfo(created.user), {
    status: 201,
    headers: { 'set-cookie': sessionCookie(session.token, SESSION_TTL_SECONDS) },
  });
};
