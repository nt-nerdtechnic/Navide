# CLI Local Log Formats (for token-log-readers)

研究產出：三家 CLI 都在本地寫 conversation log，且都含真實 token 數。

## Claude Code

**路徑**：依序 fallback
1. `$CLAUDE_CONFIG_DIR/projects`
2. `~/.config/claude/projects`
3. `~/.claude/projects`

**檔案結構**：`{project_dir}/{cwd-hash}/{session-uuid}.jsonl`，每個 cwd 一個資料夾、每次 spawn 一個 jsonl。

**cwd-hash 規則**：絕對 cwd 中所有 `/` 換成 `-`。
- `/Users/example/Desktop/Agent-Team` → `-Users-example-Desktop-Agent-Team`

**事件 filter**：`line.type == "assistant"` 且 `message.usage` 存在。

**Token 欄位**：`message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`

**Dedup key**：`message.id + (requestId or "")`（streaming chunks 會重複 append 累計值）

**範例（真實格式）**：
```json
{
  "type": "assistant",
  "sessionId": "943c4688-2197-4217-84ff-f2f8419e0e16",
  "requestId": "req_abc",
  "message": {
    "id": "msg_013fg6dcQpXgQdvjvwoaL2L2",
    "model": "claude-opus-4-7",
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 567,
      "cache_read_input_tokens": 89,
      "cache_creation_input_tokens": 12
    }
  }
}
```

**統計規則**：`input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`（cache 折入 input，per user decision）

---

## Codex CLI

**路徑**：`~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{ISO-timestamp}-{session-uuid}.jsonl`

**事件 filter**：`line.type == "event_msg"` 且 `payload.type == "token_count"`

**Token 欄位**：`payload.info.total_token_usage.{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`

**Dedup**：以 file path + line offset；token_count 是**累計值**，每次新事件取 max - prev 為 delta（同 vendor_parsers 的 cumulative 模式）

**cwd 解析**：找同檔案中 `type == "session_meta"` 那行，`payload.cwd` 就是 cwd。

**Bonus — rate_limits**：同一個 event 還附 quota window，未來可做 quota probe：
```json
"rate_limits": {
  "limit_id": "codex",
  "primary": {"used_percent": 17.0, "window_minutes": 300, "resets_at": 1779869684},
  "secondary": {"used_percent": 19.0, "window_minutes": 10080, "resets_at": 1780363769},
  "plan_type": "plus"
}
```

**範例**：
```json
{
  "timestamp": "2026-05-27T06:57:41.511Z",
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "total_token_usage": {
        "input_tokens": 33023,
        "cached_input_tokens": 3456,
        "output_tokens": 2068,
        "reasoning_output_tokens": 616,
        "total_tokens": 35091
      },
      "model_context_window": 258400
    }
  }
}
```

**統計規則**：`input = input_tokens + cached_input_tokens`、`output = output_tokens + reasoning_output_tokens`

---

## Gemini CLI

**路徑**：`~/.gemini/tmp/{project-name}/chats/session-{ISO-timestamp}-{uuid-prefix}.jsonl`

**事件 filter**：`line.type == "gemini"`（assistant turn）

**Token 欄位**：`tokens.{input, output, cached, thoughts, tool, total}`
- `cached` = cache hit input
- `thoughts` = thinking tokens (extended thinking)
- `tool` = tool-call tokens

**Dedup key**：`id`（每筆事件有 uuid）

**cwd 解析**：path 中的 `{project-name}` 對應 `~/.gemini/projects.json`（裡面有完整 cwd 對應）。

**範例**：
```json
{
  "id": "b5a6177c-e8ca-4e75-b570-33eba7d10983",
  "timestamp": "2026-04-27T08:05:52.513Z",
  "type": "gemini",
  "tokens": {
    "input": 8630,
    "output": 107,
    "cached": 0,
    "thoughts": 79,
    "tool": 0,
    "total": 8816
  },
  "model": "gemini-3-flash-preview"
}
```

**統計規則**：`input = tokens.input + tokens.cached`、`output = tokens.output + tokens.thoughts + tokens.tool`

---

## 共通設計含義

1. 三家**都用 JSONL** — 同一個 reader 框架可重用解析骨架，只差 filter / field 映射。
2. 三家**都有 dedup 需求**（streaming chunks 或 cumulative events）— `seen_keys: set[str]` per file。
3. **Cache tokens 全折入 input** — UI 不變、數字精準（per user）。
4. **Attribution（log session ↔ Agent-Team pane）**：
   - Claude/Codex 可從 cwd 反查；Gemini 需要 `~/.gemini/projects.json` lookup
   - 仍需 baseline-files-at-spawn 策略處理「同 cwd 多 pane 並發」
5. **Codex bonus**：免費附 rate_limits — Phase 9（未來）可做 quota probe
