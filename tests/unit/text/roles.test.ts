import { describe, expect, it } from 'vitest';
import {
  buildRoles,
  isEnsembleName,
  mergeRoles,
  ROLE_COLOR_COUNT,
  roleIdFor,
  roleNameKey,
  stripCueSuffix,
} from '../../../src/core/text/roles';
import { detectStructure } from '../../../src/core/text/structure';
import type { Block, BlockType, Line, Role } from '../../../src/core/text/types';

/** Builds a (line, block) pair per entry so buildRoles can be exercised directly. */
function build(entries: readonly { type: BlockType; label: string | null; text: string }[]): {
  blocks: Block[];
  lines: Line[];
} {
  const blocks: Block[] = [];
  const lines: Line[] = [];
  entries.forEach((entry, i) => {
    lines.push({
      idx: i,
      blockIdx: i,
      text: entry.text,
      tokens: [],
      fingerprint: `0000000${i % 10}:0`,
      indentEm: 0,
    });
    blocks.push({
      idx: i,
      type: entry.type,
      speakerId: entry.label === null ? null : roleIdFor(entry.label),
      speakerLabel: entry.label,
      lineIdxs: [i],
      confidence: 0.9,
    });
  });
  return { blocks, lines };
}

describe('name normalisation', () => {
  it('strips cue suffixes and trailing punctuation', () => {
    expect(stripCueSuffix("MARY (CONT'D)")).toBe('MARY');
    expect(stripCueSuffix('JOHN (V.O.)')).toBe('JOHN');
    expect(stripCueSuffix("MARY (CONT'D) (O.S.)")).toBe('MARY');
    expect(roleNameKey('Hamlet:')).toBe('hamlet');
    expect(roleNameKey('HAM.')).toBe('ham');
  });

  it('derives the same id for the same name regardless of casing or decoration', () => {
    expect(roleIdFor('HAMLET')).toBe(roleIdFor('Hamlet:'));
    expect(roleIdFor("MARY (CONT'D)")).toBe(roleIdFor('mary'));
    expect(roleIdFor('MARY')).not.toBe(roleIdFor('MARIA'));
  });

  it('recognises ensemble names', () => {
    expect(isEnsembleName('ALL')).toBe(true);
    expect(isEnsembleName('Chorus:')).toBe(true);
    expect(isEnsembleName('MARY')).toBe(false);
  });
});

describe('buildRoles', () => {
  it('counts lines and words and records first appearance', () => {
    const { blocks, lines } = build([
      { type: 'label', label: 'MARY', text: 'MARY' },
      { type: 'dialogue', label: 'MARY', text: 'You are late again my friend' },
      { type: 'direction', label: 'MARY', text: '(softly)' },
      { type: 'label', label: 'JOHN', text: 'JOHN' },
      { type: 'dialogue', label: 'JOHN', text: 'The train was held' },
    ]);
    const roles = buildRoles(blocks, lines);

    expect(roles.map((r) => r.label)).toEqual(['MARY', 'JOHN']);
    const mary = roles[0] as Role;
    // The cue label line and the parenthetical are not spoken words.
    expect(mary.lineCount).toBe(1);
    expect(mary.wordCount).toBe(6);
    expect(mary.firstLineIndex).toBe(0);
    expect(roles[1]?.firstLineIndex).toBe(3);
  });

  it('excludes the NAME: prefix from the word count', () => {
    const { blocks, lines } = build([
      { type: 'dialogue', label: 'MARY:', text: 'MARY: You are late' },
      { type: 'dialogue', label: 'MARY:', text: 'MARY: Again' },
    ]);
    const roles = buildRoles(blocks, lines);
    expect(roles[0]?.wordCount).toBe(4);
    expect(roles[0]?.lineCount).toBe(2);
  });

  it('merges HAMLET / Hamlet / HAM. into one role', () => {
    const { blocks, lines } = build([
      { type: 'dialogue', label: 'HAMLET', text: 'To be or not to be' },
      { type: 'dialogue', label: 'Hamlet', text: 'That is the question' },
      { type: 'dialogue', label: 'HAM.', text: 'HAM. Let her come' },
      { type: 'dialogue', label: 'HORATIO', text: 'My lord' },
    ]);
    const roles = buildRoles(blocks, lines);

    expect(roles).toHaveLength(2);
    const hamlet = roles.find((r) => r.aliases.includes('HAMLET')) as Role;
    expect(hamlet.aliases.sort()).toEqual(['HAM.', 'HAMLET', 'Hamlet']);
    expect(hamlet.lineCount).toBe(3);
    expect(roles.find((r) => r.label === 'HORATIO')?.lineCount).toBe(1);
  });

  it('never merges JIM into TIM, and never merges an ambiguous abbreviation', () => {
    const jimTim = build([
      { type: 'dialogue', label: 'JIM.', text: 'JIM. Hello' },
      { type: 'dialogue', label: 'TIM.', text: 'TIM. Goodbye' },
    ]);
    expect(buildRoles(jimTim.blocks, jimTim.lines)).toHaveLength(2);

    const ambiguous = build([
      { type: 'dialogue', label: 'MAR.', text: 'MAR. Hello' },
      { type: 'dialogue', label: 'MARY', text: 'Hello back' },
      { type: 'dialogue', label: 'MARIA', text: 'And hello from me' },
    ]);
    expect(buildRoles(ambiguous.blocks, ambiguous.lines)).toHaveLength(3);
  });

  it('does not merge an abbreviation that was never written with a dot', () => {
    const { blocks, lines } = build([
      { type: 'dialogue', label: 'HAM', text: 'One' },
      { type: 'dialogue', label: 'HAMLET', text: 'Two' },
    ]);
    expect(buildRoles(blocks, lines)).toHaveLength(2);
  });

  it('flags ensemble roles and wraps colour indices', () => {
    const entries = Array.from({ length: ROLE_COLOR_COUNT + 2 }, (_, i) => ({
      type: 'dialogue' as const,
      label: `SPEAKER${i}`,
      text: `Line ${i}`,
    }));
    entries.push({ type: 'dialogue', label: 'ALL', text: 'Together now' });
    const { blocks, lines } = build(entries);
    const roles = buildRoles(blocks, lines);

    expect(roles.map((r) => r.colorIndex).slice(0, ROLE_COLOR_COUNT + 1)).toEqual([
      ...Array.from({ length: ROLE_COLOR_COUNT }, (_, i) => i),
      0,
    ]);
    expect(roles.find((r) => r.label === 'ALL')?.isEnsemble).toBe(true);
    expect(roles.find((r) => r.label === 'SPEAKER0')?.isEnsemble).toBe(false);
  });

  it('ignores blocks with no speaker', () => {
    const { blocks, lines } = build([
      { type: 'heading', label: null, text: 'ACT ONE' },
      { type: 'paragraph', label: null, text: 'Mary enters.' },
    ]);
    expect(buildRoles(blocks, lines)).toEqual([]);
  });
});

