# Navide

> 不要只和一個 Agent 對話，開始帶領一支團隊。

Navide 是一套本地優先的 macOS 多 Agent 開發控制平台。它把 Agent 終端、可自訂交付流程、Manager／Worker 路由、執行歷程、Token 統計、Git 工作流、程式碼審查與 AI 輔助編輯器整合在同一個工作區。

[English](README.md) | [繁體中文](README.zh-TW.md) | [文件中心](docs/README.md)

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://www.apple.com/macos/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 為什麼需要 Navide？

AI Coding Agent 很強大，但複雜工作仍需要使用者協調提示、等待連續任務、搬運上下文、審查修改並處理卡住的 Agent。Navide 將這些彼此孤立的工具轉變成可觀察、可控制的工程工作流。

| 挑戰 | Navide 的能力 |
|---|---|
| 線性等待 | 在同一階段平行執行多個 Agent slot |
| 上下文中斷 | 建立並注入跨階段交接內容 |
| 協調成本 | 指定 Manager Agent 分派任務並處理 Worker 問題 |
| Agent 狀態不明 | 結合終端活動、CLI 日誌、Hook 與選用的本地分析 |
| 執行難以稽核 | 保存工作區歷程、Session、中繼資料、Diff 與 Token 用量 |
| 供應商綁定 | 使用多種 Agent CLI，並持續擴充 Adapter 能力 |

## 現有能力

### 多 Agent 工作區

可在獨立 pane 中執行 Claude Code、Codex、Antigravity CLI、Grok CLI 或一般終端。你可以切換版面、將仍在執行的 pane 最小化，並在偵測到 Session 後恢復支援的 Agent 工作階段。

### 可自訂 SDLC Pipeline

內建流程涵蓋需求、規劃、設計、實作、安全審查與測試。每個階段都能自訂平行 slot、Agent、角色、kickoff prompt、提問規則、文件查詢與完成 sentinel。

### Manager／Worker 協調

可指定一個 slot 作為全域 Manager。Navide 會路由結構化任務派發與 Worker 提問、帶入前置階段上下文，並由 Manager 協調階段完成。

### 本地感知與自動化

可使用 Ollama 或相容的本地 GGUF 模型判斷 Agent 意圖、識別問題或停滯狀態，並選擇是否根據任務背景自動回答。Manual、Strict、Continuous、Full Auto 與 YOLO 控制讓使用者自行決定自動化程度。

### 開發控制介面

Navide 包含工作區與檔案瀏覽、Monaco 編輯器、Plan／Diff、診斷、Git 與多 Repository 工作流、Issue 處理、程式碼審查、AI Chat、執行歷程，以及從相容 CLI 日誌解析的 Token 統計。

## 快速開始

Navide 目前支援 macOS 13 以上版本，並以原始碼方式安裝；尚未發布正式簽章下載版本。

### 前置需求

- Node.js 22+ 與 pnpm 10+
- Python 3.12+ 與 uv 0.11+
- 至少一個受支援的 Coding CLI
- 選用：Ollama 或本地 GGUF 分析模型

### 安裝與啟動

```bash
git clone https://github.com/nt-nerdtechnic/Navide.git
cd Navide
pnpm install
uv --project backend sync
pnpm dev
```

Onboarding Wizard 會檢查 runtime、偵測 Agent CLI，並說明相關 macOS 權限。接著可閱讀英文版 [Getting Started](docs/getting-started.md)。

## 技術架構

Navide 由三個本機應用層構成：

```text
Electron main process
  └─ 視窗生命週期、Backend process、更新與原生整合
       ↕ IPC
Vue renderer
  └─ 工作區、Pane、Pipeline、Editor、Git、History 與 Settings
       ↕ Loopback WebSocket / HTTP
Python FastAPI backend
  └─ PTY、持久化、CLI 日誌、Git、Analyzer、MCP 與 AI services
       ↕
外部 Agent CLI，以及選用的本地或雲端服務
```

詳細責任邊界與資料流請見 [Architecture](docs/architecture.md)。

## 隱私與安全

Navide 的編排程序與工作區狀態在本機執行，不營運專案遙測服務，也不要求建立 Navide 帳號。但 Navide 並非所有情況都完全離線：使用外部 Agent CLI、雲端 AI Provider、Context7、搜尋、Git Hosting、MCP Server 或更新檢查時，可能會與第三方服務通訊。

使用者輸入的 Cloud AI Key 會以受限檔案權限保存在本機。Agent 一般會繼承目前使用者的作業系統權限，而 Navide 尚未提供完整的 Workspace Sandbox。YOLO 與 Full Auto 僅應在可信任且有版本控制的工作區中使用。

處理敏感程式碼或憑證前，請閱讀 [Privacy and Data Flows](docs/privacy.md) 與 [Security Policy](SECURITY.md)。

## 文件

- [文件中心](docs/README.md)
- [使用指南](docs/user-guide.md)
- [疑難排解](docs/troubleshooting.md)
- [技術架構](docs/architecture.md)
- [產品 Roadmap](docs/roadmap.md)
- [貢獻指南](CONTRIBUTING.md)

## 長期方向

Navide 的長期方向是成為本地優先的多 Agent 開發控制平台：強化編排可靠性、建立能力導向的 Agent Adapter、改善隔離與 Secret Handling、提供可重現的 Run Artifact、支援依賴圖工作流、GitHub 交付自動化、可重用 Pipeline Template，以及跨平台支援。

Roadmap 代表方向，不是交付承諾。各階段目標、邊界與退出條件請見 [Product Roadmap](docs/roadmap.md)。

## 授權

MIT © Navide Team
