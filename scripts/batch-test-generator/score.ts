// 產生語料的驗收計分模組：tests/integration/generated-corpus.test.ts 與後續 CLI 報告共用。
// 計分分兩層：
//   值層（hit）＝答案值至少一個出現位置被內建偵測涵蓋、且類別與答案一致；
//   位置層（residual）＝命中後仍未涵蓋的出現位置——正是 AI 稽核／人工圈選的對象。
// 「值不存在於萃取文字」（萃取保真議題）與「誤判」（span 不與任何答案值重疊）獨立分類，
// 避免把版面問題誤記為規則漏抓。已知限制列在 KNOWN_LIMITATIONS，出現在報告但不計為驗收失敗。
import type { RedactionItem } from '../../src/core/types.ts';

export interface CorpusFinding {
  category: string;
  value: string;
  expectation: 'builtin' | 'audit';
  note?: string;
  occurrences: number;
}

export interface CorpusDocument {
  caseId: string;
  file: string;
  format: string;
  findings: CorpusFinding[];
}

export interface AnswerKey {
  generatedAt: string;
  synthetic: boolean;
  notice: string;
  config: { count: number; seed: number; format: string; output: string };
  documents: CorpusDocument[];
}

export type LimitationKind = 'miss' | 'residual' | 'valueNotFound';

export interface KnownLimitation {
  category: string;
  formats: string[];
  kind: LimitationKind;
  reason: string;
}

/** 已知限制白名單：這些組合會出現在報告，但不計為驗收失敗。 */
export const KNOWN_LIMITATIONS: KnownLimitation[] = [
  {
    category: '醫療日期',
    formats: ['docx', 'pdf'],
    kind: 'miss',
    reason: 'docx／pdf 把日期放在表格欄位（標籤列與值列分離），醫療日期規則刻意只抓同一行的標籤日期以避免誤抓；表格感知屬後續規則改善',
  },
  {
    category: '英文姓名',
    formats: ['txt', 'md', 'docx', 'pdf'],
    kind: 'residual',
    reason: '無標籤的英文姓名重複出現不在內建規則範圍（只抓 Patient Name／Dr. 等標籤後的名字），刻意留給 AI 稽核／人工圈選',
  },
  {
    category: '公司',
    formats: ['pdf'],
    kind: 'valueNotFound',
    reason: 'PDF 版面換行可能把機構名拆到兩行，使值不存在於萃取文字（萃取保真議題，非規則漏抓）',
  },
];

export function isKnownLimitation(category: string, format: string, kind: LimitationKind): boolean {
  return KNOWN_LIMITATIONS.some((k) => k.category === category && k.formats.includes(format) && k.kind === kind);
}

export interface FindingScore {
  category: string;
  value: string;
  expectation: 'builtin' | 'audit';
  note?: string;
  /** answer-key 記錄的出現次數（依產生時的本文計算）。 */
  expectedOccurrences: number;
  /** 解析後文字中實際定位到的出現次數。 */
  actualOccurrences: number;
  /** 被內建偵測涵蓋的出現位置數。 */
  covered: number;
  /** 涵蓋此值的偵測類別（去重）。 */
  detectedCategories: string[];
  /** 值層命中（至少一個出現位置被涵蓋）。 */
  hit: boolean;
  /** 涵蓋此值的偵測類別包含答案類別。 */
  categoryOk: boolean;
  /** 命中後仍未涵蓋的出現位置數。 */
  uncovered: number;
}

export interface ResidualScore {
  finding: FindingScore;
  reason: string;
}

export interface DocScore {
  file: string;
  caseId: string;
  format: string;
  textLength: number;
  detections: number;
  findings: FindingScore[];
  /** builtin 且未命中或類別不符。 */
  misses: FindingScore[];
  /** 值不存在於解析後的文字（answer 漏植或萃取保真議題）。 */
  valueNotFound: FindingScore[];
  /** builtin 命中但有出現位置未被涵蓋。 */
  residuals: ResidualScore[];
  /** audit 案例的涵蓋情形（僅報告，不計失敗）。 */
  audit: FindingScore[];
  /** 偵測 span 不與任何答案值出現位置重疊。 */
  falsePositives: { category: string; span: string }[];
  /** 偵測 span 涵蓋答案值但 span 不等於該值（定位差異，僅報告）。 */
  spanDiffs: { category: string; span: string; value: string }[];
}

