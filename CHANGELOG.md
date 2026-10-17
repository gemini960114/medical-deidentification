# 變更紀錄

本檔記錄對使用者與開發者可見的變更，格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/)。版本以 git 標籤為準（最新 v1.3.0，`package.json` 的版本與之同步）；發布時將「未發布」改為版本號與日期。

## [未發布]

### 新增

- **醫療欄位偵測**：內建規則新增三類——「病歷號」（病歷號／門診號／掛號號／批價序號／Chart No.／Medical Record No.／MRN 等標籤後的 4–10 位編號）、「醫療日期」（入院／出院／手術／門診等就醫相關日期，保留年份）、「英文姓名」（Patient Name／Dr. 等標籤後的英文名，含敬稱）。內建類別由 15 種增至 **18 種**，保留策略：病歷號與英文姓名全部隱藏、醫療日期比照生日保留年份。
- **批次個資稽核工具（AI 語意偵測）**：`npm run scan-pii -- <檔案.txt|.md> [--fail-on-findings]` 先跑內建規則，再將文字送到 OpenAI 相容端點（如國網中心 Inkling-Small）做第二層語意偵測，抓規則引擎的盲點（無標籤英文姓名、語序顛倒的就醫日期、不在標籤清單內的院內編號），報告「證實／補抓／無法定位」三類結果，補抓項目標示行號。`--fail-on-findings` 讓任何補抓以結束碼 1 結束（供批次驗收或 CI 判定）；逐檔錯誤處理——單一檔案讀取或 AI 請求失敗不中斷批次，最後統計失敗清單。設定透過 `.env`（範本見 `.env.example`，不進版控）。**網頁應用程式本身不呼叫任何 API，維持純前端零外傳**；AI 引擎 `src/core/ai-detect.ts` 未被前端引用，不會打包進 dist/。
- **驗收端操作指南**：`docs/ai-audit-guide.md`，給非開發者的逐步教學（安裝、設定端點、執行、解讀報告、隱私紅線）。
- **產生語料自動驗收**：`tests/integration/generated-corpus.test.ts`——批次測試資料產生器（`npm run generate:test-docs`）以固定種子產生全合成出院病歷摘要，測試在暫存資料夾自產 8 份文件（2 病例 × TXT／Markdown／DOCX／PDF），走完整流程 `parseDocument → detect → 對照 answer-key 計分 → 去識別化 → 重新產生 → 再解析 → 還原`。計分分「值層命中」與「出現位置殘留」兩層（`scripts/batch-test-generator/score.ts`，與後續 CLI 報告共用）：`builtin` 答案須命中、`audit` 案例不算內建失敗、誤判須為零；docx／pdf 表格日期、無標籤英文姓名重複、PDF 換行拆值列為已知限制白名單——出現在報告但不計失敗，規則進步只會更綠。產生器重構為可匯入的 `generateCorpus()` 並加上 CLI 守衛，被 import 時不再有副作用。
- **靜態檢查**：oxlint ＋ tsgolint 型別感知規則（`no-floating-promises`／`no-misused-promises` 等），`npm run lint` 全專案零警告零錯誤（`--deny-warnings` 內建於 script），CI 於測試前執行。採用 oxlint 而非 ESLint＋typescript-eslint 的原因：TypeScript 7 原生編譯器（Go 版）不含傳統 JS 編譯器 API，typescript-eslint 尚不支援 TS 7；tsgolint 以 typescript-go 為後端，正是為 TS 7 而生。
- `examples/README.md`：範例檔下載與體驗說明（補上原本失效的連結目標）。
- 開發環境：`.nvmrc`（Node 22）。

### 修正

- 預覽的資源釋放：文件退出批次時釋放圖片 blob URL；每次重繪前釋放版面縮放的 ResizeObserver——PDF 預覽切換為純文字／Word／Excel 時，observer 不再連同整個已分離的 PDF DOM 一起殘留。
- AI 稽核：同一個值重複出現時，先前只檢查第一處——第一處被內建規則蓋住、後面殘留時，整筆會被誤判為「證實」而看不到殘漏。改為逐一檢查每個出現位置，補抓報告標示行號。
- AI 稽核：分塊之間加入重疊上下文（以整行為單位，長行硬切時退回字元後綴），跨在分塊邊界的姓名或標籤不再因上下文中斷而漏判；重疊造成的重複結果自動合併。
- AI 稽核：Node 20.0–20.11 沒有 `process.loadEnvFile`，會靜默略過 `.env` 並誤導為「未設定」——改為明確提示需要 Node ≥ 20.12，`engines` 與文件同步為 `>=20.12.0`。
- 官網 FAQ（含 JSON-LD 結構化資料）與 `public/llms.txt` 的偵測類別仍寫十五種、英文姓名不支援——同步為十八種與現況（標籤後的英文姓名已內建；`llms-full.txt` 由 README 產生，隨建置更新）。
- 設定寫入（localStorage）失敗時未妥善處理的錯誤路徑。
- 「個管師於…」被中文姓名規則誤判為姓名（個案管理師是醫療文件高頻詞），加入停用詞。
- 匯入編碼表的事件監聽器為 async 函式，讀檔失敗會成為未處理的 rejection——改為明確 `catch` 並跳出錯誤提示（lint 型別感知規則抓到）。
- 範例產生腳本（make-examples／make-og／make-screenshots）的型別錯誤；`tsconfig.json` 納入 `scripts/` 一併型別檢查。
- 整合測試在平行負載下的逾時餘裕不足：`marker-style-formats` 微調；`roundtrip-ocr` 的辨識準備（beforeAll）由 3 分鐘放寬到 10 分鐘——掃毒軟體活躍的機器上，Tesseract 初始化會大幅變慢。
- 依賴：補 `tesseract.js-core` 直接依賴、`npm audit` 修補。
- 移除未使用的 `maskDisplay` 死碼（含對應測試檔）。

### 變更

- 範例檔「02-人工調整」「04-偵測規則」配合新的病歷號自動偵測行為更新內容與產生腳本。
- `.gitignore` 新增 `.env` 與 `apikey.txt`（API 金鑰永不進版控）。
- CI（GitHub Actions）在測試前先跑 lint。
- `package.json` 版本由 0.1.0 對齊 git 標籤 v1.3.0（版本以標籤為單一來源）。

### 測試

- 測試數由 372 增至 **405**（33 個檔案）：新增醫療規則 42 案（標籤命中、無標籤不誤判、規則優先順序）、AI 語意偵測 19 案（分塊與重疊、回應剖析、逐出現位置分類、429 重試與 401 快速失敗，全以模擬端點測試，不依賴真實 API），以及 PDF 預覽切換到其他格式時釋放 ResizeObserver 的回歸測試。
