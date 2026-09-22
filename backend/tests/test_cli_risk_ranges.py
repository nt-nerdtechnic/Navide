"""Shared-CDN range allowlist: seeding, persistence, matching and the WS face."""

from types import SimpleNamespace

import pytest

from agent_team_backend import app, cli_risk_ranges, ws_handlers
from agent_team_backend.cli_risk import RiskPane
from agent_team_backend.cli_risk_observers import ExpectedAddresses
from agent_team_backend.cli_risk_ranges import BUILTIN_RANGES, SharedRangeStore
from agent_team_backend.cli_risk_store import CliRiskStore, project
from agent_team_backend.db import Database


@pytest.fixture
def db(tmp_path):
    database = Database(tmp_path / "navide.db")
    yield database
    database.close()


def rows(store):
    return {row["cidr"]: row for row in store.list()}


def test_builtin_seed_counts_and_no_general_cloud(db):
    listed = rows(SharedRangeStore(db))
    assert len(listed) == len(BUILTIN_RANGES) == 43
    labels = [row["label"] for row in listed.values()]
    assert labels.count("Cloudflare") == 22 and labels.count("Fastly") == 21
    assert all(row["source"] == "builtin" and row["enabled"] for row in listed.values())


def test_reseed_keeps_user_disable_and_prunes_dropped_builtin(db, monkeypatch):
    store = SharedRangeStore(db)
    store.set_enabled("162.158.0.0/15", False)
    store.add("192.0.2.0/24", "Example CDN")
    monkeypatch.setattr(cli_risk_ranges, "BUILTIN_RANGES",
                        tuple(r for r in BUILTIN_RANGES if r[0] != "131.0.72.0/22") + (("198.18.0.0/15", "New"),))
    listed = rows(SharedRangeStore(db))
    assert listed["162.158.0.0/15"]["enabled"] is False
    assert listed["192.0.2.0/24"]["source"] == "user"
    assert "131.0.72.0/22" not in listed and listed["198.18.0.0/15"]["enabled"]


def test_builtin_cannot_be_deleted_user_row_can(db):
    store = SharedRangeStore(db)
    with pytest.raises(ValueError):
        store.delete("162.158.0.0/15")
    store.add("2001:db8::/32", "Doc")
    store.delete("2001:db8::/32")
    assert "2001:db8::/32" not in rows(store)


@pytest.mark.parametrize("cidr,label", [("192.0.2.1/24", "x"), ("nope", "x"), ("192.0.2.0", "x"),
                                        ("192.0.2.0/24", " "), ("162.158.0.0/15", "dup")])
def test_add_validates_cidr_label_and_duplicates(db, cidr, label):
    with pytest.raises(ValueError):
        SharedRangeStore(db).add(cidr, label)


def test_matching_ipv4_ipv6_mapped_and_cache_invalidation(db):
    store = SharedRangeStore(db)
    assert store.label_for("162.159.130.53") == "Cloudflare"
    assert store.label_for("2606:4700::6810:84e5") == "Cloudflare"
    assert store.label_for("::ffff:162.159.130.53") == "Cloudflare"
    assert store.label_for("151.101.1.69") == "Fastly"
    assert store.label_for("198.51.100.4") is None
    assert store.label_for("not-an-ip") is None
    store.set_enabled("162.158.0.0/15", False)
    assert store.label_for("162.159.130.53") is None
    store.add("198.51.100.0/24", "Example")
    assert store.label_for("198.51.100.4") == "Example"


def test_matching_does_not_touch_db(db, monkeypatch):
    store = SharedRangeStore(db)
    monkeypatch.setattr(db, "transaction", lambda: (_ for _ in ()).throw(AssertionError("db hit")))
    assert store.label_for("104.16.1.1") == "Cloudflare"


def test_shared_cdn_endpoint_is_record_only_and_sorted_last(db):
    store = CliRiskStore(db)
    store.apply_network("pane", "test", "successful",
                        {("162.159.130.53", 443): 1, ("198.51.100.2", 443): 1},
                        ExpectedAddresses("successful", frozenset(), 100), 100)
    pane = RiskPane("pane", "test", (10,), ("192.0.2.1",), ())
    signals = project(store.snapshot(), [pane], 100)["pane"]["signals"]
    assert [s["ip"] for s in signals] == ["198.51.100.2", "162.159.130.53"]
    assert "sharedCdn" not in signals[0] and signals[1]["sharedCdn"] == "Cloudflare"


async def test_ws_handlers_list_add_update_delete(db, monkeypatch):
    store = CliRiskStore(db)
    monkeypatch.setattr(app, "cli_risk_service", SimpleNamespace(store=store))
    messages = []
    session = SimpleNamespace(send_json=lambda msg: _record(messages, msg))

    async def call(kind, payload):
        await ws_handlers.cli_risk_ranges(session, "id", f"cli_risk.ranges.{kind}", payload)
        return messages[-1]

    assert len((await call("list", {}))["payload"]["ranges"]) == 43
    added = await call("add", {"cidr": "192.0.2.0/24", "label": "Mine"})
    assert any(r["cidr"] == "192.0.2.0/24" and r["source"] == "user" for r in added["payload"]["ranges"])
    updated = await call("update", {"cidr": "192.0.2.0/24", "enabled": False})
    assert next(r for r in updated["payload"]["ranges"] if r["cidr"] == "192.0.2.0/24")["enabled"] is False
    assert (await call("delete", {"cidr": "104.16.0.0/13"}))["error"]["code"] == "BAD_REQUEST"
    assert (await call("add", {"cidr": "bad", "label": "x"}))["error"]["code"] == "BAD_REQUEST"
    deleted = await call("delete", {"cidr": "192.0.2.0/24"})
    assert len(deleted["payload"]["ranges"]) == 43


async def _record(messages, msg):
    messages.append(msg)
