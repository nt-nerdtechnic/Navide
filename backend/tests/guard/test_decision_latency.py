"""A hook decision must not wait on navide.db.

The backend shares one connection, behind one lock, across every thread.
Under load (2026-10-01: load average 50-90, 700+ event-loop stalls a day)
another thread can sit inside a SQLite call holding that lock for seconds,
and a decision that queued for it ran out its budget and failed open —
the risky calls (asks) included.
"""

from __future__ import annotations

import asyncio
import threading
import time

from agent_team_backend import guard_hooks
from agent_team_backend.guard import mark_tainted

PAYLOAD = {"tool_name": "Bash", "tool_input": {"command": 'eval "$X"'}}


def _respond():
    return asyncio.run(guard_hooks.respond("claude", PAYLOAD, pane_id="p1", cwd="/w", workspace="/w"))


def test_decision_does_not_wait_on_a_held_database_lock(guard_store, monkeypatch):
    announced = []
    monkeypatch.setattr(guard_hooks, "_announce_failure", lambda pane, reason: announced.append(reason))
    monkeypatch.setattr(guard_hooks, "EVALUATE_BUDGET_S", 0.2)
    mark_tainted("p1", "remote", "chat message")
    assert _respond()["hookSpecificOutput"]["permissionDecision"] == "ask"  # warm

    held, release = threading.Event(), threading.Event()

    def hold_lock():
        with guard_store._db._lock:
            held.set()
            release.wait(5)

    holder = threading.Thread(target=hold_lock)
    holder.start()
    held.wait(5)
    try:
        started = time.monotonic()
        answer = _respond()
        elapsed = time.monotonic() - started
    finally:
        release.set()
        holder.join()

    assert answer["hookSpecificOutput"]["permissionDecision"] == "ask"
    assert elapsed < 0.2
    assert announced == []
    # The audit row is written once the lock frees up, and reads see it.
    assert len(guard_store.audit_list()) == 2
