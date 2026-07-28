import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { RestorePlan } from '../core/backup/import';
import { isStandalone, readStorageStatus, requestPersistence } from '../data/storageInfo';
import {
  applyRestorePlan,
  buildRestorePlan,
  downloadJson,
  exportBackupJson,
  readBackupFile,
} from '../features/backup/backupService';
import { useLibrary } from '../stores/libraryStore';
import { useSettings } from '../stores/settingsStore';
import { useUi } from '../stores/uiStore';
import '../components/sheet.css';

export function SettingsRoute() {
  const settings = useSettings((s) => s.settings);
  const set = useSettings((s) => s.set);
  const docs = useLibrary((s) => s.docs);
  const reloadLibrary = useLibrary((s) => s.load);
  const toast = useUi((s) => s.toast);

  const [storage, setStorage] = useState<Awaited<ReturnType<typeof readStorageStatus>> | null>(
    null,
  );
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void readStorageStatus(docs.length > 0).then(setStorage);
  }, [docs.length]);

  return (
    <main className="page">
      <Link
        to="/"
        className="btn btn--ghost"
        style={{ marginInlineStart: 'calc(var(--sp-3) * -1)' }}
      >
        ‹ Library
      </Link>
      <h1 className="page-title">Settings</h1>

      <div className="field">
        <span className="field__label">Theme</span>
        <div className="seg">
          {(['system', 'light', 'dark', 'contrast'] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={settings['ui.theme'] === t}
              onClick={() => void set('ui.theme', t)}
            >
              {t === 'contrast' ? 'High contrast' : t[0]?.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field__label">Peeking at a hidden word</span>
        <div className="seg">
          <button
            type="button"
            aria-pressed={settings['input.peekBehaviour'] === 'hold'}
            onClick={() => void set('input.peekBehaviour', 'hold')}
          >
            Hold to peek
          </button>
          <button
            type="button"
            aria-pressed={settings['input.peekBehaviour'] === 'tap'}
            onClick={() => void set('input.peekBehaviour', 'tap')}
          >
            Tap to keep
          </button>
        </div>
      </div>

      <div className="field">
        <span className="field__label">Auto-scroll</span>
        <div className="seg">
          <button
            type="button"
            aria-pressed={settings['reader.autoScrollMode'] === 'smooth'}
            onClick={() => void set('reader.autoScrollMode', 'smooth')}
          >
            Smooth
          </button>
          <button
            type="button"
            aria-pressed={settings['reader.autoScrollMode'] === 'stepped'}
            onClick={() => void set('reader.autoScrollMode', 'stepped')}
          >
            Line by line
          </button>
        </div>
      </div>

      <div className="field">
        <span className="field__label">Keep the screen awake</span>
        <div className="seg">
          {(['sessions', 'always', 'never'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={settings['reader.keepAwake'] === v}
              onClick={() => void set('reader.keepAwake', v)}
            >
              {v === 'sessions' ? 'While scrolling' : v === 'always' ? 'Always' : 'Never'}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field__label">Step up automatically after a clean run</span>
        <div className="seg">
          <button
            type="button"
            aria-pressed={settings['practice.autoAdvanceOnCleanRun']}
            onClick={() => void set('practice.autoAdvanceOnCleanRun', true)}
          >
            Yes
          </button>
          <button
            type="button"
            aria-pressed={!settings['practice.autoAdvanceOnCleanRun']}
            onClick={() => void set('practice.autoAdvanceOnCleanRun', false)}
          >
            No
          </button>
        </div>
      </div>

      <h2 style={{ marginBlockStart: 'var(--sp-8)', fontSize: 'var(--fs-md)' }}>
        Your texts live on this device
      </h2>
      <p className="faint" style={{ fontSize: 'var(--fs-xs)', marginBlockEnd: 'var(--sp-3)' }}>
        {docs.length} text{docs.length === 1 ? '' : 's'}
        {storage?.usageBytes != null && ` · about ${formatBytes(storage.usageBytes)} used`}
        {storage?.persisted ? ' · storage is marked persistent' : ' · storage is not persistent'}
      </p>

      {storage && !storage.persisted && (
        <div className="import__warnings" style={{ marginBlockEnd: 'var(--sp-4)' }}>
          <li style={{ listStyle: 'none' }}>
            Safari clears a website’s storage after about seven days without a visit. Installing
            Offbook to your home screen is what stops that, and it is also how the app works
            offline. Keep a backup either way.
            {!isStandalone() && ' You are in a browser tab right now.'}
          </li>
        </div>
      )}

      <div className="row" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const { json, filename } = await exportBackupJson();
            downloadJson(json, filename);
            toast('Backup saved');
          }}
        >
          Save a backup
        </button>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          Restore from a backup
        </button>
        <input
          ref={fileRef}
          type="file"
          className="sr-only"
          accept=".json,application/json"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const read = await readBackupFile(file);
            if (!read.ok) {
              toast(read.errors[0] ?? 'That file isn’t an Offbook backup', { tone: 'danger' });
              return;
            }
            setPlan(await buildRestorePlan(read.backup));
          }}
        />
        {storage && !storage.persisted && (
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const granted = await requestPersistence();
              toast(granted ? 'Storage marked persistent' : 'The browser declined');
              setStorage(await readStorageStatus(docs.length > 0));
            }}
          >
            Ask to keep storage
          </button>
        )}
      </div>

      {plan && (
        <div className="card" style={{ marginBlockStart: 'var(--sp-4)' }}>
          <p>
            <strong>{plan.summary.create}</strong> to add, <strong>{plan.summary.update}</strong> to
            update, <strong>{plan.summary.skip}</strong> already here.
          </p>
          {plan.summary.conflict > 0 && (
            <p className="muted" style={{ marginBlockStart: 'var(--sp-2)' }}>
              {plan.summary.conflict} text{plan.summary.conflict === 1 ? ' has' : 's have'} changed
              on this device since the backup and will be left alone.
            </p>
          )}
          <div className="row" style={{ gap: 'var(--sp-2)', marginBlockStart: 'var(--sp-3)' }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={async () => {
                const n = await applyRestorePlan(plan);
                await reloadLibrary();
                setPlan(null);
                toast(`Restored ${n} record${n === 1 ? '' : 's'}`);
              }}
            >
              Restore
            </button>
            <button type="button" className="btn" onClick={() => setPlan(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <p className="lib__footer">
        <Link to="/about">About Offbook</Link>
      </p>
    </main>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
