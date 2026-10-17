// 產生語料自動驗收：generate.ts 以固定種子產生全合成出院病歷摘要（txt／md／docx／pdf），
// 走完整流程 parseDocument → detect → score 對照 answer-key → applyRedactions → generateDocument →
// 再解析 → restore。answer-key 的 expectation 分兩層：
//   builtin＝內建規則必須命中；audit＝刻意留給人工／AI 稽核的案例，不算內建失敗。
// 計分有四個獨立失敗通道（語意見 score.ts 標頭與 tests/unit/score.test.ts 的反例 fixture）：
//   漏抓（值有出現但無任何位置完整涵蓋）、類別錯誤（逐出現位置）、次數不符、過度遮蔽（超出
//   答案值的部分只能是標籤／標點）。已知限制定義在 score.ts 的 KNOWN_LIMITATIONS，每條帶
//   「每份文件上界」：白名單內會出現在報告但不計失敗，超過上界或白名單外都會讓測試失敗；
//   誤判與值不存在沒有任何白名單。規則進步（misses／residuals 變少）只會更綠，不會變紅。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { detect } from '../../src/core/detector';
import { BUILTIN_PATTERNS } from '../../src/core/patterns';
import { applyRedactions } from '../../src/core/redactor';
import { restore } from '../../src/core/restorer';
import { generateDocument, parseDocument } from '../../src/formats';
import { generateCorpus } from '../../scripts/batch-test-generator/generate.ts';
import {
  isKnownLimitation,
  limitationCount,
  locateOccurrences,
  scoreDocument,
  summarize,
  KNOWN_LIMITATIONS,
  type AnswerKey,
  type DocScore,
} from '../../scripts/batch-test-generator/score.ts';

/** 2 個病例 × 4 種格式＝8 份文件：同一批病人的值橫跨四種格式，便於比較格式間差異。 */
const CASES = 2;
const SEED = 17;
const FORMATS = ['txt', 'md', 'docx', 'pdf'] as const;
/** planted() 的答案結構：17 個 builtin＋2 個 audit（reverseDate、examId）。 */
const BUILTIN_PER_DOC = 17;
const AUDIT_PER_DOC = 2;

const FONT = new Uint8Array(readFileSync('public/fonts/NotoSansTC-Regular.ttf'));
const corpusRoot = mkdtempSync(join(tmpdir(), 'deid-corpus-'));

let answerKey: AnswerKey;
const docScores: DocScore[] = [];
const roundtrips: { file: string; original: string; redacted: string; restored: string; missingCodes: string[] }[] = [];

beforeAll(async () => {
  // 產生 PDF 時字型是從靜態網站 fetch 的；測試環境直接從磁碟供給。
  vi.stubGlobal('fetch', async () => new Response(FONT));
  // parseDocument 以動態 import 載入 ./pdf，其模組層的 ?url workerSrc 賦值會晚於此處——
  // 必須先把模組載入再覆蓋成 Node 可用的 file:// URL，順序顛倒會被模組層賦值蓋掉。
  await import('../../src/formats/pdf');
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL('node_modules/pdfjs-dist/build/pdf.worker.min.mjs').href;

  const generated = await generateCorpus({ count: CASES, seed: SEED, format: 'all', output: corpusRoot });
  answerKey = JSON.parse(readFileSync(join(generated.runDir, 'answer-key.json'), 'utf8')) as AnswerKey;

  for (const doc of answerKey.documents) {
    const file = new File([readFileSync(join(generated.runDir, doc.file))], doc.file);
    const parsed = await parseDocument(file);
    const items = detect(parsed.text, BUILTIN_PATTERNS);
    docScores.push(scoreDocument(parsed.text, items, doc));

    // 完整輸出鏈：去識別化 → 重新產生文件 → 再解析 → 還原
    const { edits, mapping } = applyRedactions(parsed.text, items, 'code');
    const blob = await generateDocument(parsed, edits);
    const output = await parseDocument(new File([await blob.arrayBuffer()], doc.file));
    const { restoredText, missingCodes } = restore(output.text, mapping);
    roundtrips.push({ file: doc.file, original: parsed.text, redacted: output.text, restored: restoredText, missingCodes });
  }

  console.table(summarize(docScores));
}, 240_000);

afterAll(() => {
  rmSync(corpusRoot, { recursive: true, force: true });
});

