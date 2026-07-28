import { useCallback, useEffect, useRef, useState } from 'react';
import { INPUT } from './input';

export type PauseCause = 'user' | 'scroll' | 'peek' | null;

/**
 * Auto-scroll at a speaking pace. PLAN.md §9.5.
 *
 * Speed is in WPM because that is a number performers already understand — conversational
 * is about 130, stage delivery 100–140.
 *
 * Velocity is measured from the block currently in view, never from `scrollHeight`: under
 * `content-visibility: auto`, unrendered blocks contribute size *estimates* that are
 * replaced by real measurements as you scroll into them, so `scrollHeight` moves
 * continuously on a first pass through a long text and the pace drifts — which is exactly
 * the failure that makes autoscroll useless to someone trying to hold a tempo.
 */
export function useAutoScroll(
  scroller: HTMLElement | null,
  wpm: number,
  mode: 'smooth' | 'stepped',
) {
  const [running, setRunning] = useState(false);
  const pauseCause = useRef<PauseCause>(null);
  const raf = useRef<number | null>(null);
  const carry = useRef(0);
  const lastTs = useRef(0);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const effectiveMode: 'smooth' | 'stepped' = reducedMotion ? 'stepped' : mode;

  /** px/second, from the block under the reading zone. Recomputed as blocks change. */
  const measureVelocity = useCallback((): number => {
    if (!scroller) return 0;
    const zoneY =
      scroller.getBoundingClientRect().top + scroller.clientHeight * (INPUT.readingZonePct / 100);
    const blocks = scroller.querySelectorAll<HTMLElement>('.blk');
    let target: HTMLElement | null = null;
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (r.bottom >= zoneY) {
        target = b;
        break;
      }
    }
    if (!target) return 0;
    const words = Number(target.dataset.words ?? '0');
    if (!words || !target.offsetHeight) return 0;
    const pxPerWord = target.offsetHeight / words;
    return pxPerWord * (wpm / 60);
  }, [scroller, wpm]);

  const stop = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    carry.current = 0;
    setRunning(false);
  }, []);

  const tick = useCallback(
    (ts: number) => {
      if (!scroller) return;
      const dt = lastTs.current ? (ts - lastTs.current) / 1000 : 0;
      lastTs.current = ts;

      const pxPerSec = measureVelocity();
      // Accumulate fractional pixels: below ~0.4px/frame, moving by rounded amounts each
      // frame judders visibly at 60Hz.
      carry.current += pxPerSec * dt;
      const whole = Math.floor(carry.current);
      if (whole > 0) {
        carry.current -= whole;
        scroller.scrollTop += whole;
      }

      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        stop();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    },
    [scroller, measureVelocity, stop],
  );

  const start = useCallback(() => {
    if (running) return;
    pauseCause.current = null;
    lastTs.current = 0;
    carry.current = 0;
    setRunning(true);
    if (effectiveMode === 'smooth') raf.current = requestAnimationFrame(tick);
  }, [running, effectiveMode, tick]);

  /**
   * Pausing remembers WHY. Distinguishing "I grabbed the text to look back" from "stop"
   * is what makes autoscroll feel obedient rather than pushy.
   */
  const pause = useCallback(
    (cause: Exclude<PauseCause, null>) => {
      if (!running) return;
      pauseCause.current = cause;
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
      setRunning(false);

      if (cause !== 'user') {
        if (resumeTimer.current) clearTimeout(resumeTimer.current);
        resumeTimer.current = setTimeout(() => {
          if (pauseCause.current && pauseCause.current !== 'user') start();
        }, INPUT.autoScrollResumeMs);
      }
    },
    [running, start],
  );

  const toggle = useCallback(() => {
    if (running) pause('user');
    else start();
  }, [running, pause, start]);

  /** Advance exactly one line box to the reading zone. The stepped primitive. */
  const stepLine = useCallback(
    (direction: 1 | -1 = 1) => {
      if (!scroller) return;
      const zoneY =
        scroller.getBoundingClientRect().top + scroller.clientHeight * (INPUT.readingZonePct / 100);
      const lines = [...scroller.querySelectorAll<HTMLElement>('.ln')];
      const idx = lines.findIndex((l) => l.getBoundingClientRect().bottom >= zoneY);
      const next = lines[Math.max(0, Math.min(lines.length - 1, idx + direction))];
      if (!next) return;
      const delta = next.getBoundingClientRect().top - zoneY;
      scroller.scrollTo({
        top: scroller.scrollTop + delta,
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    },
    [scroller, reducedMotion],
  );

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
    },
    [],
  );

  return { running, mode: effectiveMode, start, stop, pause, toggle, stepLine };
}
