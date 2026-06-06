# Navide (Agent-Team)

> **把 Claude Code、Codex、Gemini CLI 同時跑起來，讓它們照 SDLC 流程分工、協作、自動推進。**

[English](README.md) | [繁體中文](README.zh-TW.md)

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://www.apple.com/macos/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 為什麼需要 Navide (Agent-Team)？

單一 AI coding agent 有它的極限——複雜任務需要等待、上下文有限、角色單一。
**Navide (Agent-Team) 讓你同時開多個 agent、各司其職、輸出互相傳遞，像一支真正的工程團隊。**

| 痛點 | Navide (Agent-Team) 的解法 |
|---|---|
| 一個 agent 做完需求再做設計、再做實作，排隊等待 | 多 agent **並行**跑同一 Stage，完成後自動推進下一 Stage |
| 不同任務需要不同思維（PM、Backend、QA）| 每個 pane 自動注入對應 **Role System Prompt** |
| Agent 輸出很長，下一步不知道從哪繼續 | Stage 完成後**自動截取上下文**注入給下一 Stage |
| 不知道 agent 是在思考還是已經卡住 | Local LLM (Ollama) **即時判讀 agent 意圖**，三訊號存活偵測 |
| 每次都要手動貼任務描述、設定角色 | 一鍵 **▶ Run pipeline**，4 個 SDLC Stage 全自動跑完 |

---

## 核心功能

### 🚀 4-Stage SDLC Pipeline（全自動）

給一段任務描述，Navide (Agent-Team) 自動依序跑完需求分析 → 設計 → 實作 → 測試，每個 Stage 用對的 agent + 對的角色。

```
▶ Run pipeline  →  Stage 01 需求分析  →  Stage 02 設計規劃  →  Stage 03 實作  →  Stage 04 測試驗收
                       Claude · PM          Claude · PM            Codex · Backend      Gemini · QA
                                            Claude · Frontend      Claude · Frontend
```

### 🤝 Manager 協調模式（Multi-Agent 指揮）

當 Stage 有多個並行 Agent 時，可指定一個 **Manager** 統籌協調：
- Manager 完成自己的工作後進入控場模式
- Worker 可透過 `---ASK-START---` 向 Manager 提問
- Manager 透過 `---DISPATCH-START---` 分配指令
- Manager 決定何時用 `---STAGE-DONE---` 結束整個 Stage

### 🧠 Local LLM Analyzer

不只看 sentinel 字串，還用本地 LLM 即時判讀每個 agent 的意圖：

| 判讀結果 | 觸發動作 |
|---|---|
| `question` | 彈出問題視窗讓使用者回答（或 Full Auto 模式自動回答）|
| `completion` | 確認此 Slot 完成，計入推進條件 |
| `in_progress` | 延展存活視窗，繼續等待 |

可在 **Settings → Analyzer** 隨時切換兩種推論後端：

| 後端 | 運作方式 | 適合情境 |
|---|---|---|
| **llama.cpp**（預設）| 直接用 `llama-cli` / `llama-completion` 讀取 Ollama 的 GGUF blob，不需常駐 daemon | 延遲較低；不需要 Ollama server 在跑 |
| **Ollama REST** | 呼叫正在執行的 Ollama server 的 `POST /api/generate` | 安裝更簡單；GPU 記憶體與並發由 Ollama 管理 |

無論使用哪種後端，都可透過 **Settings → Analyzer → 模型管理** 下載或刪除模型。

### 📊 Token 用量即時追蹤

從 CLI log files 直接解析三個廠商的 token 用量，按 Stage / Run 分類，不需要任何 API key 或額外設定。

### 📚 Context7 文件注入

每個 Stage 啟動前，自動偵測 task 中的技術棧（Next.js、Laravel、Flutter…），從 Context7 取得最新框架文件並注入 kickoff prompt，讓 agent 從一開始就有正確的 API 知識。

### 🔄 Pipeline Resume

中途關閉 App 或中斷執行？
`.agent-team/project.json` 記錄每個 Stage 的狀態，重新開啟後可從任意未完成的 Stage 繼續。

### 📂 Workspace-First 入口

打開 App 先看到 **Welcome 入口**（VS Code "Open Folder" 風格），而不是空白主畫面：
- **Recent 清單** — 最近開過的 workspace，含上次任務與狀態，可 **★ 釘選**（釘的排前面、不被淘汰），失效資料夾自動標灰
- **Browse…** — 開資料夾 dialog 選擇或新建
- 選定後依專案狀態自動切換 **Pipeline / Spawn / Completed** 模式

