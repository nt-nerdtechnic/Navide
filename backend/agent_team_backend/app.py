from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from . import __version__
from .analyzer import DEFAULT_MODEL as ANALYZER_DEFAULT_MODEL
from .analyzer import (
    classify as _llama_classify,
    health as _llama_health,
    list_models as _llama_list_models,
    auto_answer as _llama_auto_answer,
    benchmark as _llama_benchmark,
)
from .analyzer_ollama import (
    classify as _ollama_classify,
    health as _ollama_health,
    list_models as _ollama_list_models,
    auto_answer as _ollama_auto_answer,
    benchmark as _ollama_benchmark,
    pull_model as _ollama_pull_model,
    delete_model as _ollama_delete_model,
)
from .analyzer_settings import AnalyzerSettingsStore
from .ai_chat_settings import AIChatSettingsStore
from .applog import backend_log_path, backend_port_file
from .claude_hooks import install_hooks as install_claude_hooks
from .ipc import make_error, make_event, make_response
from .log_readers import (
    ActivityEvent,
    ClaudeLogReader,
    CodexLogReader,
    GeminiLogReader,
    LogWatcher,
    TokenUsage,
)
from .log_readers.attribution import Attribution
from .doc_injector import fetch_stage_docs
from .mcp_manager import MCPManager
from .mcp_settings import MCPServersDocument, MCPSettingsStore
from .projects import ProjectStore
from .recent_workspaces import RecentWorkspacesStore
from .roles_store import RolesStore
from .stages_store import StagesStore
from .terminals import TerminalService
from .tokens_store import TokensStore
from .history_store import HistoryStore
from . import git_service
from . import fs_service
from . import search_service
from . import editor_service
from . import onboarding_deps
from .git_watcher import GitWatcher

log = logging.getLogger("agent_team_backend")

STARTED_AT = datetime.now(timezone.utc).isoformat()

app = FastAPI(title="agent-team-backend", version=__version__)

project_store = ProjectStore()
recent_workspaces_store = RecentWorkspacesStore()
roles_store = RolesStore()
stages_store = StagesStore()
tokens_store = TokensStore()
history_store = HistoryStore()
mcp_manager = MCPManager()
mcp_settings_store = MCPSettingsStore()
analyzer_settings_store = AnalyzerSettingsStore()
ai_chat_settings_store = AIChatSettingsStore()

# ─── Analyzer backend routing ────────────────────────────────────────────────

def _az_settings() -> dict:
    return analyzer_settings_store.get()

def _az_is_ollama() -> bool:
    return _az_settings().get("backend") == "ollama"

def _az_base_url() -> str:
    return _az_settings().get("ollama_base_url", "http://localhost:11434")

def _az_llama_cli() -> str | None:
    v = _az_settings().get("llama_cli", "").strip()
    return v or None

def _az_gguf_path() -> str | None:
    v = _az_settings().get("gguf_path", "").strip()
    return v or None

async def analyzer_health() -> dict:
    if _az_is_ollama():
        return await _ollama_health(_az_base_url())
    return await _llama_health(llama_cli_override=_az_llama_cli(), gguf_path_override=_az_gguf_path())

async def analyzer_list_models() -> list:
    if _az_is_ollama():
        return await _ollama_list_models(_az_base_url())
    return await _llama_list_models()

async def analyzer_classify(text: str, model: str) -> dict:
    if _az_is_ollama():
        return await _ollama_classify(text, model=model, base_url=_az_base_url())
    return await _llama_classify(text, model=model,
                                 llama_cli_override=_az_llama_cli(),
                                 gguf_path_override=_az_gguf_path())

async def analyzer_auto_answer(questions: list, task: str, stage_title: str, model: str) -> dict:
    if _az_is_ollama():
        return await _ollama_auto_answer(questions, task, stage_title, model=model, base_url=_az_base_url())
    return await _llama_auto_answer(questions, task, stage_title, model=model,
                                    llama_cli_override=_az_llama_cli(),
                                    gguf_path_override=_az_gguf_path())

async def analyzer_benchmark(progress_cb=None) -> list:
    if _az_is_ollama():
        return await _ollama_benchmark(_az_base_url(), progress_cb=progress_cb)
    return await _llama_benchmark(progress_cb=progress_cb)

# Log readers: one per vendor. Attribution maps log session files to panes.
_readers = [ClaudeLogReader(), CodexLogReader(), GeminiLogReader()]
attribution = Attribution(_readers)
_log_watcher: LogWatcher | None = None
_git_watcher: GitWatcher | None = None


# Module-level registry of all currently-connected WebSocket sessions so that
# state changes (e.g. roles edits) can be broadcast to every window the user
# has open (main + role manager + future windows).
_SESSIONS: set["Session"] = set()


async def broadcast(event: dict[str, Any]) -> None:
    """Fire-and-forget send to every connected session."""
    for session in list(_SESSIONS):
        try:
            await session.websocket.send_json(event)
        except Exception as err:  # noqa: BLE001
            log.warning("broadcast send failed: %s", err)


class Session:
    """Per-WebSocket-connection state."""

    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        # Token attribution now happens via log_readers (background log scan),
        # NOT via PTY output. TerminalService runs without a token sink.
        self.terminals = TerminalService(emit=self._send_event)
        # Track background tasks so they can be cancelled on disconnect.
        self._chat_tasks: set[asyncio.Task] = set()
        self._review_tasks: set[asyncio.Task] = set()

    async def _send_event(self, event: dict[str, Any]) -> None:
        try:
            await self.websocket.send_json(event)
        except Exception as err:  # noqa: BLE001
            log.warning("send_event failed: %s", err)


async def _broadcast_git_changed(ws_path: str) -> None:
    """GitWatcher sink: a repo's working tree / .git changed on disk."""
    await broadcast(make_event("git.changed", {"workspace_path": ws_path}))


async def _maybe_announce_session(usage: TokenUsage) -> None:
    """Codex/Gemini: when a session file is first matched to its pane by marker,
    tell the frontend so it can persist the id for resume-on-restart."""
    bound = await asyncio.to_thread(attribution.maybe_bind_by_marker, usage)
    if not bound:
        return
    pane_id, resume_id = bound
    _, ws_path, _ = attribution.pane_for_session(usage.session_id)
    await broadcast(make_event("session.detected", {
        "vendor": usage.vendor,
        "pane_id": pane_id,
        "session_id": resume_id,  # the id `<cli> resume <id>` actually needs
        "workspace_path": ws_path or usage.cwd,
    }))


async def _on_session_file(vendor: str, path: Path) -> None:
    """Watcher session sink: a Codex/Gemini session file changed. Attempt marker
    binding directly off the file (decoupled from token parsing, so it works for
    session-file formats the token reader doesn't understand)."""
    usage = TokenUsage(
        vendor=vendor, input_tokens=0, output_tokens=0,
        cwd="", session_id=path.stem, file_path=str(path), dedup_key="",
    )
    await _maybe_announce_session(usage)


async def _on_log_activity(event: ActivityEvent) -> None:
    """Sink for agent-activity events (agent_active / turn_complete).

    Broadcasts to all sessions so the frontend watcher can use these signals
    as supplemental "agent still working" / "turn ended" indicators that
    don't depend on TUI buffer scanning.
    """
    try:
        # Attribution was designed for TokenUsage but only reads vendor/cwd/
        # file_path/session_id. Wrap as a placeholder so we get pane mapping.
        fake_usage = TokenUsage(
            vendor=event.vendor, input_tokens=0, output_tokens=0,
            cwd=event.cwd, session_id=event.session_id,
            file_path=event.file_path, dedup_key=event.dedup_key,
            timestamp=event.timestamp,
        )
        attributed = attribution.attribute(fake_usage)
        if attributed.workspace_path is None:
            # External session — skip; no pane to deliver to.
            return
        await broadcast(make_event("agent.activity", {
            "vendor": event.vendor,
            "event_type": event.event_type,
            "workspace_path": attributed.workspace_path,
            "pane_id": attributed.pane_id or "",
            "stage_id": attributed.stage_id or "",
            "session_id": event.session_id,
            "cwd": event.cwd,
            "timestamp": event.timestamp,
            "detail": event.detail,
        }))
    except Exception as err:  # noqa: BLE001
        log.warning("activity sink failed: %s", err)


async def _on_log_token_usage(usage: TokenUsage) -> None:
    """Sink for token events from CLI log files.

    Drops events not associated with any registered Agent-Team workspace so
    the All-time tally only counts usage in workspaces the user has actually
    opened in Agent-Team. Passes the event's dedup_key to tokens_store so
    re-rescans after workspace registration don't double-count.
    """
    try:
        attributed = attribution.attribute(usage)
        if attributed.workspace_path is None:
            # External session — outside any registered workspace. Skip silently.
            return
        # Namespace the dedup key by vendor + file_path so collisions across
        # vendors (unlikely but possible) can't masquerade as the same event.
        composite_key = f"{usage.vendor}::{usage.file_path}::{usage.dedup_key}"
        tokens_store.record(
            attributed.workspace_path,
            source="cli",
            vendor=usage.vendor,
            agent_key=usage.vendor,
            # Prefer stable slot_key as the by_pane bucket so data survives
            # frontend restarts; fall back to ephemeral pane_id for manual panes.
            pane_id=attributed.slot_key or attributed.pane_id,
            stage_id=attributed.stage_id,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            dedup_key=composite_key,
        )
        await broadcast(
            make_event("tokens.changed", tokens_store.snapshot(attributed.workspace_path))
        )
    except Exception as err:  # noqa: BLE001
        log.warning("log token sink failed: %s", err)


def _stable_pane_key(metadata: dict, fallback: str) -> str:
    """Return a key for tokens_store.by_pane that survives frontend restarts.

    Pipeline panes use "<stage_id>:<slot_label>" (e.g. "01:architect") so the
    key is deterministic across sessions. Manual panes (no stage/slot) fall
    back to the ephemeral pane UUID — they don't persist across restarts anyway.
    """
    stage = str(metadata.get("stage_id") or metadata.get("stageId") or "").strip()
    slot  = str(metadata.get("slot_label") or "").strip()
    if stage and slot:
        return f"{stage}:{slot}"
    if stage:
        return stage
    return fallback