describe('buildRoles over a detected document', () => {
  it('agrees with the structure pass', () => {
    const r = detectStructure(
      'MARY: You are late again.\nJOHN: The train was held.\nMARY: It always is.'
        .split('\n')
        .map((text) => ({ text })),
      { hasGeometry: false, kind: 'script' },
    );
    const roles = buildRoles(r.blocks, r.lines);
    expect(roles.map((role) => role.label)).toEqual(r.roles.map((role) => role.label));
    // Role.label is the display name, so the cue colon is gone; Block.speakerLabel keeps it.
    expect(roles.find((role) => role.label === 'MARY')?.lineCount).toBe(2);
  });
});

describe('mergeRoles', () => {
  const roles: Role[] = [
    {
      id: 'a',
      label: 'MARY',
      aliases: ['MARY'],
      colorIndex: 0,
      isEnsemble: false,
      lineCount: 17,
      wordCount: 120,
      firstLineIndex: 4,
    },
    {
      id: 'b',
      label: 'Mary',
      aliases: ['Mary'],
      colorIndex: 1,
      isEnsemble: false,
      lineCount: 3,
      wordCount: 20,
      firstLineIndex: 1,
    },
    {
      id: 'c',
      label: 'JOHN',
      aliases: ['JOHN'],
      colorIndex: 2,
      isEnsemble: false,
      lineCount: 5,
      wordCount: 40,
      firstLineIndex: 9,
    },
  ];

  it('folds the merged roles into the kept one', () => {
    const merged = mergeRoles(roles, 'a', ['b']);
    expect(merged.map((r) => r.id)).toEqual(['a', 'c']);
    const mary = merged[0] as Role;
    expect(mary.label).toBe('MARY');
    expect(mary.aliases).toEqual(['MARY', 'Mary']);
    expect(mary.lineCount).toBe(20);
    expect(mary.wordCount).toBe(140);
    expect(mary.firstLineIndex).toBe(1);
  });

  it('keeps ensemble-ness if any merged role was an ensemble', () => {
    const withEnsemble: Role[] = [
      ...roles,
      {
        id: 'd',
        label: 'ALL',
        aliases: ['ALL'],
        colorIndex: 3,
        isEnsemble: true,
        lineCount: 2,
        wordCount: 8,
        firstLineIndex: 12,
      },
    ];
    expect(mergeRoles(withEnsemble, 'a', ['d'])[0]?.isEnsemble).toBe(true);
  });

  it('is a no-op for an unknown keep id, an empty merge list, or self-merge', () => {
    expect(mergeRoles(roles, 'zzz', ['b'])).toEqual(roles);
    expect(mergeRoles(roles, 'a', [])).toEqual(roles);
    expect(mergeRoles(roles, 'a', ['a'])).toEqual(roles);
  });

  it('does not mutate its input', () => {
    const snapshot = JSON.stringify(roles);
    mergeRoles(roles, 'a', ['b', 'c']);
    expect(JSON.stringify(roles)).toBe(snapshot);
  });
});
