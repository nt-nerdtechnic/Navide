"""Chat-channel gateway: bridge Navide panes to Telegram/Discord/Slack/...

``start()`` / ``stop()`` run from the app lifespan; ``get_manager()`` serves the
ws handlers. ``default_seams()`` is the only place that reaches into the rest of
the backend — the manager itself is pure pipeline and tested with fakes.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .manager import ChannelManager, Seams

log = logging.getLogger(__name__)

_manager: ChannelManager | None = None
_start_task: asyncio.Task[None] | None = None


def get_manager() -> ChannelManager | None:
    return _manager


def default_seams() -> Seams:
    from .. import agent_messaging
    from ..ipc import make_event
    from ..mcp_server import server as mcp

    async def deliver(pane_id: str, text: str, from_display: str) -> dict[str, Any]:
        res = agent_messaging.resolve_pane_id("", pane_id)
        if res.pane is None:
            return {"ok": False, "error": res.error or "pane is gone"}
        target = res.pane
        if not target.realized:
            # Same as the scheduler's open_target=True: a restore placeholder
            # would otherwise park the message until someone opens it.
            opened = await mcp._open_placeholder(target)
            if opened.get("ok"):
                target = opened["pane"]
        msg_key = await mcp._dispatch_delivery(
            target, text, caller=mcp._Caller(kind="host"), me="",
            cross_workspace=res.cross_workspace, from_display=from_display,
        )
        return {"ok": True, "msg_key": msg_key, "pane_id": target.pane_id}

    async def await_verdict(msg_key: str, timeout: float) -> dict[str, Any]:
        await mcp._await_delivery(msg_key, timeout)
        entry = mcp._mcp_message_status.get(msg_key)
        if entry is None:
            return {"status": "queued", "unknown": True}
        return {"status": entry["status"], "reason": entry.get("reason"), "hold": entry.get("hold")}

    async def interrupt(pane_id: str) -> dict[str, Any]:
        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {"ok": False, "error": "pane is gone"}
        reply = await mcp._ui_request(
            pane.workspace_path, "invoke", caller=mcp._pane_caller(pane.pane_id),
            action="ui.pane.interrupt", args={"paneId": pane.pane_id},
        )
        if not reply.get("ok"):
            return {"ok": False, "error": str(reply.get("error") or "the window did not answer")}
        result = reply.get("result") or {}
        return {"ok": True, "sent": bool(result.get("sent"))}

    def pane_state(pane_id: str) -> dict[str, Any]:
        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {"exists": False, "busy": False, "display_status": ""}
        return {"exists": True, "busy": bool(pane.busy),
                "display_status": getattr(pane, "display_status", "") or ""}

    async def awaiting_info(pane_id: str) -> dict[str, Any]:
        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {}
        reply = await mcp._ui_request(
            pane.workspace_path, "invoke", caller=mcp._pane_caller(pane.pane_id),
            action="ui.pane.getStatus", args={"paneId": pane.pane_id},
        )
        result = reply.get("result") or {}
        kind = str(result.get("awaitingKind") or "")
        if kind not in ("permission", "question"):
            kind = "permission" if result.get("status") == "awaiting" else ""
        options = result.get("awaitingOptions")
        return {
            "kind": kind,
            "prompt": str(result.get("awaitingPrompt") or ""),
            "options": [str(o) for o in options] if isinstance(options, list) else [],
        }

    async def answer(pane_id: str, answer_payload: dict[str, Any]) -> dict[str, Any]:
        pane = agent_messaging.current(pane_id)
        if pane is None:
            return {"ok": False, "error": "pane is gone"}
        reply = await mcp._ui_request(
            pane.workspace_path, "invoke", caller=mcp._pane_caller(pane.pane_id),
            action="ui.pane.sendKeys", args={"paneId": pane.pane_id, "answer": answer_payload},
        )
        if not reply.get("ok"):
            return {"ok": False, "error": str(reply.get("error") or "the window did not answer")}
        result = reply.get("result") or {}
        if not result.get("ok", True) or not result.get("sent"):
            return {"ok": False, "error": str(result.get("error") or "not sent")}
        return {"ok": True}

    def resolve_pane(pane_id: str) -> str:
        pane = agent_messaging.current(pane_id)
        return pane.pane_id if pane is not None else ""

    async def broadcast(event_type: str, payload: dict[str, Any]) -> None:
        from .. import app

        await app.broadcast(make_event(event_type, payload))

    # The vault shells out to the Keychain (blocking, up to 10s): keep it off the loop.
    async def read_secret(name: str) -> str | None:
        from .. import app

        return await asyncio.to_thread(app.credential_vault.read_app_secret, name)

    async def write_secret(name: str, secret: str | None) -> None:
        from .. import app

        await asyncio.to_thread(app.credential_vault.write_app_secret, name, secret)

    return Seams(
        deliver=deliver, await_verdict=await_verdict, interrupt=interrupt, pane_state=pane_state,
        awaiting_info=awaiting_info, answer=answer, resolve_pane=resolve_pane, broadcast=broadcast,
        read_secret=read_secret, write_secret=write_secret,
    )


async def start() -> None:
    """Load channel config and start enabled adapters. Never raises into the lifespan."""
    global _manager, _start_task
    from .. import app
    from .store import ChannelStore

    if _manager is not None:
        return
    try:
        manager = ChannelManager(ChannelStore(app.database), default_seams())
        _manager = manager
        app.pane_activity_listeners.append(manager.on_pane_activity)
        # Keychain reads can take seconds; adapters come up without holding the lifespan.
        _start_task = asyncio.create_task(manager.start(), name="channels-start")
        _start_task.add_done_callback(_log_start_failure)
    except Exception:  # noqa: BLE001 — chat channels must never block startup
        log.exception("channels: start failed")


def _log_start_failure(task: asyncio.Task[None]) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.error("channels: start failed", exc_info=task.exception())


async def stop() -> None:
    global _manager
    from .. import app

    manager, _manager = _manager, None
    if manager is None:
        return
    try:
        app.pane_activity_listeners.remove(manager.on_pane_activity)
    except ValueError:
        pass
    try:
        await manager.stop()
    except Exception:  # noqa: BLE001
        log.exception("channels: stop failed")
