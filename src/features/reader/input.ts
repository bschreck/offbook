/**
 * One constants object, one value each. PLAN.md §9.3.
 *
 * Every timing in the reader comes from here. The competing values scattered across the
 * design docs (a 250 ms long-press, a 38% reading zone, a 130 wpm default) are deleted —
 * if a number is tuned, it is tuned here.
 */
export const INPUT = {
  /** Visible reveal starts here, so holding feels instant. */
  peekRevealMs: 140,
  /** Gates OTHER long-press actions; 600 with "reduce accidental taps". */
  longPressMs: 450,
  /** Beyond this the press is a scroll, and scroll must always win. */
  moveTolerancePx: 10,
  /** The current line sits here, not centred: more text below than above keeps the eyeline up. */
  readingZonePct: 40,
  readingZonePctLandscape: 45,
  autoScrollWpmDefault: 120,
  autoScrollWpmMin: 60,
  autoScrollWpmMax: 260,
  autoScrollWpmStep: 5,
  /** Only after an incidental pause (a scroll or a peek), never after an explicit one. */
  autoScrollResumeMs: 2500,
  resetHoldMs: 600,
  peekReleaseFadeMs: 180,
  /** Inside this, swipes belong to the browser's back gesture. */
  edgeDeadZonePx: 32,
} as const;

export const READER_FONT_MIN = 18;
export const READER_FONT_MAX_MOBILE = 44;
export const READER_FONT_MAX_DESKTOP = 72;
export const READER_FONT_STEP = 2;

export const MEASURE_MIN_CH = 24;
export const MEASURE_MAX_CH = 60;

/** iOS Safari has no Vibration API, so haptics are a bonus and never load-bearing. */
export function haptic(ms: number, enabled: boolean): void {
  if (!enabled) return;
  navigator.vibrate?.(ms);
}
