import { describe, expect, it } from 'vitest';
import {
  CHUNK_MAX_WORDS,
  chunkDocument,
  chunkKey,
  reanchorChunks,
  resolveStrategy,
  sentenceSplit,
} from '../../../src/core/text/chunk';
import type { Block, BlockType, Chunk, Line, Token } from '../../../src/core/text/types';
import { identityNormalize, lineFingerprint } from '../../../src/core/util/hash';

// ---------------------------------------------------------------- fixtures

interface BlockSpec {
  type?: BlockType;
  speaker?: string | null;
  lines: string[];
}

interface Doc {
  lines: Line[];
  blocks: Block[];
}

/**
 * A deliberately small stand-in for the real tokenizer: enough of the frozen Token shape
 * for the chunker, no more. Tokens inside `(...)` become `direction`, as inline directions do.
 */
function tokenizeLine(text: string, lineIdx: number, blockIdx: number, start: number): Token[] {
  const tokens: Token[] = [];
  const re = /(\s*)(\S+)/g;
  let inDirection = false;
  let m = re.exec(text);
  let i = start;
  while (m !== null) {
    const ws = m[1] ?? '';
    const raw = m[2] ?? '';
    let lead = /^[^\p{L}\p{N}]*/u.exec(raw)?.[0] ?? '';
    let rest = raw.slice(lead.length);
    let trail = /[^\p{L}\p{N}]*$/u.exec(rest)?.[0] ?? '';
    let core = rest.slice(0, rest.length - trail.length);
    if (core === '') {
      core = raw;
      lead = '';
      trail = '';
      rest = raw;
    }
    const opens = lead.includes('(');
    const closes = trail.includes(')');
    const direction = inDirection || opens;
    if (opens) inDirection = true;
    if (closes) inDirection = false;

    const kind = direction
      ? 'direction'
      : /\p{L}/u.test(core)
        ? 'word'
        : /\p{N}/u.test(core)
          ? 'number'
          : 'punct';

    tokens.push({
      i,
      text: core,
      lead,
      trail,
      ws,
      kind,
      letterCount: [...core].filter((c) => /\p{L}/u.test(c)).length,
      letterGroups: [],
      firstLetter: [...core][0] ?? '',
      normalized: identityNormalize(core),
      lineIdx,
      blockIdx,
      chunkIdx: -1,
      sentIdx: 0,
      posInLine: tokens.length,
      lineLen: 0,
      posInSent: 0,
      sentLen: 0,
      isFunction: false,
      isProperish: false,
      hasDigit: /\p{N}/u.test(core),
      count: 1,
      isMaskable: kind === 'word' || kind === 'number',
    });
    i++;
    m = re.exec(text);
  }
  for (const t of tokens) t.lineLen = tokens.length;
  return tokens;
}

function buildDoc(specs: readonly BlockSpec[]): Doc {
  const lines: Line[] = [];
  const blocks: Block[] = [];
  let tokenIndex = 0;
  specs.forEach((spec, blockIdx) => {
    const lineIdxs: number[] = [];
    for (const text of spec.lines) {
      const idx = lines.length;
      const tokens = tokenizeLine(text, idx, blockIdx, tokenIndex);
      tokenIndex += tokens.length;
      lines.push({
        idx,
        blockIdx,
        text,
        tokens,
        fingerprint: lineFingerprint(text),
        indentEm: 0,
      });
      lineIdxs.push(idx);
    }
    blocks.push({
      idx: blockIdx,
      type: spec.type ?? 'paragraph',
      speakerId: spec.speaker ?? null,
      speakerLabel: spec.speaker ?? null,
      lineIdxs,
      confidence: 1,
    });
  });
  return { lines, blocks };
}

function textOf(chunk: Chunk, doc: Doc): string {
  const [start, end] = chunk.tokenRange;
  return doc.lines
    .filter((l) => chunk.lineIdxs.includes(l.idx))
    .flatMap((l) => l.tokens)
    .filter((t) => t.i >= start && t.i < end)
    .map((t) => t.text)
    .join(' ');
}

