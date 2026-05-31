# Agent-Team SDD

Status: Draft for discussion  
Date: 2026-05-26  
Scope: UI-based terminal management system for a complete development team-agent

## 1. Confirmed Direction

目前已確認的產品方向：

- 要做一個「有介面的 Terminal 管理系統」。
- 目標不是單純包一個 terminal，而是要支援「完整的開發 team-agent」。
- 系統應該讓使用者可以透過 UI 管理 terminal、開發任務、agent 執行與團隊式協作流程。
- 產品型態以 Desktop app 為方向。
- 可以參考既有 `SSH-Manager` 專案的做法，但新系統重點是同一個介面中同時顯示多個 terminal。
- 使用者需要能看到開發過程，而不是只看到最後結果。
- 核心介面應是 terminal grid first，而不是一般 dashboard-first。
- 開發 agent 不從零實作，第一版要能控制既有開發 CLI agent：`Claude Code`、`Codex`、`Gemini CLI`。
- 本機目前可找到三個 CLI executable：`claude`、`codex`、`gemini`。
- 系統需要能自動把 Claude Code、Codex、Gemini CLI 的輸出轉送給彼此，形成可控的 agent collaboration loop。
- 預設執行模式希望盡量全自動一次做到完成。
- 使用者可以在任務中途介入對話，也可以使用 Stop Orchestration 或 Kill Task 控制任務。
- Git 管控必須強制帶入開發流程，包含檢查、備份、分支、diff 追蹤與交付前驗證。
- 系統可以協助建立 commit，但任務完成後先提供 commit message 建議與變更摘要，不自動 commit；使用者確認後才 commit。
- 技術方向定案為 Electron + embedded web terminal + Python local backend。
- Desktop shell 定案為 Electron。
- Local backend 定案為 Python service with PTY control。
- Storage 定案為 SQLite。
- 第一版只支援 macOS。
- 第一版只支援本機 shell，不做 SSH/remote/container。
- CLI agent 可以直接修改本機 repo 檔案，但必須先通過 Git preflight。
- 第一版 terminal layout 採固定 2x2 grid。
- 自動轉送採固定格式 handoff prompt 加摘要，不直接轉送完整 terminal 原文。
- Git checkpoint 第一版採 patch file + metadata；dirty tree 時可選擇性使用 stash。
- Route message 送出前必須做 secret scan/redaction。

本文件只記錄目前已確認的方向，以及下一步需要討論的設計問題。未經確認的內容不視為正式需求。

## 2. Reference Project Findings

參考專案：

`/Users/example/Projects/reference-apps/ssh-manager`

目前讀到的可參考方向：

- `main.py` 使用 `tkinter` 建立 Desktop GUI。
- `TerminalWindow` 使用 `paramiko` 建立互動式 SSH shell，並將 terminal 嵌入 tkinter 視窗。
- 使用 `pyte` 處理 VT100/terminal screen，支援 terminal resize 與 ANSI 畫面更新。
- 透過背景 `threading.Thread` 處理連線、讀取 output、送出 commands，避免 UI 卡住。
- `ssh_client.py` 將 SSH 操作、外部 Terminal.app 開啟、遠端指令執行與 ANSI 清理拆出。
- `models.py` 使用 JSON 檔案保存設定，並在儲存前自動備份。
- `pack_as_app.sh` 用腳本建立 macOS `.app` bundle，包含 PATH/locale 設定與錯誤 log。

可借鑑但需要調整的地方：

- `SSH-Manager` 以單一 `TerminalWindow` 為主，新系統需要一個主控台畫面同時容納多個 terminal pane。
- `SSH-Manager` 偏向 SSH server/app 管理，新系統應以開發 workflow 與 agent team process 為核心。
- 參考專案會開外部 Terminal.app，新系統的核心需求是直接在介面上看多個 terminal 的開發過程，因此內嵌 terminal 應是主要模式。
- 參考專案的資料存放以 JSON 為主，新系統若要保留任務、agent run、terminal history，可能需要更明確的 storage schema。
- 參考專案的 terminal 是 SSH 導向；新系統第一優先應支援本機 shell 中啟動與控制開發 CLI agent。

## 3. Problem Space

開發 team-agent 需要處理的核心問題可能包含：

