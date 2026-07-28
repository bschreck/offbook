import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { RUNG_LABELS } from '../core/mask/ladder';
import { getMethod } from '../core/mask/registry';
import { deriveDocument, PIPELINE_VERSION } from '../core/text/derive';
import type { Document } from '../core/text/types';
import { invalidateDerived, readDerived, writeDerived } from '../data/repos/derived';
import { getDocText, getDocument, roleSetHashFor, updateDocument } from '../data/repos/documents';
import type { DocumentRecord } from '../data/schema';
import { useLibrary } from '../stores/libraryStore';
import { useUi } from '../stores/uiStore';

export function TextRoute() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useUi((s) => s.toast);
  const reloadLibrary = useLibrary((s) => s.load);

  const [record, setRecord] = useState<DocumentRecord | null>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      const rec = await getDocument(id);
      const textRow = await getDocText(id);
      if (cancelled || !rec || !textRow) return;
      let d = await readDerived(id, PIPELINE_VERSION, rec.textHash);
      if (!d) {
        d = deriveDocument({
          id,
          sourceText: textRow.sourceText,
          manualText: rec.manualText,
          cleanupConfig: rec.cleanupConfig,
          structureOverrides: rec.structureOverrides,
          kind: rec.kind,
          lang: rec.lang,
        }).doc;
        await writeDerived(id, PIPELINE_VERSION, rec.textHash, d, Date.now());
      }
      if (cancelled) return;
      setRecord(rec);
      setDoc(d);
      setDraft(rec.manualText ?? textRow.sourceText);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) return <main className="page">No text selected.</main>;
  if (!record || !doc) return <main className="page">Loading…</main>;

  const myRoles = new Set(record.myRoleIds);

  const toggleRole = async (roleId: string) => {
    const next = new Set(myRoles);
    if (next.has(roleId)) next.delete(roleId);
    else next.add(roleId);
    const ids = [...next];
    const updated = await updateDocument(
      record.id,
      { myRoleIds: ids, roleSetHash: roleSetHashFor(ids) },
      Date.now(),
    );
    if (updated) setRecord(updated);
  };

  const saveEdit = async () => {
    // `sourceText` is immutable; a manual edit is an override on top of it, so "reset to
    // the original import" can never fail (§3.1).
    const updated = await updateDocument(record.id, { manualText: draft }, Date.now());
    await invalidateDerived(record.id);
    if (updated) setRecord(updated);
    setEditing(false);
    setDoc(null);
    toast('Text updated');
    navigate(0);
  };

  const method = getMethod(record.prefs.methodId);

  return (
    <main className="page">
      <Link
        to="/"
        className="btn btn--ghost"
        style={{ marginInlineStart: 'calc(var(--sp-3) * -1)' }}
      >
        ‹ Library
      </Link>
      <h1 className="page-title">{record.title}</h1>
      <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
        {doc.wordCount} words · {doc.lines.length} lines · {doc.chunks.length} chunks
        {record.lastRunPeeks100 !== null &&
          ` · last run: ${record.lastRunPeeks100} peeks per 100 words`}
      </p>

      <p style={{ marginBlock: 'var(--sp-5)' }}>
        <Link
          className="btn btn--primary"
          to={`/t/${record.id}/read`}
          style={{ inlineSize: '100%', minHeight: 48 }}
        >
          Read — {method.name}, {RUNG_LABELS[record.prefs.ladderIndex ?? 0]}
        </Link>
      </p>

      {doc.roles.length > 0 && (
        <section style={{ marginBlockStart: 'var(--sp-6)' }}>
          <h2 style={{ fontSize: 'var(--fs-md)' }}>Which part is yours?</h2>
          <p className="faint" style={{ fontSize: 'var(--fs-xs)', marginBlockEnd: 'var(--sp-3)' }}>
            Pick your character and only your lines get hidden — everyone else stays visible as
            cues. Works with every way of hiding, not just one.
          </p>
          <div className="lib__chips" style={{ flexWrap: 'wrap' }}>
            {doc.roles.map((r) => (
              <button
                key={r.id}
                type="button"
                className="chip"
                aria-pressed={myRoles.has(r.id)}
                onClick={() => void toggleRole(r.id)}
              >
                {r.label} · {r.lineCount}
              </button>
            ))}
          </div>
        </section>
      )}

      <section style={{ marginBlockStart: 'var(--sp-8)' }}>
        <h2 style={{ fontSize: 'var(--fs-md)' }}>The text</h2>
        {editing ? (
          <>
            <textarea
              className="import__area"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={16}
              spellCheck={false}
            />
            <div className="row" style={{ gap: 'var(--sp-2)', marginBlockStart: 'var(--sp-2)' }}>
              <button type="button" className="btn btn--primary" onClick={() => void saveEdit()}>
                Save changes
              </button>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
              {record.manualText !== null && (
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={async () => {
                    const row = await getDocText(record.id);
                    setDraft(row?.sourceText ?? '');
                    toast('Reverted to the original import — save to keep it');
                  }}
                >
                  Reset to original
                </button>
              )}
            </div>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Edit the text
          </button>
        )}
      </section>

      <section style={{ marginBlockStart: 'var(--sp-8)' }}>
        <h2 style={{ fontSize: 'var(--fs-md)' }}>Folder</h2>
        <FolderPicker record={record} onMoved={setRecord} onChanged={reloadLibrary} />
      </section>
    </main>
  );
}

function FolderPicker({
  record,
  onMoved,
  onChanged,
}: {
  record: DocumentRecord;
  onMoved: (r: DocumentRecord) => void;
  onChanged: () => Promise<void>;
}) {
  const { folders, createFolder } = useLibrary();
  const [newName, setNewName] = useState('');

  const move = async (folderId: string | null) => {
    const updated = await updateDocument(record.id, { folderId }, Date.now());
    if (updated) onMoved(updated);
    await onChanged();
  };

  return (
    <>
      <div className="lib__chips" style={{ flexWrap: 'wrap' }}>
        <button
          type="button"
          className="chip"
          aria-pressed={record.folderId === null}
          onClick={() => void move(null)}
        >
          None
        </button>
        {folders.map((f) => (
          <button
            key={f.id}
            type="button"
            className="chip"
            aria-pressed={record.folderId === f.id}
            onClick={() => void move(f.id)}
          >
            {f.name}
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 'var(--sp-2)' }}>
        <input
          className="import__title grow"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New folder"
        />
        <button
          type="button"
          className="btn"
          disabled={!newName.trim()}
          onClick={async () => {
            await createFolder(newName);
            setNewName('');
          }}
        >
          Create
        </button>
      </div>
    </>
  );
}
