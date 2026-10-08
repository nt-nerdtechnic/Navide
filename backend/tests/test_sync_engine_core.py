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


# ── X-1: a push reply must not move the cursor past someone else's write ─────
async def test_a_write_landing_between_pull_and_push_is_not_skipped(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a")
    b = Device(tmp_path, server, "dev-b", {"mine": {"v": "b"}})
    forward = b.engine._request
    interleaved = False

    async def request(msg_type, payload):
        nonlocal interleaved
        if msg_type == "sync.push" and not interleaved:
            # Another device writes after B pulled and before B pushes.
            interleaved = True
            a.adapter.items["theirs"] = {"v": "a"}
            await a.sync()
        return await forward(msg_type, payload)

    b.engine._request = request
    await b.sync()
    await b.sync()
    assert b.adapter.items.get("theirs") == {"v": "a"}


# ── X-2 / SEC-12 / SEC-1: who wrote a record ─────────────────────────────────
def test_the_pinned_signing_key_is_read_from_the_field_pins_store(monkeypatch):
    from agent_team_backend import trust_store

    monkeypatch.setattr(trust_store, "pin_for", lambda _d: {"signKey": "KEY", "memberId": "m"})
    assert sync_engine._pinned_signing_key("dev-x") == "KEY"
