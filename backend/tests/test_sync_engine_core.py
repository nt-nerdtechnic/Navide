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


# ── C-1 / S-4 / M-3: an adapter that refuses a record ────────────────────────
class _Refusing:
    """Wraps a device's adapter so its ``apply`` refuses chosen items."""

    def __init__(self, device: Device, refuse: set[str], *, raises: bool = False) -> None:
        self.inner = device.adapter.apply
        self.refuse = refuse
        self.raises = raises
        device.adapter.apply = self.apply

    def apply(self, item_id, payload):
        if item_id in self.refuse:
            if self.raises:
                raise ValueError("not here")
            return False
        return self.inner(item_id, payload)


@pytest.mark.parametrize("raises", [False, True])
async def test_a_refused_new_item_is_never_turned_into_a_delete(tmp_path, account_key, raises):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"y": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    _Refusing(b, {"y"}, raises=raises)
    await b.sync()
    await b.sync()
    assert not server.rows[("prompts", "y")]["deleted"]
    assert b.store.state("prompts", "y") is None


async def test_a_refused_update_does_not_push_the_old_copy_back(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    await b.sync()
    a.adapter.items["x"] = {"v": 2}
    await a.sync()
    _Refusing(b, {"x"})
    await b.sync()
    await b.sync()
    await a.sync()
    assert a.adapter.items == {"x": {"v": 2}}
    assert b.adapter.items == {"x": {"v": 1}}


async def test_keeping_a_remote_copy_the_adapter_refuses_keeps_the_conflict(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    await b.sync()
    a.adapter.items["x"] = {"v": 2}
    b.adapter.items["x"] = {"v": 3}
    await a.sync()
    await b.sync()
    assert b.store.conflict_ids("prompts") == {"x"}
    _Refusing(b, {"x"})
    with pytest.raises(sync_engine.SyncError):
        b.engine.resolve("prompts", "x", sync_engine.KEEP_REMOTE)
    assert b.store.conflict_ids("prompts") == {"x"}


# ── X-5: what a round reports ────────────────────────────────────────────────
RESULT_KEYS = {"scope", "ok", "pulled", "pushed", "conflicts", "held", "refused", "tooLarge", "at"}


async def test_a_round_reports_its_outcome_and_tells_the_listener(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"y": {"v": 1}, "z": {"v": 2}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b", {"mine": {"v": 3}})
    heard = []
    b.engine._on_result = heard.append
    _Refusing(b, {"y"})
    result = await b.sync()
    assert RESULT_KEYS <= set(result)
    assert result["ok"] is True
    assert result["pulled"] == 1 and result["pushed"] == 1
    assert result["refused"] == ["y"] and result["held"] == [] and result["tooLarge"] == []
    assert heard == [result]
    assert b.engine.last_results()["prompts"] == result


async def test_a_failing_scope_is_reported_and_the_others_still_run(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    from .test_sync_engine import DictScope

    broken = DictScope("mcp", {"m": {"v": 1}})

    def snapshot():
        raise RuntimeError("disk on fire")

    broken.snapshot = snapshot
    b.engine.register(broken)
    results = {r["scope"]: r for r in await b.engine.sync_all()}
    assert results["mcp"]["ok"] is False and "disk on fire" in results["mcp"]["error"]
    assert results["prompts"]["ok"] is True and results["prompts"]["pushed"] == 1
    assert b.engine.last_results()["mcp"]["ok"] is False


async def test_a_skipped_scope_says_why(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b")
    b.engine._enabled = lambda _s: False
    result = await b.sync()
    assert result["ok"] is True and result["skipped"] == "disabled"


async def test_an_item_the_adapter_calls_oversized_is_reported_and_never_sent(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"big": {"v": 1}, "small": {"v": 2}})
    b.adapter.oversized = lambda item_id, _payload: item_id == "big"
    result = await b.sync()
    assert result["tooLarge"] == ["big"]
    assert ("prompts", "big") not in server.rows
    b.adapter.items.pop("small")
    await b.sync()
    assert ("prompts", "big") not in server.rows


async def test_a_record_over_the_size_limit_is_reported_too_large(tmp_path, account_key, monkeypatch):
    monkeypatch.setattr(sync_engine, "MAX_BODY_BYTES", 200)
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"big": {"v": "x" * 400}})
    result = await b.sync()
    assert result["tooLarge"] == ["big"] and result["pushed"] == 0


async def test_a_deferred_item_is_reported_held(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"y": {"v": 1}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")

    def defer(item_id, payload):
        raise sync_engine.DeferItem(item_id)

    b.adapter.apply = defer
    result = await b.sync()
    assert result["held"] == ["y"]


# ── ACC: account scope ───────────────────────────────────────────────────────
async def test_a_server_cursor_behind_ours_is_a_reset_and_everything_is_read_again(
    tmp_path, account_key
):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"x": {"v": 1}, "y": {"v": 2}, "z": {"v": 3}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    await b.sync()
    assert b.store.cursor("prompts") == 3
    # A different account (or a reset server) behind the same link: rev 1.
    fresh = FakeServer()
    c = Device(tmp_path, fresh, "dev-c", {"w": {"v": 9}})
    await c.sync()
    b.engine._request = _as_device("dev-b", fresh)
    await b.sync()
    assert b.adapter.items["w"] == {"v": 9}
    # B's own items went up to the new server as new ones, not as edits of
    # revs that server never issued.
    assert {i for (_s, i) in fresh.rows} == {"w", "x", "y", "z"}


def _as_device(name: str, server: FakeServer):
    async def request(msg_type, payload):
        if msg_type == "sync.push":
            for item in payload["items"]:
                item["deviceId"] = name
        return await server.request(msg_type, payload)

    return request


async def _rev0_conflict(tmp_path) -> tuple[FakeServer, Device]:
    """B edits an item whose cloud row has vanished: the server answers rev 0."""
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"other": {"v": 0}})
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    await b.sync()
    await a.sync()  # keeps the server's cursor ahead, so this is no reset
    del server.rows[("prompts", "x")]
    b.adapter.items["x"] = {"v": 2}
    await b.sync()
    return server, b


async def test_a_conflict_with_a_row_the_cloud_never_had_says_so(tmp_path, account_key):
    _server, b = await _rev0_conflict(tmp_path)
    [row] = b.store.conflicts("prompts")
    assert row["itemId"] == "x" and row["remoteAbsent"] is True


async def test_keeping_the_cloud_copy_of_nothing_never_deletes_the_local_item(tmp_path, account_key):
    _server, b = await _rev0_conflict(tmp_path)
    with pytest.raises(sync_engine.SyncError):
        b.engine.resolve("prompts", "x", sync_engine.KEEP_REMOTE)
    assert b.adapter.items["x"] == {"v": 2}
    assert b.store.conflict_ids("prompts") == {"x"}


async def test_keeping_the_local_copy_of_a_vanished_row_puts_it_back(tmp_path, account_key):
    server, b = await _rev0_conflict(tmp_path)
    b.engine.resolve("prompts", "x", sync_engine.KEEP_LOCAL)
    await b.sync()
    assert not server.rows[("prompts", "x")]["deleted"]


async def test_keeping_an_unchanged_local_copy_pushes_it_again(tmp_path, account_key):
    # The unproven tombstone case: B never edited x, so its copy still equals
    # what was agreed — and "keep mine" must still re-create it in the cloud.
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"x": {"v": 1}})
    b.engine._signing_key_for = lambda d: "" if d == "dev-stranger" else b.own_key
    await b.sync()
    _forged(server, "x", device="dev-stranger", deleted=True)
    await b.sync()
    b.engine.resolve("prompts", "x", sync_engine.KEEP_LOCAL)
    await b.sync()
    assert not server.rows[("prompts", "x")]["deleted"]
