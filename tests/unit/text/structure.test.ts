import { describe, expect, it } from 'vitest';
import { applyStructureOverrides, overridesForApplyToAll } from '../../../src/core/text/overrides';
import {
  CUE_CONFIDENCE_FLOOR,
  detectStructure,
  type StructureInputLine,
} from '../../../src/core/text/structure';
import type { Block, Line } from '../../../src/core/text/types';

type Result = ReturnType<typeof detectStructure>;

function fromText(text: string): StructureInputLine[] {
  return text.split('\n').map((line) => ({ text: line }));
}

function blockOf(result: Result, lineText: string): Block {
  const line = result.lines.find((l) => l.text === lineText);
  if (!line) throw new Error(`no line ${JSON.stringify(lineText)}`);
  const block = result.blocks[line.blockIdx];
  if (!block) throw new Error(`line ${lineText} has no block`);
  return block;
}

function lineOf(result: Result, lineText: string): Line {
  const line = result.lines.find((l) => l.text === lineText);
  if (!line) throw new Error(`no line ${JSON.stringify(lineText)}`);
  return line;
}

function labelFor(result: Result, block: Block): string | null {
  if (block.speakerId === null) return null;
  return result.roles.find((r) => r.id === block.speakerId)?.label ?? null;
}

// ------------------------------------------------------------------ fixtures

/** `NAME:` format — stage play / transcript / lyrics annotation. */
const COLON_SCRIPT = `MARY: You are late again.
JOHN: The train was held at the bridge.
MARY: It always is.
JOHN: Not always.`;

/** `NAME.` format — Shakespeare in an Arden/Penguin setting. */
const DOT_SCRIPT = `Ham. To be, or not to be, that is the question.
Hor. My lord, the queen approaches.
Ham. Let her come, then.
Hor. She is already here.`;

/** Hollywood centred-cue format, with harvested geometry. */
const HOLLYWOOD: StructureInputLine[] = [
  { text: 'INT. KITCHEN — DAY', indentPt: 108 },
  { text: '' },
  { text: 'Mary stands at the sink.', indentPt: 108 },
  { text: '' },
  { text: 'MARY', indentPt: 266 },
  { text: 'You are late again.', indentPt: 180 },
  { text: '' },
  { text: 'JOHN', indentPt: 266 },
  { text: '(quietly)', indentPt: 216 },
  { text: 'The train was held at the bridge.', indentPt: 180 },
  { text: '' },
  { text: "MARY (CONT'D)", indentPt: 266 },
  { text: 'It always is.', indentPt: 180 },
  { text: '' },
  { text: 'JOHN', indentPt: 266 },
  { text: 'Not always.', indentPt: 180 },
  { text: '' },
  { text: 'CUT TO:', indentPt: 400 },
];

// ------------------------------------------------------------------ tests

