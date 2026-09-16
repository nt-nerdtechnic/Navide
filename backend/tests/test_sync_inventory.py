"""The read-only inventory and the selective push/pull built on top of it.

Driven against the same ``FakeServer`` the engine's own tests use, for the same
reason: the thing worth protecting is the conversation, and a stub that always
says yes would let a listing that quietly wrote state pass.

The load-bearing test here is ``test_inventory_writes_nothing``. Every other
claim in this file is about what the inventory *says*; that one is about what
it does not do, and it is written as a byte comparison of the three tables
rather than as a check on the answer, because a listing that moved the cursor
would return exactly the right answer on the way past.
"""

from __future__ import annotations

import pytest

from agent_team_backend import sync_engine, sync_keyring

from .test_sync_engine import Device, FakeServer, account_key  # noqa: F401 - a fixture


def _tables(store: sync_engine.SyncStore) -> dict[str, list[tuple]]:
    """Every row of the three tables a sync round writes, ordered."""
    with store._db.transaction() as cur:  # noqa: SLF001 - the point is to read raw
        return {
            "sync_state": cur.execute(
                "SELECT scope, item_id, rev, synced_hash, deleted FROM sync_state "
                "ORDER BY scope, item_id"
            ).fetchall(),
            "sync_cursor": cur.execute(
                "SELECT scope, cursor FROM sync_cursor ORDER BY scope"
            ).fetchall(),
            "sync_conflicts": cur.execute(
                "SELECT scope, item_id, local_json, remote_json, remote_rev, remote_device "
                "FROM sync_conflicts ORDER BY scope, item_id"
            ).fetchall(),
        }


def _by_id(items: list[dict]) -> dict[str, dict]:
    return {item["itemId"]: item for item in items}


async def _diverged_pair(tmp_path) -> tuple[FakeServer, Device, Device]:
    """Two devices that agree on p1 and disagree about p2."""
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "shared"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    a.adapter.items["p2"] = {"id": "p2", "prompt": "only on a"}
    await a.sync()
    b.adapter.items["p2"] = {"id": "p2", "prompt": "only on b"}
    return server, a, b


# ── what it says ─────────────────────────────────────────────────────────────
async def test_the_two_halves_are_reported_item_by_item(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"shared": {"id": "shared"}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b", {"mine": {"id": "mine"}})

    items = _by_id((await b.engine.inventory("prompts"))["items"])

    assert items["shared"]["state"] == "remote-only"
    assert items["shared"]["local"] is None
    assert items["shared"]["remote"]["deviceId"] == "dev-a"
    assert items["mine"]["state"] == "local-only"
    assert items["mine"]["remote"] is None


async def test_an_item_both_sides_hold_is_in_sync(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "hello"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()

    item = _by_id((await b.engine.inventory("prompts"))["items"])["p1"]

    assert item["state"] == "in-sync"
    assert item["local"]["fingerprint"] == item["remote"]["fingerprint"]


async def test_two_different_copies_read_as_diverged(tmp_path, account_key):
    _server, _a, b = await _diverged_pair(tmp_path)

    item = _by_id((await b.engine.inventory("prompts"))["items"])["p2"]

    assert item["state"] == "diverged"
    assert item["local"]["fingerprint"] != item["remote"]["fingerprint"]


async def test_no_body_reaches_the_caller(tmp_path, account_key):
    """Fingerprints, never content: these records are where secrets live."""
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "sk-secret-value"}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")

    listing = await b.engine.inventory("prompts")

    assert "sk-secret-value" not in repr(listing)
    assert "body" not in repr(listing)


async def test_a_record_this_key_cannot_open_says_so(tmp_path, account_key):
    """Unreadable is its own answer, not a silent "different"."""
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "hello"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    server.rows[("prompts", "p1")]["body"] = "not-a-body"

    item = _by_id((await b.engine.inventory("prompts"))["items"])["p1"]

    assert item["remote"]["readable"] is False
    assert item["remote"]["fingerprint"] is None
    # The two could not be compared, so they are not claimed to agree.
    assert item["state"] == "diverged"


async def test_a_tombstone_the_local_copy_outlived_is_local_only(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "hello"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    a.adapter.items.pop("p1")
    await a.sync()

    item = _by_id((await b.engine.inventory("prompts"))["items"])["p1"]

    assert item["state"] == "local-only"
    assert item["remote"]["deleted"] is True
    assert item["remote"]["present"] is False


async def test_an_item_gone_from_both_sides_is_not_listed(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "hello"}})
    b = Device(tmp_path, server, "dev-b")
    await a.sync()
    await b.sync()
    a.adapter.items.pop("p1")
    await a.sync()
    await b.sync()

    assert (await b.engine.inventory("prompts"))["items"] == []


async def test_an_unresolved_conflict_outranks_the_comparison(tmp_path, account_key):
    _server, a, b = await _diverged_pair(tmp_path)
    await b.sync()  # b's unpushed edit meets a's: a conflict row is written
    assert b.store.conflict_ids("prompts") == {"p2"}

    item = _by_id((await b.engine.inventory("prompts"))["items"])["p2"]

    assert item["state"] == "conflict"


async def test_without_the_account_key_it_lists_nothing_and_says_why(tmp_path):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"p1": {"id": "p1"}})
    sync_keyring.forget_account_key()

    listing = await b.engine.inventory("prompts")

    assert listing["status"] == sync_engine.INVENTORY_NO_KEY
    assert listing["items"] == []


async def test_an_unregistered_scope_is_refused(tmp_path, account_key):
    b = Device(tmp_path, FakeServer(), "dev-b")
    with pytest.raises(sync_engine.SyncError):
        await b.engine.inventory("memory")


