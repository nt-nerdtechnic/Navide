"""AI Chat tool registry and agent loop."""

from __future__ import annotations

import asyncio
import difflib
import json
import logging
import shlex
from pathlib import Path

from .ai_chat_service import stream_chat

log = logging.getLogger("agent_team_backend.ai_chat_tools")

# ── Command approval registry ────────────────────────────────────────────────
# Maps f"{session_id}:{tool_id}" → Future[bool] (True=approved, False=rejected)
_pending_approvals: dict[str, "asyncio.Future[bool]"] = {}


def approve_command(session_id: str, tool_id: str, *, approved: bool) -> None:
    """Resolve a pending command approval Future from a WebSocket handler."""
    key = f"{session_id}:{tool_id}"
    fut = _pending_approvals.get(key)
    if fut is not None and not fut.done():
        fut.set_result(approved)

# ── Tool definitions (Anthropic schema) ──────────────────────────────────────

TOOL_DEFS = [
    {
        "name": "read_file",
        "description": (
            "Read the contents of a file in the workspace. "
            "Returns up to 500 lines; truncates with a notice if longer."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Relative path to the file within the workspace.",
                }
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "search_files",
        "description": (
            "Search for a text pattern across files in the workspace. "
            "Uses ripgrep if available, otherwise falls back to Python glob+read. "
            "Returns up to 20 matching results."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The text or pattern to search for.",
                },
                "file_pattern": {
                    "type": "string",
                    "description": "Optional glob pattern to restrict which files are searched (e.g. '*.py').",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "edit_file",
        "description": (
            "Propose an edit to a file by supplying new content. "
            "Does NOT write to disk immediately — returns a unified diff. "
            "The user must accept or discard the change in the UI."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Relative path to the file to edit.",
                },
                "new_content": {
                    "type": "string",
                    "description": "The complete new content for the file.",
                },
            },
            "required": ["file_path", "new_content"],
        },
    },
    {
        "name": "run_command",
        "description": (
            "Propose a shell command to run in the workspace directory. "
            "The user must approve the command before it executes. "
            "Timeout is 15 seconds after approval."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The command to run.",
                },
                "cwd": {
                    "type": "string",
                    "description": "Optional working directory relative to the workspace root.",
                },
            },
            "required": ["command"],
        },
    },
    {
        "name": "list_directory",
        "description": (
            "List files and subdirectories in the workspace. "
            "Shows a tree up to the specified depth (max 3). "
            "Use this to understand the project structure before reading files."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative path within the workspace to list (default: '.' = root).",
                },
                "depth": {
                    "type": "integer",
                    "description": "Maximum depth to recurse (1-3, default 2).",
                },
            },
            "required": [],
        },
    },
]

# ── Path safety helper ────────────────────────────────────────────────────────

def _safe_resolve(workspace_path: str, rel_path: str) -> Path:
    """Resolve rel_path under workspace_path, raising ValueError on escape."""
    root = Path(workspace_path).resolve()
    rel = (rel_path or "").strip().replace("\\", "/").lstrip("/")
    target = (root / rel).resolve()
    if target != root and not str(target).startswith(str(root) + "/"):
        raise ValueError(f"path escapes workspace: {rel_path!r}")
    return target


# ── Tool implementations ──────────────────────────────────────────────────────

