# 🌌 Navide (Agent-Team)

> **停止與 Agent 對話，開始領導一支團隊。**
> 同時運行 Claude Code, Codex, 與 Gemini CLI — 透過 SDLC 流水線自動化協作與上下文傳遞。

[English](README.md) | [繁體中文](README.zh-TW.md)

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://www.apple.com/macos/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## ⚡ 為什麼選擇 Navide (Agent-Team)？

單一 AI 代理有其極限 —— 複雜任務需要不斷等待、上下文有限，且單一模型很難在 PM、後端與 QA 的思維間頻繁切換。

**Navide 將你的 AI 工具從孤立的聊天框轉變為一支協調有度的工程團隊。**

| 痛點 | Navide 的解法 |
| :--- | :--- |
| **線性等待** | **並行執行**：在一個階段中同時運行多個 Agent（如前端與後端）。 |
| **上下文斷層** | **自動銜接**：在 4 個 SDLC 階段間自動提取並注入上下文。 |
| **Agent 卡住** | **本地 LLM 判讀**：專屬本地模型即時解析 Agent 意圖，保持流水線運作。 |
| **手動輸入** | **全自動回答**：AI 根據任務背景自動回答 Agent 的提問。 |

---

## 🚀 核心功能

### 🛠️ 4 階段 SDLC 流水線
將簡單的任務描述，透過全自動流水線轉化為成品：
**需求分析 → 系統設計 → 程式實作 → 測試驗收**。Navide 為每個步驟配置最適合的角色。

### 🤝 管理員協調模式 (Manager Mode)
指定一個 **Manager Agent** (如 Claude) 來指揮 Worker Agents。
- Manager 透過 `---DISPATCH---` 分配任務。
- Worker 透過 `---ASK---` 提問或匯報進度。
- Manager 決定何時完成當前階段。

### 🧠 本地 LLM 感知器 (Analyzer)
不只是簡單的文字匹配，Navide 使用 **Ollama** 或 **llama.cpp** 即時解讀 CLI 的意圖。
- **意圖偵測**：識別 Agent 是否在提問或陷入僵局。
- **全自動模式**：自動回答技術問題，實現 100% 無人值守。

### ✍️ AI 原生編輯器與瀏覽器
專為 AI 工作流設計的內建編輯器：
- **AI Hunks**：以 Inline Diff 審閱 AI 的修改，支援逐項接受。
- **虛影文字**：輸入時的即時 AI 代碼補全。
- **Cmd+K 重寫**：選取代碼並下指令，立即進行 AI 重構。

### 📊 即時 Token 追蹤
直接從廠商日誌解析用量，提供精確的成本統計。無需 API key 即可追蹤，並按階段與執行次數分類。

---

## 🏁 快速開始

### 1. 前置需求
Navide 是一個本地優先的工具，請確保具備：
- **Node.js 22+** & **pnpm 10+**
- **Python 3.12+** & **uv 0.11+**
- **macOS 13+**
- (建議) [Ollama](https://ollama.com/) 用於本地分析。

### 2. 安裝
```bash
# 複製倉庫
git clone https://github.com/nt-nerdtechnic/Agent-Team
cd Agent-Team

# 安裝依賴
pnpm install
uv --project backend sync
```

### 3. 執行
```bash
pnpm dev
```
*啟動後，**引導精靈 (Onboarding Wizard)** 將引導您完成工具檢測與配置。*

---

## 🏗️ 技術架構

Navide 採用「雙引擎」設計：

- **編排引擎 (Electron + Vue 3)**：管理 UI、狀態機與終端視窗。
- **感知引擎 (Python FastAPI)**：處理 PTY 管理、日誌解析與本地 LLM 推論。

```
┌───────────────────────────┐      ┌───────────────────────────┐
│     Electron/Vue UI       │      │   Python FastAPI 後端      │
│ (編排管理與終端顯示)        │ <──> │ (PTY、日誌、LLM 分析器)    │
└─────────────┬─────────────┘      └─────────────┬─────────────┘
              │                                  │
              ▼                                  ▼
      ┌──────────────────────────────────────────────────┐
      │  外部 Agent CLIs (Claude, Codex, Gemini)          │
      └──────────────────────────────────────────────────┘
```

---

## 🔒 安全與隱私

- **100% 本地**：所有運算與編排資料都留在你的機器上。
- **無遙測**：我們不追蹤你的任務或代碼。
- **YOLO 模式**：略過確認對話框需自負風險，此模式下 Agent 具備完整檔案存取權。

---

## 🗺️ 開發規劃 (Roadmap)
- [ ] Git Preflight 與自動化任務分支
- [ ] 跨代理路由引擎 (Enhanced Bus)
- [ ] Windows 與 Linux 支援
- [ ] 支援更多 Agent CLIs (如 Aider 等)

---

## 📄 授權
MIT © Navide Team
