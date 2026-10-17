// Second-pass AI detection: asks an OpenAI-compatible chat endpoint for personal data the
// builtin rules cannot see — unlabelled English names, hospital numbers in word orders the
// label rules miss, semantic identifiers. Opt-in tooling for the acceptance-side audit CLI
// (scripts/scan-pii.ts) and an explicitly configured on-premises deployment; nothing in the
// web app calls it. Text sent here leaves the machine, so the endpoint must sit inside the
// operator's trust boundary (see README 醫療文件的去識別化).

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
  /** Index of the value in the text; null when the model returned text that is not in it. */
  start: number | null;
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
}

const SYSTEM_PROMPT = [
  '你是文件個資（PII）稽核助理。找出文本中所有能識別特定個人的資訊，包括：中英文姓名、身分證字號、病歷號與各種病籍編號、手機與市話、地址、電子郵件、公司或機關名稱、統一編號、生日、就醫相關日期（入院、出院、手術、門診等），以及其他具唯一性的編號（員工編號、客戶編號等）。',
  '只輸出 JSON 陣列，每項格式：{"category":"類別","value":"原文逐字字串","reason":"簡短理由"}。',
  'category 從下列選擇：姓名、英文姓名、身分證、手機、市話、地址、電子郵件、公司、統編、識別碼、病歷號、生日、醫療日期、其他。',
  'value 必須是原文中連續出現的完整字串，逐字複製、不可增刪字元或空白。找不到任何個資時輸出 []。',
].join('\n');

/** Chunks stay under this many characters so long documents fit the model's context. */
const CHUNK_CHARS = 1800;

/** Splits text into chunks of at most `limit` characters, never through a line when avoidable. */
export function chunkText(text: string, limit = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current);
    current = '';
  };
  for (const line of text.split('\n')) {
    // A single line longer than the limit is split by characters; the cut is arbitrary but rare.
    const parts: string[] = [];
    for (let i = 0; i < Array.from(line).length; i += limit) parts.push(Array.from(line).slice(i, i + limit).join(''));
    if (!parts.length) parts.push('');
    for (const part of parts) {
      if (current && current.length + part.length + 1 > limit) push();
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

/** Locates each value in the text (first occurrence not yet taken); null when hallucinated. */
export function locateFindings(text: string, findings: AiFinding[]): LocatedFinding[] {
  const cursor = new Map<string, number>();
  return findings.map((f) => {
    const at = text.indexOf(f.value, cursor.get(f.value) ?? 0);
    if (at < 0) return { ...f, start: null };
    cursor.set(f.value, at + f.value.length);
    return { ...f, start: at };
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
    for (const f of parseFindings(content)) {
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
  const doFetch = config.fetch ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: chunk },
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
      if (res.ok) return (((await res.json()) as ChatCompletion)?.choices?.[0]?.message?.content ?? '').trim();
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
