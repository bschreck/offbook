import { create } from 'zustand';
import { computeMaskPlan } from '../core/mask/plan';
import { getMethod } from '../core/mask/registry';
import { LADDER_LENGTH, type MaskPlan, type MethodId, type ModeSpec } from '../core/mask/types';
import { deriveDocument, PIPELINE_VERSION } from '../core/text/derive';
import type { Document } from '../core/text/types';
import { clamp } from '../core/util/assert';
import { readDerived, writeDerived } from '../data/repos/derived';
import {
  appendRep,
  getDocText,
  getDocument,
  roleSetHashFor,
  updateDocument,
} from '../data/repos/documents';
import type { DocumentRecord } from '../data/schema';

interface ReaderState {
  docId: string | null;
  record: DocumentRecord | null;
  doc: Document | null;
  spec: ModeSpec | null;
  plan: MaskPlan | null;
  loading: boolean;
  error: string | null;

  /** Distinct tokens peeked this run. The size is the measurement, not a running total. */
  peekedThisRun: Set<number>;
  runStartedAt: number;

  load: (docId: string) => Promise<void>;
  close: () => void;

  setMethod: (id: MethodId) => void;
  setRung: (index: number) => void;
  harder: () => void;
  easier: () => void;
  reshuffle: () => void;
  setMyRoles: (roleIds: string[]) => void;

  peek: (i: number) => void;
  endPeek: () => void;
  toggleReveal: (i: number) => void;
  setRevealAll: (on: boolean) => void;
  /** Hard reset of the rep: clears peeks, reveals and the timer, keeping seed and rung. */
  resetRep: () => void;

  /** Records the rep and, if it was clean, offers the next rung. Returns whether it was clean. */
  finishRun: () => Promise<boolean>;
}

function specFor(record: DocumentRecord): ModeSpec {
  const p = record.prefs;
  return {
    methodId: p.methodId,
    ladderIndex: p.customPercent === null ? (p.ladderIndex ?? 0) : null,
    customPercent: p.customPercent,
    params: { ...p.methodParams },
    lens: {
      myRoleIds: record.myRoleIds,
      cueStyle: record.cueStyle,
      cueTailWords: record.cueTailWords,
    },
    scope: { kind: 'text' },
    blankStyle: 'underline',
    reshuffle: p.reshuffle,
    phase: 0,
    reveals: { peeked: null, revealed: new Set(), revealAll: false },
  };
}

