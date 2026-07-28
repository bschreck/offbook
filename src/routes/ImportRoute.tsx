import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ExtractResult } from '../core/text/extract/types';
import { extractClipboard, extractFile, saveImport } from '../features/import/importService';
import { useLibrary } from '../stores/libraryStore';
import { useUi } from '../stores/uiStore';
import '../features/import/import.css';
import '../components/sheet.css';

const SAMPLES = [
  { file: 'sonnet-18.txt', title: 'Sonnet 18', blurb: 'Shakespeare — 14 lines of verse' },
  {
    file: 'hamlet-soliloquy.txt',
    title: 'Hamlet — To be or not to be',
    blurb: 'A monologue with a speaker cue',
  },
  {
    file: 'earnest-two-hander.txt',
    title: 'The Importance of Being Earnest',
    blurb: 'A two-hander — try the actor mode',
  },
  { file: 'gettysburg.txt', title: 'The Gettysburg Address', blurb: 'Prose — a short speech' },
];

export function ImportRoute() {
  const navigate = useNavigate();
  const toast = useUi((s) => s.toast);
  const reloadLibrary = useLibrary((s) => s.load);

  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const accept = (r: ExtractResult) => {
    setResult(r);
    setText(r.text);
    if (r.title) setTitle(r.title);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!e.clipboardData) return;
    const extracted = extractClipboard(e.clipboardData);
    if (!extracted.text.trim()) return;
    e.preventDefault();
    accept(extracted);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      accept(await extractFile(file));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not read that file', { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const onSample = async (file: string, sampleTitle: string) => {
    setBusy(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}samples/${file}`);
      const body = await res.text();
      setText(body);
      setTitle(sampleTitle);
      setResult({
        text: body,
        title: sampleTitle,
        source: { format: 'txt', hasGeometry: false },
        warnings: [],
      });
    } catch {
      toast('Could not load that sample', { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const format = result?.source.format ?? 'paste';
      const record = await saveImport({
        text,
        title,
        source: {
          type: format === 'paste' ? 'paste' : format,
          ...(result?.source.name ? { filename: result.source.name } : {}),
          importedAt: Date.now(),
        },
        hasGeometry: result?.source.hasGeometry ?? false,
      });
      await reloadLibrary();
      navigate(`/t/${record.id}/read`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', { tone: 'danger' });
      setBusy(false);
    }
  };

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <main className="page">
      <Link
        to="/"
        className="btn btn--ghost"
        style={{ marginInlineStart: 'calc(var(--sp-3) * -1)' }}
      >
        ‹ Library
      </Link>
      <h1 className="page-title">Add a text</h1>

      <label className="field">
        <span className="field__label">
          Paste it here <span className="field__value">{wordCount} words</span>
        </span>
        <textarea
          className="import__area"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          rows={12}
          placeholder="Paste a speech, a scene, a song, a poem…"
          spellCheck={false}
        />
      </label>

      <div className="row" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          Choose a file
        </button>
        <input
          ref={fileRef}
          type="file"
          className="sr-only"
          accept=".txt,.md,.markdown,.html,.htm,.pdf,text/plain,text/markdown,text/html,application/pdf"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
          .txt · .md · .html · PDF
        </span>
      </div>

      {result?.warnings.length ? (
        <ul className="import__warnings">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      <label className="field" style={{ marginBlockStart: 'var(--sp-6)' }}>
        <span className="field__label">Title</span>
        <input
          className="import__title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Taken from the first line if you leave this blank"
        />
      </label>

      <button
        type="button"
        className="btn btn--primary"
        onClick={() => void save()}
        disabled={busy || !text.trim()}
        style={{ inlineSize: '100%', minHeight: 48 }}
      >
        {busy ? 'Working…' : 'Save and start reading'}
      </button>

      <h2 style={{ marginBlockStart: 'var(--sp-10)', fontSize: 'var(--fs-md)' }}>
        Or try one of these
      </h2>
      <p className="faint" style={{ fontSize: 'var(--fs-xs)', marginBlockEnd: 'var(--sp-3)' }}>
        All public domain.
      </p>
      <div className="choice-list">
        {SAMPLES.map((s) => (
          <button
            key={s.file}
            type="button"
            className="choice"
            onClick={() => void onSample(s.file, s.title)}
            disabled={busy}
          >
            <span className="choice__name">{s.title}</span>
            <span className="choice__blurb">{s.blurb}</span>
          </button>
        ))}
      </div>
    </main>
  );
}
