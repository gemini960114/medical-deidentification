import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildXlsx, type CellSpec } from '../../tests/helpers/xlsx-builder.ts';
import { Fake } from '../lib/fake.ts';
import type { DocModel } from '../lib/docmodel.ts';
import { renderDocx } from '../lib/render-docx.ts';
import { renderPdf } from '../lib/render-pdf.ts';

type OutputFormat = 'txt' | 'md' | 'docx' | 'pdf';
type FormatChoice = OutputFormat | 'mixed' | 'all';
type Expectation = 'builtin' | 'audit';

interface FindingSeed {
  category: string;
  value: string;
  expectation: Expectation;
  note?: string;
}

interface FindingAnswer extends FindingSeed {
  occurrences: number;
}

interface MedicalCase {
  caseId: string;
  patientName: string;
  englishName: string;
  twId: string;
  mrn: string;
  birthday: string;
  admissionDate: string;
  dischargeDate: string;
  surgeryDate: string;
  mobile: string;
  landline: string;
  address: string;
  email: string;
  emergencyName: string;
  emergencyMobile: string;
  doctorName: string;
  doctorEnglish: string;
  clinic: string;
  examId: string;
  reverseDate: string;
  diagnosis: string;
}

interface AnswerDocument {
  caseId: string;
  file: string;
  format: OutputFormat;
  findings: FindingAnswer[];
}

export interface CorpusConfig {
  count: number;
  seed: number;
  format: FormatChoice;
  /** 輸出根目錄（相對路徑以專案根為準）；語料會寫進 seed-…-count-…-format 子資料夾。 */
  output: string;
}

export interface AnswerKey {
  generatedAt: string;
  synthetic: boolean;
  notice: string;
  config: CorpusConfig;
  documents: AnswerDocument[];
}

const DEFAULT_OUTPUT = 'scripts/batch-test-generator/output';
const FORMATS: OutputFormat[] = ['txt', 'md', 'docx', 'pdf'];
const ENGLISH_FIRST = ['Emily', 'Olivia', 'Sophia', 'Amelia', 'James', 'Daniel', 'Henry', 'Lucas', 'Grace', 'Ethan'];
const ENGLISH_LAST = ['Chen', 'Lin', 'Wang', 'Chang', 'Lee', 'Huang', 'Tsai', 'Wu', 'Liu', 'Chou'];
const DIAGNOSES = ['社區型肺炎', '急性闌尾炎', '第二型糖尿病控制不佳', '右膝退化性關節炎', '泌尿道感染', '急性腸胃炎', '高血壓合併暈眩', '左側橈骨骨折'];
const CLINICS = ['晴川聯合診所', '安和家庭診所', '康澤聯合診所', '仁心內科診所'];

