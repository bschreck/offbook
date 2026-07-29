import type { Ctx } from '../../_lib/env';
import { json, unauthorized } from '../../_lib/http';
import { requireUser } from '../../_lib/session';
import { accountInfo, findUserById } from '../../_lib/users';

/**
 * The client calls this on start-up to decide whether it is signed in. It answers 401 rather
 * than an empty body when it is not, so a revoked session is indistinguishable from never
 * having had one — and the app carries on regardless, because the account is optional and
 * IndexedDB is the source of truth (ADR-0008).
 */
export const onRequestGet = async (ctx: Ctx): Promise<Response> => {
  const { request, env } = ctx;
  const authed = await requireUser(request, env, Date.now());
  if (!authed) return unauthorized();

  const user = await findUserById(env, authed.id);
  if (!user) return unauthorized();

  return json(accountInfo(user));
};
