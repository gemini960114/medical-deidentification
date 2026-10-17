// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createAuditServer } from '../../server/http.ts';
import { runModelAudit, validateRequest } from '../../server/service.ts';
import type { ModelRequest } from '../../src/core/model-contract.ts';

const input: ModelRequest = { text: '全合成文件 qa@example.invalid', model: 'test-model', vision: false, pages: [] };
const modelReply = (content = '[]') => new Response(JSON.stringify({ choices: [{ message: { content } }] }));

describe('mandatory text model service', () => {
  it('always invokes text and never sends images while vision is disabled', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string).messages[1].content).toBe(input.text);
      return modelReply();
    });
    expect(await runModelAudit(input, { baseUrl: 'https://example.invalid/v1', apiKey: 'secret', model: 'test-model', fetch })).toMatchObject({ textCompleted: true, visionCompleted: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('runs text then the selected visual pages', async () => {
    const fetch = vi.fn(async () => modelReply('[{"category":"電子郵件","value":"qa@example.invalid"}]'));
    const result = await runModelAudit({ ...input, vision: true, pages: [{ page: 2, dataUrl: 'data:image/jpeg;base64,YWJj' }] }, { baseUrl: 'https://example.invalid/v1', apiKey: 'secret', model: 'test-model', fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.findings.map((f) => f.source)).toEqual(['text', 'vision']);
    expect(result.findings[1].page).toBe(2);
  });
  it.each([{ ...input, text: '' }, { ...input, model: 'arbitrary-model' }, { ...input, textEnabled: false }, { ...input, pages: [{ page: 1, dataUrl: 'https://evil.invalid/image' }] }])('rejects invalid or bypass requests', (value) => {
    expect(() => validateRequest(value, ['test-model'])).toThrow();
  });
});

describe('HTTP model boundary', () => {
  async function run(test: (base: string, audit: ReturnType<typeof vi.fn>) => Promise<void>, hourlyLimit = 60) {
    const audit = vi.fn(async () => ({ model: 'test-model', textCompleted: true as const, visionCompleted: false, findings: [] }));
    const server = createAuditServer({ models: ['test-model'], defaultModel: 'test-model', accessToken: 'service-code', audit, hourlyLimit });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try { await test(`http://127.0.0.1:${(server.address() as { port: number }).port}`, audit); }
    finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
  const post = (base: string, token = 'service-code', origin?: string) => fetch(base + '/api/detect', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(input),
  });
  it('returns safe model configuration without keys or provider URL', async () => run(async (base) => {
    const config = await (await fetch(base + '/api/config')).json();
    expect(config).toMatchObject({ textRequired: true, accessRequired: true, models: ['test-model'] });
    expect(JSON.stringify(config)).not.toContain('service-code');
    expect(config).not.toHaveProperty('apiKey');
  }));
  it('blocks missing/wrong access codes before model calls', async () => run(async (base, audit) => {
    expect((await post(base, '')).status).toBe(401); expect(audit).not.toHaveBeenCalled();
  }));
  it('rejects cross-origin calls', async () => run(async (base, audit) => {
    expect((await post(base, 'service-code', 'https://evil.invalid')).status).toBe(403); expect(audit).not.toHaveBeenCalled();
  }));
  it('enforces the per-instance hourly allowance', async () => run(async (base, audit) => {
    expect((await post(base)).status).toBe(200); expect((await post(base)).status).toBe(429); expect(audit).toHaveBeenCalledTimes(1);
  }, 1));
  it('does not report a model failure as successful rule-only detection', async () => run(async (base, audit) => {
    audit.mockRejectedValueOnce(new Error('private-provider-response'));
    const response = await post(base); expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private-provider-response');
  }));
});
