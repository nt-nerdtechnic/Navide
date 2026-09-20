# 使用指南

[English](../en-US/user-guide.md) | 繁體中文 | [日本語](../ja-JP/user-guide.md) | [文件中心](README.md)

## 產品模型

Navide 為一位工程師指揮多個 AI Agent 而設計。主要互動不一定是編輯檔案，而是設定成果、協調 Session、觀察進度、處理重要例外，並接受經過驗證的結果。

日常工作透過三種循環推進：

1. **Genesis** 使用 Pipeline，將想法轉化為第一個可運作 Prototype。
2. **Evolution** 透過一個或多個 Agent Session，反覆開發、測試、修正並微調現有專案。
3. **Intervention** 讓工程師透過 Diff、Editor、Terminal、Diagnostics、Git 與 Review Tool 檢查或直接修改成果。

目前 Pipeline 實作 Genesis 循環；Manual Pane 與 Maintenance Mode 提供早期 Evolution 工作流；Editor 與 Review 介面提供 Intervention。

## Runtime 心智模型

Navide 有三個工作層級：

1. **Workspace** 是專案資料夾，也是 Project State、Run History 與 Git Operation 的邊界。
2. **Pane** 是執行 Agent CLI 或一般 Shell 的 Live Terminal Session。
3. **Pipeline** 是一組依序執行的可設定 Stage。每個 Stage 包含一個或多個平行 slot，每個 slot 選擇 Agent 與 Role。

## Workspace

Welcome Screen 會列出 Recent Workspace、支援 Pin，並標示遺失的 Folder。開啟 Workspace 時會恢復其 UI State 與符合條件的 Session。切換或關閉 Workspace 前，請先完成或中止不能被中斷的 Active Work。

Navide 將個人私有 Project Intelligence 儲存在 Workspace 內的 `.agent-team/`。這個目錄排除於 Git，不應視為團隊共用狀態。它可能包含屬於個人工程流程的 Task Context、Session Metadata、Run History、Handoff 與 Token Information。

原始碼與明確分享的文件仍然是 Repository 裡團隊可見的事實。如果需要分享 `.agent-team/` 中的資訊，應將它轉換為刻意建立的 Artifact，例如 Specification、Architecture Decision、Test Report、Issue、Commit 或 Pull Request。

## Manual Agent Pane

探索、維護或不需要完整 Genesis Pipeline 的 Evolution Task，可以使用 Manual Spawn。

- 選擇 Agent 與 Role。
- Spawn 前檢查 Launch Command。
- 不需要 Agent 時使用一般 Terminal Pane。
- 將 Pane 最小化可以保留 PTY，同時避免占用主要 Layout。
- 只有 Navide 偵測到可重用 Session ID 後，才進行 Rebuild 或 Resume。

Select multiple pane headers with Cmd/Ctrl-click or Shift-click, then right-click a selected pane to open the batch menu. Its groups contain Interrupt/Rebuild, Minimize/Restore/Reclaim, notification controls, and Remove. **Restore selected** also opens selected panes that have not yet been opened or were reclaimed. Pane and project overflow menus stay within the window; long menus scroll so their final actions remain reachable.

**Reclaim selected (N)** shows how many selected panes are eligible, releases their CLI processes, and keeps click-to-resume placeholders. It skips protected panes, including running panes, the focused pane, panes awaiting an answer or holding unsent text, and panes without a resumable session. The action stays visible but is disabled when none of the selected panes can be reclaimed. **Mute selected notifications** mutes the entire selection, including a mix of muted and unmuted panes; when every selected pane is muted, **Unmute selected notifications** restores notifications for all of them. These batch actions affect only the selected panes.

受支援的內建 Agent Key 涵蓋 14 種 coding CLI：Aider、Antigravity CLI、Claude Code、Codex、Copilot CLI、Cursor CLI、Droid、Grok CLI、Kilo Code、Kimi Code、Muse Code、OpenCode、Pi、Qwen Code。實際 CLI 行為與 Provider Billing 仍由各外部工具控制。

對 Kimi Code Pane，Navide 會提供 100 ms 的 Escape Sequence 重組時間，讓方向鍵在內嵌 Terminal 中仍能可靠導覽；若環境已有 `PI_TUI_ESC_TIMEOUT`，則仍以既有值為準。

## Pipeline