def _register_workspace_and_backfill(workspace_path: str) -> None:
    """Idempotent: associate the workspace with its CLI folders AND trigger a
    one-shot LogWatcher re-rescan so historic sessions in those folders get
    retroactively counted into the workspace's cumulative."""
    if not workspace_path:
        return
    is_new = workspace_path not in attribution.known_workspaces()
    attribution.register_workspace(workspace_path)
    if is_new and _log_watcher is not None:
        # New association → previously-parsed files now have a workspace and
        # need re-emit so cumulative populates. tokens_store dedup makes
        # already-counted events safe. Scope to THIS workspace so we don't
        # re-parse the entire (multi-GB) Claude history and stall the loop.
        _log_watcher.force_rescan(workspace_path)


@app.on_event("startup")
async def _start_log_watcher() -> None:
    global _log_watcher
    _log_watcher = LogWatcher(
        sink=_on_log_token_usage,
        activity_sink=_on_log_activity,
        session_sink=_on_session_file,
    )
    for r in _readers:
        _log_watcher.add_reader(r)
    _log_watcher.start()

    # Git filesystem watcher: fires `git.changed` near-instantly when the
    # working tree or `.git` state changes on disk (external edits, another
    # terminal running git). Workspaces are registered lazily on first
    # git.status — see the WebSocket handler.
    global _git_watcher
    _git_watcher = GitWatcher(_broadcast_git_changed)
    _git_watcher.start()

    # Start MCP servers in the background so they're ready for the first pipeline run.
    asyncio.create_task(mcp_manager.startup())

    # Best-effort install Claude Code hooks pointing at this backend so we
    # get reliable "agent active / turn complete" signals (independent of
    # buffer scanning). Failure is non-fatal — the orchestrator falls back
    # to log-tail + sentinel detection.
    try:
        result = install_claude_hooks(str(backend_port_file()))
        log.info("claude hooks install: %s", result)
    except Exception as err:  # noqa: BLE001
        log.warning("claude hooks install failed: %s", err)


@app.on_event("shutdown")
async def _stop_log_watcher() -> None:
    global _log_watcher, _git_watcher
    if _log_watcher is not None:
        _log_watcher.stop()
    if _git_watcher is not None:
        _git_watcher.stop()
    await mcp_manager.shutdown()
    _log_watcher = None
    _git_watcher = None


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": __version__,
        "started_at": STARTED_AT,
        "backend_log": str(backend_log_path()),
    }


@app.get("/mcp/servers")
async def list_mcp_servers() -> dict[str, Any]:
    return {
        "servers": mcp_settings_store.list_servers(),
        "path": str(mcp_settings_store.path),
    }


@app.put("/mcp/servers")
async def replace_mcp_servers(document: MCPServersDocument) -> dict[str, Any]:
    try:
        servers = mcp_settings_store.replace_servers(
            [server.model_dump() for server in document.servers]
        )
        await mcp_manager.reload(mcp_settings_store.path)
        return {"ok": True, "servers": servers}
    except ValidationError as err:
        raise HTTPException(status_code=422, detail=err.errors()) from err
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@app.post("/mcp/servers/reset")
async def reset_mcp_servers() -> dict[str, Any]:
    servers = mcp_settings_store.reset()
    await mcp_manager.reload(mcp_settings_store.path)
    return {"ok": True, "servers": servers}


@app.post("/hooks/claude")
async def claude_hook(request: Request) -> dict[str, Any]:
    """Receive a Claude Code hook payload.

    Hook commands installed by `claude_hooks.install_hooks` POST here with:
      - Header X-Agent-Team-Event: pre_tool_use | stop | notification
      - Body: the JSON payload Claude pipes to the hook on stdin

    We map these to `agent.activity` broadcasts so the frontend watcher gets
    100% reliable signals without buffer-scanning. We do NOT pane-attribute
    here (the hook payload has cwd + session_id; we let the frontend match
    by current-stage panes based on those).
    """
    event_kind = request.headers.get("X-Agent-Team-Event", "").strip()
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    # Map Claude's lifecycle to our two event_type buckets.
    if event_kind == "stop":
        event_type = "turn_complete"
    elif event_kind in ("pre_tool_use", "notification"):
        event_type = "agent_active"
    else:
        return {"ok": False, "reason": f"unknown event kind: {event_kind!r}"}

    session_id = str(payload.get("session_id") or payload.get("sessionId") or "")
    cwd = str(payload.get("cwd") or "")
    # Resolve pane_id from session_id (claimed by the JSONL path). Hook payloads
    # have no file_path so they can't pass attribute()'s workspace gate; this
    # lookup bypasses it. Race (stop before JSONL claimed the session) → empty
    # pane_id, and the JSONL path's matching event supplies it shortly.
    pane_id, ws_path, stage_id = attribution.pane_for_session(session_id)
    await broadcast(make_event("agent.activity", {
        "vendor": "claude",
        "event_type": event_type,
        "workspace_path": ws_path or cwd,
        "pane_id": pane_id or "",
        "stage_id": stage_id or "",
        "session_id": session_id,
        "cwd": cwd,
        "timestamp": "",
        "detail": f"hook:{event_kind}",
    }))
    return {"ok": True}


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    log.info("ws client connected")
    session = Session(websocket)
    _SESSIONS.add(session)
    try:
        while True:
            try:
                msg = await websocket.receive_json()
            except (ValueError, KeyError) as parse_err:
                # Malformed JSON frame — log and continue; don't crash the session.
                log.warning("ws malformed message (ignored): %s", parse_err)
                continue
            # Dispatch each message as a concurrent task so long-running handlers
            # (e.g. analyzer.classify that takes 10-60s for LLM inference) never
            # block the receive loop.  Without this, a classify in flight would
            # cause terminal.create messages to queue in the OS buffer and time
            # out on the frontend's 10-second deadline.
            asyncio.create_task(handle_message(session, msg))
    except WebSocketDisconnect:
        log.info("ws client disconnected")
    finally:
        _SESSIONS.discard(session)
        session.terminals.shutdown()
        for t in session._chat_tasks:
            t.cancel()
        for t in session._review_tasks:
            t.cancel()


def _project_payload(project) -> dict[str, Any]:
    """Serialize a Project plus paths to its on-disk files."""
    log_file_name: str = getattr(project, "log_file_name", "") or ""
    # run_dir is the relative path from .agent-team/ to the run folder, e.g.
    # "runs/20260528-020041-task". Empty string for projects with no active run.
    run_dir = log_file_name.rsplit("/", 1)[0] if "/" in log_file_name else ""
    return {
        "project": asdict(project),
        "paths": {
            "dir": str(project_store.project_dir(project.workspace_path)),
            "project_file": str(project_store.project_file(project.workspace_path)),
            "pipeline_log": str(project_store.log_file(project.workspace_path, log_file_name)),
            "backend_log": str(backend_log_path()),
            "run_dir": run_dir,
        },
    }


def _claude_session_file(workspace_path: str, session_id: str) -> Path:
    project_dir = workspace_path.replace("/", "-")
    return Path.home() / ".claude" / "projects" / project_dir / f"{session_id}.jsonl"


def _session_exists(agent: str, workspace_path: str, session_id: str) -> bool:
    agent = agent.strip().lower()
    session_id = session_id.strip()
    if not session_id:
        return False
    if agent == "claude":
        return _claude_session_file(workspace_path, session_id).is_file()
    # Codex/Gemini ids are detected from their session files. Keep trusting
    # persisted ids until vendor-specific preflight checks are added.
    return True


def _record_analyzer_tokens(result: dict[str, Any], payload: dict[str, Any]) -> None:
    """Push an analyzer call's real token count into the store + broadcast.

    Fire-and-forget broadcast so a slow client doesn't delay the response.
    """
    ev = int(result.get("eval_count", 0) or 0)
    pev = int(result.get("prompt_eval_count", 0) or 0)
    if ev == 0 and pev == 0:
        return
    workspace_path = payload.get("workspace_path") or None
    stage_id = payload.get("stage_id") or None
    pane_id = payload.get("pane_id") or None
    tokens_store.record(
        workspace_path,
        source="analyzer",
        vendor="analyzer",
        pane_id=pane_id,
        stage_id=stage_id,
        input_tokens=pev,
        output_tokens=ev,
    )
    asyncio.create_task(
        broadcast(make_event("tokens.changed", tokens_store.snapshot(workspace_path)))
    )