### 🕓 History Timeline

右側面板可在 **Token 用量** 與 **History** 間切換：
- 每次 run 的所有事件（spawn / inject / sentinel / question / analyzer / handoff / error）結構化落地到 `.agent-team/runs/{run-id}/history.jsonl`
- Timeline UI 支援**類型/Stage 篩選、搜尋、點擊展開細節、匯出 .jsonl**
- **自動滾動黏底**跟進最新事件，往上捲看歷史時自動暫停

---

## Demo

```
任務：「為連鎖門市建立內部簽核系統，紙本流程數位化，支援 iOS + Android」

Stage 01  Claude  (PM)           → 輸出 PRD、使用者故事、UAT 情境
Stage 02  Claude  (PM)           → 系統架構、API 設計、ERD
          Claude  (Frontend)     → 線框稿、元件規格、設計系統
Stage 03  Codex   (Backend)      → 實作 API、資料庫 migration、驗證邏輯
          Claude  (Frontend)     → 實作 React Native 頁面、串接 API
Stage 04  Gemini  (QA/Test)      → Happy/Unhappy path、E2E 腳本、UAT 清單
```

所有輸出互相傳遞。上一 Stage 的 Claude 設計文件自動成為下一 Stage Codex 的 context。

---

## 快速開始

### 前置需求

| 工具 | 版本 |
|---|---|
| Node.js | 22+ |
| pnpm | 10+ |
| Python / uv | 3.12 / 0.11+ |
| macOS | 13+ |

