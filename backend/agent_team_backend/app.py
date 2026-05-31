from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from . import __version__
from .analyzer import (
    DEFAULT_MODEL as ANALYZER_DEFAULT_MODEL,
    classify as analyzer_classify,
    health as analyzer_health,
    list_models as analyzer_list_models,
    auto_answer as analyzer_auto_answer,
    benchmark as analyzer_benchmark,
)
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

# Log readers: one per vendor. Attribution maps log session files to panes.
_readers = [ClaudeLogReader(), CodexLogReader(), GeminiLogReader()]
attribution = Attribution(_readers)
_log_watcher: LogWatcher | None = None


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

    async def _send_event(self, event: dict[str, Any]) -> None:
        try:
            await self.websocket.send_json(event)
        except Exception as err:  # noqa: BLE001
            log.warning("send_event failed: %s", err)


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
        # already-counted events safe.
        _log_watcher.force_rescan()


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
    global _log_watcher
    if _log_watcher is not None:
        _log_watcher.stop()
    await mcp_manager.shutdown()
    _log_watcher = None


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
            msg = await websocket.receive_json()
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

        # -------- stages registry --------
        elif msg_type == "stages.list":
            await session.websocket.send_json(
                make_response(
                    msg_id,
                    msg_type,
                    {"stages": stages_store.list(), "path": str(stages_store.path)},
                )
            )
        elif msg_type == "stages.upsert":
            stage = stages_store.upsert(payload["stage"])
            updated_stages = stages_store.list()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"stage": stage, "stages": updated_stages})
            )
            await broadcast(
                make_event("stages.changed", {"stages": updated_stages, "reason": "upsert"})
            )
        elif msg_type == "stages.reorder":
            updated_stages = stages_store.reorder(payload["ids"])
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"stages": updated_stages})
            )
            await broadcast(
                make_event("stages.changed", {"stages": updated_stages, "reason": "reorder"})
            )
        elif msg_type == "stages.delete":
            updated_stages = stages_store.delete(payload["id"])
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"stages": updated_stages})
            )
            await broadcast(
                make_event("stages.changed", {"stages": updated_stages, "reason": "delete"})
            )
        elif msg_type == "stages.reset":
            updated_stages = stages_store.reset()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"stages": updated_stages})
            )
            await broadcast(
                make_event("stages.changed", {"stages": updated_stages, "reason": "reset"})
            )

        # -------- analyzer (local LLM) --------
        elif msg_type == "analyzer.health":
            data = await analyzer_health()
            data["default_model"] = ANALYZER_DEFAULT_MODEL
            await session.websocket.send_json(make_response(msg_id, msg_type, data))
        elif msg_type == "analyzer.models":
            models = await analyzer_list_models()
            await session.websocket.send_json(
                make_response(msg_id, msg_type, {"models": models, "default": ANALYZER_DEFAULT_MODEL})
            )
        elif msg_type == "analyzer.classify":
            text = payload.get("text", "") or ""
            model = payload.get("model") or ANALYZER_DEFAULT_MODEL
            result = await analyzer_classify(text, model=model)
            _record_analyzer_tokens(result, payload)
            await session.websocket.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "analyzer.benchmark":
            # Start benchmark in a background task; stream progress via broadcast.
            async def _benchmark_bg() -> None:
                async def _on_progress(
                    model: str, task_id: str, passed: bool, elapsed_s: float, score: int
                ) -> None:
                    await broadcast(make_event("analyzer.benchmark_progress", {
                        "model": model,
                        "task_id": task_id,
                        "passed": passed,
                        "elapsed_s": elapsed_s,
                        "score": score,
                    }))

                try:
                    results = await analyzer_benchmark(progress_cb=_on_progress)
                    await broadcast(make_event("analyzer.benchmark_done", {"results": results}))
                except Exception as _bench_err:  # noqa: BLE001
                    log.warning("benchmark error: %s", _bench_err)
                    await broadcast(make_event("analyzer.benchmark_done", {"results": [], "error": str(_bench_err)}))

            asyncio.create_task(_benchmark_bg())
            await session.websocket.send_json(make_response(msg_id, msg_type, {"ok": True, "started": True}))

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
