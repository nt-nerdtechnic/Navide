# CLI Extension Guide

How to add a new CLI agent (e.g. `aider`, `continue`, `amp`) to the Agent-Team pipeline.

The codebase uses a consistent key — `agentKey` in the frontend, `agent_key` in the backend — to identify which CLI is running in a pane. Adding a new CLI means registering that key in each of the following layers.

---

## Checklist

### 1. Type definition

**`src/renderer/src/data/stages.ts:5`**

Add the new key to the `AgentKey` union type:

```ts
export type AgentKey = 'claude' | 'codex' | 'gemini' | 'your-cli'
```

---

### 2. Agent spec

**`src/renderer/src/App.vue`** — `agentSpecs` array (~line 143)

Add one entry:

```ts
{
  agentKey: 'your-cli',
  label: 'Your CLI',          // display name in dropdowns
  defaultCommand: 'your-cli', // executable name on PATH
  skipPermissionFlag: '--yes', // flag to bypass interactive prompts (YOLO mode)
  hint: 'short role description'
}
```

`skipPermissionFlag` is appended automatically when YOLO mode is enabled and the user has not provided a custom command.

---

### 3. Session startup logic

**`src/renderer/src/App.vue`** — `buildPaneOptions` function (~line 994)

Claude supports `--session-id` at launch, which lets the backend attribute log events to a specific pane precisely. Other CLIs cannot pin a session ID at launch, so they use an embedded text marker instead.

If the new CLI **does not** support `--session-id`:

```ts
const sessionMarker =
  !opts.isResume &&
  (opts.agentKey === 'codex' || opts.agentKey === 'gemini' || opts.agentKey === 'your-cli')
    ? `at-pane:${id}`
    : ''
```

If it **does** support a session-ID flag, add a branch analogous to the Claude block above it.

---

### 4. Resume command syntax

**`src/renderer/src/lib/resume-command.ts:21`**

Each CLI has its own syntax for resuming a prior conversation. Check the CLI's docs and add a branch if it differs from the default (`<cli> --resume <id>`):

```ts
// Default covers most CLIs: `your-cli --resume <id>`
// Codex is the exception: `codex resume <id>` (subcommand, not a flag)
agentKey === 'codex'
  ? `codex resume ${id}`
  : `${agentKey} --resume ${id}`
```

---

### 5. Backend whitelist

**`backend/agent_team_backend/app.py:649`**

The backend validates `agent_key` before registering a pane with the attribution layer:

```python
if agent_key in ("claude", "codex", "gemini", "your-cli"):
```

---

### 6. Log reader (new file)

**`backend/agent_team_backend/log_readers/your_cli.py`**

Each CLI writes conversation logs in a different format and location. Implement the `LogReader` abstract base class:

```python
from .base import LogReader, TokenUsage
from pathlib import Path

class YourCliLogReader(LogReader):
    vendor = "your-cli"

    def project_dirs(self) -> list[Path]:
        # Return root directories where session files live.
        # Silently skip paths that don't exist (CLI not installed).
        ...

    def session_files(self) -> list[Path]:
        # Enumerate all JSONL session files under project_dirs().
        ...

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        # Parse one file, return only NEW TokenUsage events.
        # Use seen_keys for deduplication.
        ...
```

Then register the reader in **`backend/agent_team_backend/log_readers/watcher.py`** alongside the existing readers.

The log reader is the most effort-intensive step because it requires understanding the new CLI's session file format and directory layout. Reference `claude.py`, `codex.py`, or `gemini.py` in the same directory for concrete examples.

---

### 7. Token stats display

**`src/renderer/src/components/TokenStatsPanel.vue`** (~line 79)

```ts
const VENDOR_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  'your-cli': 'Your CLI',   // add here
}

const KNOWN_VENDORS = ['claude', 'codex', 'gemini', 'your-cli', 'analyzer']
```

---

## Summary

| Layer | File | Effort |
|-------|------|--------|
| Type | `src/renderer/src/data/stages.ts` | trivial |
| Spec | `src/renderer/src/App.vue` | trivial |
| Session startup | `src/renderer/src/App.vue` | low |
| Resume syntax | `src/renderer/src/lib/resume-command.ts` | low |
| Backend whitelist | `backend/agent_team_backend/app.py` | trivial |
| Log reader | `backend/agent_team_backend/log_readers/` | medium–high |
| Token stats | `src/renderer/src/components/TokenStatsPanel.vue` | trivial |

Steps 1–5 and 7 are mechanical one-liners. Step 6 (log reader) is the only piece that requires research into the new CLI's file format.
