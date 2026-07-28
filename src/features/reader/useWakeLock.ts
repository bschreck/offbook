import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Screen Wake Lock. Chrome/Edge 84+, Firefox 126+, Safari 16.4+ on macOS AND iOS.
 *
 * The known caveat (PLAN.md §9.6, UNVERIFIED-1): the API was broken specifically in
 * INSTALLED home-screen apps by a WebKit bug until iOS 18.4, so on iOS 16.4–18.3 an
 * installed PWA resolves the request and lets the screen sleep anyway. We cannot detect
 * that, so `supported` means "the API exists", not "the screen will stay on".
 */
export function useWakeLock(active: boolean) {
  const sentinel = useRef<WakeLockSentinel | null>(null);
  const [held, setHeld] = useState(false);
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  const acquire = useCallback(async () => {
    if (!supported || sentinel.current) return;
    try {
      const s = await navigator.wakeLock.request('screen');
      sentinel.current = s;
      setHeld(true);
      s.addEventListener('release', () => {
        sentinel.current = null;
        setHeld(false);
      });
    } catch {
      // Denied, or the document was not visible. Not worth interrupting the user over.
      setHeld(false);
    }
  }, [supported]);

  const release = useCallback(async () => {
    const s = sentinel.current;
    sentinel.current = null;
    setHeld(false);
    if (s) await s.release().catch(() => {});
  }, []);

  useEffect(() => {
    if (active) void acquire();
    else void release();
    return () => {
      void release();
    };
  }, [active, acquire, release]);

  // The lock is dropped whenever the tab is hidden, and is NOT restored automatically.
  useEffect(() => {
    if (!active) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [active, acquire]);

  return { supported, held };
}