- 多個 terminal session 同時運行時，缺少統一的管理介面。
- agent 在 terminal 中執行任務時，使用者不容易追蹤目前狀態、輸出、錯誤與下一步。
- Claude Code、Codex、Gemini CLI 各自有 terminal-based 互動流程，缺少一個統一介面同時啟動、排列、監看與操作。
- 多個 CLI agent 之間目前需要使用者手動複製/貼上上下文，無法穩定形成自動協作流程。
- 開發任務通常跨越多個步驟，例如讀檔、改檔、跑測試、啟動 server、檢查結果，需要流程化管理。
- 全自動開發若沒有 Git 邊界，容易覆蓋既有修改、混入 unrelated changes、或無法回復到任務開始前狀態。
- 一個完整開發團隊可能需要不同角色的 agent，例如 planner、developer、reviewer、tester，但各角色如何協作尚需定義。
- 傳統 terminal 一次只能聚焦單一工作，新系統需要讓多個 agent/terminal 的狀態可並排觀察。

以上是待確認的問題假設，不是最終需求。

## 4. Product Goal Draft

建立一個具有圖形介面的 terminal 控制中心，讓使用者可以：

- 建立、查看、切換與管理 terminal sessions。
- 在同一個主畫面同時看到多個 terminal 的即時輸出。
- 在 terminal pane 中啟動、控制與觀察 Claude Code、Codex、Gemini CLI。
- 將開發任務分派到不同 CLI agent 或不同 terminal pane。
- 自動擷取某個 CLI agent 的關鍵輸出，依照路由規則轉送給其他 CLI agent。
- 在全自動模式下，讓 Claude Code、Codex、Gemini CLI 依規則連續協作直到完成、阻塞或被使用者停止。
- 觀察 agent 在 terminal 中的執行狀態與輸出。
- 在不中斷整個介面的情況下，中途向任一 CLI agent 插入訊息或指令。
- 對整個任務執行 Stop Orchestration 或 Kill Task。
- 任務開始前強制檢查 Git 狀態、建立任務分支與備份點。
- 任務執行中持續追蹤 diff、檔案變更與測試狀態。
- 任務完成前輸出 Git 變更摘要與交付建議。
- 管理一個開發任務從規劃、實作、測試到交付的流程。
- 保留必要的執行紀錄，方便追蹤與回復。

## 5. Target User Draft

待確認。

可能使用者：

- 個人開發者：想用多個 agent 協助開發。
- 技術主管或產品負責人：想把需求拆給不同 agent 處理。
- 小型開發團隊：想用 agent 協助規劃、寫 code、review、測試。
- AI agent 工具開發者：想建立可觀察、可控制的 terminal orchestration tool。

需要確認哪一類是第一版 MVP 的主要使用者。

## 6. Core Product Concepts

### 6.1 Workspace

一個工作區，對應到一個專案目錄或一組開發任務。

待確認：

- Workspace 是否等同於本機資料夾。
- 是否需要同時管理多個 repo。
- 是否需要記錄 workspace 的環境設定。

### 6.2 Terminal Session

由系統建立或接管的一個 shell/terminal 執行環境。

可能能力：

- 建立 terminal。
- 命名 terminal。
- 查看 stdout/stderr。
- 傳送指令。
- 暫停、停止或關閉 session。
- 標記 terminal 正在執行哪個 task 或 agent。

待確認：

- 是否需要真正互動式 pseudo-terminal。
- 是否允許使用者直接輸入指令。
- 是否需要保留完整 terminal output history。

### 6.3 Terminal Pane

主介面中的一個 terminal 顯示區塊。每個 pane 綁定一個 terminal session，並顯示該 session 的即時輸出。

已確認方向：

- 第一版需要支援多個 pane 同時顯示。
- pane 不應只是 tab 切換；使用者要能在同一個畫面看到多個 terminal 的進度。

待確認：

- 後續版本是否支援自由分割、拖曳排序、多 workspace layout。

第一版固定 2x2 layout：

- Pane 1: Claude Code
- Pane 2: Codex
- Pane 3: Gemini CLI
- Pane 4: Control / Route Messages / Git Status / Logs

Control pane priority:

1. Global controls: Stop Orchestration, Kill Task, Pause/Resume
2. Prompt composer / inject message
3. Route messages and current round
4. Git status, branch, changed files
5. Test/diff summary
6. History/log search

每個 terminal pane 必須顯示：

