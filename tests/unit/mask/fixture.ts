/**
 * A miniature document builder for the mask conformance suite.
 *
 * The real pipeline (src/core/text) is another agent's module; the mask engine only needs a
 * Document that satisfies the frozen contract, so this builds one directly. It is deliberately
 * simpler than the real tokenizer — no Intl.Segmenter joins, no abbreviation guard — because
 * every property the mask engine is tested on is a property of the token FIELDS, not of how
 * they were derived.
 *
 * Source syntax:
 *   `# Heading`        -> heading block
 *   `(a direction)`    -> direction block
 *   `NAME: line text`  -> dialogue block for NAME; following unprefixed lines continue it
 *   anything else      -> paragraph (or verse when kind is lyrics/poem)
 *   blank line         -> block break
 */

import type { MethodId, ModeSpec } from '../../../src/core/mask/types';
import type {
  Block,
  BlockType,
  Chunk,
  DocKind,
  Document,
  Line,
  Role,
  Token,
  TokenKind,
} from '../../../src/core/text/types';
import { lineFingerprint } from '../../../src/core/util/hash';

const FUNCTION_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'not',
  'of',
  'on',
  'or',
  'our',
  'she',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'which',
  'who',
  'will',
  'with',
  'you',
  'your',
  "don't",
  "i'm",
  'am',
  'up',
  'out',
  'all',
  'us',
  'him',
  'shall',
  'thy',
  'thou',
  'thee',
  'nor',
  'no',
  'yes',
  'well',
  'oh',
]);

interface RawLine {
  text: string;
  type: BlockType;
  speaker: string | null;
  newBlock: boolean;
}

