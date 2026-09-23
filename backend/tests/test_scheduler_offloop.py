"""Scheduler store I/O must never run on the event-loop thread.

Same guard as test_watcher_offloop_discovery.py: the 2026-08-24 typing-latency
freeze was disk work done on the loop. Every SQLite call the scheduler makes
goes through asyncio.to_thread; this pins that for each store entry point.
"""

from __future__ import annotations

import threading
from pathlib import Path

from agent_team_backend.db import Database
from agent_team_backend.scheduler import SchedulerService
from agent_team_backend.scheduler_store import SchedulerStore


class _Bridge:
    def has_window(self) -> bool:
        return True

    def still_queued(self, msg_key) -> bool:
        return False

    async def budget_limited(self, action) -> bool:
        return False

    async def deliver(self, action) -> dict:
        return {"status": "ok", "msg_key": "k"}


async def test_store_io_runs_off_the_event_loop(tmp_path: Path) -> None:
    db = Database(tmp_path / "navide.db")
    store = SchedulerStore(db)
    loop_thread = threading.current_thread()
    seen: dict[str, list[threading.Thread]] = {}
    for name in (
        "_list_jobs", "_get_job", "_put_job", "_set_state", "_set_enabled",
        "_delete_job", "_append_run", "_list_runs", "_count_dispatched_since",
    ):
        original = getattr(store, name)

        def spy(*args, _name=name, _original=original):
            seen.setdefault(_name, []).append(threading.current_thread())
            return _original(*args)

        setattr(store, name, spy)

    now = [1_800_000_000.0]

    async def notify(jobs) -> None:
        return None

    service = SchedulerService(store, clock=lambda: now[0], bridge=_Bridge(), notify=notify)
    job = (await service.upsert({
        "name": "n",
        "schedule": {"kind": "every", "every_ms": 60_000},
        "action": {"kind": "message", "workspace": "/ws", "pane_name": "p", "text": "t"},
    }))["job"]
    await service.list()
    now[0] += 60
    await service.tick()
    for task, _manual in list(service._runs.values()):  # noqa: SLF001
        await task
    await service.runs(job["id"])
    await service.set_enabled(job["id"], False)
    await service.remove(job["id"])
    try:
        assert set(seen) >= {
            "_list_jobs", "_get_job", "_put_job", "_set_state", "_set_enabled",
            "_delete_job", "_append_run", "_list_runs", "_count_dispatched_since",
        }
        for name, threads in seen.items():
            assert all(t is not loop_thread for t in threads), f"{name} ran on the loop"
    finally:
        db.close()
