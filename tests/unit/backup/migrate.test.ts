import { describe, expect, it } from 'vitest';
import { buildBackup } from '../../../src/core/backup/export';
import { migrateBackup } from '../../../src/core/backup/migrate';
import { CURRENT_FORMAT_VERSION } from '../../../src/core/backup/types';
import { META, makeInput } from './fixtures';

function rawBackup(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(buildBackup(makeInput(), META))) as Record<string, unknown>;
}

describe('migrateBackup', () => {
  it('passes a current-version file straight through, running no steps', () => {
    const result = migrateBackup(rawBackup());
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.fromVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(result.steps).toEqual([]);
    expect(result.backup.documents[0]?.id).toBe('doc-1');
  });

  it('refuses a version from the future', () => {
    const raw = rawBackup();
    raw.formatVersion = 99;
    const result = migrateBackup(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('newer version of Offbook');
  });

  it('refuses a version older than anything we can read', () => {
    const raw = rawBackup();
    raw.formatVersion = 0;
    const result = migrateBackup(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('can no longer read');
  });

  it('refuses a file that is not a backup at all', () => {
    for (const input of [null, [], 'x', 42, {}, { format: 'other' }]) {
      const result = migrateBackup(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]).toContain('Offbook backup');
    }
  });

  it('reports validation problems from the migrated file', () => {
    const raw = rawBackup();
    raw.documents = 'nope';
    const result = migrateBackup(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes('documents: expected an array'))).toBe(true);
  });

  it('forwards validate options', () => {
    const raw = rawBackup();
    const docs = raw.documents as Array<Record<string, unknown>>;
    if (docs[0] !== undefined) docs[0].title = 'edited by hand';
    expect(migrateBackup(raw).ok).toBe(false);
    expect(migrateBackup(raw, { ignoreIntegrity: true }).ok).toBe(true);
  });
});
