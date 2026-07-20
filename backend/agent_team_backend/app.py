from __future__ import annotations

import asyncio
import base64
import functools
import logging
import mimetypes
import os
import re
import shlex
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import ValidationError
from uvicorn.protocols.utils import ClientDisconnected

from . import __version__
from .analyzer import DEFAULT_MODEL as ANALYZER_DEFAULT_MODEL
from .analyzer import (
    classify as _llama_classify,
    health as _llama_health,
    list_models as _llama_list_models,
    auto_answer as _llama_auto_answer,
    benchmark as _llama_benchmark,
    llama_cli_busy as _llama_cli_busy,
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
from .applog import app_data_dir, backend_log_path, backend_port_file
from .claude_hooks import install_hooks as install_claude_hooks
from .codex_home import CodexHomeManager
from .ipc import make_error, make_event, make_response
from .log_readers import (
    ActivityEvent,
    AntigravityLogReader,
    ClaudeLogReader,
    CodexLogReader,
    GrokLogReader,
    KimiLogReader,
    LogWatcher,
    TokenSinkResult,
    TokenUsage,
)
from .log_readers.attribution import Attribution
from .doc_injector import fetch_stage_docs
from .mcp_manager import MCPManager
from .mcp_settings import MCPServersDocument, MCPSettingsStore
from .plan_provisioning import ensure_plan_assets, plan_spec_exists
from .chat_store import ChatStore
from .projects import ProjectStore
from .recent_workspaces import RecentWorkspacesStore
from .roles_store import RolesStore
from .stages_store import StagesStore
from .terminals import TerminalService
from .tokens_store import TokensStore
from .ui_settings import UiSettingsStore
from .history_store import HistoryStore
from . import git_service
from . import issue_service
from . import fs_service
from . import pty_registry
from . import search_service
from . import editor_service
from . import onboarding_deps
from . import plan_history
from .git_watcher import GitWatcher

log = logging.getLogger("agent_team_backend")

STARTED_AT = datetime.now(timezone.utc).isoformat()

app = FastAPI(title="navide-backend", version=__version__)

project_store = ProjectStore()
recent_workspaces_store = RecentWorkspacesStore()
roles_store = RolesStore()
stages_store = StagesStore()
tokens_store = TokensStore()
history_store = HistoryStore()
codex_home_manager = CodexHomeManager()
mcp_manager = MCPManager()
mcp_settings_store = MCPSettingsStore()
analyzer_settings_store = AnalyzerSettingsStore()
ai_chat_settings_store = AIChatSettingsStore()
ui_settings_store = UiSettingsStore()
chat_store = ChatStore()

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

_AI_SECRET_KEYS = {
    "anthropic_api_key",
    "openai_api_key",
    "google_api_key",
    "groq_api_key",
    "deepseek_api_key",
    "mistral_api_key",
    "xai_api_key",
    "openai_compatible_api_key",
}


def _settings_paths() -> dict[str, str]:
    return {
        "app_data_dir": str(app_data_dir()),
        "roles": str(roles_store.path),
        "pipelines": str(stages_store.path),
        "mcp": str(mcp_settings_store.path),
        "analyzer": str(analyzer_settings_store.path),
        "ai_chat": str(ai_chat_settings_store.path),
        "backend_log": str(backend_log_path()),
    }


def _redact_ai_chat_settings(settings: dict[str, Any]) -> dict[str, Any]:
    return {
        key: ("__redacted__" if key in _AI_SECRET_KEYS and value else value)
        for key, value in settings.items()
        if key != "model"
    }


def _settings_bundle() -> dict[str, Any]:
    return {
        "format_version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "paths": _settings_paths(),
        "roles": roles_store.list(),
        "pipelines_document": stages_store.export_document(),
        "mcp_servers": mcp_settings_store.list_servers(),
        "analyzer": analyzer_settings_store.get(),
        "ai_chat": _redact_ai_chat_settings(ai_chat_settings_store.get()),
        "notes": {
            "secrets": "API keys and tokens are redacted and are not restored on import.",
        },
    }


async def _test_ai_provider(provider: str, overrides: dict[str, Any]) -> dict[str, Any]:
    settings = {**ai_chat_settings_store.get(), **overrides}
    provider = provider or settings.get("provider", "ollama")
    try:
        import httpx
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "message": f"httpx unavailable: {err}"}

    def _key(name: str) -> str:
        return str(settings.get(name, "") or "").strip()

    base_urls = {
        "openai": "https://api.openai.com/v1",
        "groq": "https://api.groq.com/openai/v1",
        "deepseek": "https://api.deepseek.com/v1",
        "mistral": "https://api.mistral.ai/v1",
        "xai": "https://api.x.ai/v1",
    }
    key_fields = {
        "anthropic": "anthropic_api_key",
        "openai": "openai_api_key",
        "google": "google_api_key",
        "groq": "groq_api_key",
        "deepseek": "deepseek_api_key",
        "mistral": "mistral_api_key",
        "xai": "xai_api_key",
        "openai_compatible": "openai_compatible_api_key",
    }
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            if provider == "ollama":
                base = str(settings.get("ollama_base_url") or "http://localhost:11434").rstrip("/")
                resp = await client.get(f"{base}/api/tags")
            elif provider == "google":
                api_key = _key("google_api_key")
                if not api_key:
                    return {"ok": False, "message": "Missing Google Gemini API key"}
                resp = await client.get(
                    "https://generativelanguage.googleapis.com/v1beta/models",
                    params={"key": api_key},
                )
            elif provider == "anthropic":
                api_key = _key("anthropic_api_key")
                if not api_key:
                    return {"ok": False, "message": "Missing Anthropic API key"}
                resp = await client.get(
                    "https://api.anthropic.com/v1/models",
                    headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                )
            elif provider == "openai_compatible":
                base = str(settings.get("openai_compatible_base_url") or "").rstrip("/")
                if not base:
                    return {"ok": False, "message": "Missing OpenAI-compatible base URL"}
                headers = {}
                api_key = _key("openai_compatible_api_key")
                if api_key:
                    headers["Authorization"] = f"Bearer {api_key}"
                resp = await client.get(f"{base}/models", headers=headers)
            elif provider in base_urls:
                api_key = _key(key_fields[provider])
                if not api_key:
                    return {"ok": False, "message": f"Missing {provider} API key"}
                resp = await client.get(
                    f"{base_urls[provider]}/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
            else:
                return {"ok": False, "message": f"Unsupported provider: {provider}"}
        if 200 <= resp.status_code < 300:
            return {"ok": True, "message": f"Connection OK ({resp.status_code})", "status": resp.status_code}
        text = resp.text[:240].replace("\n", " ")
        return {"ok": False, "message": f"HTTP {resp.status_code}: {text}", "status": resp.status_code}
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "message": str(err)}

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
_readers = [ClaudeLogReader(), CodexLogReader(), AntigravityLogReader(), GrokLogReader(), KimiLogReader()]
attribution = Attribution(_readers)
_log_watcher: LogWatcher | None = None
_git_watcher: GitWatcher | None = None


# Module-level registry of all currently-connected WebSocket sessions so that
# state changes (e.g. roles edits) can be broadcast to every window the user
# has open (main + role manager + future windows).
_SESSIONS: set["Session"] = set()


async def broadcast(event: dict[str, Any], *, exclude: "Session | None" = None) -> None:
    """Fire-and-forget send to every connected session (optionally minus one)."""
    for session in list(_SESSIONS):
        if session is exclude:
            continue
        try:
            await session.send_json(event)
        except Exception as err:  # noqa: BLE001
            # send_json already marks dead + discards on send failure; this is
            # a defensive net for anything unexpected it re-raised.
            log.warning("broadcast send failed: %s", err)
            _SESSIONS.discard(session)


class Session:
    """Per-WebSocket-connection state."""

    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        # Handlers run as concurrent tasks and the PTY output pump writes too;
        # the websockets protocol forbids concurrent writes on one connection
        # (its drain assertion trips and wedges the socket permanently), so
        # every outbound frame must go through send_json() below.
        self._send_lock = asyncio.Lock()
        # Token attribution now happens via log_readers (background log scan),
        # NOT via PTY output. The TerminalService is app-level (PTYs outlive this
        # connection); output routes back through _active_emit → the attached
        # Session's send_json. See get_terminals().
        self.terminals = get_terminals()
        # Track background tasks so they can be cancelled on disconnect.
        self._chat_tasks: set[asyncio.Task] = set()
        self._review_tasks: set[asyncio.Task] = set()
        # In-flight handle_message tasks; cancelled in ws() finally so handlers
        # never outlive the connection and drain onto a closed socket.
        self._handler_tasks: set[asyncio.Task] = set()
        # In-flight find_in_files cancellation handle: a newer search from
        # this session sets the event so the superseded scan stops early.
        self._search_cancel: threading.Event | None = None
        # Set once the peer is gone (send failed or ws() loop exited). All
        # further send_json calls become silent no-ops.
        self.dead = False

    async def send_json(self, data: dict[str, Any]) -> None:
        """Serialized websocket send — sole writer for this connection.

        Never raises on a dead peer: the first send failure marks the session
        dead and removes it from _SESSIONS; subsequent calls are silent no-ops.
        Callers must not crash just because the client went away.
        """
        if self.dead:
            return
        try:
            async with self._send_lock:
                await self.websocket.send_json(data)
        except (RuntimeError, WebSocketDisconnect, ClientDisconnected) as err:
            # RuntimeError: starlette's 'Cannot call "send" once a close
            # message has been sent'; ClientDisconnected: uvicorn transport
            # torn down mid-send.
            self.dead = True
            _SESSIONS.discard(self)
            log.warning("ws send failed; marking session %#x dead: %s", id(self), err)

    async def _send_event(self, event: dict[str, Any]) -> None:
        try:
            await self.send_json(event)
        except Exception as err:  # noqa: BLE001
            log.warning("send_event failed: %s", err)


async def _broadcast_git_changed(ws_path: str) -> None:
    """GitWatcher sink: a repo's working tree / .git changed on disk."""
    await broadcast(make_event("git.changed", {"workspace_path": ws_path}))


async def _broadcast_plans_changed(ws_path: str) -> None:
    """GitWatcher plans sink: a plan document under `.agent-team/plans/`
    changed on disk (any writer — App write path or an agent CLI editing the
    file directly). Record stage-transition snapshots first so subscribers
    refreshing on the event see up-to-date history, then notify."""
    try:
        await asyncio.to_thread(plan_history.snapshot_plans, ws_path)
    except Exception as err:  # noqa: BLE001
        log.warning("plan snapshot scan failed for %s: %s", ws_path, err)
    await broadcast(make_event("plans.changed", {"workspace_path": ws_path}))


def _watch_plans_workspace(ws_path: str, rel_path: str) -> None:
    """A plans-subtree fs access means a plan surface is open — start watching
    that workspace (idempotent) so plan edits push `plans.changed`."""
    if _git_watcher is not None and rel_path.startswith(".agent-team/plans"):
        _git_watcher.watch(ws_path)


_ASKPASS_PROMPT_URL_RE = re.compile(r"for '([^']+)'")


def _extract_host_from_prompt(prompt: str) -> str:
    """Best-effort remote host extraction from a git askpass prompt, e.g.
    "Username for 'https://gitlab.com': " -> "gitlab.com". Empty string if the
    prompt doesn't match git's usual "<field> for '<url>':" format."""
    match = _ASKPASS_PROMPT_URL_RE.search(prompt)
    if not match:
        return ""
    try:
        return urlparse(match.group(1)).hostname or ""
    except ValueError:
        return ""


