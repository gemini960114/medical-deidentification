// 產生語料的驗收計分模組：tests/integration/generated-corpus.test.ts 與後續 CLI 報告共用。
// 計分語意（四個獨立失敗通道，缺一不可）：
//   涵蓋＝完整涵蓋：出現位置必須被偵測項目的「聯集」完全包住（游標走訪到底），
//     只碰到前綴或後綴（如「王」之於「王小明」、「2026-000003」之於「MRN-2026-000003」）不算涵蓋；
//   類別＝逐出現位置檢查：完整涵蓋的位置，其涵蓋項目類別必須全等於答案類別（值層至少一處對不算過關）；
//   次數＝builtin 答案的實際出現次數必須等於 answer-key 記錄值（實際為 0 另歸類為值不存在）；
//   過度遮蔽＝偵測 span 超出所有答案值的部分，只能含標點、空白與欄位標籤（isAllowedExcess 邊界），
//     「王小明；診斷：肺炎」這種把病名一起遮掉的 span 會被拒絕。
// 值層 hit＝至少一個出現位置完整涵蓋；miss＝值有出現但沒有任何位置完整涵蓋。
// 殘留（residual）＝hit 之後仍未完整涵蓋的位置，分「未觸及」與「部分遮蔽」（有項目碰到但沒蓋滿）。
// 已知限制列在 KNOWN_LIMITATIONS 並帶「每份文件上界」：白名單內會出現在報告但不計失敗，
// 超出上界或白名單外都會失敗；規則進步（漏抓／殘留變少）只會讓測試更綠，不會變紅。
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
  /** 每份文件容許的上界：miss／valueNotFound 以筆數計，residual 以未涵蓋位置數計。 */
  maxPerDoc: number;
  reason: string;
}

/** 已知限制白名單：白名單內的漏抓／殘留會出現在報告但不計為驗收失敗，但每份文件不得超過上界。 */
export const KNOWN_LIMITATIONS: KnownLimitation[] = [
  {
    category: '醫療日期',
    formats: ['docx', 'pdf'],
    kind: 'miss',
    maxPerDoc: 3,
    reason:
      'docx／pdf 把日期放在表格欄位，萃取後標籤與值不同行；醫療日期規則刻意只抓同一行的標籤日期以避免誤抓，表格感知屬後續規則改善。僅容許純漏抓（無任何偵測項目），每份文件至多 3 筆（入院／手術／出院日期）',
  },
  {
    category: '英文姓名',
    formats: ['txt', 'md', 'docx', 'pdf'],
    kind: 'residual',
    maxPerDoc: 1,
    reason:
      '無標籤的英文姓名重複出現不在內建規則範圍（只抓 Patient Name／Dr. 等標籤後的名字），刻意留給 AI 稽核／人工圈選；每份文件至多 1 處（醫師姓名若也開始漏抓會超過上界）',
  },
  {
    category: '病歷號',
    formats: ['docx', 'pdf'],
    kind: 'residual',
    maxPerDoc: 1,
    reason:
      '表格欄位「病例編號／病歷號」的值含兩個識別碼（CASE-…　MRN-…），病歷號規則只抓到 MRN 的數字段，「MRN-」前綴仍在輸出中（部分遮蔽）；出院指示處為完整涵蓋。每份文件至多 1 處',
  },
];

export function isKnownLimitation(category: string, format: string, kind: LimitationKind): boolean {
  return KNOWN_LIMITATIONS.some((k) => k.category === category && k.formats.includes(format) && k.kind === kind);
}

/** 一份文件中，某類別在某通道（miss／residual／valueNotFound）的筆數，用於檢查白名單上界。 */
export function limitationCount(score: DocScore, category: string, kind: LimitationKind): number {
  if (kind === 'miss') return score.misses.filter((f) => f.category === category).length;
  if (kind === 'valueNotFound') return score.valueNotFound.filter((f) => f.category === category).length;
  return score.residuals.filter((r) => r.finding.category === category).reduce((n, r) => n + r.finding.uncovered, 0);
}

export interface OccurrenceScore {
  start: number;
  end: number;
  /** 完整涵蓋：聯集游標走訪到底。 */
  covered: boolean;
  /** 有偵測項目重疊但未完整涵蓋（部分遮蔽，如「MRN-」前綴外露）。 */
  partial: boolean;
  /** 涵蓋（或觸及）此位置的偵測類別。 */
  detectedCategories: string[];
  /** 完整涵蓋但涵蓋項目類別不全等於答案類別。 */
  categoryError: boolean;
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
  occurrences: OccurrenceScore[];
  /** 完整涵蓋的出現位置數。 */
  covered: number;
  /** 未完整涵蓋的出現位置數（含部分遮蔽）。 */
  uncovered: number;
  /** 其中「部分遮蔽」的位置數。 */
  partial: number;
  /** 涵蓋（或觸及）此值的偵測類別（去重）。 */
  detectedCategories: string[];
  /** 值層命中（至少一個出現位置完整涵蓋）。 */
  hit: boolean;
  /** 命中且所有完整涵蓋位置的類別都正確。 */
  categoryOk: boolean;
}