export const useReader = create<ReaderState>((set, get) => {
  /** Recompute the plan from the current doc+spec. The ONLY way `plan` is ever written. */
  const replan = (spec: ModeSpec) => {
    const { doc } = get();
    if (!doc) return;
    set({ spec, plan: computeMaskPlan(doc, spec) });
  };

  const patchSpec = (patch: Partial<ModeSpec>) => {
    const { spec } = get();
    if (!spec) return;
    replan({ ...spec, ...patch });
  };

  return {
    docId: null,
    record: null,
    doc: null,
    spec: null,
    plan: null,
    loading: false,
    error: null,
    peekedThisRun: new Set(),
    runStartedAt: 0,

    load: async (docId) => {
      set({ loading: true, error: null });
      try {
        const record = await getDocument(docId);
        if (!record || record.deletedAt !== null) {
          set({ loading: false, error: 'notfound' });
          return;
        }
        const textRow = await getDocText(docId);
        if (!textRow) {
          set({ loading: false, error: 'notext' });
          return;
        }

        let doc = await readDerived(docId, PIPELINE_VERSION, record.textHash);
        if (!doc) {
          const derived = deriveDocument({
            id: docId,
            sourceText: textRow.sourceText,
            manualText: record.manualText,
            cleanupConfig: record.cleanupConfig,
            structureOverrides: record.structureOverrides,
            kind: record.kind,
            lang: record.lang,
            chunkStrategy: record.prefs.chunkStrategy,
            chunkTargetWords: record.prefs.chunkTargetWords,
            manualChunkBreaks: record.prefs.manualChunkBreaks,
          });
          doc = derived.doc;
          await writeDerived(docId, PIPELINE_VERSION, record.textHash, doc, Date.now());
        }

        const spec = specFor(record);
        set({
          docId,
          record,
          doc,
          spec,
          plan: computeMaskPlan(doc, spec),
          loading: false,
          peekedThisRun: new Set(),
          runStartedAt: Date.now(),
        });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : 'load failed' });
      }
    },

    close: () =>
      set({
        docId: null,
        record: null,
        doc: null,
        spec: null,
        plan: null,
        peekedThisRun: new Set(),
      }),

    setMethod: (id) => {
      const { spec, record } = get();
      if (!spec || !record) return;
      const method = getMethod(id);
      const ladderIndex = clamp(spec.ladderIndex ?? 0, 0, method.maxRung);
      replan({
        ...spec,
        methodId: id,
        ladderIndex,
        customPercent: null,
        params: { ...method.defaultParams },
        reveals: { peeked: null, revealed: new Set(), revealAll: false },
      });
      void persistPrefs(record, { methodId: id, ladderIndex, customPercent: null });
    },

    setRung: (index) => {
      const { spec, record } = get();
      if (!spec || !record) return;
      const max = getMethod(spec.methodId).maxRung;
      const ladderIndex = clamp(index, 0, Math.min(max, LADDER_LENGTH - 1));
      // Changing rung starts a fresh attempt: last rung's reveals must not carry over.
      replan({
        ...spec,
        ladderIndex,
        customPercent: null,
        reveals: { peeked: null, revealed: new Set(), revealAll: false },
      });
      set({ peekedThisRun: new Set(), runStartedAt: Date.now() });
      void persistPrefs(record, { ladderIndex, customPercent: null });
    },

    harder: () => get().setRung((get().spec?.ladderIndex ?? 0) + 1),
    easier: () => get().setRung((get().spec?.ladderIndex ?? 0) - 1),

    reshuffle: () => {
      const { spec, record } = get();
      if (!spec || !record) return;
      const reshuffle = spec.reshuffle + 1;
      replan({
        ...spec,
        reshuffle,
        reveals: { peeked: null, revealed: new Set(), revealAll: false },
      });
      void persistPrefs(record, { reshuffle });
    },

    setMyRoles: (roleIds) => {
      const { spec, record } = get();
      if (!spec || !record) return;
      patchSpec({ lens: { ...spec.lens, myRoleIds: roleIds } });
      void updateDocument(
        record.id,
        { myRoleIds: roleIds, roleSetHash: roleSetHashFor(roleIds) },
        Date.now(),
      );
    },

    peek: (i) => {
      const { spec, peekedThisRun } = get();
      if (!spec) return;
      // A word peeked twice still cost you once; the set is what the rep records.
      const next = new Set(peekedThisRun);
      next.add(i);
      set({ peekedThisRun: next });
      replan({ ...spec, reveals: { ...spec.reveals, peeked: i } });
    },

    endPeek: () => {
      const { spec } = get();
      if (!spec || spec.reveals.peeked === null) return;
      replan({ ...spec, reveals: { ...spec.reveals, peeked: null } });
    },

    toggleReveal: (i) => {
      const { spec, peekedThisRun } = get();
      if (!spec) return;
      const revealed = new Set(spec.reveals.revealed);
      if (revealed.has(i)) {
        revealed.delete(i);
      } else {
        revealed.add(i);
        const next = new Set(peekedThisRun);
        next.add(i);
        set({ peekedThisRun: next });
      }
      replan({ ...spec, reveals: { ...spec.reveals, revealed } });
    },

    setRevealAll: (on) => {
      const { spec } = get();
      if (!spec) return;
      replan({ ...spec, reveals: { ...spec.reveals, revealAll: on } });
    },

    resetRep: () => {
      const { spec } = get();
      if (!spec) return;
      replan({ ...spec, reveals: { peeked: null, revealed: new Set(), revealAll: false } });
      set({ peekedThisRun: new Set(), runStartedAt: Date.now() });
    },

    finishRun: async () => {
      const { record, doc, spec, plan, peekedThisRun, runStartedAt } = get();
      if (!record || !doc || !spec || !plan) return false;

      const peeks = peekedThisRun.size;
      const durationMs = Date.now() - runStartedAt;
      const now = Date.now();

      // Nothing displays reps in v1 — they exist so the deferred progress model is a
      // recompute rather than a rewrite. ADR-0006.
      await appendRep({
        docId: record.id,
        roleSetHash: record.roleSetHash,
        chunkKey: 'whole',
        at: now,
        methodId: spec.methodId,
        ladderIndex: spec.ladderIndex,
        customPercent: spec.customPercent,
        maskedCount: plan.maskedCount,
        candidateCount: plan.candidateCount,
        peeks,
        reveals: spec.reveals.revealed.size,
        durationMs,
      });

      const peeks100 = doc.wordCount > 0 ? (peeks / doc.wordCount) * 100 : 0;
      await updateDocument(
        record.id,
        { lastPracticedAt: now, lastRunPeeks100: Number(peeks100.toFixed(1)) },
        now,
      );

      const clean = peeks === 0 && plan.maskedCount >= 3;
      set({ peekedThisRun: new Set(), runStartedAt: Date.now() });
      return clean;
    },
  };
});

async function persistPrefs(
  record: DocumentRecord,
  patch: Partial<DocumentRecord['prefs']>,
): Promise<void> {
  await updateDocument(record.id, { prefs: { ...record.prefs, ...patch } }, Date.now());
}
