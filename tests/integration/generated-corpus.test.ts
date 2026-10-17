// 產生語料自動驗收：generate.ts 以固定種子產生全合成出院病歷摘要（txt／md／docx／pdf），
// 走完整流程 parseDocument → detect → score 對照 answer-key → applyRedactions → generateDocument →
// 再解析 → restore。answer-key 的 expectation 分兩層：
//   builtin＝內建規則必須命中；audit＝刻意留給人工／AI 稽核的案例，不算內建失敗。
// 已知限制（docx／pdf 表格日期、無標籤英文姓名重複、PDF 換行拆值）定義在 score.ts 的
// KNOWN_LIMITATIONS：白名單內的漏抓／殘留會出現在報告但不計失敗；白名單外的漏抓、殘留或
// 任何誤判都會讓測試失敗。規則進步（misses／residuals 變少）只會讓測試更綠，不會失敗。
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
  locateOccurrences,
  scoreDocument,
  summarize,
  type AnswerKey,
  type DocScore,
} from '../../scripts/batch-test-generator/score.ts';

/** 2 個病例 × 4 種格式＝8 份文件：同一批病人的值橫跨四種格式，便於比較格式間差異。 */
const CASES = 2;
const SEED = 17;

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
  it('builtin 答案命中且無誤判（已知限制白名單除外）', () => {
    const violations: string[] = [];
    for (const score of docScores) {
      for (const miss of score.misses) {
        if (!isKnownLimitation(miss.category, score.format, 'miss')) {
          violations.push(`${score.file}：漏抓 ${miss.category}「${miss.value}」（偵測類別 ${miss.detectedCategories.join('/') || '無'}）`);
        }
      }
      for (const notFound of score.valueNotFound) {
        if (!isKnownLimitation(notFound.category, score.format, 'valueNotFound')) {
          violations.push(`${score.file}：值不存在於萃取文字 ${notFound.category}「${notFound.value}」`);
        }
      }
      for (const residual of score.residuals) {
        if (!isKnownLimitation(residual.finding.category, score.format, 'residual')) {
          violations.push(`${score.file}：殘留 ${residual.finding.category}「${residual.finding.value}」× ${residual.finding.uncovered}`);
        }
      }
      if (score.falsePositives.length > 0) {
        violations.push(`${score.file}：誤判 ${score.falsePositives.map((fp) => `${fp.category}「${fp.span}」`).join('、')}`);
      }
    }
    // 殘留上界：每份文件至多 1 處（無標籤英文姓名重複）；規則進步只會更少。
    const residualTotal = docScores.reduce((n, s) => n + s.residuals.reduce((m, r) => m + r.finding.uncovered, 0), 0);
    expect(residualTotal).toBeLessThanOrEqual(docScores.length);
    expect(docScores).toHaveLength(answerKey.documents.length);
    expect(violations.join('\n')).toBe('');
  });

  it('txt／md 的 builtin 命中率為 100%', () => {
    for (const score of docScores.filter((s) => s.format === 'txt' || s.format === 'md')) {
      const total = score.findings.filter((f) => f.expectation === 'builtin').length;
      const hits = score.findings.filter((f) => f.expectation === 'builtin' && f.hit && f.categoryOk).length;
      expect(hits, `${score.file}：builtin ${hits}/${total}`).toBe(total);
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
        // 已涵蓋的出現位置必須從輸出消失；僅允許未涵蓋（白名單殘留）的位置存活。
        if (remaining > f.uncovered) {
          violations.push(`${score.file}：輸出仍含已涵蓋值 ${f.category}「${f.value}」× ${remaining - f.uncovered}`);
        }
      }
    }
    expect(violations.join('\n')).toBe('');
  });
});
