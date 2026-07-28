import { create } from 'zustand';
import { identityNormalize } from '../core/util/hash';
import { onRemoteWrite } from '../data/broadcast';
import {
  getDocText,
  listDocuments,
  purgeDocument,
  restoreDocument,
  softDeleteDocument,
  updateDocument,
} from '../data/repos/documents';
import {
  createFolder as createFolderRepo,
  deleteFolder as deleteFolderRepo,
  listFolders,
  renameFolder as renameFolderRepo,
} from '../data/repos/folders';
import type { DocumentRecord, FolderRecord } from '../data/schema';

export type SortOrder = 'recent' | 'title' | 'added';

interface LibraryState {
  docs: DocumentRecord[];
  folders: FolderRecord[];
  loaded: boolean;
  query: string;
  folderId: string | null;
  sort: SortOrder;

  load: () => Promise<void>;
  setQuery: (q: string) => void;
  setFolder: (id: string | null) => void;
  setSort: (s: SortOrder) => void;

  createFolder: (name: string) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  moveToFolder: (docId: string, folderId: string | null) => Promise<void>;
  renameDoc: (docId: string, title: string) => Promise<void>;
  deleteDoc: (docId: string) => Promise<() => Promise<void>>;
  purgeDoc: (docId: string) => Promise<void>;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  docs: [],
  folders: [],
  loaded: false,
  query: '',
  folderId: null,
  sort: 'recent',

  load: async () => {
    const [docs, folders] = await Promise.all([listDocuments(), listFolders()]);
    set({ docs, folders, loaded: true });
  },

  setQuery: (query) => set({ query }),
  setFolder: (folderId) => set({ folderId }),
  setSort: (sort) => set({ sort }),

  createFolder: async (name) => {
    await createFolderRepo(name, Date.now());
    await get().load();
  },
  renameFolder: async (id, name) => {
    await renameFolderRepo(id, name, Date.now());
    await get().load();
  },
  deleteFolder: async (id) => {
    await deleteFolderRepo(id, Date.now());
    await get().load();
  },
  moveToFolder: async (docId, folderId) => {
    await updateDocument(docId, { folderId }, Date.now());
    await get().load();
  },
  renameDoc: async (docId, title) => {
    await updateDocument(docId, { title, sortTitle: title.trim().toLowerCase() }, Date.now());
    await get().load();
  },

  /** Soft delete, returning the inverse so the snackbar's Undo is a field flip. */
  deleteDoc: async (docId) => {
    await softDeleteDocument(docId, Date.now());
    await get().load();
    return async () => {
      await restoreDocument(docId, Date.now());
      await get().load();
    };
  },

  purgeDoc: async (docId) => {
    await purgeDocument(docId);
    await get().load();
  },
}));

// Another tab wrote something; our mirror is stale.
onRemoteWrite(() => {
  void useLibrary.getState().load();
});

/**
 * Filtering and search. Brute force over titles, and over full text only when the title
 * search finds nothing — at this library size that answers every query in well under the
 * frame budget, and it costs no index, no store and no migration (§3.2).
 */
export async function searchDocuments(
  docs: DocumentRecord[],
  query: string,
): Promise<DocumentRecord[]> {
  const q = identityNormalize(query);
  if (!q) return docs;

  const byTitle = docs.filter((d) => identityNormalize(d.title).includes(q));
  if (byTitle.length > 0) return byTitle;

  const hits: DocumentRecord[] = [];
  for (const doc of docs) {
    const row = await getDocText(doc.id);
    if (row && identityNormalize(row.sourceText).includes(q)) hits.push(doc);
  }
  return hits;
}

export function sortDocuments(docs: DocumentRecord[], order: SortOrder): DocumentRecord[] {
  const out = [...docs];
  switch (order) {
    case 'title':
      return out.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
    case 'added':
      return out.sort((a, b) => b.createdAt - a.createdAt);
    default:
      return out.sort(
        (a, b) => (b.lastPracticedAt ?? b.updatedAt) - (a.lastPracticedAt ?? a.updatedAt),
      );
  }
}
