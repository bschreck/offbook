/**
 * Stage 4 — STRUCTURE. PLAN.md §7.5 (cue detection, hardened) and §7.6 (verse indentation).
 *
 * One pass over the extracted lines produces blocks, lines and roles. The three cue
 * detectors (ALLCAPS, `NAME:`, `NAME.`) all run through the same recurrence guard, which is
 * what stops `ACT ONE`, a shouted `MOTHER!` and an ALLCAPS poem title becoming speakers.
 *
 * `tokens` on each Line is deliberately left empty: stage 5 fills it (§7.4).
 */

import { clamp } from '../util/assert';
import { lineFingerprint } from '../util/hash';
import { buildRoles, roleIdFor, roleNameKey, stripCueSuffix } from './roles';
import type { Block, BlockType, DocKind, Line, Role } from './types';

/** §7.5: accept at ≥0.70; 0.45–0.70 is accepted but flagged in the structure editor. */
export const CUE_CONFIDENCE_FLOOR = 0.7;
/** Below this a cue candidate is not a cue at all. */
export const CUE_REJECT_BELOW = 0.45;

/** A classification we were handed by a structured importer (FDX `Paragraph Type`). */
export type TrustedStyle =
  | 'character'
  | 'dialogue'
  | 'parenthetical'
  | 'action'
  | 'heading'
  | 'transition'
  | 'verse';

export interface StructureInputLine {
  /** Raw line text. Leading/trailing whitespace is harvested into `indentEm`, then trimmed. */
  text: string;
  /** Harvested left edge in points. Only meaningful when `hints.hasGeometry`. */
  indentPt?: number;
  /** Whole-line italic from HTML/Markdown — a strong stage-direction signal (§7.1). */
  italic?: boolean;
  /** Trusted style name. Short-circuits detection for this line (§7.5, shortcut paths). */
  styleType?: TrustedStyle;
}

export interface StructureHints {
  /** §7.1: the cue detector gets an indentation boost only when geometry was harvested. */
  hasGeometry: boolean;
  /** From the sniff (§7.3). Decides whether unattributed body lines are verse or prose. */
  kind?: DocKind;
}

export interface StructureResult {
  blocks: Block[];
  lines: Line[];
  roles: Role[];
}

// ---------------------------------------------------------------- line patterns

const SCENE_HEADING_RE = /^(\d{1,3}[A-Z]?\s+)?(INT\.?|EXT\.?|EST\.?|I\/E\.?)[\s.]/iu;

const NUMBER_WORDS =
  'ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN';
/**
 * The trailing group is deliberately anchored on a separator: it lets
 * `SCENE III. A room in the castle.` through while rejecting the dialogue line
 * `Act one moment of kindness and everything changes.`
 */
const SECTION_HEADING_RE = new RegExp(
  `^(ACT|SCENE|PROLOGUE|EPILOGUE|INTERMISSION)\\s+([IVXLCDM]+|\\d{1,3}|${NUMBER_WORDS})` +
    '(\\s*[.:;—–-].*)?$',
  'iu',
);
const BARE_SECTION_RE = /^(PROLOGUE|EPILOGUE|INTERMISSION|DRAMATIS PERSONAE)\.?:?$/iu;

const TRANSITIONS = new Set([
  'fade in',
  'fade out',
  'fade to black',
  'cut to',
  'smash cut to',
  'match cut to',
  'dissolve to',
  'the end',
  'blackout',
  'curtain',
  'end of act',
]);

const LYRIC_LABEL_RE = new RegExp(
  '^[\\[(]?\\s*(intro|verse|pre[- ]?chorus|chorus|hook|refrain|bridge|middle\\s*8|break|' +
    'instrumental|solo|interlude|outro|coda|tag|vamp|reprise)' +
    '\\s*(\\d{1,2})?\\s*(?::\\s*([^\\])]+?))?\\s*[\\])]?\\s*:?$',
  'iu',
);

