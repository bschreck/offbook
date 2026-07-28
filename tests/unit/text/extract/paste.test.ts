import { describe, expect, it } from 'vitest';
import { extractPaste } from '../../../../src/core/text/extract/paste';

describe('extractPaste', () => {
  it('prefers text/html over text/plain, because plain text loses the line structure', () => {
    const result = extractPaste({
      html: '<div>Is this the real life?</div><div>Is this just fantasy?</div>',
      // What a lyrics site actually puts in the plain flavour: one reflowed paragraph.
      text: 'Is this the real life? Is this just fantasy?',
    });
    expect(result.text).toBe('Is this the real life?\nIs this just fantasy?');
    expect(result.source.format).toBe('paste');
    expect(result.warnings).toEqual([]);
  });

  it('carries a title through from the HTML flavour', () => {
    const result = extractPaste({ html: '<h1>Sonnet 18</h1><p>Shall I compare thee</p>' });
    expect(result.title).toBe('Sonnet 18');
  });

  it('still works with plain text only', () => {
    const result = extractPaste({ text: 'Line one\r\nLine two\r\n\r\nLine four   \n' });
    expect(result.text).toBe('Line one\nLine two\n\nLine four');
    expect(result.title).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('falls back to plain text with a warning when the HTML flavour has no words', () => {
    const result = extractPaste({
      html: '<meta charset="utf-8"><div><img src="cover.png"></div>',
      text: 'the actual words',
    });
    expect(result.text).toBe('the actual words');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/plain text/i);
  });

  it('returns an empty result for an empty clipboard rather than throwing', () => {
    expect(extractPaste({})).toEqual({
      text: '',
      title: null,
      source: { format: 'paste', hasGeometry: false },
      warnings: [],
    });
  });
});
