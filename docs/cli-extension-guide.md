# CLI Extension Guide

How to add a new CLI agent (e.g. `aider`, `amp`, Cursor CLI) to the Agent-Team
pipeline — the impact map (which layers a new CLI touches), the process to
follow, and a record of past integrations and candidate research.

The codebase uses a consistent key — `agentKey` in the frontend, `agent_key` in
the backend — to identify which CLI is running in a pane. Adding a new CLI
means registering that key in each of the following layers.

Last verified against the codebase: 2026-07-10.

---

## Part 1 — Impact map (checklist)

### 1. Type definition

**`src/renderer/src/data/stages.ts:5`**

Add the new key to the `AgentKey` union type:

```ts
export type AgentKey = 'claude' | 'codex' | 'antigravity' | 'your-cli'
```

### 2. Agent spec

**`src/renderer/src/App.vue`** — `agentSpecs` array (~line 280)

```ts
{
  agentKey: 'your-cli',
  label: 'Your CLI',           // display name in dropdowns
  defaultCommand: 'your-cli',  // executable name on PATH
  skipPermissionFlag: '--yes', // flag to bypass interactive prompts (YOLO mode)
  hint: 'short role description'
}
```

`skipPermissionFlag` is appended automatically when YOLO mode is enabled and
the user has not provided a custom command. The manual-spawn dropdown, Active
Agents list, and pipeline agent picker all read this array — no extra UI work.

### 3. Session startup logic

**`src/renderer/src/App.vue`** — spawn options / `sessionMarker` (~line 1247)

Claude supports `--session-id` at launch, which lets the backend attribute log
events to a specific pane precisely. CLIs without such a flag use an embedded
text marker (`at-pane:<paneId>`) that the log reader later matches to bind the
session.

If the new CLI **does not** support pinning a session id at launch, add its
key to the `sessionMarker` condition (currently codex + antigravity). If it
**does**, add a branch analogous to the Claude block.

Consequence of marker-based binding: until the marker is detected, the pane
shows the "detecting session" preparation overlay (`App.vue` ~5696) and cannot
be resumed. Antigravity is the known-worst case here — see the records below.

### 4. Resume command syntax

**`src/renderer/src/lib/resume-command.ts`**

Each CLI has its own resume syntax; add a branch. Current shapes:

```ts
// claude --resume <id>       ← flag
// codex resume <id>          ← subcommand, NOT a --flag
// agy --conversation <id>    ← different flag name
```

Also check `canResumeSession` gating in the same module.

### 5. Backend whitelist

**`backend/agent_team_backend/app.py:902`**

The backend validates `agent_key` before registering a pane with the
attribution layer:

```python
if agent_key in ("claude", "codex", "antigravity", "your-cli"):
```

### 6. Log reader (new file — the big one)

**`backend/agent_team_backend/log_readers/your_cli.py`**

Each CLI writes conversation logs in its own format and location. Implement
the `LogReader` base class (`base.py`) and register it in `watcher.py`.
Responsibilities: session file discovery, session-id detection (including
`at-pane:` marker matching for `session.detected` events), and `TokenUsage`
parsing for the token stats panel.

Reference implementations, by storage format:
- JSONL: `claude.py`, `codex.py`
- SQLite + multi-tier detection: `antigravity.py`

This is the effort-dominant step — it requires understanding the CLI's session
file format, directory layout, and how quickly a new session appears on disk.

### 7. Token stats display

**`src/renderer/src/components/TokenStatsPanel.vue:76`**

Add the vendor to `VENDOR_LABELS` and `KNOWN_VENDORS`.

### 8. Per-pane home isolation (conditional)

**`backend/agent_team_backend/codex_home.py`** (precedent)

If the CLI keeps mutable global state that breaks concurrent panes (Codex:
global `CODEX_HOME` session dir), replicate the per-pane home pattern:
`prepare` an isolated home per pane, pass it via spawn env, `find_session_home`
on resume, `cleanup` on kill. Skip this layer if the CLI tolerates concurrent
instances (Claude does).

### 9. Kickoff / settle heuristics (usually free)

Role and kickoff injection waits for the CLI's input box to become ready
(settle detection in `App.vue` ~1000–1108). The heuristics are generic
(CLI-quiet + echo tail-match), but a CLI with unusual prompt rendering may
need tuning. Verify manually with a role-assigned spawn.

### Effort summary

