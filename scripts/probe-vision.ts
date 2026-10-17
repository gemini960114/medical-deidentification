// Sends only a generated image containing a random code, never document data or credentials in logs.
import { randomInt } from 'node:crypto';
import { loadAuditConfig } from './lib/audit-config.ts';
import { auditBrowser } from './lib/audit-browser.ts';
import { completeAi } from '../src/core/ai-detect.ts';

try {
  const config = loadAuditConfig();
  if (!config) throw new Error('請設定 OPENAI_API_BASE／OPENAI_API_KEY／OPENAI_MODEL');
  const session = await auditBrowser();
  try {
    const token = String(randomInt(100_000, 1_000_000));
    const dataUrl = await session.page.evaluate((code) => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 180;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 640, 180);
      ctx.fillStyle = 'black'; ctx.font = 'bold 90px Arial'; ctx.fillText(code, 90, 120);
      return canvas.toDataURL('image/png');
    }, token);
    const reply = await completeAi([
      { type: 'text', text: 'Read the six digits in this image. Return only those six digits.' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ], { ...config, timeoutMs: 45_000 }, 'Read images accurately. Return only the requested digits.');
    if (reply.trim() !== token) throw new Error('端點接受請求，但未正確讀出圖中隨機碼；視覺能力尚未確認');
    console.log(`PASS：${config.model} 接受 image_url 且正確辨識圖中隨機碼。`);
  } finally { await session.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : '視覺探測失敗'); process.exitCode = 1;
}
