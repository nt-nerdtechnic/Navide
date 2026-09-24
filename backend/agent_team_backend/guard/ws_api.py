"""WS request handlers for ``guard.*`` (registered at the end of ws_handlers.py).

Renderer-only control surface. These are ws request types, not renderer UI
actions, so MCP ``ui_invoke`` (which only forwards ``ui.*`` actions to a
window) cannot reach them — an agent must never be able to switch the guard
off, loosen rules, or clear its own taint mark.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any

from ..ipc import make_response
from . import policy, runtime, taint
from .classify import classify
from .engine import HOOK_SUPPORT

if TYPE_CHECKING:
    from ..app import Session

log = logging.getLogger(__name__)

MESSAGE_TYPES = (
    "guard.status", "guard.set_enabled", "guard.rules.list", "guard.rules.add", "guard.rules.remove",
    "guard.audit.list", "guard.taint.list", "guard.taint.clear", "guard.test",
)
_SOURCES = ("local", "relay", "remote", "agent")


def _dispatch(msg_type: str, payload: dict) -> dict[str, Any]:
    store = runtime.store()
    if msg_type == "guard.status":
        return {
            "ok": True,
            "enabled": store.enabled(),
            "counts": store.audit_counts(time.time() - 86400),
            "hook_support": dict(HOOK_SUPPORT),
        }
    if msg_type == "guard.set_enabled":
        if not isinstance(payload.get("enabled"), bool):
            raise ValueError("enabled must be a boolean")
        store.set_enabled(payload["enabled"])
        return {"ok": True}
    if msg_type == "guard.rules.list":
        return {"ok": True, "rules": store.rules_list()}
    if msg_type == "guard.rules.add":
        store.rules_add(str(payload.get("kind") or ""), str(payload.get("pattern") or ""),
                        str(payload.get("note") or ""))
        return {"ok": True, "rules": store.rules_list()}
    if msg_type == "guard.rules.remove":
        try:
            rule_id = int(payload.get("id"))
        except (TypeError, ValueError):
            raise ValueError("id must be an integer") from None
        store.rules_remove(rule_id)
        return {"ok": True, "rules": store.rules_list()}
    if msg_type == "guard.audit.list":
        pane_id = payload.get("pane_id")
        return {"ok": True, "entries": store.audit_list(payload.get("limit") or 100,
                                                          str(pane_id) if pane_id else None)}
    if msg_type == "guard.taint.list":
        return {"ok": True, "panes": taint.list_tainted()}
    if msg_type == "guard.taint.clear":
        pane_id = str(payload.get("pane_id") or "")
        if not pane_id:
            raise ValueError("pane_id is required")
        taint.clear_taint(pane_id)
        return {"ok": True}
    if msg_type == "guard.test":
        return _test(payload)
    return {"ok": False, "error": f"unknown request {msg_type}"}


def _test(payload: dict) -> dict[str, Any]:
    """Settings "try it" box: classify + policy, no audit, no taint lookup."""
    command = str(payload.get("command") or "")
    source = str(payload.get("source") or "local")
    if source not in _SOURCES:
        raise ValueError(f"source must be one of {', '.join(_SOURCES)}")
    tainted = bool(payload.get("tainted"))
    workspace = str(payload.get("workspace") or "")
    verdict = classify("shell", {"command": command}, cwd=workspace, workspace=workspace)
    store = runtime.store()
    level, rule_ids = policy.apply_user_rules(verdict.level, verdict.rule_ids, command, store.rules_list())
    level = policy.effective_level(level, parseable=verdict.parseable, tainted=tainted)
    action = policy.decide(level, source, tainted=tainted) if store.enabled() else "allow"
    return {
        "ok": True,
        "verdict": {
            "level": verdict.level, "rule_ids": list(verdict.rule_ids),
            "reasons": list(verdict.reasons), "parseable": verdict.parseable,
        },
        "decision": {"action": action, "level": level, "rule_ids": list(rule_ids), "tainted": tainted},
    }


async def handle(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    try:
        result = _dispatch(msg_type, payload or {})
    except ValueError as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — answer instead of dropping the request
        log.exception("guard: %s failed", msg_type)
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    await session.send_json(make_response(msg_id, msg_type, result))
