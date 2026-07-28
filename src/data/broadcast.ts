import { DB_NAME } from '../brand';

/**
 * Cross-tab invalidation. PLAN.md §6.1 rule 6.
 *
 * Without this, two tabs open on one document both write from stale in-memory state and the
 * library list silently disagrees with the database.
 */

export interface WriteEvent {
  store: string;
  key: string;
  updatedAt: number;
}

type Listener = (e: WriteEvent) => void;

const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(DB_NAME);
  channel.onmessage = (ev: MessageEvent<WriteEvent>) => {
    for (const l of listeners) l(ev.data);
  };
  return channel;
}

export function publishWrite(store: string, key: string): void {
  ensureChannel()?.postMessage({ store, key, updatedAt: Date.now() } satisfies WriteEvent);
}

export function onRemoteWrite(fn: Listener): () => void {
  ensureChannel();
  listeners.add(fn);
  return () => listeners.delete(fn);
}
