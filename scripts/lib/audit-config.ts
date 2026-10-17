import { existsSync } from 'node:fs';
import type { AiDetectConfig } from '../../src/core/ai-detect.ts';

export function loadAuditConfig(): AiDetectConfig | null {
  if (existsSync('.env')) {
    if (!process.loadEnvFile) throw new Error('載入 .env 需要 Node ≥ 20.12');
    process.loadEnvFile();
  }
  const baseUrl = process.env.OPENAI_API_BASE;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, model: process.env.OPENAI_MODEL ?? 'Inkling-Small' };
}
