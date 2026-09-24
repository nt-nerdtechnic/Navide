"""Tainted panes: panes that received text from outside the local user.

A pane is marked when a message from a chat channel, another device, another
pane, or an MCP client is delivered into it; a human typing never marks it.
The mark lives in navide.db so it survives restarts, and it follows pane-id
aliases: a pane restored under a new id inherits its former id's mark.
Only the renderer (``guard.taint.clear`` ws request) clears it.
"""

from __future__ import annotations

import logging
import time

from . import runtime

log = logging.getLogger(__name__)


def _canonical(pane_id: str) -> str:
    from .. import agent_messaging

    pane = agent_messaging.current(pane_id)
    return pane.pane_id if pane is not None else pane_id


def _former_ids(canonical: str) -> list[str]:
    from .. import agent_messaging

    return [old for old, alias in agent_messaging._ALIASES.items() if alias.pane_id == canonical]


def _row(pane_id: str) -> dict | None:
    """The taint row for a pane, adopting a former id's row when needed."""
    store = runtime.store()
    canonical = _canonical(pane_id)
    row = store.taint_get(canonical)
    if row is not None:
        return row
    for old in _former_ids(canonical) + ([pane_id] if pane_id != canonical else []):
        prior = store.taint_get(old)
        if prior is not None:
            store.taint_upsert(canonical, prior["sources"], prior["since"], prior["detail"])
            store.taint_delete(old)
            return store.taint_get(canonical)
    return None


def mark_tainted(pane_id: str, source: str, detail: str = "") -> None:
    if not pane_id:
        return
    canonical = _canonical(pane_id)
    row = _row(canonical)
    if row is not None and source in row["sources"]:
        return
    sources = (row["sources"] if row else []) + [source]
    since = row["since"] if row else time.time()
    runtime.store().taint_upsert(canonical, sources, since, (detail or "")[:200])
    if row is None:
        runtime.emit("guard.taint_changed", {"pane_id": canonical, "tainted": True})


def safe_mark_tainted(pane_id: str, source: str, detail: str = "") -> None:
    """For delivery paths: marking must never break message delivery."""
    try:
        mark_tainted(pane_id, source, detail)
    except Exception as err:  # noqa: BLE001
        log.warning("guard: could not mark pane %s tainted: %s", pane_id, err)


def is_tainted(pane_id: str) -> bool:
    return bool(pane_id) and _row(pane_id) is not None


def clear_taint(pane_id: str) -> None:
    canonical = _canonical(pane_id)
    removed = False
    for pid in {canonical, pane_id, *_former_ids(canonical)}:
        removed = runtime.store().taint_delete(pid) or removed
    if removed:
        runtime.emit("guard.taint_changed", {"pane_id": canonical, "tainted": False})


def list_tainted() -> list[dict]:
    """Rows under each pane's current id: a restored pane's row stays under its
    former id until a lookup adopts it, and the window only knows the new id."""
    rows: dict[str, dict] = {}
    for row in runtime.store().taint_list():
        pane_id = _canonical(row["pane_id"])
        rows.setdefault(pane_id, {**row, "pane_id": pane_id})
    return list(rows.values())
