import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { DocumentRecord } from '../data/schema';
import { useAccount } from '../stores/accountStore';
import { type SortOrder, searchDocuments, sortDocuments, useLibrary } from '../stores/libraryStore';
import { useUi } from '../stores/uiStore';
import '../features/library/library.css';

export function LibraryRoute() {
  const { docs, folders, loaded, query, folderId, sort, setQuery, setFolder, setSort, deleteDoc } =
    useLibrary();
  const toast = useUi((s) => s.toast);
  const [matches, setMatches] = useState<DocumentRecord[] | null>(null);

  const inFolder = useMemo(
    () => (folderId === null ? docs : docs.filter((d) => d.folderId === folderId)),
    [docs, folderId],
  );

  // Full-text search touches IndexedDB, so it is async and debounced; title matches alone
  // are synchronous and cover almost every query.
  useEffect(() => {
    if (!query.trim()) {
      setMatches(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void searchDocuments(inFolder, query).then((r) => {
        if (!cancelled) setMatches(r);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, inFolder]);

  const visible = sortDocuments(matches ?? inFolder, sort);

  if (!loaded) return <main className="page">Loading…</main>;

  if (docs.length === 0) {
    return (
      <main className="page">
        <h1 className="page-title">Offbook</h1>
        <div className="empty-state">
          <p style={{ fontSize: 'var(--fs-md)', color: 'var(--text-body)' }}>
            Learn a text by heart by progressively hiding it.
          </p>
          <p style={{ marginBlockStart: 'var(--sp-2)' }}>
            Paste a speech, a scene, a song or a poem. Read it aloud. Hide a few words. Repeat.
          </p>
          <p style={{ marginBlockStart: 'var(--sp-6)' }}>
            <Link className="btn btn--primary" to="/import">
              Add your first text
            </Link>
          </p>
          <p style={{ marginBlockStart: 'var(--sp-4)' }}>
            <Link className="btn" to="/account">
              I already have an account
            </Link>
          </p>
          <p
            className="faint"
            style={{ fontSize: 'var(--fs-xs)', marginBlockStart: 'var(--sp-3)' }}
          >
            Signing in brings the texts from your other devices onto this one.
          </p>
        </div>
        <AccountFooter />
      </main>
    );
  }

  return (
    <main className="page">
      <div className="row" style={{ gap: 'var(--sp-2)' }}>
        <h1 className="page-title grow">Your texts</h1>
        <Link className="btn btn--primary" to="/import">
          Add
        </Link>
      </div>

      <input
        className="lib__search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search titles and text"
        aria-label="Search your texts"
      />

      <div className="lib__chips" role="group" aria-label="Filter by folder">
        <button
          type="button"
          className="chip"
          aria-pressed={folderId === null}
          onClick={() => setFolder(null)}
        >
          All
        </button>
        {folders.map((f) => (
          <button
            key={f.id}
            type="button"
            className="chip"
            aria-pressed={folderId === f.id}
            onClick={() => setFolder(f.id)}
          >
            {f.name}
          </button>
        ))}
        <select
          className="lib__sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortOrder)}
          aria-label="Sort order"
        >
          <option value="recent">Recently practised</option>
          <option value="title">Title</option>
          <option value="added">Recently added</option>
        </select>
      </div>

      {visible.length === 0 ? (
        <div className="empty-state">
          <p>Nothing matches “{query}”.</p>
        </div>
      ) : (
        <ul className="lib__list">
          {visible.map((doc) => (
            <li key={doc.id} className="lib__row">
              {/* One tap from the library into the reader, at the stage you left it. */}
              <Link className="lib__main" to={`/t/${doc.id}/read`}>
                <span className="lib__title">{doc.title}</span>
                <span className="lib__meta">
                  {doc.wordCount} words · {KIND_LABEL[doc.kind]}
                  {doc.lastPracticedAt
                    ? ` · ${relativeDay(doc.lastPracticedAt)}`
                    : ' · not started'}
                </span>
              </Link>
              <Link
                className="lib__chevron"
                to={`/t/${doc.id}`}
                aria-label={`${doc.title} details`}
              >
                ›
              </Link>
              <button
                type="button"
                className="lib__chevron"
                aria-label={`Delete ${doc.title}`}
                onClick={() => {
                  void deleteDoc(doc.id).then((undo) => toast(`Deleted “${doc.title}”`, { undo }));
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <AccountFooter />
    </main>
  );
}

/**
 * Shown on both the empty and populated library, because the empty one is exactly where a
 * signed-out person on a new device needs it and it was missing there.
 */
function AccountFooter() {
  const status = useAccount((s) => s.status);
  const account = useAccount((s) => s.account);

  return (
    <p className="lib__footer">
      {status === 'signedIn' && account ? (
        <Link to="/account">{account.username}</Link>
      ) : (
        <Link to="/account">Sign in to sync</Link>
      )}{' '}
      · <Link to="/settings">Settings</Link> · <Link to="/about">About</Link>
    </p>
  );
}

const KIND_LABEL: Record<DocumentRecord['kind'], string> = {
  script: 'script',
  lyrics: 'lyrics',
  speech: 'speech',
  poem: 'poem',
  lesson: 'lesson',
  other: 'text',
};

function relativeDay(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}
