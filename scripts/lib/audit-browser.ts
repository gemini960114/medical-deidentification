import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import { createServer } from 'vite';

export function chromePath(): string {
  const candidates = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const path = candidates.find((p) => p && existsSync(p));
  if (!path) throw new Error('找不到 Chrome／Chromium，請設定 CHROME_PATH');
  return path;
}

/** Local assets only; credentials never enter the browser. Always close in finally. */
export async function auditBrowser(apiTarget?: string) {
  const server = await createServer({
    server: { host: '127.0.0.1', port: 0, ...(apiTarget ? { proxy: { '/api': { target: apiTarget, changeOrigin: false } } } : {}) }, logLevel: 'error',
    plugins: [{
      name: 'audit-pdf-assets',
      configureServer(vite) {
        // These self-contained ESM bundles need no dependency rewriting or optimizer restarts.
        const assets: Record<string, string> = {
          '/__audit/pdf.mjs': 'node_modules/pdfjs-dist/build/pdf.mjs',
          '/__audit/pdf.worker.mjs': 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
        };
        vite.middlewares.use((request, response, next) => {
          const path = assets[(request.url ?? '').split('?')[0]];
          if (!path) { next(); return; }
          response.setHeader('Content-Type', 'text/javascript');
          response.end(readFileSync(path));
        });
      },
    }],
  });
  await server.listen();
  let browser: Browser | undefined;
  try {
    const args = ['--disable-background-networking'];
    if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
    browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args });
    const launched = browser;
    const origin = server.resolvedUrls!.local[0];
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith(origin) || /^(data:|blob:|about:)/.test(url)) void request.continue();
      else void request.abort();
    });
    await page.goto(origin);
    return { browser, page, origin, close: async () => { await launched.close(); await server.close(); } };
  } catch (error) {
    await browser?.close();
    await server.close();
    throw error;
  }
}

/** Convenient absolute path for browser uploads. */
export const projectFile = (...parts: string[]) => join(process.cwd(), ...parts);
