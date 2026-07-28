import { Sheet } from '../../components/Sheet';
import { useSettings } from '../../stores/settingsStore';
import {
  MEASURE_MAX_CH,
  MEASURE_MIN_CH,
  READER_FONT_MAX_DESKTOP,
  READER_FONT_MIN,
  READER_FONT_STEP,
} from './input';

export function AaSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useSettings((s) => s.settings);
  const set = useSettings((s) => s.set);

  return (
    <Sheet open={open} title="Appearance" onClose={onClose}>
      <label className="field">
        <span className="field__label">
          Text size <span className="field__value">{settings['reader.fontPx']}px</span>
        </span>
        <input
          type="range"
          min={READER_FONT_MIN}
          max={READER_FONT_MAX_DESKTOP}
          step={READER_FONT_STEP}
          value={settings['reader.fontPx']}
          onChange={(e) => void set('reader.fontPx', Number(e.target.value))}
        />
      </label>

      <div className="field">
        <span className="field__label">Line spacing</span>
        <div className="seg">
          {([1.45, 1.65, 1.95] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={settings['reader.lineHeight'] === v}
              onClick={() => void set('reader.lineHeight', v)}
            >
              {v === 1.45 ? 'Tight' : v === 1.65 ? 'Normal' : 'Loose'}
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span className="field__label">
          Line width <span className="field__value">{settings['reader.measureCh']} characters</span>
        </span>
        <input
          type="range"
          min={MEASURE_MIN_CH}
          max={MEASURE_MAX_CH}
          step={2}
          value={settings['reader.measureCh']}
          onChange={(e) => void set('reader.measureCh', Number(e.target.value))}
        />
      </label>

      <div className="field">
        <span className="field__label">Blanks look like</span>
        <div className="seg">
          {(['underline', 'box', 'dots'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={settings['reader.blankStyle'] === v}
              onClick={() => void set('reader.blankStyle', v)}
            >
              {v === 'underline' ? 'Line' : v === 'box' ? 'Box' : 'Dots'}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field__label">Dim everything but the current line</span>
        <div className="seg">
          <button
            type="button"
            aria-pressed={!settings['reader.lineFocus']}
            onClick={() => void set('reader.lineFocus', false)}
          >
            Off
          </button>
          <button
            type="button"
            aria-pressed={settings['reader.lineFocus']}
            onClick={() => void set('reader.lineFocus', true)}
          >
            On
          </button>
        </div>
      </div>

      <label className="field">
        <span className="field__label">
          Auto-scroll pace{' '}
          <span className="field__value">{settings['reader.autoScrollWpm']} words/min</span>
        </span>
        <input
          type="range"
          min={60}
          max={260}
          step={5}
          value={settings['reader.autoScrollWpm']}
          onChange={(e) => void set('reader.autoScrollWpm', Number(e.target.value))}
        />
        <span className="choice__blurb">
          Conversational is about 130. Stage delivery is 100–140.
        </span>
      </label>
    </Sheet>
  );
}