# ── what it must not do ──────────────────────────────────────────────────────
async def test_inventory_writes_nothing(tmp_path, account_key):
    """The cursor, the agreed state and the conflict rows come out untouched.

    Set up so that all three tables have something in them first — a listing
    that wipes a table it never fills would pass against an empty database.
    """
    _server, _a, b = await _diverged_pair(tmp_path)
    await b.sync()  # writes state rows, a cursor, and one conflict row
    b.adapter.items["p3"] = {"id": "p3", "prompt": "never pushed"}
    assert all(_tables(b.store).values()), "the fixture must fill all three tables"

    before = _tables(b.store)
    await b.engine.inventory("prompts")
    after = _tables(b.store)

    assert after == before


async def test_inventory_does_not_apply_remote_items(tmp_path, account_key):
    """Looking at what is up there must not bring it down."""
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "hello"}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")

    await b.engine.inventory("prompts")

    assert b.adapter.items == {}


async def test_inventory_pushes_nothing(tmp_path, account_key):
    server = FakeServer()
    b = Device(tmp_path, server, "dev-b", {"p1": {"id": "p1", "prompt": "hello"}})

    await b.engine.inventory("prompts")

    assert server.pushes == 0
    assert server.rows == {}


async def test_a_disabled_scope_still_lists(tmp_path, account_key):
    """Deciding whether to switch a section on means seeing what it holds."""
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "hello"}})
    await a.sync()
    b = Device(tmp_path, server, "dev-b")
    b.engine._enabled = lambda _scope: False  # noqa: SLF001 - the flag under test

    listing = await b.engine.inventory("prompts")

    assert listing["status"] == sync_engine.INVENTORY_OK
    assert _by_id(listing["items"])["p1"]["state"] == "remote-only"


# ── moving one item at a time ────────────────────────────────────────────────
async def test_push_items_sends_only_what_was_named(tmp_path, account_key):
    server = FakeServer()
    a = Device(
        tmp_path,
        server,
        "dev-a",
        {"p1": {"id": "p1", "prompt": "one"}, "p2": {"id": "p2", "prompt": "two"}},
    )

    results = await a.engine.push_items("prompts", ["p1"])

    assert {r["itemId"]: r["result"] for r in results} == {"p1": "pushed"}
    assert set(server.rows) == {("prompts", "p1")}


async def test_push_items_reports_an_item_that_needed_nothing(tmp_path, account_key):
    server = FakeServer()
    a = Device(tmp_path, server, "dev-a", {"p1": {"id": "p1", "prompt": "one"}})
    await a.sync()

    results = await a.engine.push_items("prompts", ["p1"])

    assert results == [{"itemId": "p1", "result": "up-to-date"}]
    assert server.pushes == 1  # the sync above; this call sent no batch


async def test_push_items_reports_an_id_nobody_holds(tmp_path, account_key):
    a = Device(tmp_path, FakeServer(), "dev-a")

    results = await a.engine.push_items("prompts", ["ghost"])

    assert results == [{"itemId": "ghost", "result": "unknown"}]


async def test_push_items_still_skips_a_conflicted_item(tmp_path, account_key):
    """Choosing an item is not a way around the question the user owes."""
    _server, _a, b = await _diverged_pair(tmp_path)
    await b.sync()
    assert b.store.conflict_ids("prompts") == {"p2"}
    before = _tables(b.store)["sync_conflicts"]

    results = await b.engine.push_items("prompts", ["p2"])

    assert results == [{"itemId": "p2", "result": "conflict"}]
    assert _tables(b.store)["sync_conflicts"] == before


async def test_pull_items_takes_only_what_was_named(tmp_path, account_key):
    server = FakeServer()
    a = Device(
        tmp_path,
        server,
        "dev-a",
        {"p1": {"id": "p1", "prompt": "one"}, "p2": {"id": "p2", "prompt": "two"}},
    )
    await a.sync()
    b = Device(tmp_path, server, "dev-b")

    results = await b.engine.pull_items("prompts", ["p2"])

    assert {r["itemId"]: r["result"] for r in results} == {"p2": "pulled"}
    assert b.adapter.items == {"p2": {"id": "p2", "prompt": "two"}}


async def test_pull_items_leaves_the_cursor_alone(tmp_path, account_key):
    """The rows beside the chosen one have still never been read."""
    server = FakeServer()
    a = Device(
        tmp_path,
        server,
        "dev-a",
        {"p1": {"id": "p1", "prompt": "one"}, "p2": {"id": "p2", "prompt": "two"}},
    )
    await a.sync()
    b = Device(tmp_path, server, "dev-b")

    await b.engine.pull_items("prompts", ["p2"])
    assert b.store.cursor("prompts") == 0

    # So the ordinary round that follows still finds p1.
    await b.sync()
    assert set(b.adapter.items) == {"p1", "p2"}


async def test_pull_items_reports_an_id_the_server_does_not_have(tmp_path, account_key):
    b = Device(tmp_path, FakeServer(), "dev-b")

    results = await b.engine.pull_items("prompts", ["ghost"])

    assert results == [{"itemId": "ghost", "result": "not-on-server"}]


async def test_pull_items_refuses_to_apply_over_an_unpushed_edit(tmp_path, account_key):
    """The one thing the engine must never do stays impossible when asked."""
    _server, _a, b = await _diverged_pair(tmp_path)

    results = await b.engine.pull_items("prompts", ["p2"])

    assert results == [{"itemId": "p2", "result": "conflict"}]
    assert b.adapter.items["p2"] == {"id": "p2", "prompt": "only on b"}
    assert b.store.conflict_ids("prompts") == {"p2"}
