# Navide

> **Agent 時代的工程利器。**
>
> 一位工程師，一整支 AI 工程力量。

Navide 是為一個人調度多個 Coding Agent 而生的 AI-native 軟體工程環境。它將 Agent 與 Session 調度、私有專案記憶、可自訂開發 Pipeline、測試與審查、Git 工作流、終端控制及精密編輯整合在一套本地優先的應用程式中。

Navide 不是要成為傳統 IDE 裡的另一個聊天面板，而是要成為傳統 IDE 之後的新工程環境。

[English](README.md) | [繁體中文](README.zh-TW.md) | [Manifesto](docs/manifesto.md) | [文件中心](docs/README.md)

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://www.apple.com/macos/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 為什麼需要 Navide？

傳統 IDE 是為親自完成大部分實作工作的工程師設計；AI 改變了這個前提。一位工程師現在可以同時指揮多個 Agent，平行進行研究、規劃、實作、測試、審查與微調。

AI 模型提供新的動力，Navide 提供駕馭這股力量所需的工程系統：角色、Session、協調、記憶、可見性、介入與完成證據。

```text
傳統 IDE
工程師 → 編輯檔案、操作工具 → 軟體

Navide
工程師 → 指揮目標、Agent、決策與證據 → 軟體
```

工程師仍對意圖、架構、判斷、風險與最終驗收負責；Agent 承接可重複的執行工作；Navide 讓整個過程保持同步、可見、可中斷並可恢復。

完整理念請見 [The Navide Manifesto](docs/manifesto.md) 與 [Product Vision](docs/vision.md)。

## 工程工作模型

### Genesis — 從想法到可運作雛形

以可自訂 Pipeline 啟動新專案，涵蓋需求、規劃、設計、實作、安全審查與測試。多個 Agent slot 可以平行工作，並在階段之間傳遞上下文。

### Evolution — 持續開發

透過彼此協調的 Agent Session，為既有專案開發功能、修復問題、執行測試、微調行為並持續維護。這個不斷重複的演進循環，而非一次性的 Pipeline，才是日常工作的核心。

### Intervention — 人類精密介入

透過 Diff、Monaco Editor、Terminal、Diagnostics、Git、Tests 與 Review 工具檢查和修改成果。直接編輯仍然是第一級工程能力，但它用在人類判斷與精度真正有價值的地方，而不再是開發軟體的唯一方式。

## 現有能力

- **多 Agent 工作區：**在獨立 pane 中執行 Claude Code、Codex、Antigravity CLI、Grok CLI 或一般終端。
- **Session 生命週期：**偵測、保存、重建並恢復受支援的 CLI Session。
- **可自訂 Pipeline：**設定 Stage、平行 slot、Agent、角色、kickoff prompt、提問規則、文件查詢與完成 sentinel。
- **Manager 協調：**路由結構化任務派發與 Worker 問題，並傳遞跨階段上下文。
- **自動化控制：**結合終端活動、Provider Log、Hook 與選用的本地分析，提供 Manual、Strict、Continuous、Full Auto 與 YOLO 模式。
- **私有專案歷史：**在 `.agent-team/` 保存 Workspace 狀態、Run Event、Handoff 與 Token 摘要。
- **工程操作介面：**檔案瀏覽、Monaco 編輯、Plan／Diff、衝突處理、Git 與多 Repository 工作流、Issue、Review 及 AI Chat。
- **可觀察性：**依 Workspace、Stage、Pane 與 Run 查看 History 及相容 CLI 的 Token 用量。

## 私有 Project Intelligence

每位工程師對專案都有一份私有理解：目前的 Session、先前嘗試、任務脈絡、決策、Handoff 與完成證據。Navide 將這份本機工程記憶保存於 `<workspace>/.agent-team/`。

`.agent-team/` 已排除於 Git 之外，也不是用來同步真人團隊的資料。原始碼與共用專案文件仍是 Repository 裡的共同事實；`.agent-team/` 則是個別工程師用來協調 AI Session 的本機智慧層。

## 例外管理

Navide 的方向，是讓 Agent 在可逆、可見的範圍內持續工作，而不是每一步都要求工程師批准。只有遇到需求歧義、風險、決策衝突、外部影響或不可逆操作時，才將注意力交還給工程師。

長期標準是：

> 高度自主、全程可見、隨時可介入，並以證據負責。

目前的自動化控制只是這個方向的早期實作，尚未提供 Roadmap 中描述的完整 Policy 與 Isolation 模型。

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

Onboarding Wizard 會檢查 Runtime、偵測 Agent CLI，並說明相關 macOS 權限。接著可閱讀 [Getting Started](docs/getting-started.md) 與 [User Guide](docs/user-guide.md)。

## 隱私與安全

Navide 的編排程序、私有專案智慧與 Workspace 狀態都在本機執行，不營運專案遙測服務，也不要求建立 Navide 帳號。但 Navide 並非所有情況都完全離線：使用外部 Agent CLI、雲端 AI Provider、Context7、搜尋、Git Hosting、MCP Server 或更新檢查時，可能會與第三方服務通訊。

Agent 一般會繼承目前使用者的作業系統權限，而 Navide 尚未提供完整的 Workspace Sandbox。處理敏感程式碼、憑證、YOLO 或 Full Auto 前，請閱讀 [Privacy and Data Flows](docs/privacy.md) 與 [Security Policy](SECURITY.md)。

## 長期方向

Navide 的目標不是逐一複製傳統 IDE 的畫面與操作，而是透過以人類意圖和協調式 AI 執行為核心的新互動模型，提供理解、建立、瀏覽、編輯、執行、除錯、測試、審查、版本控制及交付軟體所需的完整專業能力。

從目前可運作的系統走向完整 AI-native 工程環境的路徑，請見 [Product Roadmap](docs/roadmap.md)。

## 授權

MIT © Navide Team
