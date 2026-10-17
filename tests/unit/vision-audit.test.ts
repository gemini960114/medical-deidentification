// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { auditImage, strictFindings } from '../../scripts/lib/vision-audit.ts';
import { extractEmbeddedJpegs } from '../../scripts/lib/pdf-audit.ts';
import { parseScanArgs } from '../../scripts/scan-pii.ts';

const config = { baseUrl: 'https://example.test/v1', apiKey: 'test', model: 'vision', retryDelayMs: 0 };
const image = { page: 2, text: '', dataUrl: 'data:image/jpeg;base64,YWJj' };
const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));

describe('visual audit', () => {
  it('sends local image_url and preserves page attribution for image-only values', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: image.dataUrl } });
      expect(body.messages[1].content[0].text).toContain('第 2 頁');
      return reply('[{"category":"姓名","value":"合成姓名","reason":"表格"}]');
    });
    expect(await auditImage(image, { ...config, fetch })).toEqual([{ category: '姓名', value: '合成姓名', reason: '表格', page: 2, source: 'vision' }]);
  });
  it.each(['no PII', '{broken', '{"findings":[]}', '[{"category":"姓名"}]', '[null]', '[{"category":"姓名","value":" "}]'])('rejects malformed responses instead of passing: %s', (content) => {
    expect(() => strictFindings(content)).toThrow();
  });
  it('accepts explicit empty JSON and fenced valid JSON', () => {
    expect(strictFindings('[]')).toEqual([]);
    expect(strictFindings('```json\n[]\n```')).toEqual([]);
  });
  it('fails on truncation and empty completion', async () => {
    for (const choice of [{ message: { content: '[]' }, finish_reason: 'length' }, { message: { content: '' } }]) {
      await expect(auditImage(image, { ...config, fetch: async () => new Response(JSON.stringify({ choices: [choice] })) })).rejects.toThrow('不完整');
    }
  });
  it('rejects remote image URLs', async () => {
    await expect(auditImage({ ...image, dataUrl: 'https://example.test/a.jpg' }, config)).rejects.toThrow('本機');
  });
  it('extracts all page JPEGs from the synthetic scan PDF', async () => {
    const pages = await extractEmbeddedJpegs(new Uint8Array(readFileSync('public/samples/scanned.pdf')));
    expect(pages.length).toBeGreaterThanOrEqual(5);
    expect(new Set(pages.map((p) => p.page)).size).toBe(5);
    expect(pages.every((p) => p.dataUrl.startsWith('data:image/jpeg;base64,/9j/'))).toBe(true);
  });
  it('accepts text/vector PDFs without image XObjects', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    expect(await extractEmbeddedJpegs(await pdf.save())).toEqual([]);
  });
});

describe('scan CLI args', () => {
  it('separates report options from document paths', () => {
    expect(parseScanArgs(['a.pdf', '--report', 'out.json', '--fail-on-findings'])).toEqual({ files: ['a.pdf'], report: 'out.json', failOnFindings: true });
  });
  it.each([[], ['a.pdf', '--report'], ['a.pdf', '--unknown'], ['a.pdf', '--report', 'a.pdf']])('rejects invalid args: %j', (...args) => {
    expect(() => parseScanArgs(args as string[])).toThrow();
  });
});
