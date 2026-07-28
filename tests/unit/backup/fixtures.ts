import type { BackupInput, BackupMetaInput } from '../../../src/core/backup/export';
import type {
  BackupDocText,
  BackupDocument,
  BackupFolder,
  BackupRep,
  SettingsValue,
} from '../../../src/core/backup/types';

export const META: BackupMetaInput = {
  appVersion: '1.0.0',
  createdAt: '2026-07-28T09:30:00.000Z',
  installId: 'install-abc',
};

export function makeFolder(over: Partial<BackupFolder> = {}): BackupFolder {
  return {
    id: 'fold-1',
    name: 'Auditions',
    sortName: 'auditions',
    color: '#10756A',
    order: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    deletedAt: null,
    sv: 1,
    ...over,
  };
}

export function makeDocument(over: Partial<BackupDocument> = {}): BackupDocument {
  return {
    id: 'doc-1',
    folderId: 'fold-1',
    title: 'Hamlet, III.i',
    sortTitle: 'hamlet, iii.i',
    kind: 'script',
    lang: 'en',
    textHash: 'aabbccdd',
    pipelineVersion: 3,
    wordCount: 260,
    charCount: 1480,
    chunkCount: 12,
    roles: [
      {
        id: 'role-ham',
        label: 'HAMLET',
        aliases: ['HAM.'],
        colorIndex: 2,
        isEnsemble: false,
        lineCount: 33,
        wordCount: 260,
        firstLineIndex: 0,
      },
    ],
    myRoleIds: ['role-ham'],
    roleSetHash: 'ff00ff00',
    roleView: 'mine',
    cueTailWords: 5,
    cleanupConfig: {
      normalise: true,
      punctuation: true,
      whitespace: true,
      dropArtifacts: true,
      unwrap: false,
    },
    manualText: null,
    structureOverrides: [
      { kind: 'lineType', fingerprint: '1a2b3c4d', type: 'direction' },
      { kind: 'speaker', fingerprint: '5e6f7a8b', speakerId: 'role-ham' },
      { kind: 'chunkBreak', fingerprint: '9c0d1e2f' },
    ],
    prefs: {
      methodId: 'hideWords',
      ladderIndex: 3,
      customPercent: null,
      methodParams: { protectProperNouns: true, seedBias: 0.25 },
      reshuffle: 2,
      chunkStrategy: 'auto',
      chunkTargetWords: 28,
      manualChunkBreaks: ['9c0d1e2f'],
    },
    cursor: {
      chunkKey: 'chunk-7',
      lineFingerprint: 'deadbeef',
      scrollFraction: 0.42,
      step: 3,
      updatedAt: 1_700_000_500_000,
    },
    performanceAt: 1_800_000_000_000,
    performanceTz: 'Europe/London',
    targetDurationSec: 180,
    source: { type: 'pdf', filename: 'hamlet.pdf', importedAt: 1_700_000_000_000 },
    lastPracticedAt: 1_700_000_900_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_900_000,
    deletedAt: null,
    sv: 1,
    ...over,
  };
}

export function makeDocText(over: Partial<BackupDocText> = {}): BackupDocText {
  return {
    docId: 'doc-1',
    sourceText: 'To be, or not to be, that is the question:\nWhether ’tis nobler…',
    textHash: 'aabbccdd',
    sourceMeta: { pdfPages: 2, droppedArtifacts: 4, parserConfidence: 0.93 },
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

export function makeRep(over: Partial<BackupRep> = {}): BackupRep {
  return {
    id: 'rep-1',
    docId: 'doc-1',
    roleSetHash: 'ff00ff00',
    chunkKey: 'chunk-7',
    sessionId: null,
    at: 1_700_000_800_000,
    ms: 41_000,
    tzOffsetMin: -60,
    mode: 'recall',
    mask: { methodId: 'hideWords', m: 0.4, mContent: 0.55, kind: 'blank', promptVisible: true },
    grade: 3,
    stakes: 1.4,
    peeks: 2,
    lineReveals: 1,
    revealAllUsed: false,
    score: 0.87,
    missedTokenIdx: [4, 11],
    post: { S: 3.2, D: 5.1, C: 0.78 },
    ...over,
  };
}

export const SETTINGS: Record<string, SettingsValue> = {
  'ui.theme': 'system',
  'reader.fontPx': 22,
  'reader.autoScrollMode': 'smooth',
  'input.twoFingerGestures': false,
};

export function makeInput(over: Partial<BackupInput> = {}): BackupInput {
  return {
    folders: [makeFolder()],
    documents: [makeDocument()],
    docTexts: [makeDocText()],
    reps: [makeRep(), makeRep({ id: 'rep-2', grade: 4, clockSuspect: true })],
    settings: SETTINGS,
    ...over,
  };
}
