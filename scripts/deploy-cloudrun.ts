// Deploy only this application. Provider credentials travel to Secret Manager over stdin, never argv.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadAuditConfig } from './lib/audit-config.ts';

const project = 'gen-lang-client-0039151647';
const region = 'asia-east1';
const service = 'medical-deidentification';
const account = `medical-deid-run@${project}.iam.gserviceaccount.com`;
const sdk = join(process.env.LOCALAPPDATA ?? '', 'Google/Cloud SDK/google-cloud-sdk');
const windowsPython = join(sdk, 'platform/bundledpython/python.exe');
const executable = process.platform === 'win32' ? windowsPython : 'gcloud';
const prefix = process.platform === 'win32' ? [join(sdk, 'lib/gcloud.py')] : [];
if (process.platform === 'win32' && !existsSync(executable)) throw new Error('找不到 Google Cloud SDK 的 bundled Python，請安裝 gcloud');

async function cloud(args: string[], input?: string, allowFailure = false, stream = false): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn(executable, [...prefix, ...args, '--project', project, '--quiet'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: 'true', CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true' } });
    let out = ''; let errors = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); if (stream) process.stdout.write(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); if (stream) process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? done(out.trim()) : allowFailure ? done('') : reject(new Error(`gcloud ${args.slice(0, 3).join(' ')} 失敗：${errors.trim()}`)));
    child.stdin.end(input);
  });
}

async function secret(name: string, value: string): Promise<string> {
  if (!await cloud(['secrets', 'describe', name, '--format=value(name)'], undefined, true)) {
    await cloud(['secrets', 'create', name, '--replication-policy=user-managed', '--locations', region]);
  }
  const version = await cloud(['secrets', 'versions', 'add', name, '--data-file=-', '--format=value(name)'], value);
  await cloud(['secrets', 'add-iam-policy-binding', name, `--member=serviceAccount:${account}`, '--role=roles/secretmanager.secretAccessor']);
  return `${name}:${version.split('/').at(-1)}`;
}

const config = loadAuditConfig();
if (!config) throw new Error('本機 .env 尚未提供模型端點與金鑰');
let accessToken = process.env.AUDIT_ACCESS_TOKEN;
if (!accessToken) {
  accessToken = randomBytes(32).toString('hex');
  appendFileSync('.env', `\nAUDIT_ACCESS_TOKEN=${accessToken}\n`);
  console.log('已產生服務存取碼並保存至本機 .env（不在輸出顯示）。');
}
mkdirSync('.deploy', { recursive: true });
console.log(`部署目標：${project} / ${region} / ${service}；不更動 transitx 或其他服務。`);
await cloud(['services', 'enable', 'run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'secretmanager.googleapis.com', 'iam.googleapis.com']);
if (!await cloud(['iam', 'service-accounts', 'describe', account, '--format=value(email)'], undefined, true)) {
  await cloud(['iam', 'service-accounts', 'create', 'medical-deid-run', '--display-name=Medical De-identification Runtime']);
}
console.log('設定此服務專用 Secret Manager 資源與最小讀取權限…');
const providerSecret = await secret(`${service}-model-key`, config.apiKey);
const accessSecret = await secret(`${service}-access-code`, accessToken);
writeFileSync('.deploy/environment.json', JSON.stringify({ OPENAI_API_BASE: config.baseUrl, OPENAI_MODEL: config.model,
  OPENAI_VISION_MODELS: process.env.OPENAI_VISION_MODELS ?? '',
  OPENAI_MODEL_Available: process.env.OPENAI_MODEL_Available ?? config.model, AUDIT_HOURLY_LIMIT: process.env.AUDIT_HOURLY_LIMIT ?? '60' }, null, 2));
console.log('開始 Cloud Build 與 Cloud Run 部署…');
await cloud(['run', 'deploy', service, '--source', '.', '--region', region, '--service-account', account,
  '--port=8080', '--memory=512Mi', '--cpu=1', '--min-instances=0', '--max-instances=1', '--concurrency=2', '--timeout=900',
  '--allow-unauthenticated', `--set-secrets=OPENAI_API_KEY=${providerSecret},AUDIT_ACCESS_TOKEN=${accessSecret}`,
  '--env-vars-file', resolve('.deploy/environment.json')], undefined, false, true);
const url = await cloud(['run', 'services', 'describe', service, '--region', region, '--format=value(status.url)']);
if (!/^https:\/\/[a-z0-9.-]+\.run\.app$/.test(url)) throw new Error('服務 URL 格式無法確認');
const health = await fetch(url + '/healthz');
if (!health.ok) throw new Error('Cloud Run 健康檢查失敗');
const settingsResponse = await fetch(url + '/api/config');
const settings = await settingsResponse.json() as { textRequired?: boolean; accessRequired?: boolean; models?: string[] };
if (!settingsResponse.ok || !settings.textRequired || !settings.accessRequired) throw new Error('部署後的必要模型或存取限制檢查失敗');
const syntheticInput = { text: 'SYNTHETIC TEST ONLY\nEmail: cloud-smoke@example.invalid', model: config.model, vision: false, pages: [] };
const blocked = await fetch(url + '/api/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(syntheticInput) });
if (blocked.status !== 401) throw new Error('公開端點缺少存取保護');
console.log('執行雲端合成文字辨識驗收…');
const live = await fetch(url + '/api/detect', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(syntheticInput), signal: AbortSignal.timeout(150_000) });
const result = await live.json() as { textCompleted?: boolean; findings?: { value: string }[] };
if (!live.ok || !result.textCompleted || !result.findings?.some((f) => f.value === 'cloud-smoke@example.invalid')) throw new Error('雲端模型合成驗收未通過');
writeFileSync('.deploy/deployment.json', JSON.stringify({ project, region, service, url, verifiedAt: new Date().toISOString(), textRequired: true, accessProtected: true, models: settings.models }, null, 2) + '\n');
console.log(`PASS：${url}；健康、存取限制與真實文字模型皆通過。服務存取碼請從本機 .env 的 AUDIT_ACCESS_TOKEN 取用。`);
