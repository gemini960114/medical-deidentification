import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { ModelRequest, ModelResponse, ModelSettings } from '../src/core/model-contract.ts';
import { validateRequest } from './service.ts';

export interface ServerOptions {
  models: string[]; defaultModel: string; visionModels?: string[]; accessToken?: string; root?: string;
  maxPages?: number; hourlyLimit?: number;
  publicBaseUrl?: string;
  audit: (request: ModelRequest) => Promise<ModelResponse>;
}
export function createAuditServer(options: ServerOptions) {
  const root = resolve(options.root ?? 'dist');
  const settings: ModelSettings = { models: options.models, defaultModel: options.defaultModel, visionModels: options.visionModels ?? [],
    textRequired: true, accessRequired: Boolean(options.accessToken), maxPages: options.maxPages ?? 20 };
  let active = 0;
  let windowAt = Date.now();
  let used = 0;
  return createServer((request, response) => { void (async () => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz' && request.method === 'GET') { send(200, { ok: true }); return; }
      if (url.pathname === '/api/config' && request.method === 'GET') { send(200, settings); return; }
      if (url.pathname === '/api/detect') {
        if (request.method !== 'POST') { send(405, { error: '請使用 POST' }); return; }
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) { send(403, { error: '不接受跨來源請求' }); return; }
        if (options.accessToken) {
          const supplied = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
          const expected = Buffer.from(options.accessToken);
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { send(401, { error: '服務存取碼不正確' }); return; }
        }
        if (!request.headers['content-type']?.startsWith('application/json')) { send(415, { error: '需要 JSON 請求' }); return; }
        if (Date.now() - windowAt >= 3_600_000) { windowAt = Date.now(); used = 0; }
        if (active >= 2 || used >= (options.hourlyLimit ?? 60)) { send(429, { error: '模型服務忙碌或已達本時段用量，請稍後重試' }); return; }
        // Reserve before reading the body as well as during inference; do not queue unbounded uploads.
        active++;
        try {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of request) {
            const bytes = Buffer.from(chunk); size += bytes.length;
            if (size > 24 * 1024 * 1024) { send(413, { error: '請求超過 24 MB，請減少頁數' }); return; }
            chunks.push(bytes);
          }
          let input: ModelRequest;
          try { input = validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')), options.models, settings.maxPages); }
          catch (error) { send(400, { error: error instanceof Error ? error.message : '請求格式錯誤' }); return; }
          if (input.vision && !settings.visionModels.includes(input.model)) { send(400, { error: '此模型尚未通過視覺驗證，請改選支援視覺的模型' }); return; }
          used++;
          try { send(200, await options.audit(input)); }
          catch { send(502, { error: '模型辨識未完成，請重試或改選其他模型；本次不能視為已完成辨識' }); }
        } finally { active--; }
        return;
      }
      if (url.pathname.startsWith('/api/')) { send(404, { error: '找不到服務' }); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { send(405, { error: '不支援此操作' }); return; }
      const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(root + sep) || /(^|[/\\])\./.test(path.slice(root.length))) { send(404, { error: '找不到檔案' }); return; }
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
      try {
        let bytes = await readFile(path);
        if (extname(path) === '.html' || extname(path) === '.xml' || extname(path) === '.txt') {
          const host = request.headers.host ?? 'localhost';
          if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) { send(400, { error: 'Host 無效' }); return; }
          const scheme = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
          const base = options.publicBaseUrl ?? `${scheme}://${host}`;
          bytes = Buffer.from(bytes.toString('utf8').replaceAll('__PUBLIC_BASE_URL__', base));
        }
        response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=3600' });
        response.end(request.method === 'HEAD' ? undefined : bytes);
      } catch { send(404, { error: '找不到檔案' }); }
    } catch { if (!response.headersSent) send(400, { error: '無法處理請求' }); else response.end(); }
  })(); });
}
