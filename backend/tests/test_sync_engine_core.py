"""Sync engine core: paging, cursors, origins, refusals and per-scope results.

Driven against the same ``FakeServer`` as ``test_sync_engine`` — which answers
like Navide-Server — because every bug here was a disagreement between what
the engine assumed the server said and what it actually says.
"""

from __future__ import annotations

import pytest

from agent_team_backend import sync_engine

from .test_sync_engine import Device, FakeServer, account_key  # noqa: F401 - a fixture


# ── X-0: paging ──────────────────────────────────────────────────────────────
async def test_a_pull_reads_every_page_not_just_the_first(tmp_path, account_key, monkeypatch):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {f"p{i}": {"n": i} for i in range(5)})
    await a.sync()
    monkeypatch.setattr(sync_engine, "PULL_PAGE", 2)
    b = Device(tmp_path, server, "dev-b")
    await b.sync()
    assert b.adapter.items == a.adapter.items
