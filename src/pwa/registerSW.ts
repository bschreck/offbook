import { registerSW } from 'virtual:pwa-register';

/**
 * `registerType: 'prompt'` with `skipWaiting: false` — we must never swap the JS bundle
 * under an actor mid-scene. The user is asked, and the swap happens on their say-so.
 */
export function setupServiceWorker(onUpdateReady: () => void, onOfflineReady: () => void) {
  const update = registerSW({
    immediate: true,
    onNeedRefresh: onUpdateReady,
    onOfflineReady,
  });
  return update;
}
