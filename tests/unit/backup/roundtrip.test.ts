import { describe, expect, it } from 'vitest';
import { buildBackup, buildDocumentExport } from '../../../src/core/backup/export';
import { CURRENT_FORMAT_VERSION } from '../../../src/core/backup/types';
import { validateBackup } from '../../../src/core/backup/validate';
import { META, makeDocText, makeDocument, makeInput, makeRep } from './fixtures';

describe('buildBackup / validateBackup round trip', () => {
  it('survives JSON.stringify -> JSON.parse -> validate unchanged', () => {
    const input = makeInput();
    const built = buildBackup(input, META);

    const parsed: unknown = JSON.parse(JSON.stringify(built));
    const result = validateBackup(parsed);
    if (!result.ok) throw new Error(`expected a valid backup, got: ${result.errors.join('; ')}`);

    expect(result.backup).toEqual(built);
    expect(result.warnings).toEqual([]);

    expect(result.backup.folders).toEqual(input.folders);
    expect(result.backup.documents).toEqual(input.documents);
    expect(result.backup.docTexts).toEqual(input.docTexts);
    expect(result.backup.reps).toEqual(input.reps);
    expect(result.backup.settings).toEqual(input.settings);
  });

  it('writes the brand-neutral envelope', () => {
    const built = buildBackup(makeInput(), META);
    expect(built.format).toBe('lines.backup');
    expect(built.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(built.appVersion).toBe('1.0.0');
    expect(built.createdAt).toBe('2026-07-28T09:30:00.000Z');
    expect(built.installId).toBe('install-abc');
    expect(built.counts).toEqual({ folders: 1, documents: 1, docTexts: 1, reps: 2 });
    expect(JSON.stringify(built)).not.toMatch(/Offbook/i);
  });

  it('is stable: the same records produce the same integrity hash', () => {
    const a = buildBackup(makeInput(), META);
    const b = buildBackup(makeInput(), { ...META, createdAt: '2027-01-01T00:00:00.000Z' });
    expect(b.integrity).toBe(a.integrity);
  });

  it('changes the integrity hash when any record changes', () => {
    const a = buildBackup(makeInput(), META);
    const b = buildBackup(makeInput({ reps: [makeRep({ grade: 1 })] }), META);
    expect(b.integrity).not.toBe(a.integrity);
  });

  it('does not alias the caller records, so later mutation cannot rewrite the file', () => {
    const rep = makeRep();
    const built = buildBackup(makeInput({ reps: [rep] }), META);
    rep.missedTokenIdx?.push(99);
    expect(built.reps[0]?.missedTokenIdx).toEqual([4, 11]);
  });

  it('drops fields that are not part of the format (derived caches, progress)', () => {
    const doc = { ...makeDocument(), progress: { readiness: 42 }, derived: { tokStart: [1, 2] } };
    const built = buildBackup(makeInput({ documents: [doc] }), META);
    expect(built.documents[0]).not.toHaveProperty('progress');
    expect(built.documents[0]).not.toHaveProperty('derived');
    expect(validateBackup(JSON.parse(JSON.stringify(built))).ok).toBe(true);
  });

  it('rejects a createdAt that is not an ISO timestamp', () => {
    expect(() => buildBackup(makeInput(), { ...META, createdAt: '28/07/2026' })).toThrow(
      /ISO-8601/,
    );
  });

  describe('buildDocumentExport', () => {
    it('produces an ordinary one-document backup that validates', () => {
      const doc = makeDocument();
      const file = buildDocumentExport(doc, makeDocText(), META);
      expect(file.format).toBe('lines.backup');
      expect(file.counts).toEqual({ folders: 0, documents: 1, docTexts: 1, reps: 0 });
      expect(file.folders).toEqual([]);
      expect(file.settings).toEqual({});

      const result = validateBackup(JSON.parse(JSON.stringify(file)));
      if (!result.ok) throw new Error(result.errors.join('; '));
      expect(result.backup.documents[0]).toEqual(doc);
    });

    it('carries reps only when the caller passes them', () => {
      const withHistory = buildDocumentExport(makeDocument(), makeDocText(), META, [makeRep()]);
      expect(withHistory.reps).toHaveLength(1);
      expect(withHistory.counts.reps).toBe(1);
    });

    it('refuses a docText belonging to another document', () => {
      expect(() =>
        buildDocumentExport(makeDocument(), makeDocText({ docId: 'doc-9' }), META),
      ).toThrow(/does not match/);
    });
  });
});