async def _tool_list_directory(input: dict, workspace_path: str) -> str:
    rel_path = (input.get("path") or ".").strip() or "."
    depth = max(1, min(int(input.get("depth") or 2), 3))

    try:
        root = _safe_resolve(workspace_path, "" if rel_path == "." else rel_path)
    except ValueError as exc:
        return f"Error: {exc}"

    if not root.is_dir():
        return f"Error: not a directory: {rel_path}"

    lines: list[str] = []

    # Common dirs/files to skip for clarity
    _SKIP = {
        ".git", "__pycache__", ".venv", "venv", "node_modules",
        ".mypy_cache", ".pytest_cache", "dist", "build", ".DS_Store",
    }

    def _walk(path: Path, current_depth: int, prefix: str) -> None:
        if current_depth > depth:
            return
        try:
            entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except PermissionError:
            return
        visible = [e for e in entries if e.name not in _SKIP]
        for i, entry in enumerate(visible):
            is_last = i == len(visible) - 1
            connector = "└── " if is_last else "├── "
            child_prefix = prefix + ("    " if is_last else "│   ")
            suffix = "/" if entry.is_dir() else ""
            lines.append(f"{prefix}{connector}{entry.name}{suffix}")
            if entry.is_dir():
                _walk(entry, current_depth + 1, child_prefix)

    lines.append(f"{root.name}/")
    _walk(root, 1, "")

    if len(lines) > 200:
        lines = lines[:200]
        lines.append("... (truncated)")

    return "\n".join(lines)


async def _tool_read_file(input: dict, workspace_path: str) -> str:
    file_path = input.get("file_path", "")
    try:
        target = _safe_resolve(workspace_path, file_path)
    except ValueError as exc:
        return f"Error: {exc}"

    if not target.is_file():
        return f"Error: file not found: {file_path}"

    _BYTE_CAP = 5 * 1024 * 1024  # 5 MB — read limit before line-based truncation
    try:
        size = target.stat().st_size
        if size > _BYTE_CAP:
            with target.open("rb") as fh:
                raw = fh.read(_BYTE_CAP)
            content = raw.decode("utf-8", errors="replace")
            content += f"\n\n[Truncated: file is {size // 1024} KB; showing first 5 MB]"
            return content
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return "Error: binary or non-UTF-8 file — cannot read as text"
    except OSError as exc:
        return f"Error reading file: {exc}"

    lines = content.splitlines(keepends=True)
    max_lines = 500
    if len(lines) <= max_lines:
        return content
    truncated = "".join(lines[:max_lines])
    return truncated + f"\n\n[Truncated: showing first {max_lines} of {len(lines)} lines]"