describe('detectStructure — cue formats', () => {
  it('detects NAME: cues and attributes each line', () => {
    const r = detectStructure(fromText(COLON_SCRIPT), { hasGeometry: false, kind: 'script' });

    expect(r.lines).toHaveLength(4);
    expect(r.roles.map((role) => role.label)).toEqual(['MARY', 'JOHN']);
    // The cue punctuation survives where it is actually rendered, above the speech.
    expect(r.blocks.map((b) => b.speakerLabel).filter(Boolean)).toContain('MARY:');
    for (const line of r.lines) {
      const block = r.blocks[line.blockIdx];
      expect(block?.type).toBe('dialogue');
      expect(block?.speakerId).not.toBeNull();
      expect(block?.confidence).toBeGreaterThanOrEqual(CUE_CONFIDENCE_FLOOR);
    }
    expect(labelFor(r, blockOf(r, 'MARY: It always is.'))).toBe('MARY');
  });

  it('detects NAME. cues (Shakespeare) and keeps the dot in the label', () => {
    const r = detectStructure(fromText(DOT_SCRIPT), { hasGeometry: false, kind: 'script' });

    expect(r.roles.map((role) => role.label).sort()).toEqual(['Ham.', 'Hor.']);
    expect(blockOf(r, 'Ham. Let her come, then.').type).toBe('dialogue');
    expect(labelFor(r, blockOf(r, 'Hor. She is already here.'))).toBe('Hor.');
  });

  it('does not treat ordinary prose sentences as NAME. cues', () => {
    const prose = `Well. I told you that already.
Nothing else happened that evening.
Well. I told you that already.`;
    const r = detectStructure(fromText(prose), { hasGeometry: false, kind: 'speech' });
    expect(r.roles).toHaveLength(0);
  });

  it('detects Hollywood centred cues, parentheticals and transitions', () => {
    const r = detectStructure(HOLLYWOOD, { hasGeometry: true, kind: 'script' });

    expect(blockOf(r, 'INT. KITCHEN — DAY').type).toBe('heading');
    expect(blockOf(r, 'Mary stands at the sink.').type).toBe('paragraph');
    expect(blockOf(r, 'MARY').type).toBe('label');
    expect(blockOf(r, 'You are late again.').type).toBe('dialogue');
    expect(blockOf(r, '(quietly)').type).toBe('direction');
    expect(blockOf(r, 'CUT TO:').type).toBe('heading');

    // (CONT'D) is part of the cue as written but not part of the name.
    expect(labelFor(r, blockOf(r, 'It always is.'))).toBe('MARY');
    expect(r.roles.map((role) => role.label)).toEqual(['MARY', 'JOHN']);
  });

  it('keeps the parenthetical attached to the speaker it interrupts', () => {
    const r = detectStructure(HOLLYWOOD, { hasGeometry: true, kind: 'script' });
    const paren = blockOf(r, '(quietly)');
    expect(labelFor(r, paren)).toBe('JOHN');
    // …but a direction is never the speaker's spoken text.
    const john = r.roles.find((role) => role.label === 'JOHN');
    expect(john?.lineCount).toBe(2);
  });
});

describe('detectStructure — the recurrence guard', () => {
  it('a one-off ALL-CAPS line does not become a speaker, a recurring one does', () => {
    const text = `MARY
The door is stuck again.

A SUDDEN CRASH

MARY
What was that?`;
    const r = detectStructure(fromText(text), { hasGeometry: false, kind: 'script' });

    expect(r.roles.map((role) => role.label)).toEqual(['MARY']);
    expect(blockOf(r, 'A SUDDEN CRASH').speakerId).toBeNull();
    expect(blockOf(r, 'A SUDDEN CRASH').type).not.toBe('label');
    expect(blockOf(r, 'MARY').type).toBe('label');
    expect(labelFor(r, blockOf(r, 'What was that?'))).toBe('MARY');
  });

  it('a titled collection (>8 singleton ALL-CAPS lines) yields no speakers at all', () => {
    const titles = [
      'THE ROAD NOT TAKEN',
      'FIRE AND ICE',
      'BIRCHES',
      'MENDING WALL',
      'DESERT PLACES',
      'THE PASTURE',
      'A PATCH OF OLD SNOW',
      'THE SOUND OF TREES',
      'SPRING POOLS',
      'DUST OF SNOW',
    ];
    const lines = titles.flatMap((t) => [t, 'A short line of verse follows it.', '']);
    const r = detectStructure(fromText(lines.join('\n')), { hasGeometry: false, kind: 'poem' });

    expect(r.roles).toHaveLength(0);
    for (const title of titles) expect(blockOf(r, title).type).toBe('heading');
  });

  it('a verse with an ALL-CAPS title keeps the title as a heading', () => {
    const poem = `THE ROAD NOT TAKEN

Two roads diverged in a yellow wood,
  And sorry I could not travel both
  And be one traveler, long I stood
    And looked down one as far as I could`;
    const r = detectStructure(fromText(poem), { hasGeometry: false, kind: 'poem' });

    expect(blockOf(r, 'THE ROAD NOT TAKEN').type).toBe('heading');
    expect(r.roles).toHaveLength(0);
    expect(blockOf(r, 'Two roads diverged in a yellow wood,').type).toBe('verse');
  });
});

