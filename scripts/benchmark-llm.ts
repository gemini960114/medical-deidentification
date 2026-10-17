// LLM 偵測準確度 benchmark：以批次測試產生器的全合成語料（模擬試題）當考卷，
// 比較「內建規則（第一層）」與「各 LLM 端點（第二層）」的值層表現：
//   召回（builtin 層／audit 層分開算——audit 案例是刻意設計給 AI 抓的規則盲點）、
//   精確率（FP＝找到答案以外的值）、幻覺（回傳值根本不在文本裡）、類別正確率、延遲。
// 用法：npm run benchmark-llm -- [--docs N] [--seed S] [--models m1,m2] [--json 路徑]
// 設定：複製 .env.example 成 .env（同 scan-pii）；未設定端點時仍會跑內建規則基準線。
// 紅線：驗收端工具——語料為全合成虛構資料，送到設定端點屬預期行為；網頁 App 永不使用此模組。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detect } from '../src/core/detector.ts';
import { BUILTIN_PATTERNS } from '../src/core/patterns.ts';
import { aiDetect } from '../src/core/ai-detect.ts';
import { generateCorpus } from './batch-test-generator/generate.ts';
import type { CorpusFinding } from './batch-test-generator/score.ts';

/** 被評測系統回報的一筆偵測（值層；規則與 LLM 都轉成這個形狀，確保公平比較）。 */
export interface FoundItem {
  category: string;
  value: string;
}

/** 單份文件的計分（值層；同一 category＋值只計一次）。 */
export interface DocBenchScore {
  /** 值命中：答案值被找到。 */
  tp: number;
  /** 值命中但類別與答案不同。 */
  categoryErrors: number;
  /** FP：找到答案以外的值（語料為全合成，答案清單即完整真值）。 */
  fp: number;
  /** 幻覺：FP 且該值根本不存在於文本。 */
  unlocatable: number;
  /** builtin 答案未被找到（LLM 也應該要抓到的）。 */
  fnBuiltin: number;
  /** audit 答案未被找到（刻意留給 AI 的規則盲點）。 */
  fnAudit: number;
  builtinTotal: number;
  auditTotal: number;
  fpSamples: string[];
  fnSamples: string[];
}

const emptyDocScore = (): DocBenchScore => ({
  tp: 0,
  categoryErrors: 0,
  fp: 0,
  unlocatable: 0,
  fnBuiltin: 0,
  fnAudit: 0,
  builtinTotal: 0,
  auditTotal: 0,
  fpSamples: [],
  fnSamples: [],
});

/**
 * 對一份文件計分：found（被評測系統的偵測，值層去重後）對照 answer-key。
 * 值比對採去除首尾空白後的字串相等；found 的值若不在文本中，另計為幻覺。
 */
export function scoreDoc(answers: CorpusFinding[], found: FoundItem[], text: string): DocBenchScore {
  const score = emptyDocScore();
  const byValue = new Map(answers.map((a) => [a.value.trim(), a]));
  const seen = new Set<string>();
  const pairs: FoundItem[] = [];
  for (const f of found) {
    const key = f.value.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const answer = byValue.get(key);
    pairs.push(found.find((candidate) => candidate.value.trim() === key && candidate.category === answer?.category) ?? f);
  }
  for (const f of pairs) {
    const value = f.value.trim();
    const ans = byValue.get(value);
    if (!ans) {
      score.fp++;
      if (!text.includes(value)) score.unlocatable++;
      if (score.fpSamples.length < 5) score.fpSamples.push(`${f.category}「${value}」`);
    } else {
      score.tp++;
      if (f.category !== ans.category) score.categoryErrors++;
    }
  }
  for (const a of answers) {
    if (!pairs.some((f) => f.value.trim() === a.value.trim())) {
      if (a.expectation === 'audit') {
        score.fnAudit++;
        score.auditTotal++;
      } else {
        score.fnBuiltin++;
        score.builtinTotal++;
      }
      if (score.fnSamples.length < 5) score.fnSamples.push(`${a.category}「${a.value}」`);
    } else if (a.expectation === 'audit') score.auditTotal++;
    else score.builtinTotal++;
  }
  return score;
}

