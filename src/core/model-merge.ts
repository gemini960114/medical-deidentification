import type { ModelFinding } from './model-contract';
import { CATEGORIES, type Category, type RedactionItem } from './types';
import { CodeBook } from './codes';

export interface ModelReview { finding: ModelFinding; reason: string; }
/** Expand exact AI values to every occurrence and union overlaps, preserving all covered characters. */
export function mergeModelFindings(text: string, builtin: RedactionItem[], findings: ModelFinding[], book: CodeBook): { items: RedactionItem[]; review: ModelReview[] } {
  const candidates = builtin.map((it) => ({ ...it }));
  const review: ModelReview[] = [];
  let id = 0;
  for (const finding of findings) {
    const category: Category = CATEGORIES.includes(finding.category as Category) ? finding.category as Category : '識別碼';
    let at = text.indexOf(finding.value);
    if (!finding.value || at < 0) { review.push({ finding, reason: '模型讀到的值無法在文字中精確定位，請按頁碼核對' }); continue; }
    while (at >= 0) {
      candidates.push({ id: `ai-${++id}`, category, original: finding.value, start: at, end: at + finding.value.length,
        code: '', origin: 'auto', active: true });
      at = text.indexOf(finding.value, at + finding.value.length);
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const items: RedactionItem[] = [];
  for (const item of candidates) {
    const previous = items[items.length - 1];
    if (previous && item.start < previous.end) {
      // A partial builtin span cannot suppress the remainder of a larger AI finding.
      previous.end = Math.max(previous.end, item.end);
      previous.original = text.slice(previous.start, previous.end);
      delete previous.head; delete previous.tail;
    } else items.push({ ...item });
  }
  for (const item of items) item.code = book.codeFor(item.category, item.original);
  return { items, review };
}
