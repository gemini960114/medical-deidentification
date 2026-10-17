// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ enabled: true, reply: '[]' }));
vi.mock('../../scripts/lib/audit-config.ts', () => ({ loadAuditConfig: () => state.enabled ? {
  baseUrl: 'https://example.test/v1', apiKey: 'test', model: 'mock', retryDelayMs: 0,
  fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: state.reply } }] })),
} : null }));
vi.mock('../../scripts/lib/pdf-audit.ts', () => ({
  extractEmbeddedJpegs: async () => [],
  renderAuditPdf: async () => [{ page: 1, text: '', dataUrl: 'data:image/jpeg;base64,YWJj' }],
}));
import { main } from '../../scripts/scan-pii.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scan-cli-test-'));
  state.enabled = true; state.reply = '[]';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('scan-pii failure gates', () => {
  it('fails on image-only findings absent from the text layer and reports the page', async () => {
    const path = join(root, 'image.pdf'); writeFileSync(path, 'synthetic mock PDF');
    const report = join(root, 'report.json');
    state.reply = '[{"category":"姓名","value":"合成人物"}]';
    expect(await main([path, '--report', report, '--fail-on-findings'])).toBe(1);
    const output = JSON.parse(readFileSync(report, 'utf8'));
    expect(output.reviewCount).toBe(1);
    expect(output.results[0].findings[0]).toMatchObject({ page: 1, source: 'vision', status: 'unlocatable' });
  });
  it('fails when PDF audit has no configured endpoint', async () => {
    state.enabled = false;
    expect(await main([join(root, 'missing.pdf')])).toBe(1);
  });
  it('does not silently skip unsupported files and continues processing valid files', async () => {
    const text = join(root, 'synthetic.txt'); writeFileSync(text, '全合成無個資');
    const report = join(root, 'report.json');
    expect(await main([join(root, 'input.docx'), text, '--report', report])).toBe(1);
    const output = JSON.parse(readFileSync(report, 'utf8'));
    expect(output.failures).toHaveLength(1);
    expect(output.results).toHaveLength(1);
  });
  it.each(['not JSON', '[{"value":"x"}]'])('rejects invalid text AI output: %s', async (reply) => {
    const text = join(root, 'synthetic.txt'); writeFileSync(text, '全合成文件');
    state.reply = reply;
    expect(await main([text, '--fail-on-findings'])).toBe(1);
  });
  it('accepts explicit [] from the visual model', async () => {
    const path = join(root, 'image.pdf'); writeFileSync(path, 'synthetic mock PDF');
    expect(await main([path, '--fail-on-findings'])).toBe(0);
  });
});
