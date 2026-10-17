// 批次個資稽核：內建規則（第一層）＋ AI 語意偵測（第二層，選用）。
// 用法：npm run scan-pii -- <檔案.txt|.md> [更多檔案…]
// 設定：複製 .env.example 成 .env，填入 OpenAI 相容端點的 Base URL、API Key 與模型。
// 未設定端點時只跑內建規則；AI 層用於驗收端複核——文件內容會送到設定的端點，屬預期行為。
import { readFileSync } from 'node:fs';
import { detect } from '../src/core/detector.ts';
import { BUILTIN_PATTERNS } from '../src/core/patterns.ts';
import { aiDetect, locateFindings } from '../src/core/ai-detect.ts';
import type { RedactionItem } from '../src/core/types.ts';

// .env（存在時才載入；Node ≥ 20.12 內建，不存在的話安靜略過）
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    /* 沒有 .env */
  }
}

const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!files.length) {
  console.log('用法：npm run scan-pii -- <檔案.txt|.md> [更多檔案…]');
  console.log('       先複製 .env.example 成 .env 填入端點資訊，即可加上 AI 語意偵測。');
  process.exit(1);
}

const baseUrl = process.env.OPENAI_API_BASE;
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? 'Inkling-Small';
const aiEnabled = Boolean(baseUrl && apiKey);
if (aiEnabled) console.log(`AI 語意偵測：${model} @ ${baseUrl}`);
else console.log('AI 語意偵測：未設定 .env，僅跑內建規則。');

const overlap = (item: RedactionItem, start: number, end: number) => item.start < end && start < item.end;

let totalMissed = 0;
for (const file of files) {
  if (!/\.(txt|md)$/i.test(file)) {
    console.log(`\n⏭  ${file}：僅支援 .txt／.md（其他格式請先匯出為文字）`);
    continue;
  }
  const text = readFileSync(file, 'utf8');
  console.log(`\n=== ${file} ===`);
  const builtin = detect(text, BUILTIN_PATTERNS);
  console.log(`內建規則：${builtin.length} 筆`);

  if (aiEnabled) {
    const findings = await aiDetect(text, {
      baseUrl: baseUrl!,
      apiKey: apiKey!,
      model,
      onProgress: (done, total) => console.log(`  AI 語意偵測中… ${done}/${total} 段`),
    });
    const located = locateFindings(text, findings);
    const covered = (f: (typeof located)[number]) => {
      if (f.start === null) return false;
      const { start } = f;
      return builtin.some((it) => overlap(it, start, start + f.value.length));
    };
    const confirmed = located.filter(covered);
    const missed = located.filter((f) => f.start !== null && !covered(f));
    const unlocatable = located.filter((f) => f.start === null);
    totalMissed += missed.length;
    console.log(`AI 語意偵測：${located.length} 筆＝證實 ${confirmed.length}＋補抓 ${missed.length}＋無法定位 ${unlocatable.length}`);
    for (const f of missed) console.log(`  ⚠ 補抓  ${f.category}「${f.value}」（${f.reason}）`);
    for (const f of unlocatable) console.log(`  ？ 無法定位  ${f.category}「${f.value}」—原文中找不到此字串`);
  }
}

console.log(aiEnabled ? `\n完成：AI 補抓 ${totalMissed} 筆（供人工覆核，補抓項目請回工具內圈選或新增規則）。` : '\n完成。');
