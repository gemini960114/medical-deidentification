import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { auditBrowser } from './audit-browser.ts';
import type { AuditPage } from './vision-audit.ts';

/** Extract original JPEG XObjects, including nested Forms. These are NOT a full-page rendering. */
export async function extractEmbeddedJpegs(bytes: Uint8Array): Promise<{ page: number; dataUrl: string }[]> {
  const pdf = await PDFDocument.load(bytes);
  const result: { page: number; dataUrl: string }[] = [];
  for (const [index, page] of pdf.getPages().entries()) {
    const visited = new Set<PDFRawStream>();
    const visit = (resources: PDFDict | undefined) => {
      const objects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!objects) return;
      for (const ref of objects.values()) {
        const stream = pdf.context.lookup(ref);
        if (!(stream instanceof PDFRawStream) || visited.has(stream)) continue;
        visited.add(stream);
        const subtype = stream.dict.get(PDFName.of('Subtype'));
        if (subtype === PDFName.of('Image') && stream.dict.get(PDFName.of('Filter')) === PDFName.of('DCTDecode')) {
          result.push({ page: index + 1, dataUrl: `data:image/jpeg;base64,${Buffer.from(stream.contents).toString('base64')}` });
        } else if (subtype === PDFName.of('Form')) visit(stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict));
      }
    };
    visit(page.node.Resources());
  }
  return result;
}

/** Render the actual page appearance, including rotation, masks, vectors, text and every image. */
export async function renderAuditPdf(bytes: Uint8Array, maxPages = 100, existing?: Awaited<ReturnType<typeof auditBrowser>>): Promise<AuditPage[]> {
  const session = existing ?? await auditBrowser();
  const timer = setTimeout(() => { void session.browser.close(); }, 120_000);
  try {
    // Dynamic browser module import goes through Vite; this code never becomes an app import.
    return await session.page.evaluate(async (base64, limit) => {
      const moduleUrl = '/__audit/pdf.mjs';
      const pdfjs = await import(/* @vite-ignore */ moduleUrl) as typeof import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = '/__audit/pdf.worker.mjs';
      const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const task = pdfjs.getDocument({ data, isEvalSupported: false });
      try {
        const pdf = await task.promise;
        if (pdf.numPages > limit) throw new Error(`PDF 共 ${pdf.numPages} 頁，超過視覺稽核上限 ${limit}；未送出任何頁面`);
        const pages = [];
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const natural = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2, 2200 / Math.max(natural.width, natural.height)) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
          const content = await page.getTextContent();
          const text = content.items.map((it) => 'str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '').join('');
          pages.push({ page: p, text, dataUrl: canvas.toDataURL('image/jpeg', 0.92) });
          canvas.width = canvas.height = 0;
          page.cleanup();
        }
        return pages;
      } finally { await task.destroy(); }
    }, Buffer.from(bytes).toString('base64'), maxPages);
  } finally {
    clearTimeout(timer);
    if (!existing) await session.close();
  }
}
