// score.ts 計分語意的單元測試：把外部審查指出的反例直接編成 fixture——
// 部分重疊不算涵蓋、相鄰項目聯集可涵蓋、逐出現位置類別檢查、過度遮蔽容許邊界、次數檢查。
// 這些案例在整合測試的合成語料中不會出現（規則目前行為正確），必須靠 fixture 鎖住語意。
import { describe, expect, it } from 'vitest';
import type { Category, RedactionItem } from '../../src/core/types.ts';
import { scoreDocument, type CorpusDocument, type CorpusFinding } from '../../scripts/batch-test-generator/score.ts';

function item(text: string, category: Category, start: number, end: number): RedactionItem {
  return {
    id: `it-${start}-${end}`,
    category,
    original: text.slice(start, end),
    start,
    end,
    code: 'a1b2c3',
    origin: 'manual',
    active: true,
  };
}

function finding(category: string, value: string, occurrences = 1, expectation: 'builtin' | 'audit' = 'builtin'): CorpusFinding {
  return { category, value, expectation, occurrences };
}

function doc(findings: CorpusFinding[]): CorpusDocument {
  return { caseId: 'CASE-0001', file: 'fixture.txt', format: 'txt', findings };
}

describe('scoreDocument 涵蓋語意：完整涵蓋才算命中', () => {
  it('只遮到前綴「王」不算涵蓋「王小明」：值層 miss、該位置記為部分遮蔽', () => {
    const text = '王小明的病歷';
    const score = scoreDocument(text, [item(text, '姓名', 0, 1)], doc([finding('姓名', '王小明')]));
    const f = score.findings[0];
    expect(f.hit).toBe(false);
    expect(f.covered).toBe(0);
    expect(f.uncovered).toBe(1);
    expect(f.partial).toBe(1);
    expect(score.misses).toHaveLength(1);
    // 部分遮蔽的 span 落在答案值範圍內：不是誤判，也不是過度遮蔽。
    expect(score.falsePositives).toHaveLength(0);
    expect(score.overRedactions).toHaveLength(0);
  });

  it('只遮到後綴「明」不算涵蓋「王小明」', () => {
    const text = '王小明的病歷';
    const score = scoreDocument(text, [item(text, '姓名', 2, 3)], doc([finding('姓名', '王小明')]));
    const f = score.findings[0];
    expect(f.hit).toBe(false);
    expect(f.partial).toBe(1);
    expect(score.misses).toHaveLength(1);
    expect(score.overRedactions).toHaveLength(0);
  });

  it('相鄰項目「王小」＋「明」的聯集算完整涵蓋，與陣列順序無關', () => {
    const text = '王小明的病歷';
    const mingMing = [item(text, '姓名', 2, 3), item(text, '姓名', 0, 2)];
    const score = scoreDocument(text, mingMing, doc([finding('姓名', '王小明')]));
    const f = score.findings[0];
    expect(f.hit).toBe(true);
    expect(f.covered).toBe(1);
    expect(f.uncovered).toBe(0);
    expect(score.misses).toHaveLength(0);
    expect(score.residuals).toHaveLength(0);
    expect(f.categoryOk).toBe(true);
  });

  it('聯集有缺口（「王」＋「明」缺「小」）不算涵蓋', () => {
    const text = '王小明的病歷';
    const score = scoreDocument(text, [item(text, '姓名', 0, 1), item(text, '姓名', 2, 3)], doc([finding('姓名', '王小明')]));
    const f = score.findings[0];
    expect(f.hit).toBe(false);
    expect(f.partial).toBe(1);
    expect(score.misses).toHaveLength(1);
  });
});

describe('scoreDocument 逐出現位置類別檢查', () => {
  it('第二處出現被標成「公司」：值層仍命中，但該位置計為類別錯誤', () => {
    const text = '王小明與王小明';
    const items = [item(text, '姓名', 0, 3), item(text, '公司', 4, 7)];
    const score = scoreDocument(text, items, doc([finding('姓名', '王小明', 2)]));
    const f = score.findings[0];
    expect(f.hit).toBe(true);
    expect(f.categoryOk).toBe(false);
    expect(score.categoryErrors).toHaveLength(1);
    expect(score.categoryErrors[0].start).toBe(4);
    expect(score.categoryErrors[0].detectedCategories).toEqual(['公司']);
    expect(score.misses).toHaveLength(0);
  });

  it('部分遮蔽的位置不做類別檢查（只有完整涵蓋的位置檢查）', () => {
    const text = '王小明與王小明';
    const items = [item(text, '姓名', 0, 3), item(text, '公司', 4, 5)];
    const score = scoreDocument(text, items, doc([finding('姓名', '王小明', 2)]));
    expect(score.categoryErrors).toHaveLength(0);
    expect(score.findings[0].hit).toBe(true);
    expect(score.findings[0].uncovered).toBe(1);
    expect(score.residuals[0].partial).toBe(1);
  });
});