- CLI agent name
- task name
- current status
- current command or last detected activity
- branch name
- changed-file count
- Stop Orchestration / Kill Task controls remain globally visible outside pane focus

### 6.4 CLI Agent

由外部 terminal CLI 提供的開發 agent。第一版目標是控制既有 CLI，而不是重做 agent runtime。

已確認第一版要支援的 CLI agent：

- `Claude Code`
- `Codex`
- `Gemini CLI`

可能能力：

- 為指定 workspace 開啟某個 CLI agent。
- 在 terminal pane 中顯示該 CLI agent 的完整互動過程。
- 將使用者任務或 prompt 傳送到指定 CLI agent。
- 標記每個 CLI agent 的狀態，例如 idle、running、waiting input、completed、error。
- 讓使用者同時觀察多個 CLI agent 的輸出。
- 接收其他 CLI agent 轉送過來的摘要、問題、review request 或驗證任務。

第一版 default settings：

- 三個 CLI agent 預設共用同一 workspace。
- executable path、workspace path、default args、profile/model/config 可在 settings 中覆寫。
- 第一版若沒有指定 profile/model/config，使用各 CLI agent 自身預設值。
- 系統需要自動解析 CLI output，至少要能判斷可轉送的穩定訊息區塊。

第一版 adapter default：

- `claude`: launch command defaults to `claude`
- `codex`: launch command defaults to `codex`
- `gemini`: launch command defaults to `gemini`
- 三個 CLI agent 預設共用同一 workspace。
- executable path、workspace path、default args、profile/model/config 必須可在 settings 中覆寫。
- Adapter 必須支援 launch、send input、send Ctrl-C、kill process、read output、status detection。

### 6.5 Team Role

可能角色：

- Planner：拆需求、建立開發計畫。
- Developer：讀 code、改 code、實作功能。
- Reviewer：檢查 diff、找 bug、確認風險。
- Tester：跑測試、整理失敗原因、提出修正建議。
- Operator：啟動服務、管理環境、檢查 logs。

第一版 default role mapping：

- Claude Code: planner + reviewer
- Codex: implementer
- Gemini CLI: tester + verifier
- 使用者可在 task settings 中覆寫 role mapping。
- agent 之間需要自動交接任務，交接使用固定格式 handoff prompt。

### 6.6 Orchestration Route

定義 CLI agent 之間的自動轉送規則。

可能路由：

- Claude Code -> Codex：把規劃、修改建議或 review finding 轉成實作任務。
- Codex -> Gemini CLI：把變更摘要、測試需求或待驗證項目轉成驗證任務。
- Gemini CLI -> Claude Code：把測試結果、風險與疑問轉成 review 或下一輪規劃。
- Any -> User：需要批准、遇到高風險操作、無法判斷下一步時通知使用者。

路由內容類型：

- `task_brief`: 任務簡述。
- `plan`: 執行計畫。
- `implementation_summary`: 實作摘要。
- `review_request`: review 請求。
- `test_request`: 測試請求。
- `test_result`: 測試結果。
- `blocker`: 阻塞原因。
- `handoff`: 交接摘要。

控制原則：

- 所有自動轉送都要可在 UI 中看到。
- 系統要記錄來源 pane、目標 pane、轉送內容、時間與狀態。
- 預設模式是全自動連續協作，盡量一次跑到任務完成。
- 第一版仍應避免無限制 agent-to-agent 迴圈，需要 max rounds、timeout、no-progress detection 或 manual stop。
- 使用者可在任務進行中插入對話，插入內容會被視為新的 user intervention event，並可送到單一 CLI agent 或整個 team。
- 一般 repo 修改允許自動化；刪除檔案、危險命令、protected branch override、secret 洩漏等高風險情境需 approval 或 Stop Orchestration。

第一版預設路由：

- Claude Code: planner + reviewer
- Codex: implementer
- Gemini CLI: tester + verifier

第一版停止條件：

- `max_rounds`: 3
- 單一 CLI agent 無新輸出 timeout: 10 minutes
- 連續 2 輪沒有 diff、test、route status 的有效進展時 Stop Orchestration
- 測試通過且 Claude Code 沒有 blocker 時標記 completed
- 任一 CLI agent 明確回報 blocker 時進入 `blocked`
- 使用者按 Stop Orchestration 或 Kill Task 時立即停止自動路由

