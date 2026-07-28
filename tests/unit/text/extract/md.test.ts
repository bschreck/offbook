import { describe, expect, it } from 'vitest';
import { extractMarkdown } from '../../../../src/core/text/extract/md';

const DOC = [
  '---',
  'title: From Frontmatter',
  '---',
  '',
  '# Friends, Romans',
  '',
  'Lend me your **ears**; I come to _bury_ Caesar,',
  'not to ~~praise~~ him.',
  '',
  '## The [second](https://example.com/x) part',
  '',
  '- one item',
  '- two item',
  '',
  '> quoted line',
  '',
  '```js',
  'const secret = "DO_NOT_IMPORT";',
  '```',
  '',
  'Done `inline` here, see <https://example.com>.',
  '',
].join('\n');

describe('extractMarkdown', () => {
  it('strips headings, emphasis, links and fences while keeping line structure', () => {
    const { text } = extractMarkdown(DOC);
    expect(text.split('\n')).toEqual([
      'Friends, Romans',
      '',
      'Lend me your ears; I come to bury Caesar,',
      'not to him.',
      '',
      'The second part',
      '',
      'one item',
      'two item',
      '',
      'quoted line',
      '',
      'Done inline here, see https://example.com.',
    ]);
  });

  it('drops fenced code entirely', () => {
    expect(extractMarkdown(DOC).text).not.toContain('DO_NOT_IMPORT');
  });

  it('prefers the first heading over the frontmatter title', () => {
    expect(extractMarkdown(DOC).title).toBe('Friends, Romans');
    expect(extractMarkdown('---\ntitle: Only Here\n---\n\nbody text\n').title).toBe('Only Here');
    expect(extractMarkdown('plain body\n', 'my-speech.md').title).toBe('my speech');
  });

  it('warns when fenced code took most of the file', () => {
    const codeHeavy = ['# T', '', '```', 'x'.repeat(400), '```', ''].join('\n');
    expect(extractMarkdown(codeHeavy).warnings.join(' ')).toMatch(/fenced code/i);
  });

  it('warns about an unclosed fence', () => {
    const { warnings } = extractMarkdown('# T\n\n```\nnever closed\n');
    expect(warnings.join(' ')).toMatch(/never closed/i);
  });

  it('keeps setext heading text but drops the underline and horizontal rules', () => {
    const { text } = extractMarkdown('Big Title\n=========\n\nbody\n\n***\n\nmore\n');
    expect(text.split('\n')).toEqual(['Big Title', '', 'body', '', 'more']);
  });

  it('leaves underscores inside words alone', () => {
    expect(extractMarkdown('call snake_case_name now').text).toBe('call snake_case_name now');
  });

  it('preserves leading indentation on verse lines', () => {
    const { text } = extractMarkdown('First line\n    Indented *second* line');
    expect(text.split('\n')[1]).toBe('    Indented second line');
  });

  it('drops images and link reference definitions but keeps reference link text', () => {
    const { text } = extractMarkdown('See ![cover](a.png)the [play][ref].\n\n[ref]: http://x.y\n');
    expect(text).toBe('See the play.');
  });
});