describe('scoreDocument 過度遮蔽容許邊界（isAllowedExcess）', () => {
  it('span 多含欄位標籤「姓名：」屬容許範圍：記為 spanDiffs，不算過度遮蔽', () => {
    const text = '姓名：王小明';
    const score = scoreDocument(text, [item(text, '姓名', 0, 6)], doc([finding('姓名', '王小明')]));
    expect(score.overRedactions).toHaveLength(0);
    expect(score.spanDiffs).toHaveLength(1);
    expect(score.spanDiffs[0].excess).toBe('姓名：');
    expect(score.findings[0].hit).toBe(true);
  });

  it('span「王小明；診斷：肺炎」把病名一起遮掉：拒絕（excess 含「肺炎」）', () => {
    const text = '王小明；診斷：肺炎';
    const score = scoreDocument(text, [item(text, '姓名', 0, 9)], doc([finding('姓名', '王小明')]));
    expect(score.overRedactions).toHaveLength(1);
    expect(score.overRedactions[0].excess).toBe('；診斷：肺炎');
    expect(score.spanDiffs).toHaveLength(0);
    expect(score.findings[0].hit).toBe(true);
  });

  it('span 超出部分含數字（電話片段）：拒絕', () => {
    const text = '王小明（0912）';
    const score = scoreDocument(text, [item(text, '姓名', 0, 9)], doc([finding('姓名', '王小明')]));
    expect(score.overRedactions).toHaveLength(1);
    expect(score.overRedactions[0].excess).toBe('（0912）');
  });

  it('拉丁標籤字 Patient Name: 屬容許範圍', () => {
    const text = 'Patient Name: 王小明';
    const score = scoreDocument(text, [item(text, '姓名', 0, 16)], doc([finding('姓名', '王小明')]));
    expect(score.overRedactions).toHaveLength(0);
    expect(score.spanDiffs).toHaveLength(1);
    expect(score.spanDiffs[0].excess).toBe('Patient Name: ');
  });
});

describe('scoreDocument 次數與值存在檢查', () => {
  it('實際出現 1 次、answer-key 記 2 次：計為次數不符（不是漏抓）', () => {
    const text = '王小明';
    const score = scoreDocument(text, [item(text, '姓名', 0, 3)], doc([finding('姓名', '王小明', 2)]));
    expect(score.countMismatches).toHaveLength(1);
    expect(score.countMismatches[0].actualOccurrences).toBe(1);
    expect(score.countMismatches[0].expectedOccurrences).toBe(2);
    expect(score.misses).toHaveLength(0);
    expect(score.valueNotFound).toHaveLength(0);
  });

  it('值完全不存在：歸類為值不存在，不算次數不符也不是漏抓', () => {
    const text = '無關文字';
    const score = scoreDocument(text, [], doc([finding('姓名', '王小明', 1)]));
    expect(score.valueNotFound).toHaveLength(1);
    expect(score.countMismatches).toHaveLength(0);
    expect(score.misses).toHaveLength(0);
  });
});

describe('scoreDocument 誤判與 audit 分層', () => {
  it('span 不與任何答案值重疊：計為誤判', () => {
    const text = '王小明與無關內容';
    const items = [item(text, '姓名', 0, 3), item(text, '地址', 4, 8)];
    const score = scoreDocument(text, items, doc([finding('姓名', '王小明')]));
    expect(score.falsePositives).toHaveLength(1);
    expect(score.falsePositives[0].span).toBe('無關內容');
    expect(score.overRedactions).toHaveLength(0);
  });

  it('audit 案例不命中只進 audit 清單，不算漏抓／值不存在／次數不符', () => {
    const text = '王小明';
    const score = scoreDocument(text, [item(text, '姓名', 0, 3)], doc([
      finding('姓名', '王小明'),
      finding('醫療日期', '2026-01-01', 1, 'audit'),
    ]));
    expect(score.audit).toHaveLength(1);
    expect(score.misses).toHaveLength(0);
    expect(score.valueNotFound).toHaveLength(0);
    expect(score.countMismatches).toHaveLength(0);
  });
});