### 6.7 Handoff Prompt

自動轉送使用固定格式 handoff prompt 加摘要，不直接轉送完整 terminal 原文。

```text
[Handoff]
From: {source_agent}
To: {target_agent}
Task: {task_title}
Round: {round_number}
Route Type: {route_type}

Context:
{short_context_summary}

What changed / found:
{summary}

Request:
{specific_action_for_target_agent}

Evidence:
{commands_files_tests_or_diff_summary}

Constraints:
{safety_limits_workspace_branch_or_user_instructions}

Expected output:
{what_the_target_agent_should_return}
```

Handoff rules:

- Handoff must include source agent, target agent, task id, round number, and route type.
- Handoff must include Git branch and changed-file summary when workspace is Git-backed.
- Handoff must pass secret scan/redaction before sending to target agent.
- Handoff should prefer concise summaries, with terminal excerpts only when needed as evidence.
- Full raw terminal output remains in history, but is not forwarded by default.

### 6.8 Intervention Control

使用者在全自動流程中可介入控制。

控制類型：

- `pause`: 暫停自動轉送，不殺掉 terminal session。
- `resume`: 恢復自動轉送。
- `inject_message`: 向指定 CLI agent 或全體 CLI agent 插入對話。
- `stop_orchestration`: 停止自動轉送與 route engine，但 terminal sessions 保持存活。
- `kill_task`: 對 Claude Code、Codex、Gemini CLI terminal 送 Ctrl-C，必要時 kill child process，並將任務標記為 terminated。
- `terminate_task`: 終止本次任務，停止 orchestration，標記 task 為 terminated。第一版語意等同或包裝 `kill_task`，但 UI 文案需清楚區分。

控制原則：

- Stop Orchestration 與 Kill Task 必須是主介面固定可見操作。
- Stop Orchestration 不應清空 terminal，也不應關閉 CLI agent；它只是停止自動轉送與下一步派發。
- Kill Task 需要二次確認，並在執行前建立 termination snapshot。
- Kill Task 的流程：停止 route engine -> 建立 termination snapshot -> 對三個 CLI terminal 送 Ctrl-C -> 等待 grace period -> 必要時 kill child process -> 標記 task 為 terminated。
- Terminate task 需要二次確認，避免誤按。
- Pause 不應清空 terminal，也不應丟失 route history。
- Inject message 必須記錄內容、時間、目標 agent 與觸發者。
- 使用者介入後，系統應顯示目前 orchestration 是否繼續、暫停或終止。

### 6.9 Git Control

Git 是開發流程的強制控制層。任何會修改 workspace/repo 的任務，都必須先通過 Git preflight。

任務開始前：

- 檢查 workspace 是否為 Git repo。
- 檢查目前 branch。
- 檢查 working tree 是否乾淨。
- 檢查是否有 untracked files。
- 檢查是否有 upstream remote。
- 建立或切換到任務分支。
- 建立任務開始前備份點。

任務執行中：

- 週期性讀取 `git status --short`。
- 追蹤 changed files。
- 追蹤 staged/unstaged 狀態。
- 在 UI 顯示 diff summary。
- 在 route message 中附上相關 changed files，而不是讓 CLI agent 猜測。
- 若偵測到任務外檔案變更，標記為 Git warning。

任務完成前：

- 顯示完整 changed-file scope。
- 顯示 diff summary。
- 執行使用者或專案設定的驗證命令。
- 建議 commit message。
- 提供 commit action，但不自動 commit。
- 使用者確認 commit 後，系統才執行 `git add` 與 `git commit`。
- commit 前再次顯示 staged files、diff summary、測試結果與 commit message。

備份能力：

- `pre_task_snapshot`: 任務開始前記錄 commit hash、branch、status、diff patch。
- `manual_checkpoint`: 使用者手動建立 checkpoint。
- `auto_checkpoint`: 每個 orchestration round 或重要階段建立 checkpoint。
- `termination_snapshot`: 任務被終止時保存當下 Git 狀態與 diff。

Checkpoint default:

- 第一版使用 patch file + metadata。
- patch file 內容來自 Git diff。
- metadata 至少包含 task id、round、branch、base commit、created_at、changed files、source run。
- dirty tree 時可選擇性建立 stash，但 stash 不是第一版預設。
- 不使用臨時 commit 作為 checkpoint，避免污染 commit history。