describe('detectStructure — MOTHER', () => {
  const text = `MOTHER
You can't stay in this house forever.

SON
Don't you dare say that to me, MOTHER!
MOTHER!
Come back here and look at me.

MOTHER
Then go.

SON
I am going.`;

  it('MOTHER is a speaker, and MOTHER shouted inside dialogue is not', () => {
    const r = detectStructure(fromText(text), { hasGeometry: false, kind: 'script' });

    expect(r.roles.map((role) => role.label).sort()).toEqual(['MOTHER', 'SON']);

    const shouted = blockOf(r, "Don't you dare say that to me, MOTHER!");
    expect(shouted.type).toBe('dialogue');
    expect(labelFor(r, shouted)).toBe('SON');
  });

  it('a bare MOTHER! mid-speech does not steal the speech', () => {
    const r = detectStructure(fromText(text), { hasGeometry: false, kind: 'script' });
    const shout = blockOf(r, 'MOTHER!');
    expect(shout.type).toBe('dialogue');
    expect(labelFor(r, shout)).toBe('SON');
    expect(labelFor(r, blockOf(r, 'Come back here and look at me.'))).toBe('SON');
  });
});

describe('detectStructure — headings are never speakers', () => {
  const text = `ACT ONE

SCENE III

INT. KITCHEN — DAY

MARY
You are late.

MARY
Again.`;

  it('ACT ONE, SCENE III and INT. KITCHEN — DAY are headings', () => {
    const r = detectStructure(fromText(text), { hasGeometry: false, kind: 'script' });
    for (const heading of ['ACT ONE', 'SCENE III', 'INT. KITCHEN — DAY']) {
      const block = blockOf(r, heading);
      expect(block.type).toBe('heading');
      expect(block.speakerId).toBeNull();
    }
    expect(r.roles.map((role) => role.label)).toEqual(['MARY']);
  });

  it('a dialogue line that merely starts with "Act one" is not a heading', () => {
    const r = detectStructure(fromText('Act one moment of kindness and everything changes.'), {
      hasGeometry: false,
      kind: 'speech',
    });
    expect(r.blocks[0]?.type).toBe('paragraph');
  });
});

describe('detectStructure — verse indentation (§7.6)', () => {
  it('quantises leading whitespace into 0/1/2/3 em buckets', () => {
    const poem = `Flat against the margin,
  one step in,
    two steps in,
\t\t\t\tfour steps in.`;
    const r = detectStructure(fromText(poem), { hasGeometry: false, kind: 'poem' });
    expect(r.lines.map((l) => l.indentEm)).toEqual([0, 1, 2, 3]);
    // The indent lives in indentEm, not in the text the tokenizer will see.
    expect(r.lines[1]?.text).toBe('one step in,');
  });

  it('derives buckets from harvested geometry when it is available', () => {
    const r = detectStructure(HOLLYWOOD, { hasGeometry: true, kind: 'script' });
    expect(lineOf(r, 'Mary stands at the sink.').indentEm).toBe(0);
    expect(lineOf(r, 'You are late again.').indentEm).toBe(2);
    expect(lineOf(r, 'MARY').indentEm).toBe(3);
  });
});

describe('detectStructure — lyrics', () => {
  it('keeps the section label, drops the artist, and records the artist as a speaker', () => {
    const lyrics = `[Verse 1: MARY]
I walked out in the morning air

[Verse 2: JOHN]
And I was waiting by the door`;
    const r = detectStructure(fromText(lyrics), { hasGeometry: false, kind: 'lyrics' });

    expect(blockOf(r, '[Verse 1: MARY]').type).toBe('heading');
    expect(labelFor(r, blockOf(r, 'I walked out in the morning air'))).toBe('MARY');
    expect(labelFor(r, blockOf(r, 'And I was waiting by the door'))).toBe('JOHN');
  });

  it('treats a bare [Chorus] label as a heading, not a speaker', () => {
    const lyrics = `[Chorus]
Sing it out loud

[Chorus]
Sing it out loud`;
    const r = detectStructure(fromText(lyrics), { hasGeometry: false, kind: 'lyrics' });
    expect(blockOf(r, '[Chorus]').type).toBe('heading');
    expect(r.roles).toHaveLength(0);
  });
});

