import type {
  AccountInfo,
  ApiError,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
} from '../../shared/sync/protocol';

/**
 * The thin HTTP seam. Same-origin, so the session cookie rides along automatically and the
 * existing `connect-src 'self'` CSP already permits every call — no policy change was needed
 * to add a backend (ADR-0008).
 */

const BASE = `${import.meta.env.BASE_URL}api`.replace(/\/{2,}api$/, '/api');

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    // Offline, or the server is unreachable. Never an error the user must act on: the app
    // works without us. The caller decides whether to say anything.
    throw new ApiFailure(0, 'offline', 'No connection, so nothing was synced just now.');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = parsed as ApiError | null;
    throw new ApiFailure(
      res.status,
      err?.error ?? 'error',
      err?.message ?? 'Something went wrong on the server.',
    );
  }
  return parsed as T;
}

export const api = {
  register: (username: string, authKey: string, kdfVersion: number) =>
    call<AccountInfo>('/auth/register', { username, authKey, kdfVersion }),

  login: (username: string, authKey: string) =>
    call<AccountInfo>('/auth/login', { username, authKey }),

  logout: () => call<void>('/auth/logout', {}),

  me: () => call<AccountInfo>('/auth/me'),

  pull: (req: PullRequest) => call<PullResponse>('/sync/pull', req),

  push: (req: PushRequest) => call<PushResponse>('/sync/push', req),
};