分支原則：

- 不直接在 protected branch 上自動開發。
- 若目前在 `main`、`master`、`develop` 或使用者設定的 protected branch，系統應建立 task branch。
- task branch 命名建議：`agent/{task-id}-{slug}`。
- 若 working tree 不乾淨，系統應提示處理策略：保留現況並建立 snapshot、建立新分支、或暫停任務。

### 6.10 Secret Redaction

Route message、handoff prompt、history preview、summary 在顯示或轉送前必須經過 secret scan/redaction。

第一版需偵測並遮蔽：

- `.env` values
- API keys and tokens
- private keys
- SSH keys
- database URLs
- bearer tokens
- GitHub tokens
- provider credentials

Redaction rules:

- Redacted value should be replaced with `[REDACTED:{type}]`。
- 原始 terminal log 可保留在本機受控 history，但不得自動轉送。
- 若偵測到 private key 或大量 secret，route engine 應 Stop Orchestration 並通知使用者。

### 6.11 Task

使用者希望 team-agent 完成的開發工作。

可能內容：

- 任務描述。
- 目標 repo/workspace。
- 指派 agent 或 agent team。
- 執行狀態。
- terminal sessions。
- 產出結果。
- 測試與驗收紀錄。

### 6.12 Run

一次 agent 對 task 的執行。

可能紀錄：

- 使用的 agent。
- 使用的 terminal session。
- 執行過的 commands。
- 讀寫過的檔案摘要。
- Git branch、base commit、changed files、diff summary。
- 測試結果。
- 錯誤與中斷原因。

## 7. Candidate MVP Scope

以下是候選範圍，需要你確認後才會變成正式 MVP。

### 7.1 Terminal Management

- 建立 terminal session。
- 在 UI 中查看 terminal output。
- 在同一畫面顯示多個 terminal panes。
- 從 UI 傳送 command。
- 停止或關閉 terminal。
- 顯示 session 狀態：idle、running、exited、error。
- 每個 terminal pane 可以綁定一個 CLI agent。

### 7.2 Task Management

- 建立開發任務。
- 將任務綁定到 workspace。
- 將任務指派給 Claude Code、Codex、Gemini CLI，或指定 terminal pane。
- 查看任務目前狀態。

### 7.3 CLI Agent Control

- 從 UI 啟動 Claude Code、Codex、Gemini CLI。
- 顯示每個 CLI agent 正在做什麼。
- 顯示 terminal command、互動輸入與結果。
- 每個 CLI agent 或任務階段可以對應到獨立 terminal pane。
- 支援向指定 pane 傳送 prompt 或 command。
- 顯示最後產出與下一步建議。

### 7.4 Agent-to-Agent Orchestration

- 自動擷取 Claude Code、Codex、Gemini CLI 的輸出。
- 將輸出整理成可轉送訊息。
- 依照 route 規則轉送給其他 CLI agent。
- 在 UI 中顯示轉送紀錄與目前 collaboration round。
- 支援暫停、恢復、停止自動轉送。
- 支援人工插入訊息或改寫下一次轉送內容。
- 支援全自動連續執行，直到任務完成、遇到阻塞、達到停止條件或使用者介入。

### 7.5 Runtime Intervention

- 在任務執行中向 Claude Code、Codex、Gemini CLI 任一 pane 插入訊息。
- 對整個 orchestration 執行 pause/resume。
- Stop Orchestration：停止自動轉送，但 terminal 還活著。
- Kill Task：對三個 CLI terminal 送 Ctrl-C，必要時 kill child process，整個任務標記 terminated。
- 在 UI 顯示介入後的狀態，例如 paused、stopping、terminated。

### 7.6 Git Control and Backup

- 任務開始前執行 Git preflight。
- 強制建立或確認 task branch。
- 建立 pre-task snapshot。
- 任務執行中追蹤 changed files 與 diff summary。
- 支援手動 checkpoint 與自動 checkpoint。
- 任務終止時建立 termination snapshot。
- 完成前顯示 Git scope、測試結果與建議 commit message。
- 使用者確認後才建立 commit。

### 7.7 Development Workflow

- 規劃。
- 實作。
- 測試。
- review。
- 完成或退回。

### 7.8 History and Traceability

