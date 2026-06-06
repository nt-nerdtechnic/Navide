# Security Policy

<!-- 安全政策 -->

## Supported Versions / 支援版本

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

---

## Reporting a Vulnerability / 回報漏洞

**Please do not open a public GitHub Issue for security vulnerabilities.**

> **請勿在 GitHub Issue 公開回報安全漏洞。**

Email **nt.nerdtechnic@gmail.com** with the subject line:

```
[Navide (Agent-Team)] Security Vulnerability
```

Please include:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fix (optional)

You will receive an acknowledgement within **48 hours** and a status update within **7 days**.

> 請以郵件聯絡 **nt.nerdtechnic@gmail.com**，主旨：`[Navide (Agent-Team)] Security Vulnerability`。  
> 請附上漏洞描述、重現步驟、潛在影響，以及建議修法（選填）。  
> 我們會在 **48 小時**內確認收信，**7 天**內告知處理進度。

---

## Security Design / 安全設計說明

Navide (Agent-Team) runs entirely on your local machine:

- **No external server** — no data is transmitted to any remote service
- **No telemetry** — no usage data is collected
- **No API key storage** — all CLI credentials stay in each tool's own config (`~/.claude/`, `~/.codex/`, etc.)
- **Claude Code hooks** are installed into `~/.claude/settings.json` in a merge-safe way; the original file is backed up as `.pre-agent-team.bak`
- **YOLO Mode** grants agents unrestricted filesystem access — only use it in workspaces you trust

> Navide (Agent-Team) 完全在本機執行，不傳送任何遙測資料，不需要帳號，不儲存 API key。  
> YOLO Mode 下 agent 擁有完整檔案系統讀寫權，僅在信任的 workspace 下使用。

### Known Limitations / 已知限制

- Secret scrubbing before cross-agent context handoff is **not yet implemented** (planned)
- Workspace sandboxing is **not yet implemented** — agents run with full user-level permissions

> 跨 agent 傳遞前的 secret 自動抹除與 workspace 沙盒隔離功能尚未實作（規劃中）。
