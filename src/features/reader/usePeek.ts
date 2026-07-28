import { useEffect, useRef } from 'react';
import { haptic, INPUT } from './input';

export interface PeekHandlers {
  /** A word was peeked. Fired once per distinct peek, and it is the measurement (§8.4). */
  onPeek: (tokenIndex: number) => void;
  /** Peek ended; the word goes back under its blank. */
  onPeekEnd: (tokenIndex: number) => void;
  /** A sticky reveal was toggled (peekBehaviour: 'tap'). */
  onToggleReveal: (tokenIndex: number) => void;
  /** A tap that hit the canvas rather than a blank. */
  onCanvasTap: () => void;
}

export interface PeekOptions {
  behaviour: 'hold' | 'tap';
  haptics: boolean;
  /** How long a quick tap keeps the word visible before it fades back. */
  tapPeekMs?: number;
}

/**
 * All reader pointer handling, by event delegation on the canvas.
 *
 * Delegation rather than per-token handlers is not a micro-optimisation: a 10,000-word text
 * would otherwise attach 10,000 listener pairs.
 *
 * The load-bearing rule is that **scroll always wins**. The reveal is scheduled, not
 * immediate, and any movement past the tolerance before it fires cancels it — so dragging
 * the text to look back never leaves a trail of revealed words.
 */
export function usePeek(canvas: HTMLElement | null, handlers: PeekHandlers, opts: PeekOptions) {
  const h = useRef(handlers);
  h.current = handlers;
  const o = useRef(opts);
  o.current = opts;

  useEffect(() => {
    if (!canvas) return;

    let startX = 0;
    let startY = 0;
    let tokenIndex: number | null = null;
    let revealTimer: ReturnType<typeof setTimeout> | null = null;
    let fadeTimer: ReturnType<typeof setTimeout> | null = null;
    let revealed = false;
    let movedOff = false;

    const clearTimers = () => {
      if (revealTimer) clearTimeout(revealTimer);
      revealTimer = null;
    };

    const findBlank = (target: EventTarget | null): number | null => {
      if (!(target instanceof Element)) return null;
      const tok = target.closest('.tok[data-mask]');
      if (!tok) return null;
      const mask = tok.getAttribute('data-mask');
      if (!mask || mask === 'none' || mask === 'dim') return null;
      const i = Number(tok.getAttribute('data-i'));
      return Number.isFinite(i) ? i : null;
    };

    const onPointerDown = (e: PointerEvent) => {
      // Let the browser own secondary buttons; right-click is not ours in v1.
      if (e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      movedOff = false;
      revealed = false;
      tokenIndex = findBlank(e.target);
      if (tokenIndex === null) return;

      if (o.current.behaviour === 'tap') return; // handled on pointerup

      const idx = tokenIndex;
      revealTimer = setTimeout(() => {
        revealed = true;
        revealTimer = null;
        h.current.onPeek(idx);
      }, INPUT.peekRevealMs);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (tokenIndex === null || movedOff) return;
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (dx > INPUT.moveTolerancePx || dy > INPUT.moveTolerancePx) {
        movedOff = true;
        clearTimers();
        if (revealed && tokenIndex !== null) {
          h.current.onPeekEnd(tokenIndex);
          revealed = false;
        }
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      clearTimers();
      const idx = tokenIndex;
      tokenIndex = null;

      if (movedOff) return; // it was a scroll

      if (idx === null) {
        // A tap on the canvas itself, not on a blank.
        if (findBlank(e.target) === null) h.current.onCanvasTap();
        return;
      }

      if (o.current.behaviour === 'tap') {
        h.current.onToggleReveal(idx);
        haptic(10, o.current.haptics);
        return;
      }

      if (revealed) {
        revealed = false;
        h.current.onPeekEnd(idx);
        return;
      }

      // Released before the hold threshold: treat it as a tap and show the word briefly,
      // otherwise a quick tap on a blank would appear to do nothing at all.
      h.current.onPeek(idx);
      if (fadeTimer) clearTimeout(fadeTimer);
      fadeTimer = setTimeout(() => h.current.onPeekEnd(idx), o.current.tapPeekMs ?? 1200);
    };

    const onPointerCancel = () => {
      clearTimers();
      if (revealed && tokenIndex !== null) h.current.onPeekEnd(tokenIndex);
      tokenIndex = null;
      revealed = false;
    };

    // Long-press otherwise summons the iOS magnifier and the Android context menu.
    const onContextMenu = (e: Event) => e.preventDefault();

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove, { passive: true });
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('contextmenu', onContextMenu);

    return () => {
      clearTimers();
      if (fadeTimer) clearTimeout(fadeTimer);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    };
  }, [canvas]);
}

/**
 * Hold-to-act, for the Stage chip (reveal everything while held — the documented panic
 * gesture) and for the 600 ms hard reset.
 */
export function useHoldAction(
  el: HTMLElement | null,
  holdMs: number,
  onHoldStart: () => void,
  onHoldEnd: () => void,
  onTap?: () => void,
  haptics = true,
) {
  const cbs = useRef({ onHoldStart, onHoldEnd, onTap });
  cbs.current = { onHoldStart, onHoldEnd, onTap };

  useEffect(() => {
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let held = false;

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      held = false;
      timer = setTimeout(() => {
        held = true;
        haptic(10, haptics);
        cbs.current.onHoldStart();
      }, holdMs);
    };
    const up = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (held) cbs.current.onHoldEnd();
      else cbs.current.onTap?.();
      held = false;
    };
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (held) cbs.current.onHoldEnd();
      held = false;
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
    return () => {
      if (timer) clearTimeout(timer);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointerleave', cancel);
      el.removeEventListener('pointercancel', cancel);
    };
  }, [el, holdMs, haptics]);
}
