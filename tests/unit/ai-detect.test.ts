import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiDetect, chunkText, locateFindings, parseFindings } from '../../src/core/ai-detect';

const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe('parseFindings', () => {
  it('parses a strict JSON array', () => {
    expect(parseFindings('[{"category":"英文姓名","value":"John Wang","reason":"醫師"}]')).toEqual([
      { category: '英文姓名', value: 'John Wang', reason: '醫師' },
    ]);
  });

  it('reads the array out of prose or code fences and tolerates a missing reason', () => {
    const fenced = '```json\n[{"category":"病歷號","value":"A12345678"}]\n```';
    expect(parseFindings(fenced)).toEqual([{ category: '病歷號', value: 'A12345678', reason: '' }]);
    const prose = '以下是結果：\n[{"category":"姓名","value":"王小明","reason":"個案"}] 以上。';
    expect(parseFindings(prose)).toEqual([{ category: '姓名', value: '王小明', reason: '個案' }]);
  });

  it('drops items without a string category or value, and returns [] for anything else', () => {
    expect(parseFindings('[{"value":"x"},{"category":"姓名"},42,null]')).toEqual([]);
    expect(parseFindings('[]')).toEqual([]);
    expect(parseFindings('沒有個資')).toEqual([]);
    expect(parseFindings('[broken')).toEqual([]);
    expect(parseFindings('{"not":"an array"}')).toEqual([]);
  });
});

describe('chunkText', () => {
  it('keeps short text as one chunk and drops empty text', () => {
    expect(chunkText('一行\n兩行')).toEqual(['一行\n兩行']);
    expect(chunkText('')).toEqual([]);
    expect(chunkText(' \n  ')).toEqual([]);
  });

  it('splits long text at line boundaries, never mid-line and never over the limit', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `第${i}行：一些內容`);
    const text = lines.join('\n');
    const chunks = chunkText(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(30);
      for (const line of c.split('\n')) expect(lines).toContain(line); // 每行都完整
    }
    expect(chunks.join('\n')).toBe(text);
  });

  it('hard-splits a single line longer than the limit without breaking surrogate pairs', () => {
    const long = '𝓍'.repeat(25) + '字'.repeat(25); // 50 code points
    const chunks = chunkText(long, 30);
    expect(chunks).toEqual(['𝓍'.repeat(25) + '字'.repeat(5), '字'.repeat(20)]);
  });
});

describe('locateFindings', () => {
  it('locates each value, walking repeated values forward', () => {
    const text = '王小明就診，王小明回診';
    const located = locateFindings(text, [
      { category: '姓名', value: '王小明', reason: '' },
      { category: '姓名', value: '王小明', reason: '' },
    ]);
    expect(located.map((f) => f.start)).toEqual([0, 6]);
  });

  it('marks values not in the text as null', () => {
    const located = locateFindings('原文', [{ category: '姓名', value: '不存在的字串', reason: '' }]);
    expect(located).toEqual([{ category: '姓名', value: '不存在的字串', reason: '', start: null }]);
  });
});

describe('aiDetect', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the endpoint per chunk with temperature 0 and merges repeated findings', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(init!.body as string) });
        return reply('[{"category":"英文姓名","value":"John Wang","reason":"醫師"}]');
      }),
    );
    const findings = await aiDetect('由 John Wang 醫師主治，John Wang 負責追蹤。', {
      baseUrl: 'https://example.test/api/v1/',
      apiKey: 'k',
      model: 'm',
      retryDelayMs: 0,
    });
    expect(findings).toEqual([{ category: '英文姓名', value: 'John Wang', reason: '醫師' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.test/api/v1/chat/completions');
    expect(calls[0].body.temperature).toBe(0);
    expect(calls[0].body.model).toBe('m');
  });

  it('reports progress per chunk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('[]')));
    const seen: string[] = [];
    await aiDetect('a\nb\nc\nd\ne\nf\ng\nh', {
      baseUrl: 'https://example.test/api/v1',
      apiKey: 'k',
      model: 'm',
      retryDelayMs: 0,
      onProgress: (done, total) => seen.push(`${done}/${total}`),
    });
    expect(seen).toEqual(['1/1']);
  });

  it('retries a 429 once and succeeds on the second attempt', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (++calls === 1) return new Response('rate limited', { status: 429 });
        return reply('[]');
      }),
    );
    await expect(
      aiDetect('文本', { baseUrl: 'https://example.test/api/v1', apiKey: 'k', model: 'm', retryDelayMs: 0 }),
    ).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  it('fails fast on a 401 without retrying, with the endpoint status in the message', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response('unauthorized', { status: 401 });
      }),
    );
    await expect(
      aiDetect('文本', { baseUrl: 'https://example.test/api/v1', apiKey: 'bad', model: 'm', retryDelayMs: 0 }),
    ).rejects.toThrow(/AI 偵測請求失敗.*401/);
    expect(calls).toBe(1);
  });

  it('throws after two retryable network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))));
    await expect(
      aiDetect('文本', { baseUrl: 'https://example.test/api/v1', apiKey: 'k', model: 'm', retryDelayMs: 0 }),
    ).rejects.toThrow('AI 偵測請求失敗：connect ECONNREFUSED');
  });
});
