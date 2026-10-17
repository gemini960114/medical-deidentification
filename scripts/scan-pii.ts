// 批次個資稽核：內建規則（第一層）＋ AI 語意偵測（第二層，選用）。
// 用法：npm run scan-pii -- <檔案.txt|.md> [更多檔案…] [--fail-on-findings]
// 設定：複製 .env.example 成 .env，填入 OpenAI 相容端點的 Base URL、API Key 與模型。
// 未設定端點時只跑內建規則；AI 層用於驗收端複核——文件內容會送到設定的端點，屬預期行為。
import { existsSync, readFileSync } from 'node:fs';
import { detect } from '../src/core/detector.ts';
import { BUILTIN_PATTERNS } from '../src/core/patterns.ts';
import { aiDetect, classifyFindings } from '../src/core/ai-detect.ts';

// .env（Node ≥ 20.12 內建 process.loadEnvFile；更舊的版本看不到 .env——明確告知，不靜默略過）
if (typeof process.loadEnvFile !== 'function') {
  if (existsSync('.env')) {
    console.error('偵測到 .env，但此 Node 版本沒有 process.loadEnvFile（需要 Node ≥ 20.12）。請升級 Node，或改用環境變數提供端點設定。');
  }
} else {
  try {
    process.loadEnvFile();
  } catch {
    /* 沒有 .env */
  }
}

const args = process.argv.slice(2);
const failOnFindings = args.includes('--fail-on-findings');
const files = args.filter((a) => !a.startsWith('-'));
if (!files.length) {
  console.log('用法：npm run scan-pii -- <檔案.txt|.md> [更多檔案…] [--fail-on-findings]');
  console.log('       先複製 .env.example 成 .env 填入端點資訊，即可加上 AI 語意偵測。');
  console.log('       --fail-on-findings：有任何補抓（殘留個資）時以結束碼 1 結束，供批次驗收或 CI 判定。');
  process.exit(1);
}

const baseUrl = process.env.OPENAI_API_BASE;
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? 'Inkling-Small';
const aiEnabled = Boolean(baseUrl && apiKey);
if (aiEnabled) console.log(`AI 語意偵測：${model} @ ${baseUrl}`);
else console.log('AI 語意偵測：未設定 .env，僅跑內建規則。');

let totalMissed = 0;
const failed: string[] = [];
for (const file of files) {
  if (!/\.(txt|md)$/i.test(file)) {
    console.log(`\n⏭  ${file}：僅支援 .txt／.md（其他格式請先匯出為文字）`);
    continue;
  }
  console.log(`\n=== ${file} ===`);
  try {
    const text = readFileSync(file, 'utf8');
    const builtin = detect(text, BUILTIN_PATTERNS);
    console.log(`內建規則：${builtin.length} 筆`);

    if (aiEnabled) {
      const findings = await aiDetect(text, {
        baseUrl: baseUrl!,
        apiKey: apiKey!,
        model,
        onProgress: (done, total) => console.log(`  AI 語意偵測中… ${done}/${total} 段`),
      });
      const classified = classifyFindings(text, findings, builtin);
      const lineOf = (index: number) => text.slice(0, index).split('\n').length;
      const confirmed = classified.filter((f) => f.status === 'confirmed');
      const missed = classified.filter((f) => f.status === 'missed');
      const unlocatable = classified.filter((f) => f.status === 'unlocatable');
      totalMissed += missed.length;
      console.log(`AI 語意偵測：${classified.length} 筆＝證實 ${confirmed.length}＋補抓 ${missed.length}＋無法定位 ${unlocatable.length}`);
      for (const f of missed) {
        const lines = [...new Set(f.uncovered.map(lineOf))].join('、');
        console.log(`  ⚠ 補抓  ${f.category}「${f.value}」第 ${lines} 行（${f.reason}）`);
      }
      for (const f of unlocatable) console.log(`  ？ 無法定位  ${f.category}「${f.value}」—原文中找不到此字串`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failed.push(`${file}：${msg}`);
    console.log(`  ✗ 失敗：${msg}（繼續處理其餘檔案）`);
  }
}

console.log(aiEnabled ? `\n完成：AI 補抓 ${totalMissed} 筆（供人工覆核，補抓項目請回工具內圈選或新增規則）。` : '\n完成。');
if (failed.length) {
  console.log(`\n掃描失敗 ${failed.length} 個檔案：`);
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
if (failOnFindings && totalMissed > 0) {
  console.log('\n--fail-on-findings：偵測到補抓項目，以結束碼 1 結束。');
  process.exit(1);
}
