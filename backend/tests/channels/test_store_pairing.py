from __future__ import annotations

import pytest

from agent_team_backend.channels.base import Location
from agent_team_backend.channels.pairing import (
    CODE_ALPHABET,
    CODE_LENGTH,
    CODE_TTL_S,
    MAX_PENDING,
    SenderGate,
    new_code,
)
from agent_team_backend.channels.store import ChannelStore
from agent_team_backend.db import Database


@pytest.fixture
def store(tmp_path):
    db = Database(tmp_path / "navide.db")
    yield ChannelStore(db)
    db.close()


class Clock:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


def test_code_alphabet_has_no_lookalikes() -> None:
    for ch in "01IO":
        assert ch not in CODE_ALPHABET
    codes = {new_code() for _ in range(200)}
    assert len(codes) > 190
    assert all(len(c) == CODE_LENGTH and set(c) <= set(CODE_ALPHABET) for c in codes)


def test_migration_is_idempotent(tmp_path) -> None:
    db = Database(tmp_path / "n.db")
    ChannelStore(db)
    ChannelStore(db)
    assert db.schema_version("channels") == 1
    db.close()


def test_pairing_reuse_max_and_expiry(store: ChannelStore) -> None:
    clock = Clock()
    gate = SenderGate(store, now=clock)
    first = gate.request_pairing("telegram", "1", "a", "c1")
    assert first.created and first.request
    again = gate.request_pairing("telegram", "1", "a", "c1")
    assert not again.created and again.request.code == first.request.code
    for i in range(2, MAX_PENDING + 1):
        assert gate.request_pairing("telegram", str(i), "x", "c").created
    full = gate.request_pairing("telegram", "99", "x", "c")
    assert full.full and full.request is None
    # Another platform has its own budget.
    assert gate.request_pairing("discord", "99", "x", "c").created
    clock.t += CODE_TTL_S + 1
    assert gate.request_pairing("telegram", "99", "x", "c").created
    assert [r.sender_id for r in store.list_pairing("telegram")] == ["99"]


def test_approve_adds_allow_and_reject_drops(store: ChannelStore) -> None:
    gate = SenderGate(store)
    code = gate.request_pairing("telegram", "7", "alice", "42").request.code
    assert not gate.is_allowed("telegram", "7")
    # Case / separator tolerant.
    req = gate.approve("telegram", f"{code[:4].lower()}-{code[4:]}")
    assert req and req.sender_id == "7"
    assert gate.is_allowed("telegram", "7") and not gate.is_allowed("discord", "7")
    assert gate.approve("telegram", code) is None
    code2 = gate.request_pairing("telegram", "8", "bob", "43").request.code
    assert gate.reject("telegram", code2) is not None
    assert not gate.is_allowed("telegram", "8") and store.list_pairing(None) == []
    assert store.remove_allow("telegram", "7") and not gate.is_allowed("telegram", "7")


def test_expired_code_cannot_be_approved(store: ChannelStore) -> None:
    clock = Clock()
    gate = SenderGate(store, now=clock)
    code = gate.request_pairing("telegram", "7", "alice", "42").request.code
    clock.t += CODE_TTL_S + 1
    assert gate.approve("telegram", code) is None
    assert not gate.is_allowed("telegram", "7")


def test_bindings_are_one_to_one(store: ChannelStore) -> None:
    loc = Location("telegram", "default", "-100", "50", "api")
    store.bind("p1", loc)
    store.bind("p2", loc)  # takes the location over
    assert [b.pane_id for b in store.bindings()] == ["p2"]
    store.bind("p2", Location("telegram", "default", "-100", "51", "b"))
    assert [(b.pane_id, b.thread_id) for b in store.bindings()] == [("p2", "51")]
    assert store.rename_pane("p2", "p3")
    assert store.unbind("p3").thread_id == "51" and store.bindings() == []


def test_offsets_are_discarded_on_bot_change(store: ChannelStore) -> None:
    store.set_offset("telegram", "default", "111", 5)
    assert store.get_offset("telegram", "default", "111") == 5
    assert store.get_offset("telegram", "default", "222") is None
    store.set_offset("telegram", "default", "222", 9)
    assert store.get_offset("telegram", "default", "111") is None


def test_accounts_kill_switch_and_remove(store: ChannelStore) -> None:
    assert store.global_enabled()
    store.set_global_enabled(False)
    assert not store.global_enabled()
    store.upsert_account("telegram", {"group": "-100"})
    store.add_allow("telegram", "7", "a", 1)
    store.bind("p1", Location("telegram", "default", "1"))
    store.set_account_enabled("telegram", False)
    assert store.accounts() == {"telegram": {"enabled": False, "config": {"group": "-100"}}}
    store.upsert_account("telegram", {"group": "-200"})  # keeps enabled flag
    assert store.accounts()["telegram"]["enabled"] is False
    store.remove_platform("telegram")
    assert store.accounts() == {} and store.list_allow(None) == [] and store.bindings() == []