async def _tool_search_files(input: dict, workspace_path: str) -> str:
    query = input.get("query", "")
    file_pattern = input.get("file_pattern", "") or "*"

    if not query:
        return "Error: query is required"

    root = Path(workspace_path).resolve()
    results: list[str] = []
    max_results = 20

    # Try ripgrep first
    try:
        rg_args = ["rg", "--line-number", "--no-heading", "--color=never",
                   "--max-count=1", "-l"]
        if file_pattern and file_pattern != "*":
            rg_args += ["--glob", file_pattern]
        rg_args += [query, str(root)]
        proc = await asyncio.create_subprocess_exec(
            *rg_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(root),
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10.0)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            raise
        if proc.returncode in (0, 1):  # 0=found, 1=no match
            matching_files = stdout.decode(errors="replace").splitlines()
            for fpath in matching_files[:max_results]:
                results.append(fpath.strip())
            if not results:
                return f"No matches found for {query!r}"
            summary_lines = [f"Found matches in {len(results)} file(s):"]
            summary_lines.extend(results)
            return "\n".join(summary_lines)
    except (FileNotFoundError, asyncio.TimeoutError):
        pass  # rg not available or timed out — fall back to Python

    # Python fallback: glob + read
    import fnmatch
    pattern = file_pattern if file_pattern != "*" else "**/*"
    try:
        candidates = list(root.glob(pattern))
    except Exception:
        candidates = list(root.glob("**/*"))

    for candidate in candidates:
        if len(results) >= max_results:
            break
        if not candidate.is_file():
            continue
        # Skip binary-ish / noise dirs
        parts = candidate.parts
        if any(p in {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"} for p in parts):
            continue
        try:
            if candidate.stat().st_size > 5 * 1024 * 1024:
                continue
            text = candidate.read_text(encoding="utf-8", errors="ignore")
            if query in text:
                results.append(str(candidate.relative_to(root)))
        except OSError:
            continue

    if not results:
        return f"No matches found for {query!r}"
    summary_lines = [f"Found matches in {len(results)} file(s):"]
    summary_lines.extend(results)
    return "\n".join(summary_lines)


async def _tool_edit_file(input: dict, workspace_path: str) -> str:
    file_path = input.get("file_path", "")
    new_content = input.get("new_content", "")

    try:
        target = _safe_resolve(workspace_path, file_path)
    except ValueError as exc:
        return f"Error: {exc}"

    # Read existing content for diff; reject files too large to show a meaningful diff
    _EDIT_SIZE_CAP = 2 * 1024 * 1024  # 2 MB
    if target.is_file():
        try:
            size = target.stat().st_size
            if size > _EDIT_SIZE_CAP:
                return f"Error: existing file is too large to edit safely ({size // 1024} KB > 2 MB). " \
                       "Read the file in sections and rewrite it with a targeted tool call instead."
            old_content = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            old_content = ""
    else:
        old_content = ""

    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)
    diff = difflib.unified_diff(
        old_lines,
        new_lines,
        fromfile=f"a/{file_path}",
        tofile=f"b/{file_path}",
    )
    diff_str = "".join(diff)

    return json.dumps({
        "diff": diff_str,
        "file_path": file_path,
        "new_content": new_content,
    })


async def _execute_command(command: str, cwd_rel: str, workspace_path: str) -> str:
    """Actually run a pre-approved command. Called only after user confirms."""
    if cwd_rel:
        try:
            cwd_path = _safe_resolve(workspace_path, cwd_rel)
        except ValueError as exc:
            return f"Error: {exc}"
        if not cwd_path.is_dir():
            return f"Error: cwd not found: {cwd_rel}"
    else:
        cwd_path = Path(workspace_path).resolve()

    try:
        args = shlex.split(command)
    except ValueError as exc:
        return f"Error parsing command: {exc}"

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(cwd_path),
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15.0)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            return "Error: command timed out after 15 seconds"
    except FileNotFoundError:
        return f"Error: command not found: {args[0]!r}"
    except OSError as exc:
        return f"Error running command: {exc}"

    output = stdout.decode(errors="replace")
    max_chars = 2000
    if len(output) > max_chars:
        output = output[:max_chars] + f"\n[Truncated: output exceeded {max_chars} characters]"
    return f"Exit code: {proc.returncode}\n{output}"


async def _run_command_with_approval(
    input: dict,
    workspace_path: str,
    session_id: str,
    tool_id: str,
    emit,
) -> str:
    """Emit a command proposal, wait for user approval, then execute if approved."""
    command = input.get("command", "").strip()
    cwd_rel = (input.get("cwd") or "").strip()

    if not command:
        return "Error: command is required"

    # Validate cwd path before proposing (no execution yet)
    if cwd_rel:
        try:
            _safe_resolve(workspace_path, cwd_rel)
        except ValueError as exc:
            return f"Error: {exc}"

    await emit("ai.chat.command_proposal", {
        "session_id": session_id,
        "tool_id": tool_id,
        "command": command,
        "cwd": cwd_rel,
    })

    key = f"{session_id}:{tool_id}"
    loop = asyncio.get_running_loop()
    fut: asyncio.Future[bool] = loop.create_future()
    _pending_approvals[key] = fut
    try:
        approved = await asyncio.wait_for(asyncio.shield(fut), timeout=300.0)
    except asyncio.TimeoutError:
        return "Command proposal timed out — user did not respond within 5 minutes."
    finally:
        _pending_approvals.pop(key, None)

    if not approved:
        return "Command rejected by user."

    return await _execute_command(command, cwd_rel, workspace_path)


# ── Dispatch (non-command tools only) ────────────────────────────────────────

async def execute_tool(name: str, input: dict, workspace_path: str) -> str:
    """Dispatch a non-interactive tool call and return the result string."""
    if name == "read_file":
        return await _tool_read_file(input, workspace_path)
    elif name == "search_files":
        return await _tool_search_files(input, workspace_path)
    elif name == "edit_file":
        return await _tool_edit_file(input, workspace_path)
    elif name == "list_directory":
        return await _tool_list_directory(input, workspace_path)
    else:
        return f"Error: unknown tool: {name!r}"


