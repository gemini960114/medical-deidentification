# Data De-identification Tool Constitution

## Core Principles

### I. Mandatory Model & Server-Side Secrets（必要模型與後端金鑰）
依使用者於 2026-10-17 的明確決策，正式方案改為 Cloud Run 網站與同源後端。每份文件必須完成文字 LLM 辨識；PDF 視覺能力由使用者勾選。文字會傳至後端與指定模型，勾選時另傳頁面圖像，介面必須清楚揭露。金鑰只由後端環境變數／Secret Manager 讀取，不得進入瀏覽器、版本庫或容器映像。任一必要辨識失敗，不得假裝成功或退回只有規則。文件解析、遮蔽輸出、編碼表與還原仍在瀏覽器處理。

### II. Reversibility & Round-Trip Fidelity（可逆與無損還原）
預設輸出中，每一筆被去識別化的內容必須可透過編碼對照表精確還原。「去識別化 → 下載 → 上傳 + 編碼表 → 還原」的完整循環結果，其文字內容必須與原始文件一致。編碼在單次輸出內不得重複；還原不得依賴使用者無法保存的瀏覽器內部狀態——編碼表（CSV）是唯一還原憑證。
例外：使用者在介面上明確選擇「不需還原」的標記方式（例如只標類別、以符號佔位）時，可輸出不含編碼的文件；此時介面必須清楚標示無法還原，且不產生編碼表。預設值必須維持可還原。

### III. Human in the Loop（使用者最終決定權）
自動偵測結果一律視為「建議」。在輸出前，使用者必須能夠檢視每一筆偵測結果、取消任一筆誤判（false positive）、以及手動圈選新增遺漏項目（false negative）。系統不得在未經使用者確認預覽的情況下直接產出去識別化檔案。

### IV. Transparent & Editable Patterns（規則透明可管理）
所有用於偵測敏感資訊的 pattern 必須在介面上可檢視，包含名稱、類別與比對規則。使用者可啟用/停用個別 pattern。不得存在使用者看不到的隱藏偵測規則。

### V. Simplicity & Cloud Run Deployability（簡單優先）
優先採用最簡單可行的技術方案；避免不必要的框架與建置複雜度。任何新增依賴必須有明確理由。正式產物由 Cloud Run 同源提供前端及 Node 後端，遵循 PORT，金鑰在執行期注入，不再使用 GitHub Pages 部署。

## Security & Privacy Requirements

- 本服務不將文件、模型輸入、對照表寫入資料庫、日誌或持久磁碟；模型輸入會經過後端記憶體送至指定供應商，供應商的資料保管依其政策。localStorage 可存放 pattern 設定，以及使用者明確按「儲存」的服務存取碼（依使用者最新要求，可清除、同來源自動帶入）；不得存放文件、對照表或供應商 API Key。
- 編碼必須不可由編碼本身反推原始值（不得使用可逆編碼如 Base64 直接編碼原文）。
- 離開或重新整理頁面前，若有未下載的處理結果，應提醒使用者資料將遺失。

## Development Workflow

- 依循 spec-kit 流程：constitution → specify → plan → tasks → implement。
- 偵測 pattern（正規表達式等）必須有對應的測試案例，涵蓋命中與不應命中（誤判）兩類樣本。
- 去識別化/還原的 round-trip 必須有自動化測試驗證。

## Governance

本 constitution 優先於其他開發慣例。修改本文件須更新版本號並記錄修改原因。所有 plan 與 implementation 必須通過上述原則的合規檢查；任何與原則衝突的設計必須在 plan 的 Complexity Tracking 中說明理由或修正。

**Version**: 1.2.0 | **Ratified**: 2026-09-02 | **Last Amended**: 2026-10-17

- 1.2.0（2026-10-17）：使用者要求正式改為 Cloud Run、文字模型必要、視覺可勾選，取代純前端零外傳及靜態部署限制；維持瀏覽器輸出還原、人工覆核與金鑰不下放前端。

- 1.1.0（2026-10-16）：原則 II 加入「使用者明確選擇不需還原的標記方式」的例外。原因：使用者回報只需去識別化、不需還原的實際需求（specs/006-scan-polish-marker-style）。
