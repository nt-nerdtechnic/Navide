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

from .. import confirm_token
from ..ipc import make_error, make_response
from . import policy, runtime, taint, terminal_policy
from .classify import classify
from .engine import HOOK_SUPPORT

if TYPE_CHECKING:
    from ..app import Session

log = logging.getLogger(__name__)

MESSAGE_TYPES = (
    "guard.status", "guard.set_enabled", "guard.rules.list", "guard.rules.add", "guard.rules.remove",
    "guard.audit.list", "guard.taint.list", "guard.taint.events", "guard.taint.clear", "guard.test",
    "guard.terminal.get", "guard.terminal.set_category", "guard.terminal.add_pattern",
    "guard.terminal.remove_pattern", "guard.terminal.test",
)


class ConfirmationRequired(Exception):
    """A change that loosens terminal command protection arrived without a
    live confirmation from the main process (see confirm_token)."""


def _require_confirm(msg_type: str, payload: dict, subject: str) -> None:
    """Loosening terminal command protection is a trust change: only a
    person's window can mint the confirmation, so MCP and the plugin broker —
    which reach these handlers over the same socket — cannot."""
    reason = confirm_token.check(payload.get("confirm"), action=msg_type, device_id="", subject=subject)
    if reason:
        raise ConfirmationRequired(reason)


def _terminal_state() -> dict[str, Any]:
    store = runtime.store()
    settings = store.terminal_settings()
    return {
        "ok": True,
        "categories": [
            {"id": c.id, "description": c.description, "example": c.example,
             "enabled": c.id not in settings.disabled, "default_enabled": c.id not in terminal_policy.DEFAULT_OFF}
            for c in terminal_policy.CATEGORIES
        ],
        "patterns": [{"id": r["id"], "kind": r["kind"], "pattern": r["pattern"]} for r in store.terminal_patterns()],
    }


def _terminal(msg_type: str, payload: dict) -> dict[str, Any]:
    store = runtime.store()
    if msg_type == "guard.terminal.get":
        return _terminal_state()
    if msg_type == "guard.terminal.set_category":
        category = str(payload.get("id") or "")
        if not isinstance(payload.get("enabled"), bool):
            raise ValueError("enabled must be a boolean")
        if category not in terminal_policy.CATEGORY_IDS:
            raise ValueError(f"unknown category: {category}")
        if not payload["enabled"]:
            _require_confirm(msg_type, payload, f"{category}:off")
        store.terminal_set_category(category, payload["enabled"])
        return _terminal_state()
    if msg_type == "guard.terminal.add_pattern":
        kind = str(payload.get("kind") or "")
        pattern = str(payload.get("pattern") or "").strip()
        if kind not in ("block", "allow"):
            raise ValueError("kind must be 'block' or 'allow'")
        problem = terminal_policy.validate_pattern(pattern)
        if problem:
            raise ValueError(problem)
        if kind == "allow":
            _require_confirm(msg_type, payload, f"allow:{pattern}")
        store.terminal_add_pattern(kind, pattern)
        return _terminal_state()
    if msg_type == "guard.terminal.remove_pattern":
        try:
            pattern_id = int(payload.get("id"))
        except (TypeError, ValueError):
            raise ValueError("id must be an integer") from None
        row = store.terminal_pattern(pattern_id)
        if row is None:
            raise ValueError("no such pattern")
        if row["kind"] == "block":
            _require_confirm(msg_type, payload, str(pattern_id))
        store.terminal_remove_pattern(pattern_id)
        return _terminal_state()
    if msg_type == "guard.terminal.test":
        # The very function every enforcement path calls, minus the audit row
        # and the notice: what this box says is what enforcement does.
        workspace = str(payload.get("workspace") or "")
        refusal = terminal_policy.check_with_store(str(payload.get("command") or ""), workspace=workspace)
        return {"ok": True, "refused": refusal is not None, "refusal": refusal.as_dict() if refusal else None}
    return {"ok": False, "error": f"unknown request {msg_type}"}
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
    if msg_type == "guard.taint.events":
        pane_id = str(payload.get("pane_id") or "")
        if not pane_id:
            raise ValueError("pane_id is required")
        return {"ok": True, "events": taint.taint_events(pane_id)}
    if msg_type == "guard.taint.clear":
        pane_id = str(payload.get("pane_id") or "")
        if not pane_id:
            raise ValueError("pane_id is required")
        taint.clear_taint(pane_id)
        return {"ok": True}
    if msg_type == "guard.test":
        return _test(payload)
    if msg_type.startswith("guard.terminal."):
        return _terminal(msg_type, payload)
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
    action = policy.decide(level, source, tainted=tainted) if policy.enforced(store.enabled(), source) else "allow"
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
    except ConfirmationRequired as exc:
        log.warning("refusing %s: %s", msg_type, exc)
        await session.send_json(make_error(msg_id, msg_type, "CONFIRMATION_REQUIRED", str(exc)))
        return
    except ValueError as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — answer instead of dropping the request
        log.exception("guard: %s failed", msg_type)
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    await session.send_json(make_response(msg_id, msg_type, result))