- 保留任務歷程。
- 保留 terminal output。
- 保留測試結果。
- 保留重要決策與 agent summary。
- 保留 agent-to-agent route message。
- 保留使用者中途介入、Stop Orchestration、Kill Task、終止任務的事件。
- 保留 Git preflight、branch、snapshot、checkpoint、diff summary 與 final scope。

## 8. Draft Workflow

這是討論用流程，不是已確認規格。

1. User opens a workspace.
2. User creates a development task.
3. System runs Git preflight for the workspace.
4. System creates or confirms task branch.
5. System creates pre-task snapshot.
6. System creates or assigns multiple terminal panes.
7. User chooses which panes run Claude Code, Codex, and Gemini CLI.
8. User sends the development task prompt to one or more CLI agents.
9. CLI agents execute inside their terminal panes.
10. System captures meaningful output from each CLI agent.
11. System forwards selected output to the next CLI agent according to route rules.
12. System tracks Git status, changed files, checkpoints, and diff summaries during execution.
13. System continues collaboration automatically while progress is detected.
14. User watches the development process, route messages, and Git changes across panes.
15. User can inject messages into one agent or the full team at any point.
16. User can pause/resume orchestration.
17. User can stop orchestration or kill the task.
18. System creates termination snapshot if the task is terminated.
19. System stops when task is completed, blocked, no-progress threshold is reached, safety stop is triggered, or user terminates the task.
20. User reviews final result, changed-file scope, diff summary, test result, and commit recommendation.

需要確認：

- 預設不要求每一步 approve，採全自動連續執行。
- CLI agent 需要可以自動連續執行。
- 自動轉送要使用完整原文、摘要，還是結構化 handoff prompt。
- 每輪自動協作的停止條件。
- 使用者中途介入是必要能力，但不是每一步的前置門檻。
- Git preflight 不通過時，任務不得進入自動修改流程。

## 9. State Model Draft

### 9.1 Terminal Session Status

- `starting`
- `idle`
- `running`
- `waiting_input`
- `exited`
- `error`

### 9.2 Task Status

- `draft`
- `planned`
- `approved`
- `running`
- `testing`
- `reviewing`
- `completed`
- `blocked`
- `canceled`

### 9.3 CLI Agent Run Status

- `queued`
- `running`
- `waiting_user`
- `succeeded`
- `failed`
- `canceled`

### 9.4 Orchestration Status

- `idle`
- `routing`
- `waiting_agent`
- `waiting_user`
- `paused`
- `stopped`
- `stopping`
- `completed`
- `failed`
- `terminated`

### 9.5 Git Control Status

- `not_checked`
- `checking`
- `clean`
- `dirty`
- `branch_required`
- `snapshotting`
- `ready`
- `warning`
- `blocked`

狀態名稱與轉換條件待確認。

## 10. Architecture Questions

這類系統的架構關鍵在 terminal 控制、agent orchestration、檔案操作安全與 UI 即時更新。以下是 technical design 階段需要細化的問題：

- Desktop app 採 Electron + embedded web terminal + Python local backend。
- 第一版 terminal session 在本機 shell 執行，用於啟動 Claude Code、Codex、Gemini CLI；不支援 SSH/remote/container。
- 多 terminal pane 的即時 output streaming 與 UI 更新方式。
- Claude Code、Codex、Gemini CLI 的啟動、輸入、停止與 session lifecycle。
- CLI output capture 的穩定邊界：如何判斷一段輸出已完成、可轉送。
- route engine：如何避免循環、重複轉送與 prompt 汙染。
- Stop Orchestration 如何停止 route engine 但保留 terminal sessions。
- Kill Task 如何中斷 PTY/child process，以及如何標記未完成 run。
- terminate task 如何關閉或保留 terminal sessions。
- Git preflight 如何處理 dirty working tree、untracked files、protected branch。
- checkpoint 採用 patch file + metadata；dirty tree 時可選擇性 stash。
- task branch 是否自動建立，以及 commit confirmation flow 如何設計。
- CLI agent 可以直接操作本機 repo 檔案，但必須受 Git preflight、task branch、snapshot/checkpoint 約束。
- 第一版允許 CLI agent 直接修改本機 repo；permission approval 僅針對高風險命令、secret 洩漏或 protected branch override。
- 是否要支援多 repo、多 workspace。
- 是否要支援多人同時使用。

## 11. Technical Direction

### 11.1 Selected Direction

