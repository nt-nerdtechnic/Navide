"""Approval before a synced skill or MCP server can run here.

A record another device sends can carry something this machine will execute:
an MCP server's command, a skill's scripts. Applying it on arrival meant one
compromised device could run code on every other device of the account. So a
record that is *new here*, or that changes what would run, is held instead of
applied — not written, not enabled, not projected to any CLI, no executable
bit — until the user approves it in the main window. A change that does not
touch what runs (a skill switched off, a rotated token in an MCP env) and a
deletion behave as before.

The skills install gate (``skills_approvals``) is the model: a pending
request, approve or reject in the window, the write only on approval. It is
not reused as-is because its records live in memory and point at installer
previews. A held sync record has to survive a restart: while it waits, the
adapter shows the engine the held payload in place of the local item (see
``overlay``), so the engine sees agreement and pushes nothing. Forgetting the
hold on a restart would make the next round push this machine's old copy over
the change on every other device. Hence:

- the index lives in the UI settings under ``APPROVALS_KEY``, as
  ``{scope: {item_id: {digest, base, status, kind, summary, at}}}`` — no
  secret in it (``summary`` names what would run, env and header *values*
  are never in it);
- the payload itself is sealed under the account key, the same way it
  travelled, in a file under the app data directory.

A rejection is kept: the cloud copy goes on standing in for the local item, so
nothing is pushed back, until a newer record for the item arrives — which is
a new request. A local edit of the item while it waits ends the hold: the edit
is the user's newer decision and syncs as one.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any

from . import sync_engine, sync_keyring

log = logging.getLogger("agent_team_backend.sync_approvals")

APPROVALS_KEY = "sync-approvals"

PENDING = "pending"
REJECTED = "rejected"
#: Approved, but not landed yet (a large skill's files still downloading).
APPROVED = "approved"

#: Why a record waits: the item is not here at all, or what runs changed.
KIND_NEW = "new"
KIND_CHANGED = "changed"


def _settings():
    from . import app

    return app.ui_settings_store


def _stash_dir() -> Path:
    from . import app

    return app.app_data_dir() / "sync-approvals"


def _stash_path(scope: str, item_id: str) -> Path:
    name = hashlib.sha256(f"{scope}\0{item_id}".encode("utf-8")).hexdigest()
    return _stash_dir() / scope / f"{name}.sealed"


def _index() -> dict[str, dict[str, dict[str, Any]]]:
    raw = _settings().get().get(APPROVALS_KEY)
    if not isinstance(raw, dict):
        return {}
    return {
        str(scope): {str(i): dict(e) for i, e in entries.items() if isinstance(e, dict)}
        for scope, entries in raw.items()
        if isinstance(entries, dict)
    }


def _write_index(index: dict[str, dict[str, dict[str, Any]]]) -> None:
    _settings().set({APPROVALS_KEY: {s: e for s, e in index.items() if e} or None})


def _round_is_stale() -> bool:
    # A round begun for the previous account must not file requests under
    # the next one (the same guard the detached marks take).
    is_current = getattr(sync_engine, "round_is_current", None)
    return is_current is not None and not is_current()


def digest(payload: Any) -> str:
    return sync_engine.digest(payload)


def entry(scope: str, item_id: str) -> dict[str, Any] | None:
    return _index().get(scope, {}).get(item_id)


def hold(
    scope: str,
    item_id: str,
    payload: Any,
    *,
    local: Any | None,
    kind: str,
    summary: dict[str, Any],
) -> None:
    """File *payload* for approval instead of applying it. Worker thread.

    ``local`` is the item as this machine holds it now (None when absent);
    its digest is what ``overlay`` checks to notice a local edit.
    """
    if _round_is_stale():
        return
    path = _stash_path(scope, item_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    sealed = sync_keyring.encrypt(sync_engine.canonical(payload), scope=scope, item_id=item_id)
    temp = path.with_suffix(".tmp")
    temp.write_text(sealed, encoding="utf-8")
    temp.replace(path)
    index = _index()
    index.setdefault(scope, {})[item_id] = {
        "digest": digest(payload),
        "base": digest(local) if local is not None else "",
        "status": PENDING,
        "kind": kind,
        "summary": summary,
        "at": int(time.time()),
    }
    _write_index(index)
    log.info("synced %s/%s is waiting for approval (%s)", scope, item_id, kind)


def held_payload(scope: str, item_id: str) -> Any | None:
    """The held payload, or None when there is none or it will not open here."""
    path = _stash_path(scope, item_id)
    try:
        sealed = path.read_text(encoding="utf-8")
        return json.loads(sync_keyring.decrypt(sealed, scope=scope, item_id=item_id))
    except FileNotFoundError:
        return None
    except Exception as err:  # noqa: BLE001 - a hold that will not open is no hold
        log.warning("the held %s/%s could not be opened: %s", scope, item_id, err)
        return None


def drop(scope: str, item_id: str) -> None:
    index = _index()
    if index.get(scope, {}).pop(item_id, None) is not None:
        _write_index(index)
    _stash_path(scope, item_id).unlink(missing_ok=True)


def is_approved(scope: str, item_id: str, payload: Any) -> bool:
    """Whether the user approved exactly *payload* for this item."""
    held = entry(scope, item_id)
    return bool(held and held.get("status") == APPROVED and held.get("digest") == digest(payload))


def is_rejected(scope: str, item_id: str, payload: Any) -> bool:
    held = entry(scope, item_id)
    return bool(held and held.get("status") == REJECTED and held.get("digest") == digest(payload))


def overlay(scope: str, snapshot: dict[str, Any]) -> dict[str, Any]:
    """*snapshot* with each held item replaced by its held payload.

    That is what keeps the engine from pushing this machine's copy over the
    change it holds. A hold whose local copy has since changed (or whose
    payload no longer opens) is dropped: the local edit is newer.
    """
    held = _index().get(scope)
    if not held:
        return snapshot
    out = dict(snapshot)
    for item_id, record in held.items():
        local = snapshot.get(item_id)
        local_digest = digest(local) if local is not None else ""
        if local_digest != record.get("base", ""):
            log.info("%s/%s changed here while it waited for approval; the local edit wins", scope, item_id)
            drop(scope, item_id)
            continue
        payload = held_payload(scope, item_id)
        if payload is None:
            drop(scope, item_id)
            continue
        out[item_id] = payload
    return out


def set_status(scope: str, item_id: str, status: str) -> None:
    index = _index()
    record = index.get(scope, {}).get(item_id)
    if record is None:
        return
    record["status"] = status
    _write_index(index)


def listing() -> list[dict[str, Any]]:
    """Every held record, for the window: no payload, only its summary."""
    out = []
    for scope, entries in sorted(_index().items()):
        for item_id, record in sorted(entries.items()):
            out.append({
                "scope": scope,
                "itemId": item_id,
                "status": record.get("status", PENDING),
                "kind": record.get("kind", KIND_NEW),
                "summary": record.get("summary") or {},
                "at": record.get("at", 0),
            })
    return out


def decide(adapter: Any, item_id: str, approve: bool) -> dict[str, Any]:
    """Apply the user's decision on one held record. Worker thread.

    Approval writes the held payload through the adapter, now let past the
    gate; a large skill whose files must download first stays ``approved``
    until they land (``SkillFilesScope`` retries it each round). Rejection
    keeps the hold, so the cloud copy goes on standing in for the local one.
    """
    scope = adapter.scope
    record = entry(scope, item_id)
    if record is None:
        raise sync_engine.SyncError(f"nothing from {scope}/{item_id} is waiting for approval")
    if not approve:
        set_status(scope, item_id, REJECTED)
        return {"scope": scope, "itemId": item_id, "status": REJECTED}
    payload = held_payload(scope, item_id)
    if payload is None:
        drop(scope, item_id)
        raise sync_engine.SyncError(f"the held {scope}/{item_id} could not be opened here")
    set_status(scope, item_id, APPROVED)
    return {"scope": scope, "itemId": item_id, "status": land(adapter, item_id, payload)}


def land(adapter: Any, item_id: str, payload: Any) -> str:
    """Write an approved payload; the status it leaves the hold in."""
    scope = adapter.scope
    try:
        result = adapter.apply(item_id, payload)
    except sync_engine.DeferItem:
        return APPROVED  # files on their way; landed on a later round
    if result is False:
        # Refused here after all (the store would not take it). The hold goes
        # back to waiting, so the window shows it still unresolved.
        set_status(scope, item_id, PENDING)
        raise sync_engine.SyncError(f"{scope}/{item_id} was approved but could not be written here")
    drop(scope, item_id)
    return "applied"


def land_approved(adapter: Any) -> None:
    """Retry every approved-but-not-landed hold of *adapter*'s scope."""
    for item_id, record in list(_index().get(adapter.scope, {}).items()):
        if record.get("status") != APPROVED:
            continue
        payload = held_payload(adapter.scope, item_id)
        if payload is None:
            drop(adapter.scope, item_id)
            continue
        try:
            land(adapter, item_id, payload)
        except sync_engine.SyncError as err:
            log.warning("%s", err)


def forget_approvals(scope: str | None = None) -> None:
    """Drop every hold of *scope*, or of every scope — on an account change,
    whose key the held payloads are sealed under."""
    index = _index()
    scopes = list(index) if scope is None else [scope]
    for name in scopes:
        for item_id in list(index.get(name, {})):
            _stash_path(name, item_id).unlink(missing_ok=True)
        index.pop(name, None)
    _write_index(index)
