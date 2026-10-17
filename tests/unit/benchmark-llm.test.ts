import { describe, expect, it } from 'vitest';
import { aggregateRow, scoreDoc, type DocScored, type FoundItem } from '../../scripts/benchmark-llm.ts';
import type { CorpusFinding } from '../../scripts/batch-test-generator/score.ts';

function finding(category: string, value: string, expectation: 'builtin' | 'audit' = 'builtin'): CorpusFinding {
  return { category, value, expectation, occurrences: 1 };
}

const found = (category: string, value: string): FoundItem => ({ category, value });

describe('scoreDoc（benchmark 值層計分）', () => {
  it('same value under conflicting categories counts at most one TP', () => {
    const score = scoreDoc([finding('姓名', '王小明')], [found('姓名', '王小明'), found('公司', '王小明')], '王小明');
    expect(score.tp).toBe(1); expect(score.categoryErrors).toBe(0);
  });
  it('值命中但類別不同：計 TP 且計類別錯誤', () => {
    const s = scoreDoc([finding('姓名', '王小明')], [found('手機', '王小明')], '王小明');
    expect(s.tp).toBe(1);
    expect(s.categoryErrors).toBe(1);
    expect(s.fp).toBe(0);
  });

  it('FP 且值不存在於文本：另計幻覺', () => {
    const s = scoreDoc([finding('姓名', '王小明')], [found('姓名', '王小明'), found('姓名', '陳大同')], '王小明');
    expect(s.tp).toBe(1);
    expect(s.fp).toBe(1);
    expect(s.unlocatable).toBe(1);
  });

  it('FP 但值存在於文本（答案清單以外）：只計 FP 不計幻覺', () => {
    const s = scoreDoc([finding('姓名', '王小明')], [found('公司', '台大醫院')], '王小明就診於台大醫院');
    expect(s.fp).toBe(1);
    expect(s.unlocatable).toBe(0);
  });

  it('漏抓分層：builtin 與 audit 分開計，audit 漏抓是重點指標', () => {
    const answers = [finding('姓名', '王小明'), finding('英文姓名', 'Amelia Chou', 'audit')];
    const s = scoreDoc(answers, [found('姓名', '王小明')], '王小明 Amelia Chou');
    expect(s.fnBuiltin).toBe(0);
    expect(s.fnAudit).toBe(1);
    expect(s.builtinTotal).toBe(1);
    expect(s.auditTotal).toBe(1);
  });

  it('同一類別＋值重複回報只計一次（值層去重）', () => {
    const s = scoreDoc([finding('姓名', '王小明')], [found('姓名', '王小明'), found('姓名', '王小明')], '王小明');
    expect(s.tp).toBe(1);
    expect(s.fp).toBe(0);
  });

  it('去除首尾空白後比對：LLM 帶空白的值仍算命中', () => {
    const s = scoreDoc([finding('姓名', '王小明')], [found('姓名', ' 王小明 ')], '王小明');
    expect(s.tp).toBe(1);
    expect(s.fnBuiltin).toBe(0);
  });
});

describe('aggregateRow（benchmark 彙總）', () => {
  it('召回／精確率／F1 的計算與分層彙總', () => {
    const doc = (score: DocScored['score']): DocScored => ({ file: 'a.txt', score, latencyMs: 1000 });
    const rows = [
      doc({ tp: 2, categoryErrors: 0, fp: 1, unlocatable: 1, fnBuiltin: 1, fnAudit: 0, builtinTotal: 3, auditTotal: 1, fpSamples: [], fnSamples: [] }),
      doc({ tp: 3, categoryErrors: 0, fp: 0, unlocatable: 0, fnBuiltin: 0, fnAudit: 1, builtinTotal: 3, auditTotal: 1, fpSamples: [], fnSamples: [] }),
    ];
    const r = aggregateRow('測試', rows);
    expect(r.文件).toBe(2);
    expect(r.值命中).toBe(5);
    expect(r.誤判FP).toBe(1);
    // builtin 命中 5/6、audit 命中 1/2、整體召回 6/8、精確率 5/6。
    expect(r.召回builtin).toBe('83.3%');
    expect(r.召回audit).toBe('50.0%');
    expect(r.精確率).toBe('83.3%');
    expect(r.F1).toBe('78.9%');
    expect(r.延遲秒).toBe('2.0');
  });

  it('零分母顯示為「—」不除零', () => {
    const r = aggregateRow('空', [{ file: 'a.txt', score: { tp: 0, categoryErrors: 0, fp: 0, unlocatable: 0, fnBuiltin: 0, fnAudit: 0, builtinTotal: 0, auditTotal: 0, fpSamples: [], fnSamples: [] }, latencyMs: 0 }]);
    expect(r.召回builtin).toBe('—');
    expect(r.召回audit).toBe('—');
    expect(r.精確率).toBe('—');
  });
});