**Agent CLI（可選，有裝才能真正執行）：**
- `claude` — [Claude Code](https://code.claude.ai)
- `codex` — [Codex CLI](https://github.com/openai/codex)
- `gemini` — [Gemini CLI](https://github.com/google-gemini/gemini-cli)

**Local LLM Analyzer（可選，建議裝）：**

預設後端（`llama.cpp`）需要同時安裝 Ollama（下載模型）與 llama.cpp CLI（推論）：

```bash
brew install ollama llama.cpp   # llama.cpp 提供 llama-cli 執行檔
ollama pull qwen2.5-coder        # 下載 GGUF 到 ~/.ollama
```

若你的 llama.cpp 安裝出來的執行檔叫 `llama-cli` 而不是 `llama-completion`，可在
**Settings → Analyzer → llama-cli 執行檔路徑** 設定，或啟動前設定環境變數：

```bash
export LLAMA_CLI=llama-cli
```

也可改用 **Ollama REST** 後端（在 Settings 切換），只需安裝 Ollama、不需要 llama.cpp：

```bash
brew install ollama
ollama serve           # 在背景保持執行
ollama pull qwen2.5-coder
```

### 安裝

```bash
git clone https://github.com/nt-nerdtechnic/Navide (Agent-Team)
cd Navide (Agent-Team)

pnpm install
uv --project backend sync
```

### 啟動

```bash
pnpm dev
```

這一個指令會同時啟動 Vite dev server、Electron 主視窗、Python backend（動態 port）。

---

## 使用方式

### Pipeline 模式（推薦）

1. **Open Workspace** — 在 Welcome 入口從 Recent 清單選一個，或 Browse 選/新建專案資料夾
2. **Task description** — 描述你要做什麼（中文英文皆可）
3. 點 **▶ Run pipeline** — 系統自動 spawn Stage 01 的 agent、注入 Role Prompt、送出 Kickoff Prompt
4. Agent 完成後自動偵測（sentinel / analyzer / turn_complete）→ 推進到下一 Stage
5. 重複到 Stage 04 結束，彈出完成彈窗

> 進行中可隨時開右側 **History** 分頁看完整事件時間軸，或在 Header 切換 / 關閉 workspace（pipeline 執行中會警告）。

**進階選項：**

| 設定 | 說明 |
|---|---|
| **YOLO Mode** | 自動帶入 `--dangerously-skip-permissions` 等略過確認的 flags |
| **Continuous Mode** | Sentinel 偵測到或 Analyzer 判定完成時自動推進，不需手動按 Next |
| **Strict Mode** | Idle/Cap timeout 時彈確認視窗，不自動推進 |
| **Full Auto** | LLM 自動回答 agent 提出的問題，免人工干預 |
| **Local Analyzer** | 本地 LLM 即時判讀 agent 意圖，取代純 sentinel 偵測（可在 Settings → Analyzer 切換後端）|

### Manual Spawn（單次手動）

1. 展開 **Manual spawn** 區塊
2. 選 CLI、Role、Stage
3. 點 **+ Add to grid**

每個 pane 都可以獨立 `⌃C`（中斷）、`Re-inject`（重送 Role Prompt）、`Remove`（關閉）。

### Stage / Role 自訂

工具列齒輪 → Settings 可開啟：
- **Role Manager**：編輯各角色的 system prompt，或新增自訂角色
- **Stage Editor**：調整每個 Stage 的 slot 組合、kickoff body、sentinel 字串

所有設定儲存在本機 `~/Library/Application Support/Navide (Agent-Team)/`，不進版本庫。

---

## 完成偵測機制

一個 Slot 被判定「完成」需滿足以下任一條件（按優先順序）：

```
1. Sentinel        — agent 輸出指定字串（如 ---SPEC-DONE---）於獨立一行
2. turn_complete   — Claude Hooks / log reader 偵測到 agent 回合結束 + 5s 安靜
3. Analyzer        — Ollama LLM 判讀 intent = "completion"
4. Idle timeout    — 10 分鐘無 cleaned-text 活動，通過多訊號存活探測後
5. Hard cap        — 15 分鐘絕對上限（防止永久卡住）
```

所有 Slot 完成後才推進 Stage（Strict Mode 下 Idle/Cap 需使用者確認）。

---

## 架構

```
┌─────────────────────────────────────────────────────────┐
│                   Electron Main Process                   │
│  多視窗管理 (Main / Roles / Stages) · IPC handlers      │
│  backend.ts — 動態 port · 子進程督管 · 健康檢查          │
└───────────────────────┬─────────────────────────────────┘
                        │ uv run python -m agent_team_backend
                        ▼
┌─────────────────────────────────────────────────────────┐
│              Python FastAPI Backend                       │
│                                                          │
│  WebSocket /ws ── 所有訊息路由（concurrent tasks）       │
│  REST /health · /hooks/claude · /mcp/...                 │
│                                                          │
│  terminals.py    PTY 進程管理（pty + asyncio）           │
│  projects.py     Pipeline 狀態 + per-run event log       │
│  analyzer.py     Ollama / llama-cli 本地 LLM 推論        │
│  log_readers/    Claude · Codex · Gemini log 解析        │
│  tokens_store.py Token 用量追蹤 + dedup                  │
│  mcp_manager.py  MCP server 連線（Context7 等）          │
│  doc_injector.py Context7 文件 → kickoff prefix         │
│  claude_hooks.py ~/.claude/settings.json hook 安裝      │
│  roles_store.py / stages_store.py  設定持久化            │
└───────────────────────┬─────────────────────────────────┘
                        │ WebSocket ws://127.0.0.1:{port}/ws
                        ▼
┌─────────────────────────────────────────────────────────┐
│                  Vue 3 Renderer                           │
│                                                          │
│  App.vue (Orchestrator)                                  │
│  ├─ Pipeline state machine                               │
│  ├─ Stage watcher (600ms poll · sentinel · analyzer)     │
│  ├─ Manager router (4s poll · ASK/REPORT/DISPATCH)       │
│  ├─ Question alert + auto-answer                         │
│  └─ Cross-slot handoff                                   │
│                                                          │
│  ControlPane.vue   左側控制面板                          │
│  TerminalPane.vue  xterm.js · displayStatus · PTY wire   │
│  TokenStatsPanel   即時 token 統計                       │
│  SettingsModal     MCP server 設定                       │
└─────────────────────────────────────────────────────────┘
```

### 技術棧

| 層 | 技術 |
|---|---|
| Desktop shell | Electron 33 |
| Frontend | Vue 3 + TypeScript + Vite (electron-vite) |
| Terminal 模擬 | xterm.js 6 + FitAddon |
| Backend | Python 3.12 + FastAPI + uvicorn |
| PTY | Python stdlib `pty` + asyncio |
| Local LLM | Ollama / llama-cli (GGUF，Metal 加速) |
| MCP Client | `mcp` Python SDK |
| Package 管理 | pnpm (Node) · uv (Python) |

---

## 專案結構

```
agent-team/
├── src/
│   ├── main/
│   │   ├── index.ts          Electron 主進程、IPC、多視窗
│   │   └── backend.ts        Python 子進程管理、健康檢查
│   ├── preload/
│   │   └── index.ts          contextBridge API 暴露
│   └── renderer/src/
│       ├── App.vue           Pipeline Orchestrator（主邏輯）
│       ├── RolesManagerApp.vue
│       ├── StagesEditorApp.vue
│       ├── components/
│       │   ├── ControlPane.vue      左側控制面板
│       │   ├── TerminalPane.vue     xterm.js pane
│       │   ├── QuestionAlert.vue    agent 問題彈窗
│       │   ├── CompletionModal.vue  Pipeline 完成彈窗
│       │   ├── TokenStatsPanel.vue  token 統計面板
│       │   └── SettingsModal.vue    MCP 設定
│       ├── composables/
│       │   ├── useBackend.ts        WebSocket 連線 + 訊息路由
│       │   ├── useTerminal.ts       xterm + PTY wire-up
│       │   ├── useRoles.ts / useStages.ts
│       │   ├── useAnalyzer.ts       Ollama API
│       │   └── useTokens.ts         Token 用量 reactive state
│       ├── data/
│       │   └── stages.ts            Stage/Slot 型別 + kickoff 渲染
│       └── lib/
│           └── buffer.ts            ANSI strip · sentinel · question block parser
└── backend/agent_team_backend/
    ├── app.py               FastAPI + WebSocket dispatcher
    ├── terminals.py         PTY 進程管理
    ├── projects.py          Pipeline 持久化
    ├── analyzer.py          Local LLM (Ollama)
    ├── log_readers/         Claude / Codex / Gemini log 解析
    ├── tokens_store.py      Token 追蹤 + dedup
    ├── mcp_manager.py       MCP server 連線管理
    ├── doc_injector.py      Context7 文件注入
    ├── claude_hooks.py      Claude lifecycle hook 安裝
    ├── roles_store.py
    └── stages_store.py
```

---

## 本機資料與隱私

Navide (Agent-Team) 是本機開發者工具，所有運算和資料都留在你自己的機器上。

- **沒有外部服務依賴**（除了你主動啟動的 Claude / Codex / Gemini CLI 本身）
- **沒有遙測、沒有帳號**，不需要任何 API key
- Runtime 設定存於 `~/Library/Application Support/Navide (Agent-Team)/`（不進版本庫）
- Workspace 狀態寫入 `<workspace>/.agent-team/`（`project.json`、pipeline log、pane 對話記錄）

### YOLO Mode 注意事項

開啟 YOLO Mode 會自動帶入以下 flags：

| CLI | Flag |
|---|---|
| Claude Code | `--dangerously-skip-permissions` |
| Codex | `--dangerously-bypass-approvals-and-sandbox` |
| Gemini | `--yolo --skip-trust` |

這些 flags 讓 agent 跳過互動式確認，適合全自動執行，但 **agent 有完整的檔案系統讀寫權限**，請在你信任的 workspace 下使用。

### Claude Code Hooks

首次啟動時，Navide (Agent-Team) 會在 `~/.claude/settings.json` 新增三個 lifecycle hooks（`PreToolUse` / `Stop` / `Notification`），讓 backend 接收更精確的 agent 活動訊號。安裝是 merge-safe（不覆蓋你的現有設定），且原始 settings.json 會備份為 `.pre-agent-team.bak`。

### 尚未實作的安全功能

- 跨 Agent 傳遞前的 secret 自動抹除（planned）
- Workspace 沙盒隔離（Agent 目前有完整 user 權限）

---

## 執行測試

```bash
cd backend
uv run pytest
```

---

## 開發指令

```bash
pnpm dev            # 啟動 Electron + Vite + Python backend（全部）
pnpm build          # 打包 Electron app
pnpm typecheck      # TypeScript 型別檢查（Node + Web）
pnpm backend:dev    # 單獨啟動 Python backend（debug 用）
```

---

## 規劃中功能

- [ ] Git preflight（自動建 task branch、snapshot）
- [ ] Cross-agent route engine（agent 對 agent 的 routed message bus）
- [ ] Frontend tests（Vitest + Playwright）
- [ ] Windows / Linux 支援
- [ ] 更多 Agent CLI 支援（Aider、OpenCode 等）

> 完整 roadmap 與設計細節見 [`docs/spec.md`](docs/spec.md)。

---

## 安全性

漏洞回報流程請見 [SECURITY.md](SECURITY.md)。

**使用提醒：**
- YOLO Mode 下 agent 擁有完整檔案系統讀寫權，僅在信任的 workspace 下使用。
- Navide (Agent-Team) 安裝的 Claude Code hooks 是 merge-safe，原始 `~/.claude/settings.json` 會先備份。
- Navide (Agent-Team) 不儲存任何 API key，所有 CLI 憑證留在各自工具的設定中（`~/.claude/`、`~/.codex/` 等）。

---

## 貢獻

歡迎貢獻！提交 PR 前請先閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## License

MIT
