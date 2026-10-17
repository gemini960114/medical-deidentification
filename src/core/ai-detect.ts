// Server-side semantic detection shared by the mandatory web backend and acceptance CLI.
// This module must never be imported into the browser bundle. Text sent to the configured
// endpoint leaves the browser/server boundary; operators must choose an authorized endpoint.

import type { RedactionItem } from './types';

export interface AiDetectConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Wait between the two attempts of a retryable failure (429, 5xx, network). */
  retryDelayMs?: number;
  /** Called after each chunk completes. */
  onProgress?: (done: number, total: number) => void;
}

export interface AiFinding {
  category: string;
  value: string;
  reason: string;
}

export interface LocatedFinding extends AiFinding {
  /** Every index where the value occurs in the text; empty when the model returned text not in it. */
  starts: number[];
}

export type FindingStatus = 'confirmed' | 'missed' | 'unlocatable';

export interface ClassifiedFinding extends LocatedFinding {
  status: FindingStatus;
  /** Occurrences no builtin match covers; non-empty exactly when the finding is residual ('missed'). */
  uncovered: number[];
}

interface ChatCompletion {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
}

const SYSTEM_PROMPT = [
  '你是文件個資（PII）稽核助理。找出文本中所有能識別特定個人的資訊，包括：中英文姓名、身分證字號、病歷號與各種病籍編號、手機與市話、地址、電子郵件、公司或機關名稱、統一編號、生日、就醫相關日期（入院、出院、手術、門診等），以及其他具唯一性的編號（員工編號、客戶編號等）。',
  '只輸出 JSON 陣列，每項格式：{"category":"類別","value":"原文逐字字串","reason":"簡短理由"}。',
  'category 從下列選擇：姓名、英文姓名、身分證、手機、市話、地址、電子郵件、公司、統編、識別碼、病歷號、生日、醫療日期、其他。',
  'value 必須是原文中連續出現的完整字串，逐字複製、不可增刪字元或空白。找不到任何個資時輸出 []。',
].join('\n');

/** Chunks stay under this many characters so long documents fit the model's context. */
const CHUNK_CHARS = 1800;

/**
 * Context repeated at the head of the next chunk so a value — or the label introducing it — that
 * straddles a chunk boundary is still seen whole by the model. Duplicates this creates in the
 * model's answers are merged by aiDetect, so overlap costs a few tokens and nothing else.
 */
const OVERLAP_CHARS = 200;

/** The tail of `prev` that fits in `budget`: whole lines when possible, else a character suffix. */
function overlapTail(prev: string, budget: number): string {
  if (budget <= 0 || !prev) return '';
  const lines = prev.split('\n');
  const tail: string[] = [];
  let len = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const extra = lines[i].length + (tail.length ? 1 : 0);
    if (len + extra > budget) break;
    tail.unshift(lines[i]);
    len += extra;
  }
  if (tail.length) return tail.join('\n');
  // The last line alone exceeds the budget (a hard-split piece): fall back to a character suffix.
  const chars = Array.from(lines[lines.length - 1]);
  return chars.slice(Math.max(0, chars.length - budget)).join('');
}

/** Splits text into chunks of at most `limit` characters, never through a line when avoidable. */
export function chunkText(text: string, limit = CHUNK_CHARS, overlap = OVERLAP_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current);
    current = '';
  };
  for (const line of text.split('\n')) {
    // A single line longer than the limit is split by characters; the cut is arbitrary but rare.
    const parts: string[] = [];
    const lineChars = Array.from(line);
    for (let i = 0; i < lineChars.length; i += limit) parts.push(lineChars.slice(i, i + limit).join(''));
    if (!parts.length) parts.push('');
    for (const part of parts) {
      if (current && current.length + part.length + 1 > limit) {
        push();
        // Repeat the end of the previous chunk for context, shrunk so the limit still holds.
        current = overlapTail(chunks[chunks.length - 1] ?? '', Math.min(overlap, limit - part.length - 1));
      }
      current = current ? `${current}\n${part}` : part;
    }
  }
  push();
  return chunks;
}

/** Parses the model's reply: a strict JSON array, or the array inside prose or ``` fences. */
export function parseFindings(content: string): AiFinding[] {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : content).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const findings: AiFinding[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const { category, value, reason } = item as Record<string, unknown>;
    if (typeof category !== 'string' || !category || typeof value !== 'string' || !value) continue;
    findings.push({ category, value, reason: typeof reason === 'string' ? reason : '' });
  }
  return findings;
}

