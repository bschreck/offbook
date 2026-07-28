import { memo } from 'react';
import { MaskStyle, type MaskStyleCode } from '../../core/mask/types';
import type { Token } from '../../core/text/types';

const STYLE_NAME: Record<MaskStyleCode, string> = {
  [MaskStyle.none]: 'none',
  [MaskStyle.rule]: 'rule',
  [MaskStyle.dots]: 'dots',
  [MaskStyle.initial]: 'initial',
  [MaskStyle.dim]: 'dim',
  [MaskStyle.blank]: 'blank',
};

export interface MaskedTokenProps {
  token: Token;
  style: MaskStyleCode;
  peeked: boolean;
  revealed: boolean;
  /** 1-based position among the masked tokens of this line, for the accessible name. */
  hiddenOrdinal: number;
  hiddenTotal: number;
  verbose: boolean;
}

/**
 * ADR-0005. The real text lives in the inner `.txt` span and masking is
 * `visibility: hidden` on that span — which keeps the exact advance width (so nothing
 * moves on reveal) and removes the glyphs from the a11y tree, from selection and from
 * find-in-page, all in one decision.
 *
 * `ws` is rendered by the parent, OUTSIDE this element: whitespace inside the inline-block
 * would widen the box and the blank's rule would run past the end of the word.
 */
export const MaskedToken = memo(function MaskedToken({
  token,
  style,
  peeked,
  revealed,
  hiddenOrdinal,
  hiddenTotal,
  verbose,
}: MaskedTokenProps) {
  const masked = style !== MaskStyle.none && style !== MaskStyle.dim;
  const cls = `tok${peeked ? ' peek' : ''}${revealed ? ' revealed' : ''}`;

  /**
   * A token that is currently peeked or revealed has had its style zeroed by the reveals
   * lens, but it must STILL render as the same `<button>` element. If the element type
   * flips mid-gesture React unmounts the node the pointer is on, the `pointerup` never
   * reaches the delegated listener on the canvas, and the peek sticks forever.
   */
  const interactive = masked || peeked || revealed;
  const inner = (
    <>
      {token.lead}
      <span className="txt">{token.text}</span>
      {token.trail}
    </>
  );

  // `dim` is a soft style for lookback context and cue tails, never for words under test,
  // so it stays plain text and deliberately exposes the real word (§9.8 matrix).
  //
  // A peeked or revealed word also arrives here, because the reveals lens has already set
  // its style to `none` — it still gets the amber treatment, which is the point: it is the
  // only coloured word on screen and it marks what the run cost you.
  if (!interactive) {
    return (
      <span className={cls} data-i={token.i} data-mask={STYLE_NAME[style]}>
        {inner}
      </span>
    );
  }

  const label =
    style === MaskStyle.initial
      ? `Hidden word ${hiddenOrdinal} of ${hiddenTotal}, starts with ${token.firstLetter}.`
      : verbose
        ? `Hidden word ${hiddenOrdinal} of ${hiddenTotal}. Activate to reveal.`
        : 'Blank. Activate to reveal.';

  return (
    <button
      type="button"
      className={cls}
      data-i={token.i}
      data-mask={STYLE_NAME[style]}
      aria-label={revealed || peeked ? token.text : label}
    >
      {token.lead}
      <span className="txt">{token.text}</span>
      {token.trail}
      {style === MaskStyle.initial && !peeked && !revealed && (
        <span className="ovl" aria-hidden="true">
          {token.firstLetter}
        </span>
      )}
    </button>
  );
});

/**
 * The line's accessible name, with the literal word "blank" substituted for each masked
 * token — so the line reads naturally and the gap is audible. This is what blind users of
 * fill-in-the-blank material expect (§9.8 rule 1).
 */
export function buildLineLabel(
  tokens: Token[],
  styleAt: (i: number) => MaskStyleCode,
  lineNumber: number,
): string {
  const parts: string[] = [];
  for (const t of tokens) {
    const s = styleAt(t.i);
    if (s === MaskStyle.none || s === MaskStyle.dim) {
      parts.push(t.lead + t.text + t.trail);
    } else if (s === MaskStyle.initial) {
      parts.push(`blank starting with ${t.firstLetter}`);
    } else {
      parts.push('blank');
    }
  }
  return `Line ${lineNumber}: ${parts.join(' ')}`;
}