describe('detectStructure — invariants', () => {
  it('every line belongs to exactly one block and tokens are left for stage 5', () => {
    const r = detectStructure(HOLLYWOOD, { hasGeometry: true, kind: 'script' });
    const covered = new Set<number>();
    for (const block of r.blocks) {
      expect(block.idx).toBe(r.blocks.indexOf(block));
      for (const lineIdx of block.lineIdxs) {
        expect(covered.has(lineIdx)).toBe(false);
        covered.add(lineIdx);
        expect(r.lines[lineIdx]?.blockIdx).toBe(block.idx);
      }
    }
    expect(covered.size).toBe(r.lines.length);
    for (const line of r.lines) {
      expect(line.tokens).toEqual([]);
      expect(line.fingerprint).toMatch(/^[0-9a-f]{8}:\d+$/);
    }
  });

  it('gives repeated identical lines distinct fingerprints', () => {
    const r = detectStructure(fromText('Sing it out\nSing it out\nSing it out'), {
      hasGeometry: false,
      kind: 'lyrics',
    });
    const prints = r.lines.map((l) => l.fingerprint);
    expect(new Set(prints).size).toBe(3);
    expect(prints[0]?.split(':')[0]).toBe(prints[2]?.split(':')[0]);
  });

  it('handles an empty document', () => {
    const r = detectStructure([], { hasGeometry: false });
    expect(r).toEqual({ blocks: [], lines: [], roles: [] });
  });
});

describe('applyStructureOverrides', () => {
  const base = `MARY
The door is stuck again.
Someone should fix it.

MARY
What was that?`;

  it('is anchored by fingerprint, so it survives an edit elsewhere', () => {
    const before = detectStructure(fromText(base), { hasGeometry: false, kind: 'script' });
    const fingerprint = lineOf(before, 'Someone should fix it.').fingerprint;
    const overrides = [{ kind: 'lineType' as const, fingerprint, type: 'direction' as const }];

    // The same override, applied to a document with an extra line inserted at the top.
    const after = detectStructure(fromText(`A NEW OPENING LINE\n\n${base}`), {
      hasGeometry: false,
      kind: 'script',
    });
    const applied = applyStructureOverrides(after.blocks, after.lines, overrides);
    const line = applied.lines.find((l) => l.text === 'Someone should fix it.');
    expect(line).toBeDefined();
    expect(applied.blocks[line?.blockIdx ?? -1]?.type).toBe('direction');
  });

  it('splits a block and marks the touched block as user-confirmed', () => {
    const r = detectStructure(fromText(base), { hasGeometry: false, kind: 'script' });
    const fingerprint = lineOf(r, 'Someone should fix it.').fingerprint;
    const applied = applyStructureOverrides(r.blocks, r.lines, [
      { kind: 'lineType', fingerprint, type: 'direction' },
    ]);

    const touched = applied.blocks.find((b) => b.type === 'direction');
    expect(touched?.lineIdxs).toHaveLength(1);
    expect(touched?.confidence).toBe(1);
    // The rest of the speech is untouched and still MARY's.
    const rest = applied.blocks.find((b) => b.type === 'dialogue');
    expect(rest?.speakerLabel).toBe('MARY');
  });

  it('never merges two separate speeches into one block', () => {
    const r = detectStructure(fromText(base), { hasGeometry: false, kind: 'script' });
    const applied = applyStructureOverrides(r.blocks, r.lines, []);
    expect(applied.blocks.map((b) => b.type)).toEqual(r.blocks.map((b) => b.type));
    expect(applied.blocks.map((b) => b.lineIdxs)).toEqual(r.blocks.map((b) => b.lineIdxs));
  });

  it('ignores unknown fingerprints and chunkBreak overrides', () => {
    const r = detectStructure(fromText(base), { hasGeometry: false, kind: 'script' });
    const applied = applyStructureOverrides(r.blocks, r.lines, [
      { kind: 'lineType', fingerprint: 'deadbeef:0', type: 'heading' },
      { kind: 'chunkBreak', fingerprint: r.lines[0]?.fingerprint ?? '' },
    ]);
    expect(applied.blocks).toEqual(r.blocks);
  });
});

