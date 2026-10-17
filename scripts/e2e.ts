// Browser acceptance: real upload → detection → downloads → restore upload → restored download.
// Entirely synthetic, no model/network credentials, no external document requests.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { generateCorpus } from './batch-test-generator/generate.ts';
import { auditBrowser } from './lib/audit-browser.ts';
import { extractEmbeddedJpegs, renderAuditPdf } from './lib/pdf-audit.ts';
import { createAuditServer } from '../server/http.ts';
import type { ModelFinding, ModelRequest } from '../src/core/model-contract.ts';

const root = mkdtempSync(join(tmpdir(), 'deid-e2e-'));
let answers: ModelFinding[] = [];
let failModel = false;
const modelRequests: ModelRequest[] = [];
const api = createAuditServer({ models: ['test-A', 'test-B', 'test-C'], visionModels: ['test-C'], defaultModel: 'test-A', accessToken: 'e2e-code',
  audit: async (request) => {
    modelRequests.push(request);
    if (failModel) throw new Error('mock provider failure');
    return { model: request.model, textCompleted: true, visionCompleted: request.vision && Boolean(request.pages?.length), findings: answers };
  } });
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const session = await auditBrowser(`http://127.0.0.1:${(api.address() as { port: number }).port}`);
const { page, origin } = session;
page.on('console', (message) => { if (message.text().startsWith('E2E ')) console.log(message.text()); });
await page.evaluateOnNewDocument(() => document.addEventListener('click', (event) => {
  const element = event.target as Element;
  if (element.closest?.('.restore-result .btn-primary')) console.info('E2E restore download clicked');
  if (element instanceof HTMLAnchorElement && element.download) console.info('E2E download anchor: ' + element.download);
}, true));
const errors: string[] = [];
const external: string[] = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('request', (request) => {
  if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) external.push(request.url());
  if (request.method() === 'POST' && request.url() !== origin + 'api/detect') external.push(`Unexpected POST ${request.url()}`);
});
page.on('dialog', (dialog) => { void dialog.accept(); });

async function waitFile(path: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (existsSync(path) && statSync(path).size > 0 && !existsSync(path + '.crdownload')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  const state = await page.evaluate(() => ({ toast: document.querySelector('.toast-host')?.textContent, inert: document.getElementById('app')?.hasAttribute('inert'), restore: document.querySelector('.restore-result .toolbar')?.textContent }));
  throw new Error(`下載逾時：${basename(path)}；目前檔案：${readdirSync(root).join(', ')}；畫面：${JSON.stringify(state)}`);
}

async function parsedText(path: string) {
  return page.evaluate(async (bytes, name) => {
    const url = '/src/formats/index.ts';
    const formats = await import(/* @vite-ignore */ url) as typeof import('../src/formats/index.ts');
    return (await formats.parseDocument(new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], name))).text;
  }, readFileSync(path).toString('base64'), basename(path));
}

async function ready() {
  // Result DOM is rendered before withBusy's finally removes inert; clicks during that gap are discarded.
  await page.waitForFunction(() => !document.getElementById('app')?.hasAttribute('inert'));
}