內建 Pipeline 涵蓋 Requirements、Planning、Design、Implementation、Security Review 與 Testing。Stage、slot、Role、Kickoff Prompt、Question 與 Completion Sentinel 都能在 Settings 中設定。

一個 Stage 可以平行執行多個 slot。Navide 會根據設定的 Completion Signal 與 Agent State 推進。務必檢查生成變更與測試結果；自動完成只代表工作流進度，不代表成果正確。

## Manager 與 Worker 協調

其中一個 slot 可以擔任 Global Manager。Manager 會接收跨 Stage Context、將工作分派給 Worker、處理 Worker Question，並透過 Navide Routing Protocol 發出 Stage Completion Signal。

需要拆解或平行 Ownership 的任務適合使用 Manager。小型任務通常使用 Single-agent Stage，成本較低也較容易檢查。

## Automation Mode

- **YOLO** 會在受支援時傳入略過 Approval 或 Trust Prompt 的 CLI-specific Flag。某些 CLI 可能原本就不會要求 Tool Confirmation。
- **Full Auto** 允許 Analyzer 根據可用 Task Context 自動回答 Agent Question。
- **Strict** 在特定 Timeout 或 Progression Boundary 要求確認。
- **Continuous** 根據設定的 Automation Behavior 持續推進 Pipeline。
- **Local Analyzer** 啟用本機 Intent Classification 與相關 Automation。

請從保守設定開始。YOLO 與 Full Auto 可能讓 Agent 在沒有再次取得使用者確認的情況下修改檔案或執行 Command。

## 例外管理

Navide 的長期運作哲學，是讓 Agent 在可逆、可觀察的工作中持續執行，只有人類判斷真正有價值時才將注意力交還給工程師。目前 Automation Mode 是早期控制方式，不是完整 Policy Engine。

以下情況應該介入：

- 需求存在多種實質不同但都合理的解釋
- 架構或產品選擇具有長期影響
- Session 在 Ownership、File 或技術方向上衝突
- Test 與明確 Acceptance Criteria 不一致
- 涉及 Credential、Payment、Deployment、Publication、Destructive Operation 或 External System
- 成果需要主觀產品或品質判斷

例行探索、可逆修改、本機測試、診斷與修正，未來應該能在沒有 Approval Noise 的情況下繼續，同時保持可見與可中斷。

## History 與 Token Tracking

History 是 Pipeline、Stage、Pane、Question、Analyzer、Handoff 與 Warning Event 的 Append-only Timeline。Run History 儲存在 `.agent-team/runs/`，並可篩選或 Export。

Token Stats 解析相容的本機 CLI Log，將 Usage 歸屬到 Workspace、Pane、Stage 與 Run。它是 Observability Feature，不是 Provider Invoice；Provider 端 Usage 與 Billing 才是最終依據。

### Token Monitor

Open **Window → Token Monitor** for a separate window showing local Claude turn history over 14, 30, or 90 days. Reopening the command focuses the existing monitor. The existing **Turn Stats** modal remains available for inspecting one pane. Model filters, per-turn trends, and per-turn averages and medians summarize the selected local records.

Transcript records have **unknown account attribution**: a shared local Claude history cannot establish which signed-in account produced a turn. Other devices, web conversations, and subagent logs are outside this view. Missing history is not zero usage; partial scan coverage and errors are shown. Large histories are bounded, and refresh can reuse a scan for 60 seconds.

Quota history records successful observations for the active Claude account slot through the existing usage polling service. It starts accumulating when those observations are available; it cannot reconstruct earlier quota windows. Disabled polling and an empty history are displayed explicitly. Opening the monitor does not make extra provider requests. Observed tokens and quota percentages do not establish an official token allowance, throttling, effort level, or separate thinking-token usage.

## Git 與 Review

在 Marketplace 安裝功能完成前，Navide 會提供可移除的官方 Git Factory Package。其 Active Package Version 會同時提供嵌入式左側 View 與獨立 Git Window。在 Extensions 移除 Bundled Git 後，重新啟動也不會自動裝回；可在同一處按 **Restore** 恢復 Factory Copy。若存在已驗證的 Marketplace Version，會優先使用該版本。Git View 支援 Repository Discovery、Working Tree Inspection、Staging、Commit、Branch、Remote、Issue 與相關工作流；Multi-repository Workspace 可以在偵測到的 Repository 間切換。Discovery Scan 不會阻塞 Backend，並會在慢速 Filesystem 上經過受限的掃描時間後回傳部分結果。Repository Operation 仍經由 Navide Host／Backend 邊界處理；GitHub 與 GitLab Issue Detection 在可用時使用設定的 `gh` 或 `glab` CLI。若選定的 v2 Package 無法 Load、Mount 或回報 Ready，Navide 會明確標示並在該次 Process 使用保留的 Legacy Git Renderer；Security、Trust 或 Permission Denial 不會觸發 Fallback。