export interface ResidualScore {
  finding: FindingScore;
  /** 部分遮蔽的位置數（其餘為完全未觸及）。 */
  partial: number;
  reason: string;
}

export interface CategoryError {
  category: string;
  value: string;
  start: number;
  detectedCategories: string[];
}

export interface OverRedaction {
  category: string;
  span: string;
  excess: string;
}

export interface DocScore {
  file: string;
  caseId: string;
  format: string;
  textLength: number;
  detections: number;
  findings: FindingScore[];
  /** builtin 且無任何位置完整涵蓋。 */
  misses: FindingScore[];
  /** 值不存在於解析後的文字（answer 漏植或萃取保真議題）。 */
  valueNotFound: FindingScore[];
  /** builtin 命中但有出現位置未被完整涵蓋。 */
  residuals: ResidualScore[];
  /** builtin 且實際出現次數不等於 answer-key 記錄值。 */
  countMismatches: FindingScore[];
  /** 完整涵蓋但偵測類別與答案不符的位置（逐位置，不白名單）。 */
  categoryErrors: CategoryError[];
  /** 偵測 span 不與任何答案值出現位置重疊。 */
  falsePositives: { category: string; span: string }[];
  /** 偵測 span 涵蓋答案值但範圍較大，超出部分屬容許的標籤／標點（僅報告）。 */
  spanDiffs: OverRedaction[];
  /** span 超出答案值且超出部分不屬容許邊界（遮掉了不該遮的內容）。 */
  overRedactions: OverRedaction[];
  /** audit 案例的涵蓋情形（僅報告，不計失敗）。 */
  audit: FindingScore[];
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

/**
 * 聯集游標走訪：從 start 出發，反覆尋找「起點在游標之前、終點在游標之後」的項目並把游標推到其終點。
 * 選擇終點最遠的項目使結果與項目排列順序無關；回傳走訪用到的項目與最終游標。cursor ≥ end 即完整涵蓋。
 */
function walkCoverage(items: RedactionItem[], start: number, end: number): { items: RedactionItem[]; cursor: number } {
  const used: RedactionItem[] = [];
  let cursor = start;
  for (;;) {
    let next: RedactionItem | undefined;
    for (const it of items) {
      if (it.start <= cursor && it.end > cursor && (!next || it.end > next.end)) next = it;
    }
    if (!next) break;
    used.push(next);
    cursor = next.end;
    if (cursor >= end) break;
  }
  return { items: used, cursor };
}

/** span 超出所有答案值範圍的部分（依序串接；空字串代表 span 完全落在答案值內）。 */
function excessText(text: string, item: { start: number; end: number }, ranges: { start: number; end: number }[]): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let cursor = item.start;
  let excess = '';
  for (const r of sorted) {
    if (r.end <= cursor || r.start >= item.end) continue;
    if (r.start > cursor) excess += text.slice(cursor, r.start);
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < item.end) excess += text.slice(cursor, item.end);
  return excess;
}

/** 分隔符：標點、空白（含全型）、斜線、破折號。 */
const SEPARATOR_CLASS = '：:、,，;；（）()／/\\.\\s\\-';
const SEPARATOR_RUN = new RegExp(`[${SEPARATOR_CLASS}]+`);
/** 表單欄位標籤（機構文件常見）；「肺炎」這類內容詞刻意不在列表內。 */
const CJK_LABELS = [
  '轉介院所', '主治醫師', '緊急聯絡人', '病例編號', '檢查序號', '病歷號', '英文姓名', '身分證字號',
  '出生日期', '聯絡手機', '住家電話', '通訊地址', '電子郵件', '診斷', '姓名', '手機', '電話', '住址', '地址', '日期', '院所',
];
const LABEL_TOKEN = new RegExp(`^(?:[A-Za-z]{1,16}|${CJK_LABELS.join('|')})$`);

/**
 * 過度遮蔽的容許邊界：span 超出答案值的部分切成 token 後，每個 token 都必須是
 * 標點／空白（會被切掉）、拉丁字母標籤字（Patient／Name／Dr／MRN…）或上述欄位標籤。
 * 數字、病名（肺炎）、地址片段等任何其他內容都算過度遮蔽。
 */
function isAllowedExcess(excess: string): boolean {
  if (!excess) return true;
  return excess.split(SEPARATOR_RUN).filter(Boolean).every((token) => LABEL_TOKEN.test(token));
}