describe('overridesForApplyToAll', () => {
  const text = `MARY
(softly)
The door is stuck again.
(louder)
Someone should fix it.

MARY
(softly)
What was that?`;

  it('generalises to every line with the same signal, casing and indent', () => {
    const r = detectStructure(fromText(text), { hasGeometry: false, kind: 'script' });
    const exemplar = lineOf(r, '(louder)').fingerprint;
    const overrides = overridesForApplyToAll(r.lines, exemplar, 'paragraph');

    expect(overrides).toHaveLength(3); // (softly) ×2 and (louder)
    for (const o of overrides) expect(o.kind).toBe('lineType');

    const applied = applyStructureOverrides(r.blocks, r.lines, overrides);
    for (const parenthetical of ['(softly)', '(louder)']) {
      const line = applied.lines.find((l) => l.text === parenthetical);
      expect(applied.blocks[line?.blockIdx ?? -1]?.type).toBe('paragraph');
    }
  });

  it('does not generalise across a different signal or casing', () => {
    const r = detectStructure(fromText(text), { hasGeometry: false, kind: 'script' });
    const exemplar = lineOf(r, 'The door is stuck again.').fingerprint;
    const overrides = overridesForApplyToAll(r.lines, exemplar, 'direction');
    const targets = overrides.map((o) => o.fingerprint);
    expect(targets).not.toContain(lineOf(r, '(softly)').fingerprint);
    expect(targets).not.toContain(lineOf(r, 'MARY').fingerprint);
  });

  it('returns nothing for an unknown exemplar', () => {
    const r = detectStructure(fromText(text), { hasGeometry: false, kind: 'script' });
    expect(overridesForApplyToAll(r.lines, 'nope:0', 'heading')).toEqual([]);
  });
});

describe('recurrence guard — regressions found in the running app', () => {
  it('does not turn a one-off "Something:" inside a speech into a speaker', () => {
    // "That flesh is heir to:" matches the NAME: cue pattern perfectly. Before the guard
    // was tightened it became a phantom character in the middle of the soliloquy.
    const { blocks, roles } = detectStructure(
      [
        'HAMLET',
        'To be, or not to be, that is the question:',
        'Whether ’tis nobler in the mind to suffer',
        'The heart-ache and the thousand natural shocks',
        'That flesh is heir to: ’tis a consummation',
        'Devoutly to be wish’d. To die, to sleep;',
      ].map((text) => ({ text })),
      { hasGeometry: false, kind: 'script' },
    );

    expect(roles.map((r) => r.label)).not.toContain('That flesh is heir to');
    const labels = blocks.map((b) => b.speakerLabel).filter(Boolean);
    expect(labels).not.toContain('That flesh is heir to:');
  });

  it('still accepts a two-hander written in NAME: form', () => {
    const { roles } = detectStructure(
      [
        'ALGERNON: Did you hear what I was playing, Lane?',
        'LANE: I didn’t think it polite to listen, sir.',
        'ALGERNON: I’m sorry for that, for your sake.',
        'LANE: Yes, sir.',
      ].map((text) => ({ text })),
      { hasGeometry: false, kind: 'script' },
    );
    expect(roles.map((r) => r.label).sort()).toEqual(['ALGERNON', 'LANE']);
  });
});
