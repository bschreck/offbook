import { describe, expect, it } from 'vitest';
import {
  cleanForSniff,
  RULE_ORDER,
  runCleanup,
  splitLines,
} from '../../../src/core/text/clean/pipeline';
import {
  type CleanupHints,
  dropArtifacts,
  normalise,
  punctuation,
  unwrap,
  whitespace,
} from '../../../src/core/text/clean/rules';
import { type CleanupConfig, DEFAULT_CLEANUP } from '../../../src/core/text/types';

const PROSE_HINTS: CleanupHints = { kind: 'speech', lineBreaksAreSemantic: false };

describe('normalise', () => {
  it('produces NFC, which the tokenizer requires as a precondition', () => {
    const decomposed = 'café naı̈ve';
    const { lines } = normalise([decomposed]);
    expect(lines[0]).toBe(decomposed.normalize('NFC'));
    expect(lines[0]?.normalize('NFC')).toBe(lines[0]);
  });

  it('strips a BOM, zero-width characters and control characters', () => {
    const { lines, changed } = normalise(['\uFEFFto\u200Bbe\u0007 or not']);
    expect(lines[0]).toBe('tobe or not');
    expect(changed).toBe(1);
  });

  it('keeps ZWJ, which welds emoji and Indic clusters', () => {
    const { lines } = normalise(['a\u200Db']);
    expect(lines[0]).toBe('a\u200Db');
  });

  it('converts exotic spaces to plain spaces and hyphen variants to hyphen-minus', () => {
    const { lines, notes } = normalise(['one\u00A0two\u2009three', 'in\u2011built \u2212 five']);
    expect(lines[0]).toBe('one two three');
    expect(lines[1]).toBe('in-built - five');
    expect(notes.join(' ')).toContain('exotic space');
  });

  it('keeps en and em dashes distinct from hyphens', () => {
    const { lines } = normalise(['a – b — c']);
    expect(lines[0]).toBe('a – b — c');
  });

  it('expands the fi-family ligatures but leaves the soft hyphen for de-hyphenation', () => {
    const { lines } = normalise(['\uFB01ne o\uFB03ce depart\u00ADment']);
    expect(lines[0]).toBe('fine office depart\u00ADment');
    expect(lines[0]).toContain('\u00AD');
  });

  it('counts only the lines it actually changed', () => {
    const { changed } = normalise(['clean line', 'dirty\u00A0line', 'also clean']);
    expect(changed).toBe(1);
  });
});

describe('punctuation', () => {
  it('straightens curly quotes, apostrophes and ellipses', () => {
    const { lines, changed } = punctuation(['“I can’t…” she said']);
    expect(lines[0]).toBe('"I can\'t..." she said');
    expect(changed).toBe(1);
  });

  it('straightens guillemets and low quotes', () => {
    const { lines } = punctuation(['«bonjour» „guten Tag“']);
    expect(lines[0]).toBe('"bonjour" "guten Tag"');
  });

  it('treats an acute between letters as a mistyped apostrophe, but not a standalone one', () => {
    const { lines } = punctuation(['can´t', '´ alone ´']);
    expect(lines[0]).toBe("can't");
    expect(lines[1]).toBe('´ alone ´');
  });
});

describe('whitespace', () => {
  it('preserves leading indentation because verse depends on it', () => {
    const { lines } = whitespace(['    Sweet day,  so cool', '\t\tso calm,  so bright']);
    expect(lines[0]).toBe('    Sweet day, so cool');
    expect(lines[1]).toBe('\t\tso calm, so bright');
  });

  it('collapses intra-line runs and strips trailing space', () => {
    const { lines, changed } = whitespace(['to    be\tor  not to be   ']);
    expect(lines[0]).toBe('to be or not to be');
    expect(changed).toBe(1);
  });

  it('caps consecutive blank lines at one', () => {
    const { lines, notes } = whitespace(['a', '', '   ', '\t', 'b', '', 'c']);
    expect(lines).toEqual(['a', '', 'b', '', 'c']);
    expect(notes.join(' ')).toContain('2 blank line');
  });

  it('leaves already-clean text untouched', () => {
    const input = ['  indented line', '', 'plain line'];
    const { lines, changed } = whitespace(input);
    expect(lines).toEqual(input);
    expect(changed).toBe(0);
  });
});