/** 跨文件彙總成一列報表數據。 */
export interface BenchRow {
  模型: string;
  文件: number;
  值命中: number;
  類別錯誤: number;
  誤判FP: number;
  幻覺: number;
  漏抓builtin: number;
  漏抓audit: number;
  召回builtin: string;
  召回audit: string;
  精確率: string;
  F1: string;
  延遲秒: string;
  誤判樣本: string[];
  漏抓樣本: string[];
}

const pct = (hit: number, total: number): string => (total ? `${((hit / total) * 100).toFixed(1)}%` : '—');

export function aggregateRow(model: string, docs: DocScored[]): BenchRow {
  const s = docs.reduce(
    (acc, d) => {
      acc.tp += d.score.tp;
      acc.categoryErrors += d.score.categoryErrors;
      acc.fp += d.score.fp;
      acc.unlocatable += d.score.unlocatable;
      acc.builtinTotal += d.score.builtinTotal;
      acc.auditTotal += d.score.auditTotal;
      acc.fnBuiltin += d.score.fnBuiltin;
      acc.fnAudit += d.score.fnAudit;
      return acc;
    },
    { tp: 0, categoryErrors: 0, fp: 0, unlocatable: 0, builtinTotal: 0, auditTotal: 0, fnBuiltin: 0, fnAudit: 0 },
  );
  const builtinHit = s.builtinTotal - s.fnBuiltin;
  const auditHit = s.auditTotal - s.fnAudit;
  const recall = (builtinHit + auditHit) / (s.builtinTotal + s.auditTotal || 1);
  const precision = s.tp / (s.tp + s.fp || 1);
  const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
  return {
    模型: model,
    文件: docs.length,
    值命中: s.tp,
    類別錯誤: s.categoryErrors,
    誤判FP: s.fp,
    幻覺: s.unlocatable,
    漏抓builtin: s.fnBuiltin,
    漏抓audit: s.fnAudit,
    召回builtin: pct(builtinHit, s.builtinTotal),
    召回audit: pct(auditHit, s.auditTotal),
    精確率: pct(s.tp, s.tp + s.fp),
    F1: `${(f1 * 100).toFixed(1)}%`,
    延遲秒: (docs.reduce((n, d) => n + d.latencyMs, 0) / 1000).toFixed(1),
    誤判樣本: [...new Set(docs.flatMap((d) => d.score.fpSamples))].slice(0, 5),
    漏抓樣本: [...new Set(docs.flatMap((d) => d.score.fnSamples))].slice(0, 5),
  };
}

