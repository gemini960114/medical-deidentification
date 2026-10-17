# Cloud Run 部署與維護

應用為網站＋同源 Node 後端，文字模型為必要流程，PDF 視覺辨識可選。一般使用與資料限制見 [README](../README.md)。本機修改、存取碼與規則不會自動同步至正式服務。

## 目前環境

- 專案：`gen-lang-client-0039151647`
- 區域：`asia-east1`（台灣）
- 服務：`medical-deidentification`
- 網址：<https://medical-deidentification-57229660377.asia-east1.run.app>
- 執行帳號：`medical-deid-run@gen-lang-client-0039151647.iam.gserviceaccount.com`
- 此服務與 `transitx` 分開，更新時不要覆蓋其他服務。

## 已驗證的部署方式

沿用 TransitX 成功紀錄：標準 `gcloud run deploy --source .`，由專案 Dockerfile 在雲端建置。Windows 使用 SDK 的 `gcloud.cmd`；不要另行直接啟動 SDK 內的 Python 入口，本機曾在該路徑遇到等待程序結束的問題。

`scripts/deploy-cloudrun.ts` 是先前的自動化草稿，尚未依標準啟動方式重新驗證，也仍使用 `/healthz` 判斷部署；**目前不要把 `npm run deploy:cloudrun` 當作已驗收的部署入口**。正式服務是以下標準方式部署與驗收。

### 1. 準備服務與金鑰

安裝並登入 gcloud，確認有目標專案、Cloud Build、Artifact Registry、Cloud Run、Secret Manager 與服務帳號相關權限。建置使用 Dockerfile，不需把 `.env` 上傳。

由管理者在 Secret Manager 建立／更新：

| Secret | 注入名稱 | 用途 |
|---|---|---|
| `medical-deidentification-model-key` | `OPENAI_API_KEY` | 模型供應商金鑰 |
| `medical-deidentification-access-code` | `AUDIT_ACCESS_TOKEN` | 使用者服務存取碼 |

執行帳號只需要這兩個 Secret 的 `roles/secretmanager.secretAccessor` 權限。不要把金鑰寫入 Dockerfile、前端、指令文字或版本庫；也不要使用 `VITE_` 作為金鑰變數前綴。

### 2. 準備非機密環境變數

建立已忽略的 `.deploy/environment.json`，依實際供應商與模型填入，**其中不放 API Key 或服務存取碼**：

```json
{
  "OPENAI_API_BASE": "https://your-model-service.example/v1",
  "OPENAI_MODEL": "your-text-model",
  "OPENAI_MODEL_Available": "your-text-model,your-tested-vision-model",
  "OPENAI_VISION_MODELS": "your-tested-vision-model",
  "AUDIT_HOURLY_LIMIT": "60"
}
```

模型必須是該供應商實際允許的名稱，視覺允許清單也須包含在可用模型清單中。可選用 `PUBLIC_BASE_URL` 指定公開網址；未設定時由後端依請求產生網站中繼資料網址。

### 3. 執行標準部署

以下 PowerShell 範例以目前資源名稱為準。請先確認 Secret 版本；範例的 `:1` 必須改成要發布的實際版本。使用固定版本可讓每次發布的設定可追溯。

```powershell
$deployGcloud = Join-Path $env:LOCALAPPDATA 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
& $deployGcloud run deploy medical-deidentification `
  --source . `
  --project gen-lang-client-0039151647 `
  --region asia-east1 `
  --service-account medical-deid-run@gen-lang-client-0039151647.iam.gserviceaccount.com `
  --port 8080 --memory 512Mi --cpu 1 `
  --min-instances 0 --max-instances 1 --concurrency 2 --timeout 900 `
  --allow-unauthenticated `
  --set-secrets 'OPENAI_API_KEY=medical-deidentification-model-key:1,AUDIT_ACCESS_TOKEN=medical-deidentification-access-code:1' `
  --env-vars-file .deploy/environment.json
```

`--allow-unauthenticated` 讓網頁可以開啟；模型 API 仍需通過應用層的服務存取碼。Cloud Run 缺少 `AUDIT_ACCESS_TOKEN` 時，應用會拒絕啟動。變更 Secret 後，需更新服務引用的版本並確認新版本就緒；改本機 `.env` 不會改雲端存取碼。

`.gcloudignore` 與 `.dockerignore` 排除 `.env`、金鑰檔、`.deploy`、版本庫與測試輸出。容器使用非 root 使用者並遵循 `PORT`。

### 4. 上線確認

1. 等待 gcloud 回報版本就緒、接收流量，不只看容器建置成功。
2. 開啟首頁，確認介面可載入。
3. `GET /api/config` 應回應可用模型、`textRequired: true` 與 `accessRequired: true`，不得出現供應商金鑰。
4. 不提供存取碼的 `POST /api/detect` 應回應 401。
5. 使用正確存取碼與全合成文字，確認實際模型辨識完成。

本次環境曾出現 `/healthz` 回應 404、但首頁與實際 API 正常的情況，不應以這條路徑作唯一成功判準。上線驗收應包含實際使用的首頁與 API。不要用真實病患資料測試部署。

## 用量與資料保存

每個實例同時最多兩個辨識請求，單一暖機實例每小時預設最多 60 份。計數會因實例生命週期重設；最多一個實例也不能當作持久化計費硬上限。

後端只接受允許模型與本機編碼的頁圖，不接受任意端點或遠端圖片 URL。文件文字與頁圖只在處理期間經過本服務記憶體，不主動保存至資料庫或內容日誌；供應商端的資料處理依其政策。服務存取碼只提供基本存取控制，沒有個人帳號或逐使用者配額。使用者可按「儲存」將服務代碼保存在同來源的 localStorage，重新整理或新開辨識分頁時帶入；可按「清除」移除。這不包含供應商 API Key，也不會同步不同裝置或本機／雲端環境。

GitHub workflow 只做 CI、模擬模型 E2E 與保存建置產物，不自動部署 Cloud Run，也不發布 Pages。

官方參考：[Secret Manager 整合](https://docs.cloud.google.com/run/docs/configuring/services/secrets)、[環境變數](https://docs.cloud.google.com/run/docs/configuring/services/environment-variables)。