/** 對一份文件計分：text＝解析後全文、items＝detect() 結果、answer＝answer-key 的該份文件。 */
export function scoreDocument(text: string, items: RedactionItem[], answer: CorpusDocument): DocScore {
  const active = items.filter((it) => it.active);
  const ranges = answer.findings.flatMap((f) =>
    locateOccurrences(text, f.value).map((start) => ({ start, end: start + f.value.length })),
  );

  const findings: FindingScore[] = answer.findings.map((f) => {
    const occurrences: OccurrenceScore[] = locateOccurrences(text, f.value).map((start) => {
      const end = start + f.value.length;
      const walk = walkCoverage(active, start, end);
      const covered = walk.cursor >= end;
      const touching = active.filter((it) => it.start < end && start < it.end);
      const detectedCategories = [...new Set((covered ? walk.items : touching).map((it) => it.category))];
      return {
        start,
        end,
        covered,
        partial: !covered && touching.length > 0,
        detectedCategories,
        categoryError: covered && detectedCategories.some((c) => c !== f.category),
      };
    });
    const covered = occurrences.filter((o) => o.covered).length;
    const partial = occurrences.filter((o) => o.partial).length;
    const hit = covered > 0;
    return {
      category: f.category,
      value: f.value,
      expectation: f.expectation,
      note: f.note,
      expectedOccurrences: f.occurrences,
      actualOccurrences: occurrences.length,
      occurrences,
      covered,
      uncovered: occurrences.length - covered,
      partial,
      detectedCategories: [...new Set(occurrences.flatMap((o) => o.detectedCategories))],
      hit,
      categoryOk: hit && !occurrences.some((o) => o.categoryError),
    };
  });

  const misses: FindingScore[] = [];
  const valueNotFound: FindingScore[] = [];
  const residuals: ResidualScore[] = [];
  const countMismatches: FindingScore[] = [];
  const categoryErrors: CategoryError[] = [];
  const audit: FindingScore[] = [];
  for (const f of findings) {
    if (f.expectation === 'audit') {
      audit.push(f);
      continue;
    }
    for (const o of f.occurrences) {
      if (o.categoryError) {
        categoryErrors.push({ category: f.category, value: f.value, start: o.start, detectedCategories: o.detectedCategories });
      }
    }
    if (f.actualOccurrences === 0) {
      valueNotFound.push(f);
      continue;
    }
    if (!f.hit) {
      misses.push(f);
      continue;
    }
    if (f.actualOccurrences !== f.expectedOccurrences) {
      countMismatches.push(f);
    }
    if (f.uncovered > 0) {
      const known = KNOWN_LIMITATIONS.find((k) => k.category === f.category && k.kind === 'residual');
      residuals.push({ finding: f, partial: f.partial, reason: known?.reason ?? '' });
    }
  }

  const falsePositives: { category: string; span: string }[] = [];
  const overRedactions: OverRedaction[] = [];
  const spanDiffs: OverRedaction[] = [];
  for (const it of active) {
    const span = text.slice(it.start, it.end);
    const overlapped = ranges.some((r) => it.start < r.end && r.start < it.end);
    if (!overlapped) {
      falsePositives.push({ category: it.category, span });
      continue;
    }
    const excess = excessText(text, it, ranges);
    if (!excess) continue; // span 完全落在答案值內（若只蓋到一部分，由殘留通道以部分遮蔽處理）
    if (isAllowedExcess(excess)) spanDiffs.push({ category: it.category, span, excess });
    else overRedactions.push({ category: it.category, span, excess });
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
    countMismatches,
    categoryErrors,
    falsePositives,
    spanDiffs,
    overRedactions,
    audit,
  };
}

export interface FormatSummary {
  格式: string;
  文件: number;
  偵測: number;
  builtin命中: number;
  builtin總數: number;
  殘留位置: number;
  部分遮蔽: number;
  漏抓: number;
  值不存在: number;
  次數不符: number;
  類別錯誤: number;
  過度遮蔽: number;
  誤判: number;
  audit案例: number;
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
    部分遮蔽: docs.reduce((n, d) => n + d.residuals.reduce((m, r) => m + r.partial, 0), 0),
    漏抓: docs.reduce((n, d) => n + d.misses.length, 0),
    值不存在: docs.reduce((n, d) => n + d.valueNotFound.length, 0),
    次數不符: docs.reduce((n, d) => n + d.countMismatches.length, 0),
    類別錯誤: docs.reduce((n, d) => n + d.categoryErrors.length, 0),
    過度遮蔽: docs.reduce((n, d) => n + d.overRedactions.length, 0),
    誤判: docs.reduce((n, d) => n + d.falsePositives.length, 0),
    audit案例: docs.reduce((n, d) => n + d.audit.length, 0),
  }));
}