第一版採 Electron + embedded web terminal + Python local backend。

定案組合：

- Desktop shell: Electron
- Terminal renderer: xterm.js or equivalent embedded web terminal
- Local backend: Python service with PTY control
- Storage: SQLite
- Git integration: local git command wrapper
- CLI agent integration: PTY-backed adapters for `claude`, `codex`, `gemini`
- Platform: macOS only for v1
- Terminal execution: local shell only for v1
- Repo access: CLI agents may directly modify local repo files after Git preflight passes

選擇原因：

- 多 terminal pane 需要穩定的 terminal rendering 與 keyboard handling。
- UI 需要 terminal grid、route messages、Git status、prompt composer 與 global controls。
- xterm.js 類型的 renderer 比 tkinter Text 更適合現代 terminal UI。
- local backend 可以直接控制本機 shell、child process、Git、workspace files。

### 11.2 Reference Option: Python Desktop App

參考 `SSH-Manager`，使用 Python 建立 Desktop app。

適合：

- 延續既有 `SSH-Manager` 的可行做法。
- 快速做出 macOS desktop prototype。
- 可直接使用本機 shell、SSH、threading、JSON storage。

可能技術：

- `tkinter` for UI。
- `paramiko` for SSH terminal。
- `pty`/`subprocess` for local shell。
- `pyte` for terminal screen rendering。
- macOS `.app` packaging script。

風險：

- tkinter 做多 pane、複雜 dashboard、拖曳 layout 的體驗有限。
- terminal rendering 與輸入處理要小心。
- UI 美觀與長期擴充可能受限。

### 11.3 Desktop App with Web UI Shell

使用桌面框架包 Web UI，後端負責 terminal process 與 agent orchestration。

適合：

- 需要更強的 terminal grid、多 pane layout、狀態視覺化。
- 需要長期做成完整產品。
- 想快速建立 MVP。

風險：

- 比純 Python tkinter 初期多一層前後端通訊。
- 打包、權限、local process bridge 需要設計。

### 11.4 Desktop App with Embedded Web Terminal

使用成熟 terminal web component 作為 pane，例如 xterm.js 類型的 terminal renderer，再由 local backend 提供 PTY。

適合：

- 多 terminal pane。
- 接近現代 IDE terminal 的操作體驗。
- 後續可加 agent status、task board、timeline，但主畫面仍以 terminal grid 為核心。

風險：

- 技術棧需要重新選型。
- local backend 與 UI streaming contract 要先設計清楚。

### 11.5 Server-based Web App

terminal 跑在 server/container 中，瀏覽器只做控制介面。

適合：

- 團隊多人使用。
- 每個任務隔離在 container。
- 未來要做 SaaS。

風險：

- 基礎設施複雜度高。
- 權限、隔離、成本管理較重。

## 12. Data Model Draft

資料模型需等產品型態確認後才能定稿。以下只是候選實體：

- `workspaces`
- `terminal_sessions`
- `terminal_events`
- `tasks`
- `git_repositories`
- `git_snapshots`
- `git_checkpoints`
- `git_change_events`
- `cli_agents`
- `cli_agent_runs`
- `commands`
- `route_rules`
- `route_messages`
- `orchestration_runs`
- `intervention_events`
- `settings`
- `workspace_configs`
- `artifacts`
- `reviews`

初步關係：

- workspace has many tasks。
- workspace has many terminal sessions。
- task has many CLI agent runs。
- task belongs to one git repository when workspace is Git-backed。
- task has many git snapshots and git checkpoints。
- git change event records changed files, diff summary, and source run。
- CLI agent run uses one terminal session。
- terminal session has many terminal events。
- orchestration run has many route messages。
- orchestration run has many intervention events。
- route message has source CLI agent run and target CLI agent run。
- workspace has one workspace config。
- settings store executable paths, route defaults, protected branches, test commands, max rounds, timeouts, profile/model/config, and redaction rules。
- task has many artifacts and reviews。

## 13. Non-functional Concerns

### 13.1 Safety