| Layer | File | Effort |
|-------|------|--------|
| Type | `src/renderer/src/data/stages.ts` | trivial |
| Spec | `src/renderer/src/App.vue` (agentSpecs) | trivial |
| Session startup | `src/renderer/src/App.vue` (sessionMarker) | low |
| Resume syntax | `src/renderer/src/lib/resume-command.ts` | low |
| Backend whitelist | `backend/agent_team_backend/app.py` | trivial |
| Log reader | `backend/agent_team_backend/log_readers/` | **medium–high** |
| Token stats | `src/renderer/src/components/TokenStatsPanel.vue` | trivial |
| Per-pane home | `backend/agent_team_backend/codex_home.py` pattern | none–medium (CLI-dependent) |
| Settle heuristics | `App.vue` injection path | usually none |

---

## Part 2 — Process

1. **Research first** (before any code). Answer for the candidate CLI:
   - launch command + install path; does the binary name collide with anything?
   - interactive & non-interactive modes; permission-skip / YOLO flag
   - resume: flag or subcommand? is the session id printed / discoverable?
   - can a session id be pinned at launch (`--session-id` equivalent)?
   - session storage: directory, format (JSONL/SQLite), per-project layout,
     how fast a new session file appears
   - token usage: recorded where, in what units?
   - concurrent instances: safe, or needs home isolation?
2. **Write a plan file** under `.cursor/plans/` (see project memory
   `cursor-plan-format` for filename + frontmatter schema), phased roughly:
   A) spec + types + whitelist, B) resume + session startup, C) log reader,
   D) token stats + polish, E) validation.
3. **Implement by phases**; update plan todo statuses as phases complete.
4. **Validate**: `pnpm typecheck`, `pnpm test:run`,
   `uv --project backend run pytest backend/tests` (all bare, no piping), plus
   manual spawn/resume/token-stats checks. Terminal-adjacent work must respect
   `.claude/playbook/20-pitfalls.md` (never clear scrollback, etc.).

---

## Part 3 — Integration records

### Antigravity CLI (`agy`) — added 2026-07-05

- Full integration: agentSpecs, resume via `agy --conversation <id>`,
  Stage editor support, TokenStats reader, session detection.
- Hard-won lesson: no way to pin a session id at launch → marker-based binding
  with **three-tier detection** (SQLite polling / websocket) in
  `antigravity.py`. If the marker is never detected the pane sticks on the
  "detecting session" overlay — this remains the known weak spot.

### Gemini CLI — removed 2026-07-05 (obsolete)

- Product discontinued; support fully removed (specs, reader, resume branch).
- Do not re-add. Historical implementation retrievable from git history if a
  similar JSONL-based CLI ever needs a reference.

### Cursor CLI — researched 2026-07-10 (candidate, not yet integrated)

Source: https://cursor.com/docs/cli/overview (+ installation, parameters
reference; community sources for storage internals).

| Question | Finding |
|---|---|
| Install | `curl https://cursor.com/install -fsS \| bash` → binary **`agent`** in `~/.local/bin`; auto-updates itself; `agent update` |
| Launch | `agent` (interactive) or `agent "prompt"`; non-interactive `-p/--print` with `--output-format text\|json\|stream-json` |
| YOLO flag | `-f, --force` ("force allow commands unless explicitly denied"); `--yolo` is an alias. Also `--approve-mcps`, `--trust` (headless) |
| Modes | `--mode agent\|plan\|ask`; `--model <m>`, `--list-models`; `--sandbox enabled\|disabled` |
| Resume | `agent ls` (list), `agent resume` (latest), `--continue` (= `--resume=-1`), `--resume <chatId>` |
| Pin id at launch | **Not documented** → assume marker-based binding (layer 3) needed |
| Session storage | Not in official docs; community-verified: SQLite `store.db` files under `~/.cursor/chats/` — an SQLite reader like `antigravity.py` is the likely shape |
| Chat id discovery | Printed on Ctrl-C interrupt; enumerable via `agent ls` |

Suggested spec entry when integrating:

```ts
{
  agentKey: 'cursor',
  label: 'Cursor CLI',
  defaultCommand: 'agent',
  skipPermissionFlag: '--force',
  hint: 'generalist'
}
```

Open questions to verify on a real install before writing the log reader:
1. Exact schema/layout of `~/.cursor/chats/` (per-project subdirs? id scheme?)
   and whether a freshly started session appears there immediately.
2. Whether token usage is recorded in `store.db` (needed for TokenStats).
3. Whether an injected `at-pane:` marker is persisted verbatim into the chat
   store (required for marker-based `session.detected` binding).
4. Auth flow (`agent login`?) and behavior when unauthenticated.
5. PATH collision risk: the binary name `agent` is generic — confirm
   `defaultCommand` resolution on the user's machine.
6. Concurrency: whether multiple `agent` instances share mutable global state
   (decides if a `codex_home.py`-style isolation layer is needed).