try {
  const generated = await generateCorpus({ count: 1, seed: 17, format: 'all', layout: 'realistic', output: root });
  answers = generated.answerKey.documents[0].findings.map((f) => ({ category: f.category, value: f.value, reason: 'synthetic E2E answer', source: 'text' }));
  const docx = generated.answerKey.documents.find((d) => d.format === 'docx')!;
  const zip = await JSZip.loadAsync(readFileSync(join(generated.runDir, docx.file)));
  const xml = await zip.file('word/document.xml')!.async('string');
  assert.match(xml, /<w:br w:type="page"/);
  assert.match(xml, /<w:tc>[\s\S]*?<w:tbl>/);
  const pdfFile = generated.answerKey.documents.find((d) => d.format === 'pdf')!;
  const pdfBytes = new Uint8Array(readFileSync(join(generated.runDir, pdfFile.file)));
  assert.ok((await PDFDocument.load(pdfBytes)).getPageCount() >= 3, 'realistic PDF must span at least three pages');
  console.log('Testing full-page PDF rendering');
  const rendered = await renderAuditPdf(pdfBytes, 100, session);
  assert.ok(rendered.length >= 3);
  assert.ok(rendered.every((p) => p.dataUrl.startsWith('data:image/jpeg;base64,')));

  // A rotated image-only PDF exercises page appearance instead of assuming XObject[0] is the page.
  const imagePdf = await PDFDocument.create();
  const jpg = await imagePdf.embedJpg(Buffer.from(rendered[0].dataUrl.split(',')[1], 'base64'));
  const imgPage = imagePdf.addPage([595, 842]);
  imgPage.drawImage(jpg, { x: 0, y: 0, width: 595, height: 842 });
  const { degrees } = await import('pdf-lib');
  imgPage.setRotation(degrees(90));
  const imageBytes = await imagePdf.save();
  assert.equal((await extractEmbeddedJpegs(imageBytes)).length, 1);
  console.log('Testing rotated image-only PDF rendering');
  const scanPages = await renderAuditPdf(imageBytes, 100, session);
  assert.equal(scanPages.length, 1);
  assert.equal(scanPages[0].text.trim(), '');
  assert.ok(scanPages[0].dataUrl.length > 1000);

  const cdp = await session.browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: root, eventsEnabled: true });
  cdp.on('Browser.downloadWillBegin', (event) => console.log('Download started: ' + event.suggestedFilename));
  cdp.on('Browser.downloadProgress', (event) => { if (event.state === 'canceled') console.log('Download canceled: ' + event.guid); });
  const paths = [...generated.answerKey.documents.map((d) => join(generated.runDir, d.file)), join(generated.runDir, '病患總表.xlsx')];
  for (const path of paths) {
    console.log(`Testing ${basename(path)}`);
    await page.goto(origin);
    await page.waitForSelector('select[aria-label="辨識模型"] option');
    assert.equal(await page.$eval('input[aria-label="文字 LLM 辨識（必要）"]', (e) => (e as HTMLInputElement).checked && (e as HTMLInputElement).disabled), true);
    await page.type('input[aria-label="服務存取碼"]', 'e2e-code');
    console.log('  parsing original');
    const original = await parsedText(path);
    console.log('  uploading');
    const name = basename(path);
    const dot = name.lastIndexOf('.');
    const stem = name.slice(0, dot);
    const ext = name.slice(dot);
    if (ext === '.md') await page.select('select[aria-label="辨識模型"]', 'test-B');
    if (ext === '.pdf') {
      await page.select('select[aria-label="辨識模型"]', 'test-C');
      await page.click('input[data-vision-option]');
    }
    // Downloads from successive formats share a stem: remove only this generated CSV between cases.
    const mapping = join(root, `${stem}.mapping.csv`);
    if (existsSync(mapping)) rmSync(mapping);
    const input = await page.waitForSelector('.process-view input[type=file]');
    await input!.uploadFile(path);
    console.log('  waiting model result');
    await page.waitForSelector('.toolbar-actions .btn-strong', { timeout: 60_000 });
    console.log('  downloading');
    await page.waitForSelector('[data-ai-completed]');
    await ready();
    await page.click('.output-panel > summary');
    await page.click('label:has(input[name="output-mode"][value="code"])');
    await page.click('.toolbar-actions .btn-strong');
    const redactedPath = join(root, `${stem}.deid${ext}`);
    await waitFile(redactedPath); await waitFile(mapping);
    const redacted = await parsedText(redactedPath);
    assert.match(redacted, /\[[^\]]+:[^\]]+\]/, `${name}: output must contain markers`);
    for (const f of generated.answerKey.documents[0].findings.filter((f) => ['身分證', '電子郵件'].includes(f.category))) {
      assert.ok(!redacted.includes(f.value), `${name}: output retains ${f.category}`);
    }
    await page.click('[data-tab="restore"]');
    const docInput = await page.waitForSelector('.restore-slot:first-child input[type=file]');
    await docInput!.uploadFile(redactedPath);
    await page.waitForFunction((name) => document.querySelector('.restore-slot:first-child .file-chip')?.textContent?.includes(name), {}, basename(redactedPath));
    await ready();
    const csvInput = await page.waitForSelector('.restore-slot:nth-child(2) input[type=file]');
    await csvInput!.uploadFile(mapping);
    await page.waitForSelector('.restore-result .btn-primary', { timeout: 60_000 });
    await ready();
    // The preview changes page geometry while fonts/layout settle. Locator clicks wait for a stable target.
    await page.locator('.restore-result .btn-primary').click();
    const restoredPath = join(root, `${stem}.restored${ext}`);
    await waitFile(restoredPath);
    const restored = await parsedText(restoredPath);
    const normalize = (s: string) => ext === '.pdf' ? s.replace(/\s/g, '') : s;
    assert.equal(normalize(restored), normalize(original), `${name}: restored text differs`);
    console.log(`PASS ${ext}: upload → detect → download → restore → exact text`);
  }
  assert.equal(modelRequests.length, 5);
  assert.ok(modelRequests.every((request) => request.text.trim().length > 0));
  assert.equal(modelRequests[1].model, 'test-B');
  assert.equal(modelRequests[3].model, 'test-C');
  assert.ok(modelRequests[3].vision && modelRequests[3].pages!.length >= 3);
  assert.ok(modelRequests.filter((_, i) => i !== 3).every((request) => !request.vision && !request.pages?.length));
  failModel = true;
  await page.goto(origin);
  await page.waitForSelector('input[aria-label="服務存取碼"]');
  await page.type('input[aria-label="服務存取碼"]', 'e2e-code');
  await (await page.waitForSelector('.process-view input[type=file]'))!.uploadFile(paths[0]);
  await page.waitForFunction(() => document.body.textContent?.includes('模型辨識未完成'));
  assert.equal(await page.$('.toolbar-actions .btn-strong'), null, 'model failure must not expose a rule-only download');
  assert.deepEqual(external, [], 'browser must contact only the same-origin model backend');
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('PASS: mandatory text model, model selection, PDF vision opt-in, five UI formats, failed-model download blocking, no browser provider keys.');
} finally {
  await session.close();
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