/** Acceptance gates must distinguish explicit [] from refusals, invalid JSON and malformed rows. */
export function parseFindingsStrict(content: string): AiFinding[] {
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let rows: unknown;
  try { rows = JSON.parse(body); } catch { throw new Error('AI 稽核回應不是 JSON 陣列'); }
  if (!Array.isArray(rows) || rows.some((row: unknown) => {
    if (!row || typeof row !== 'object') return true;
    const { category, value } = row as Record<string, unknown>;
    return typeof category !== 'string' || !category.trim() || typeof value !== 'string' || !value.trim();
  })) throw new Error('AI 稽核回應缺少有效 category／value');
  return parseFindings(body);
}

/** Locates every occurrence of each value; empty `starts` mean the model returned text not in it. */
export function locateFindings(text: string, findings: AiFinding[]): LocatedFinding[] {
  return findings.map((f) => {
    const starts: number[] = [];
    let at = text.indexOf(f.value);
    while (at >= 0) {
      starts.push(at);
      at = text.indexOf(f.value, at + f.value.length);
    }
    return { ...f, starts };
  });
}

/**
 * Verifies findings occurrence by occurrence: a value the builtin rules already covered at its
 * first spot may still be residual later in the document, so every occurrence is checked before
 * the finding counts as confirmed. `uncovered` lists the offsets no builtin match covers.
 */
export function classifyFindings(text: string, findings: AiFinding[], builtin: RedactionItem[]): ClassifiedFinding[] {
  return locateFindings(text, findings).map((f) => {
    const uncovered = f.starts.filter((start) => {
      let cursor = start;
      for (const it of builtin.filter((it) => it.active !== false).sort((a, b) => a.start - b.start)) {
        if (it.start > cursor) break;
        if (it.end > cursor) cursor = it.end;
        if (cursor >= start + f.value.length) return false;
      }
      return true;
    });
    const status: FindingStatus = !f.starts.length ? 'unlocatable' : uncovered.length ? 'missed' : 'confirmed';
    return { ...f, uncovered, status };
  });
}

/**
 * Sends the text to the endpoint chunk by chunk and merges the findings (same category＋value
 * counted once). Retryable failures (429, 5xx, network, timeout) get one second attempt;
 * anything else (bad key, unknown model) fails immediately with the endpoint's status.
 */
export async function aiDetect(text: string, config: AiDetectConfig): Promise<AiFinding[]> {
  const chunks = chunkText(text);
  const findings: AiFinding[] = [];
  const seen = new Set<string>();
  for (const [i, chunk] of chunks.entries()) {
    const content = await complete(chunk, config);
    for (const f of parseFindingsStrict(content)) {
      const key = `${f.category}\u0000${f.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push(f);
      }
    }
    config.onProgress?.(i + 1, chunks.length);
  }
  return findings;
}

async function complete(chunk: string, config: AiDetectConfig): Promise<string> {
  return completeAi(chunk, config);
}

export type AiUserContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];

/** Shared transport for acceptance-side text and visual audits; never imported by the web app. */
export async function completeAi(content: AiUserContent, config: AiDetectConfig, systemPrompt = SYSTEM_PROMPT): Promise<string> {
  const doFetch = config.fetch ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content },
  ];
  const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let lastError = '未知錯誤';
  let fatal = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 120_000);
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, temperature: 0, messages }),
        signal: controller.signal,
      });
      if (res.ok) {
        const choice = ((await res.json()) as ChatCompletion)?.choices?.[0];
        const reply = choice?.message?.content;
        if (choice?.finish_reason === 'length' || typeof reply !== 'string' || !reply.trim()) {
          fatal = true;
          throw new Error('端點回應不完整或沒有文字內容，不能視為無個資');
        }
        return reply.trim();
      }
      const status = `${res.status} ${res.statusText}`.trim();
      if (res.status !== 429 && res.status < 500) {
        fatal = true;
        throw new Error(`端點回應 ${status}（請檢查 API Key、Base URL 或模型名稱）`);
      }
      lastError = `端點回應 ${status}`;
    } catch (e) {
      if (fatal || attempt === 2) throw new Error(`AI 偵測請求失敗：${messageOf(e)}`);
      lastError = messageOf(e);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, config.retryDelayMs ?? 1000));
  }
  throw new Error(`AI 偵測請求失敗：${lastError}`);
}
