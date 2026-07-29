import { create } from 'zustand';
import { ApiFailure, api } from '../data/sync/api';
import {
  resetSyncCursor,
  syncNow as runSync,
  type SyncOutcome,
  startAutoSync,
} from '../data/sync/engine';
import { AUTH_KDF_VERSION, deriveAuthKey } from '../shared/auth/kdf';
import type { AccountInfo } from '../shared/sync/protocol';
import { useLibrary } from './libraryStore';
import { useSettings } from './settingsStore';

export type AccountStatus = 'unknown' | 'signedOut' | 'signedIn';

/** Actions that can fail with something the user has to read return this, not a throw. */
export type AuthResult = { ok: true } | { ok: false; message: string };

export interface SyncSummary {
  ok: boolean;
  /** A sentence, already written for a human. Goes straight into the panel. */
  message: string;
}

interface AccountState {
  account: AccountInfo | null;
  status: AccountStatus;
  /** An auth call is in flight — including the ~half-second KDF, which is most of it. */
  busy: boolean;
  syncing: boolean;
  lastSyncAt: number | null;
  lastSyncError: string | null;

  refresh: () => Promise<void>;
  signUp: (username: string, password: string) => Promise<AuthResult>;
  signIn: (username: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<AuthResult>;
  syncNow: () => Promise<SyncSummary>;
}

/**
 * Auto-sync is a page-lifetime background loop, so it must be armed once and not once per
 * `refresh()` — every route mount calls refresh.
 */
let autoSyncArmed = false;
function armAutoSync(): void {
  if (autoSyncArmed) return;
  autoSyncArmed = true;
  // The engine asks this predicate every time, so signing out stops sync without tearing the
  // listeners down — which is why arming once is enough.
  startAutoSync(() => useAccount.getState().status === 'signedIn');
}

/**
 * Derivation is 300–800 ms on a phone (ADR-0008). WebCrypto does the work off the main
 * thread, but the busy flag still has to reach the screen before it starts, or the button
 * looks inert for a second and the user presses it again.
 */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function failureMessage(err: unknown, fallback: string): string {
  return err instanceof ApiFailure ? err.message : fallback;
}

/**
 * Which account this device last had in hand, so switching users drops the sync cursor: a rev
 * from one account means nothing in another (see resetSyncCursor in data/sync/engine.ts). This
 * is in memory only, which covers the case the UI can produce — a session expiring and somebody
 * else signing in — without persisting an identity we have no business keeping.
 */
let lastKnownUsername: string | null = null;

async function adoptAccount(account: AccountInfo): Promise<void> {
  if (lastKnownUsername !== null && lastKnownUsername !== account.username) {
    await resetSyncCursor();
  }
  lastKnownUsername = account.username;
}

/**
 * Accounts are optional and the server is a replica, never the origin (ADR-0008). Nothing in
 * this store may gate the reader: every failure path ends in a message, not a blocked app.
 */
export const useAccount = create<AccountState>((set, get) => ({
  account: null,
  status: 'unknown',
  busy: false,
  syncing: false,
  lastSyncAt: null,
  lastSyncError: null,

  refresh: async () => {
    try {
      const account = await api.me();
      await adoptAccount(account);
      set({ account, status: 'signedIn' });
      armAutoSync();
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) {
        set({ account: null, status: 'signedOut' });
        return;
      }
      // Offline, or the server is unhappy. We genuinely do not know whether there is an
      // account, and claiming "signed out" would invite a pointless second sign-in.
      set({ status: 'unknown' });
    }
  },

  signUp: async (username, password) => {
    if (get().busy) return { ok: false, message: 'One moment — that is still going.' };
    set({ busy: true });
    try {
      await yieldToPaint();
      // The password stops here. Only the derived key crosses the network, and neither value
      // is ever written to state or to a log.
      const authKey = await deriveAuthKey(username, password);
      const account = await api.register(username, authKey, AUTH_KDF_VERSION);
      await adoptAccount(account);
      set({ account, status: 'signedIn' });
      armAutoSync();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: failureMessage(err, 'Could not create that account.') };
    } finally {
      set({ busy: false });
    }
  },

  signIn: async (username, password) => {
    if (get().busy) return { ok: false, message: 'One moment — that is still going.' };
    set({ busy: true });
    try {
      await yieldToPaint();
      const authKey = await deriveAuthKey(username, password);
      const account = await api.login(username, authKey);
      await adoptAccount(account);
      set({ account, status: 'signedIn' });
      armAutoSync();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: failureMessage(err, 'Could not sign in.') };
    } finally {
      set({ busy: false });
    }
  },