describe('dropArtifacts', () => {
  const paste = [
    'THE TEMPEST',
    'MIRANDA',
    'If by your art, my dearest father, you have',
    'Put the wild waters in this roar, allay them.',
    '',
    'PROSPERO',
    'Be collected:',
    'No more amazement: tell your piteous heart',
    'Page 1',
    'THE TEMPEST',
    "There's no harm done.",
    'MIRANDA',
    'O, woe the day!',
    'PROSPERO',
    'No harm.',
    'I have done nothing but in care of thee,',
    '2',
    'THE TEMPEST',
    'Of thee, my dear one, thee my daughter, who',
    'Art ignorant of what thou art, nought knowing',
    'Of whence I am, nor that I am more better',
    'Than Prospero, master of a full poor cell,',
    '3 of 47',
    'THE TEMPEST',
    'And thy no greater father.',
  ];

  it('drops page numbers, "N of M" and repeated running headers', () => {
    const { lines, notes } = dropArtifacts(paste);
    expect(lines).not.toContain('Page 1');
    expect(lines).not.toContain('2');
    expect(lines).not.toContain('3 of 47');
    expect(lines).not.toContain('THE TEMPEST');
    expect(notes.some((n) => n.includes('recurring header/footer "THE TEMPEST"'))).toBe(true);
  });

  it('does not eat short lines of dialogue', () => {
    const { lines } = dropArtifacts(paste);
    expect(lines).toContain('No harm.');
    expect(lines).toContain('O, woe the day!');
    expect(lines).toContain('MIRANDA');
    expect(lines).toContain('PROSPERO');
    expect(lines).toContain('Be collected:');
  });

  it('leaves a short line that repeats irregularly alone', () => {
    const said = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    said[2] = 'Yes.';
    said[3] = 'Yes.';
    said[30] = 'Yes.';
    const { lines } = dropArtifacts(said);
    expect(lines.filter((l) => l === 'Yes.')).toHaveLength(3);
  });

  it('strips leading line numbers only when they ascend', () => {
    const numbered = ['1  HAMLET', '2  To be, or not to be', '12  that is the question'];
    expect(dropArtifacts(numbered).lines).toEqual([
      'HAMLET',
      'To be, or not to be',
      'that is the question',
    ]);
    const unordered = ['9  HAMLET', '2  To be', '5  that is the question'];
    expect(dropArtifacts(unordered).lines).toEqual(unordered);
  });

  it('drops (MORE) / (CONT’D) only as whole lines', () => {
    const { lines } = dropArtifacts(['(MORE)', "MARY (CONT'D)", 'CONTINUED']);
    expect(lines).toEqual(["MARY (CONT'D)"]);
  });

  it('drops lyrics-site scrape junk', () => {
    const { lines } = dropArtifacts([
      '12 Contributors',
      'You might also like',
      'Hey Jude',
      '5Embed',
    ]);
    expect(lines).toEqual(['Hey Jude']);
  });
});

describe('unwrap', () => {
  const wrapped = [
    'We shall go on to the end. We shall fight in France, we shall',
    'fight on the seas and oceans, we shall fight with growing confi-',
    'dence and growing strength in the air, we shall defend our island,',
    'whatever the cost may be. We shall fight on the beaches, we shall',
    'fight on the landing grounds, we shall fight in the fields and in the',
    'streets, we shall fight in the hills; we shall never surrender.',
  ];

  it('is off unless the sniffer says line breaks are cosmetic', () => {
    const { lines, changed, notes } = unwrap(wrapped);
    expect(lines).toEqual(wrapped);
    expect(changed).toBe(0);
    expect(notes[0]).toContain('skipped');
  });

  it('rejoins hard-wrapped prose and de-hyphenates across the join', () => {
    const { lines, changed, notes } = unwrap(wrapped, PROSE_HINTS);
    expect(lines.join('\n')).toContain('confidence and growing strength');
    expect(lines.length).toBeLessThan(wrapped.length);
    expect(changed).toBeGreaterThan(0);
    expect(notes.join(' ')).toContain('de-hyphenated');
  });

  it('leaves verse alone even when the hints allow prose unwrapping', () => {
    const sonnet = [
      "Shall I compare thee to a summer's day?",
      'Thou art more lovely and more temperate:',
      'Rough winds do shake the darling buds of May,',
      "And summer's lease hath all too short a date:",
    ];
    expect(unwrap(sonnet, { kind: 'poem', lineBreaksAreSemantic: false }).lines).toEqual(sonnet);
    expect(unwrap(sonnet, PROSE_HINTS).lines).toEqual(sonnet);
  });

  it('never joins across a cue, a heading or a list item', () => {
    const script = [
      'and then she said something quite long that runs right up to the margin',
      'HAMLET',
      'nothing at all',
      '# A heading',
      '- a list item',
    ];
    expect(unwrap(script, PROSE_HINTS).lines).toEqual(script);
  });

  it('keeps the hyphen when the second fragment is capitalised or a known prefix', () => {
    const hints = PROSE_HINTS;
    expect(unwrap(['the Anglo-', 'Saxon king'], hints).lines[0]).toBe('the Anglo-Saxon king');
    expect(unwrap(['a self-', 'evident truth'], hints).lines[0]).toBe('a self-evident truth');
    expect(unwrap(['a govern-', 'ment truth'], hints).lines[0]).toBe('a government truth');
  });

  it('joins and drops a soft hyphen, and removes leftover soft hyphens', () => {
    const { lines } = unwrap(['depart\u00AD', 'ment of pea\u00ADce'], PROSE_HINTS);
    expect(lines[0]).toBe('department of peace');
  });

  it('does not join when the next line is blank', () => {
    const { lines } = unwrap(['a broken-', '', 'start'], PROSE_HINTS);
    expect(lines).toEqual(['a broken-', '', 'start']);
  });
});