/** 找出 value 在 text 中的每個出現位置（起點）。 */
export function locateOccurrences(text: string, value: string): number[] {
  if (!value) return [];
  const starts: number[] = [];
  let at = text.indexOf(value);
  while (at >= 0) {
    starts.push(at);
    at = text.indexOf(value, at + value.length);
  }
  return starts;
}

function covers(items: RedactionItem[], start: number, end: number): boolean {
  return items.some((it) => it.start < end && start < it.end);
}

/** 對一份文件計分：text＝解析後全文、items＝detect() 結果、answer＝answer-key 的該份文件。 */
export function scoreDocument(text: string, items: RedactionItem[], answer: CorpusDocument): DocScore {
  const active = items.filter((it) => it.active);
  const ranges = answer.findings.flatMap((f) =>
    locateOccurrences(text, f.value).map((start) => ({ start, end: start + f.value.length, value: f.value })),
  );

  const findings: FindingScore[] = answer.findings.map((f) => {
    const starts = locateOccurrences(text, f.value);
    const covered = starts.filter((start) => covers(active, start, start + f.value.length)).length;
    const detectedCategories: string[] = [
      ...new Set(
        active
          .filter((it) => starts.some((start) => it.start < start + f.value.length && start < it.end))
          .map((it) => it.category),
      ),
    ];
    const hit = covered > 0;
    return {
      category: f.category,
      value: f.value,
      expectation: f.expectation,
      note: f.note,
      expectedOccurrences: f.occurrences,
      actualOccurrences: starts.length,
      covered,
      detectedCategories,
      hit,
      categoryOk: hit && detectedCategories.includes(f.category),
      uncovered: starts.length - covered,
    };
  });

  const misses: FindingScore[] = [];
  const valueNotFound: FindingScore[] = [];
  const residuals: ResidualScore[] = [];
  const audit: FindingScore[] = [];
  for (const f of findings) {
    if (f.expectation === 'audit') {
      audit.push(f);
    } else if (f.actualOccurrences === 0) {
      valueNotFound.push(f);
    } else if (!f.hit || !f.categoryOk) {
      misses.push(f);
    } else if (f.uncovered > 0) {
      const known = KNOWN_LIMITATIONS.find((k) => k.category === f.category && k.kind === 'residual');
      residuals.push({ finding: f, reason: known?.reason ?? '' });
    }
  }

  const falsePositives: { category: string; span: string }[] = [];
  const spanDiffs: { category: string; span: string; value: string }[] = [];
  for (const it of active) {
    const overlapped = ranges.find((r) => it.start < r.end && r.start < it.end);
    const span = text.slice(it.start, it.end);
    if (!overlapped) {
      falsePositives.push({ category: it.category, span });
    } else if (span !== overlapped.value) {
      spanDiffs.push({ category: it.category, span, value: overlapped.value });
    }
  }

  return {
    file: answer.file,
    caseId: answer.caseId,
    format: answer.format,
    textLength: text.length,
    detections: active.length,
    findings,
    misses,
    valueNotFound,
    residuals,
    audit,
    falsePositives,
    spanDiffs,
  };
}

export interface FormatSummary {
  格式: string;
  文件: number;
  偵測: number;
  builtin命中: number;
  builtin總數: number;
  殘留位置: number;
  漏抓: number;
  值不存在: number;
  audit案例: number;
  誤判: number;
}

/** 各格式統計，供 console.table 呈現。 */
export function summarize(scores: DocScore[]): FormatSummary[] {
  const byFormat = new Map<string, DocScore[]>();
  for (const s of scores) {
    const list = byFormat.get(s.format) ?? [];
    list.push(s);
    byFormat.set(s.format, list);
  }
  return [...byFormat.entries()].map(([format, docs]) => ({
    格式: format,
    文件: docs.length,
    偵測: docs.reduce((n, d) => n + d.detections, 0),
    builtin命中: docs.reduce(
      (n, d) => n + d.findings.filter((f) => f.expectation === 'builtin' && f.hit && f.categoryOk).length,
      0,
    ),
    builtin總數: docs.reduce((n, d) => n + d.findings.filter((f) => f.expectation === 'builtin').length, 0),
    殘留位置: docs.reduce((n, d) => n + d.residuals.reduce((m, r) => m + r.finding.uncovered, 0), 0),
    漏抓: docs.reduce((n, d) => n + d.misses.length, 0),
    值不存在: docs.reduce((n, d) => n + d.valueNotFound.length, 0),
    audit案例: docs.reduce((n, d) => n + d.audit.length, 0),
    誤判: docs.reduce((n, d) => n + d.falsePositives.length, 0),
  }));
}
