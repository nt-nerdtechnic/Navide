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
            "Returns up to 20 matching lines in 'file:line: snippet' format."
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
    {
        "name": "glob_files",
        "description": (
            "Find files in the workspace matching a glob pattern. "
            "Returns a list of relative file paths. "
            "Useful for finding all files of a specific type or in a specific directory. "
            "Examples: '**/*.test.ts', 'src/**/*.vue', '*.py'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern relative to the workspace root (e.g. '**/*.ts', 'src/**/*.vue').",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of files to return (default: 50, max: 200).",
                },
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "write_file",
        "description": (
            "Write complete content to a file in the workspace. "
            "Creates the file (and any parent directories) if it does not exist, "
            "or OVERWRITES it entirely if it does. "
            "Use this to create new files from scratch. "
            "For updating existing files, prefer edit_file which shows a diff. "
            "Returns the number of bytes written."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Relative path to the file within the workspace.",
                },
                "content": {
                    "type": "string",
                    "description": "Complete file content to write.",
                },
            },
            "required": ["file_path", "content"],
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
                # trim trailing UTF-8 continuation bytes — count first, slice once (max 3)
                n = 0
                while n < 3 and n < len(raw) and (raw[-1 - n] & 0xC0) == 0x80:
                    n += 1
                if n:
                    raw = raw[:-n]
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
    results: list[str] = []  # "rel/path.py:LINE: snippet"
    max_results = 20

    # Try ripgrep first — returns file:line:snippet for each match
    try:
        rg_args = ["rg", "--line-number", "--no-heading", "--color=never",
                   "--max-count=3"]
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
            for raw_line in stdout.decode(errors="replace").splitlines():
                if len(results) >= max_results:
                    break
                line = raw_line.strip()
                if not line:
                    continue
                # Make path relative for readability: /abs/root/src/foo.py:5:text → src/foo.py:5:text
                abs_prefix = str(root) + "/"
                if line.startswith(abs_prefix):
                    line = line[len(abs_prefix):]
                # Truncate very long match lines to avoid token bloat
                if len(line) > 200:
                    line = line[:197] + "…"
                results.append(line)
            if not results:
                return f"No matches found for {query!r}"
            return f"Found {len(results)} match(es):\n" + "\n".join(results)
    except (FileNotFoundError, asyncio.TimeoutError):
        pass  # rg not available or timed out — fall back to Python

    # Python fallback: glob + line-level search
    _SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"}
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
        if any(p in _SKIP_DIRS for p in candidate.parts):
            continue
        try:
            if candidate.stat().st_size > 5 * 1024 * 1024:
                continue
            rel = str(candidate.relative_to(root))
            lines = candidate.read_text(encoding="utf-8", errors="ignore").splitlines()
            for lineno, text in enumerate(lines, 1):
                if len(results) >= max_results:
                    break
                if query in text:
                    snippet = text.strip()
                    if len(snippet) > 160:
                        snippet = snippet[:157] + "…"
                    results.append(f"{rel}:{lineno}: {snippet}")
        except (OSError, ValueError):
            continue

    if not results:
        return f"No matches found for {query!r}"
    return f"Found {len(results)} match(es):\n" + "\n".join(results)


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


async def _tool_glob_files(input: dict, workspace_path: str) -> str:
    """Return files in workspace matching a glob pattern."""
    pattern = (input.get("pattern") or "").strip()
    if not pattern:
        return "Error: pattern is required"
    max_results = min(int(input.get("max_results") or 50), 200)

    root = Path(workspace_path).resolve()
    # Reject patterns that could escape the workspace
    if ".." in pattern or pattern.startswith("/"):
        return "Error: invalid pattern — must be relative and cannot contain '..'"

    try:
        matched = sorted(root.glob(pattern))
        # Filter to files only, exclude common noise dirs
        _SKIP = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", "out"}
        files = [
            str(p.relative_to(root))
            for p in matched
            if p.is_file() and not any(part in _SKIP for part in p.parts)
        ][:max_results]
        if not files:
            return f"No files found matching pattern: {pattern}"
        return f"Files matching '{pattern}' ({len(files)} result{'s' if len(files) != 1 else ''}):\n" + "\n".join(files)
    except Exception as exc:
        return f"Error: {exc}"


async def _tool_write_file(input: dict, workspace_path: str) -> str:
    """Write (create or overwrite) a file with complete content."""
    file_path = (input.get("file_path") or "").strip()
    content = input.get("content", "")

    if not file_path:
        return "Error: file_path is required"
    if not isinstance(content, str):
        return "Error: content must be a string"

    try:
        target = _safe_resolve(workspace_path, file_path)
    except ValueError as exc:
        return f"Error: {exc}"

    _WRITE_SIZE_CAP = 2 * 1024 * 1024  # 2 MB
    if len(content.encode("utf-8")) > _WRITE_SIZE_CAP:
        return f"Error: content is too large to write in one call ({len(content)} chars > 2 MB limit)"

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return f"Written {len(content.encode('utf-8'))} bytes to {file_path}"
    except OSError as exc:
        return f"Error writing file: {exc}"


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
    elif name == "glob_files":
        return await _tool_glob_files(input, workspace_path)
    elif name == "write_file":
        return await _tool_write_file(input, workspace_path)
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

    # Tools are supported for Anthropic, OpenAI-compatible providers, and Ollama
    # (Ollama supports function calling on llama3.1+, qwen2.5-coder, etc.)
    _TOOL_PROVIDERS = {"anthropic", "openai", "groq", "deepseek", "mistral", "xai", "openai_compatible", "ollama"}
    tools = TOOL_DEFS if provider in _TOOL_PROVIDERS else None

    # Work on a copy so we don't mutate the caller's list
    conversation = list(messages)

    max_iterations = max(1, min(20, int(settings.get("max_agent_iterations", 10) or 10)))
    done_meta: dict = {}  # populated from \x00DONE: sentinel (last iteration)
    total_input_tokens = 0
    total_output_tokens = 0
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
                        meta = json.loads(chunk[len("\x00DONE:"):])
                        done_meta.update(meta)
                        total_input_tokens += meta.get("input_tokens") or 0
                        total_output_tokens += meta.get("output_tokens") or 0
                    except json.JSONDecodeError as err:
                        log.warning("failed to parse done meta JSON: %s", err)
                else:
                    # Don't include thinking sentinels in the text content sent
                    # back to the API — they're display-only for the frontend.
                    if not chunk.startswith("\x00THINKING:"):
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
        "input_tokens": total_input_tokens or None,
        "output_tokens": total_output_tokens or None,
    })
