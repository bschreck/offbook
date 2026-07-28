import { Fragment, memo } from 'react';
import { MaskStyle, type MaskStyleCode } from '../../core/mask/types';
import type { Line } from '../../core/text/types';
import { buildLineLabel, MaskedToken } from './MaskedToken';

export interface LineViewProps {
  line: Line;
  /** Slice of MaskPlan.styles covering this line's tokens, keyed by absolute token index. */
  styleAt: (i: number) => MaskStyleCode;
  peeked: number | null;
  revealed: ReadonlySet<number>;
  isCurrent: boolean;
  isNear: boolean;
  isCue: boolean;
  hiddenLine: boolean;
  type: string;
  verbose: boolean;
}

export const LineView = memo(function LineView({
  line,
  styleAt,
  peeked,
  revealed,
  isCurrent,
  isNear,
  isCue,
  hiddenLine,
  type,
  verbose,
}: LineViewProps) {
  let hiddenTotal = 0;
  for (const t of line.tokens) {
    const s = styleAt(t.i);
    if (s !== MaskStyle.none && s !== MaskStyle.dim) hiddenTotal++;
  }

  let ordinal = 0;
  const style =
    line.indentEm > 0 ? ({ '--indent': `${line.indentEm}em` } as React.CSSProperties) : undefined;

  return (
    <div
      className="ln"
      data-line={line.idx}
      data-current={isCurrent || undefined}
      data-near={isNear || undefined}
      data-cue={isCue || undefined}
      data-hidden-line={hiddenLine || undefined}
      data-type={type}
      style={style}
      role="group"
      aria-label={buildLineLabel(line.tokens, styleAt, line.idx + 1)}
    >
      {line.tokens.map((t) => {
        const s = styleAt(t.i);
        const masked = s !== MaskStyle.none && s !== MaskStyle.dim;
        if (masked) ordinal++;
        return (
          <Fragment key={t.i}>
            {t.ws}
            <MaskedToken
              token={t}
              style={s}
              peeked={peeked === t.i}
              revealed={revealed.has(t.i)}
              hiddenOrdinal={ordinal}
              hiddenTotal={hiddenTotal}
              verbose={verbose}
            />
          </Fragment>
        );
      })}
    </div>
  );
});
