import type { LoadedDocument } from './types';
import type { ModelPage, ModelRequest, ModelResponse, ModelSettings } from './model-contract';

export async function getModelSettings(): Promise<ModelSettings> {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('模型服務尚未就緒，請確認後端已啟動');
  const settings = await response.json() as ModelSettings;
  if (!settings.textRequired || !Array.isArray(settings.models) || !settings.models.length) throw new Error('後端沒有提供必要的文字模型');
  if (!Array.isArray(settings.visionModels)) throw new Error('後端沒有提供視覺模型設定');
  return settings;
}

export async function pdfModelPages(file: File, maxPages: number): Promise<ModelPage[]> {
  // The app parser owns the local worker URL; import it before starting another PDF.js task.
  await import('../formats/pdf');
  const pdfjs = await import('pdfjs-dist');
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > maxPages) throw new Error(`視覺辨識最多 ${maxPages} 頁，請拆分文件或取消視覺選項`);
    const pages: ModelPage[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 2200 / Math.max(natural.width, natural.height)) });
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
      pages.push({ page: p, dataUrl: canvas.toDataURL('image/jpeg', 0.92) });
      canvas.width = canvas.height = 0; page.cleanup();
    }
    return pages;
  } finally { await task.destroy(); }
}

export async function requestModelAudit(doc: LoadedDocument, model: string, vision: boolean, token: string, file: File, maxPages: number): Promise<ModelResponse> {
  const pages = vision && doc.format === 'pdf' ? await pdfModelPages(file, maxPages) : [];
  const input: ModelRequest = { text: doc.text, model, vision, pages };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600_000);
  try {
    const response = await fetch('/api/detect', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(input), signal: controller.signal });
    const result = await response.json() as ModelResponse & { error?: string };
    if (!response.ok) throw new Error(result.error ?? '模型辨識失敗');
    if (result.textCompleted !== true || !Array.isArray(result.findings) || (pages.length && !result.visionCompleted)) throw new Error('模型辨識未完整完成，不能使用此次結果');
    return result;
  } finally { clearTimeout(timeout); }
}
