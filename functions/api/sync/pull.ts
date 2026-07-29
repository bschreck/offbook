import type { PullRequest } from '../../../src/shared/sync/protocol';
import type { Ctx } from '../../_lib/env';
import { fail, json, readJson, unauthorized } from '../../_lib/http';
import { requireUser } from '../../_lib/session';
import { executePull } from '../../_lib/sync';

/**
 * `POST /api/sync/pull` — every record above the client's cursor, in revision order. ADR-0008.
 *
 * An HTTP shell on purpose: authenticate, parse, delegate. The cursor arithmetic lives in
 * `_lib/sync.ts`, where it can be tested without a database, because getting it wrong is how a
 * client silently skips records it never received.
 */
export const onRequestPost = async (ctx: Ctx): Promise<Response> => {
  const user = await requireUser(ctx.request, ctx.env, Date.now());
  if (user === null) return unauthorized();

  const body = await readJson<PullRequest>(ctx.request);
  if (body === null || typeof body !== 'object') {
    return fail(400, 'malformed', 'That sync request could not be read, so nothing was fetched.');
  }

  const { sinceRev } = body;
  if (typeof sinceRev !== 'number' || !Number.isFinite(sinceRev) || sinceRev < 0) {
    // Refused rather than defaulted to 0: a broken cursor should be a visible bug in the
    // client, not a silent full resync on every call.
    return fail(400, 'malformed', 'That sync request had no valid position to resume from.');
  }

  try {
    return json(await executePull(ctx.env.DB, user, body));
  } catch {
    // The client shows `message` verbatim, so an unhandled throw must still arrive as JSON —
    // an HTML error page would break parsing on the other end.
    return fail(
      500,
      'sync-failed',
      'The server could not read your library just now. Everything on this device is unaffected.',
    );
  }
};
