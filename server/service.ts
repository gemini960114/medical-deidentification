import type { AiDetectConfig } from '../src/core/ai-detect.ts';
import { aiDetect } from '../src/core/ai-detect.ts';
import type { ModelRequest, ModelResponse } from '../src/core/model-contract.ts';
import { auditImage } from '../scripts/lib/vision-audit.ts';

export function validateRequest(value: unknown, models: string[], maxPages = 20): ModelRequest {
  if (!value || typeof value !== 'object') throw new Error('請提供文字辨識內容');
  const v = value as Record<string, unknown>;
  if (typeof v.text !== 'string' || !v.text.trim() || v.text.length > 100_000) throw new Error('文字不可為空，且每份最多十萬字元');
  if (typeof v.model !== 'string' || !models.includes(v.model)) throw new Error('模型不在服務允許清單');
  if (typeof v.vision !== 'boolean') throw new Error('請明確指定視覺辨識選項');
  if (v.textRequired === false || v.textEnabled === false) throw new Error('文字 LLM 為必要流程，不能停用');
  const pages = v.pages ?? [];
  if (!Array.isArray(pages) || pages.length > maxPages) throw new Error(`視覺辨識最多 ${maxPages} 頁`);
  if (!v.vision && pages.length) throw new Error('未勾選視覺辨識，不可傳送頁面圖片');
  const seen = new Set<number>();
  for (const page of pages) {
    if (!page || !Number.isSafeInteger(page.page) || page.page < 1 || seen.has(page.page) ||
      typeof page.dataUrl !== 'string' || page.dataUrl.length > 4_000_000 ||
      !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(page.dataUrl)) throw new Error('頁面圖片格式或頁碼無效');
    seen.add(page.page);
  }
  return { text: v.text, model: v.model, vision: v.vision, pages };
}

/** Text is unconditional. A failure in either requested stage fails the entire request. */
export async function runModelAudit(request: ModelRequest, config: AiDetectConfig): Promise<ModelResponse> {
  const selected = { ...config, model: request.model };
  const findings: ModelResponse['findings'] = (await aiDetect(request.text, selected)).map((f) => ({ ...f, source: 'text' }));
  if (request.vision) {
    for (const page of request.pages ?? []) findings.push(...await auditImage({ ...page, text: '' }, selected));
  }
  return { model: request.model, textCompleted: true, visionCompleted: request.vision && Boolean(request.pages?.length), findings };
}
