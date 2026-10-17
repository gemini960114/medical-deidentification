// Acceptance-side only: explicit CLI use sends document text/images to the configured endpoint.
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detect } from '../src/core/detector.ts';
import { BUILTIN_PATTERNS } from '../src/core/patterns.ts';
import { aiDetect, classifyFindings } from '../src/core/ai-detect.ts';
import { loadAuditConfig } from './lib/audit-config.ts';
import { auditImage, type AuditPage } from './lib/vision-audit.ts';
import { extractEmbeddedJpegs, renderAuditPdf } from './lib/pdf-audit.ts';

export function parseScanArgs(args: string[]) {
  const files: string[] = [];
  let report: string | undefined;
  let failOnFindings = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fail-on-findings') failOnFindings = true;
    else if (args[i] === '--report') {
      report = args[++i];
      if (!report || report.startsWith('-')) throw new Error('--report 缺少 JSON 輸出路徑');
    } else if (args[i].startsWith('-')) throw new Error(`未知參數：${args[i]}`);
    else files.push(args[i]);
  }
  if (!files.length) throw new Error('用法：npm run scan-pii -- <txt|md|pdf|png|jpg> […] [--fail-on-findings] [--report report.json]');
  if (report && files.some((file) => resolve(file) === resolve(report))) throw new Error('報告不得覆寫輸入文件');
  return { files, report, failOnFindings };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const options = parseScanArgs(args);
  const config = loadAuditConfig();
  const results: unknown[] = [];
  const failures: { file: string; error: string }[] = [];
  let reviewCount = 0;
  console.log(config ? `AI 稽核模型：${config.model}（文件內容會送到設定端點）` : '未設定 AI 端點，TXT／MD 僅跑內建規則；圖像／PDF 視覺稽核需要端點。');
  for (const file of options.files) {
    console.log(`\n=== ${file} ===`);
    try {
      const ext = extname(file).toLowerCase();
      if (ext === '.txt' || ext === '.md') {
        const text = readFileSync(file, 'utf8');
        const builtin = detect(text, BUILTIN_PATTERNS);
        const findings = config ? classifyFindings(text, await aiDetect(text, config), builtin) : [];
        const review = findings.filter((f) => f.status !== 'confirmed');
        reviewCount += review.length;
        results.push({ file, mode: config ? 'text-ai' : 'builtin-only', builtin: builtin.length, findings });
        console.log(`內建 ${builtin.length} 筆；AI 待覆核 ${review.length} 筆`);
        for (const f of review) {
          const lines = [...new Set(f.uncovered.map((at) => text.slice(0, at).split('\n').length))];
          console.log(`  ${f.status === 'missed' ? '補抓' : '無法定位'} ${f.category}「${f.value}」${lines.length ? `第 ${lines.join('、')} 行` : ''} ${f.reason}`);
        }
      } else if (['.pdf', '.png', '.jpg', '.jpeg'].includes(ext)) {
        if (!config) throw new Error('視覺稽核必須設定 AI 端點，不可略過後回報成功');
        const bytes = new Uint8Array(readFileSync(file));
        let pages: AuditPage[];
        let embeddedJpegs = 0;
        if (ext === '.pdf') {
          embeddedJpegs = (await extractEmbeddedJpegs(bytes)).length;
          pages = await renderAuditPdf(bytes);
        } else {
          const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
          const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
          if (!png && !jpeg) throw new Error('檔案不是有效 PNG／JPEG');
          pages = [{ page: 1, text: '', dataUrl: `data:image/${png ? 'png' : 'jpeg'};base64,${Buffer.from(bytes).toString('base64')}` }];
        }
        const findings: unknown[] = [];
        const result = { file, mode: 'vision', pages: pages.length, embeddedJpegs, findings, complete: false };
        results.push(result);
        for (const page of pages) {
          const visual = await auditImage(page, config);
          const classified = classifyFindings(page.text, visual, detect(page.text, BUILTIN_PATTERNS));
          const review = classified.filter((f) => f.status !== 'confirmed');
          reviewCount += review.length;
          findings.push(...classified.map((f) => ({ ...f, page: page.page, source: 'vision' })));
          console.log(`第 ${page.page}/${pages.length} 頁：視覺 ${visual.length} 筆，待覆核 ${review.length} 筆`);
          for (const f of review) console.log(`  ${f.status} ${f.category}「${f.value}」${f.reason}`);
        }
        result.complete = true;
      } else throw new Error('不支援的格式；請提供 TXT／MD／PDF／PNG／JPEG');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ file, error: message });
      console.error(`失敗：${message}（繼續其餘文件）`);
    }
  }
  if (options.report) writeFileSync(options.report, JSON.stringify({ results, failures, reviewCount }, null, 2) + '\n');
  console.log(`\n完成：待人工覆核 ${reviewCount} 筆，失敗 ${failures.length} 個檔案。`);
  return failures.length || (options.failOnFindings && reviewCount > 0) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '稽核失敗'); process.exitCode = 1;
  });
}