# ── Agent loop ────────────────────────────────────────────────────────────────

async def run_agent_loop(
    settings: dict,
    messages: list[dict],
    workspace_path: str,
    session_id: str,
    emit,  # async callable(event_type: str, data: dict)
) -> None:
    """Run the agentic loop until the model stops requesting tool calls."""
    system = settings.get("system_prompt", "You are a helpful AI coding assistant.")
    max_tokens = int(settings.get("max_tokens", 4096))
    provider = settings.get("provider", "ollama")

    # Only pass tools for Anthropic
    tools = TOOL_DEFS if provider == "anthropic" else None

    # Work on a copy so we don't mutate the caller's list
    conversation = list(messages)

    max_iterations = 10  # guard against infinite loops
    done_meta: dict = {}  # populated from \x00DONE: sentinel
    for _iteration in range(max_iterations):
        assistant_text_parts: list[str] = []
        tool_calls: list[dict] = []  # {"id": ..., "name": ..., "input": ...}

        try:
            async for chunk in stream_chat(settings, conversation, system, max_tokens, tools):
                if chunk.startswith("\x00TOOL:"):
                    raw = chunk[len("\x00TOOL:"):]
                    try:
                        tool_call = json.loads(raw)
                        tool_calls.append(tool_call)
                        await emit("ai.chat.tool_call", {
                            "session_id": session_id,
                            "tool_name": tool_call.get("name"),
                            "tool_input": tool_call.get("input"),
                            "tool_id": tool_call.get("id"),
                        })
                    except json.JSONDecodeError as err:
                        log.warning("failed to parse tool call JSON: %s", err)
                elif chunk.startswith("\x00DONE:"):
                    try:
                        done_meta.update(json.loads(chunk[len("\x00DONE:"):]))
                    except json.JSONDecodeError as err:
                        log.warning("failed to parse done meta JSON: %s", err)
                else:
                    assistant_text_parts.append(chunk)
                    await emit("ai.chat.chunk", {
                        "session_id": session_id,
                        "text": chunk,
                    })
        except Exception as err:
            log.exception("stream_chat error in agent loop")
            await emit("ai.chat.error", {
                "session_id": session_id,
                "message": str(err),
            })
            return

        # No tool calls → conversation turn is complete
        if not tool_calls:
            break

        # Append the assistant turn (text + tool use) to conversation
        assistant_content: list[dict] = []
        full_text = "".join(assistant_text_parts)
        if full_text:
            assistant_content.append({"type": "text", "text": full_text})
        for tc in tool_calls:
            assistant_content.append({
                "type": "tool_use",
                "id": tc["id"],
                "name": tc["name"],
                "input": tc["input"],
            })
        conversation.append({"role": "assistant", "content": assistant_content})

        # Execute each tool and collect results.
        # run_command goes through the approval flow; all others execute directly.
        tool_results: list[dict] = []
        for tc in tool_calls:
            try:
                if tc["name"] == "run_command":
                    result_str = await _run_command_with_approval(
                        tc.get("input") or {}, workspace_path, session_id, tc["id"], emit
                    )
                else:
                    result_str = await execute_tool(tc["name"], tc.get("input") or {}, workspace_path)
            except Exception:
                log.exception("tool %r raised unexpectedly", tc.get("name"))
                result_str = "Error: tool execution failed. Check server logs for details."
            await emit("ai.chat.tool_result", {
                "session_id": session_id,
                "tool_id": tc["id"],
                "tool_name": tc["name"],
                "result": result_str,
            })
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tc["id"],
                "content": result_str,
            })

        # Append tool results as a user turn
        conversation.append({"role": "user", "content": tool_results})

    await emit("ai.chat.done", {
        "session_id": session_id,
        "model": done_meta.get("model"),
        "input_tokens": done_meta.get("input_tokens"),
        "output_tokens": done_meta.get("output_tokens"),
    })