- 指令執行必須可觀察。
- 危險命令、secret 洩漏或 protected branch override 需要 approval 或 Stop Orchestration。
- CLI agent 可以直接修改本機 repo 檔案，但只能在通過 Git preflight 的 workspace/task branch 中進行。
- 自動轉送不得無限制循環，必須有停止條件。
- Stop Orchestration 與 Kill Task 必須隨時可用，且不依賴目前 focus 在哪個 terminal pane。
- Kill Task 前必須建立 termination snapshot，除非檔案系統或 Git 狀態無法讀取。
- 修改 repo 前必須先通過 Git preflight。
- 不得在 protected branch 上直接自動修改，除非使用者明確覆寫。
- 系統不得覆蓋使用者原本未提交的變更，必須先建立 snapshot 或暫停。
- Route message 與 handoff prompt 必須先通過 secret redaction。
- 偵測到 private key 或高風險 secret 時必須 Stop Orchestration。

### 13.2 Traceability

- terminal output、commands、CLI agent decisions、test results 應可回溯。
- agent-to-agent route message 應可回溯。
- 使用者介入、Stop Orchestration、Kill Task 與終止任務事件應可回溯。
- Git branch、base commit、snapshots、checkpoints、diff summaries 應可回溯。
- 重要紀錄不能只存在即時畫面。

### 13.3 Responsiveness

- terminal output 需要即時或接近即時更新。
- 長任務不能阻塞 UI。
- 自動轉送需要節流，不能讓三個 CLI 同時大量輸出時拖垮 UI。

### 13.4 Recovery

- terminal session 中斷時要能標記狀態。
- task run 失敗時要能查看原因。
- pause 後需支援 resume。
- Stop Orchestration 後可 resume route engine，terminal sessions 保持原狀。
- Kill Task 後不自動 resume。
- terminate 後不自動 resume；若要重開，應建立新的 run 或 task iteration。
- terminate 後需保留 termination snapshot，讓使用者能看見當時變更並決定保留、回復或另開分支。
- CLI crash 時應標記對應 CLI agent run failed，保留 terminal history，並讓 route engine 進入 waiting_user 或 failed。
- route message 送出失敗時應可 retry 或人工改寫再送。
- Git snapshot 失敗時不得進入自動修改流程。

## 14. MVP Acceptance Criteria

第一版 MVP 完成標準：

1. 使用者可以開啟一個 Git-backed workspace。
2. 系統會執行 Git preflight，必要時建立 task branch。
3. 系統會建立 pre-task snapshot。
4. UI 顯示固定 2x2 layout：Claude Code、Codex、Gemini CLI、Control/Route/Git。
5. 系統可以在三個 terminal pane 啟動 `claude`、`codex`、`gemini`。
6. 使用者可以輸入一次任務，系統將任務送入起始 CLI agent。
7. 系統可以產生固定格式 handoff prompt，並至少完成一輪 Claude -> Codex -> Gemini 的自動轉送。
8. Route message 送出前會做 secret redaction。
9. 使用者可以中途 inject message 到單一 agent 或全體 agent。
10. Stop Orchestration 可以停止 route engine 且保留 terminal sessions。
11. Kill Task 可以送 Ctrl-C，必要時 kill child process，並建立 termination snapshot。
12. 系統可以追蹤 changed files 與 diff summary。
13. 任務完成時顯示 changed-file scope、diff summary、測試結果與 commit message 建議。
14. 使用者確認後才執行 `git add` 與 `git commit`。
15. 所有 terminal events、route messages、intervention events、Git snapshots/checkpoints 可回溯。
16. v1 app 可以在 macOS 以 Electron 啟動，並連接 Python local backend。
17. v1 terminal sessions 使用本機 shell，不依賴 SSH/remote/container。
18. v1 使用 SQLite 保存 settings、workspace config、task/run、terminal events、route messages、Git snapshots/checkpoints。

## 15. Technical Design Follow-ups

目前第一版產品與技術核心已定案。後續 technical design 階段仍需細化：

1. SQLite schema 欄位細節與 migration 策略。
2. Electron 與 Python local backend 的 IPC / WebSocket contract。
3. xterm.js terminal event model 與 PTY resize/input protocol。

## 16. Next Step

等上述問題確認後，下一版 SDD 應補齊：

- 明確 MVP scope。
- 系統架構圖。
- terminal session lifecycle。
- CLI agent adapter。
- CLI agent role 與交接規則。
- agent-to-agent route engine。
- runtime intervention controls。
- Git preflight、branch、backup、checkpoint、diff tracking。
- 權限與安全策略。
- 第一版資料表或 storage schema。
- API/WebSocket event contract。