/** Every maskable token belongs to exactly one chunk, in order. */
function expectTotalCoverage(chunks: readonly Chunk[], doc: Doc): void {
  const covered: number[] = [];
  for (const c of chunks) {
    for (let i = c.tokenRange[0]; i < c.tokenRange[1]; i++) covered.push(i);
  }
  const all = doc.lines.flatMap((l) => l.tokens).map((t) => t.i);
  expect(covered).toEqual(all);
}

// ---------------------------------------------------------------- documents

const LYRIC: BlockSpec[] = [
  { type: 'verse', lines: ['I was lost in the harbour light', 'counting every passing ship'] },
  { type: 'verse', lines: ['Carry me home', 'carry me home tonight', 'the road is long'] },
  {
    type: 'verse',
    lines: ['You wrote my name in the salt and sand', 'the tide took back the rest'],
  },
  { type: 'verse', lines: ['Carry me home', 'carry me home tonight', 'the road is long'] },
  { type: 'verse', lines: ['Morning came up over the wire', 'and nothing looked the same'] },
  { type: 'verse', lines: ['Carry me home', 'carry me home tonight', 'the road is long'] },
];

const SCRIPT: BlockSpec[] = [
  { type: 'heading', lines: ['ACT ONE'] },
  { type: 'dialogue', speaker: 'hamlet', lines: ['To be or not to be, that is the question.'] },
  { type: 'dialogue', speaker: 'hamlet', lines: ['Whether tis nobler in the mind to suffer.'] },
  { type: 'direction', lines: ['(He turns away from the window.)'] },
  { type: 'dialogue', speaker: 'ophelia', lines: ['My lord, I have remembrances of yours.'] },
  { type: 'dialogue', speaker: 'hamlet', lines: ['No, not I. I never gave you aught.'] },
];

const PROSE_SENTENCES = [
  'The first thing you notice about the harbour is how quietly it works.',
  'Nobody shouts and nobody hurries, and the cranes move like slow patient animals.',
  'A man in a yellow coat waves a clipboard at nothing in particular.',
  'The ferry leaves at nine and it leaves at nine whatever the weather does.',
  'I have watched it go a hundred times and I have never once been on it.',
  'That is the whole of my report.',
];

const PROSE: BlockSpec[] = [{ type: 'paragraph', lines: [PROSE_SENTENCES.join(' ')] }];

// ---------------------------------------------------------------- strategies

describe('chunkDocument strategies', () => {
  it('line: one chunk per non-empty line', () => {
    const doc = buildDoc(LYRIC);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'line');
    expect(chunks).toHaveLength(doc.lines.length);
    expect(chunks.map((c) => c.lineIdxs)).toEqual(doc.lines.map((l) => [l.idx]));
    expectTotalCoverage(chunks, doc);
  });

  it('block: one chunk per block', () => {
    const doc = buildDoc(LYRIC);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'block');
    expect(chunks).toHaveLength(LYRIC.length);
    expect(chunks[1]?.lineIdxs).toEqual([2, 3, 4]);
    expectTotalCoverage(chunks, doc);
  });

  it('speech: consecutive blocks by the same speaker become one chunk', () => {
    const doc = buildDoc(SCRIPT);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'speech');
    // heading | HAMLET x2 | direction | OPHELIA | HAMLET
    expect(chunks).toHaveLength(5);
    expect(chunks.map((c) => c.speakerId)).toEqual([null, 'hamlet', null, 'ophelia', 'hamlet']);
    expect(chunks[1]?.lineIdxs).toEqual([1, 2]);
    expectTotalCoverage(chunks, doc);
  });

  it('speech: a chunk never spans a speaker change', () => {
    const doc = buildDoc([
      ...SCRIPT,
      { type: 'dialogue', speaker: 'ophelia', lines: ['I know.'] },
      { type: 'dialogue', speaker: 'hamlet', lines: ['Ha.'] },
      { type: 'dialogue', speaker: 'ophelia', lines: ['Well.'] },
    ]);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'speech');
    const speakerOfLine = new Map(
      doc.lines.map((l) => [l.idx, doc.blocks[l.blockIdx]?.speakerId ?? null]),
    );
    for (const chunk of chunks) {
      const speakers = new Set(chunk.lineIdxs.map((i) => speakerOfLine.get(i)));
      expect(speakers.size).toBe(1);
    }
  });

  it('sentence: merges sentences towards the target and never exceeds the max', () => {
    const doc = buildDoc(PROSE);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'sentence', 28);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.wordCount).toBeLessThanOrEqual(CHUNK_MAX_WORDS);
    expectTotalCoverage(chunks, doc);
    // Boundaries land on sentence starts, never mid-sentence.
    for (const c of chunks.slice(1)) {
      const first = textOf(c, doc).split(' ')[0] ?? '';
      expect(PROSE_SENTENCES.some((s) => s.startsWith(first))).toBe(true);
    }
  });

  it('splits a single over-long unit at sentence boundaries', () => {
    const doc = buildDoc([{ type: 'paragraph', lines: [PROSE_SENTENCES.join(' ')] }]);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'block');
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.wordCount).toBeLessThanOrEqual(CHUNK_MAX_WORDS);
  });

  it('honours manual chunk breaks', () => {
    const doc = buildDoc([{ type: 'verse', lines: ['one two three', 'four five six'] }]);
    const breaks = new Set([lineFingerprint('four five six')]);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'block', 28, breaks);
    expect(chunks).toHaveLength(2);
  });

  it('a --- marker line is a boundary and belongs to no chunk', () => {
    const doc = buildDoc([{ type: 'verse', lines: ['one two three', '---', 'four five six'] }]);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'block');
    expect(chunks).toHaveLength(2);
    expect(chunks.flatMap((c) => c.lineIdxs)).toEqual([0, 2]);
  });
});