function classify(raw: string, prose: BlockType): RawLine {
  if (raw.startsWith('# ')) {
    return { text: raw.slice(2), type: 'heading', speaker: null, newBlock: true };
  }
  if (raw.startsWith('(') && raw.endsWith(')')) {
    return { text: raw, type: 'direction', speaker: null, newBlock: true };
  }
  const cue = /^([A-Z][A-Z0-9 '.-]*):\s*(.*)$/.exec(raw);
  if (cue !== null) {
    return {
      text: cue[2] ?? '',
      type: 'dialogue',
      speaker: (cue[1] ?? '').trim().toLowerCase(),
      newBlock: true,
    };
  }
  return { text: raw, type: prose, speaker: null, newBlock: false };
}

function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[‘’ʼ´`]/g, "'");
}

function countLetters(s: string): number {
  return [...s].filter((ch) => /\p{L}/u.test(ch)).length;
}

interface PartialToken {
  ws: string;
  lead: string;
  text: string;
  trail: string;
}

function splitLine(text: string): PartialToken[] {
  const out: PartialToken[] = [];
  const re = /(\s*)(\S+)/gu;
  let m = re.exec(text);
  while (m !== null) {
    const ws = m[1] ?? '';
    const raw = m[2] ?? '';
    const lead = /^[^\p{L}\p{N}]+/u.exec(raw)?.[0] ?? '';
    const rest = raw.slice(lead.length);
    const trail = /[^\p{L}\p{N}]+$/u.exec(rest)?.[0] ?? '';
    const core = rest.slice(0, rest.length - trail.length);
    if (core.length === 0) out.push({ ws, lead: '', text: raw, trail: '' });
    else out.push({ ws, lead, text: core, trail });
    m = re.exec(text);
  }
  return out;
}

export interface BuildOptions {
  id?: string;
  kind?: DocKind;
  lang?: string;
  /** One chunk per block by default; `line` gives one chunk per line. */
  chunkBy?: 'block' | 'line';
}

export function buildDoc(source: string, options: BuildOptions = {}): Document {
  const kind = options.kind ?? 'script';
  const prose: BlockType = kind === 'lyrics' || kind === 'poem' ? 'verse' : 'paragraph';

  const blocks: Block[] = [];
  const lines: Line[] = [];
  const tokens: Token[] = [];

  let currentBlock: Block | null = null;
  let sentIdx = 0;

  for (const sourceLine of source.split('\n')) {
    const trimmed = sourceLine.trim();
    if (trimmed.length === 0) {
      currentBlock = null;
      continue;
    }
    const raw = classify(trimmed, prose);
    if (currentBlock === null || raw.newBlock || currentBlock.type !== raw.type) {
      currentBlock = {
        idx: blocks.length,
        type: raw.type,
        speakerId: raw.speaker,
        speakerLabel: raw.speaker === null ? null : raw.speaker.toUpperCase(),
        lineIdxs: [],
        confidence: 1,
      };
      blocks.push(currentBlock);
    }
    const block = currentBlock;

    const line: Line = {
      idx: lines.length,
      blockIdx: block.idx,
      text: raw.text,
      tokens: [],
      fingerprint: lineFingerprint(raw.text),
      indentEm: 0,
    };
    block.lineIdxs.push(line.idx);
    lines.push(line);

    const parts = splitLine(raw.text);
    parts.forEach((part, posInLine) => {
      const hasLetters = /\p{L}/u.test(part.text);
      const hasDigits = /\p{N}/u.test(part.text);
      let tokenKind: TokenKind;
      if (!hasLetters && !hasDigits) tokenKind = 'punct';
      else if (!hasLetters && hasDigits) tokenKind = 'number';
      else if (raw.type === 'direction') tokenKind = 'direction';
      else tokenKind = 'word';

      const normalized = normalize(part.text);
      const token: Token = {
        i: tokens.length,
        text: part.text,
        lead: part.lead,
        trail: part.trail,
        ws: posInLine === 0 ? '' : part.ws,
        kind: tokenKind,
        letterCount: countLetters(part.text),
        letterGroups: part.text.split('-').map(countLetters),
        firstLetter: [...part.text][0] ?? '',
        normalized,
        lineIdx: line.idx,
        blockIdx: block.idx,
        chunkIdx: 0,
        sentIdx,
        posInLine,
        lineLen: parts.length,
        posInSent: 0,
        sentLen: 0,
        isFunction:
          FUNCTION_WORDS.has(normalized) || (tokenKind === 'word' && normalized.length <= 2),
        isProperish:
          /^\p{Lu}/u.test(part.text) &&
          posInLine > 0 &&
          part.text !== part.text.toUpperCase() &&
          normalized !== 'i',
        hasDigit: hasDigits,
        count: 0,
        isMaskable:
          (tokenKind === 'word' || tokenKind === 'number') &&
          (raw.type === 'dialogue' || raw.type === 'paragraph' || raw.type === 'verse'),
      };
      tokens.push(token);
      line.tokens.push(token);
      if (/[.?!]/.test(part.trail)) sentIdx++;
    });
  }

  // second pass: sentence positions and document-wide counts
  const counts = new Map<string, number>();
  for (const t of tokens) {
    if (t.kind === 'punct') continue;
    counts.set(t.normalized, (counts.get(t.normalized) ?? 0) + 1);
  }
  const sentSeen = new Map<number, number>();
  for (const t of tokens) {
    const pos = sentSeen.get(t.sentIdx) ?? 0;
    t.posInSent = pos;
    sentSeen.set(t.sentIdx, pos + 1);
    t.count = counts.get(t.normalized) ?? 1;
  }
  for (const t of tokens) t.sentLen = sentSeen.get(t.sentIdx) ?? 1;

  const chunks = buildChunks(options.chunkBy ?? 'block', blocks, lines, tokens);
  for (const chunk of chunks) {
    for (let i = chunk.tokenRange[0]; i < chunk.tokenRange[1]; i++) {
      const t = tokens[i];
      if (t !== undefined) t.chunkIdx = chunk.idx;
    }
  }

  const roles = buildRoles(blocks, lines, tokens);

  return {
    id: options.id ?? 'doc-test',
    kind,
    lang: options.lang ?? 'en',
    blocks,
    lines,
    tokens,
    chunks,
    roles,
    wordCount: tokens.filter((t) => t.kind === 'word' || t.kind === 'number').length,
    charCount: source.length,
  };
}

function buildChunks(
  by: 'block' | 'line',
  blocks: readonly Block[],
  lines: readonly Line[],
  tokens: readonly Token[],
): Chunk[] {
  const groups: { lineIdxs: number[]; speakerId: string | null }[] =
    by === 'line'
      ? lines.map((l) => ({
          lineIdxs: [l.idx],
          speakerId: blocks[l.blockIdx]?.speakerId ?? null,
        }))
      : blocks.map((b) => ({ lineIdxs: [...b.lineIdxs], speakerId: b.speakerId }));

  const chunks: Chunk[] = [];
  for (const group of groups) {
    const groupTokens = group.lineIdxs.flatMap((idx) => lines[idx]?.tokens ?? []);
    if (groupTokens.length === 0) continue;
    const first = groupTokens[0]?.i ?? 0;
    const last = groupTokens[groupTokens.length - 1]?.i ?? first;
    chunks.push({
      idx: chunks.length,
      key: `chunk-${chunks.length}`,
      lineIdxs: group.lineIdxs,
      tokenRange: [first, last + 1],
      wordCount: groupTokens.filter((t) => t.kind === 'word' || t.kind === 'number').length,
      speakerId: group.speakerId,
    });
  }
  void tokens;
  return chunks;
}

function buildRoles(
  blocks: readonly Block[],
  lines: readonly Line[],
  tokens: readonly Token[],
): Role[] {
  const roles = new Map<string, Role>();
  for (const block of blocks) {
    if (block.speakerId === null) continue;
    let role = roles.get(block.speakerId);
    if (role === undefined) {
      role = {
        id: block.speakerId,
        label: block.speakerId.toUpperCase(),
        aliases: [],
        colorIndex: roles.size,
        isEnsemble: false,
        lineCount: 0,
        wordCount: 0,
        firstLineIndex: block.lineIdxs[0] ?? 0,
      };
      roles.set(block.speakerId, role);
    }
    role.lineCount += block.lineIdxs.length;
    for (const lineIdx of block.lineIdxs) {
      role.wordCount += (lines[lineIdx]?.tokens ?? []).filter(
        (t) => t.kind === 'word' || t.kind === 'number',
      ).length;
    }
  }
  void tokens;
  return [...roles.values()];
}

// ---------------------------------------------------------------- specs

export function makeSpec(methodId: MethodId, overrides: Partial<ModeSpec> = {}): ModeSpec {
  return {
    methodId,
    ladderIndex: 0,
    customPercent: null,
    params: {},
    lens: { myRoleIds: [], cueStyle: 'full', cueTailWords: 5 },
    scope: { kind: 'text' },
    blankStyle: 'underline',
    reshuffle: 0,
    phase: 0,
    reveals: { peeked: null, revealed: new Set<number>(), revealAll: false },
    ...overrides,
  };
}

export function maskedSet(styles: Uint8Array): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < styles.length; i++) if (styles[i] !== 0) out.add(i);
  return out;
}

export function isSubset(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---------------------------------------------------------------- corpora

export const SCENE_SOURCE = `# ACT THREE, SCENE ONE

(Enter HAMLET, reading a book.)

HAMLET: To be, or not to be, that is the question:
Whether tis nobler in the mind to suffer
The slings and arrows of outrageous fortune,
Or to take arms against a sea of troubles.

OPHELIA: Good my lord, how does your honour for this many a day?

HAMLET: I humbly thank you; well, well, well.
There were 3 letters and 12 tokens of remembrance.

OPHELIA: My honoured lord, you know right well you did.`;

export const LYRIC_SOURCE = `We were young and we were free
Every summer by the sea
Now the tide has turned away
Nothing left for me to say

Hold the line
Hold it one more time
Hold the line
We will all be fine`;

export const SHORT_LINES_SOURCE = `One two three
One two three four five
Alpha beta gamma delta epsilon zeta eta theta iota kappa`;

export function sceneDoc(): Document {
  return buildDoc(SCENE_SOURCE, { id: 'scene', kind: 'script' });
}

export function lyricDoc(): Document {
  return buildDoc(LYRIC_SOURCE, { id: 'lyric', kind: 'lyrics', chunkBy: 'line' });
}

export function shortLinesDoc(): Document {
  return buildDoc(SHORT_LINES_SOURCE, { id: 'short', kind: 'lyrics', chunkBy: 'line' });
}

/** Deliberately mixed line lengths: 3, 5, 6 and 20 words. */
export const MIXED_SOURCE = `Alpha beta gamma
Delta epsilon zeta eta theta
Kappa lambda mu nu xi omicron
Pi rho sigma tau upsilon phi chi psi omega aleph beth gimel daleth vav zayin het tet yod kaf`;

export function mixedDoc(): Document {
  return buildDoc(MIXED_SOURCE, { id: 'mixed', kind: 'poem', chunkBy: 'line' });
}

/** The first chunk that actually contains maskable words. */
export function firstMaskableChunkIndex(doc: Document): number {
  for (const chunk of doc.chunks) {
    for (let i = chunk.tokenRange[0]; i < chunk.tokenRange[1]; i++) {
      if (doc.tokens[i]?.isMaskable === true) return chunk.idx;
    }
  }
  return 0;
}

/**
 * One stanza, many line lengths, real rhymes, and enough lines that the density ladder
 * separates. Used for the §8.6 "every rung is distinguishable" claim, which is a property of
 * the document as much as of the table.
 */
export const VARIED_SOURCE = `The morning came and took the light away
And I was left with nothing much to say
A bird
A small brown bird upon the humming wire
Sang out a note that set the whole grey street on fire
Nobody moved at all
The clock upon the mantel ticked and ticked and slowly wore the whole long afternoon to grey
We waited
I counted 17 cracks along the ceiling of the little room where mother used to sit and read
Then evening came
Somebody knocked three times upon the door and did not wait for anyone to answer it at all
The kettle sang a while
Nothing else happened that day
Everyone went home`;

export function variedDoc(): Document {
  return buildDoc(VARIED_SOURCE, { id: 'varied', kind: 'poem', chunkBy: 'block' });
}
