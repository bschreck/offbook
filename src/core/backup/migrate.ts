/**
 * Reading older backup files. PLAN.md §11.8: hand-written validation "doubles as the
 * version-migration seam".
 *
 * The shape of this module is the point. `validateBackup` only ever parses ONE shape —
 * the current one — and everything older is lifted to that shape here first, one version
 * at a time. Adding format v2 is then: bump CURRENT_FORMAT_VERSION in types.ts, write
 * `1 -> 2` below, done. No second parser, no version branches sprinkled through
 * validate.ts, and the v1 reader never has to keep working on v2 data.
 *
 * Steps operate on raw parsed JSON (`unknown`), not on typed records, because a v1 file
 * cannot be typed as a v2 record by definition. They must be total and side-effect free:
 * given anything at all, return something (validation catches what they produce).
 */

import { APP_NAME } from '../../brand';
import { CURRENT_FORMAT_VERSION, MIN_READABLE_FORMAT_VERSION } from './types';
import { checkFormat, type ValidateOptions, type ValidateResult, validateBackup } from './validate';

export type MigrateResult =
  | (Extract<ValidateResult, { ok: true }> & { fromVersion: number; steps: string[] })
  | { ok: false; errors: string[] };

/** `from` is the version the step consumes; it produces `from + 1`. */
type MigrationStep = { from: number; describe: string; apply: (raw: unknown) => unknown };

/**
 * Empty on purpose. v1 is the only format that has ever existed, so there is nothing to
 * upgrade from — the loop below runs zero times and `migrateBackup` is exactly
 * `validateBackup` for a v1 file. This is the documented no-op, not an oversight.
 */
const STEPS: readonly MigrationStep[] = [];

export function migrateBackup(raw: unknown, options: ValidateOptions = {}): MigrateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const got = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
    return {
      ok: false,
      errors: [`not an ${APP_NAME} backup (expected a JSON object, got ${got})`],
    };
  }

  const version = readFormatVersion(raw as Record<string, unknown>);
  if (typeof version !== 'number') return { ok: false, errors: [version] };

  let current: unknown = raw;
  const steps: string[] = [];
  for (let v = version; v < CURRENT_FORMAT_VERSION; v++) {
    const step = STEPS.find((s) => s.from === v);
    if (step === undefined) {
      return {
        ok: false,
        errors: [
          `this backup uses format version ${version} and there is no upgrade path from ` +
            `version ${v} to ${v + 1}`,
        ],
      };
    }
    current = step.apply(current);
    steps.push(step.describe);
  }

  const result = validateBackup(current, options);
  if (!result.ok) {
    return version === CURRENT_FORMAT_VERSION
      ? result
      : {
          ok: false,
          errors: [`after upgrading from format version ${version}:`, ...result.errors],
        };
  }
  return { ...result, fromVersion: version, steps };
}

/**
 * The version, or a ready-to-show error string. Deliberately shallow: we must read the
 * header of a file we cannot yet parse, which is the whole reason migration comes first.
 */
function readFormatVersion(root: Record<string, unknown>): number | string {
  const headerError = checkFormat(root);
  const version = root.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    // checkFormat has already phrased this (missing marker, wrong format, bad version).
    return headerError ?? 'backup is missing "formatVersion"';
  }
  if (version > CURRENT_FORMAT_VERSION || version < MIN_READABLE_FORMAT_VERSION) {
    return headerError ?? `unsupported format version ${version}`;
  }
  // An older-but-supported version fails checkFormat ("must be upgraded") — that is this
  // function's job, so the error is expected here and only the version matters.
  if (headerError !== null && version === CURRENT_FORMAT_VERSION) return headerError;
  return version;
}