Commit 前務必審查變更，特別是在 Automation 或 Parallel Run 之後。Agent 生成的變更不會因為顯示在 Git Panel 中就自動變得安全。

## Editor 與 AI Terminal

Editor 使用 Monaco，並提供 File Editing、Diagnostics、Plan Rendering、Diff、Conflict 與 AI-assisted Workflow。右側 AI 面板內嵌真實的 Coding Agent CLI Terminal（與主視窗相同的 Agent），啟動時會自動注入 Editor 情境。

這些工具是更大工程環境的 Intervention 介面。Navide 的目標，是最終提供完整專業工作流，而不必使用傳統 IDE 作為主要環境。

## 透過 Navide MCP 管理 Skills

已獲授權的 Agent 可使用與 **設定 → Skills** 相同的共用庫：

1. 呼叫 `skills_list`，再把回傳的 ID 傳給 `skills_inspect`，讀取指示、檔案、所有權、來源紀錄與目前的 `delivery_revision`。
2. 呼叫 `skills_prepare_install`，來源可用 `owner/repo`、HTTPS `github.com/owner/repo` URL 或本機 skill 資料夾的絕對路徑（支援展開 `~`）。GitHub 的 `ref` 與 `subdir` 分開提供；`subdir: "."` 選擇 repository 根目錄。多個候選會回傳 `selection_required` 與 `candidates`，不產生可安裝的 preview ID；選好路徑後重新 prepare。不支援私人 repository、任意 URL 或 GitHub tree URL。
3. 檢視完整指示、檔案清單、腳本警示、來源與 digest，再以 preview ID、相同 digest 及明確 targets 呼叫 `skills_install`。首次寫入共用根另須由 `consent` 表達使用者許可；digest 或 Agent 自填的布林值不代表已獲授權。任何同名受管、使用者或原生 skill 都會拒絕。安裝獨占建立目的目錄，寫完附件與 metadata 後才發布 `SKILL.md`，讓掃描不會讀到半套內容；這不是整個目錄的原子 rename。
4. 之後用 skill ID 與最新 `delivery_revision` 呼叫 `skills_set_delivery`。過時 revision 會失敗，不覆蓋其他呼叫端的決定。此流程只新增 skill，不更新或重新取得既有安裝。

準備的 bytes 綁定已驗證的呼叫端，15 分鐘後或 backend 重啟時失效；安裝不重讀本機來源或再次下載。許可重試可沿用尚未到期的 preview；重試收據仍保留時，成功重送只回傳原結果，不重複寫入。同時最多 8 份有效準備，另有最多 8 份不含套件內容的輕量完成收據。安裝成功即釋放套件 bytes 與有效準備名額。收據沿用原 preview 到期時間；快取滿時，最早安裝成功的收據優先淘汰。到期或淘汰後重送回傳 missing/expired，不重新安裝。GitHub archive 限壓縮 10 MiB、展開 32 MiB、4,096 個 entries；選定 skill 限 64 檔、每檔 256 KiB、總量 512 KiB。不安全路徑、連結、特殊檔、保留 metadata 與無效 manifest 直接拒絕，不靜默略過。

共用 skill 的 `targets: null` 代表所有 wired vendor，`targets: []` 停止 Navide 額外投遞。原生 skill 的 targets 指定其他 CLI，空陣列或 `null` 清除額外路由。自行掃描共用根的 CLI 仍可能讀到 skill，不受 Navide targets 或啟用開關全面限制；這些設定不是隔離界線。

`materialized_in_current_session: null` 與 `loaded_in_current_session: null` 表示目前 session 的實際投遞與載入尚未驗證；相容欄位 `delivered_to_me` 也只表示設定。改投遞後開新 CLI session 並在其中確認，安裝或路由回覆不能證明執行中的 CLI 已載入新內容。