describe('auto strategy', () => {
  it('resolves per DocKind (§3.4 #23)', () => {
    expect(resolveStrategy('auto', 'script')).toBe('speech');
    expect(resolveStrategy('auto', 'lyrics')).toBe('line');
    expect(resolveStrategy('auto', 'poem')).toBe('line');
    expect(resolveStrategy('auto', 'speech')).toBe('sentence');
    expect(resolveStrategy('auto', 'lesson')).toBe('sentence');
    expect(resolveStrategy('auto', 'other')).toBe('sentence');
    expect(resolveStrategy('line', 'script')).toBe('line');
  });

  it('auto on a script chunks like speech', () => {
    const doc = buildDoc(SCRIPT);
    const auto = chunkDocument(doc.lines, doc.blocks, 'auto', 28, undefined, { kind: 'script' });
    const explicit = chunkDocument(doc.lines, doc.blocks, 'speech');
    expect(auto.map((c) => c.key)).toEqual(explicit.map((c) => c.key));
  });

  it('auto on lyrics chunks like line', () => {
    const doc = buildDoc(LYRIC);
    const auto = chunkDocument(doc.lines, doc.blocks, 'auto', 28, undefined, { kind: 'lyrics' });
    const explicit = chunkDocument(doc.lines, doc.blocks, 'line');
    expect(auto.map((c) => c.key)).toEqual(explicit.map((c) => c.key));
  });

  it('auto on prose chunks like sentence', () => {
    const doc = buildDoc(PROSE);
    const auto = chunkDocument(doc.lines, doc.blocks, 'auto', 28, undefined, { kind: 'speech' });
    const explicit = chunkDocument(doc.lines, doc.blocks, 'sentence', 28);
    expect(auto.map((c) => c.key)).toEqual(explicit.map((c) => c.key));
  });
});

// ---------------------------------------------------------------- identity

