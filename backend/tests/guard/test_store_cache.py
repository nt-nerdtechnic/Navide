"""GuardStore's decision caches against a write that lands mid-load, and the
audit queue against shutdown.

evaluate() loads a cache on a worker thread while the loop thread writes. The
interleaving that lost a write is: the load SELECTs, the write commits and
invalidates, then the load assigns what it read. Each test forces exactly
that order by running the write right after the load's read returns."""

from __future__ import annotations

import ast
import threading
from contextlib import contextmanager
from pathlib import Path

from agent_team_backend.db import Database
from agent_team_backend.guard.store import GuardStore


def _write_after_first_read(monkeypatch, store, write, attr="transaction"):
    real = getattr(store._db, attr)
    fired: list[bool] = []

    def fire():
        if not fired:
            fired.append(True)
            write()

    if attr == "transaction":
        @contextmanager
        def wrapped():
            with real() as cur:
                yield cur
            fire()
    else:
        def wrapped(*args, **kwargs):
            value = real(*args, **kwargs)
            fire()
            return value

    monkeypatch.setattr(store._db, attr, wrapped)
    return fired


def test_rule_added_during_a_rules_load_is_not_lost(guard_store, monkeypatch):
    fired = _write_after_first_read(monkeypatch, guard_store, lambda: guard_store.rules_add("deny", "rm -rf /x"))
    guard_store.rules_list()  # the load the write lands in
    assert fired
    assert [r["pattern"] for r in guard_store.rules_list()] == ["rm -rf /x"]


def test_taint_marked_during_a_taint_load_is_not_lost(guard_store, monkeypatch):
    fired = _write_after_first_read(
        monkeypatch, guard_store, lambda: guard_store.taint_upsert("p1", ["web"], 1.0, "fetched a page"))
    guard_store.taint_get("p1")
    assert fired
    assert guard_store.taint_get("p1")["sources"] == ["web"]


def test_taint_cleared_during_a_taint_load_is_not_resurrected(guard_store, monkeypatch):
    guard_store.taint_upsert("p1", ["web"], 1.0, "x")
    guard_store._taint_cache = None
    fired = _write_after_first_read(monkeypatch, guard_store, lambda: guard_store.taint_delete("p1"))
    guard_store.taint_get("p1")
    assert fired
    assert guard_store.taint_get("p1") is None


def test_branch_protected_during_a_grading_load_is_not_lost(guard_store, monkeypatch):
    fired = _write_after_first_read(monkeypatch, guard_store, lambda: guard_store.add_protected_branch("release"))
    guard_store.grading()
    assert fired
    assert "release" in guard_store.protected_branches()


def test_category_set_during_a_terminal_load_is_not_lost(guard_store, monkeypatch):
    fired = _write_after_first_read(
        monkeypatch, guard_store, lambda: guard_store.terminal_set_category("classifier-high", True))
    guard_store.terminal_settings()
    assert fired
    assert "classifier-high" not in guard_store.terminal_settings().disabled


def test_disable_during_an_enabled_load_is_not_lost(guard_store, monkeypatch):
    fired = _write_after_first_read(monkeypatch, guard_store, lambda: guard_store.set_enabled(False), attr="kv_get")
    guard_store.enabled()
    assert fired
    assert guard_store.enabled() is False


# ── shutdown ────────────────────────────────────────────────────────────────

def _entry(i: int) -> dict:
    return {"pane_id": f"p{i}", "vendor": "claude", "source": "local", "tool": "Bash", "excerpt": "x",
            "level": "high", "action": "ask", "rule_ids": ["git-push"], "tainted": False}


def test_flush_writes_queued_audits_before_the_database_closes(tmp_path, monkeypatch):
    db = Database(tmp_path / "navide.db")
    store = GuardStore(db)
    gate = threading.Event()
    real = store._audit_insert

    def slow_insert(entry):
        gate.wait(5)
        real(entry)

    monkeypatch.setattr(store, "_audit_insert", slow_insert)
    for i in range(3):
        store.audit_add(_entry(i))
    threading.Timer(0.05, gate.set).start()
    store.flush()
    db.close()

    reopened = GuardStore(Database(tmp_path / "navide.db"))
    assert len(reopened.audit_list()) == 3


def test_the_backend_flushes_guard_audits_before_closing_the_database():
    src = Path(__file__).resolve().parents[2] / "agent_team_backend" / "app.py"
    tree = ast.parse(src.read_text(encoding="utf-8"))
    stoppers = [n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "_stop_log_watcher"]
    assert len(stoppers) == 1
    lines: dict[str, int] = {}
    for node in ast.walk(stoppers[0]):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            key = f"{node.func.value.id}.{node.func.attr}"
            lines.setdefault(key, node.lineno)
    assert "guard_runtime.flush" in lines and "database.close" in lines
    assert lines["guard_runtime.flush"] < lines["database.close"]