async def handle_message(session: Session, msg: dict[str, Any]) -> None:
    msg_id: str = msg.get("id", "")
    msg_type: str = msg.get("type", "")
    payload: dict[str, Any] = msg.get("payload") or {}

    try:
        # -------- ping / terminals --------
        if msg_type == "ping":
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"pong": True, "echo": payload})
            )
        elif msg_type == "terminal.create":
            metadata = payload.get("metadata") or {}
            term = session.terminals.create(
                pane_id=payload["pane_id"],
                agent_key=payload.get("agent_key"),
                command=payload["command"],
                cwd=payload["cwd"],
                cols=int(payload.get("cols", 100)),
                rows=int(payload.get("rows", 30)),
                env=payload.get("env"),
                metadata=metadata,
                output_log_file=payload.get("output_log_file") or "",
            )
            # Register the pane with the log-attribution layer so any session
            # file appearing after this point can be attributed back to us.
            agent_key = payload.get("agent_key") or ""
            if agent_key in ("claude", "codex", "gemini"):
                ws_for_pane = str(metadata.get("workspace_path") or payload["cwd"])
                # Workspace registration via helper triggers a force-rescan
                # if the workspace is newly known — so historic CLI sessions
                # in that workspace's folder appear in the panel right away.
                _register_workspace_and_backfill(ws_for_pane)
                attribution.register_pane(
                    term.pane_id,
                    vendor=agent_key,
                    cwd=payload["cwd"],
                    workspace_path=ws_for_pane,
                    stage_id=metadata.get("stage_id") or metadata.get("stageId"),
                    slot_key=_stable_pane_key(metadata, ""),
                    explicit_session_id=str(metadata.get("explicit_session_id") or ""),
                    session_marker=str(metadata.get("session_marker") or ""),
                )
            await session.websocket.send_json(
                make_response(
                    msg_id,
                    msg_type,
                    {
                        "terminal_session_id": term.id,
                        "pane_id": term.pane_id,
                        "pid": term.proc.pid,
                        "command": term.command,
                    },
                )
            )
        elif msg_type == "terminal.input":
            session.terminals.write(payload["terminal_session_id"], payload["data"])
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "terminal.log_sent":
            # Fire-and-forget: log injected text to the session's output log file.
            # No response needed — caller does not await this.
            session.terminals.log_sent(
                payload["terminal_session_id"],
                payload.get("label", "sent"),
                payload.get("text", ""),
            )
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "terminal.resize":
            session.terminals.resize(
                payload["terminal_session_id"],
                int(payload["cols"]),
                int(payload["rows"]),
            )
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "terminal.interrupt":
            session.terminals.interrupt(payload["terminal_session_id"])
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "terminal.kill":
            # We don't have direct session_id → pane_id mapping at the app layer;
            # the TerminalService does. Look it up before killing so we can
            # release the attribution registration.
            term_session_id = payload["terminal_session_id"]
            pane_id_for_unreg = ""
            for sess in session.terminals._sessions.values():  # noqa: SLF001
                if sess.id == term_session_id:
                    pane_id_for_unreg = sess.pane_id
                    break
            session.terminals.kill(term_session_id)
            if pane_id_for_unreg:
                attribution.unregister_pane(pane_id_for_unreg)
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True}))

        # -------- project / pipeline --------
        elif msg_type == "project.upsert":
            project = project_store.load_or_create(
                payload["workspace_path"],
                name=payload.get("name", ""),
                backend_version=__version__,
            )
            _register_workspace_and_backfill(project.workspace_path)
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "project.get":
            project = project_store.load_or_create(payload["workspace_path"])
            _register_workspace_and_backfill(project.workspace_path)
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "project.peek":
            ws_raw = payload.get("workspace_path", "") or ""
            project = project_store.peek(ws_raw)
            if project:
                _register_workspace_and_backfill(project.workspace_path)
                await session.websocket.send_json(
                    make_response(msg_id, msg_type, _project_payload(project))
                )
            else:
                # Even when no .agent-team/project.json exists yet, register
                # any valid directory the user "opens" so its historic CLI
                # sessions can show up in cumulative immediately.
                import os as _os
                if ws_raw and _os.path.isdir(ws_raw):
                    _register_workspace_and_backfill(_os.path.abspath(ws_raw))
                await session.websocket.send_json(
                    make_response(msg_id, msg_type, {"project": None, "paths": None})
                )
        elif msg_type == "agent.session_exists":
            exists = _session_exists(
                str(payload.get("agent", "")),
                str(payload.get("workspace_path", "")),
                str(payload.get("session_id", "")),
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"exists": exists})
            )
        elif msg_type == "pipeline.resume":
            project, resume_index = project_store.resume_pipeline(payload["workspace_path"])
            resp = _project_payload(project)
            resp["resume_index"] = resume_index
            await session.websocket.send_json(make_response(msg_id, msg_type, resp))
        elif msg_type == "pipeline.start":
            project = project_store.start_pipeline(
                payload["workspace_path"],
                task_description=payload.get("task_description", ""),
                total_stages=int(payload.get("total_stages", 4)),
                stage_blueprint=payload.get("stage_blueprint", []),
                backend_version=__version__,
                pipeline_id=payload.get("pipeline_id", "") or stages_store.get_active_pipeline_id(),
            )
            _register_workspace_and_backfill(project.workspace_path)
            # Start a fresh token-stats run for this workspace.
            log_name = project.log_file_name or ""
            run_dir = log_name.rsplit("/", 1)[0] if "/" in log_name else ""
            tokens_store.start_run(
                project.workspace_path,
                run_id=run_dir or project.id,
                task=project.task_description,
                run_dir=run_dir,
            )
            asyncio.create_task(
                broadcast(make_event("tokens.changed", tokens_store.snapshot(project.workspace_path)))
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "pipeline.stage_spawn":
            project = project_store.record_stage_spawn(
                payload["workspace_path"],
                stage_index=int(payload["stage_index"]),
                pane_id=payload["pane_id"],
                agent=payload.get("agent", ""),
                role=payload.get("role", ""),
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "pipeline.slot_spawn":
            project = project_store.record_slot_spawn(
                payload["workspace_path"],
                stage_index=int(payload["stage_index"]),
                slot_label=payload["slot_label"],
                pane_id=payload["pane_id"],
                agent=payload.get("agent", ""),
                role=payload.get("role", ""),
                # Claude passes its pinned --session-id here; Codex/Gemini pass
                # "" and persist later via pipeline.slot_session once detected.
                session_id=payload.get("session_id", ""),
                run_group_id=payload.get("run_group_id", ""),
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "pipeline.slot_session":
            project = project_store.record_slot_session(
                payload["workspace_path"],
                stage_index=int(payload["stage_index"]),
                slot_label=payload["slot_label"],
                session_id=payload.get("session_id", ""),
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "pipeline.slot_unspawn":
            project = project_store.record_slot_unspawn(
                payload["workspace_path"],
                stage_index=int(payload["stage_index"]),
                slot_label=payload["slot_label"],
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "manual_pane.spawn":
            project = project_store.record_manual_pane_spawn(
                payload["workspace_path"],
                pane_id=payload["pane_id"],
                previous_pane_id=payload.get("previous_pane_id", ""),
                agent=payload.get("agent", ""),
                role=payload.get("role", ""),
                command=payload.get("command", ""),
                session_id=payload.get("session_id", ""),
                run_group_id=payload.get("run_group_id", ""),
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "manual_pane.unspawn":
            project = project_store.record_manual_pane_unspawn(
                payload["workspace_path"],
                pane_id=payload["pane_id"],
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "manual_pane.session":
            project = project_store.record_manual_pane_session(
                payload["workspace_path"],
                pane_id=payload["pane_id"],
                session_id=payload.get("session_id", ""),
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "pane.set_run_group":
            project = project_store.set_pane_run_group(
                payload["workspace_path"],
                pane_id=payload["pane_id"],
                run_group_id=payload.get("run_group_id", ""),
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "project.set_layout_mode":
            ws_raw = payload.get("workspace_path", "") or ""
            mode = payload.get("layout_mode", "grid")
            if mode not in ("auto", "grid", "spotlight", "fullscreen"):
                mode = "grid"
            project = project_store.peek(ws_raw)
            if project:
                project.layout_mode = mode
                project_store.save(project)
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "project.set_theme":
            # Backup-only persistence: localStorage in the renderer is the source
            # of truth. We just stash the latest theme + custom overrides so they
            # can sync across devices. Unknown workspace → silently no-op.
            ws_raw = payload.get("workspace_path", "") or ""
            project = project_store.peek(ws_raw)
            if project:
                theme = payload.get("theme")
                if isinstance(theme, str) and theme:
                    project.theme = theme
                custom = payload.get("theme_custom")
                if isinstance(custom, dict):
                    project.theme_custom = custom
                project_store.save(project)
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "pipeline.slot_kickoff":
            project = project_store.update_slot_kickoff(
                payload["workspace_path"],
                stage_index=int(payload["stage_index"]),
                slot_label=payload["slot_label"],
                kickoff_status=payload.get("kickoff_status", "sent"),
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "pipeline.complete":
            project = project_store.complete_pipeline(payload["workspace_path"])
            tokens_store.end_run(project.workspace_path)
            asyncio.create_task(
                broadcast(make_event("tokens.changed", tokens_store.snapshot(project.workspace_path)))
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "pipeline.abort":
            project = project_store.abort_pipeline(
                payload["workspace_path"], reason=payload.get("reason", "user")
            )
            tokens_store.end_run(project.workspace_path)
            asyncio.create_task(
                broadcast(make_event("tokens.changed", tokens_store.snapshot(project.workspace_path)))
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "pipeline.fetch_docs":
            # Fetch framework docs from Context7 via MCP for dynamic kickoff injection.
            # Best-effort: returns { doc_prefix: "" } on any error.
            task = payload.get("task", "")
            doc_query = payload.get("doc_query", "")
            workspace_path = payload.get("workspace_path", "")
            analyzer_model = payload.get("analyzer_model", "") or ANALYZER_DEFAULT_MODEL
            try:
                doc_prefix = await fetch_stage_docs(
                    task=task,
                    doc_query=doc_query,
                    mcp_manager=mcp_manager,
                    workspace_path=workspace_path,
                    analyzer_model=analyzer_model,
                )
            except Exception as fetch_err:  # noqa: BLE001
                log.warning("pipeline.fetch_docs error: %s", fetch_err)
                doc_prefix = ""
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"doc_prefix": doc_prefix})
            )
        elif msg_type == "mcp.list_servers":
            configured = mcp_settings_store.list_servers()
            live = await mcp_manager.list_status()
            live_map = {s["name"]: s for s in live}
            merged = []
            for srv in configured:
                info = live_map.get(srv["name"], {})
                if not srv.get("enabled", True):
                    live_status = "disabled"
                else:
                    live_status = info.get("status", "unknown")
                merged.append({
                    **srv,
                    "status": live_status,
                    "tool_count": info.get("tool_count", 0),
                    "tools": info.get("tools", []),
                })
            await session.websocket.send_json(
                make_response(
                    msg_id,
                    msg_type,
                    {
                        "servers": merged,
                        "path": str(mcp_settings_store.path),
                    },
                )
            )
        elif msg_type == "mcp.save_servers":
            servers_raw = payload.get("servers", [])
            servers = mcp_settings_store.replace_servers(servers_raw)
            await mcp_manager.reload(mcp_settings_store.path)
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"ok": True, "servers": servers})
            )
        elif msg_type == "pipeline.auto_answer":
            result = await analyzer_auto_answer(
                questions=payload.get("questions", []),
                task=payload.get("task", ""),
                stage_title=payload.get("stage_title", ""),
                model=payload.get("model") or ANALYZER_DEFAULT_MODEL,
            )
            _record_analyzer_tokens(result, payload)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
        # -------- recent workspaces --------
        elif msg_type == "workspace.list_recent":
            await session.websocket.send_json(
                make_response(
                    msg_id,
                    msg_type,
                    {
                        "recent": recent_workspaces_store.list(),
                        "path": str(recent_workspaces_store.path),
                    },
                )
            )
        elif msg_type == "workspace.touch":
            recent_workspaces_store.touch(
                payload["path"],
                state=payload.get("state", ""),
                task=payload.get("task", ""),
            )
            recent = recent_workspaces_store.list()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"recent": recent})
            )
            await broadcast(
                make_event("workspace.recent_changed", {"recent": recent, "reason": "touch"})
            )
        elif msg_type == "workspace.pin":
            recent_workspaces_store.pin(payload["path"])
            recent = recent_workspaces_store.list()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"recent": recent})
            )
            await broadcast(
                make_event("workspace.recent_changed", {"recent": recent, "reason": "pin"})
            )
        elif msg_type == "workspace.unpin":
            recent_workspaces_store.unpin(payload["path"])
            recent = recent_workspaces_store.list()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"recent": recent})
            )
            await broadcast(
                make_event("workspace.recent_changed", {"recent": recent, "reason": "unpin"})
            )

        elif msg_type == "workspace.remove":
            recent_workspaces_store.remove(payload["path"])
            recent = recent_workspaces_store.list()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"recent": recent})
            )
            await broadcast(
                make_event("workspace.recent_changed", {"recent": recent, "reason": "remove"})
            )

        # -------- roles registry --------
        elif msg_type == "roles.list":
            await session.websocket.send_json(
                make_response(
                    msg_id,
                    msg_type,
                    {"roles": roles_store.list(), "path": str(roles_store.path)},
                )
            )
        elif msg_type == "roles.upsert":
            role = roles_store.upsert(
                key=payload["key"],
                label=payload.get("label", ""),
                one_line=payload.get("one_line", ""),
                system_prompt=payload.get("system_prompt", ""),
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"role": role, "roles": roles_store.list()})
            )
            await broadcast(
                make_event("roles.changed", {"roles": roles_store.list(), "reason": "upsert"})
            )
        elif msg_type == "roles.delete":
            roles = roles_store.delete(payload["key"])
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"roles": roles})
            )
            await broadcast(
                make_event("roles.changed", {"roles": roles, "reason": "delete"})
            )
        elif msg_type == "roles.reset":
            roles = roles_store.reset()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"roles": roles})
            )
            await broadcast(
                make_event("roles.changed", {"roles": roles, "reason": "reset"})
            )

        # -------- pipelines registry --------
        elif msg_type == "pipelines.list":
            pipelines = stages_store.list_pipelines()
            active_id = stages_store.get_active_pipeline_id()
            await session.websocket.send_json(
                make_response(
                    msg_id,
                    msg_type,
                    {"pipelines": pipelines, "active_pipeline_id": active_id, "path": str(stages_store.path)},
                )
            )
        elif msg_type == "pipelines.create":
            name = payload.get("name", "New Pipeline")
            pipeline = stages_store.create_pipeline(name)
            pipelines = stages_store.list_pipelines()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"pipeline": pipeline, "pipelines": pipelines})
            )
            await broadcast(make_event("pipelines.changed", {
                "pipelines": pipelines,
                "active_pipeline_id": stages_store.get_active_pipeline_id(),
                "reason": "create",
            }))
        elif msg_type == "pipelines.rename":
            pipeline_id = payload.get("pipeline_id", "")
            name = payload.get("name", "")
            pipeline = stages_store.rename_pipeline(pipeline_id, name)
            pipelines = stages_store.list_pipelines()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"pipeline": pipeline, "pipelines": pipelines})
            )
            await broadcast(make_event("pipelines.changed", {
                "pipelines": pipelines,
                "active_pipeline_id": stages_store.get_active_pipeline_id(),
                "reason": "rename",
            }))
        elif msg_type == "pipelines.delete":
            pipeline_id = payload.get("pipeline_id", "")
            ws_path = payload.get("workspace_path", "") or ""
            if ws_path:
                proj = project_store.peek(ws_path)
                if proj and proj.state == "running":
                    await session.websocket.send_json(
                        make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot delete pipeline while a project is running")
                    )
                    return
            pipelines = stages_store.delete_pipeline(pipeline_id)
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"pipelines": pipelines})
            )
            await broadcast(make_event("pipelines.changed", {
                "pipelines": pipelines,
                "active_pipeline_id": stages_store.get_active_pipeline_id(),
                "reason": "delete",
            }))
        elif msg_type == "pipelines.set_active":
            pipeline_id = payload.get("pipeline_id", "")
            ws_path = payload.get("workspace_path", "") or ""
            if ws_path:
                proj = project_store.peek(ws_path)
                if proj and proj.state == "running":
                    await session.websocket.send_json(
                        make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot switch pipeline while a project is running")
                    )
                    return
            stages_store.set_active_pipeline(pipeline_id)
            pipelines = stages_store.list_pipelines()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {
                    "active_pipeline_id": pipeline_id,
                    "pipelines": pipelines,
                })
            )
            await broadcast(make_event("pipelines.changed", {
                "pipelines": pipelines,
                "active_pipeline_id": pipeline_id,
                "reason": "set_active",
            }))
        elif msg_type == "pipelines.reset_builtin":
            pipeline_id = payload.get("pipeline_id", "")
            pipeline = stages_store.reset_builtin(pipeline_id)
            pipelines = stages_store.list_pipelines()
            stages = stages_store.list(pipeline_id)
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"pipeline": pipeline, "pipelines": pipelines})
            )
            await broadcast(make_event("pipelines.changed", {
                "pipelines": pipelines,
                "active_pipeline_id": stages_store.get_active_pipeline_id(),
                "reason": "reset_builtin",
            }))
            await broadcast(make_event("stages.changed", {
                "stages": stages,
                "pipeline_id": pipeline_id,
                "reason": "reset_builtin",
            }))

        # -------- stages registry --------
        elif msg_type == "stages.list":
            pipeline_id = payload.get("pipeline_id") or None
            stages = stages_store.list(pipeline_id)
            active_id = stages_store.get_active_pipeline_id()
            await session.websocket.send_json(
                make_response(
                    msg_id,
                    msg_type,
                    {"stages": stages, "path": str(stages_store.path), "pipeline_id": pipeline_id or active_id},
                )
            )
        elif msg_type == "stages.upsert":
            pipeline_id = payload.get("pipeline_id") or None
            ws_path = payload.get("workspace_path", "") or ""
            if ws_path and not pipeline_id:
                # Check running guard for active pipeline
                proj = project_store.peek(ws_path)
                if proj and proj.state == "running":
                    await session.websocket.send_json(
                        make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot edit stages while the active pipeline is running")
                    )
                    return
            stage = stages_store.upsert(payload["stage"], pipeline_id)
            effective_pipeline_id = pipeline_id or stages_store.get_active_pipeline_id()
            updated_stages = stages_store.list(pipeline_id)
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"stage": stage, "stages": updated_stages})
            )
            await broadcast(make_event("stages.changed", {
                "stages": updated_stages,
                "pipeline_id": effective_pipeline_id,
                "reason": "upsert",
            }))
        elif msg_type == "stages.reorder":
            pipeline_id = payload.get("pipeline_id") or None
            ws_path = payload.get("workspace_path", "") or ""
            if ws_path and not pipeline_id:
                proj = project_store.peek(ws_path)
                if proj and proj.state == "running":
                    await session.websocket.send_json(
                        make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot reorder stages while the active pipeline is running")
                    )
                    return
            updated_stages = stages_store.reorder(payload["ids"], pipeline_id)
            effective_pipeline_id = pipeline_id or stages_store.get_active_pipeline_id()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"stages": updated_stages})
            )
            await broadcast(make_event("stages.changed", {
                "stages": updated_stages,
                "pipeline_id": effective_pipeline_id,
                "reason": "reorder",
            }))
        elif msg_type == "stages.delete":
            pipeline_id = payload.get("pipeline_id") or None
            ws_path = payload.get("workspace_path", "") or ""
            if ws_path and not pipeline_id:
                proj = project_store.peek(ws_path)
                if proj and proj.state == "running":
                    await session.websocket.send_json(
                        make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot delete stages while the active pipeline is running")
                    )
                    return
            updated_stages = stages_store.delete(payload["id"], pipeline_id)
            effective_pipeline_id = pipeline_id or stages_store.get_active_pipeline_id()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"stages": updated_stages})
            )
            await broadcast(make_event("stages.changed", {
                "stages": updated_stages,
                "pipeline_id": effective_pipeline_id,
                "reason": "delete",
            }))
        elif msg_type == "stages.reset":
            pipeline_id = payload.get("pipeline_id") or None
            updated_stages = stages_store.reset(pipeline_id)
            effective_pipeline_id = pipeline_id or stages_store.get_active_pipeline_id()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"stages": updated_stages})
            )
            await broadcast(make_event("stages.changed", {
                "stages": updated_stages,
                "pipeline_id": effective_pipeline_id,
                "reason": "reset",
            }))

        # -------- analyzer (local LLM / Ollama) --------
        elif msg_type == "analyzer.detect_llama_cli":
            import shutil as _shutil
            candidates = [
                "llama-completion",
                "llama-cli",
                "/opt/homebrew/bin/llama-completion",
                "/opt/homebrew/bin/llama-cli",
                "/usr/local/bin/llama-completion",
                "/usr/local/bin/llama-cli",
            ]
            found = []
            for c in candidates:
                p = _shutil.which(c) or (c if __import__("os.path", fromlist=["exists"]).exists(c) else None)
                if p and p not in found:
                    found.append(p)
            await session.websocket.send_json(make_response(msg_id, msg_type, {
                "found": found,
                "recommended": found[0] if found else None,
            }))

        elif msg_type == "analyzer.settings.get":
            await session.websocket.send_json(
                make_response(msg_id, msg_type, analyzer_settings_store.get())
            )
        elif msg_type == "analyzer.settings.set":
            updated = analyzer_settings_store.set(payload)
            await session.websocket.send_json(make_response(msg_id, msg_type, updated))
            await broadcast(make_event("analyzer.settings_changed", updated))

        elif msg_type == "analyzer.health":
            data = await analyzer_health()
            data["default_model"] = ANALYZER_DEFAULT_MODEL
            data["backend"] = _az_settings().get("backend", "llama_cpp")
            await session.websocket.send_json(make_response(msg_id, msg_type, data))
        elif msg_type == "analyzer.models":
            models = await analyzer_list_models()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"models": models, "default": ANALYZER_DEFAULT_MODEL})
            )
        elif msg_type == "analyzer.classify":
            text = payload.get("text", "") or ""
            model = payload.get("model") or ANALYZER_DEFAULT_MODEL
            result = await analyzer_classify(text, model)
            _record_analyzer_tokens(result, payload)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "analyzer.benchmark":
            async def _benchmark_bg() -> None:
                async def _on_progress(
                    model: str, task_id: str, passed: bool, elapsed_s: float, score: int
                ) -> None:
                    await broadcast(make_event("analyzer.benchmark_progress", {
                        "model": model, "task_id": task_id,
                        "passed": passed, "elapsed_s": elapsed_s, "score": score,
                    }))
                try:
                    results = await analyzer_benchmark(progress_cb=_on_progress)
                    await broadcast(make_event("analyzer.benchmark_done", {"results": results}))
                except Exception as _bench_err:  # noqa: BLE001
                    log.warning("benchmark error: %s", _bench_err)
                    await broadcast(make_event("analyzer.benchmark_done", {"results": [], "error": str(_bench_err)}))

            asyncio.create_task(_benchmark_bg())
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True, "started": True}))

        elif msg_type == "analyzer.pull":
            # Only valid in Ollama mode.
            model_name = payload.get("name", "")
            if not model_name:
                await session.websocket.send_json(
                    make_response(msg_id, msg_type, {"ok": False, "error": "name required"})
                )
            elif not _az_is_ollama():
                await session.websocket.send_json(
                    make_response(msg_id, msg_type, {"ok": False, "error": "pull only available in Ollama mode"})
                )
            else:
                async def _pull_bg(name: str = model_name) -> None:
                    try:
                        async for progress in _ollama_pull_model(name, _az_base_url()):
                            await broadcast(make_event("analyzer.pull_progress", {"name": name, **progress}))
                        await broadcast(make_event("analyzer.pull_done", {"name": name, "ok": True}))
                    except Exception as _pull_err:
                        await broadcast(make_event("analyzer.pull_done", {"name": name, "ok": False, "error": str(_pull_err)}))

                asyncio.create_task(_pull_bg())
                await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True, "started": True}))

        elif msg_type == "analyzer.delete":
            model_name = payload.get("name", "")
            if not model_name:
                await session.websocket.send_json(
                    make_response(msg_id, msg_type, {"ok": False, "error": "name required"})
                )
            elif not _az_is_ollama():
                await session.websocket.send_json(
                    make_response(msg_id, msg_type, {"ok": False, "error": "delete only available in Ollama mode"})
                )
            else:
                result = await _ollama_delete_model(model_name, _az_base_url())
                await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "analyzer.ollama_health":
            data = await _ollama_health(_az_base_url())
            await session.websocket.send_json(make_response(msg_id, msg_type, data))

        # -------- token stats --------
        elif msg_type == "tokens.snapshot":
            snap = tokens_store.snapshot(payload.get("workspace_path") or None)
            await session.websocket.send_json(make_response(msg_id, msg_type, snap))
        elif msg_type == "tokens.reset":
            scope = payload.get("scope", "run")
            snap = tokens_store.reset(scope, payload.get("workspace_path") or None)
            await session.websocket.send_json(make_response(msg_id, msg_type, snap))
            await broadcast(make_event("tokens.changed", snap))

        # -------- pipeline history (timeline) --------
        elif msg_type == "history.snapshot":
            ws_path = payload.get("workspace_path") or ""
            # Resolve the active run's folder so the timeline scopes to it.
            _proj = project_store.peek(ws_path) if ws_path else None
            _log_name = _proj.log_file_name if _proj else ""
            run_dir = _log_name.rsplit("/", 1)[0] if "/" in _log_name else ""
            snap = history_store.snapshot(ws_path, run_dir, int(payload.get("limit", 500)))
            await session.websocket.send_json(make_response(msg_id, msg_type, snap))

        elif msg_type == "project.log_event":
            ws_path = payload["workspace_path"]
            # Route to the run-specific log file (e.g. pipeline-20260528-…log)
            # rather than the generic pipeline.log fallback.
            _proj = project_store.peek(ws_path)
            _log_name = _proj.log_file_name if _proj else ""
            project_store.record_pane_event(
                ws_path,
                event_type=payload.get("event_type", "note"),
                pane_id=payload.get("pane_id", ""),
                agent=payload.get("agent", ""),
                role=payload.get("role", ""),
                origin=payload.get("origin", "manual"),
                details=payload.get("details"),
                log_file_name=_log_name,
            )
            # Mirror into the structured history timeline. Orchestrator log lines
            # carry their text in details.line; classify those, store others as-is.
            _run_dir = _log_name.rsplit("/", 1)[0] if "/" in _log_name else ""
            _details = payload.get("details") or {}
            _line = _details.get("line") if isinstance(_details, dict) else None
            if payload.get("event_type") == "orchestrator_log" and _line:
                _ev = history_store.record_line(
                    ws_path,
                    _line,
                    run_dir=_run_dir,
                    pane_id=payload.get("pane_id") or None,
                    vendor=payload.get("agent") or None,
                )
            else:
                _ev = history_store.record(
                    ws_path,
                    run_dir=_run_dir,
                    type=payload.get("event_type", "note"),
                    summary=str(_line or payload.get("event_type", "note")),
                    pane_id=payload.get("pane_id") or None,
                    vendor=payload.get("agent") or None,
                    detail=_details if isinstance(_details, dict) and _details else None,
                )
            asyncio.create_task(
                broadcast(make_event("history.appended", {"workspace_path": ws_path, "event": _ev}))
            )
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"ok": True})
            )

        # -------- git --------
        elif msg_type == "git.init":
            ws_path = payload.get("workspace_path") or ""
            create_gi = bool(payload.get("create_gitignore", True))
            result = await git_service.init_repo(ws_path, create_gitignore=create_gi)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.status":
            ws_path = payload.get("workspace_path") or ""
            # The GitPane is now looking at this workspace — start (idempotently)
            # watching it on disk so external changes refresh near-instantly.
            if _git_watcher is not None:
                _git_watcher.watch(ws_path)
            include_ignored = bool(payload.get("include_ignored", False))
            result = await git_service.get_status(ws_path, include_ignored=include_ignored)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.log":
            ws_path = payload.get("workspace_path") or ""
            n = min(int(payload.get("n", 20)), 500)
            all_branches = bool(payload.get("all", False))
            result = await git_service.get_log(ws_path, n, all_branches)
            await session.websocket.send_json(make_response(msg_id, msg_type, {"commits": result}))

        elif msg_type == "git.stage":
            ws_path = payload.get("workspace_path") or ""
            files = payload.get("files") or []
            result = await git_service.stage_files(ws_path, files)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.unstage":
            ws_path = payload.get("workspace_path") or ""
            files = payload.get("files") or []
            result = await git_service.unstage_files(ws_path, files)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.stage_all":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.stage_all(ws_path)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.check_staged":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.check_staged(ws_path)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.commit":
            ws_path = payload.get("workspace_path") or ""
            message = payload.get("message") or ""
            commit_all = bool(payload.get("all"))
            result = await git_service.commit(ws_path, message, commit_all)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.sync":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.sync(ws_path)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.generate_message":
            ws_path = payload.get("workspace_path") or ""
            ollama_url = _az_base_url()
            attempt_count = int(payload.get("attempt_count") or 0)
            chat_settings = ai_chat_settings_store.get()
            model = payload.get("model") or chat_settings.get("model") or ANALYZER_DEFAULT_MODEL
            result = await git_service.generate_commit_message(ws_path, ollama_url, model, attempt_count, settings=chat_settings)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.discard":
            ws_path = payload.get("workspace_path") or ""
            files = payload.get("files") or []
            result = await git_service.discard_changes(ws_path, files)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.fetch":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.fetch(ws_path)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.pull":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.pull_only(ws_path)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.push":
            ws_path = payload.get("workspace_path") or ""
            remote = payload.get("remote") or ""
            branch = payload.get("branch") or ""
            result = await git_service.push_only(ws_path, remote, branch)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.branches":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.list_branches(ws_path)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.create_branch":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            switch_to = bool(payload.get("switch_to", True))
            result = await git_service.create_branch(ws_path, name, switch_to=switch_to)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.switch_branch":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            result = await git_service.switch_branch(ws_path, name)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.checkout_remote_branch":
            ws_path = payload.get("workspace_path") or ""
            remote_ref = payload.get("remote_ref") or ""
            result = await git_service.checkout_remote_branch(ws_path, remote_ref)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.delete_branch":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            force = bool(payload.get("force", False))
            result = await git_service.delete_branch(ws_path, name, force=force)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.stash_list":
            ws_path = payload.get("workspace_path") or ""
            entries = await git_service.stash_list(ws_path)
            await session.websocket.send_json(make_response(msg_id, msg_type, {"stashes": entries}))

        elif msg_type == "git.stash":
            ws_path = payload.get("workspace_path") or ""
            message = payload.get("message") or ""
            paths = payload.get("paths") or None
            result = await git_service.stash_push(ws_path, message, paths)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.stash_pop":
            ws_path = payload.get("workspace_path") or ""
            index = int(payload.get("index", 0))
            result = await git_service.stash_pop(ws_path, index)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.stash_drop":
            ws_path = payload.get("workspace_path") or ""
            index = int(payload.get("index", 0))
            result = await git_service.stash_drop(ws_path, index)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.amend":
            ws_path = payload.get("workspace_path") or ""
            message = payload.get("message") or ""
            result = await git_service.amend_commit(ws_path, message)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.undo_commit":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.undo_last_commit(ws_path)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.diff_file":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            staged = bool(payload.get("staged", False))
            result = await git_service.diff_file(ws_path, filepath, staged=staged)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.diff_blame":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            staged = bool(payload.get("staged", False))
            result = await git_service.diff_blame(ws_path, filepath, staged=staged)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.diff_all":
            ws_path = payload.get("workspace_path") or ""
            staged = bool(payload.get("staged", False))
            result = await git_service.diff_all(ws_path, staged=staged)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.merge":
            ws_path = payload.get("workspace_path") or ""
            branch = payload.get("branch") or ""
            result = await git_service.merge_branch(ws_path, branch)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.merge_into":
            ws_path = payload.get("workspace_path") or ""
            target = payload.get("target") or ""
            result = await git_service.merge_into(ws_path, target)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.revert":
            ws_path = payload.get("workspace_path") or ""
            commit_hash = payload.get("commit_hash") or ""
            result = await git_service.revert_commit(ws_path, commit_hash)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.remotes":
            ws_path = payload.get("workspace_path") or ""
            remotes = await git_service.list_remotes(ws_path)
            await session.websocket.send_json(make_response(msg_id, msg_type, {"remotes": remotes}))

        elif msg_type == "git.add_remote":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            url = payload.get("url") or ""
            result = await git_service.add_remote(ws_path, name, url)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.connect_to_remote":
            ws_path = payload.get("workspace_path") or ""
            url = payload.get("url") or ""
            result = await git_service.connect_to_remote(ws_path, url)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.remove_remote":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            result = await git_service.remove_remote(ws_path, name)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.cherry_pick":
            ws_path = payload.get("workspace_path") or ""
            commit_hash = payload.get("commit_hash") or ""
            result = await git_service.cherry_pick(ws_path, commit_hash)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.tags":
            ws_path = payload.get("workspace_path") or ""
            tags = await git_service.list_tags(ws_path)
            await session.websocket.send_json(make_response(msg_id, msg_type, {"tags": tags}))

        elif msg_type == "git.create_tag":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            message = payload.get("message") or ""
            commit_hash = payload.get("commit_hash") or ""
            result = await git_service.create_tag(ws_path, name, message, commit_hash)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.delete_tag":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            result = await git_service.delete_tag(ws_path, name)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.file_log":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            n = int(payload.get("n", 15))
            commits = await git_service.file_log(ws_path, filepath, n)
            await session.websocket.send_json(make_response(msg_id, msg_type, {"commits": commits}))

        elif msg_type == "git.show_file":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            rev = payload.get("rev") or "HEAD"
            result = await git_service.show_file(ws_path, filepath, rev)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.resolve_ours":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            result = await git_service.resolve_conflict_ours(ws_path, filepath)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.resolve_theirs":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            result = await git_service.resolve_conflict_theirs(ws_path, filepath)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.clean":
            ws_path = payload.get("workspace_path") or ""
            dry_run = bool(payload.get("dry_run", True))
            result = await git_service.clean_untracked(ws_path, dry_run=dry_run)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok") and not dry_run:
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.show_commit":
            ws_path = payload.get("workspace_path") or ""
            commit_hash = payload.get("commit_hash") or ""
            result = await git_service.show_commit(ws_path, commit_hash)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.worktrees":
            ws_path = payload.get("workspace_path") or ""
            entries = await git_service.list_worktrees(ws_path)
            await session.websocket.send_json(make_response(msg_id, msg_type, {"worktrees": entries}))

        elif msg_type == "git.add_worktree":
            ws_path = payload.get("workspace_path") or ""
            wt_path = payload.get("worktree_path") or ""
            branch = payload.get("branch") or ""
            new_branch = bool(payload.get("new_branch", False))
            result = await git_service.add_worktree(ws_path, wt_path, branch, new_branch=new_branch)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.remove_worktree":
            ws_path = payload.get("workspace_path") or ""
            wt_path = payload.get("worktree_path") or ""
            force = bool(payload.get("force", False))
            result = await git_service.remove_worktree(ws_path, wt_path, force=force)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.config_get":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.get_config(ws_path)
            result["allowed_keys"] = sorted(git_service._ALLOWED_CONFIG_KEYS)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.config_set":
            ws_path = payload.get("workspace_path") or ""
            key = payload.get("key") or ""
            value = payload.get("value") or ""
            result = await git_service.set_config(ws_path, key, value)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.blame":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            result = await git_service.blame_file(ws_path, filepath)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.compare_branches":
            ws_path = payload.get("workspace_path") or ""
            base = payload.get("base") or ""
            compare = payload.get("compare") or ""
            result = await git_service.compare_branches(ws_path, base, compare)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.diff_branches":
            ws_path = payload.get("workspace_path") or ""
            base = payload.get("base") or "main"
            compare = payload.get("compare") or ""
            result = await git_service.diff_branches(ws_path, base, compare)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.rebase":
            ws_path = payload.get("workspace_path") or ""
            branch = payload.get("branch") or ""
            result = await git_service.rebase_on(ws_path, branch)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.restore_from_branch":
            ws_path = payload.get("workspace_path") or ""
            branch = payload.get("branch") or ""
            filepath = payload.get("filepath") or ""
            result = await git_service.restore_file_from_branch(ws_path, branch, filepath)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.push_upstream":
            ws_path = payload.get("workspace_path") or ""
            branch = payload.get("branch") or ""
            remote = payload.get("remote") or "origin"
            result = await git_service.push_set_upstream(ws_path, branch, remote)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.apply_patch":
            ws_path = payload.get("workspace_path") or ""
            patch = payload.get("patch") or ""
            reverse = bool(payload.get("reverse", False))
            cached = bool(payload.get("cached", True))
            result = await git_service.apply_patch(ws_path, patch, reverse=reverse, cached=cached)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.clone":
            url = payload.get("url") or ""
            target_dir = payload.get("target_dir") or ""
            result = await git_service.clone_repo(url, target_dir)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.ignore":
            ws_path = payload.get("workspace_path") or ""
            pattern = payload.get("pattern") or ""
            target = payload.get("target") or "project"
            untrack = bool(payload.get("untrack", True))
            result = await git_service.add_to_gitignore(ws_path, pattern, target=target, untrack=untrack)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.check_ignore":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            result = await git_service.check_ignore(ws_path, filepath)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.abort":
            ws_path = payload.get("workspace_path") or ""
            op = payload.get("op") or ""
            result = await git_service.abort_operation(ws_path, op)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.stash_apply":
            ws_path = payload.get("workspace_path") or ""
            index = int(payload.get("index", 0))
            result = await git_service.stash_apply(ws_path, index)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.pull_rebase":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.pull_rebase(ws_path)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.push_force":
            ws_path = payload.get("workspace_path") or ""
            remote = payload.get("remote") or ""
            branch = payload.get("branch") or ""
            result = await git_service.push_force(ws_path, remote, branch)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        # ── Explorer filesystem (fs.*) ──────────────────────────────────────
        elif msg_type == "fs.list_dir":
            ws_path = payload.get("workspace_path") or ""
            rel = payload.get("rel_path", "") or ""
            show_hidden = bool(payload.get("show_hidden", False))
            result = fs_service.list_dir(ws_path, rel, show_hidden=show_hidden)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "fs.list_files_flat":
            ws_path = payload.get("workspace_path") or ""
            query = payload.get("query", "") or ""
            result = fs_service.list_files_flat(ws_path, query=query)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "fs.glob_files":
            ws_path = payload.get("workspace_path") or ""
            pattern = payload.get("pattern", "") or ""
            result = fs_service.glob_files(ws_path, pattern=pattern)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "fs.mkdir":
            ws_path = payload.get("workspace_path") or ""
            result = fs_service.mkdir(ws_path, payload.get("rel_path", "") or "")
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "fs.create_file":
            ws_path = payload.get("workspace_path") or ""
            result = fs_service.create_file(
                ws_path, payload.get("rel_path", "") or "", payload.get("content", "") or ""
            )
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "fs.rename":
            ws_path = payload.get("workspace_path") or ""
            result = fs_service.rename(
                ws_path, payload.get("src_path", "") or "", payload.get("dst_path", "") or ""
            )
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "fs.delete":
            ws_path = payload.get("workspace_path") or ""
            result = fs_service.delete(ws_path, payload.get("rel_path", "") or "")
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "fs.write_file":
            ws_path = payload.get("workspace_path") or ""
            result = fs_service.write_file(
                ws_path, payload.get("rel_path", "") or "", payload.get("content", "") or ""
            )
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "fs.read_file":
            ws_path = payload.get("workspace_path") or ""
            result = fs_service.read_file(ws_path, payload.get("rel_path", "") or "")
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        # ── Shell run (shell.run) ───────────────────────────────────────────
        # Security notes:
        # - Uses create_subprocess_exec('/bin/sh', '-c', cmd) instead of
        #   create_subprocess_shell to avoid implicit shell injection.
        # - ws_path is resolved and validated to be an existing directory.
        # - Frontend shows full command in confirm dialog before invoking.
        # - This is a local-only Electron app; the WebSocket server binds to
        #   localhost only, reducing (but not eliminating) external attack surface.
        elif msg_type == "shell.run":
            ws_path = payload.get("workspace_path") or ""
            cmd = payload.get("command", "") or ""
            if not cmd:
                await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "no command"}))
            else:
                resolved_cwd = Path(ws_path).resolve() if ws_path else None
                # Validate that cwd is a known registered workspace (or its subdirectory)
                known_roots = [Path(w).resolve() for w in attribution.known_workspaces()]
                cwd_allowed = resolved_cwd is None or any(
                    resolved_cwd == r or resolved_cwd.is_relative_to(r)
                    for r in known_roots
                )
                if not cwd_allowed:
                    await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "workspace path not registered"}))
                elif resolved_cwd and not resolved_cwd.is_dir():
                    await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "invalid workspace path"}))
                else:
                    try:
                        proc = await asyncio.create_subprocess_exec(
                            "/bin/sh", "-c", cmd,
                            stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.STDOUT,
                            cwd=str(resolved_cwd) if resolved_cwd else None,
                        )
                        try:
                            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
                            output = stdout.decode("utf-8", errors="replace")
                            await session.websocket.send_json(make_response(msg_id, msg_type, {
                                "ok": True, "output": output[:8000], "exit_code": proc.returncode,
                            }))
                        except asyncio.TimeoutError:
                            proc.kill()
                            await proc.communicate()
                            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "timeout after 30s"}))
                    except Exception as exc:
                        await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": False, "error": str(exc)}))

        # ── Search (search.*) ───────────────────────────────────────────────
        elif msg_type == "search.find_in_files":
            result = await asyncio.to_thread(
                search_service.find_in_files,
                payload.get("workspace_path") or "",
                payload.get("query", "") or "",
                is_regex=bool(payload.get("is_regex")),
                case_sensitive=bool(payload.get("case_sensitive")),
                whole_word=bool(payload.get("whole_word")),
                includes=payload.get("includes", "") or "",
                excludes=payload.get("excludes", "") or "",
            )
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "search.replace_in_files":
            ws_path = payload.get("workspace_path") or ""
            result = await asyncio.to_thread(
                search_service.replace_in_files,
                ws_path,
                payload.get("query", "") or "",
                payload.get("replacement", "") or "",
                payload.get("files", []) or [],
                is_regex=bool(payload.get("is_regex")),
                case_sensitive=bool(payload.get("case_sensitive")),
                whole_word=bool(payload.get("whole_word")),
            )
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok") and result.get("total"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        # ── Editor AI (editor.*) ────────────────────────────────────────────
        elif msg_type == "editor.rewrite":
            _rew_code = payload.get("code", "") or ""
            _rew_instr = payload.get("instruction", "") or ""
            _rew_lang = payload.get("language", "") or ""
            _chat_cfg = ai_chat_settings_store.get()
            if _chat_cfg.get("provider", "ollama") == "ollama":
                result = await editor_service.rewrite(
                    _az_base_url(),
                    payload.get("model") or ANALYZER_DEFAULT_MODEL,
                    _rew_code,
                    _rew_instr,
                    _rew_lang,
                )
            else:
                from .ai_chat_service import stream_chat as _stream_chat
                _lang_hint = f" ({_rew_lang})" if _rew_lang else ""
                _msgs = [{"role": "user", "content": (
                    f"Rewrite the following code{_lang_hint} per this instruction: {_rew_instr}\n\n"
                    f"```\n{_rew_code}\n```\n\nReturn ONLY the rewritten code, no explanation."
                )}]
                _chunks: list[str] = []
                async for _chunk in _stream_chat(_chat_cfg, _msgs, "You are a code rewriting assistant. Output only code.", max_tokens=2048):
                    if not _chunk.startswith("\x00"):
                        _chunks.append(_chunk)
                _text = "".join(_chunks).strip()
                # Strip markdown fences if model wrapped the code
                _text = re.sub(r'^```[a-zA-Z]*\n?', '', _text).strip()
                _text = re.sub(r'\n?```$', '', _text).strip()
                result = {"ok": True, "text": _text} if _text else {"ok": False, "error": "Empty response"}
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "editor.complete":
            result = await editor_service.complete(
                _az_base_url(),
                payload.get("model") or ANALYZER_DEFAULT_MODEL,
                payload.get("prefix", "") or "",
                payload.get("suffix", "") or "",
                payload.get("language", "") or "",
            )
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        # ── Onboarding (onboarding.*) ───────────────────────────────────────
        elif msg_type == "onboarding.status":
            status = await asyncio.to_thread(onboarding_deps.get_status)
            status["complete"] = onboarding_deps.is_complete()
            status["skip"] = onboarding_deps.should_skip()
            await session.websocket.send_json(make_response(msg_id, msg_type, status))

        elif msg_type == "onboarding.install":
            dep_id = payload.get("dep_id", "") or ""
            result = await asyncio.to_thread(onboarding_deps.install_dep, dep_id)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "onboarding.pull_model":
            model = payload.get("model", "") or onboarding_deps._SUGGESTED_MODEL
            result = onboarding_deps.pull_model(model)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "onboarding.complete":
            onboarding_deps.set_complete(bool(payload.get("complete", True)))
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True}))

        # ── AI Chat ──────────────────────────────────────────────────────────────
        elif msg_type == "ai.chat.settings.get":
            await session.websocket.send_json(make_response(msg_id, msg_type, ai_chat_settings_store.get()))

        elif msg_type == "ai.chat.settings.set":
            updated = ai_chat_settings_store.set(payload)
            await session.websocket.send_json(make_response(msg_id, msg_type, updated))

        elif msg_type == "ai.chat.start":
            session_id = payload.get("session_id", "") or str(__import__("uuid").uuid4())
            messages = payload.get("messages", []) or []
            workspace_path = payload.get("workspace_path", "") or ""
            system_suffix = payload.get("system_suffix", "") or ""
            system_prefix = payload.get("system_prefix", "") or ""
            settings = {**ai_chat_settings_store.get()}

            # Auto-inject workspace rules when frontend didn't already provide a prefix
            if not system_prefix and workspace_path:
                _cursor_rules_dir = Path(workspace_path) / ".cursor" / "rules"
                if _cursor_rules_dir.is_dir():
                    _mdc_parts: list[str] = []
                    for _mdc in sorted(_cursor_rules_dir.glob("*.mdc")):
                        try:
                            _raw = _mdc.read_text(encoding="utf-8", errors="replace")
                            if _raw.startswith("---") and "alwaysApply: true" in _raw:
                                _end = _raw.index("---", 3) if _raw.count("---") >= 2 else len(_raw)
                                _body = _raw[_end + 3:].strip()
                                if _body:
                                    _mdc_parts.append(_body[:4_000])
                        except OSError:
                            pass
                    if _mdc_parts:
                        system_prefix = "--- Project Rules ---\n" + "\n\n---\n\n".join(_mdc_parts) + "\n---\n\n"
                if not system_prefix:
                    for _rf in [".cursor/rules.md", ".cursorrules", "AGENTS.md", ".ai/rules.md",
                                ".ai/instructions.md", ".github/copilot-instructions.md"]:
                        _rp = Path(workspace_path) / _rf
                        if _rp.is_file():
                            try:
                                if _rp.stat().st_size <= 512_000:
                                    _rules = _rp.read_text(encoding="utf-8", errors="replace")[:8_000].strip()
                                    if _rules:
                                        system_prefix = f"--- Project Rules ---\n{_rules}\n---\n\n"
                            except OSError:
                                pass
                            break

            base_sys = settings.get("system_prompt", "You are a helpful AI coding assistant.")
            if system_prefix or system_suffix:
                sep = "" if (not system_prefix or system_prefix.endswith("\n")) else "\n"
                settings["system_prompt"] = (
                    f"{system_prefix}{sep}{base_sys}" + (f"\n\n{system_suffix}" if system_suffix else "")
                )

            async def _run_chat(sid=session_id, msgs=messages, ws_path=workspace_path, s=settings):
                from .ai_chat_tools import run_agent_loop
                async def _emit(event_type, data):
                    await broadcast(make_event(event_type, data))
                try:
                    await run_agent_loop(s, msgs, ws_path, sid, _emit)
                except Exception as e:
                    await broadcast(make_event("ai.chat.error", {"session_id": sid, "message": str(e)}))

            task = asyncio.create_task(_run_chat())
            session._chat_tasks.add(task)
            task.add_done_callback(session._chat_tasks.discard)
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True, "session_id": session_id}))

        elif msg_type == "ai.chat.accept_edit":
            ws_path = payload.get("workspace_path", "") or ""
            file_path = payload.get("file_path", "") or ""
            new_content = payload.get("new_content", "") or ""
            result = fs_service.write_file(ws_path, file_path, new_content)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "ai.chat.approve_command":
            from .ai_chat_tools import approve_command
            approve_command(
                str(payload.get("session_id", "")),
                str(payload.get("tool_id", "")),
                approved=True,
            )
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True}))

        elif msg_type == "ai.chat.reject_command":
            from .ai_chat_tools import approve_command
            approve_command(
                str(payload.get("session_id", "")),
                str(payload.get("tool_id", "")),
                approved=False,
            )
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True}))

        elif msg_type == "ai.chat.stop":
            for t in list(session._chat_tasks):
                t.cancel()
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True}))

        elif msg_type == "ai.chat.test_connection":
            _tc_provider = (payload.get("provider") or "").strip()
            _tc_key = (payload.get("api_key") or "").strip()
            _tc_base_url = (payload.get("base_url") or "").strip().rstrip("/")
            _tc_ollama_url = (payload.get("ollama_base_url") or "http://localhost:11434").strip().rstrip("/")
            _tc_ok = False
            _tc_err = ""
            try:
                import httpx as _httpx
                if _tc_provider == "anthropic":
                    import anthropic as _ant
                    _ant_client = _ant.AsyncAnthropic(api_key=_tc_key or None)
                    async with asyncio.timeout(10):
                        await _ant_client.models.list(limit=1)
                    _tc_ok = True
                elif _tc_provider == "ollama":
                    async with _httpx.AsyncClient(timeout=8.0) as _hc:
                        _r = await _hc.get(f"{_tc_ollama_url}/api/tags")
                        _r.raise_for_status()
                    _tc_ok = True
                else:
                    from .ai_chat_service import _OPENAI_COMPAT_CONFIGS
                    _cfg = _OPENAI_COMPAT_CONFIGS.get(_tc_provider, {})
                    if "base_url_field" in _cfg:
                        _url = _tc_base_url
                    else:
                        _url = _cfg.get("base_url", "")
                    if not _url:
                        raise ValueError(f"No base URL for provider '{_tc_provider}'")
                    _headers: dict = {}
                    if _tc_key:
                        _headers["Authorization"] = f"Bearer {_tc_key}"
                    async with _httpx.AsyncClient(timeout=8.0) as _hc:
                        _r = await _hc.get(f"{_url}/models", headers=_headers)
                        _r.raise_for_status()
                    _tc_ok = True
            except Exception as _e:
                _tc_err = str(_e)
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": _tc_ok, "error": _tc_err}))

        elif msg_type == "ai.enhance_prompt":
            _ep_system = (payload.get("system") or "").strip()
            _ep_prompt = (payload.get("prompt") or "").strip()[:4000]
            _ep_model = (payload.get("model") or "").strip()
            _ep_provider = (payload.get("provider") or "").strip()
            if not _ep_prompt:
                await session.websocket.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "prompt is required"))
            else:
                try:
                    from .ai_chat_service import stream_chat
                    # Use a shallow copy of session settings, overriding model if specified
                    _ep_settings = dict(session.settings)
                    if _ep_provider:
                        _ep_settings["provider"] = _ep_provider
                    if _ep_model:
                        _ep_settings["model"] = _ep_model
                    _ep_content = ""
                    async with asyncio.timeout(30):
                        async for _ep_chunk in stream_chat(
                            settings=_ep_settings,
                            messages=[{"role": "user", "content": _ep_prompt}],
                            system=_ep_system,
                            max_tokens=1024,
                        ):
                            if _ep_chunk.startswith("\x00"):
                                break  # DONE or TOOL sentinel
                            _ep_content += _ep_chunk
                    await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True, "content": _ep_content.strip()}))
                except Exception as _ep_exc:
                    await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": False, "error": str(_ep_exc)}))

        elif msg_type == "ai.web.search":
            query = (payload.get("query") or "").strip()[:200]
            if not query:
                await session.websocket.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "query is required"))
            else:
                try:
                    import httpx as _httpx
                    from html.parser import HTMLParser as _HTMLParser

                    class _DDGLiteParser(_HTMLParser):
                        """Parse DuckDuckGo Lite HTML to extract search results."""
                        def __init__(self) -> None:
                            super().__init__()
                            self.results: list[dict] = []
                            self._in_result = False
                            self._cur: dict = {}
                            self._capture: str | None = None

                        def handle_starttag(self, tag: str, attrs: list) -> None:
                            amap = dict(attrs)
                            # Result links in DDG Lite are <a class="result-link">
                            if tag == "a" and "result-link" in (amap.get("class") or ""):
                                self._cur = {"url": amap.get("href", ""), "title": "", "snippet": ""}
                                self._in_result = True
                                self._capture = "title"
                            elif tag == "td" and self._in_result and "result-snippet" in (amap.get("class") or ""):
                                self._capture = "snippet"

                        def handle_endtag(self, tag: str) -> None:
                            if tag == "a" and self._capture == "title":
                                self._capture = None
                            elif tag == "td" and self._capture == "snippet":
                                self._capture = None
                                if self._cur.get("url"):
                                    # Strip accumulated whitespace now that the field is complete
                                    self._cur["title"] = self._cur.get("title", "").strip()
                                    self._cur["snippet"] = self._cur.get("snippet", "").strip()
                                    self.results.append(self._cur)
                                self._in_result = False
                                self._cur = {}

                        def handle_data(self, data: str) -> None:
                            if self._capture and self._cur:
                                # Accumulate without stripping — strip only when finalising
                                self._cur[self._capture] = self._cur.get(self._capture, "") + data

                    results: list[dict] = []
                    headers = {
                        "User-Agent": "Mozilla/5.0 (compatible; AgentTeamIDE/1.0)",
                        "Accept-Language": "en-US,en;q=0.9",
                    }
                    async with _httpx.AsyncClient(timeout=10.0, follow_redirects=True) as _hc:
                        # Primary: DDG Lite HTML (proper search results, no API key)
                        try:
                            lite_resp = await _hc.get(
                                "https://lite.duckduckgo.com/lite/",
                                params={"q": query, "kl": "us-en"},
                                headers=headers,
                            )
                            lite_resp.raise_for_status()
                            parser = _DDGLiteParser()
                            parser.feed(lite_resp.text)
                            results = parser.results[:7]
                        except Exception:
                            pass
                        # Fallback: DDG Instant Answers API
                        if not results:
                            ia_resp = await _hc.get(
                                "https://api.duckduckgo.com/",
                                params={"q": query, "format": "json", "no_html": "1", "skip_disambig": "1"},
                                headers=headers,
                            )
                            ia_resp.raise_for_status()
                            data = ia_resp.json()
                            if data.get("AbstractText"):
                                results.append({"title": data.get("Heading", query), "snippet": data["AbstractText"], "url": data.get("AbstractURL", "")})
                            for item in (data.get("RelatedTopics") or [])[:6]:
                                if isinstance(item, dict) and item.get("Text"):
                                    results.append({"title": item.get("Text", "")[:80], "snippet": item.get("Text", ""), "url": item.get("FirstURL", "")})

                    await session.websocket.send_json(make_response(msg_id, msg_type, {"query": query, "results": results[:7]}))
                except Exception as _e:
                    await session.websocket.send_json(make_error(msg_id, msg_type, "SEARCH_ERROR", str(_e)))

        elif msg_type == "ai.review.stop":
            for t in list(session._review_tasks):
                t.cancel()
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True}))

        elif msg_type == "ai.review.start":
            # Cancel any in-progress review before starting a new one.
            for _t in list(session._review_tasks):
                _t.cancel()
            session._review_tasks.clear()
            ws_path = payload.get("workspace_path") or ""
            review_id = payload.get("review_id") or str(__import__("uuid").uuid4())
            mode = payload.get("mode") or "working"  # "working" | "branch"
            base = payload.get("base") or ""
            compare = payload.get("compare") or ""
            settings = {**ai_chat_settings_store.get()}

            async def _run_review(rid=review_id, m=mode, b=base, c=compare, s=settings, ws=ws_path):
                import re as _re
                import json as _json
                from .review_service import stream_review
                try:
                    if m == "branch":
                        _b = b or "main"
                        if not c:
                            _rc, _cur, _ = await git_service._run(
                                ["git", "rev-parse", "--abbrev-ref", "HEAD"], ws
                            )
                            _c = _cur.strip() if _rc == 0 and _cur.strip() else "HEAD"
                        else:
                            _c = c
                        diff_result = await git_service.diff_branches(ws, _b, _c)
                        diff = diff_result.get("diff", "") if diff_result.get("ok") else ""
                    else:
                        # working mode: staged + unstaged (git diff HEAD)
                        diff_result = await git_service.diff_branches(ws, "", "")
                        diff = diff_result.get("diff", "") if diff_result.get("ok") else ""
                    _truncated = diff_result.get("truncated", False) if diff_result.get("ok") else False
                    chunks: list[str] = []
                    async for chunk in stream_review(s, diff, truncated=_truncated):
                        chunks.append(chunk)
                    # Parse and validate structured JSON result from streamed text
                    full_text = "".join(chunks)
                    try:
                        # Use raw_decode so it stops at the matching closing brace,
                        # handling both: (a) embedded ```fences``` inside JSON string
                        # values (where .*? would truncate) and (b) multiple JSON
                        # blocks in the output (where .* would merge them).
                        _fence_mo = _re.search(r"```json\s*", full_text)
                        raw = None
                        if _fence_mo:
                            try:
                                raw, _ = _json.JSONDecoder().raw_decode(
                                    full_text[_fence_mo.end():].lstrip()
                                )
                            except _json.JSONDecodeError:
                                raw = None
                        if raw:
                            _VALID_VERDICTS = {"approve", "approve_with_comments", "request_changes"}
                            _VALID_SEVS = {"critical", "warning", "suggestion"}
                            validated: dict = {
                                "summary": str(raw.get("summary", "")),
                                "verdict": raw.get("verdict") if raw.get("verdict") in _VALID_VERDICTS else "approve_with_comments",
                                "findings": [],
                            }
                            for _i, _f in enumerate(raw.get("findings") or []):
                                if not isinstance(_f, dict):
                                    continue
                                validated["findings"].append({
                                    "id": str(_f.get("id") or f"f{_i}"),
                                    "file": str(_f.get("file") or ""),
                                    "line": _f["line"] if isinstance(_f.get("line"), int) else None,
                                    "severity": _f.get("severity") if _f.get("severity") in _VALID_SEVS else "suggestion",
                                    "title": str(_f.get("title") or ""),
                                    "body": str(_f.get("body") or ""),
                                })
                            await broadcast(make_event("ai.review.result", {"review_id": rid, "result": validated}))
                        else:
                            log.warning("ai.review: no ```json block found in LLM output")
                    except Exception:
                        log.warning("ai.review: failed to parse JSON from streamed output")
                    await broadcast(make_event("ai.review.end", {"review_id": rid}))
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    log.exception("ai.review.start failed: %s", exc)
                    await broadcast(make_event("ai.review.error", {"review_id": rid, "message": str(exc)}))

            task = asyncio.create_task(_run_review())
            session._review_tasks.add(task)
            task.add_done_callback(session._review_tasks.discard)
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True, "review_id": review_id}))

        else:
            await session.websocket.send_json(
                make_error(msg_id, msg_type, "UNKNOWN_TYPE", f"Unsupported message type: {msg_type!r}")
            )
    except FileNotFoundError as err:
        await session.websocket.send_json(
            make_error(msg_id, msg_type, "SETUP_ERROR", str(err))
        )
    except KeyError as err:
        await session.websocket.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", f"missing field: {err}")
        )
    except Exception as err:  # noqa: BLE001
        log.exception("handle_message failed for type=%s", msg_type)
        await session.websocket.send_json(
            make_error(msg_id, msg_type, "INTERNAL_ERROR", str(err))
        )