describe('runCleanup', () => {
  const source = '\uFEFFTHE  SPEECH\r\n\r\n\r\n“We shall fight…” he said,\nand we did.\nPage 2\n';

  it('is deterministic', () => {
    const a = runCleanup(source, DEFAULT_CLEANUP);
    const b = runCleanup(source, DEFAULT_CLEANUP);
    expect(a).toEqual(b);
  });

  it('does not depend on the key order of the config object', () => {
    const forwards: CleanupConfig = {
      normalise: true,
      punctuation: true,
      whitespace: true,
      dropArtifacts: true,
      unwrap: true,
    };
    const backwards: CleanupConfig = {
      unwrap: true,
      dropArtifacts: true,
      whitespace: true,
      punctuation: true,
      normalise: true,
    };
    expect(runCleanup(source, backwards, PROSE_HINTS)).toEqual(
      runCleanup(source, forwards, PROSE_HINTS),
    );
  });

  it('applies the rules in the fixed order regardless of config', () => {
    expect(RULE_ORDER).toEqual([
      'normalise',
      'punctuation',
      'whitespace',
      'dropArtifacts',
      'unwrap',
    ]);
  });

  it('reports every rule, with zero counts for the disabled ones', () => {
    const { perRule } = runCleanup(source, { ...DEFAULT_CLEANUP, punctuation: false });
    expect(Object.keys(perRule).sort()).toEqual([...RULE_ORDER].sort());
    expect(perRule.punctuation).toEqual({ changed: 0, notes: [] });
    expect(perRule.dropArtifacts.changed).toBe(1);
  });

  it('leaves the text untouched when every rule is off', () => {
    const allOff: CleanupConfig = {
      normalise: false,
      punctuation: false,
      whitespace: false,
      dropArtifacts: false,
      unwrap: false,
    };
    expect(runCleanup(source, allOff).lines).toEqual(splitLines(source));
  });

  it('cleans a realistic paste end to end', () => {
    const { lines } = runCleanup(source, DEFAULT_CLEANUP);
    expect(lines).toEqual(['THE SPEECH', '', '"We shall fight..." he said,', 'and we did.', '']);
  });

  it('cleanForSniff runs rules 1-4 and never unwraps', () => {
    const hardWrapped =
      'The quick brown fox jumped over the lazy dog and kept on running\n' +
      'until it reached the end of the very long sentence it was in.\n';
    expect(cleanForSniff(hardWrapped)).toHaveLength(3);
  });
});

describe('dropArtifacts — regressions found by importing a real script', () => {
  it('keeps interleaving character cues, which look exactly like running headers', () => {
    // ALGERNON and LANE each recur at a near-regular interval under 60 characters —
    // every other test for a running header passes on them. Interleaving is the signal
    // that they are a cast and not a page header.
    const scene = [
      'ALGERNON',
      'Did you hear what I was playing, Lane?',
      '',
      'LANE',
      'I didn’t think it polite to listen, sir.',
      '',
      'ALGERNON',
      'I’m sorry for that, for your sake.',
      '',
      'LANE',
      'Yes, sir.',
      '',
      'ALGERNON',
      'And have you got the cucumber sandwiches cut?',
      '',
      'LANE',
      'Yes, sir; eight bottles and a pint.',
    ];
    const { lines } = dropArtifacts(scene);
    expect(lines.filter((l) => l === 'ALGERNON')).toHaveLength(3);
    expect(lines.filter((l) => l === 'LANE')).toHaveLength(3);
  });

  it('still drops a lone running header in the same shape', () => {
    const paged: string[] = [];
    for (let page = 0; page < 4; page++) {
      paged.push('THE TEMPEST');
      for (let i = 0; i < 6; i++) paged.push(`Line ${page}-${i} of the scene, spoken aloud.`);
    }
    const { lines } = dropArtifacts(paged);
    expect(lines).not.toContain('THE TEMPEST');
  });
});
