import { useEffect, useState } from 'react';
import { INPUT } from './input';

/**
 * The current line is the one overlapping the reading zone at 40% of viewport height —
 * not the centre. Reading forward you want more text below than above, and it keeps the
 * eyeline up, which matters for actors who should not be looking at their chin (§9.1).
 *
 * One IntersectionObserver with a rootMargin that collapses the root to a thin band at
 * that height: cheap, and no scroll-event thrash.
 */
export function useCurrentLine(root: HTMLElement | null, lineCount: number): number {
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    if (!root || lineCount === 0) return;

    const landscape = window.matchMedia('(orientation: landscape)').matches;
    const zone = landscape ? INPUT.readingZonePctLandscape : INPUT.readingZonePct;
    const observer = new IntersectionObserver(
      (entries) => {
        let best: { idx: number; top: number } | null = null;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = Number((entry.target as HTMLElement).dataset.line);
          if (!Number.isFinite(idx)) continue;
          const top = entry.boundingClientRect.top;
          if (!best || top < best.top) best = { idx, top };
        }
        if (best) setCurrent(best.idx);
      },
      { root, rootMargin: `-${zone}% 0px -${98 - zone}% 0px`, threshold: 0 },
    );

    const lines = root.querySelectorAll('.ln');
    for (const l of lines) observer.observe(l);
    return () => observer.disconnect();
  }, [root, lineCount]);

  return current;
}
