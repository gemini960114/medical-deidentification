# 變更紀錄

本檔記錄對使用者與開發者可見的變更，格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/)。版本號依 `package.json`（尚未發布標籤版本，先以「未發布」彙總）。

## [未發布]

### 新增

- **醫療欄位偵測**：內建規則新增三類——「病歷號」（病歷號／門診號／掛號號／批價序號／Chart No.／Medical Record No.／MRN 等標籤後的 4–10 位編號）、「醫療日期」（入院／出院／手術／門診等就醫相關日期，保留年份）、「英文姓名」（Patient Name／Dr. 等標籤後的英文名，含敬稱）。內建類別由 15 種增至 **18 種**，部分保留策略：病歷號與英文姓名全部隱藏、醫療日期比照生日保留年份。
- **批次個資稽核工具（AI 語意偵測）**：`npm run scan-pii -- <檔案.txt|.md>` 先跑內建規則，再將文字送到 OpenAI 相容端點（如國網中心 Inkling-Small）做第二層語意偵測，抓規則引擎的盲點（無標籤英文姓名、語序顛倒的就醫日期、不在標籤清單內的院內編號），報告「證實／補抓／無法定位」三類結果。設定透過 `.env`（範本見 `.env.example`，不進版控）。**網頁應用程式本身不呼叫任何 API，維持純前端零外傳**；AI 引擎 `src/core/ai-detect.ts` 未被前端引用，不會打包進 dist/。
- **驗收端操作指南**：`docs/ai-audit-guide.md`，給非開發者的逐步教學（安裝、設定端點、執行、解讀報告、隱私紅線）。
- **靜態檢查**：oxlint ＋ tsgolint 型別感知規則（`no-floating-promises`／`no-misused-promises` 等），`npm run lint --deny-warnings` 全專案零警告零錯誤，CI 於測試前執行。採用 oxlint 而非 ESLint＋typescript-eslint 的原因：TypeScript 7 原生編譯器（Go 版）不含傳統 JS 編譯器 API，typescript-eslint 尚不支援 TS 7；tsgolint 以 typescript-go 為後端，正是為 TS 7 而生。
- `examples/README.md`：範例檔下載與體驗說明（補上原本失效的連結目標）。
- 開發環境：`.nvmrc`（Node 22）。

### 修正

- 預覽切換文件時 blob URL 與 ResizeObserver 未釋放造成的記憶體洩漏。
- 設定寫入（localStorage）失敗時未妥善處理的錯誤路徑。
- 「個管師於…」被中文姓名規則誤判為姓名（個案管理師是醫療文件高頻詞），加入停用詞。
- 匯入編碼表的事件監聽器為 async 函式，讀檔失敗會成為未處理的 rejection——改為明確 `catch` 並跳出錯誤提示（lint 型別感知規則抓到）。
- 範例產生腳本（make-examples／make-og／make-screenshots）的型別錯誤；`tsconfig.json` 納入 `scripts/` 一併型別檢查。
- 整合測試 `marker-style-formats` 在平行 OCR 測試負載下的逾時餘裕不足。
- 依賴：補 `tesseract.js-core` 直接依賴、`package.json` 加入 `engines` 欄位、`npm audit` 修補。
- 移除未使用的 `maskDisplay` 死碼（含對應測試檔）。

### 變更

- 範例檔「02-人工調整」「04-偵測規則」配合新的病歷號自動偵測行為更新內容與產生腳本。
- `.gitignore` 新增 `.env` 與 `apikey.txt`（API 金鑰永不進版控）。
- CI（GitHub Actions）在測試前先跑 lint。

### 測試

- 測試數由 372 增至 **398**（33 個檔案）：新增醫療規則 42 案（標籤命中、無標籤不誤判、規則優先順序）、AI 語意偵測 13 案（分塊、回應剖析、結果定位、429 重試與 401 快速失敗，全以模擬端點測試，不依賴真實 API）。