describe('產生語料自動驗收（generateCorpus → parseDocument → detect）', () => {
  it('語料結構與答案分層正確（文件數、格式分布、builtin／audit 題數）', () => {
    expect(answerKey.synthetic).toBe(true);
    expect(answerKey.config).toMatchObject({ count: CASES, seed: SEED, format: 'all' });
    expect(answerKey.documents).toHaveLength(CASES * FORMATS.length);
    for (const format of FORMATS) {
      const docs = answerKey.documents.filter((d) => d.format === format);
      expect(docs, `格式 ${format} 應有 ${CASES} 份`).toHaveLength(CASES);
    }
    // 同一病例必須四種格式都有，且答案題數固定，避免產生器悄悄改變語料結構。
    const byCase = new Map<string, Set<string>>();
    for (const doc of answerKey.documents) {
      const formats = byCase.get(doc.caseId) ?? new Set<string>();
      formats.add(doc.format);
      byCase.set(doc.caseId, formats);
      expect(doc.findings.filter((f) => f.expectation === 'builtin'), `${doc.file} builtin 題數`).toHaveLength(BUILTIN_PER_DOC);
      expect(doc.findings.filter((f) => f.expectation === 'audit'), `${doc.file} audit 題數`).toHaveLength(AUDIT_PER_DOC);
      expect(doc.findings.every((f) => f.value.length > 0 && f.occurrences >= 1), `${doc.file} 答案值與次數`).toBe(true);
    }
    for (const [caseId, formats] of byCase) {
      expect(formats.size, `${caseId} 應含四種格式`).toBe(FORMATS.length);
    }
  });

  it('builtin 漏抓／殘留／誤判／次數／類別／過度遮蔽都在白名單與上界內', () => {
    const violations: string[] = [];
    for (const score of docScores) {
      for (const miss of score.misses) {
        if (!isKnownLimitation(miss.category, score.format, 'miss')) {
          violations.push(`${score.file}：漏抓 ${miss.category}「${miss.value}」（偵測類別 ${miss.detectedCategories.join('/') || '無'}）`);
        }
      }
      // 值不存在（萃取保真）與誤判沒有白名單：公司已改用不換行欄位控制案例，任何值消失都要調查。
      for (const notFound of score.valueNotFound) {
        violations.push(`${score.file}：值不存在於萃取文字 ${notFound.category}「${notFound.value}」`);
      }
      for (const residual of score.residuals) {
        const f = residual.finding;
        const kind = residual.partial > 0 ? '部分遮蔽' : '殘留';
        if (!isKnownLimitation(f.category, score.format, 'residual')) {
          violations.push(`${score.file}：${kind} ${f.category}「${f.value}」× ${f.uncovered}`);
        }
      }
      for (const fp of score.falsePositives) {
        violations.push(`${score.file}：誤判 ${fp.category}「${fp.span}」`);
      }
      for (const or of score.overRedactions) {
        violations.push(`${score.file}：過度遮蔽 ${or.category}「${or.span}」（超出部分「${or.excess}」）`);
      }
      for (const ce of score.categoryErrors) {
        violations.push(`${score.file}：類別錯誤 ${ce.category}「${ce.value}」@${ce.start}（偵測為 ${ce.detectedCategories.join('/')}）`);
      }
      for (const cm of score.countMismatches) {
        violations.push(`${score.file}：次數不符 ${cm.category}「${cm.value}」期望 ${cm.expectedOccurrences} 實際 ${cm.actualOccurrences}`);
      }
      // 白名單上界：醫師姓名開始漏抓、表格日期規則退化等，都會衝破上界轉紅。
      for (const k of KNOWN_LIMITATIONS) {
        if (!k.formats.includes(score.format)) continue;
        const n = limitationCount(score, k.category, k.kind);
        if (n > k.maxPerDoc) {
          violations.push(`${score.file}：${k.category} 的 ${k.kind} 有 ${n} 筆，超過每份文件上界 ${k.maxPerDoc}`);
        }
      }
    }
    expect(docScores).toHaveLength(answerKey.documents.length);
    expect(violations.join('\n')).toBe('');
  });

  it('txt／md 的 builtin 命中率為 100%', () => {
    for (const score of docScores.filter((s) => s.format === 'txt' || s.format === 'md')) {
      const total = score.findings.filter((f) => f.expectation === 'builtin').length;
      const hits = score.findings.filter((f) => f.expectation === 'builtin' && f.hit && f.categoryOk).length;
      expect(hits, `${score.file}：builtin ${hits}/${total}`).toBe(total);
      expect(score.countMismatches, `${score.file}：txt／md 不應有次數不符`).toHaveLength(0);
    }
  });

  it('audit 案例確實存在於文件中（供人工／AI 稽核）', () => {
    for (const score of docScores) {
      for (const f of score.audit) {
        expect(f.actualOccurrences, `${score.file}：audit 值未出現於文件「${f.value}」`).toBeGreaterThan(0);
      }
    }
  });

  it('去識別化輸出不含已涵蓋的值，還原後等於原文', () => {
    const violations: string[] = [];
    for (const [i, score] of docScores.entries()) {
      const roundtrip = roundtrips[i];
      if (roundtrip.missingCodes.length > 0) {
        violations.push(`${score.file}：有 marker 找不到對照（${roundtrip.missingCodes.join('、')}）`);
      }
      // PDF 重新產生後再解析，換行與空白會漂移（roundtrip-pdf.test.ts 同樣以去空白比較）；其餘格式位元組一致。
      const normalize = (s: string) => (score.format === 'pdf' ? s.replace(/\s/g, '') : s);
      if (normalize(roundtrip.restored) !== normalize(roundtrip.original)) {
        violations.push(`${score.file}：還原後與原文不同`);
      }
      for (const f of score.findings) {
        if (f.expectation !== 'builtin') continue;
        const remaining = locateOccurrences(roundtrip.redacted, f.value).length;
        // 完整涵蓋與部分遮蔽的位置，值都會被 marker 打斷而消失；只有完全未觸及的位置允許存活。
        const untouched = f.uncovered - f.partial;
        if (remaining > untouched) {
          violations.push(`${score.file}：輸出仍含已涵蓋值 ${f.category}「${f.value}」× ${remaining - untouched}`);
        }
      }
    }
    expect(violations.join('\n')).toBe('');
  });
});
