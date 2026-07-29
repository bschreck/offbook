import type { PushRequest } from '../../../src/shared/sync/protocol';
import { MAX_PUSH_RECORDS } from '../../../src/shared/sync/protocol';
import type { Ctx } from '../../_lib/env';
import { fail, json, readJson, unauthorized } from '../../_lib/http';
import { requireUser } from '../../_lib/session';
import { executePush } from '../../_lib/sync';

/**
 * `POST /api/sync/push` — the device offers records, the server assigns revisions and reports
 * what it refused. ADR-0008.
 *
 * An HTTP shell on purpose: the merge policy, revision allocation and byte accounting are in
 * `_lib/sync.ts`.
 */

/** Generous for a device id; small enough that it cannot smuggle a payload. */
const MAX_DEVICE_ID_LENGTH = 64;

export const onRequestPost = async (ctx: Ctx): Promise<Response> => {
  const user = await requireUser(ctx.request, ctx.env, Date.now());
  if (user === null) return unauthorized();

  const body = await readJson<PushRequest>(ctx.request);
  if (body === null || typeof body !== 'object' || !Array.isArray(body.records)) {
    return fail(400, 'malformed', 'That sync request could not be read, so nothing was saved.');
  }

  const { deviceId } = body;
  if (
    typeof deviceId !== 'string' ||
    deviceId.length === 0 ||
    deviceId.length > MAX_DEVICE_ID_LENGTH
  ) {
    // The device id is the deterministic tie-breaker for last-write-wins, so a push without a
    // usable one has no defined merge behaviour and must not be guessed at.
    return fail(400, 'malformed', 'That sync request did not say which device it came from.');
  }

  if (body.records.length > MAX_PUSH_RECORDS) {
    return fail(
      413,
      'too-many-records',
      `Offbook tried to send ${body.records.length} items at once, and the server takes ${MAX_PUSH_RECORDS} at a time. It will send them in smaller batches instead.`,
    );
  }

  try {
    return json(await executePush(ctx.env.DB, user, body));
  } catch {
    // Nothing is lost by a failure here: IndexedDB is the source of truth and the client will
    // offer these records again (ADR-0008, "the server is a replica, not the origin").
    return fail(
      500,
      'sync-failed',
      'The server could not save those changes just now. They are still safe on this device, and Offbook will try again.',
    );
  }
};