const PAREN_LINE_RE = /^\(.*\)[.,;]?$/su;
const BRACKET_LINE_RE = /^\[.*\][.,;]?$/su;

/** §7.5 `NAME:` prefix. The name may not contain a colon, so `9:30` cannot start one. */
const COLON_CUE_RE = /^([^\s:][^:]{0,39}):\s+(\S.*)$/u;
/** §7.5 `NAME.` prefix — Shakespeare in Arden/Penguin setting. */
const DOT_CUE_RE = /^([A-Z][\p{L}'’.\- ]{1,28})\.\s+(\p{Lu}|\p{Lu}?['"“])/u;

const COLON_BLOCKLIST = new Set(
  (
    'note warning caution nb ps re fwd subject from to date time act scene chorus verse ' +
    'bridge intro outro tempo key capo tuning source translation http https www'
  ).split(' '),
);

const ABBREVIATIONS = new Set(
  'mr mrs ms dr st jr sr prof rev capt sgt lt no vol ch fig op col gen fr'.split(' '),
);

const ARTIFACT_RES = [
  /^\(?(page\s*)?\d{1,4}(\s*of\s*\d{1,4})?\)?\.?$/iu,
  /^\d{1,3}[a-z]?\.$/iu,
  /^\(?(MORE|CONTINUED|CONT'?D)\)?\.?$/iu,
  /^(Rev\.?|Revised)\s+\d/iu,
  /^[*|_\-—–\s]+$/u,
  /^\d+$/u,
];

const CUE_SUFFIX_PRESENT_RE = /\((?:CONT'?D|CONTINUED|V\.?\s?O\.?|O\.?\s?S\.?|O\.?\s?C\.?)\)\s*$/iu;

// ---------------------------------------------------------------- small predicates

function words(text: string): string[] {
  const t = text.trim();
  return t === '' ? [] : t.split(/\s+/u);
}

/** ≥2 cased letters and an uppercase ratio ≥0.9 (§7.5). */
export function isAllCapsText(text: string): boolean {
  const upper = text.match(/\p{Lu}/gu)?.length ?? 0;
  const lower = text.match(/\p{Ll}/gu)?.length ?? 0;
  const cased = upper + lower;
  return cased >= 2 && upper / cased >= 0.9;
}

function hasLowercaseWord(text: string): boolean {
  return /\p{Ll}{2,}/u.test(text);
}

export function isSceneHeadingLine(text: string): boolean {
  return SCENE_HEADING_RE.test(text);
}

export function isSectionHeadingLine(text: string): boolean {
  return SECTION_HEADING_RE.test(text) || BARE_SECTION_RE.test(text);
}

export function isTransitionLine(text: string): boolean {
  if (!isAllCapsText(text)) return false;
  const bare = text
    .replace(/[.:]+$/u, '')
    .trim()
    .toLowerCase();
  return TRANSITIONS.has(bare) || /\bto:$/iu.test(text.trim());
}

function isArtifactLine(text: string): boolean {
  return ARTIFACT_RES.some((re) => re.test(text));
}

function colonCueName(text: string): string | null {
  const m = COLON_CUE_RE.exec(text);
  if (!m) return null;
  const name = (m[1] ?? '').trim();
  if (name === '' || words(name).length > 5) return null;
  if (/[.,;!?]$/u.test(name)) return null;
  if (/\d$/u.test(name)) return null;
  const key = roleNameKey(name);
  if (key === '' || COLON_BLOCKLIST.has(key)) return null;
  return name;
}

function dotCueName(text: string): string | null {
  const m = DOT_CUE_RE.exec(text);
  if (!m) return null;
  const name = (m[1] ?? '').trim();
  if (name === '' || words(name).length > 5) return null;
  const key = roleNameKey(name);
  if (key === '' || ABBREVIATIONS.has(key) || COLON_BLOCKLIST.has(key)) return null;
  return name;
}

/**
 * Shape class used by "apply to all lines like this" (§7.5) — the signal that actually
 * misfired, so the generalisation matches the user's mental model of "lines like this".
 */
export type LineSignal =
  | 'parenthesised'
  | 'bracketed'
  | 'sceneHeading'
  | 'sectionHeading'
  | 'transition'
  | 'colonPrefix'
  | 'dotPrefix'
  | 'artifact'
  | 'plain';

export function lineSignalOf(text: string): LineSignal {
  const t = text.trim();
  if (isSceneHeadingLine(t)) return 'sceneHeading';
  if (isTransitionLine(t)) return 'transition';
  if (isSectionHeadingLine(t) || LYRIC_LABEL_RE.test(t)) return 'sectionHeading';
  if (PAREN_LINE_RE.test(t)) return 'parenthesised';
  if (BRACKET_LINE_RE.test(t)) return 'bracketed';
  if (isArtifactLine(t)) return 'artifact';
  if (colonCueName(t) !== null) return 'colonPrefix';
  if (dotCueName(t) !== null) return 'dotPrefix';
  return 'plain';
}

// ---------------------------------------------------------------- preparation

interface Prepped {
  text: string;
  blank: boolean;
  indentPt: number | null;
  indentEm: number;
  italic: boolean;
  styleType: TrustedStyle | null;
  allCaps: boolean;
}

/** Expanded tab width when there is no geometry to harvest. */
const TAB_WIDTH = 4;

function leadingSpaceCount(raw: string): number {
  let n = 0;
  for (const ch of raw) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += TAB_WIDTH;
    else break;
  }
  return n;
}

/**
 * §7.6 — quantise into 0/1/2/3 so harvested-point noise does not produce ragged output.
 * Thresholds are relative to the document's own left edge.
 */
function indentBucket(relativePt: number | null, spaces: number): number {
  if (relativePt !== null) {
    if (relativePt < 18) return 0;
    if (relativePt < 54) return 1;
    if (relativePt < 108) return 2;
    return 3;
  }
  if (spaces < 2) return 0;
  if (spaces < 4) return 1;
  if (spaces < 8) return 2;
  return 3;
}

function prepare(input: readonly StructureInputLine[], hints: StructureHints): Prepped[] {
  const geometry = hints.hasGeometry;
  const indents: number[] = [];
  for (const line of input) {
    if (line.text.trim() === '') continue;
    if (geometry && typeof line.indentPt === 'number') indents.push(line.indentPt);
  }
  const baseIndent = indents.length > 0 ? Math.min(...indents) : 0;

  return input.map((line) => {
    const text = line.text.trim();
    const blank = text === '';
    const indentPt = geometry && typeof line.indentPt === 'number' ? line.indentPt : null;
    const spaces = leadingSpaceCount(line.text);
    return {
      text,
      blank,
      indentPt,
      indentEm: blank ? 0 : indentBucket(indentPt === null ? null : indentPt - baseIndent, spaces),
      italic: line.italic === true,
      styleType: line.styleType ?? null,
      allCaps: !blank && isAllCapsText(text),
    };
  });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

// ---------------------------------------------------------------- detection

type Detected =
  | { kind: 'heading'; confidence: number; artist: string | null }
  | { kind: 'direction'; confidence: number }
  | { kind: 'allcapsCue'; label: string; name: string; score: number }
  | { kind: 'colonCue'; label: string; name: string }
  | { kind: 'dotCue'; label: string; name: string }
  | { kind: 'body' };

interface DocContext {
  /** Only set when `hasGeometry` — the +0.30 indentation boost (§7.5). */
  cueIndentThreshold: number | null;
  /** ALLCAPS tokens that also occur inside mixed-case lines (the −0.30 rule). */
  capsTokensInProse: Set<string>;
}

function buildContext(prepped: Prepped[], hints: StructureHints): DocContext {
  const capsTokensInProse = new Set<string>();
  for (const p of prepped) {
    if (p.blank || p.allCaps) continue;
    for (const w of words(p.text)) {
      const core = w.replace(/[^\p{L}]/gu, '');
      if (core.length >= 2 && !/\p{Ll}/u.test(core)) capsTokensInProse.add(core.toUpperCase());
    }
  }

  let cueIndentThreshold: number | null = null;
  if (hints.hasGeometry) {
    const indents = prepped.filter((p) => !p.blank && p.indentPt !== null).map((p) => p.indentPt!);
    // Half an inch clear of the body is the narrowest real screenplay cue offset.
    if (indents.length >= 4) cueIndentThreshold = median(indents) + 36;
  }
  return { cueIndentThreshold, capsTokensInProse };
}

/** The §7.5 ALLCAPS score table, in table order. */
function scoreAllCapsCue(
  p: Prepped,
  prevBlank: boolean,
  nextNonBlank: Prepped | null,
  ctx: DocContext,
): number {
  const body = stripCueSuffix(p.text).replace(/:$/u, '').trim();
  const wordCount = words(body).length;
  const last = p.text.at(-1) ?? '';

  let s = 0.3; // ALL-CAPS — the caller has already checked it
  if (p.text.length <= 40 && wordCount <= 5) s += 0.15;
  if (last !== '.' && last !== ',') s += 0.1;
  if (nextNonBlank !== null && !nextNonBlank.allCaps) s += 0.15;
  if (prevBlank) s += 0.1;
  if (
    ctx.cueIndentThreshold !== null &&
    p.indentPt !== null &&
    p.indentPt >= ctx.cueIndentThreshold
  )
    s += 0.3;
  if (CUE_SUFFIX_PRESENT_RE.test(p.text)) s += 0.2;

  // Real cues never end in them; without this a son shouting MOTHER! steals his own speech.
  if (last === '!' || last === '?') s -= 0.35;
  if (isSceneHeadingLine(p.text) || isSectionHeadingLine(p.text) || isTransitionLine(p.text))
    s -= 0.9;
  if (wordCount >= 6 || hasLowercaseWord(body)) s -= 0.5;
  if (isArtifactLine(p.text)) s -= 0.9;
  if (
    wordCount >= 3 &&
    words(body).some((w) => ctx.capsTokensInProse.has(w.replace(/[^\p{L}]/gu, '')))
  )
    s -= 0.3;

  return s;
}

function detectLine(
  p: Prepped,
  prevBlank: boolean,
  nextNonBlank: Prepped | null,
  ctx: DocContext,
): Detected {
  const t = p.text;

  if (p.styleType !== null) {
    switch (p.styleType) {
      case 'character':
        return {
          kind: 'allcapsCue',
          label: t,
          name: stripCueSuffix(t).replace(/:$/u, ''),
          score: 1,
        };
      case 'parenthetical':
        return { kind: 'direction', confidence: 1 };
      case 'heading':
      case 'transition':
        return { kind: 'heading', confidence: 1, artist: null };
      default:
        return { kind: 'body' };
    }
  }

  if (isSceneHeadingLine(t)) return { kind: 'heading', confidence: 0.95, artist: null };
  if (isTransitionLine(t)) return { kind: 'heading', confidence: 0.9, artist: null };
  if (isSectionHeadingLine(t)) return { kind: 'heading', confidence: 0.9, artist: null };

  const lyric = LYRIC_LABEL_RE.exec(t);
  if (lyric) {
    // §7.5: `[Verse 1: Artist]` keeps the label, drops the artist, records the artist as a speaker.
    const artist = (lyric[3] ?? '').trim();
    return { kind: 'heading', confidence: 0.9, artist: artist === '' ? null : artist };
  }

  if (PAREN_LINE_RE.test(t) || BRACKET_LINE_RE.test(t))
    return { kind: 'direction', confidence: 0.85 };
  if (p.italic) return { kind: 'direction', confidence: 0.8 };

  const colon = colonCueName(t);
  if (colon !== null) return { kind: 'colonCue', label: `${colon}:`, name: colon };

  const dot = dotCueName(t);
  if (dot !== null) return { kind: 'dotCue', label: `${dot}.`, name: dot };

  if (p.allCaps) {
    const score = scoreAllCapsCue(p, prevBlank, nextNonBlank, ctx);
    const label = t;
    const name = stripCueSuffix(t).replace(/:$/u, '').trim();
    if (name !== '') return { kind: 'allcapsCue', label, name, score };
  }

  return { kind: 'body' };
}

// ---------------------------------------------------------------- resolution

interface LineClass {
  type: BlockType;
  speakerId: string | null;
  speakerLabel: string | null;
  confidence: number;
  /** Headings and standalone cue labels are always a block of their own. */
  solo: boolean;
}

function inferBodyType(prepped: Prepped[], hints: StructureHints): BlockType {
  const kind = hints.kind;
  if (kind === 'poem' || kind === 'lyrics') return 'verse';
  if (kind !== undefined) return 'paragraph';
  const content = prepped.filter((p) => !p.blank);
  if (content.length === 0) return 'paragraph';
  const short = content.filter((p) => p.text.length <= 60).length;
  return short / content.length >= 0.8 ? 'verse' : 'paragraph';
}

function resolve(prepped: Prepped[], hints: StructureHints): (LineClass | null)[] {
  const ctx = buildContext(prepped, hints);
  const bodyType = inferBodyType(prepped, hints);

  // ---- pass 1: per-line signals
  const detected: (Detected | null)[] = prepped.map((p, i) => {
    if (p.blank) return null;
    let prevBlank = i === 0;
    for (let j = i - 1; j >= 0; j--) {
      const q = prepped[j];
      if (!q) continue;
      prevBlank = q.blank;
      break;
    }
    let nextNonBlank: Prepped | null = null;
    for (let j = i + 1; j < prepped.length; j++) {
      const q = prepped[j];
      if (q && !q.blank) {
        nextNonBlank = q;
        break;
      }
    }
    return detectLine(p, prevBlank, nextNonBlank, ctx);
  });

  // ---- pass 2: recurrence. One count map across all three detectors, so a name that
  // appears once as `MARY` and once as `MARY:` still recurs.
  const nameCounts = new Map<string, number>();
  let colonCandidates = 0;
  let contentCount = 0;
  const colonNames = new Set<string>();
  const dotNames = new Set<string>();
  for (let i = 0; i < detected.length; i++) {
    const d = detected[i];
    if (d === null || d === undefined) continue;
    contentCount += 1;
    if (d.kind === 'allcapsCue' && d.score >= CUE_REJECT_BELOW) {
      bump(nameCounts, roleNameKey(d.name));
    } else if (d.kind === 'colonCue') {
      bump(nameCounts, roleNameKey(d.name));
      colonNames.add(roleNameKey(d.name));
      colonCandidates += 1;
    } else if (d.kind === 'dotCue') {
      bump(nameCounts, roleNameKey(d.name));
      dotNames.add(roleNameKey(d.name));
    }
  }

  // §7.5 guard 2: >8 singleton ALLCAPS candidates means a titled collection, not a cast.
  let allcapsSingletons = 0;
  for (const d of detected) {
    if (d && d.kind === 'allcapsCue' && d.score >= CUE_REJECT_BELOW) {
      if ((nameCounts.get(roleNameKey(d.name)) ?? 0) < 2) allcapsSingletons += 1;
    }
  }
  const titledCollection = allcapsSingletons > 8;

  // §7.5: distinct prefixed names covering ≥35% of non-blank lines rescues singletons.
  // The plan says ≥3 distinct names; two is enough when they also carry a third of the
  // document, because that is a two-hander — and a two-hander in `NAME:` form is common
  // enough that requiring three would silently drop every one of them to prose.
  const colonDocument =
    colonNames.size >= 2 && contentCount > 0 && colonCandidates / contentCount >= 0.35;
  // Added guard (not in the plan): `Well. I told you.` is ordinary prose, so a dotted cue
  // is only trusted in a document that has at least two distinct dotted speakers.
  const dotDocument = dotNames.size >= 2;

  // ---- pass 3: final classes
  const classes: (LineClass | null)[] = [];
  let currentSpeaker: { id: string; label: string } | null = null;
  let lyricSpeaker: { id: string; label: string } | null = null;

  for (let i = 0; i < prepped.length; i++) {
    const p = prepped[i];
    const d = detected[i];
    if (!p || p.blank || d === null || d === undefined) {
      classes.push(null);
      currentSpeaker = null; // a blank line ends the current speech
      continue;
    }

    switch (d.kind) {
      case 'heading': {
        currentSpeaker = null;
        // A `[Verse 2: JOHN]` label hands the following lines to JOHN; a bare `[Chorus]`
        // (or any other heading) ends whatever attribution was running.
        if (d.artist !== null) lyricSpeaker = { id: roleIdFor(d.artist), label: d.artist };
        else if (LYRIC_LABEL_RE.test(p.text)) lyricSpeaker = null;
        classes.push({
          type: 'heading',
          speakerId: null,
          speakerLabel: null,
          confidence: d.confidence,
          solo: true,
        });
        break;
      }
      case 'direction': {
        classes.push({
          type: 'direction',
          speakerId: currentSpeaker?.id ?? null,
          speakerLabel: currentSpeaker?.label ?? null,
          confidence: d.confidence,
          solo: false,
        });
        break;
      }
      case 'allcapsCue': {
        const key = roleNameKey(d.name);
        const recurs = (nameCounts.get(key) ?? 0) >= 2;
        const accepted = d.score >= CUE_REJECT_BELOW && recurs;
        if (accepted) {
          currentSpeaker = { id: roleIdFor(d.name), label: d.label };
          classes.push({
            type: 'label',
            speakerId: currentSpeaker.id,
            speakerLabel: currentSpeaker.label,
            confidence: clamp(d.score, 0, 1),
            solo: true,
          });
        } else if (titledCollection || d.score >= CUE_CONFIDENCE_FLOOR) {
          // A singleton that still looks like a standalone label is a title/heading (§7.5).
          currentSpeaker = null;
          classes.push({
            type: 'heading',
            speakerId: null,
            speakerLabel: null,
            confidence: clamp(d.score, 0, 1),
            solo: true,
          });
        } else {
          classes.push(bodyClass(bodyType, currentSpeaker ?? lyricSpeaker));
        }
        break;
      }
      case 'colonCue': {
        const key = roleNameKey(d.name);
        const recurs = (nameCounts.get(key) ?? 0) >= 2;
        if (recurs || colonDocument) {
          currentSpeaker = { id: roleIdFor(d.name), label: d.label };
          classes.push({
            type: 'dialogue',
            speakerId: currentSpeaker.id,
            speakerLabel: currentSpeaker.label,
            confidence: 0.85,
            solo: false,
          });
        } else {
          // A one-off `Something:` is NOT a speaker, however many other names the document
          // has. `That flesh is heir to:` in the middle of a soliloquy matches the cue
          // pattern perfectly, and the recurrence guard is the only thing standing between
          // it and a phantom character. §7.5, and the algorithm critic's counter-example.
          classes.push(bodyClass(bodyType, currentSpeaker ?? lyricSpeaker));
        }
        break;
      }
      case 'dotCue': {
        const key = roleNameKey(d.name);
        const recurs = (nameCounts.get(key) ?? 0) >= 2;
        if (recurs && dotDocument) {
          currentSpeaker = { id: roleIdFor(d.name), label: d.label };
          classes.push({
            type: 'dialogue',
            speakerId: currentSpeaker.id,
            speakerLabel: currentSpeaker.label,
            confidence: 0.85,
            solo: false,
          });
        } else {
          classes.push(bodyClass(bodyType, currentSpeaker ?? lyricSpeaker));
        }
        break;
      }
      default: {
        classes.push(bodyClass(bodyType, currentSpeaker ?? lyricSpeaker));
        break;
      }
    }
  }

  return classes;
}

function bump(map: Map<string, number>, key: string): void {
  if (key === '') return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function bodyClass(bodyType: BlockType, speaker: { id: string; label: string } | null): LineClass {
  return {
    // A body line under a cue is that speaker's dialogue; otherwise it is prose or verse.
    type: speaker ? 'dialogue' : bodyType,
    speakerId: speaker?.id ?? null,
    speakerLabel: speaker?.label ?? null,
    confidence: speaker ? 0.85 : 0.8,
    solo: false,
  };
}

// ---------------------------------------------------------------- assembly

/**
 * Blank input lines are separators, not content: they are dropped here so that every
 * emitted Line belongs to exactly one Block and `Line.idx` is the output index.
 */
function assemble(
  prepped: Prepped[],
  classes: (LineClass | null)[],
): {
  blocks: Block[];
  lines: Line[];
} {
  const lines: Line[] = [];
  const blocks: Block[] = [];
  const hashCounts = new Map<string, number>();
  let boundary = true;
  let openSolo = false;

  for (let i = 0; i < prepped.length; i++) {
    const p = prepped[i];
    const c = classes[i];
    if (!p || p.blank || !c) {
      boundary = true;
      continue;
    }

    const base = lineFingerprint(p.text);
    const ordinal = hashCounts.get(base) ?? 0;
    hashCounts.set(base, ordinal + 1);

    const idx = lines.length;
    const line: Line = {
      idx,
      blockIdx: 0,
      text: p.text,
      tokens: [],
      fingerprint: `${base}:${ordinal}`,
      indentEm: p.indentEm,
    };
    lines.push(line);

    const open = blocks.at(-1);
    const startNew =
      boundary ||
      open === undefined ||
      openSolo ||
      c.solo ||
      open.type !== c.type ||
      open.speakerId !== c.speakerId;

    if (startNew) {
      blocks.push({
        idx: blocks.length,
        type: c.type,
        speakerId: c.speakerId,
        speakerLabel: c.speakerLabel,
        lineIdxs: [idx],
        confidence: c.confidence,
      });
    } else {
      open.lineIdxs.push(idx);
      open.confidence = Math.min(open.confidence, c.confidence);
    }
    const current = blocks.at(-1);
    if (current) line.blockIdx = current.idx;
    boundary = false;
    openSolo = c.solo;
  }

  return { blocks, lines };
}

// ---------------------------------------------------------------- entry point

export function detectStructure(
  input: readonly StructureInputLine[],
  hints: StructureHints,
): StructureResult {
  const prepped = prepare(input, hints);
  const classes = resolve(prepped, hints);
  const { blocks, lines } = assemble(prepped, classes);

  const roles = buildRoles(blocks, lines);

  // Alias merging can fold `HAM.` into `HAMLET`; the blocks must point at the survivor,
  // because role isolation (§7.8) looks a token's role up by `Block.speakerId`.
  const canonical = new Map<string, string>();
  for (const role of roles) {
    canonical.set(role.id, role.id);
    for (const alias of role.aliases) canonical.set(roleIdFor(alias), role.id);
  }
  for (const block of blocks) {
    if (block.speakerId === null) continue;
    block.speakerId = canonical.get(block.speakerId) ?? block.speakerId;
  }

  return { blocks, lines, roles };
}
