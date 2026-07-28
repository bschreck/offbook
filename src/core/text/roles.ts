/**
 * Roles (speakers). PLAN.md §7.5 (ensemble names, alias merging, the speaker manager)
 * and §7.8 (role isolation reads `Role.id` off every block).
 *
 * Pure: role ids are derived from the normalised name, never generated, because
 * `myRoleIds` and `roleSetHash` are persisted and must survive a re-derive of the document.
 */

import { fnv1a, identityNormalize } from '../util/hash';
import type { Block, Line, Role } from './types';

/** Palette size in the renderer. Roles wrap round it. */
export const ROLE_COLOR_COUNT = 8;

/** §7.5 — selectable as a role and offered additively alongside the user's own role. */
const ENSEMBLE_NAMES = new Set([
  'all',
  'both',
  'everyone',
  'omnes',
  'chorus',
  'company',
  'ensemble',
  'crowd',
  'together',
]);

/** `(CONT'D)`, `(V.O.)`, `(O.S.)`, `(O.C.)` — part of the cue as written, not part of the name. */
const CUE_SUFFIX_RE = /\s*\((?:CONT'?D|CONTINUED|V\.?\s?O\.?|O\.?\s?S\.?|O\.?\s?C\.?|OFF)\)\s*$/iu;

export function stripCueSuffix(label: string): string {
  let out = label.trim();
  // A cue can carry more than one: `MARY (CONT'D) (V.O.)`.
  for (let i = 0; i < 3 && CUE_SUFFIX_RE.test(out); i++) out = out.replace(CUE_SUFFIX_RE, '');
  return out.trim();
}

/**
 * The display name for a chip in the role picker. Strips the cue colon but NOT a trailing
 * period, which may be an abbreviation marker (`HAM.`) rather than cue punctuation.
 */
export function displayRoleLabel(label: string): string {
  return stripCueSuffix(label).replace(/:+$/u, '').trim();
}

/** The recurrence / alias key. `HAMLET`, `Hamlet` and `Hamlet:` all collapse to `hamlet`. */
export function roleNameKey(label: string): string {
  return identityNormalize(stripCueSuffix(label).replace(/[:.]+$/u, ''));
}

/** Deterministic, stable across re-derives — see the module note. */
export function roleIdFor(label: string): string {
  return `role_${fnv1a(roleNameKey(label))}`;
}

export function isEnsembleName(label: string): boolean {
  return ENSEMBLE_NAMES.has(roleNameKey(label));
}

function countWords(text: string): number {
  const t = text.trim();
  if (t === '') return 0;
  return t.split(/\s+/u).length;
}

interface Agg {
  key: string;
  labelCounts: Map<string, number>;
  /** A Folio abbreviation signal: the cue was written `Ham.`, not `Ham`. */
  abbreviated: boolean;
  lineCount: number;
  wordCount: number;
  firstLineIndex: number;
  isEnsemble: boolean;
}

/** Line types whose words are the speaker's own. Cue labels and directions are not. */
const SPOKEN_TYPES = new Set(['dialogue', 'verse', 'paragraph']);

function aggregate(blocks: readonly Block[], lines: readonly Line[]): Map<string, Agg> {
  const byIdx = new Map<number, Line>();
  for (const line of lines) byIdx.set(line.idx, line);

  const aggs = new Map<string, Agg>();
  for (const block of blocks) {
    const id = block.speakerId;
    const label = block.speakerLabel ?? '';
    if (id === null) continue;
    const key = roleNameKey(label);
    let agg = aggs.get(id);
    if (!agg) {
      agg = {
        key,
        labelCounts: new Map(),
        abbreviated: false,
        lineCount: 0,
        wordCount: 0,
        firstLineIndex: Number.MAX_SAFE_INTEGER,
        isEnsemble: isEnsembleName(label),
      };
      aggs.set(id, agg);
    }
    if (label !== '') {
      agg.labelCounts.set(label, (agg.labelCounts.get(label) ?? 0) + 1);
      if (/\.$/u.test(stripCueSuffix(label))) agg.abbreviated = true;
    }
    for (const lineIdx of block.lineIdxs) {
      const line = byIdx.get(lineIdx);
      if (!line) continue;
      if (lineIdx < agg.firstLineIndex) agg.firstLineIndex = lineIdx;
      if (!SPOKEN_TYPES.has(block.type)) continue;
      agg.lineCount += 1;
      // The cue prefix (`MARY: `) is part of the line text but is not spoken words.
      const spoken =
        block.speakerLabel !== null && line.text.startsWith(block.speakerLabel)
          ? line.text.slice(block.speakerLabel.length)
          : line.text;
      agg.wordCount += countWords(spoken);
    }
  }
  return aggs;
}

/**
 * §7.5 — `HAM.` is folded into `HAMLET`, but `JIM` is never folded into `TIM`.
 * Only an explicitly abbreviated cue (written with a trailing dot) is a merge candidate,
 * and only when exactly one longer name extends it, so `MAR.` next to MARY and MARIA stays put.
 */
function abbreviationTargets(aggs: Map<string, Agg>): Map<string, string> {
  const merged = new Map<string, string>();
  for (const [id, agg] of aggs) {
    if (!agg.abbreviated || agg.isEnsemble || agg.key.length < 3) continue;
    let target: string | null = null;
    let hits = 0;
    for (const [otherId, other] of aggs) {
      if (otherId === id || other.isEnsemble) continue;
      if (other.key.length > agg.key.length && other.key.startsWith(agg.key)) {
        target = otherId;
        hits += 1;
      }
    }
    if (hits === 1 && target !== null) merged.set(id, target);
  }
  // Resolve short chains (HAM -> HAMLE -> HAMLET) without looping on a cycle.
  for (const [id] of merged) {
    let dest = merged.get(id);
    for (let i = 0; i < 4 && dest !== undefined; i++) {
      const next = merged.get(dest);
      if (next === undefined || next === id) break;
      dest = next;
    }
    if (dest !== undefined && dest !== id) merged.set(id, dest);
  }
  return merged;
}

/**
 * The role's display name. An undecorated cue always beats a decorated one, so a speaker
 * is never called `MARY (CONT'D)`; after that, frequency, then length.
 */
function pickLabel(labelCounts: Map<string, number>): string {
  let best = '';
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [label, count] of labelCounts) {
    const undecorated = stripCueSuffix(label) === label ? 1 : 0;
    const score = undecorated * 1e6 + count * 1e3 + label.length;
    if (score > bestScore) {
      best = label;
      bestScore = score;
    }
  }
  return best;
}

export function buildRoles(blocks: readonly Block[], lines: readonly Line[]): Role[] {
  const aggs = aggregate(blocks, lines);
  const targets = abbreviationTargets(aggs);

  const groups = new Map<string, Agg[]>();
  for (const [id, agg] of aggs) {
    const canonical = targets.get(id) ?? id;
    const bucket = groups.get(canonical);
    if (bucket) bucket.push(agg);
    else groups.set(canonical, [agg]);
  }

  const roles: Role[] = [];
  for (const [id, members] of groups) {
    const labelCounts = new Map<string, number>();
    let lineCount = 0;
    let wordCount = 0;
    let firstLineIndex = Number.MAX_SAFE_INTEGER;
    let isEnsemble = false;
    for (const m of members) {
      for (const [label, count] of m.labelCounts) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + count);
      }
      lineCount += m.lineCount;
      wordCount += m.wordCount;
      firstLineIndex = Math.min(firstLineIndex, m.firstLineIndex);
      isEnsemble = isEnsemble || m.isEnsemble;
    }
    // The canonical member's own label wins ties, so `HAMLET` beats `HAM.`.
    const canonical = aggs.get(id);
    const raw = canonical ? pickLabel(canonical.labelCounts) : pickLabel(labelCounts);
    // `Role.label` is a display name — it goes on a chip in the role picker, where a
    // trailing cue colon reads as a typo. The cue punctuation stays on `Block.speakerLabel`,
    // which is what the reader renders above a speech.
    const label = displayRoleLabel(raw);
    roles.push({
      id,
      label,
      aliases: [...labelCounts.keys()].sort(),
      colorIndex: 0,
      isEnsemble,
      lineCount,
      wordCount,
      firstLineIndex: firstLineIndex === Number.MAX_SAFE_INTEGER ? -1 : firstLineIndex,
    });
  }

  roles.sort((a, b) => a.firstLineIndex - b.firstLineIndex || a.label.localeCompare(b.label));
  return roles.map((role, i) => ({ ...role, colorIndex: i % ROLE_COLOR_COUNT }));
}