function parsePositiveInt(raw: string | undefined, fallback: number, name: string, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} 必須是 1–${max} 的整數`);
  return value;
}

function option(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`--${name} 缺少值`);
  return args[at + 1];
}

function parseArgs(args: string[]): { count: number; seed: number; format: FormatChoice; output: string } {
  const count = parsePositiveInt(option(args, 'count'), 100, '--count', 10_000);
  const seed = parsePositiveInt(option(args, 'seed'), 20_261_017, '--seed', 2_147_483_647);
  const format = (option(args, 'format') ?? 'mixed') as FormatChoice;
  if (![...FORMATS, 'mixed', 'all'].includes(format)) throw new Error('--format 必須是 mixed、all、txt、md、docx 或 pdf');
  const output = option(args, 'output') ?? DEFAULT_OUTPUT;
  return { count, seed, format, output };
}

function pad(n: number, width = 4): string {
  return String(n).padStart(width, '0');
}

function makeCase(seed: number, index: number): MedicalCase {
  const f = new Fake(seed + index * 7919);
  const month = (index % 10) + 1;
  const day = (index % 20) + 2;
  const date = (offset: number) => `2026-${pad(month, 2)}-${pad(Math.min(28, day + offset), 2)}`;
  const englishName = `${ENGLISH_FIRST[index % ENGLISH_FIRST.length]} ${ENGLISH_LAST[(index * 3) % ENGLISH_LAST.length]}`;
  const doctorEnglish = `${ENGLISH_FIRST[(index + 4) % ENGLISH_FIRST.length]} ${ENGLISH_LAST[(index * 7 + 1) % ENGLISH_LAST.length]}`;
  return {
    caseId: `CASE-${pad(index)}`,
    patientName: f.name(),
    englishName,
    twId: f.twId(),
    mrn: `MRN-2026-${pad(index, 6)}`,
    birthday: f.birthday(),
    admissionDate: date(0),
    surgeryDate: date(1),
    dischargeDate: date(4),
    mobile: f.mobile(),
    landline: f.landline(),
    address: f.address(),
    email: f.email(),
    emergencyName: f.name(),
    emergencyMobile: f.mobile(),
    doctorName: f.name(),
    doctorEnglish,
    clinic: CLINICS[index % CLINICS.length],
    examId: `LAB-${String(20260000 + index)}-${pad((index % 97) + 1, 2)}`,
    reverseDate: date(8),
    diagnosis: DIAGNOSES[index % DIAGNOSES.length],
  };
}

function plainText(c: MedicalCase): string {
  return `晴川醫療體系\n出院病歷摘要（全合成測試資料）\n\n病例編號：${c.caseId}\n病歷號：${c.mrn}\n姓名：${c.patientName}\nPatient Name: ${c.englishName}\n身分證字號：${c.twId}\n出生日期：${c.birthday}\n聯絡手機：${c.mobile}\n住家電話：${c.landline}\n通訊地址：${c.address}\n電子郵件：${c.email}\n緊急聯絡人：${c.emergencyName}　手機：${c.emergencyMobile}\n\n入院日期：${c.admissionDate}\n手術日期：${c.surgeryDate}\n出院日期：${c.dischargeDate}\n主治醫師：${c.doctorName}（Dr. ${c.doctorEnglish}）\n轉介院所：${c.clinic}\n\n入院診斷\n${c.diagnosis}\n\n住院經過\n${c.patientName}因${c.diagnosis}住院治療，由 Dr. ${c.doctorEnglish} 負責照護。${c.englishName}於治療後症狀改善，生命徵象穩定。\n另安排於 ${c.reverseDate} 入院接受日間檢查，院內檢查序號 ${c.examId}，此行刻意使用日期在標籤前與非內建編號標籤，供人工或 AI 稽核。\n\n出院指示\n請依醫囑服藥，若有不適請聯絡 ${c.mobile}，並攜帶病歷號 ${c.mrn} 回診。\n\n本文件所有人物與資料均由程式合成，與任何真實人物無關。\n`;
}

function markdownText(c: MedicalCase): string {
  const text = plainText(c);
  return text
    .replace('晴川醫療體系\n出院病歷摘要（全合成測試資料）', '# 晴川醫療體系\n\n## 出院病歷摘要（全合成測試資料）')
    .replace('\n入院診斷\n', '\n## 入院診斷\n')
    .replace('\n住院經過\n', '\n## 住院經過\n')
    .replace('\n出院指示\n', '\n## 出院指示\n');
}

function docModel(c: MedicalCase): DocModel {
  return {
    title: `出院病歷摘要－${c.caseId}`,
    header: `晴川醫療體系　出院病歷摘要　${c.caseId}`,
    footer: '全合成測試資料・與任何真實人物無關',
    blocks: [
      { type: 'title', text: '出院病歷摘要' },
      { type: 'subtitle', text: '全合成測試資料' },
      {
        type: 'kv',
        rows: [
          ['病例編號／病歷號', `${c.caseId}　${c.mrn}`],
          ['姓名／英文姓名', `${c.patientName}　Patient Name: ${c.englishName}`],
          ['身分證字號／出生日期', `${c.twId}　出生日期：${c.birthday}`],
          ['聯絡方式', `手機 ${c.mobile}　電話 ${c.landline}　電子郵件 ${c.email}`],
          ['通訊地址', c.address],
          ['緊急聯絡人', `${c.emergencyName}　手機 ${c.emergencyMobile}`],
        ],
      },
      { type: 'heading', text: '住院資料' },
      {
        type: 'table',
        columns: [
          { header: '入院日期', width: 1 },
          { header: '手術日期', width: 1 },
          { header: '出院日期', width: 1 },
          { header: '主治醫師', width: 1.4 },
        ],
        rows: [[c.admissionDate, c.surgeryDate, c.dischargeDate, `${c.doctorName}／Dr. ${c.doctorEnglish}`]],
      },
      { type: 'heading', text: '入院診斷' },
      { type: 'para', text: c.diagnosis },
      { type: 'heading', text: '住院經過' },
      { type: 'para', text: `${c.patientName}因${c.diagnosis}住院治療，由 Dr. ${c.doctorEnglish} 負責照護。${c.englishName}於治療後症狀改善，生命徵象穩定。`, indent: true },
      { type: 'para', text: `另安排於 ${c.reverseDate} 入院接受日間檢查，院內檢查序號 ${c.examId}，轉介院所為${c.clinic}。`, indent: true },
      { type: 'heading', text: '出院指示' },
      { type: 'para', text: `請依醫囑服藥，若有不適請聯絡 ${c.mobile}，並攜帶病歷號 ${c.mrn} 回診。`, indent: true },
    ],
  };
}

function planted(c: MedicalCase): FindingSeed[] {
  return [
    { category: '病歷號', value: c.mrn, expectation: 'builtin' },
    { category: '姓名', value: c.patientName, expectation: 'builtin' },
    { category: '英文姓名', value: c.englishName, expectation: 'builtin', note: '首次有 Patient Name 標籤，後文重複一次且無標籤' },
    { category: '身分證', value: c.twId, expectation: 'builtin' },
    { category: '生日', value: c.birthday, expectation: 'builtin' },
    { category: '手機', value: c.mobile, expectation: 'builtin' },
    { category: '市話', value: c.landline, expectation: 'builtin' },
    { category: '地址', value: c.address, expectation: 'builtin' },
    { category: '電子郵件', value: c.email, expectation: 'builtin' },
    { category: '姓名', value: c.emergencyName, expectation: 'builtin' },
    { category: '手機', value: c.emergencyMobile, expectation: 'builtin' },
    { category: '醫療日期', value: c.admissionDate, expectation: 'builtin' },
    { category: '醫療日期', value: c.surgeryDate, expectation: 'builtin' },
    { category: '醫療日期', value: c.dischargeDate, expectation: 'builtin' },
    { category: '姓名', value: c.doctorName, expectation: 'builtin' },
    { category: '英文姓名', value: `Dr. ${c.doctorEnglish}`, expectation: 'builtin' },
    { category: '公司', value: c.clinic, expectation: 'builtin' },
    { category: '醫療日期', value: c.reverseDate, expectation: 'audit', note: '日期在「入院」之前，內建標籤規則刻意不命中' },
    { category: '識別碼', value: c.examId, expectation: 'audit', note: '院內檢查序號，需 AI 或自訂規則' },
  ];
}

function occurrenceCount(text: string, value: string): number {
  if (!value) return 0;
  let count = 0;
  let at = 0;
  while ((at = text.indexOf(value, at)) >= 0) {
    count++;
    at += value.length;
  }
  return count;
}

function answerFor(c: MedicalCase, text: string): FindingAnswer[] {
  return planted(c).map((finding) => ({ ...finding, occurrences: occurrenceCount(text, finding.value) }));
}

function formatFor(choice: FormatChoice, index: number): OutputFormat[] {
  if (choice === 'all') return FORMATS;
  if (choice === 'mixed') return [FORMATS[(index - 1) % FORMATS.length]];
  return [choice];
}

async function writeDocument(dir: string, c: MedicalCase, format: OutputFormat, font: Uint8Array): Promise<string> {
  const base = `${c.caseId}-出院病歷摘要`;
  const file = `${base}.${format}`;
  const path = join(dir, file);
  if (format === 'txt') writeFileSync(path, plainText(c));
  else if (format === 'md') writeFileSync(path, markdownText(c));
  else if (format === 'docx') writeFileSync(path, await renderDocx(docModel(c)));
  else writeFileSync(path, await renderPdf(docModel(c), font));
  return file;
}

/** 產生一批全合成語料（文件＋病患總表＋標準答案），回傳輸出資料夾與 answer-key。 */
export async function generateCorpus(config: CorpusConfig): Promise<{ runDir: string; answerKey: AnswerKey }> {
  const outputRoot = isAbsolute(config.output) ? config.output : resolve(config.output);
  const runName = `seed-${config.seed}-count-${config.count}-${config.format}`;
  const runDir = join(outputRoot, runName);
  mkdirSync(runDir, { recursive: true });

  const font = new Uint8Array(readFileSync('public/fonts/NotoSansTC-Regular.ttf'));
  const cases = Array.from({ length: config.count }, (_, i) => makeCase(config.seed, i + 1));
  const answers: AnswerDocument[] = [];

  for (const [i, c] of cases.entries()) {
    for (const format of formatFor(config.format, i + 1)) {
      const file = await writeDocument(runDir, c, format, font);
      const text = format === 'md' ? markdownText(c) : plainText(c);
      answers.push({ caseId: c.caseId, file, format, findings: answerFor(c, text) });
    }
    if ((i + 1) % 10 === 0 || i + 1 === cases.length) console.log(`已產生 ${i + 1}/${cases.length} 個病例`);
  }

  const headers: CellSpec[] = ['病例編號', '病歷號', '姓名', '英文姓名', '身分證字號', '出生日期', '入院日期', '手術日期', '出院日期', '手機', '市話', '地址', '電子郵件', '緊急聯絡人', '緊急手機', '主治醫師', '英文醫師', '轉介院所', '檢查序號', '診斷'];
  const rows: CellSpec[][] = cases.map((c) => [c.caseId, c.mrn, c.patientName, c.englishName, c.twId, c.birthday, c.admissionDate, c.surgeryDate, c.dischargeDate, c.mobile, c.landline, c.address, c.email, c.emergencyName, c.emergencyMobile, c.doctorName, `Dr. ${c.doctorEnglish}`, c.clinic, c.examId, c.diagnosis]);
  writeFileSync(join(runDir, '病患總表.xlsx'), await buildXlsx({ sheets: [{ name: '合成病患', rows: [headers, ...rows] }], headerOnlyBold: true }));

  const answerKey: AnswerKey = {
    generatedAt: new Date().toISOString(),
    synthetic: true,
    notice: '所有資料由固定種子合成，與任何真實人物無關。builtin 為內建規則預期命中；audit 為刻意保留給人工或 AI 稽核的案例。',
    config,
    documents: answers,
  };
  writeFileSync(join(runDir, 'answer-key.json'), JSON.stringify(answerKey, null, 2) + '\n');
  writeFileSync(
    join(runDir, 'README.txt'),
    `醫療文件批次測試資料\n\n所有資料均為程式合成，不含真實個資。\n病例數：${config.count}\n文件格式：${config.format}\n亂數種子：${config.seed}\n文件數：${answers.length}\n另含：病患總表.xlsx、answer-key.json\n`,
  );
  return { runDir, answerKey };
}

async function main(): Promise<void> {
  const { runDir, answerKey } = await generateCorpus(parseArgs(process.argv.slice(2)));
  console.log(`完成：${answerKey.documents.length} 份文件＋1 份 Excel＋標準答案`);
  console.log(`輸出位置：${runDir}`);
}

// 僅在直接以 CLI 執行時才跑 main（被測試或其他腳本 import 時不產生副作用）
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