export interface DocScored {
  file: string;
  score: DocBenchScore;
  latencyMs: number;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** .env（Node ≥ 20.12 內建 process.loadEnvFile）。 */
function loadEnv(): void {
  if (typeof process.loadEnvFile !== 'function') {
    if (existsSync('.env')) {
      console.error('偵測到 .env，但此 Node 版本沒有 process.loadEnvFile（需要 Node ≥ 20.12）。');
    }
    return;
  }
  try {
    process.loadEnvFile();
  } catch {
    /* 沒有 .env */
  }
}

async function main(): Promise<void> {
  loadEnv();
  const docs = Math.min(50, Math.max(1, Number(option(process.argv.slice(2), 'docs') ?? 2)));
  const seed = Number(option(process.argv.slice(2), 'seed') ?? 20260101);
  const jsonPath = option(process.argv.slice(2), 'json');
  const baseUrl = process.env.OPENAI_API_BASE;
  const apiKey = process.env.OPENAI_API_KEY;
  const models = (option(process.argv.slice(2), 'models') ?? process.env.OPENAI_MODEL_Available ?? process.env.OPENAI_MODEL ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  console.log(`產生模擬試題（全合成語料）：${docs} 病例 × 各格式，種子 ${seed} …`);
  const { runDir, answerKey } = await generateCorpus({ count: docs, seed, format: 'all', output: 'scripts/batch-test-generator/output', layout: 'realistic' });
  const corpus = answerKey.documents
    .filter((d) => /\.(txt|md)$/.test(d.file))
    .map((d) => ({ file: d.file, text: readFileSync(join(runDir, d.file), 'utf8'), findings: d.findings }));
  console.log(`考卷：${corpus.length} 份（${docs} 病例 × txt／md），共 ${corpus.reduce((n, c) => n + c.findings.length, 0)} 個答案值。\n`);

  const rows: BenchRow[] = [];
  const failures: { model: string; error: string }[] = [];
  const predictions = new Map<string, FoundItem[][]>();
  const latencies = new Map<string, number[]>();

  // 第一列：內建規則基準線（確定性、零成本、零外傳）。
  const ruleDocs: DocScored[] = corpus.map((c) => {
    const t0 = performance.now();
    const items = detect(c.text, BUILTIN_PATTERNS);
    const found: FoundItem[] = items.map((it) => ({ category: it.category, value: c.text.slice(it.start, it.end) }));
    return { file: c.file, score: scoreDoc(c.findings, found, c.text), latencyMs: performance.now() - t0 };
  });
  rows.push(aggregateRow('內建規則（第一層）', ruleDocs));
  const rules = corpus.map((c) => detect(c.text, BUILTIN_PATTERNS).map((it) => ({ category: it.category, value: c.text.slice(it.start, it.end) })));

  // 後續列：各 LLM 模型。
  if (baseUrl && apiKey && models.length) {
    for (const model of models) {
      console.log(`評測模型：${model} …`);
      const modelDocs: DocScored[] = [];
      const values: FoundItem[][] = [];
      try {
        for (const [i, c] of corpus.entries()) {
          const t0 = performance.now();
          const findings = await aiDetect(c.text, { baseUrl, apiKey, model, timeoutMs: 120000 });
          values.push(findings);
          modelDocs.push({
            file: c.file,
            score: scoreDoc(c.findings, findings, c.text),
            latencyMs: performance.now() - t0,
          });
          console.log(`  (${i + 1}/${corpus.length}) ${c.file}：${findings.length} 筆偵測`);
        }
      } catch (err) {
        failures.push({ model, error: err instanceof Error ? err.message : String(err) });
        console.error(`  模型 ${model} 失敗：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      rows.push(aggregateRow(model, modelDocs));
      predictions.set(model, values);
      latencies.set(model, modelDocs.map((d) => d.latencyMs));
      rows.push(aggregateRow(`規則＋${model}`, corpus.map((c, i) => ({ file: c.file,
        score: scoreDoc(c.findings, [...rules[i], ...values[i]], c.text), latencyMs: modelDocs[i].latencyMs }))));
    }
  } else {
    console.log('未設定 .env 或 --models，僅跑內建規則基準線（要比較 LLM：cp .env.example .env 並填入端點）。\n');
  }

  if (predictions.size) rows.push(aggregateRow('規則＋全部成功模型聯集', corpus.map((c, i) => ({ file: c.file,
    score: scoreDoc(c.findings, [...rules[i], ...[...predictions.values()].flatMap((values) => values[i])], c.text),
    latencyMs: [...latencies.values()].reduce((sum, values) => sum + values[i], 0) }))));

  console.table(
    rows.map((r) => ({
      模型: r.模型,
      文件: r.文件,
      值命中: r.值命中,
      類別錯誤: r.類別錯誤,
      誤判FP: r.誤判FP,
      幻覺: r.幻覺,
      漏抓builtin: r.漏抓builtin,
      漏抓audit: r.漏抓audit,
      召回builtin: r.召回builtin,
      召回audit: r.召回audit,
      精確率: r.精確率,
      F1: r.F1,
      延遲秒: r.延遲秒,
    })),
  );
  for (const r of rows) {
    if (r.誤判樣本.length) console.log(`${r.模型} 誤判樣本：${r.誤判樣本.join('、')}`);
    if (r.漏抓樣本.length) console.log(`${r.模型} 漏抓樣本：${r.漏抓樣本.join('、')}`);
  }
  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), seed, cases: docs, documents: corpus.length,
        note: '值層評測；TXT／MD 同病例內容相關，尚非視覺或逐位置遮蔽成績。聯集延遲為各模型循序呼叫耗時總和。', rows, failures,
        predictions: Object.fromEntries(predictions) }, null, 2),
      'utf8',
    );
    console.log(`\nJSON 報告：${jsonPath}`);
  }
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