  signOut: async () => {
    if (get().busy) return { ok: false, message: 'One moment — that is still going.' };
    set({ busy: true });
    try {
      await api.logout();
    } catch (err) {
      // 401 means the session was already gone, which is the state we were asking for.
      if (!(err instanceof ApiFailure) || err.status !== 401) {
        set({ busy: false });
        return {
          ok: false,
          message:
            err instanceof ApiFailure && err.status === 0
              ? 'No connection, so signing out could not be confirmed. Try again once you are online.'
              : failureMessage(err, 'Could not sign out.'),
        };
      }
    }
    // The local library is deliberately untouched: IndexedDB is the source of truth, and
    // signing out is not a delete (ADR-0008). The sync cursor, on the other hand, must go —
    // a rev from one account means nothing in another, and the next person to sign in on this
    // device would silently skip their whole library.
    await resetSyncCursor();
    lastKnownUsername = null;
    set({
      account: null,
      status: 'signedOut',
      busy: false,
      lastSyncError: null,
    });
    return { ok: true };
  },

  syncNow: async () => {
    if (get().syncing) return { ok: false, message: 'A sync is already running.' };
    set({ syncing: true });
    try {
      const outcome = await runSync('manual');
      const summary = describeOutcome(outcome);

      // A round that came back 'signed-out' has told us something refresh() would otherwise
      // have to ask for: the session is gone. Believe it.
      if (outcome.status === 'signed-out') {
        set({ account: null, status: 'signedOut', lastSyncError: null, syncing: false });
        return summary;
      }

      set({
        lastSyncAt: Date.now(),
        lastSyncError: summary.ok ? null : summary.message,
      });

      // The push response already carries the usage figures, so the quota bar is exact without
      // a second request. A pull-only round carries none, and then it is worth one GET.
      const account = get().account;
      if (account && outcome.usageBytes !== undefined && outcome.quotaBytes !== undefined) {
        set({
          account: {
            ...account,
            usageBytes: outcome.usageBytes,
            quotaBytes: outcome.quotaBytes,
          },
        });
      } else if (outcome.ok) {
        try {
          set({ account: await api.me() });
        } catch {
          /* Leave the previous figures on screen: this is decoration, not the sync result. */
        }
      }

      // Records landed in IndexedDB behind the open views' backs, so they have to re-read.
      if (outcome.changedLocally) {
        await Promise.all([useLibrary.getState().load(), useSettings.getState().load()]);
      }
      return summary;
    } catch (err) {
      // The engine reports failure in the outcome rather than throwing, so this is a genuine
      // surprise — still not something that may break the reader.
      const message = failureMessage(err, 'Sync did not finish.');
      set({ lastSyncError: message });
      return { ok: false, message };
    } finally {
      set({ syncing: false });
    }
  },
}));

/**
 * `quiet` failures are expected — offline, or a session that has expired — and the app works
 * without us, so they are stated calmly and never as something to act on (ADR-0008).
 */
function describeOutcome(outcome: SyncOutcome): SyncSummary {
  if (!outcome.ok) {
    if (outcome.status === 'offline') {
      return { ok: false, message: 'No connection, so nothing synced just now. It will catch up.' };
    }
    if (outcome.status === 'signed-out') {
      return { ok: false, message: 'Your session has expired. Sign in again to keep syncing.' };
    }
    return { ok: false, message: outcome.message ?? 'Sync did not finish. It will try again.' };
  }

  // A 'stale' rejection is ordinary last-write-wins: another device had something newer. Only
  // the rest — quota, size, malformed — are worth a word, and their messages are already
  // written for the user (protocol.ts).
  const loud = outcome.rejected.filter((r) => r.reason !== 'stale');
  const first = loud[0];
  if (first) {
    const more = loud.length > 1 ? ` And ${loud.length - 1} more like it.` : '';
    return { ok: false, message: `${first.message}${more}` };
  }

  const moved: string[] = [];
  if (outcome.pushed > 0) {
    moved.push(`sent ${outcome.pushed} change${outcome.pushed === 1 ? '' : 's'}`);
  }
  if (outcome.pulled > 0) moved.push(`received ${outcome.pulled}`);
  return {
    ok: true,
    message: moved.length > 0 ? `Synced — ${moved.join(', ')}.` : 'Synced. Already up to date.',
  };
}
