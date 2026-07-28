import { describe, expect, it } from 'vitest';
import {
  extractTxt,
  normalizePlainText,
  titleFromFileName,
} from '../../../../src/core/text/extract/txt';

describe('normalizePlainText', () => {
  it('strips the BOM and normalises CRLF and CR', () => {
    expect(normalizePlainText('﻿a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('strips trailing spaces but keeps blank runs for the CLEAN stage to judge', () => {
    expect(normalizePlainText('a   \n\n\n\nb')).toBe('a\n\n\n\nb');
  });

  it('trims leading and trailing blank lines', () => {
    expect(normalizePlainText('\n\n  \nhello\n\n\n')).toBe('hello');
  });
});

describe('titleFromFileName', () => {
  it('prettifies a file name and returns null when there is nothing to use', () => {
    expect(titleFromFileName('/tmp/act_one-scene_2.txt')).toBe('act one scene 2');
    expect(titleFromFileName(undefined)).toBeNull();
    expect(titleFromFileName('.txt')).toBeNull();
  });
});

describe('extractTxt', () => {
  it('passes text through untouched apart from line endings', () => {
    const result = extractTxt('Line one\r\nLine two\n', 'speech.txt');
    expect(result).toEqual({
      text: 'Line one\nLine two',
      title: 'speech',
      source: { format: 'txt', name: 'speech.txt', hasGeometry: false },
      warnings: [],
    });
  });
});