def build_credential_request_emitter(
    workspace_path: str,
) -> Callable[[str, str], Awaitable[None]]:
    """Build the `on_request` callback for git_service.create_askpass_context()
    (Phase C). Broadcasts a git.credential_request event to every connected
    session; frontends filter by workspace_path, same convention as
    git.changed. Each call corresponds to exactly one askpass prompt (git asks
    Username and Password as separate invocations), so `request_id` here
    identifies a single field's answer, not a combined credential pair."""

    async def _on_request(request_id: str, prompt: str) -> None:
        await broadcast(
            make_event(
                "git.credential_request",
                {
                    "request_id": request_id,
                    "workspace_path": workspace_path,
                    "host": _extract_host_from_prompt(prompt),
                    "prompt": prompt,
                },
            )
        )

    return _on_request


def build_credential_settled_emitter(
    workspace_path: str,
) -> Callable[[str, str | None], Awaitable[None]]:
    """Build the `on_settled` callback for git_service.create_askpass_context()
    (Phase C). Emits git.credential_cancelled only when a request settles with
    no value (timeout or explicit cancellation), so the frontend can close its
    modal; a successful submission needs no further event."""

    async def _on_settled(request_id: str, value: str | None) -> None:
        if value is None:
            await broadcast(
                make_event(
                    "git.credential_cancelled",
                    {"request_id": request_id, "workspace_path": workspace_path},
                )
            )

    return _on_settled


def _git_credential(payload: dict[str, Any]) -> dict[str, str] | None:
    """Extract a bound-account credential from a git op payload, if the renderer
    attached one (main-process safeStorage store, decrypted just for this op).
    Returns None when absent/malformed so git_service falls back to the normal
    interactive askpass flow."""
    cred = payload.get("credential")
    if isinstance(cred, dict) and cred.get("token"):
        return {"username": str(cred.get("username") or ""), "token": str(cred.get("token"))}
    return None


# ── App-level terminal ownership (true persistence) ──────────────────────────
# PTYs must outlive any single WebSocket: a renderer reload / window close drops
# the ws, but the terminal (agent CLI, bash, build) keeps running in the
# background until it exits, the user explicitly kills the pane, or the whole
# app quits. So a single app-level TerminalService owns every PTY.
# Output is routed per-PTY: each terminal session is owned by whichever WS
# Session created or last reattached to it. A second window never steals PTYs
# it didn't explicitly claim via terminal.create / terminal.reattach.
_TERMINALS: TerminalService | None = None
# terminal_session_id → owning WS Session. Populated on terminal.create and
# updated on terminal.reattach. Entries removed when the owning WS disconnects.
_PTY_OWNERS: "dict[str, Session]" = {}


# An autonomous PTY death (exit/EOF) must release the attribution registration
# — otherwise the pane's session marker leaks in _unbound_markers forever. But
# the release is DELAYED: the CLI's final log flush reaches attribution through
# the watcher's queue drain / 30s rescan AFTER the exit event, and a marker
# session may still bind late (short-lived run). Immediate unregister would
# drop that usage tail and the pane's resume id. terminal.create for the same
# pane cancels the pending cleanup (a renderer-reload respawn keeps its pane id).
_UNREGISTER_GRACE_SEC = 90.0
_PENDING_UNREGISTERS: dict[str, asyncio.TimerHandle] = {}


def _schedule_pane_unregister(pane_id: str) -> None:
    _cancel_pane_unregister(pane_id)

    def _fire() -> None:
        _PENDING_UNREGISTERS.pop(pane_id, None)
        attribution.unregister_pane(pane_id)

    _PENDING_UNREGISTERS[pane_id] = asyncio.get_running_loop().call_later(
        _UNREGISTER_GRACE_SEC, _fire
    )


def _cancel_pane_unregister(pane_id: str) -> None:
    handle = _PENDING_UNREGISTERS.pop(pane_id, None)
    if handle:
        handle.cancel()


async def _active_emit(event: dict[str, Any]) -> None:
    """Output sink: route each PTY's output to its owning Session."""
    payload = event.get("payload", {})
    # Runs before the owner check: cleanup applies even when the pane is
    # detached.
    if event.get("type") == "terminal.exit" and isinstance(payload, dict):
        exit_pane_id = payload.get("pane_id")
        if exit_pane_id:
            _schedule_pane_unregister(exit_pane_id)
    session_id = payload.get("terminal_session_id") if isinstance(payload, dict) else None
    if session_id and event.get("type") == "terminal.exit":
        sess = _PTY_OWNERS.pop(session_id, None)
    else:
        sess = _PTY_OWNERS.get(session_id) if session_id else None
    if sess is None:
        return  # detached: drop output, PTY keeps running, TUI redraws on reattach
    try:
        await sess.send_json(event)
    except Exception as err:  # noqa: BLE001
        log.warning("terminal output send failed: %s", err)


def get_terminals() -> TerminalService:
    """The one app-level TerminalService. Lazy (not at import) because
    TerminalService.__init__ binds to the running event loop."""
    global _TERMINALS
    if _TERMINALS is None:
        _TERMINALS = TerminalService(emit=_active_emit)
    return _TERMINALS


def _claim_ptys(session: "Session", terminal_session_ids: list[str]) -> None:
    """Transfer ownership of the given PTY ids to `session`."""
    for tid in terminal_session_ids:
        _PTY_OWNERS[tid] = session


async def _maybe_announce_session(usage: TokenUsage) -> None:
    """Codex/Antigravity/Grok: when a session file is first matched to its pane,
    tell the frontend so it can persist the id/path for resume-on-restart."""
    bound = await asyncio.to_thread(attribution.maybe_announce_session, usage)
    if not bound:
        return
    await broadcast(make_event("session.detected", {
        "vendor": usage.vendor,
        "pane_id": bound.pane_id,
        "session_id": bound.resume_id,  # the id/path `<cli> resume` actually needs
        "workspace_path": bound.workspace_path or usage.cwd,
        "session_file": bound.session_file,
    }))


async def _on_session_file(vendor: str, path: Path) -> None:
    """Watcher session sink: a Codex/Antigravity/Grok session file changed. Attempt
    marker binding directly off the file (decoupled from token parsing, so it works
    for session-file formats the token reader doesn't understand)."""
    reader = next((r for r in _readers if r.vendor == vendor), None)
    usage = TokenUsage(
        vendor=vendor, input_tokens=0, output_tokens=0,
        cwd=reader.cwd_from_file(path) if reader else "",
        session_id=path.stem, file_path=str(path), dedup_key="",
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


# A startup rescan of historical CLI logs emits thousands of token events in a
# burst; broadcasting a full workspace snapshot per event saturated the event
# loop and starved concurrent requests past the frontend's 10s timeout (real
# case: terminal.create timeouts during session restore, 2026-07-14). Coalesce
# to at most one broadcast per workspace per window; the trailing snapshot
# includes every record accumulated during the wait.
_TOKENS_BROADCAST_DEBOUNCE_SEC = 0.3
_pending_tokens_broadcast: set[str] = set()


def _schedule_tokens_broadcast(workspace_path: str) -> None:
    if workspace_path in _pending_tokens_broadcast:
        return
    _pending_tokens_broadcast.add(workspace_path)

    async def _fire() -> None:
        try:
            await asyncio.sleep(_TOKENS_BROADCAST_DEBOUNCE_SEC)
        finally:
            _pending_tokens_broadcast.discard(workspace_path)
        await broadcast(
            make_event("tokens.changed", tokens_store.snapshot(workspace_path))
        )

    asyncio.create_task(_fire())


async def _on_log_token_usage(usage: TokenUsage) -> TokenSinkResult:
    """Sink for token events from CLI log files.

    Drops events not associated with any registered Agent-Team workspace so
    the All-time tally only counts usage in workspaces the user has actually
    opened in Agent-Team. Passes the event's dedup_key to tokens_store so
    re-rescans after workspace registration don't double-count.
    """
    try:
        attributed = attribution.attribute(usage)
        if usage.replay_workspace:
            if attributed.workspace_path != usage.replay_workspace:
                # Shared sources (notably Grok's single SQLite DB) contain rows
                # for many workspaces. This row is safely consumed for the
                # target workspace, but must not be attributed or retried.
                return TokenSinkResult(True)
            workspace_path = usage.replay_workspace
        else:
            workspace_path = attributed.workspace_path
        if workspace_path is None:
            # External session — outside any registered workspace. Skip silently.
            return TokenSinkResult(False)
        # Namespace the dedup key by vendor + file_path so collisions across
        # vendors (unlikely but possible) can't masquerade as the same event.
        composite_key = f"{usage.vendor}::{usage.file_path}::{usage.dedup_key}"
        handled = tokens_store.record(
            workspace_path,
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
            ingestion_file=usage.file_path,
            ingestion_checkpoint=usage.checkpoint,
            replay_workspace=usage.replay_workspace,
            legacy_dedup_key=usage.dedup_key,
        )
        _schedule_tokens_broadcast(workspace_path)
        return TokenSinkResult(handled, workspace_path)
    except Exception as err:  # noqa: BLE001
        log.warning("log token sink failed: %s", err)
        return TokenSinkResult(False)


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
    # Provision plan-document infrastructure (_spec.md + _template.html) into
    # <workspace>/.agent-team/plans/. Idempotent, never overwrites, never
    # raises — see plan_provisioning.
    ensure_plan_assets(workspace_path)
    if is_new and _log_watcher is not None:
        # New association → parse from this workspace's independent checkpoint
        # so cumulative populates without double-counting Global. Scope to THIS
        # workspace so we don't
        # re-parse the entire (multi-GB) Claude history and stall the loop.
        #
        # force_rescan still enumerates session files synchronously (Codex
        # readers fall back to ALL their files), which blocks the event
        # loop and stalls every terminal.create queued behind it. Run it
        # off-loop so spawns return immediately; the rescan only backfills
        # stats, so its timing isn't on the critical path.
        watcher = _log_watcher
        try:
            asyncio.get_running_loop().run_in_executor(
                None, watcher.force_rescan, workspace_path
            )
        except RuntimeError:
            # No running loop (non-async caller) — fall back to inline.
            watcher.force_rescan(workspace_path)


@app.on_event("startup")
async def _start_log_watcher() -> None:
    # Reap PTY children left behind by a previous run that died without its
    # shutdown sweep (SIGKILL, crash). Blocking ps/sleep — off the loop.
    try:
        await asyncio.to_thread(pty_registry.reap_stale)
    except Exception as err:  # noqa: BLE001
        log.warning("pty orphan reap failed: %s", err)

    global _log_watcher
    _log_watcher = LogWatcher(
        sink=_on_log_token_usage,
        activity_sink=_on_log_activity,
        session_sink=_on_session_file,
        # Scope periodic/startup backfill to opened workspaces so the drain task
        # never re-stats the entire multi-GB CLI history (which stalled the loop).
        workspace_provider=attribution.known_workspaces,
        checkpoint_provider=tokens_store.get_ingestion_checkpoint,
        checkpoint_sink=tokens_store.advance_ingestion_checkpoint,
    )
    for r in _readers:
        _log_watcher.add_reader(r)
    _log_watcher.start()

    # Git filesystem watcher: fires `git.changed` near-instantly when the
    # working tree or `.git` state changes on disk (external edits, another
    # terminal running git). Workspaces are registered lazily on first
    # git.status — see the WebSocket handler.
    global _git_watcher
    _git_watcher = GitWatcher(_broadcast_git_changed, on_plans_change=_broadcast_plans_changed)
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
    # PTY children are detached process groups (start_new_session=True); they
    # must be killed here or they outlive the app as CPU-spinning orphans.
    # Guarded so a sweep failure never skips the watcher/MCP teardown below.
    if _TERMINALS is not None:
        try:
            await _TERMINALS.kill_all()
        except Exception as err:  # noqa: BLE001
            log.warning("pty shutdown sweep failed: %s", err)
    if _log_watcher is not None:
        _log_watcher.stop()
    try:
        tokens_store.flush()
    except Exception as err:  # noqa: BLE001
        log.warning("token store shutdown flush failed: %s", err)
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


# Font mimes served inline (specimen @font-face fetch, /fs/page subresources).
_FONT_MIMES = ("font/ttf", "font/otf", "font/woff", "font/woff2")


def _serve_workspace_file(workspace: str, rel: str, *, allow_css: bool = False) -> FileResponse:
    """Serve a workspace file over HTTP (Range/206 handled by FileResponse).

    Shared policy for /fs/raw and /fs/page. Same trust boundary as the ws
    fs.* handlers: the workspace argument is not checked against a
    known-workspace set (fs.list_dir does not do that either) — any existing
    directory is accepted, and path safety (escape + .agent-team guard) is
    enforced by fs_service._resolve_safe.

    Media, fonts, PDF, and (X)HTML are served inline (plus text/css when
    ``allow_css`` — /fs/page relative subresources); HTML is confined by
    `Content-Security-Policy: sandbox` (opaque origin, no scripts/forms/
    plugins) for the sandboxed iframe preview. Every other type is downgraded
    to an application/octet-stream attachment.
    """
    try:
        target = fs_service._resolve_safe(workspace, rel)
    except fs_service.FsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if target.is_dir():
        raise HTTPException(status_code=400, detail="path is a directory")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    # XSS hardening: only types the preview pane embeds are served inline.
    # HTML is inline for the sandboxed iframe preview but neutralized by
    # `Content-Security-Policy: sandbox` — the document runs in an opaque
    # origin with scripts/forms/plugins blocked. Every other non-media type
    # is downgraded to an opaque attachment. PDF is exempt from the CSP
    # sandbox because it would disable Chromium's embedded viewer.
    inline = (
        media_type in ("application/pdf", "text/html", "application/xhtml+xml")
        or media_type in _FONT_MIMES
        or (allow_css and media_type == "text/css")
        or media_type.startswith(("image/", "video/", "audio/"))
    )
    headers = {"X-Content-Type-Options": "nosniff"}
    if media_type != "application/pdf":
        headers["Content-Security-Policy"] = "sandbox"
    if not inline:
        return FileResponse(
            target,
            media_type="application/octet-stream",
            filename=target.name,
            content_disposition_type="attachment",
            headers=headers,
        )
    return FileResponse(target, media_type=media_type, headers=headers)


@app.get("/fs/raw")
async def fs_raw(workspace: str, rel: str) -> FileResponse:
    """Serve a raw workspace file (query-addressed). See _serve_workspace_file."""
    return _serve_workspace_file(workspace, rel)


@app.get("/fs/page/{ws_b64}/{rel:path}")
async def fs_page(ws_b64: str, rel: str) -> FileResponse:
    """Serve a workspace file path-addressed so relative subresources resolve.

    ``ws_b64`` is the URL-safe base64 of the absolute workspace path (padding
    optional). Same policy as /fs/raw, plus text/css inline — an HTML preview
    loaded from this route can fetch its ./style.css, images, and fonts via
    relative URLs.
    """
    try:
        padded = ws_b64 + "=" * (-len(ws_b64) % 4)
        workspace = base64.urlsafe_b64decode(padded).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail="invalid workspace encoding") from exc
    return _serve_workspace_file(workspace, rel, allow_css=True)


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
            if session.dead:
                # A send already failed on this connection; stop receiving.
                log.info("ws session marked dead; closing receive loop")
                break
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
            task = asyncio.create_task(handle_message(session, msg))
            session._handler_tasks.add(task)
            task.add_done_callback(session._handler_tasks.discard)
    except WebSocketDisconnect:
        log.info("ws client disconnected")
    finally:
        # Peer is gone: silence any in-flight sends before cancelling tasks.
        session.dead = True
        _SESSIONS.discard(session)
        # Release PTY ownership so their output is dropped until reattached.
        orphaned = [tid for tid, owner in _PTY_OWNERS.items() if owner is session]
        for tid in orphaned:
            del _PTY_OWNERS[tid]
        # PTYs survive this disconnect so the frontend can reattach after a
        # transient network outage. They are killed only when the user explicitly
        # closes a pane (terminal.kill) or the whole app process exits.
        for t in session._chat_tasks:
            t.cancel()
        for t in session._review_tasks:
            t.cancel()
        for t in session._handler_tasks:
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
    # Claude Code encodes the cwd by replacing EVERY non-alphanumeric char
    # with "-" (dots, underscores, spaces, unicode — not just "/"). It encodes
    # its *normalized* cwd, which never carries a trailing separator, so strip
    # one the frontend may have sent: otherwise the extra "-" makes the encoded
    # dir miss the real one and resume falsely reports the session "not found".
    project_dir = re.sub(r"[^A-Za-z0-9]", "-", workspace_path.rstrip("/"))
    return Path.home() / ".claude" / "projects" / project_dir / f"{session_id}.jsonl"