/**
 * Speaker manager: fold `mergeIds` into `keepId`. Unknown ids are ignored rather than
 * throwing — the manager can race a re-derive that dropped a role.
 */
export function mergeRoles(
  roles: readonly Role[],
  keepId: string,
  mergeIds: readonly string[],
): Role[] {
  const keep = roles.find((r) => r.id === keepId);
  if (!keep) return roles.map((r) => ({ ...r }));

  const absorb = new Set(mergeIds.filter((id) => id !== keepId));
  const absorbed = roles.filter((r) => absorb.has(r.id));
  if (absorbed.length === 0) return roles.map((r) => ({ ...r }));

  const aliases = new Set(keep.aliases);
  let lineCount = keep.lineCount;
  let wordCount = keep.wordCount;
  let firstLineIndex = keep.firstLineIndex;
  let isEnsemble = keep.isEnsemble;
  for (const role of absorbed) {
    for (const alias of role.aliases) aliases.add(alias);
    aliases.add(role.label);
    lineCount += role.lineCount;
    wordCount += role.wordCount;
    if (role.firstLineIndex >= 0 && (firstLineIndex < 0 || role.firstLineIndex < firstLineIndex)) {
      firstLineIndex = role.firstLineIndex;
    }
    isEnsemble = isEnsemble || role.isEnsemble;
  }

  return roles
    .filter((r) => !absorb.has(r.id))
    .map((r) =>
      r.id === keepId
        ? {
            ...r,
            aliases: [...aliases].sort(),
            lineCount,
            wordCount,
            firstLineIndex,
            isEnsemble,
          }
        : { ...r },
    );
}