describe('chunk identity', () => {
  it('three identical choruses get three distinct keys, ranked 0,1,2', () => {
    const doc = buildDoc(LYRIC);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'block');
    const chorus = [chunks[1], chunks[3], chunks[5]];
    for (const c of chorus) expect(c).toBeDefined();
    const keys = chorus.map((c) => c?.key ?? '');
    expect(new Set(keys).size).toBe(3);
    const bases = keys.map((k) => k.split('#')[0]);
    expect(new Set(bases).size).toBe(1); // same content...
    expect(keys.map((k) => k.split('#')[1])).toEqual(['0', '1', '2']); // ...different rank
  });

  it('re-chunking the same text reproduces exactly the same keys', () => {
    const a = buildDoc(LYRIC);
    const b = buildDoc(LYRIC);
    const keysA = chunkDocument(a.lines, a.blocks, 'block').map((c) => c.key);
    const keysB = chunkDocument(b.lines, b.blocks, 'block').map((c) => c.key);
    expect(keysB).toEqual(keysA);
  });

  it('inserting a fourth chorus at the top orphans nothing (§7.7 rank-within-group)', () => {
    const before = buildDoc(LYRIC);
    const chorus = LYRIC[1];
    expect(chorus).toBeDefined();
    const after = buildDoc([chorus as BlockSpec, ...LYRIC]);

    const oldChunks = chunkDocument(before.lines, before.blocks, 'block');
    const newChunks = chunkDocument(after.lines, after.blocks, 'block');
    const result = reanchorChunks(
      oldChunks.map((c) => c.key),
      newChunks,
      after.lines,
    );
    expect(result.orphaned).toEqual([]);
    expect(result.matched.size).toBe(oldChunks.length);
  });

  it('is insensitive to case, punctuation and accents but not to words', () => {
    const plain = buildDoc([{ lines: ['the tide took back the rest'] }]);
    const fussy = buildDoc([{ lines: ['The tide — took back, the rest!'] }]);
    const changed = buildDoc([{ lines: ['the tide took back the ring'] }]);
    const key = (d: Doc) => chunkDocument(d.lines, d.blocks, 'line')[0]?.key;
    expect(key(fussy)).toBe(key(plain));
    expect(key(changed)).not.toBe(key(plain));
  });

  it('chunkKey re-derives the key of a chunk chunkDocument produced', () => {
    const doc = buildDoc(LYRIC);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'block');
    const first = chunks[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(chunkKey(first, doc.lines, 0)).toBe(first.key);
    expect(chunkKey(first, doc.lines, 1)).toBe(`${first.key.split('#')[0]}#1`);
  });
});

// ---------------------------------------------------------------- re-anchoring

describe('reanchorChunks — the edit-survival guarantee', () => {
  const ORIGINAL = [
    'I was lost in the harbour light',
    'counting every passing ship',
    'you wrote my name in the salt and sand',
    'the tide took back the ret',
    'morning came up over the wire',
    'and nothing looked the same',
    'the ferry leaves at nine',
    'whatever the weather does',
  ];

  it('fixing a typo in chunk 4 orphans only chunk 4', () => {
    const before = buildDoc(ORIGINAL.map((l) => ({ type: 'verse' as BlockType, lines: [l] })));
    const fixed = [...ORIGINAL];
    fixed[3] = 'the tide took back the rest';
    const after = buildDoc(fixed.map((l) => ({ type: 'verse' as BlockType, lines: [l] })));

    const oldChunks = chunkDocument(before.lines, before.blocks, 'line');
    const newChunks = chunkDocument(after.lines, after.blocks, 'line');
    expect(oldChunks).toHaveLength(8);
    expect(newChunks).toHaveLength(8);

    const oldKeys = oldChunks.map((c) => c.key);
    const result = reanchorChunks(oldKeys, newChunks, after.lines);

    expect(result.orphaned).toEqual([oldKeys[3]]);
    for (const [i, key] of oldKeys.entries()) {
      if (i === 3) continue;
      expect(result.matched.get(key)).toBe(newChunks[i]?.key);
    }
    expect(result.matched.size).toBe(7);
  });

  it('a pure punctuation fix orphans nothing', () => {
    const before = buildDoc(ORIGINAL.map((l) => ({ type: 'verse' as BlockType, lines: [l] })));
    const repunctuated = ORIGINAL.map((l, i) => (i === 3 ? `${l.toUpperCase()}!` : l));
    const after = buildDoc(repunctuated.map((l) => ({ type: 'verse' as BlockType, lines: [l] })));
    const result = reanchorChunks(
      chunkDocument(before.lines, before.blocks, 'line').map((c) => c.key),
      chunkDocument(after.lines, after.blocks, 'line'),
      after.lines,
    );
    expect(result.orphaned).toEqual([]);
  });

  it('deleting a chunk in the middle keeps every other key', () => {
    const before = buildDoc(ORIGINAL.map((l) => ({ type: 'verse' as BlockType, lines: [l] })));
    const after = buildDoc(
      ORIGINAL.filter((_, i) => i !== 2).map((l) => ({ type: 'verse' as BlockType, lines: [l] })),
    );
    const oldKeys = chunkDocument(before.lines, before.blocks, 'line').map((c) => c.key);
    const result = reanchorChunks(
      oldKeys,
      chunkDocument(after.lines, after.blocks, 'line'),
      after.lines,
    );
    expect(result.orphaned).toEqual([oldKeys[2]]);
    expect(result.matched.size).toBe(7);
  });
});