_CODEX_RESUME_RE = re.compile(r"^codex\s+resume\s+(\S+)")


def _command_text(command: Any) -> str:
    """Actual CLI command string from a terminal.create payload.

    The frontend wraps agent commands as [shell, '-ilc'|'-lc', '<cmd>'] — the real
    command is the LAST element. Plain strings pass through unchanged.
    """
    if isinstance(command, list):
        return str(command[-1]) if command else ""
    return str(command or "")


def _codex_resume_id(command: Any) -> str:
    """Session id from a `codex resume <id> ...` command ('' otherwise)."""
    m = _CODEX_RESUME_RE.match(_command_text(command).strip())
    return m.group(1) if m else ""


_CLAUDE_RESUME_RE = re.compile(r"^claude\s+(?:\S+\s+)*--resume\s+(\S+)")


def _claude_resume_id(command: Any) -> str:
    """Session id from a `claude ... --resume <id> ...` command ('' otherwise)."""
    m = _CLAUDE_RESUME_RE.match(_command_text(command).strip())
    return m.group(1) if m else ""


def _session_lookup_path(agent: str, workspace_path: str, session_id: str) -> str:
    """The filesystem path the resume preflight checks for this session — logged
    and returned so a failed resume is diagnosable (e.g. a cwd whose non-ASCII
    chars encode to a colliding claude projects dir). '' when the vendor owns
    the location and there is no single stable path (codex/grok)."""
    agent = agent.strip().lower()
    session_id = session_id.strip()
    if not session_id:
        return ""
    if agent == "claude":
        return str(_claude_session_file(workspace_path, session_id))
    if agent == "antigravity":
        # Antigravity stores each conversation as a SQLite db; the id is the
        # filename stem accepted by `agy --conversation <id>`.
        return str(
            Path.home() / ".gemini" / "antigravity-cli" / "conversations"
            / f"{session_id}.db"
        )
    return ""


def _session_exists(agent: str, workspace_path: str, session_id: str) -> bool:
    agent = agent.strip().lower()
    session_id = session_id.strip()
    if not session_id:
        return False
    if agent == "codex":
        # Agent History stores only a pointer to the vendor-owned rollout. A
        # stale pointer must not pass preflight and launch a doomed
        # `codex resume`; search both the real and isolated per-pane homes.
        return codex_home_manager.find_session_home(session_id) is not None
    path = _session_lookup_path(agent, workspace_path, session_id)
    if path:
        return Path(path).is_file()
    return True  # unknown agent: assume resumable (unchanged behaviour)


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


# Agent-CLI spawns inherit the backend's PATH (terminals.py copies os.environ),
# but the backend was launched with the GUI's restricted PATH. Refresh from the
# user's shell — throttled, it shells out — before spawning, so a CLI the user
# just installed is found without first passing through an onboarding.status
# call (real case: install grok → click Respawn → still exit 127).
_PATH_REFRESH_INTERVAL_SEC = 30.0
_last_path_refresh = 0.0


async def _ensure_fresh_path_for_spawn(agent_key: str) -> None:
    global _last_path_refresh
    if agent_key in ("", "terminal"):
        return
    now = time.monotonic()
    if now - _last_path_refresh < _PATH_REFRESH_INTERVAL_SEC:
        return
    _last_path_refresh = now
    await asyncio.to_thread(onboarding_deps._refresh_path_from_login_shell)


class AgentCliProbeError(RuntimeError):
    def __init__(self, message: str, details: dict[str, Any]) -> None:
        super().__init__(message)
        self.details = details


def _command_with_persisted_cli_binary(agent_key: str, command: Any) -> Any:
    """Replace the CLI executable while preserving shell flags and list wrappers."""
    selected = onboarding_deps.cli_binary_override(agent_key)
    dep = onboarding_deps.DEPS_BY_ID.get(agent_key)
    if not selected or dep is None:
        return command
    text = _command_text(command)
    try:
        parts = shlex.split(text)
    except ValueError:
        return command
    if not parts or Path(parts[0]).name != dep.check_cmd[0]:
        return command
    first_token = re.match(r"^\s*(?:'[^']*'|\"[^\"]*\"|\S+)", text)
    if first_token is None:
        return command
    replaced = f"{text[:first_token.start()]}{shlex.quote(selected)}{text[first_token.end():]}"
    if isinstance(command, list):
        updated = list(command)
        if updated:
            updated[-1] = replaced
        return updated
    return replaced


# Aligned with onboarding_deps' detection probe (was 3s here — too tight, so a
# momentarily overloaded machine timed out and made EVERY CLI unlaunchable).
_SPAWN_PROBE_TIMEOUT_S = 8


def _probe_agent_cli_for_spawn(agent_key: str, requested_command: Any = None) -> dict[str, Any] | None:
    """Resolve and smoke-test an agent CLI before allocating its PTY.

    Environmental/transient failures (timeout, exec error) DEGRADE to a warning
    dict and let the spawn proceed — the binary is almost certainly fine (a
    `--version` probe is near-instant when the box is idle) and a genuinely
    broken one still fails visibly at spawn. Only definitive failures
    (not_found / nonzero exit / fatal signal) still raise to block the spawn.
    """
    dep = onboarding_deps.DEPS_BY_ID.get(agent_key)
    if dep is None or dep.group != "agent_cli":
        return None
    executable = None
    try:
        command_parts = shlex.split(_command_text(requested_command))
    except ValueError:
        command_parts = []
    requested_executable = command_parts[0] if command_parts else ""
    if requested_executable and Path(requested_executable).name == dep.check_cmd[0]:
        executable = shutil.which(requested_executable)
    executable = executable or shutil.which(dep.check_cmd[0])
    if not executable:
        raise AgentCliProbeError(
            f"{dep.label} startup probe failed: executable not found ({dep.check_cmd[0]})",
            {
                "agent_key": agent_key,
                "binary_path": "",
                "probe_command": dep.check_cmd,
                "reason": "not_found",
            },
        )
    resolved = os.path.realpath(executable)
    executable_display = (
        f"{executable} → {resolved}" if resolved != executable else executable
    )
    command = [executable, *dep.check_cmd[1:]]
    started = time.monotonic()
    try:
        proc = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=_SPAWN_PROBE_TIMEOUT_S,
            env=os.environ.copy(),
        )
    except subprocess.TimeoutExpired:
        # Transient: the box is momentarily overloaded (fork queued behind a
        # swap storm), not a broken binary. Degrade to a warning and let the
        # spawn proceed instead of blocking every CLI.
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        log.warning(
            "%s startup probe timed out after %dms (%s) — spawning anyway",
            dep.label, duration_ms, executable_display,
        )
        return {
            "agent_key": agent_key,
            "binary_path": executable,
            "resolved_path": resolved,
            "probe_command": command,
            "duration_ms": duration_ms,
            "reason": "timeout",
            "degraded": True,
            "version": None,
        }
    except OSError as err:
        # Transient: the probe's own fork/exec failed (e.g. EAGAIN under load).
        # Degrade rather than block — a truly unrunnable binary fails at spawn.
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        log.warning(
            "%s startup probe could not execute %s: %s — spawning anyway",
            dep.label, executable_display, err,
        )
        return {
            "agent_key": agent_key,
            "binary_path": executable,
            "resolved_path": resolved,
            "probe_command": command,
            "duration_ms": duration_ms,
            "reason": "exec_error",
            "degraded": True,
            "version": None,
        }

    duration_ms = max(0, round((time.monotonic() - started) * 1000))
    output = ((proc.stdout or "") + (proc.stderr or "")).strip()
    version = onboarding_deps._parse_version(output, dep.version_regex)
    signal_name: str | None = None
    if proc.returncode < 0:
        try:
            signal_name = signal.Signals(-proc.returncode).name
        except ValueError:
            signal_name = f"SIG{-proc.returncode}"
    details = {
        "agent_key": agent_key,
        "binary_path": executable,
        "resolved_path": resolved,
        "probe_command": command,
        "duration_ms": duration_ms,
        "exit_code": proc.returncode,
        "signal": signal_name,
        "version": version,
    }
    if proc.returncode != 0:
        cause = f"was terminated by {signal_name}" if signal_name else f"exited with code {proc.returncode}"
        message = f"{dep.label} startup probe {cause} after {duration_ms}ms ({executable_display})"
        error_details = {**details, "reason": "signal" if signal_name else "nonzero_exit"}
        if signal_name == "SIGKILL" and duration_ms < 500:
            hint = (
                "the binary may be quarantined or corrupt (e.g. a broken auto-update); "
                f"try running '{executable} --version' in a terminal"
            )
            message += f" — {hint}"
            error_details["hint"] = hint
        raise AgentCliProbeError(message, error_details)
    return details