本機來源收據記錄來源、準備時 digest 與時間，編輯、切換及重啟後仍可由 inspect 取得。digest 代表安裝快照，不代表之後的本機編輯。管理 marker 與來源收據不進入既有 export／Skills sync，不保證跨裝置保存來源。開啟 Skills sync 時，符合限制的內容與投遞決定仍可透過既有流程同步；符合套件限制不等於同步已完成。

Skills 畫面在 backend 成功變更與重新連線後刷新，保留未儲存內容及原 revision，讓過時儲存繼續產生衝突。其他程式直接改檔案仍需手動刷新。準備與安裝不執行夾帶腳本或 plugin hooks；日後使用 skill 仍受 CLI 工具與授權規則控制。

## Settings 與可攜性

**設定 → 語言** 是側欄中位於「外觀」之後的獨立頁面。可選擇繁體中文或 English；這項使用者層級偏好套用到所有工作區。

Settings 涵蓋 Role、Pipeline、MCP Server、Analyzer Behavior、AI Provider、Appearance、Keyboard Shortcut，以及獨立的 **Execution Policy** 分頁。該分頁會顯示唯讀的 Host 預設值，讓你建立或編輯一個全域的 `full`、`allowlist` 或 `denylist` 使用者政策，並將第一層系統命名空間與最上層 Shell 可執行檔名稱分開管理。完整模式需要明確的高風險確認。開啟工作區後，也會顯示不受信任的 Repository 建議，讓你明確選擇 Host 預設值、使用者政策或接受後的 Repository 政策。全域政策損壞時，可透過獨立確認的重建保留工作區來源選擇；政策資料夾不安全或無法使用時，則必須手動修復。Extensions 會將 Plugin 的 Manifest Permissions、精確 package-version Grant，以及目前選定 Agent 的 Execution Policy 分開顯示。

**設定 → CLI Agents** 以每個 Agent 一張卡片呈現。使用搜尋及「全部」、「已啟用」或「需注意」篩選找到 Agent，切換啟用狀態。要調整順序，請選擇「全部」並清空搜尋，再拖曳卡片或使用上下移動按鈕；篩選或搜尋期間無法重新排序。至少必須保留一個已啟用的 Agent。選擇「管理」會開啟該 Agent 的側邊抽屜，提供總覽、啟動設定、權限、推送及安裝分頁。設定沿用自動儲存方式，不需要另外按下儲存。關閉抽屜或按 Escape 會先返回卡片，不會直接關閉整個設定視窗。

安裝分頁管理已安裝的 Coding CLI：版本、安裝方式、重複安裝、該 CLI 上次自我更新的結果，以及在終端機執行該 CLI 官方更新與診斷指令的按鈕。開啟工作區時可設定恢復單一 CLI、第一個 Grid 頁面或目前分頁；即使上次不是 Grid layout，Grid 頁面仍會依 Grid preset 計算。Navide 只呈現並執行官方指令，不會自行更新 CLI。Exported Setting 會遮蔽 API Key 與 Token。啟用第三方 Server 前，請先檢查 MCP Command 與 Environment Variable。

**帳號**分頁為每個 CLI 帳號放一張卡片。除了 CLI 自己的登入，卡片還能保存一份**可攜憑證**：各家官方為「在任何機器上使用」而設計的值（例如 Claude Code 的 `claude setup-token`）。貼入一次，該 CLI 的新 pane 會在環境變數裡拿到它，CLI 自己的登入檔不會被動到。每個 CLI 同時只有一份憑證在*使用中*；卡片會標示是哪一份，並在本機登入檔會蓋過它時提出警告。移除憑證只影響這台裝置。

**同步**區段（設定 → 同步）可以把這些憑證帶到你的其他裝置。**憑證**開關預設關閉。開啟後，帳號卡片會為每份憑證多一行雲端狀態——已同步、只在這台、雲端有但這台未使用、或待你決定——而在別台機器貼入的憑證可以一鍵在這台啟用。在這台移除永遠不會刪掉雲端或其他裝置上的那一份。同一區段會顯示同步金鑰的 id，並在你懷疑外洩時提供更換：所有記錄重新加密，已配對的裝置會收到新金鑰。

`.agent-team/` 目前不是可攜機制。未來在不同裝置間移轉時，應使用具有 Redaction 與 Retention Control 的明確本機 Export／Import，而不是透過 Git 同步。
