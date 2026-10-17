import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModelSettings, requestModelAudit } from '../../src/core/model-client.ts';
import type { LoadedDocument } from '../../src/core/types.ts';
const doc: LoadedDocument = { fileName: 'synthetic.txt', format: 'txt', text: '全合成 qa@example.invalid', handle: null };
afterEach(() => vi.unstubAllGlobals());
describe('same-origin model client', () => {
  it('sends required text and no images when unchecked; keeps provider keys out of the request', async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe('/api/detect');
      expect(JSON.parse(init!.body as string)).toEqual({ text: doc.text, model: 'model-B', vision: false, pages: [] });
      expect(init!.headers).toMatchObject({ Authorization: 'Bearer service-code' });
      return new Response(JSON.stringify({ model: 'model-B', textCompleted: true, visionCompleted: false, findings: [] }));
    });
    vi.stubGlobal('fetch', fetch);
    await requestModelAudit(doc, 'model-B', false, 'service-code', new File([doc.text], doc.fileName), 20);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not accept incomplete text inference', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ textCompleted: false, findings: [] })));
    await expect(requestModelAudit(doc, 'm', false, '', new File([doc.text], doc.fileName), 20)).rejects.toThrow('未完整');
  });
  it('fails clearly if the model backend is unavailable', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
    await expect(getModelSettings()).rejects.toThrow('尚未就緒');
  });
});