async def handle_message(session: Session, msg: dict[str, Any]) -> None:
    msg_id: str = msg.get("id", "")
    msg_type: str = msg.get("type", "")
    payload: dict[str, Any] = msg.get("payload") or {}

    try:
        # -------- ping / terminals --------
        if msg_type == "ping":
            await session.send_json(
                make_response(msg_id, msg_type, {"pong": True, "echo": payload})
            )
        elif msg_type == "terminal.create":
            metadata = payload.get("metadata") or {}
            agent_key = payload.get("agent_key") or ""
            env = dict(payload.get("env") or {})
            await _ensure_fresh_path_for_spawn(agent_key)
            payload["command"] = _command_with_persisted_cli_binary(
                agent_key, payload.get("command")
            )
            startup_probe = await asyncio.to_thread(
                _probe_agent_cli_for_spawn, agent_key, payload.get("command")
            )
            if startup_probe:
                metadata["startup_probe"] = startup_probe
            if agent_key == "codex":
                # Compatibility: `codex resume <id>` only works inside the home
                # that recorded the session. Resume in whichever home owns it;
                # only unknown/fresh sessions get a (new) per-pane home.
                resume_id = _codex_resume_id(payload.get("command"))
                session_home = (
                    codex_home_manager.find_session_home(resume_id) if resume_id else None
                )
                if session_home is None:
                    home_id = str(metadata.get("session_home_id") or payload["pane_id"])
                    codex_home = codex_home_manager.prepare(home_id)
                    env["CODEX_HOME"] = str(codex_home)
                    metadata["session_home_id"] = home_id
                elif session_home != codex_home_manager.real_home:
                    env["CODEX_HOME"] = str(session_home)
                    metadata["session_home_id"] = session_home.name
                # else: session lives in the real ~/.codex — resume with the
                # default env so codex can find it.
            term = session.terminals.create(
                pane_id=payload["pane_id"],
                agent_key=agent_key,
                command=payload["command"],
                cwd=payload["cwd"],
                cols=int(payload.get("cols", 100)),
                rows=int(payload.get("rows", 30)),
                env=env or None,
                metadata=metadata,
                output_log_file=payload.get("output_log_file") or "",
            )
            # Claim immediately. A CLI can die while attribution registration is
            # still running; its terminal.exit must still reach this renderer.
            _PTY_OWNERS[term.id] = session
            # Register the pane with the log-attribution layer so any session
            # file appearing after this point can be attributed back to us.
            if agent_key in ("claude", "codex", "antigravity", "grok", "kimi"):
                ws_for_pane = str(metadata.get("workspace_path") or payload["cwd"])
                # Workspace registration via helper triggers a force-rescan
                # if the workspace is newly known — so historic CLI sessions
                # in that workspace's folder appear in the panel right away.
                _register_workspace_and_backfill(ws_for_pane)
                explicit_session_id = str(metadata.get("explicit_session_id") or "")
                if agent_key == "claude" and not explicit_session_id:
                    # Resumed Claude panes carry no pinned --session-id. Claim the
                    # resume id at registration, or the unowned-session fallback
                    # can hand this pane's session to a sibling in the same cwd —
                    # which then overwrites that sibling's persisted resume id.
                    explicit_session_id = _claude_resume_id(payload.get("command"))
                # A re-created pane (renderer reload respawn keeps its pane id)
                # must not lose its fresh registration to a pending grace-period
                # cleanup from the previous PTY's exit.
                _cancel_pane_unregister(term.pane_id)
                # register_pane's baseline scan enumerates the vendor's whole
                # session-file tree — run it off-loop (register_pane is
                # thread-safe via attribution._lock) so the create ack below
                # isn't delayed past the frontend's timeout. Awaited so the
                # pane is registered before the ack, as before.
                await asyncio.get_running_loop().run_in_executor(
                    None,
                    functools.partial(
                        attribution.register_pane,
                        term.pane_id,
                        vendor=agent_key,
                        cwd=payload["cwd"],
                        workspace_path=ws_for_pane,
                        stage_id=metadata.get("stage_id") or metadata.get("stageId"),
                        slot_key=_stable_pane_key(metadata, ""),
                        explicit_session_id=explicit_session_id,
                        session_marker=str(metadata.get("session_marker") or ""),
                        session_home_id=str(metadata.get("session_home_id") or ""),
                    ),
                )
            if getattr(term, "closed", False):
                _PTY_OWNERS.pop(term.id, None)
                details = {
                    "agent_key": agent_key,
                    "binary_path": (startup_probe or {}).get("binary_path", ""),
                    "reason": getattr(term, "close_reason", None),
                    "exit_code": getattr(term, "exit_code", None),
                    "signal": getattr(term, "exit_signal", None),
                    "uptime_ms": getattr(term, "uptime_ms", None),
                    "startup_probe": startup_probe,
                }
                cause = getattr(term, "exit_signal", None) or f"exit code {getattr(term, 'exit_code', None)}"
                raise AgentCliProbeError(
                    f"Process died {getattr(term, 'uptime_ms', None)}ms after spawn ({cause})",
                    details,
                )
            await session.send_json(
                make_response(
                    msg_id,
                    msg_type,
                    {
                        "terminal_session_id": term.id,
                        "pane_id": term.pane_id,
                        "pid": term.proc.pid,
                        "command": term.command,
                        "startup_probe": startup_probe,
                    },
                )
            )
        elif msg_type == "terminal.input":
            session.terminals.write(payload["terminal_session_id"], payload["data"])
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "terminal.log_sent":
            # Fire-and-forget: log injected text to the session's output log file.
            # No response needed — caller does not await this.
            session.terminals.log_sent(
                payload["terminal_session_id"],
                payload.get("label", "sent"),
                payload.get("text", ""),
            )
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "terminal.resize":
            # Drain old-width output BEFORE the ioctl + ack so it reaches the
            # frontend first — otherwise xterm re-wraps stale-width content
            # after narrowing and the CLI's repaints strand corrupt frames in
            # scrollback (visible as residual text). See drain_output().
            await session.terminals.drain_output(payload["terminal_session_id"])
            session.terminals.resize(
                payload["terminal_session_id"],
                int(payload["cols"]),
                int(payload["rows"]),
            )
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "terminal.interrupt":
            session.terminals.interrupt(payload["terminal_session_id"])
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "terminal.kill":
            # We don't have direct session_id → pane_id mapping at the app layer;
            # the TerminalService does. Look it up before killing so we can
            # release the attribution registration.
            term_session_id = payload["terminal_session_id"]
            force = bool(payload.get("force", False))
            pane_id_for_unreg = ""
            for sess in session.terminals._sessions.values():  # noqa: SLF001
                if sess.id == term_session_id:
                    pane_id_for_unreg = sess.pane_id
                    break
            session.terminals.kill(term_session_id, force=force)
            if pane_id_for_unreg:
                attribution.unregister_pane(pane_id_for_unreg)
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "terminal.reattach":
            # A reconnecting renderer rebinds to still-running PTYs. Report which
            # ids survived; the frontend rebinds those and falls back to
            # spawn+resume for the rest. Force a one-shot SIGWINCH on survivors so
            # agent TUIs repaint into the fresh (empty) xterm. This is NOT the
            # forbidden "auto-redraw a running, visible pane" (no existing content
            # to reflow-corrupt) — it's the only way a reattached blank xterm
            # recovers its screen, since there is no server-side output buffer.
            ids = [str(x) for x in (payload.get("terminal_session_ids") or [])]
            cols = int(payload.get("cols", 0))
            rows = int(payload.get("rows", 0))
            live_ids = {
                s.id
                for s in session.terminals._sessions.values()  # noqa: SLF001
                if not s.closed
            }
            alive = [tid for tid in ids if tid in live_ids]
            dead = [tid for tid in ids if tid not in live_ids]
            # Transfer ownership of reattached PTYs to this window.
            _claim_ptys(session, alive)
            if cols > 0 and rows > 0:
                for tid in alive:
                    session.terminals.force_redraw(tid, cols, rows)
            await session.send_json(
                make_response(msg_id, msg_type, {"alive": alive, "dead": dead})
            )
        elif msg_type == "terminal.redraw":
            # One-shot SIGWINCH nudge so a TUI repaints cleanly after a resize
            # settles, clearing the reflow residue xterm leaves when it re-wraps
            # the old frame at the new width. Unlike terminal.reattach this does
            # NOT re-route the active session — it is a pure repaint of an
            # already-attached, visible pane (the frontend gates it on width
            # stable + CLI quiet, see useTerminal scheduleResizeRedraw).
            tid = str(payload.get("terminal_session_id") or "")
            cols = int(payload.get("cols", 0))
            rows = int(payload.get("rows", 0))
            if tid and cols > 0 and rows > 0:
                # Order the repaint SIGWINCH AFTER any pending output, the same
                # barrier terminal.resize uses (drain_output). The frontend can
                # fire this mid-stream when a busy pane hits its bounded-wait
                # deadline; without draining first, the SIGWINCH could interrupt
                # an in-flight frame and strand a corrupt repaint — exactly what
                # the resize drain/grace machinery exists to prevent.
                await session.terminals.drain_output(tid)
                session.terminals.force_redraw(tid, cols, rows)
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "debug.log":
            # TEMP: append a frontend diagnostic line to a file the dev can read
            # directly (renderer console logs aren't otherwise reachable). Remove
            # with the matching frontend diagnostics once resize is confirmed.
            try:
                import time as _t

                line = str(payload.get("line", ""))

                def _append_debug_line() -> None:
                    with open("/tmp/agent-team-resize.log", "a") as _f:
                        _f.write(f"{_t.strftime('%H:%M:%S')} {line}\n")

                await asyncio.to_thread(_append_debug_line)
            except Exception:
                pass
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "codex_home.cleanup":
            cleaned = codex_home_manager.cleanup(str(payload.get("session_home_id") or ""))
            await session.send_json(
                make_response(msg_id, msg_type, {"ok": True, "cleaned": cleaned})
            )

        # -------- project / pipeline --------
        elif msg_type == "project.upsert":
            project = project_store.load_or_create(
                payload["workspace_path"],
                name=payload.get("name", ""),
                backend_version=__version__,
            )
            _register_workspace_and_backfill(project.workspace_path)
            await session.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "project.get":
            project = project_store.load_or_create(payload["workspace_path"])
            _register_workspace_and_backfill(project.workspace_path)
            await session.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "project.peek":
            ws_raw = payload.get("workspace_path", "") or ""
            project = project_store.peek(ws_raw)
            if project:
                _register_workspace_and_backfill(project.workspace_path)
                peek_payload = _project_payload(project)
                peek_payload["plan_spec_available"] = plan_spec_exists(
                    project.workspace_path
                )
                await session.send_json(
                    make_response(msg_id, msg_type, peek_payload)
                )
            else:
                # Even when no .agent-team/project.json exists yet, register
                # any valid directory the user "opens" so its historic CLI
                # sessions can show up in cumulative immediately.
                import os as _os
                ws_abs = _os.path.abspath(ws_raw) if ws_raw else ""
                if ws_abs and _os.path.isdir(ws_abs):
                    _register_workspace_and_backfill(ws_abs)
                await session.send_json(
                    make_response(
                        msg_id,
                        msg_type,
                        {
                            "project": None,
                            "paths": None,
                            "plan_spec_available": plan_spec_exists(ws_abs),
                        },
                    )
                )
        elif msg_type == "agent.session_exists":
            _agent = str(payload.get("agent", ""))
            _ws = str(payload.get("workspace_path", ""))
            _sid = str(payload.get("session_id", ""))
            exists = _session_exists(_agent, _ws, _sid)
            checked_path = _session_lookup_path(_agent, _ws, _sid)
            if not exists and _sid.strip():
                # Diagnostic: a resume that reports "not found" logs exactly
                # where it looked, so a colliding/encoded path is visible.
                log.info(
                    "resume preflight miss: agent=%s session=%s checked=%s",
                    _agent.strip().lower(), _sid.strip(),
                    checked_path or "(vendor-managed)",
                )
            await session.send_json(
                make_response(msg_id, msg_type, {"exists": exists, "checked_path": checked_path})
            )
        elif msg_type == "agent.orphan_scan":
            # Read-only leftover count (dead-backend PTY children still alive).
            orphans = await asyncio.to_thread(pty_registry.scan_orphans)
            await session.send_json(
                make_response(msg_id, msg_type, {"orphans": orphans, "count": len(orphans)})
            )
        elif msg_type == "agent.reap_orphans":
            # Manual cleanup: kill the leftover process groups reap_stale finds.
            reaped = await asyncio.to_thread(pty_registry.reap_stale)
            await session.send_json(
                make_response(msg_id, msg_type, {"reaped": reaped, "count": len(reaped)})
            )
        elif msg_type == "pipeline.resume":
            project, resume_index = project_store.resume_pipeline(payload["workspace_path"])
            resp = _project_payload(project)
            resp["resume_index"] = resume_index
            await session.send_json(make_response(msg_id, msg_type, resp))
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
            await session.send_json(
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
            await session.send_json(
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
                # Claude passes its pinned --session-id here; Codex/Antigravity pass
                # "" and persist later via pipeline.slot_session once detected.
                session_id=payload.get("session_id", ""),
                session_home_id=payload.get("session_home_id", ""),
                run_group_id=payload.get("run_group_id", ""),
            )
            await session.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "pipeline.slot_session":
            project = project_store.record_slot_session(
                payload["workspace_path"],
                stage_index=int(payload["stage_index"]),
                slot_label=payload["slot_label"],
                session_id=payload.get("session_id", ""),
            )
            await session.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "pipeline.slot_unspawn":
            project = project_store.record_slot_unspawn(
                payload["workspace_path"],
                stage_index=int(payload["stage_index"]),
                slot_label=payload["slot_label"],
            )
            await session.send_json(
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
                session_home_id=payload.get("session_home_id", ""),
                run_group_id=payload.get("run_group_id", ""),
                output_log_file=payload.get("output_log_file", ""),
            )
            await session.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "manual_pane.unspawn":
            project = project_store.record_manual_pane_unspawn(
                payload["workspace_path"],
                pane_id=payload["pane_id"],
                session_id=payload.get("session_id", "") or "",
            )
            await session.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "manual_pane.session":
            project = project_store.record_manual_pane_session(
                payload["workspace_path"],
                pane_id=payload["pane_id"],
                session_id=payload.get("session_id", ""),
            )
            await session.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "pane.set_run_group":
            project = project_store.set_pane_run_group(
                payload["workspace_path"],
                pane_id=payload["pane_id"],
                run_group_id=payload.get("run_group_id", ""),
            )
            await session.send_json(
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
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "project.set_pane_order":
            ws_raw = payload.get("workspace_path", "") or ""
            pane_ids = payload.get("pane_ids") or []
            if isinstance(pane_ids, list):
                project_store.set_pane_order(
                    ws_raw, pane_ids=[p for p in pane_ids if isinstance(p, str)]
                )
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "project.set_tab_order":
            ws_raw = payload.get("workspace_path", "") or ""
            tab_order = payload.get("tab_order") or []
            if isinstance(tab_order, list):
                project_store.set_tab_order(
                    ws_raw, tab_order=[t for t in tab_order if isinstance(t, str)]
                )
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "project.set_ui_state":
            ws_raw = payload.get("workspace_path", "") or ""
            raw_groups = payload.get("run_groups")
            run_groups = (
                [g for g in raw_groups if isinstance(g, dict)]
                if isinstance(raw_groups, list)
                else None
            )
            raw_tab = payload.get("active_tab")
            active_tab = raw_tab if isinstance(raw_tab, str) else None
            raw_repo = payload.get("git_tab_repo")
            git_tab_repo = raw_repo if isinstance(raw_repo, str) else None
            raw_history = payload.get("spawn_history")
            spawn_history = (
                [entry for entry in raw_history if isinstance(entry, dict)][-100:]
                if isinstance(raw_history, list)
                else None
            )
            project = project_store.set_ui_state(
                ws_raw,
                run_groups=run_groups,
                active_tab=active_tab,
                git_tab_repo=git_tab_repo,
                spawn_history=spawn_history,
            )
            if project is not None:
                # Peer windows on the same workspace adopt the change live
                # (replaces the old cross-window localStorage `storage` event).
                delta: dict[str, Any] = {"workspace_path": project.workspace_path}
                if run_groups is not None:
                    delta["run_groups"] = run_groups
                if active_tab is not None:
                    delta["active_tab"] = active_tab
                if git_tab_repo is not None:
                    delta["git_tab_repo"] = git_tab_repo
                if spawn_history is not None:
                    delta["spawn_history"] = spawn_history
                await broadcast(
                    make_event("project.ui_state_changed", delta), exclude=session
                )
            # ok mirrors persistence so the frontend's one-time localStorage
            # migration only deletes its legacy copy after a real ack.
            await session.send_json(
                make_response(msg_id, msg_type, {"ok": project is not None})
            )
        elif msg_type == "project.rename_pane":
            ws_raw = payload.get("workspace_path", "") or ""
            pane_id = payload.get("pane_id", "") or ""
            custom_name = (payload.get("custom_name", "") or "").strip()
            if pane_id:
                project = project_store.rename_pane(
                    ws_raw, pane_id=pane_id, custom_name=custom_name
                )
                # rename_pane() patches the persisted history mirror; push it to
                # peer windows so their in-memory copies (and later snapshots)
                # don't clobber the rename with stale entries.
                if project is not None and project.ui_spawn_history is not None:
                    await broadcast(
                        make_event("project.ui_state_changed", {
                            "workspace_path": project.workspace_path,
                            "spawn_history": project.ui_spawn_history,
                        }),
                        exclude=session,
                    )
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
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
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "project.set_language":
            # Backup-only persistence: localStorage in the renderer is the source
            # of truth. Unknown workspace → silently no-op.
            ws_raw = payload.get("workspace_path", "") or ""
            project = project_store.peek(ws_raw)
            if project:
                lang = payload.get("language")
                if isinstance(lang, str) and lang:
                    project.language = lang
                project_store.save(project)
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
        elif msg_type == "pipeline.slot_kickoff":
            project = project_store.update_slot_kickoff(
                payload["workspace_path"],
                stage_index=int(payload["stage_index"]),
                slot_label=payload["slot_label"],
                kickoff_status=payload.get("kickoff_status", "sent"),
            )
            await session.send_json(
                make_response(msg_id, msg_type, _project_payload(project))
            )
        elif msg_type == "pipeline.complete":
            project = project_store.complete_pipeline(payload["workspace_path"])
            tokens_store.end_run(project.workspace_path)
            asyncio.create_task(
                broadcast(make_event("tokens.changed", tokens_store.snapshot(project.workspace_path)))
            )
            await session.send_json(
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
            await session.send_json(
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
            await session.send_json(
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
            await session.send_json(
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
            await session.send_json(
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
            await session.send_json(make_response(msg_id, msg_type, result))
        # -------- recent workspaces --------
        elif msg_type == "workspace.list_recent":
            await session.send_json(
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
            await session.send_json(
                make_response(msg_id, msg_type, {"recent": recent})
            )
            await broadcast(
                make_event("workspace.recent_changed", {"recent": recent, "reason": "touch"})
            )
        elif msg_type == "workspace.pin":
            recent_workspaces_store.pin(payload["path"])
            recent = recent_workspaces_store.list()
            await session.send_json(
                make_response(msg_id, msg_type, {"recent": recent})
            )
            await broadcast(
                make_event("workspace.recent_changed", {"recent": recent, "reason": "pin"})
            )
        elif msg_type == "workspace.unpin":
            recent_workspaces_store.unpin(payload["path"])
            recent = recent_workspaces_store.list()
            await session.send_json(
                make_response(msg_id, msg_type, {"recent": recent})
            )
            await broadcast(
                make_event("workspace.recent_changed", {"recent": recent, "reason": "unpin"})
            )

        elif msg_type == "workspace.remove":
            recent_workspaces_store.remove(payload["path"])
            recent = recent_workspaces_store.list()
            await session.send_json(
                make_response(msg_id, msg_type, {"recent": recent})
            )
            await broadcast(
                make_event("workspace.recent_changed", {"recent": recent, "reason": "remove"})
            )

        # -------- UI settings (generic KV store, localStorage replacement) --------
        elif msg_type == "ui.settings.get":
            await session.send_json(
                make_response(msg_id, msg_type, {"settings": ui_settings_store.get()})
            )

        elif msg_type == "ui.settings.set":
            updates = payload.get("updates")
            delta = ui_settings_store.set(updates) if isinstance(updates, dict) else {}
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
            if delta:
                # Other windows (EditorWindow, roles/stages) hold their own ws
                # connections — broadcast the merged delta so their caches
                # converge; the sender already applied it locally.
                await broadcast(
                    make_event("ui.settings_changed", {"settings": delta}),
                    exclude=session,
                )

        # -------- settings bundle / metadata --------
        elif msg_type == "settings.paths":
            await session.send_json(make_response(msg_id, msg_type, {"paths": _settings_paths()}))

        elif msg_type == "settings.bundle.export":
            await session.send_json(make_response(msg_id, msg_type, {"bundle": _settings_bundle()}))

        elif msg_type == "settings.bundle.import":
            bundle = payload.get("bundle") if isinstance(payload.get("bundle"), dict) else payload
            if not isinstance(bundle, dict):
                await session.send_json(make_error(msg_id, msg_type, "INVALID_BUNDLE", "settings bundle must be an object"))
                return
            applied: list[str] = []
            if isinstance(bundle.get("roles"), list):
                roles = roles_store.replace_all(bundle["roles"])
                applied.append("roles")
                await broadcast(make_event("roles.changed", {"roles": roles, "reason": "bundle_import"}))
            if isinstance(bundle.get("pipelines_document"), dict):
                stages_store.replace_document(bundle["pipelines_document"])
                pipelines = stages_store.list_pipelines()
                active_id = stages_store.get_active_pipeline_id()
                applied.append("pipelines")
                await broadcast(make_event("pipelines.changed", {
                    "pipelines": pipelines,
                    "active_pipeline_id": active_id,
                    "reason": "bundle_import",
                }))
                await broadcast(make_event("stages.changed", {
                    "stages": stages_store.list(active_id),
                    "pipeline_id": active_id,
                    "reason": "bundle_import",
                }))
            if isinstance(bundle.get("mcp_servers"), list):
                mcp_settings_store.replace_servers(bundle["mcp_servers"])
                await mcp_manager.reload(mcp_settings_store.path)
                applied.append("mcp")
            if isinstance(bundle.get("analyzer"), dict):
                updated = analyzer_settings_store.set(bundle["analyzer"])
                applied.append("analyzer")
                await broadcast(make_event("analyzer.settings_changed", updated))
            if isinstance(bundle.get("ai_chat"), dict):
                safe_chat = {
                    k: v for k, v in bundle["ai_chat"].items()
                    if k not in _AI_SECRET_KEYS and v != "__redacted__"
                }
                if safe_chat:
                    ai_chat_settings_store.set(safe_chat)
                    applied.append("ai_chat")
            await session.send_json(make_response(msg_id, msg_type, {
                "ok": True,
                "applied": applied,
                "paths": _settings_paths(),
            }))

        # -------- roles registry --------
        elif msg_type == "roles.list":
            await session.send_json(
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
            await session.send_json(
                make_response(msg_id, msg_type, {"role": role, "roles": roles_store.list()})
            )
            await broadcast(
                make_event("roles.changed", {"roles": roles_store.list(), "reason": "upsert"})
            )
        elif msg_type == "roles.delete":
            roles = roles_store.delete(payload["key"])
            await session.send_json(
                make_response(msg_id, msg_type, {"roles": roles})
            )
            await broadcast(
                make_event("roles.changed", {"roles": roles, "reason": "delete"})
            )
        elif msg_type == "roles.reset":
            roles = roles_store.reset()
            await session.send_json(
                make_response(msg_id, msg_type, {"roles": roles})
            )
            await broadcast(
                make_event("roles.changed", {"roles": roles, "reason": "reset"})
            )

        # -------- pipelines registry --------
        elif msg_type == "pipelines.list":
            pipelines = stages_store.list_pipelines()
            active_id = stages_store.get_active_pipeline_id()
            await session.send_json(
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
            await session.send_json(
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
            await session.send_json(
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
                    await session.send_json(
                        make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot delete pipeline while a project is running")
                    )
                    return
            pipelines = stages_store.delete_pipeline(pipeline_id)
            await session.send_json(
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
                    await session.send_json(
                        make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot switch pipeline while a project is running")
                    )
                    return
            stages_store.set_active_pipeline(pipeline_id)
            pipelines = stages_store.list_pipelines()
            await session.send_json(
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
            await session.send_json(
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
            await session.send_json(
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
                    await session.send_json(
                        make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot edit stages while the active pipeline is running")
                    )
                    return
            stage = stages_store.upsert(payload["stage"], pipeline_id)
            effective_pipeline_id = pipeline_id or stages_store.get_active_pipeline_id()
            updated_stages = stages_store.list(pipeline_id)
            await session.send_json(
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
                    await session.send_json(
                        make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot reorder stages while the active pipeline is running")
                    )
                    return
            updated_stages = stages_store.reorder(payload["ids"], pipeline_id)
            effective_pipeline_id = pipeline_id or stages_store.get_active_pipeline_id()
            await session.send_json(
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
                    await session.send_json(
                        make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot delete stages while the active pipeline is running")
                    )
                    return
            updated_stages = stages_store.delete(payload["id"], pipeline_id)
            effective_pipeline_id = pipeline_id or stages_store.get_active_pipeline_id()
            await session.send_json(
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
            await session.send_json(
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
            await session.send_json(make_response(msg_id, msg_type, {
                "found": found,
                "recommended": found[0] if found else None,
            }))

        elif msg_type == "analyzer.settings.get":
            await session.send_json(
                make_response(msg_id, msg_type, analyzer_settings_store.get())
            )
        elif msg_type == "analyzer.settings.set":
            updated = analyzer_settings_store.set(payload)
            await session.send_json(make_response(msg_id, msg_type, updated))
            await broadcast(make_event("analyzer.settings_changed", updated))

        elif msg_type == "analyzer.health":
            data = await analyzer_health()
            data["default_model"] = ANALYZER_DEFAULT_MODEL
            data["backend"] = _az_settings().get("backend", "llama_cpp")
            await session.send_json(make_response(msg_id, msg_type, data))
        elif msg_type == "analyzer.models":
            models = await analyzer_list_models()
            await session.send_json(
                make_response(msg_id, msg_type, {"models": models, "default": ANALYZER_DEFAULT_MODEL})
            )
        elif msg_type == "analyzer.classify":
            text = payload.get("text", "") or ""
            model = payload.get("model") or ANALYZER_DEFAULT_MODEL
            # llama_cpp calls are serialised via _llama_sem (analyzer.py); if one
            # is already running, this call will queue behind it for up to 60s.
            # Tell the frontend now so it shows "queued" instead of looking hung.
            if not _az_is_ollama() and _llama_cli_busy():
                await broadcast(make_event("analyzer.queued", {
                    "pane_id": payload.get("pane_id") or "",
                    "stage_id": payload.get("stage_id") or "",
                    "workspace_path": payload.get("workspace_path") or "",
                }))
            result = await analyzer_classify(text, model)
            _record_analyzer_tokens(result, payload)
            await session.send_json(make_response(msg_id, msg_type, result))

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
            await session.send_json(make_response(msg_id, msg_type, {"ok": True, "started": True}))

        elif msg_type == "analyzer.pull":
            # Only valid in Ollama mode.
            model_name = payload.get("name", "")
            if not model_name:
                await session.send_json(
                    make_response(msg_id, msg_type, {"ok": False, "error": "name required"})
                )
            elif not _az_is_ollama():
                await session.send_json(
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
                await session.send_json(make_response(msg_id, msg_type, {"ok": True, "started": True}))

        elif msg_type == "analyzer.delete":
            model_name = payload.get("name", "")
            if not model_name:
                await session.send_json(
                    make_response(msg_id, msg_type, {"ok": False, "error": "name required"})
                )
            elif not _az_is_ollama():
                await session.send_json(
                    make_response(msg_id, msg_type, {"ok": False, "error": "delete only available in Ollama mode"})
                )
            else:
                result = await _ollama_delete_model(model_name, _az_base_url())
                await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "analyzer.ollama_health":
            data = await _ollama_health(_az_base_url())
            await session.send_json(make_response(msg_id, msg_type, data))

        # -------- token stats --------
        elif msg_type == "tokens.snapshot":
            snap = tokens_store.snapshot(payload.get("workspace_path") or None)
            await session.send_json(make_response(msg_id, msg_type, snap))
        elif msg_type == "tokens.reset":
            scope = payload.get("scope", "run")
            snap = tokens_store.reset(scope, payload.get("workspace_path") or None)
            await session.send_json(make_response(msg_id, msg_type, snap))
            await broadcast(make_event("tokens.changed", snap))

        # -------- pipeline history (timeline) --------
        elif msg_type == "history.snapshot":
            ws_path = payload.get("workspace_path") or ""
            # Resolve the active run's folder so the timeline scopes to it.
            _proj = project_store.peek(ws_path) if ws_path else None
            _log_name = _proj.log_file_name if _proj else ""
            run_dir = _log_name.rsplit("/", 1)[0] if "/" in _log_name else ""
            snap = history_store.snapshot(ws_path, run_dir, int(payload.get("limit", 500)))
            await session.send_json(make_response(msg_id, msg_type, snap))

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
            await session.send_json(
                make_response(msg_id, msg_type, {"ok": True})
            )

        # -------- git --------
        elif msg_type == "git.init":
            ws_path = payload.get("workspace_path") or ""
            create_gi = bool(payload.get("create_gitignore", True))
            result = await git_service.init_repo(ws_path, create_gitignore=create_gi)
            await session.send_json(make_response(msg_id, msg_type, result))
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
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.discover_repositories":
            ws_path = payload.get("workspace_path") or ""
            max_depth = min(int(payload.get("max_depth", 3)), 8)
            limit = min(int(payload.get("limit", 20)), 100)
            result = await git_service.discover_repositories(ws_path, max_depth=max_depth, limit=limit)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.log":
            ws_path = payload.get("workspace_path") or ""
            n = min(int(payload.get("n", 20)), 500)
            all_branches = bool(payload.get("all", False))
            result = await git_service.get_log(ws_path, n, all_branches)
            await session.send_json(make_response(msg_id, msg_type, {"commits": result}))

        elif msg_type == "git.stage":
            ws_path = payload.get("workspace_path") or ""
            files = payload.get("files") or []
            result = await git_service.stage_files(ws_path, files)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.unstage":
            ws_path = payload.get("workspace_path") or ""
            files = payload.get("files") or []
            result = await git_service.unstage_files(ws_path, files)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.stage_all":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.stage_all(ws_path)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.check_staged":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.check_staged(ws_path)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.commit":
            ws_path = payload.get("workspace_path") or ""
            message = payload.get("message") or ""
            commit_all = bool(payload.get("all"))
            result = await git_service.commit(ws_path, message, commit_all)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.sync":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.sync(
                ws_path,
                on_credential_request=build_credential_request_emitter(ws_path),
                on_credential_settled=build_credential_settled_emitter(ws_path),
                credential=_git_credential(payload),
            )
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.generate_message":
            ws_path = payload.get("workspace_path") or ""
            ollama_url = _az_base_url()
            attempt_count = int(payload.get("attempt_count") or 0)
            chat_settings = ai_chat_settings_store.get()
            model = payload.get("model") or chat_settings.get("model") or ANALYZER_DEFAULT_MODEL
            result = await git_service.generate_commit_message(ws_path, ollama_url, model, attempt_count, settings=chat_settings)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.discard":
            ws_path = payload.get("workspace_path") or ""
            files = payload.get("files") or []
            result = await git_service.discard_changes(ws_path, files)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.fetch":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.fetch(
                ws_path,
                on_credential_request=build_credential_request_emitter(ws_path),
                on_credential_settled=build_credential_settled_emitter(ws_path),
                credential=_git_credential(payload),
            )
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.pull":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.pull_only(
                ws_path,
                on_credential_request=build_credential_request_emitter(ws_path),
                on_credential_settled=build_credential_settled_emitter(ws_path),
                credential=_git_credential(payload),
            )
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.push":
            ws_path = payload.get("workspace_path") or ""
            remote = payload.get("remote") or ""
            branch = payload.get("branch") or ""
            result = await git_service.push_only(
                ws_path,
                remote,
                branch,
                on_credential_request=build_credential_request_emitter(ws_path),
                on_credential_settled=build_credential_settled_emitter(ws_path),
                credential=_git_credential(payload),
            )
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.credential_submit":
            request_id = str(payload.get("request_id") or "")
            value = payload.get("value")
            ok = git_service.resolve_credential(request_id, str(value) if value is not None else None)
            await session.send_json(make_response(msg_id, msg_type, {"ok": ok}))

        elif msg_type == "git.credential_cancel":
            request_id = str(payload.get("request_id") or "")
            ok = git_service.resolve_credential(request_id, None)
            await session.send_json(make_response(msg_id, msg_type, {"ok": ok}))

        elif msg_type == "git.branches":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.list_branches(ws_path)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.create_branch":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            switch_to = bool(payload.get("switch_to", True))
            start_point = payload.get("start_point") or ""
            result = await git_service.create_branch(
                ws_path, name, switch_to=switch_to, start_point=start_point
            )
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.switch_branch":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            result = await git_service.switch_branch(ws_path, name)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.checkout_commit":
            ws_path = payload.get("workspace_path") or ""
            commit_hash = payload.get("commit_hash") or ""
            result = await git_service.checkout_commit(ws_path, commit_hash)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.checkout_remote_branch":
            ws_path = payload.get("workspace_path") or ""
            remote_ref = payload.get("remote_ref") or ""
            result = await git_service.checkout_remote_branch(ws_path, remote_ref)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.delete_branch":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            force = bool(payload.get("force", False))
            result = await git_service.delete_branch(ws_path, name, force=force)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.stash_list":
            ws_path = payload.get("workspace_path") or ""
            entries = await git_service.stash_list(ws_path)
            await session.send_json(make_response(msg_id, msg_type, {"stashes": entries}))

        elif msg_type == "git.stash":
            ws_path = payload.get("workspace_path") or ""
            message = payload.get("message") or ""
            paths = payload.get("paths") or None
            result = await git_service.stash_push(ws_path, message, paths)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.stash_pop":
            ws_path = payload.get("workspace_path") or ""
            index = int(payload.get("index", 0))
            result = await git_service.stash_pop(ws_path, index)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.stash_drop":
            ws_path = payload.get("workspace_path") or ""
            index = int(payload.get("index", 0))
            result = await git_service.stash_drop(ws_path, index)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.amend":
            ws_path = payload.get("workspace_path") or ""
            message = payload.get("message") or ""
            result = await git_service.amend_commit(ws_path, message)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.undo_commit":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.undo_last_commit(ws_path)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.diff_file":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            staged = bool(payload.get("staged", False))
            result = await git_service.diff_file(ws_path, filepath, staged=staged)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.diff_blame":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            staged = bool(payload.get("staged", False))
            result = await git_service.diff_blame(ws_path, filepath, staged=staged)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.commit_file_diff":
            ws_path = payload.get("workspace_path") or ""
            commit_hash = payload.get("commit_hash") or ""
            filepath = payload.get("filepath") or ""
            result = await git_service.commit_file_diff(ws_path, commit_hash, filepath)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.diff_all":
            ws_path = payload.get("workspace_path") or ""
            staged = bool(payload.get("staged", False))
            result = await git_service.diff_all(ws_path, staged=staged)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.merge":
            ws_path = payload.get("workspace_path") or ""
            branch = payload.get("branch") or ""
            result = await git_service.merge_branch(ws_path, branch)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.merge_into":
            ws_path = payload.get("workspace_path") or ""
            target = payload.get("target") or ""
            result = await git_service.merge_into(ws_path, target)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.revert":
            ws_path = payload.get("workspace_path") or ""
            commit_hash = payload.get("commit_hash") or ""
            result = await git_service.revert_commit(ws_path, commit_hash)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.remotes":
            ws_path = payload.get("workspace_path") or ""
            remotes = await git_service.list_remotes(ws_path)
            await session.send_json(make_response(msg_id, msg_type, {"remotes": remotes}))

        elif msg_type == "git.add_remote":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            url = payload.get("url") or ""
            result = await git_service.add_remote(ws_path, name, url)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.connect_to_remote":
            ws_path = payload.get("workspace_path") or ""
            url = payload.get("url") or ""
            result = await git_service.connect_to_remote(ws_path, url)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.remove_remote":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            result = await git_service.remove_remote(ws_path, name)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.cherry_pick":
            ws_path = payload.get("workspace_path") or ""
            commit_hash = payload.get("commit_hash") or ""
            result = await git_service.cherry_pick(ws_path, commit_hash)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.tags":
            ws_path = payload.get("workspace_path") or ""
            tags = await git_service.list_tags(ws_path)
            await session.send_json(make_response(msg_id, msg_type, {"tags": tags}))

        elif msg_type == "git.create_tag":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            message = payload.get("message") or ""
            commit_hash = payload.get("commit_hash") or ""
            result = await git_service.create_tag(ws_path, name, message, commit_hash)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.delete_tag":
            ws_path = payload.get("workspace_path") or ""
            name = payload.get("name") or ""
            result = await git_service.delete_tag(ws_path, name)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.file_log":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            n = int(payload.get("n", 15))
            commits = await git_service.file_log(ws_path, filepath, n)
            await session.send_json(make_response(msg_id, msg_type, {"commits": commits}))

        elif msg_type == "git.show_file":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            rev = payload.get("rev") or "HEAD"
            result = await git_service.show_file(ws_path, filepath, rev)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.resolve_ours":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            result = await git_service.resolve_conflict_ours(ws_path, filepath)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.resolve_theirs":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            result = await git_service.resolve_conflict_theirs(ws_path, filepath)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.clean":
            ws_path = payload.get("workspace_path") or ""
            dry_run = bool(payload.get("dry_run", True))
            result = await git_service.clean_untracked(ws_path, dry_run=dry_run)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok") and not dry_run:
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.show_commit":
            ws_path = payload.get("workspace_path") or ""
            commit_hash = payload.get("commit_hash") or ""
            result = await git_service.show_commit(ws_path, commit_hash)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.worktrees":
            ws_path = payload.get("workspace_path") or ""
            entries = await git_service.list_worktrees(ws_path)
            await session.send_json(make_response(msg_id, msg_type, {"worktrees": entries}))

        elif msg_type == "git.add_worktree":
            ws_path = payload.get("workspace_path") or ""
            wt_path = payload.get("worktree_path") or ""
            branch = payload.get("branch") or ""
            new_branch = bool(payload.get("new_branch", False))
            result = await git_service.add_worktree(ws_path, wt_path, branch, new_branch=new_branch)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.remove_worktree":
            ws_path = payload.get("workspace_path") or ""
            wt_path = payload.get("worktree_path") or ""
            force = bool(payload.get("force", False))
            result = await git_service.remove_worktree(ws_path, wt_path, force=force)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.prune_worktrees":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.prune_worktrees(ws_path)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.lock_worktree":
            ws_path = payload.get("workspace_path") or ""
            wt_path = payload.get("worktree_path") or ""
            reason = payload.get("reason") or ""
            result = await git_service.lock_worktree(ws_path, wt_path, reason)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.unlock_worktree":
            ws_path = payload.get("workspace_path") or ""
            wt_path = payload.get("worktree_path") or ""
            result = await git_service.unlock_worktree(ws_path, wt_path)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.move_worktree":
            ws_path = payload.get("workspace_path") or ""
            wt_path = payload.get("worktree_path") or ""
            new_path = payload.get("new_path") or ""
            result = await git_service.move_worktree(ws_path, wt_path, new_path)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.repair_worktrees":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.repair_worktree(ws_path)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.config_get":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.get_config(ws_path)
            result["allowed_keys"] = sorted(git_service._ALLOWED_CONFIG_KEYS)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.config_set":
            ws_path = payload.get("workspace_path") or ""
            key = payload.get("key") or ""
            value = payload.get("value") or ""
            result = await git_service.set_config(ws_path, key, value)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.blame":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            result = await git_service.blame_file(ws_path, filepath)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.compare_branches":
            ws_path = payload.get("workspace_path") or ""
            base = payload.get("base") or ""
            compare = payload.get("compare") or ""
            result = await git_service.compare_branches(ws_path, base, compare)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.diff_branches":
            ws_path = payload.get("workspace_path") or ""
            base = payload.get("base") or "main"
            compare = payload.get("compare") or ""
            result = await git_service.diff_branches(ws_path, base, compare)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.rebase":
            ws_path = payload.get("workspace_path") or ""
            branch = payload.get("branch") or ""
            result = await git_service.rebase_on(ws_path, branch)
            await session.send_json(make_response(msg_id, msg_type, result))
            # Refresh on success or when a rebase was left in progress on conflict,
            # so the UI shows the in-progress operation and conflicted files.
            if result.get("ok") or result.get("conflict_files"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.restore_from_branch":
            ws_path = payload.get("workspace_path") or ""
            branch = payload.get("branch") or ""
            filepath = payload.get("filepath") or ""
            result = await git_service.restore_file_from_branch(ws_path, branch, filepath)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.push_upstream":
            ws_path = payload.get("workspace_path") or ""
            branch = payload.get("branch") or ""
            remote = payload.get("remote") or "origin"
            result = await git_service.push_set_upstream(
                ws_path,
                branch,
                remote,
                on_credential_request=build_credential_request_emitter(ws_path),
                on_credential_settled=build_credential_settled_emitter(ws_path),
                credential=_git_credential(payload),
            )
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.apply_patch":
            ws_path = payload.get("workspace_path") or ""
            patch = payload.get("patch") or ""
            reverse = bool(payload.get("reverse", False))
            cached = bool(payload.get("cached", True))
            result = await git_service.apply_patch(ws_path, patch, reverse=reverse, cached=cached)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.clone":
            url = payload.get("url") or ""
            target_dir = payload.get("target_dir") or ""
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.clone_repo(
                url,
                target_dir,
                on_credential_request=build_credential_request_emitter(ws_path),
                on_credential_settled=build_credential_settled_emitter(ws_path),
            )
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.ignore":
            ws_path = payload.get("workspace_path") or ""
            pattern = payload.get("pattern") or ""
            target = payload.get("target") or "project"
            untrack = bool(payload.get("untrack", True))
            result = await git_service.add_to_gitignore(ws_path, pattern, target=target, untrack=untrack)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.check_ignore":
            ws_path = payload.get("workspace_path") or ""
            filepath = payload.get("filepath") or ""
            result = await git_service.check_ignore(ws_path, filepath)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "git.abort":
            ws_path = payload.get("workspace_path") or ""
            op = payload.get("op") or ""
            result = await git_service.abort_operation(ws_path, op)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.stash_apply":
            ws_path = payload.get("workspace_path") or ""
            index = int(payload.get("index", 0))
            result = await git_service.stash_apply(ws_path, index)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.pull_rebase":
            ws_path = payload.get("workspace_path") or ""
            result = await git_service.pull_rebase(
                ws_path,
                on_credential_request=build_credential_request_emitter(ws_path),
                on_credential_settled=build_credential_settled_emitter(ws_path),
                credential=_git_credential(payload),
            )
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "git.push_force":
            ws_path = payload.get("workspace_path") or ""
            remote = payload.get("remote") or ""
            branch = payload.get("branch") or ""
            result = await git_service.push_force(
                ws_path,
                remote,
                branch,
                on_credential_request=build_credential_request_emitter(ws_path),
                on_credential_settled=build_credential_settled_emitter(ws_path),
                credential=_git_credential(payload),
            )
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        # ── Cloud issues (issues.*) ─────────────────────────────────────────
        # GitHub via gh / GitLab via glab, host auto-detected from origin remote.
        # No git.changed broadcast — issues are remote state, not local repo state.
        elif msg_type == "issues.provider":
            ws_path = payload.get("workspace_path") or ""
            result = await issue_service.detect_provider(ws_path)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "issues.list":
            ws_path = payload.get("workspace_path") or ""
            limit = payload.get("limit") or 30
            result = await issue_service.list_issues(ws_path, limit)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "issues.get":
            ws_path = payload.get("workspace_path") or ""
            number = payload.get("number")
            result = await issue_service.get_issue(ws_path, number)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "issues.create":
            ws_path = payload.get("workspace_path") or ""
            title = payload.get("title") or ""
            body = payload.get("body") or ""
            result = await issue_service.create_issue(ws_path, title, body)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "issues.comment":
            ws_path = payload.get("workspace_path") or ""
            number = payload.get("number")
            body = payload.get("body") or ""
            result = await issue_service.comment_issue(ws_path, number, body)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "issues.set_state":
            ws_path = payload.get("workspace_path") or ""
            number = payload.get("number")
            state = payload.get("state") or ""
            result = await issue_service.set_issue_state(ws_path, number, state)
            await session.send_json(make_response(msg_id, msg_type, result))

        # ── Explorer filesystem (fs.*) ──────────────────────────────────────
        # Read-only directory scans run in a worker thread: os.scandir/os.walk
        # on a large repo or slow/network disk would otherwise block the event
        # loop and stall every other in-flight request on the connection.
        elif msg_type == "fs.list_dir":
            ws_path = payload.get("workspace_path") or ""
            rel = payload.get("rel_path", "") or ""
            _watch_plans_workspace(ws_path, rel)
            show_hidden = bool(payload.get("show_hidden", False))
            result = await asyncio.to_thread(fs_service.list_dir, ws_path, rel, show_hidden=show_hidden)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "fs.list_files_flat":
            ws_path = payload.get("workspace_path") or ""
            query = payload.get("query", "") or ""
            max_results = int(payload.get("max_results", 100))
            result = await asyncio.to_thread(
                fs_service.list_files_flat, ws_path, query=query, max_results=max_results
            )
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "fs.glob_files":
            ws_path = payload.get("workspace_path") or ""
            pattern = payload.get("pattern", "") or ""
            result = await asyncio.to_thread(fs_service.glob_files, ws_path, pattern=pattern)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "fs.mkdir":
            ws_path = payload.get("workspace_path") or ""
            result = await asyncio.to_thread(fs_service.mkdir, ws_path, payload.get("rel_path", "") or "")
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "fs.create_file":
            ws_path = payload.get("workspace_path") or ""
            result = await asyncio.to_thread(
                fs_service.create_file,
                ws_path, payload.get("rel_path", "") or "", payload.get("content", "") or ""
            )
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "fs.rename":
            ws_path = payload.get("workspace_path") or ""
            result = await asyncio.to_thread(
                fs_service.rename,
                ws_path, payload.get("src_path", "") or "", payload.get("dst_path", "") or ""
            )
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "fs.delete":
            ws_path = payload.get("workspace_path") or ""
            # to_thread: shutil.rmtree on a big dir would block the event loop.
            result = await asyncio.to_thread(fs_service.delete, ws_path, payload.get("rel_path", "") or "")
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "fs.write_file":
            ws_path = payload.get("workspace_path") or ""
            _watch_plans_workspace(ws_path, payload.get("rel_path", "") or "")
            expected_mtime = payload.get("expected_mtime")
            result = await asyncio.to_thread(
                fs_service.write_file,
                ws_path, payload.get("rel_path", "") or "", payload.get("content", "") or "",
                encoding=payload.get("encoding") or "utf-8",
                expected_mtime=float(expected_mtime) if expected_mtime is not None else None,
            )
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "fs.read_file":
            ws_path = payload.get("workspace_path") or ""
            _watch_plans_workspace(ws_path, payload.get("rel_path", "") or "")
            enc_override = payload.get("encoding_override") or None
            result = await asyncio.to_thread(
                fs_service.read_file, ws_path, payload.get("rel_path", "") or "", encoding_override=enc_override
            )
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "fs.stat_path":
            result = await asyncio.to_thread(fs_service.stat_path, payload.get("path", "") or "")
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "fs.read_image":
            ws_path = payload.get("workspace_path") or ""
            result = await asyncio.to_thread(fs_service.read_image, ws_path, payload.get("rel_path", "") or "")
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "fs.list_archive":
            ws_path = payload.get("workspace_path") or ""
            result = await asyncio.to_thread(
                fs_service.list_archive, ws_path, payload.get("rel_path", "") or ""
            )
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "fs.convert_office":
            ws_path = payload.get("workspace_path") or ""
            result = await asyncio.to_thread(
                fs_service.convert_office, ws_path, payload.get("rel_path", "") or ""
            )
            await session.send_json(make_response(msg_id, msg_type, result))

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
                await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "no command"}))
            else:
                resolved_cwd = Path(ws_path).resolve() if ws_path else None
                # Validate that cwd is a known registered workspace (or its subdirectory)
                known_roots = [Path(w).resolve() for w in attribution.known_workspaces()]
                cwd_allowed = resolved_cwd is None or any(
                    resolved_cwd == r or resolved_cwd.is_relative_to(r)
                    for r in known_roots
                )
                if not cwd_allowed:
                    await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "workspace path not registered"}))
                elif resolved_cwd and not resolved_cwd.is_dir():
                    await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "invalid workspace path"}))
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
                            await session.send_json(make_response(msg_id, msg_type, {
                                "ok": True, "output": output[:8000], "exit_code": proc.returncode,
                            }))
                        except asyncio.TimeoutError:
                            proc.kill()
                            await proc.communicate()
                            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "timeout after 30s"}))
                    except Exception as exc:
                        await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": str(exc)}))

        # ── Search (search.*) ───────────────────────────────────────────────
        elif msg_type == "search.find_in_files":
            # A new search supersedes any in-flight one from this session:
            # cancel it so stale scans don't stack up server-side. (The
            # frontend's seq guard already discards the stale response.)
            if session._search_cancel is not None:
                session._search_cancel.set()
            cancel_event = threading.Event()
            session._search_cancel = cancel_event
            result = await asyncio.to_thread(
                search_service.find_in_files,
                payload.get("workspace_path") or "",
                payload.get("query", "") or "",
                is_regex=bool(payload.get("is_regex")),
                case_sensitive=bool(payload.get("case_sensitive")),
                whole_word=bool(payload.get("whole_word")),
                includes=payload.get("includes", "") or "",
                excludes=payload.get("excludes", "") or "",
                cancel_event=cancel_event,
            )
            if session._search_cancel is cancel_event:
                session._search_cancel = None
            await session.send_json(make_response(msg_id, msg_type, result))

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
            await session.send_json(make_response(msg_id, msg_type, result))
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
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "editor.complete":
            result = await editor_service.complete(
                _az_base_url(),
                payload.get("model") or ANALYZER_DEFAULT_MODEL,
                payload.get("prefix", "") or "",
                payload.get("suffix", "") or "",
                payload.get("language", "") or "",
            )
            await session.send_json(make_response(msg_id, msg_type, result))

        # ── Onboarding (onboarding.*) ───────────────────────────────────────
        elif msg_type == "onboarding.status":
            status = await asyncio.to_thread(onboarding_deps.get_status)
            status["complete"] = onboarding_deps.is_complete()
            status["skip"] = onboarding_deps.should_skip()
            await session.send_json(make_response(msg_id, msg_type, status))

        elif msg_type == "onboarding.install":
            dep_id = payload.get("dep_id", "") or ""
            result = await asyncio.to_thread(onboarding_deps.install_dep, dep_id)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "onboarding.pull_model":
            model = payload.get("model", "") or onboarding_deps._SUGGESTED_MODEL
            result = onboarding_deps.pull_model(model)
            await session.send_json(make_response(msg_id, msg_type, result))

        elif msg_type == "onboarding.complete":
            onboarding_deps.set_complete(bool(payload.get("complete", True)))
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))

        elif msg_type == "onboarding.cli_health.dismiss":
            onboarding_deps.dismiss_cli_health(str(payload.get("fingerprint") or ""))
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))

        elif msg_type == "onboarding.cli_health.select_binary":
            result = onboarding_deps.select_cli_binary(
                str(payload.get("agent_key") or ""),
                str(payload.get("path") or ""),
                str(payload.get("fingerprint") or ""),
            )
            await session.send_json(make_response(msg_id, msg_type, result))

        # ── AI Chat ──────────────────────────────────────────────────────────────
        elif msg_type == "ai.chat.settings.get":
            await session.send_json(make_response(msg_id, msg_type, ai_chat_settings_store.get()))

        elif msg_type == "ai.chat.settings.set":
            updated = ai_chat_settings_store.set(payload)
            await session.send_json(make_response(msg_id, msg_type, updated))

        elif msg_type == "ai.chat.threads.get":
            ws_raw = payload.get("workspace_path", "") or ""
            await session.send_json(
                make_response(msg_id, msg_type, {"threads": chat_store.get_threads(ws_raw)})
            )

        elif msg_type == "ai.chat.threads.set":
            ws_raw = payload.get("workspace_path", "") or ""
            threads = payload.get("threads")
            saved = (
                chat_store.set_threads(ws_raw, threads)
                if isinstance(threads, list)
                else None
            )
            # ok mirrors persistence — gates the frontend's one-time
            # localStorage migration (legacy copy deleted only after ack).
            await session.send_json(
                make_response(msg_id, msg_type, {"ok": saved is not None})
            )

        elif msg_type == "ai.chat.notes.get":
            ws_raw = payload.get("workspace_path", "") or ""
            await session.send_json(
                make_response(msg_id, msg_type, chat_store.get_notes(ws_raw))
            )

        elif msg_type == "ai.chat.notes.set":
            ws_raw = payload.get("workspace_path", "") or ""
            notes = payload.get("notes")
            notepads = payload.get("notepads")
            saved = chat_store.set_notes(
                ws_raw,
                notes=notes if isinstance(notes, str) else "",
                notepads=notepads if isinstance(notepads, list) else [],
            )
            await session.send_json(
                make_response(msg_id, msg_type, {"ok": saved is not None})
            )

        elif msg_type == "ai.chat.provider.test":
            provider = str(payload.get("provider") or "")
            overrides = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
            result = await _test_ai_provider(provider, overrides)
            await session.send_json(make_response(msg_id, msg_type, result))

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
            await session.send_json(make_response(msg_id, msg_type, {"ok": True, "session_id": session_id}))

        elif msg_type == "ai.chat.accept_edit":
            ws_path = payload.get("workspace_path", "") or ""
            file_path = payload.get("file_path", "") or ""
            new_content = payload.get("new_content", "") or ""
            result = await asyncio.to_thread(fs_service.write_file, ws_path, file_path, new_content)
            await session.send_json(make_response(msg_id, msg_type, result))
            if result.get("ok"):
                asyncio.create_task(broadcast(make_event("git.changed", {"workspace_path": ws_path})))

        elif msg_type == "ai.chat.approve_command":
            from .ai_chat_tools import approve_command
            approve_command(
                str(payload.get("session_id", "")),
                str(payload.get("tool_id", "")),
                approved=True,
            )
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))

        elif msg_type == "ai.chat.reject_command":
            from .ai_chat_tools import approve_command
            approve_command(
                str(payload.get("session_id", "")),
                str(payload.get("tool_id", "")),
                approved=False,
            )
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))

        elif msg_type == "ai.chat.stop":
            for t in list(session._chat_tasks):
                t.cancel()
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))

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
            await session.send_json(make_response(msg_id, msg_type, {"ok": _tc_ok, "error": _tc_err}))

        elif msg_type == "ai.enhance_prompt":
            _ep_system = (payload.get("system") or "").strip()
            _ep_prompt = (payload.get("prompt") or "").strip()[:4000]
            _ep_model = (payload.get("model") or "").strip()
            _ep_provider = (payload.get("provider") or "").strip()
            if not _ep_prompt:
                await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "prompt is required"))
            else:
                try:
                    from .ai_chat_service import stream_chat
                    # Use a shallow copy of AI chat settings, overriding model if specified.
                    # (Session has no .settings attribute — reading it raised AttributeError
                    # on every call, so enhance_prompt always returned ok=False.)
                    _ep_settings = dict(ai_chat_settings_store.get())
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
                    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "content": _ep_content.strip()}))
                except Exception as _ep_exc:
                    await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": str(_ep_exc)}))

        elif msg_type == "ai.web.search":
            query = (payload.get("query") or "").strip()[:200]
            if not query:
                await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "query is required"))
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

                    await session.send_json(make_response(msg_id, msg_type, {"query": query, "results": results[:7]}))
                except Exception as _e:
                    await session.send_json(make_error(msg_id, msg_type, "SEARCH_ERROR", str(_e)))

        elif msg_type == "ai.review.stop":
            for t in list(session._review_tasks):
                t.cancel()
            await session.send_json(make_response(msg_id, msg_type, {"ok": True}))

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
            await session.send_json(make_response(msg_id, msg_type, {"ok": True, "review_id": review_id}))

        else:
            await session.send_json(
                make_error(msg_id, msg_type, "UNKNOWN_TYPE", f"Unsupported message type: {msg_type!r}")
            )
    except AgentCliProbeError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "CLI_PROBE_FAILED", str(err), err.details)
        )
    except FileNotFoundError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "SETUP_ERROR", str(err))
        )
    except KeyError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", f"missing field: {err}")
        )
    except Exception as err:  # noqa: BLE001
        log.exception("handle_message failed for type=%s", msg_type)
        if not session.dead:
            await session.send_json(
                make_error(msg_id, msg_type, "INTERNAL_ERROR", str(err))
            )
