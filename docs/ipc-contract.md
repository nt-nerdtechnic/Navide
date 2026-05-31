# Agent-Team IPC Contract

Status: v1 draft  
Date: 2026-05-26

## 1. Transport

Electron renderer communicates with Python backend over localhost WebSocket plus HTTP health endpoint.

Defaults:

- HTTP health: `GET http://127.0.0.1:{port}/health`
- WebSocket: `ws://127.0.0.1:{port}/ws`
- Backend port is assigned by Electron main process and passed to renderer.

## 2. Message Envelope

All WebSocket messages use:

```json
{
  "id": "uuid",
  "type": "message.type",
  "payload": {},
  "timestamp": "2026-05-26T00:00:00Z"
}
```

Responses use:

```json
{
  "id": "same-request-id",
  "type": "message.type.result",
  "ok": true,
  "payload": {},
  "error": null,
  "timestamp": "2026-05-26T00:00:00Z"
}
```

Errors use:

```json
{
  "id": "same-request-id",
  "type": "message.type.result",
  "ok": false,
  "payload": null,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": {}
  },
  "timestamp": "2026-05-26T00:00:00Z"
}
```

## 3. Workspace Messages

### workspace.open

Renderer -> Backend

```json
{
  "type": "workspace.open",
  "payload": {
    "path": "/Users/name/project"
  }
}
```

Backend returns workspace record and Git detection result.

### git.preflight

```json
{
  "type": "git.preflight",
  "payload": {
    "workspace_id": "uuid",
    "task_id": "uuid"
  }
}
```

Returns branch, status, protected branch flag, untracked files, and recommended action.

## 4. Task Messages

### task.create

```json
{
  "type": "task.create",
  "payload": {
    "workspace_id": "uuid",
    "title": "Fix login bug",
    "prompt": "..."
  }
}
```

### task.start

Starts Git preflight, task branch/snapshot, terminal sessions, and initial orchestration.

```json
{
  "type": "task.start",
  "payload": {
    "task_id": "uuid",
    "start_agent": "claude"
  }
}
```

## 5. Terminal Messages

### terminal.create

```json
{
  "type": "terminal.create",
  "payload": {
    "task_id": "uuid",
    "pane_id": "claude",
    "agent_key": "claude",
    "command": "claude",
    "cwd": "/Users/name/project",
    "cols": 100,
    "rows": 30
  }
}
```

### terminal.input

```json
{
  "type": "terminal.input",
  "payload": {
    "terminal_session_id": "uuid",
    "data": "hello\\n"
  }
}
```

### terminal.resize

```json
{
  "type": "terminal.resize",
  "payload": {
    "terminal_session_id": "uuid",
    "cols": 120,
    "rows": 40
  }
}
```

### terminal.output

Backend -> Renderer event

```json
{
  "type": "terminal.output",
  "payload": {
    "terminal_session_id": "uuid",
    "sequence": 42,
    "data": "output text",
    "stream": "stdout"
  }
}
```

## 6. Agent Messages

### agent.launch

```json
{
  "type": "agent.launch",
  "payload": {
    "task_id": "uuid",
    "agent_key": "codex",
    "pane_id": "codex"
  }
}
```

### agent.send_prompt

```json
{
  "type": "agent.send_prompt",
  "payload": {
    "agent_key": "codex",
    "task_id": "uuid",
    "prompt": "..."
  }
}
```

### agent.interrupt

Sends Ctrl-C.

```json
{
  "type": "agent.interrupt",
  "payload": {
    "task_id": "uuid",
    "agent_key": "codex"
  }
}
```

### agent.kill

Kills child process/process group.

```json
{
  "type": "agent.kill",
  "payload": {
    "task_id": "uuid",
    "agent_key": "codex"
  }
}
```

## 7. Orchestration Messages

### orchestration.start

```json
{
  "type": "orchestration.start",
  "payload": {
    "task_id": "uuid",
    "start_agent": "claude"
  }
}
```

### orchestration.pause

```json
{
  "type": "orchestration.pause",
  "payload": {
    "task_id": "uuid"
  }
}
```

### orchestration.resume

```json
{
  "type": "orchestration.resume",
  "payload": {
    "task_id": "uuid"
  }
}
```

### orchestration.stop

Stop Orchestration: stop route engine, keep terminals.

```json
{
  "type": "orchestration.stop",
  "payload": {
    "task_id": "uuid",
    "reason": "user"
  }
}
```

### orchestration.kill_task

```json
{
  "type": "orchestration.kill_task",
  "payload": {
    "task_id": "uuid",
    "reason": "user"
  }
}
```

### orchestration.route_message

Backend -> Renderer event

```json
{
  "type": "orchestration.route_message",
  "payload": {
    "route_message_id": "uuid",
    "round_number": 1,
    "source_agent_key": "claude",
    "target_agent_key": "codex",
    "status": "sent",
    "content": "[Handoff]..."
  }
}
```

## 8. Git Messages

### git.status

```json
{
  "type": "git.status",
  "payload": {
    "workspace_id": "uuid"
  }
}
```

### git.snapshot.create

```json
{
  "type": "git.snapshot.create",
  "payload": {
    "task_id": "uuid",
    "snapshot_type": "pre_task"
  }
}
```

### git.commit.confirmed

```json
{
  "type": "git.commit.confirmed",
  "payload": {
    "task_id": "uuid",
    "files": ["path/to/file"],
    "message": "Implement terminal grid"
  }
}
```

## 9. Settings Messages

### settings.get

```json
{
  "type": "settings.get",
  "payload": {}
}
```

### settings.update

```json
{
  "type": "settings.update",
  "payload": {
    "agent_config": {
      "claude": { "executable": "claude", "args": [] }
    }
  }
}
```

