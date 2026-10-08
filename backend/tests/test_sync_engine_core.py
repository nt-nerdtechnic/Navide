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


def _forged(server: FakeServer, item_id: str, *, device: str, deleted: bool, body: str = "") -> int:
    rev = server.cursors.get("prompts", 0) + 1
    server.cursors["prompts"] = rev
    server.rows[("prompts", item_id)] = {
        "itemId": item_id, "rev": rev, "updatedAt": "2030-01-01T00:00:00+00:00",
        "deviceId": device, "deleted": 1 if deleted else 0,
        "body": body or None, "sig": "forged",
    }
    return rev


async def test_a_forged_record_from_a_pinned_device_is_dropped(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    await b.sync()
    _forged(server, "x", device="dev-a", deleted=True)
    await b.sync()
    assert b.adapter.items == {"x": {"v": 1}}
    assert not b.store.state("prompts", "x").deleted


async def test_a_record_claiming_to_be_ours_must_carry_our_signature(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    await b.sync()
    before = b.store.state("prompts", "x")
    _forged(server, "x", device="dev-b", deleted=True)
    await b.sync()
    assert b.store.state("prompts", "x") == before
    assert b.adapter.items == {"x": {"v": 1}}


async def test_a_tombstone_from_an_unknown_device_asks_instead_of_deleting(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    b.engine._signing_key_for = lambda d: "" if d == "dev-stranger" else b.own_key
    await b.sync()
    _forged(server, "x", device="dev-stranger", deleted=True)
    await b.sync()
    assert b.adapter.items == {"x": {"v": 1}}
    assert [c["itemId"] for c in b.store.conflicts("prompts")] == ["x"]


async def test_a_live_record_from_an_unknown_device_is_still_taken(tmp_path, account_key):
    # Its body opened under the account key, which only the account's own
    # devices hold: that is the proof of origin a missing pin cannot give.
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    b.engine._signing_key_for = lambda _d: ""
    await b.sync()
    assert b.adapter.items == {"x": {"v": 1}}


async def test_a_tombstone_from_an_unknown_device_for_an_item_we_lack_is_taken(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b")
    b.engine._signing_key_for = lambda _d: ""
    _forged(server, "gone", device="dev-stranger", deleted=True)
    await b.sync()
    assert b.store.conflicts("prompts") == []
