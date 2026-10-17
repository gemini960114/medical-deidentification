import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiDetect, chunkText, classifyFindings, locateFindings, parseFindings } from '../../src/core/ai-detect';
import type { RedactionItem } from '../../src/core/types';

const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

/** A builtin match stub: classifyFindings only reads start/end. */
const builtinItem = (start: number, end: number) => ({ start, end }) as RedactionItem;

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
    const chunks = chunkText(text, 30, 0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(30);
      for (const line of c.split('\n')) expect(lines).toContain(line); // 每行都完整
    }
    expect(chunks.join('\n')).toBe(text);
  });

  it('hard-splits a single line longer than the limit without breaking surrogate pairs', () => {
    const long = '𝓍'.repeat(25) + '字'.repeat(25); // 50 code points
    const chunks = chunkText(long, 30, 0);
    expect(chunks).toEqual(['𝓍'.repeat(25) + '字'.repeat(5), '字'.repeat(20)]);
  });

  it('repeats the end of the previous chunk as context while staying within the limit', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `第${i}行：一些內容`);
    const chunks = chunkText(lines.join('\n'), 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(30);
      for (const line of c.split('\n')) expect(lines).toContain(line); // 重疊也以整行為單位
    }
    // 每個後續段落以「前一段的最後幾行」開頭：跨邊界的值與標籤不會失去上下文
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i - 1].split('\n')).toContain(chunks[i].split('\n')[0]);
    }
    // 原文的每一行都還在某個段落裡——重疊沒有吃掉任何內容
    for (const line of lines) expect(chunks.some((c) => c.split('\n').includes(line))).toBe(true);
  });

  it('gives hard-split pieces a character-suffix overlap without breaking surrogate pairs', () => {
    const long = '𝓍'.repeat(25) + '字'.repeat(25); // 50 code points
    const chunks = chunkText(long, 30);
    expect(chunks).toHaveLength(2);
    // 第二段以前段尾端 9 個字元（4 個 𝓍＋5 個字）開頭，緊接其後是剩下的 20 個字
    expect(chunks[1]).toBe('𝓍'.repeat(4) + '字'.repeat(5) + '\n' + '字'.repeat(20));
    // 長度以 code point 計（𝓍 是星芒字元，佔兩個 UTF-16 單元）
    for (const c of chunks) expect(Array.from(c).length).toBeLessThanOrEqual(30);
  });
});

describe('locateFindings', () => {
  it('locates every occurrence of a repeated value', () => {
    const text = '王小明就診，王小明回診';
    const located = locateFindings(text, [{ category: '姓名', value: '王小明', reason: '' }]);
    expect(located).toEqual([{ category: '姓名', value: '王小明', reason: '', starts: [0, 6] }]);
  });

  it('gives values not in the text an empty starts list', () => {
    const located = locateFindings('原文', [{ category: '姓名', value: '不存在的字串', reason: '' }]);
    expect(located).toEqual([{ category: '姓名', value: '不存在的字串', reason: '', starts: [] }]);
  });
});

describe('classifyFindings', () => {
  it('flags a value as missed when only its first occurrence is covered by the builtin rules', () => {
    const text = 'Patient: John Wang 主治；後文再提 John Wang 追蹤。';
    const first = text.indexOf('John Wang');
    const second = text.indexOf('John Wang', first + 1);
    expect(second).toBeGreaterThan(first);
    const classified = classifyFindings(text, [{ category: '英文姓名', value: 'John Wang', reason: '醫師' }], [
      builtinItem(first, first + 'John Wang'.length),
    ]);
    expect(classified[0].status).toBe('missed');
    expect(classified[0].uncovered).toEqual([second]);
  });

  it('confirms a value only when every occurrence is covered', () => {
    const text = '王小明就診，王小明回診';
    const first = text.indexOf('王小明');
    const second = text.indexOf('王小明', first + 3);
    const classified = classifyFindings(text, [{ category: '姓名', value: '王小明', reason: '' }], [
      builtinItem(first, first + 3),
      builtinItem(second, second + 3),
    ]);
    expect(classified[0].status).toBe('confirmed');
    expect(classified[0].uncovered).toEqual([]);
  });

  it('marks values the text does not contain as unlocatable', () => {
    const classified = classifyFindings('原文', [{ category: '姓名', value: '幻覺', reason: '' }], []);
    expect(classified[0].status).toBe('unlocatable');
    expect(classified[0].starts).toEqual([]);
    expect(classified[0].uncovered).toEqual([]);
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

  it('merges the same value reported by different chunks into one finding', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return reply('[{"category":"英文姓名","value":"John Wang","reason":"醫師"}]');
      }),
    );
    const lines = Array.from({ length: 120 }, (_, i) => `第${i}行：一些內容一些內容一些內容`);
    const findings = await aiDetect(lines.join('\n'), {
      baseUrl: 'https://example.test/api/v1',
      apiKey: 'k',
      model: 'm',
      retryDelayMs: 0,
    });
    expect(calls).toBeGreaterThan(1);
    expect(findings).toEqual([{ category: '英文姓名', value: 'John Wang', reason: '醫師' }]);
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
      aiDetect('文本', { baseUrl: 'https://example.test/api/v1', apiKey: 'k', model: 'm', retryDelayMs: 0 }),
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
