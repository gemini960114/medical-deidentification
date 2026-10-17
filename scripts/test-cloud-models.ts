// Explicit live test: only synthetic text and one generated image, using the production service engine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadAuditConfig } from './lib/audit-config.ts';
import { auditBrowser } from './lib/audit-browser.ts';
import { runModelAudit } from '../server/service.ts';

const config = loadAuditConfig();
if (!config) throw new Error('需要模型端點設定');
const models = [...new Set((process.env.OPENAI_MODEL_Available ?? config.model).split(',').map((v) => v.trim()).filter(Boolean))];
const session = await auditBrowser();
try {
  const text = 'SYNTHETIC TEST ONLY\nPatient Name: Test Patient\nEmail: qa@example.invalid';
  const dataUrl = await session.page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 400;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'black'; ctx.font = '36px Arial';
    ctx.fillText('SYNTHETIC TEST ONLY', 40, 70); ctx.fillText('Patient Name: Test Patient', 40, 150); ctx.fillText('Email: qa@example.invalid', 40, 220);
    return canvas.toDataURL('image/jpeg', 0.95);
  });
  const rows = [];
  for (const model of models) {
    const start = performance.now();
    try {
      const result = await runModelAudit({ text, model, vision: true, pages: [{ page: 1, dataUrl }] }, config);
      const textHit = result.findings.some((f) => f.source === 'text' && f.value === 'qa@example.invalid');
      const visionHit = result.findings.some((f) => f.source === 'vision' && f.value === 'qa@example.invalid');
      rows.push({ model, textHit, visionHit, seconds: Number(((performance.now() - start) / 1000).toFixed(1)), findings: result.findings });
      if (!textHit || !visionHit) process.exitCode = 1;
    } catch (error) { rows.push({ model, error: error instanceof Error ? error.message : '模型測試失敗' }); process.exitCode = 1; }
  }
  mkdirSync('scripts/batch-test-generator/output', { recursive: true });
  writeFileSync('scripts/batch-test-generator/output/model-vision.json', JSON.stringify({ synthetic: true, rows }, null, 2) + '\n');
  console.table(rows.map(({ findings: _findings, ...row }) => row));
} finally { await session.close(); }
