import type { Ctx } from '../../_lib/env';
import { clearedSessionCookie, readCookie, SESSION_COOKIE } from '../../_lib/http';
import { destroySession, purgeExpiredSessions } from '../../_lib/session';

/**
 * Always succeeds. Logging out is the one action that must never fail — a user who cannot
 * clear a session on a shared device has a security problem, not a usability one — so an
 * unknown or already-dead token still clears the cookie and returns 204.
 */
export const onRequestPost = async (ctx: Ctx): Promise<Response> => {
  const { request, env } = ctx;
  const token = readCookie(request, SESSION_COOKIE);

  if (token) {
    await destroySession(env, token);
    // Opportunistic sweep: we are already writing, so dead rows cost nothing to remove here.
    await purgeExpiredSessions(env, Date.now());
  }

  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': clearedSessionCookie(), 'cache-control': 'no-store' },
  });
};
