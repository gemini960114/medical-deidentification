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
--layout <版面>     basic（預設）或 realistic（多頁、巢狀表格）
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

`npm run generate:test-docs -- --count 2 --format all --layout realistic` 會加入兩個明確分頁的追蹤紀錄與巢狀聯絡表。Word 包含真正的巢狀 `<w:tbl>`；PDF 以框線繪出內外表格並驗證至少三頁。新增聯絡欄位的重複次數一起寫入 answer-key，不放寬原本的偵測白名單。`npm run test:e2e` 會在本機瀏覽器操作五種格式的上傳、偵測、下載與還原，比對實際下載內容，並檢查瀏覽器只呼叫同源 API、不直連外部模型端點；需要 Chrome／Chromium，可用 `CHROME_PATH` 指定。CI 同樣執行此測試，無須模型金鑰。

`answer-key.json` 的每一筆 finding 包含：

- `category`：預期類別；
- `value`：植入文件的原始值；
- `occurrences`：該值在文件本文出現的次數；
- `expectation`：
  - `builtin`：應由目前內建規則偵測；
  - `audit`：刻意設計成需要人工圈選或 AI 第二層稽核的盲點，例如無標籤英文姓名、日期在「入院」之前、院內檢查序號。

同一位病患姓名會在有標籤與無標籤段落重複出現，可用來驗證重複值是否全部被定位。

## 自動驗收測試

`tests/integration/generated-corpus.test.ts` 會在暫存資料夾自產語料（2 個病例 × 4 種格式、固定種子 17，不依賴也不更動 `output/`），逐一 `parseDocument → detect` 對照 `answer-key.json` 計分，再走「去識別化 → 重新產生文件 → 再解析 → 還原」完整輸出鏈。計分邏輯在 `score.ts`（設計上與後續 CLI 報告共用），採四個獨立失敗通道：

- **完整涵蓋**：`builtin` 答案的出現位置必須被偵測 span 的「聯集」完全包住（txt／md 要求 100% 命中）；只碰到前綴或後綴不算命中——例如表格欄位中的病歷號只被抓到數字段、「MRN-」前綴外露，會列為「部分遮蔽」殘留；
- **逐出現位置類別**：完整涵蓋的位置，其偵測類別必須等於答案類別——同一值第二處被標錯類別，不會因為值層命中而通過；
- **出現次數**：實際定位到的次數必須等於 `answer-key.json` 的記錄值——次數檢查獨立於漏抓，漏抓白名單不能吸收次數退步（值完全不存在另歸類為「值不存在」，無白名單）；
- **過度遮蔽**：偵測 span 超出所有答案值的部分，只容許標點、空白與「值之前」的明確欄位標籤——標籤是封閉清單（拉丁：Patient／Name／Dr／MRN 等；中文：轉介院所／姓名／診斷等），任意英文單字（pneumonia）不算標籤，出現在值**之後**的標籤（「王小明 Dr.」）也被拒絕；「王小明；診斷：肺炎」這種把病名一起遮掉的 span 會失敗。誤判（span 不與任何答案值重疊）同樣須為零。

已知限制定義在 `score.ts` 的 `KNOWN_LIMITATIONS`，每條帶「每份文件上界」與「形狀限制」（`shape`／`allowedExposed`）：docx／pdf 表格欄位中的醫療日期（標籤列與值列分離，同一行規則刻意不抓，每份 ≤3 筆，只容許**純漏抓**——不得有任何項目觸及）、無標籤的英文姓名重複（刻意留給 AI 稽核／人工圈選，每份 ≤1 處，殘留必須**完全未被觸及**——規則若開始部分匹配會被拒絕）、病歷號在 docx／pdf 表格的部分遮蔽（每份 ≤1 處，**只容許「MRN-」前綴外露**——外露內容必須完全等於 `"MRN-"`，完全未遮蔽或外露後綴「000003」都會失敗）。白名單內會出現在報告但不計失敗；形狀不符、超過上界（例如醫師姓名也開始漏抓）或白名單外都會讓測試變紅，而規則進步只會讓漏抓與殘留變少。

語料本身有兩個配合計分的設計：機構名放在不換行的「轉介院所」表格欄位——PDF 段落換行會把機構名拆到兩行造成萃取漏值，表格欄位是控制案例（段落不再重複機構名，四種格式的出現次數一致）；診所名刻意不含「的與和及」等連接詞字元，以符合公司規則的反誤抓設計（見 `src/core/patterns.ts` 的 `COMPANY_NOT_FIRST`）。計分語意的反例（部分遮蔽、聯集缺口、逐位置類別、過度遮蔽邊界、次數、白名單形狀）另有 21 個單元測試：`tests/unit/score.test.ts`。

單獨執行：

```powershell
npx vitest run tests/integration/generated-corpus.test.ts
```


