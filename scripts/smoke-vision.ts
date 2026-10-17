// Opt-in live endpoint check using one wholly synthetic, image-only PDF.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { auditBrowser } from './lib/audit-browser.ts';
import { main } from './scan-pii.ts';

const root = mkdtempSync(join(tmpdir(), 'deid-vision-smoke-'));
const session = await auditBrowser();
try {
  const dataUrl = await session.page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 400;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'black'; ctx.font = '36px Arial';
    ctx.fillText('SYNTHETIC TEST DOCUMENT', 40, 70);
    ctx.fillText('Patient Name: Test Patient', 40, 150);
    ctx.fillText('Email: qa@example.invalid', 40, 220);
    return canvas.toDataURL('image/jpeg', 0.95);
  });
  const pdf = await PDFDocument.create();
  const image = await pdf.embedJpg(Buffer.from(dataUrl.split(',')[1], 'base64'));
  pdf.addPage([900, 400]).drawImage(image, { x: 0, y: 0, width: 900, height: 400 });
  const path = join(root, 'synthetic-scan.pdf');
  const report = join(root, 'report.json');
  writeFileSync(path, await pdf.save());
  const code = await main([path, '--report', report, '--fail-on-findings']);
  const result = JSON.parse(readFileSync(report, 'utf8')) as { failures: unknown[]; reviewCount: number; results: { findings: { value: string; page: number; status: string }[] }[] };
  assert.equal(result.failures.length, 0);
  assert.equal(code, 1, 'visible PII in an image-only PDF must fail the audit gate');
  assert.ok(result.results[0].findings.some((f) => f.value === 'qa@example.invalid' && f.page === 1 && f.status === 'unlocatable'));
  console.log('PASS: live image-only PDF audit found the synthetic email and failed the residual-PII gate.');
} finally {
  await session.close();
  rmSync(root, { recursive: true, force: true });
}
