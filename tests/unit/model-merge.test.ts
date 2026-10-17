import { describe, expect, it } from 'vitest';
import { mergeModelFindings } from '../../src/core/model-merge.ts';
import { detect } from '../../src/core/detector.ts';
import { BUILTIN_PATTERNS } from '../../src/core/patterns.ts';
import { CodeBook } from '../../src/core/codes.ts';
import { applyRedactions } from '../../src/core/redactor.ts';
import { restore } from '../../src/core/restorer.ts';

describe('rule + LLM union', () => {
  it('expands repeated values and preserves exact round trip', () => {
    const text = 'John Wang 由 John Wang 回診，手機0912-345-678';
    const book = new CodeBook();
    const result = mergeModelFindings(text, detect(text, BUILTIN_PATTERNS, book), [{ category: '英文姓名', value: 'John Wang', reason: '', source: 'text' }], book);
    const output = applyRedactions(text, result.items);
    expect(output.redactedText).not.toContain('John Wang');
    expect(restore(output.redactedText, output.mapping).restoredText).toBe(text);
  });
  it('merges partial overlaps instead of discarding the uncovered part', () => {
    const text = '病歷號：MRN-2026-000003';
    const book = new CodeBook();
    const items = detect(text, BUILTIN_PATTERNS, book);
    const result = mergeModelFindings(text, items, [{ category: '病歷號', value: 'MRN-2026-000003', reason: '', source: 'text' }], book);
    const output = applyRedactions(text, result.items);
    expect(output.redactedText).not.toContain('MRN-');
    expect(restore(output.redactedText, output.mapping).restoredText).toBe(text);
  });
  it('keeps unlocatable visual values for review without inventing offsets', () => {
    const result = mergeModelFindings('可讀文字', [], [{ category: '姓名', value: '圖中姓名', reason: '', source: 'vision', page: 2 }], new CodeBook());
    expect(result.items).toEqual([]); expect(result.review[0].finding.page).toBe(2);
  });
});
