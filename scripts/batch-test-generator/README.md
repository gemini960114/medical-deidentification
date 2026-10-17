# 醫療文件批次測試資料產生器

產生高擬真的**全合成**中文出院病歷摘要，不使用或下載任何真實病患個資。

## 快速使用

在專案根目錄執行：

```powershell
npm run generate:test-docs -- --count 100
```

預設會在 `scripts/batch-test-generator/output/seed-20261017-count-100-mixed/` 產生：

- 100 份文件，平均分配為 TXT、Markdown、DOCX、PDF；
- `病患總表.xlsx`：同一批 100 筆資料的 Excel 版本；
- `answer-key.json`：每份文件植入的個資、類別、預期出現次數及是否屬於內建規則或人工／AI 稽核案例；
- `README.txt`：該次產生參數與使用說明。

## 參數

```text
--count <數量>       病例數，預設 100，範圍 1–10000
--seed <整數>        固定亂數種子，預設 20261017
--format <格式>      mixed（預設）、all、txt、md、docx、pdf
--output <資料夾>    輸出根目錄，預設 scripts/batch-test-generator/output
```

範例：

```powershell
# 100 份混合格式
npm run generate:test-docs -- --count 100

# 20 個病例，每個病例同時輸出四種格式（共 80 份文件）
npm run generate:test-docs -- --count 20 --format all

# 500 份純文字文件，換一組可重現的資料
npm run generate:test-docs -- --count 500 --format txt --seed 42
```

`mixed` 的 `count` 是文件總數；`all` 的 `count` 是病例數，每個病例各產生 TXT、Markdown、DOCX、PDF。

## 標準答案

`answer-key.json` 的每一筆 finding 包含：

- `category`：預期類別；
- `value`：植入文件的原始值；
- `occurrences`：該值在文件本文出現的次數；
- `expectation`：
  - `builtin`：應由目前內建規則偵測；
  - `audit`：刻意設計成需要人工圈選或 AI 第二層稽核的盲點，例如無標籤英文姓名、日期在「入院」之前、院內檢查序號。

同一位病患姓名會在有標籤與無標籤段落重複出現，可用來驗證重複值是否全部被定位。

## 自動驗收測試

`tests/integration/generated-corpus.test.ts` 會在暫存資料夾自產語料（2 個病例 × 4 種格式、固定種子 17，不依賴也不更動 `output/`），逐一 `parseDocument → detect` 對照 `answer-key.json` 計分，再走「去識別化 → 重新產生文件 → 再解析 → 還原」完整輸出鏈。計分邏輯在 `score.ts`（設計上與後續 CLI 報告共用）：

- **值層命中**：`builtin` 答案至少一個出現位置被涵蓋且類別正確（txt／md 要求 100%）；
- **位置層殘留**：命中後仍未涵蓋的出現位置——刻意留給 AI 稽核／人工圈選的對象；
- **誤判**：偵測 span 不與任何答案值重疊，須為零。

已知限制定義在 `score.ts` 的 `KNOWN_LIMITATIONS`（出現在報告、不計為失敗）：docx／pdf 表格欄位中的醫療日期（標籤列與值列分離，同一行規則刻意不抓）、無標籤的英文姓名重複、PDF 換行拆開的機構名（萃取保真）。規則進步只會讓漏抓與殘留變少，不會讓測試變紅。

單獨執行：

```powershell
npx vitest run tests/integration/generated-corpus.test.ts
```


