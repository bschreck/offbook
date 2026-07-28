import { describe, expect, it } from 'vitest';
import { buildBackup } from '../../../src/core/backup/export';
import { type BackupDocText, computeIntegrity } from '../../../src/core/backup/types';
import { validateBackup } from '../../../src/core/backup/validate';
import { META, makeDocument, makeInput } from './fixtures';

/** A valid file as raw JSON, ready to be corrupted in one specific way per test. */
function rawBackup(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(buildBackup(makeInput(), META))) as Record<string, unknown>;
}

/** Re-hash after tampering, so a test about field X does not merely fail on the checksum. */
function resealed(mutate: (raw: Record<string, unknown>) => void): Record<string, unknown> {
  const raw = rawBackup();
  mutate(raw);
  raw.integrity = computeIntegrity({
    folders: raw.folders,
    documents: raw.documents,
    docTexts: raw.docTexts,
    reps: raw.reps,
    settings: raw.settings,
  });
  return raw;
}

/**
 * `obj.__proto__ = v` and `{ __proto__: v }` both hit the prototype *setter*; only
 * defineProperty (and JSON.parse) create the own data property this file is about.
 */
function withOwnKey<T extends object>(target: T, key: string, value: unknown): T {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return target;
}

function errorsOf(input: unknown): string[] {
  const result = validateBackup(input);
  if (result.ok) throw new Error('expected validation to fail, but it succeeded');
  return result.errors;
}

describe('validateBackup rejects', () => {
  it('an empty object, naming the missing marker', () => {
    expect(errorsOf({})).toEqual(['not an Offbook backup (missing "format" marker)']);
  });

  it('null', () => {
    expect(errorsOf(null)).toEqual(['not an Offbook backup (expected a JSON object, got null)']);
  });

  it('a JSON array', () => {
    expect(errorsOf([])).toEqual(['not an Offbook backup (expected a JSON object, got array)']);
  });

  it('a string and a number', () => {
    expect(errorsOf('{}')[0]).toContain('got string');
    expect(errorsOf(7)[0]).toContain('got number');
  });

  it('the right shape with the wrong format string', () => {
    const raw = rawBackup();
    raw.format = 'memocoach.backup';
    expect(errorsOf(raw)).toEqual([
      'not an Offbook backup ("format" is "memocoach.backup", expected "lines.backup")',
    ]);
  });

  it('a non-string format marker', () => {
    const raw = rawBackup();
    raw.format = 1;
    expect(errorsOf(raw)[0]).toContain('"format" is number');
  });

  it('a future format version, and says to update the app', () => {
    const raw = rawBackup();
    raw.formatVersion = 2;
    const [message] = errorsOf(raw);
    expect(message).toContain('newer version of Offbook');
    expect(message).toContain('format version 2');
    expect(message).toContain('reads up to 1');
  });

  it('a format version that is not an integer', () => {
    const raw = rawBackup();
    raw.formatVersion = '1';
    expect(errorsOf(raw)[0]).toContain('formatVersion: expected an integer, got string');
  });

  it('a documents array containing a string', () => {
    const raw = resealed((r) => {
      (r.documents as unknown[]).push('DROP TABLE documents');
    });
    expect(errorsOf(raw)).toContain('documents[1]: expected an object, got string');
  });

  it('a documents array containing null', () => {
    const raw = resealed((r) => {
      (r.documents as unknown[])[0] = null;
    });
    expect(errorsOf(raw)).toContain('documents[0]: expected an object, got null');
  });

  it('a payload section that is not an array', () => {
    const raw = resealed((r) => {
      r.reps = { 0: 'nope' };
    });
    expect(errorsOf(raw)).toContain('reps: expected an array, got object');
  });

  it('a missing payload section', () => {
    const raw = resealed((r) => {
      delete r.docTexts;
    });
    expect(errorsOf(raw)).toContain('docTexts: missing (expected an array)');
  });

  it('an absurd declared count without walking the file', () => {
    const raw = rawBackup();
    raw.counts = { folders: 1, documents: 1, docTexts: 1, reps: 9_999_999_999 };
    expect(errorsOf(raw)[0]).toContain('counts.reps: 9999999999 records is beyond the supported');
  });

  it('a count that disagrees with the array it describes', () => {
    const raw = resealed((r) => {
      (r.documents as unknown[]).pop();
    });
    expect(
      errorsOf(raw).some((e) => e.includes('counts.documents says 1 but the file contains 0')),
    ).toBe(true);
  });

  it('a corrupted payload, via the integrity checksum', () => {
    const raw = rawBackup();
    const docs = raw.documents as Array<Record<string, unknown>>;
    if (docs[0] !== undefined) docs[0].title = 'Macbeth';
    expect(errorsOf(raw)[0]).toContain('integrity: checksum mismatch');
  });

  it('a wrong field type deep inside a record, naming the path', () => {
    const raw = resealed((r) => {
      const docs = r.documents as Array<Record<string, unknown>>;
      const doc = docs[0];
      if (doc !== undefined) (doc.prefs as Record<string, unknown>).reshuffle = 'lots';
    });
    expect(errorsOf(raw)).toContain(
      'documents[0].prefs.reshuffle: expected a finite number, got string',
    );
  });

  it('a rep grade outside 1..4', () => {
    const raw = resealed((r) => {
      const reps = r.reps as Array<Record<string, unknown>>;
      if (reps[0] !== undefined) reps[0].grade = 7;
    });
    expect(errorsOf(raw)).toContain('reps[0].grade: expected 1, 2, 3 or 4, got 7');
  });

  it('an object-valued setting', () => {
    const raw = resealed((r) => {
      (r.settings as Record<string, unknown>)['ui.theme'] = { nested: true };
    });
    expect(errorsOf(raw)).toContain(
      'settings["ui.theme"]: expected a string, number or boolean, got object',
    );
  });

  it('duplicate record ids', () => {
    const raw = resealed((r) => {
      const reps = r.reps as unknown[];
      reps[1] = reps[0];
    });
    expect(errorsOf(raw)).toContain('reps[1]: duplicate id "rep-1"');
  });

  it('a performanceAt with no timezone (§11.9)', () => {
    const raw = resealed((r) => {
      const docs = r.documents as Array<Record<string, unknown>>;
      if (docs[0] !== undefined) docs[0].performanceTz = null;
    });
    expect(errorsOf(raw)[0]).toContain('performanceTz: required whenever performanceAt is set');
  });

  it('a createdAt that is not an ISO timestamp', () => {
    const raw = rawBackup();
    raw.createdAt = 1_700_000_000_000;
    expect(errorsOf(raw)).toContain('createdAt: expected a string, got number');
  });

  it('caps the error list instead of returning one line per bad record', () => {
    const documents = Array.from({ length: 200 }, (_, i) => makeDocument({ id: `doc-${i}` }));
    const raw = resealed((r) => {
      r.documents = documents.map((d) => ({ ...d, wordCount: 'many' }));
      r.counts = { folders: 1, documents: 200, docTexts: 1, reps: 2 };
    });
    const errors = errorsOf(raw);
    expect(errors).toHaveLength(51);
    expect(errors[50]).toBe('…and 150 more problems');
  });
});

