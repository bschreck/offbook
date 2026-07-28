import { describe, expect, it } from 'vitest';
import { decodeEntities, extractHtml } from '../../../../src/core/text/extract/html';

const GENIUS_PASTE = [
  '<!DOCTYPE html>',
  '<html><head>',
  '<title>Bohemian Rhapsody | Queen</title>',
  '<style>.Lyrics__Container{color:red;content:"NEVER"}</style>',
  '<script>window.__PRELOADED__={"body":"SCRIPT_LEAK"};</script>',
  '</head>',
  '<body>',
  '<div class="Lyrics__Container" data-lyrics="1">',
  '[Intro]<br>',
  'Is this the real life?<br>',
  'Is this just fantasy?<br>',
  '<br>',
  'Caught in a landslide<br>',
  'No escape from <i>reality</i>',
  '</div>',
  '<script>trackPageView();</script>',
  '</body></html>',
].join('\n');

describe('extractHtml', () => {
  it('keeps one line per lyric line for a Genius-style paste', () => {
    const { text } = extractHtml(GENIUS_PASTE);
    expect(text.split('\n')).toEqual([
      '[Intro]',
      'Is this the real life?',
      'Is this just fantasy?',
      '',
      'Caught in a landslide',
      'No escape from reality',
    ]);
  });

  it('never emits script or style content', () => {
    const { text } = extractHtml(GENIUS_PASTE);
    expect(text).not.toContain('SCRIPT_LEAK');
    expect(text).not.toContain('trackPageView');
    expect(text).not.toContain('NEVER');
  });

  it('takes the title from <title>, and from <h1> when there is none', () => {
    expect(extractHtml(GENIUS_PASTE).title).toBe('Bohemian Rhapsody | Queen');
    expect(extractHtml('<article><h1>Act I</h1><p>Enter.</p></article>').title).toBe('Act I');
    expect(extractHtml('<p>no title</p>', 'the_tempest.html').title).toBe('the tempest');
  });

  it('decodes named, numeric and hex entities', () => {
    const { text } = extractHtml(
      '<p>Caf&eacute; &amp; bar &mdash; &#39;yes&#39; &#x2014;&nbsp;end &Eacute;t&eacute;</p>',
    );
    expect(text).toBe("Café & bar — 'yes' — end Été");
  });

  it('leaves an unknown or malformed entity as written', () => {
    expect(decodeEntities('a &notarealentity; b &#xZZ; c')).toBe('a &notarealentity; b &#xZZ; c');
  });

  it('does not eat the spaces around nested inline tags', () => {
    const { text } = extractHtml(
      '<p>The <b>quick <i>brown</i></b> <span>fox</span> is un<b>believ</b>able</p>',
    );
    expect(text).toBe('The quick brown fox is unbelievable');
  });

  it('breaks on block elements even without <br>', () => {
    const { text } = extractHtml('<div><p>One</p><p>Two</p><ul><li>Three</li></ul></div>');
    expect(text.split('\n').filter((l) => l !== '')).toEqual(['One', 'Two', 'Three']);
  });

  it('ignores comments, doctypes and stray angle brackets', () => {
    const { text } = extractHtml('<p>5 &lt; 6 <!-- hidden --> and 7 > 6</p>');
    expect(text).toBe('5 < 6 and 7 > 6');
  });

  it('does not mistake an attribute value containing ">" for the end of a tag', () => {
    const { text } = extractHtml('<p title="a > b">kept</p>');
    expect(text).toBe('kept');
  });

  it('collapses runaway blank lines from empty wrapper divs', () => {
    const { text } = extractHtml('<div>A</div><div></div><div></div><div></div><div>B</div>');
    expect(text).toBe('A\nB');
  });
});
