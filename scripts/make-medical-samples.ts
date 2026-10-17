/** Reproducible medical homepage samples; never read real patient records. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateCorpus } from './batch-test-generator/generate.ts';
import { detect } from '../src/core/detector.ts';
import { getEffectivePatterns } from '../src/core/pattern-store.ts';
import { CodeBook } from '../src/core/codes.ts';
import { applyRedactions } from '../src/core/redactor.ts';
import { serializeMapping } from '../src/core/csv.ts';
const generated = await generateCorpus({ count: 3, seed: 20261017, format: 'all', layout: 'realistic', output: 'scripts/batch-test-generator/output' });
const target = 'public/samples'; mkdirSync(target, { recursive: true });
const cases = [...new Set(generated.answerKey.documents.map((d) => d.caseId))];
const files = [
  ['medical-discharge.docx', 'docx', 0], ['medical-discharge.pdf', 'pdf', 0],
  ['medical-followup.pdf', 'pdf', 1], ['medical-notes.md', 'md', 1], ['medical-summary.txt', 'txt', 2],
] as const;
for (const [file, format, index] of files) {
  const source = generated.answerKey.documents.find((d) => d.caseId === cases[index] && d.format === format)!;
  copyFileSync(join(generated.runDir, source.file), join(target, file));
}
copyFileSync(join(generated.runDir, '病患總表.xlsx'), join(target, 'medical-roster.xlsx'));
const text = readFileSync(join(target, 'medical-summary.txt'), 'utf8');
const items = detect(text, getEffectivePatterns(), new CodeBook());
const result = applyRedactions(text, items);
writeFileSync(join(target, 'medical-summary.deid.txt'), result.redactedText);
writeFileSync(join(target, 'medical-summary.mapping.csv'), serializeMapping(result.mapping));
writeFileSync(join(target, 'medical-manifest.json'), JSON.stringify({ synthetic: true, seed: 20261017, cases: 3, generator: 'scripts/make-medical-samples.ts', note: '同病例 Word/PDF、跨頁追蹤、病患總表與成對還原範例；範例遮蔽依內建規則產生，不是 LLM 全面驗收結果。', files: [...files.map(([file]) => file), 'medical-roster.xlsx', 'medical-summary.deid.txt', 'medical-summary.mapping.csv'] }, null, 2) + '\n');
console.log('醫療範例已產生：六份原始檔及一組文字還原範例，全合成資料。');