describe('validateBackup accepts', () => {
  it('a file with no records at all', () => {
    const empty = buildBackup(
      { folders: [], documents: [], docTexts: [], reps: [], settings: {} },
      META,
    );
    const result = validateBackup(JSON.parse(JSON.stringify(empty)));
    expect(result.ok).toBe(true);
  });

  it('records that omit every optional field', () => {
    const doc = makeDocument({
      cursor: null,
      performanceAt: null,
      performanceTz: null,
      targetDurationSec: null,
      source: { type: 'paste', importedAt: 1 },
      roles: [],
      structureOverrides: [],
    });
    const bareText: BackupDocText = {
      docId: 'doc-1',
      sourceText: 'A short speech.',
      textHash: 'aabbccdd',
      updatedAt: 1_700_000_000_000,
    };
    const built = buildBackup(
      { folders: [], documents: [doc], docTexts: [bareText], reps: [], settings: {} },
      META,
    );
    const result = validateBackup(JSON.parse(JSON.stringify(built)));
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.backup.documents[0]?.cursor).toBeNull();
    expect(result.backup.docTexts[0]).not.toHaveProperty('sourceMeta');
  });

  it('an unknown method id, kind or mode — a file written by a later version', () => {
    const doc = makeDocument({
      kind: 'sermon',
      prefs: { ...makeDocument().prefs, methodId: 'snowball' },
    });
    const raw = resealed((r) => {
      r.documents = [doc];
      const reps = r.reps as Array<Record<string, unknown>>;
      if (reps[0] !== undefined) reps[0].mode = 'holographic';
    });
    const result = validateBackup(raw);
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.backup.documents[0]?.prefs.methodId).toBe('snowball');
  });

  it('a hand-edited file when the caller opts out of the checksum', () => {
    const raw = rawBackup();
    const docs = raw.documents as Array<Record<string, unknown>>;
    if (docs[0] !== undefined) docs[0].title = 'Macbeth';
    const result = validateBackup(raw, { ignoreIntegrity: true });
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.backup.documents[0]?.title).toBe('Macbeth');
    expect(result.warnings[0]).toContain('checksum mismatch ignored');
  });
});

describe('prototype pollution', () => {
  it('does not pollute Object.prototype via a __proto__ key in a document', () => {
    const json = JSON.stringify(
      resealed((r) => {
        const docs = r.documents as Array<Record<string, unknown>>;
        const doc = docs[0];
        if (doc !== undefined) withOwnKey(doc, '__proto__', { polluted: 'yes' });
      }),
    );
    // Re-parse from text: JSON.parse is what creates the own "__proto__" data property.
    const parsed: unknown = JSON.parse(json);
    const result = validateBackup(parsed);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.backup.documents[0]).not.toHaveProperty('polluted');
    expect(result.warnings.some((w) => w.includes('__proto__'))).toBe(true);
  });

  it('does not pollute Object.prototype via __proto__, constructor or prototype settings keys', () => {
    const json = JSON.stringify(
      resealed((r) => {
        const settings: Record<string, unknown> = {
          'ui.theme': 'dark',
          constructor: 'polluted',
          prototype: 'polluted',
        };
        r.settings = withOwnKey(settings, '__proto__', 'polluted');
      }),
    );
    const result = validateBackup(JSON.parse(json));
    if (!result.ok) throw new Error(result.errors.join('; '));

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(result.backup.settings)).toEqual(['ui.theme']);
    expect(Object.getPrototypeOf(result.backup.settings)).toBe(Object.prototype);
    expect({}.toString).toBeTypeOf('function');
  });
});
