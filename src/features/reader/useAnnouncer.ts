import { useCallback, useEffect, useRef } from 'react';

/**
 * ONE polite live region for the whole reader, coalesced and debounced.
 *
 * Never put `aria-live` on the text container: a stage change rewrites a hundred tokens and
 * would fire a hundred announcements (§9.8 rule 3).
 */
export function useAnnouncer(elementId = 'announcer') {
  const pending = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(
    (message: string) => {
      pending.current.push(message);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const el = document.getElementById(elementId);
        if (el) el.textContent = pending.current.join('. ');
        pending.current = [];
        timer.current = null;
      }, 120);
    },
    [elementId],
  );
}
