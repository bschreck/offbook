import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Sheet } from '../../components/Sheet';
import { RUNG_LABELS } from '../../core/mask/ladder';
import { getMethod } from '../../core/mask/registry';
import { LineFlag, MaskStyle, type MaskStyleCode } from '../../core/mask/types';
import { useReader } from '../../stores/readerStore';
import { useSettings } from '../../stores/settingsStore';
import { useUi } from '../../stores/uiStore';
import { AaSheet } from './AaSheet';
import { haptic, INPUT } from './input';
import { LineView } from './LineView';
import { MethodSheet } from './MethodSheet';
import { useAnnouncer } from './useAnnouncer';
import { useAutoScroll } from './useAutoScroll';
import { useCurrentLine } from './useCurrentLine';
import { useHoldAction, usePeek } from './usePeek';
import { useWakeLock } from './useWakeLock';
import './reader.css';

const WINDOWING_TOKEN_THRESHOLD = 2000;

export function Reader({ docId }: { docId: string }) {
  const navigate = useNavigate();
  // Callback refs backed by state, not useRef: the reader renders a loading screen first,
  // so a plain ref is still null when the binding effects run and would never re-bind.
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLButtonElement | null>(null);

  const {
    record,
    doc,
    spec,
    plan,
    loading,
    error,
    load,
    close,
    harder,
    easier,
    peek,
    endPeek,
    toggleReveal,
    setRevealAll,
    resetRep,
    reshuffle,
    finishRun,
  } = useReader();

  const settings = useSettings((s) => s.settings);
  const toast = useUi((s) => s.toast);
  const announce = useAnnouncer();

  const [sheet, setSheet] = useState<'none' | 'aa' | 'method' | 'more'>('none');
  const [immersive, setImmersive] = useState(false);

  useEffect(() => {
    void load(docId);
    return close;
  }, [docId, load, close]);

  const autoScroll = useAutoScroll(
    canvas,
    settings['reader.autoScrollWpm'],
    settings['reader.autoScrollMode'],
  );
  useWakeLock(settings['reader.keepAwake'] === 'always' || autoScroll.running);
  const currentLine = useCurrentLine(canvas, doc?.lines.length ?? 0);

  const styleAt = useCallback(
    (i: number): MaskStyleCode => (plan?.styles[i] ?? MaskStyle.none) as MaskStyleCode,
    [plan],
  );

  usePeek(
    canvas,
    {
      onPeek: (i) => {
        // Revealing a word means you have lost the thread — the pace should wait for you.
        if (autoScroll.running) autoScroll.pause('peek');
        peek(i);
      },
      onPeekEnd: () => endPeek(),
      onToggleReveal: (i) => toggleReveal(i),
      onCanvasTap: () => {
        if (settings['reader.autoScrollMode'] === 'stepped') autoScroll.stepLine(1);
        else if (autoScroll.running) autoScroll.pause('user');
        else setImmersive((v) => !v);
      },
    },
    {
      behaviour: settings['input.peekBehaviour'],
      haptics: settings['input.haptics'],
    },
  );

  // The documented, always-available panic gesture: hold the stage chip to see everything.
  useHoldAction(
    stageEl,
    INPUT.longPressMs,
    () => {
      setRevealAll(true);
      announce('All words revealed');
    },
    () => {
      setRevealAll(false);
      announce('Words hidden again');
    },
    () => setSheet('method'),
    settings['input.haptics'],
  );

  const rung = spec?.ladderIndex ?? 0;
  const method = spec ? getMethod(spec.methodId) : null;
  const maxRung = method?.maxRung ?? 6;

  const onHarder = useCallback(() => {
    if (rung >= maxRung) return;
    harder();
    haptic(10, settings['input.haptics']);
    announce(RUNG_LABELS[rung + 1] ?? 'Harder');
  }, [rung, maxRung, harder, announce, settings]);

  const onEasier = useCallback(() => {
    if (rung <= 0) return;
    easier();
    haptic(10, settings['input.haptics']);
    announce(RUNG_LABELS[rung - 1] ?? 'Easier');
  }, [rung, easier, announce, settings]);

  const onDone = useCallback(async () => {
    const clean = await finishRun();
    if (clean && settings['practice.autoAdvanceOnCleanRun'] && rung < maxRung) {
      harder();
      toast(`Clean run — moving to ${RUNG_LABELS[rung + 1] ?? 'the next stage'}`);
    } else {
      toast('Run recorded');
    }
    canvas?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [finishRun, settings, rung, maxRung, harder, toast, canvas]);

  // Keyboard map (§9.4), gated so it never fights a text field or a browser shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const editable =
        t?.isContentEditable ||
        t?.tagName === 'INPUT' ||
        t?.tagName === 'TEXTAREA' ||
        t?.tagName === 'SELECT';
      if (editable || e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case ']':
          e.preventDefault();
          onHarder();
          break;
        case '[':
          e.preventDefault();
          onEasier();
          break;
        case 's':
          e.preventDefault();
          autoScroll.toggle();
          break;
        case 'r':
          e.preventDefault();
          setRevealAll(true);
          break;
        case 'm':
          e.preventDefault();
          setSheet('method');
          break;
        case 'a':
          e.preventDefault();
          setSheet('aa');
          break;
        case 'f':
          e.preventDefault();
          setImmersive((v) => !v);
          break;
        case ' ':
          e.preventDefault();
          if (settings['reader.autoScrollMode'] === 'stepped') autoScroll.stepLine(1);
          else autoScroll.toggle();
          break;
        case 'Escape':
          if (immersive) setImmersive(false);
          else navigate(`/t/${docId}`);
          break;
        default:
          if (/^[1-7]$/.test(e.key)) {
            e.preventDefault();
            useReader.getState().setRung(Number(e.key) - 1);
          }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'r') setRevealAll(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [onHarder, onEasier, autoScroll, setRevealAll, immersive, navigate, docId, settings]);

  const blocks = useMemo(() => {
    if (!doc) return [];
    return doc.blocks.map((b) => ({
      block: b,
      lines: b.lineIdxs.map((i) => doc.lines[i]).filter((l) => l !== undefined),
    }));
  }, [doc]);

  if (loading) return <main className="page">Loading…</main>;
  if (error === 'notfound') {
    return (
      <main className="page">
        <h1 className="page-title">Not on this device</h1>
        <p className="muted">This text isn’t stored here. Restore a backup?</p>
      </main>
    );
  }
  if (error || !doc || !plan || !record || !spec) {
    return (
      <main className="page">
        <h1 className="page-title">Couldn’t open this text</h1>
        <p className="muted">{error}</p>
      </main>
    );
  }

  const windowed = doc.tokens.length > WINDOWING_TOKEN_THRESHOLD;
  const myRoles = new Set(spec.lens.myRoleIds);

  return (
    <div className={`reader${immersive ? ' reader--immersive' : ''}`}>
      <div className="reader__rail">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => navigate(`/t/${docId}`)}
          aria-label="Back to text overview"
        >
          ‹
        </button>
        <span className="reader__title grow">{record.title}</span>
        <button
          ref={setStageEl}
          type="button"
          className="reader__stage"
          aria-label={`Stage ${rung + 1} of ${maxRung + 1}: ${RUNG_LABELS[rung]}. Hold to reveal everything.`}
        >
          {RUNG_LABELS[rung]}
        </button>
      </div>

      <div
        ref={setCanvas}
        className="reader__canvas"
        role="region"
        aria-roledescription="Rehearsal text"
        aria-label={`${record.title}, stage ${rung + 1} of ${maxRung + 1}`}
      >
        <div
          className="reader__doc"
          data-windowed={windowed || undefined}
          data-blank-style={settings['reader.blankStyle']}
          data-line-focus={settings['reader.lineFocus'] || undefined}
          lang={doc.lang}
          style={
            {
              '--fs-reader': `${settings['reader.fontPx']}px`,
              '--lh-reader': settings['reader.lineHeight'],
              '--measure': `${settings['reader.measureCh']}ch`,
            } as React.CSSProperties
          }
        >
          {blocks.map(({ block, lines }) => {
            const words = lines.reduce((n, l) => n + l.tokens.length, 0);
            const isCue =
              block.speakerId !== null && myRoles.size > 0 && !myRoles.has(block.speakerId);
            return (
              <div
                key={block.idx}
                className="blk"
                data-words={words}
                style={{ '--est-h': `${Math.max(1, lines.length) * 2}em` } as React.CSSProperties}
              >
                {block.speakerLabel && <div className="blk__speaker">{block.speakerLabel}</div>}
                {lines.map((line) => (
                  <LineView
                    key={line.idx}
                    line={line}
                    styleAt={styleAt}
                    peeked={spec.reveals.peeked}
                    revealed={spec.reveals.revealed}
                    isCurrent={line.idx === currentLine}
                    isNear={Math.abs(line.idx - currentLine) <= 1}
                    isCue={isCue}
                    hiddenLine={((plan.lineFlags[line.idx] ?? 0) & LineFlag.hiddenLine) !== 0}
                    type={block.type}
                    verbose={settings['a11y.verbosity'] === 'verbose'}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="reader__progress">
          <i style={{ width: `${((rung + 1) / (maxRung + 1)) * 100}%` }} />
        </div>
        <div className="reader__bar">
          <button
            type="button"
            className="ctl"
            onClick={() => setSheet('aa')}
            aria-label="Text size and appearance"
          >
            <span className="ctl__glyph">Aa</span>
          </button>
          <button type="button" className="ctl" onClick={onEasier} disabled={rung <= 0}>
            <span className="ctl__glyph">◀</span>
            Easier
          </button>
          <button type="button" className="ctl" onClick={onHarder} disabled={rung >= maxRung}>
            <span className="ctl__glyph">▶</span>
            Harder
          </button>
          <button
            type="button"
            className="ctl"
            onClick={() => autoScroll.toggle()}
            aria-label={autoScroll.running ? 'Pause auto-scroll' : 'Start auto-scroll'}
          >
            <span className="ctl__glyph">{autoScroll.running ? '⏸' : '▶'}</span>
            {settings['reader.autoScrollWpm']}
          </button>
          <button type="button" className="ctl" onClick={() => setSheet('more')} aria-label="More">
            <span className="ctl__glyph">⋯</span>
          </button>
        </div>
      </div>

      <div id="announcer" className="sr-only" aria-live="polite" aria-atomic="true" />

      <AaSheet open={sheet === 'aa'} onClose={() => setSheet('none')} />
      <MethodSheet
        open={sheet === 'method'}
        onClose={() => setSheet('none')}
        doc={doc}
        currentMethod={spec.methodId}
      />
      <Sheet open={sheet === 'more'} title="More" onClose={() => setSheet('none')}>
        <div className="choice-list">
          <button
            type="button"
            className="choice"
            onClick={() => {
              setRevealAll(!spec.reveals.revealAll);
              setSheet('none');
            }}
          >
            <span className="choice__name">
              {spec.reveals.revealAll ? 'Hide words again' : 'Reveal everything'}
            </span>
            <span className="choice__blurb">Or hold the stage chip at any time.</span>
          </button>
          <button
            type="button"
            className="choice"
            onClick={() => {
              reshuffle();
              setSheet('none');
            }}
          >
            <span className="choice__name">Shuffle the blanks</span>
            <span className="choice__blurb">Same difficulty, different words hidden.</span>
          </button>
          <button
            type="button"
            className="choice"
            onClick={() => {
              resetRep();
              setSheet('none');
              toast('Started over');
            }}
          >
            <span className="choice__name">Start this run over</span>
            <span className="choice__blurb">Clears peeks and reveals. Same words hidden.</span>
          </button>
          <button
            type="button"
            className="choice"
            onClick={() => {
              setSheet('none');
              void onDone();
            }}
          >
            <span className="choice__name">I got through it</span>
            <span className="choice__blurb">
              Records the run and, if it was clean, steps you up.
            </span>
          </button>
        </div>
      </Sheet>
    </div>
  );
}