// ---------------------------------------------------------------- sentence splitting

describe('sentenceSplit', () => {
  it('does not split on Mr. or mid-abbreviation, but does split a real full stop', () => {
    expect(sentenceSplit('Mr. Smith went to Washington, D.C. He stayed.', 'en')).toEqual([
      'Mr. Smith went to Washington, D.C.',
      'He stayed.',
    ]);
  });

  it('keeps e.g. and i.e. inside their sentence', () => {
    expect(sentenceSplit('Bring something warm, e.g. a coat. Then wait.', 'en')).toEqual([
      'Bring something warm, e.g. a coat.',
      'Then wait.',
    ]);
  });

  it('keeps initials together', () => {
    expect(sentenceSplit('J. R. R. Tolkien wrote it. Nobody else did.', 'en')).toHaveLength(2);
  });

  it('does not split inside a quotation', () => {
    expect(sentenceSplit('She said "Hello. Goodbye." Then she left.', 'en')).toEqual([
      'She said "Hello. Goodbye."',
      'Then she left.',
    ]);
  });

  it('returns nothing for blank text and tolerates a junk locale', () => {
    expect(sentenceSplit('   ', 'en')).toEqual([]);
    expect(sentenceSplit('One. Two.', 'not a locale!!')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- splitting guards

describe('splitting an over-long unit', () => {
  const NUMBERS = Array.from({ length: 65 }, (_, i) => `w${i + 1}`);

  it('never cuts inside an inline-direction span (§7.7)', () => {
    const withDirection = [
      ...NUMBERS.slice(0, 20),
      '(he',
      'pauses',
      'here',
      'for',
      'a',
      'very',
      'long',
      'and',
      'awkward',
      'moment)',
      ...NUMBERS.slice(20),
    ].join(' ');
    const doc = buildDoc([{ type: 'dialogue', speaker: 'a', lines: [withDirection] }]);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'speech', 28);
    expect(chunks.length).toBeGreaterThan(1);

    const directionIdxs = doc.lines
      .flatMap((l) => l.tokens)
      .filter((t) => t.kind === 'direction')
      .map((t) => t.i);
    expect(directionIdxs).toHaveLength(10);
    const owning = chunks.filter((c) =>
      directionIdxs.some((i) => i >= c.tokenRange[0] && i < c.tokenRange[1]),
    );
    expect(owning).toHaveLength(1);
  });

  it('prefers line boundaries over arbitrary word boundaries', () => {
    const doc = buildDoc([
      { type: 'verse', lines: [NUMBERS.slice(0, 30).join(' '), NUMBERS.slice(30).join(' ')] },
    ]);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'block', 28);
    expect(chunks.map((c) => c.lineIdxs)).toEqual([[0], [1]]);
  });

  it('merges a runt sentence into its neighbour', () => {
    const doc = buildDoc([
      { type: 'paragraph', lines: ['One two three four five six seven eight nine ten. Yes.'] },
    ]);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'sentence', 28);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.wordCount).toBe(11);
  });

  it('leaves short lyric lines alone under the line strategy', () => {
    const doc = buildDoc([{ type: 'verse', lines: ['Carry me home', 'the road is long'] }]);
    const chunks = chunkDocument(doc.lines, doc.blocks, 'line');
    expect(chunks).toHaveLength(2);
  });
});
