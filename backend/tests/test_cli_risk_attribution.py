"""Who is on each end of an unexpected connection: the pane process that
opened it and, for loopback, the listener captured at observation time."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent_team_backend.cli_risk import CliRiskService, RiskPane
from agent_team_backend.cli_risk_observers import ExpectedAddresses
from agent_team_backend.cli_risk_store import HISTORY_KEEP, CliRiskStore
from agent_team_backend.db import Database
from agent_team_backend.osplat import cli_network
from agent_team_backend.osplat.cli_network import Connection, Listener, NetworkSample, ProcessInfo


@pytest.fixture
def store(tmp_path):
    db = Database(tmp_path / "navide.db")
    yield CliRiskStore(db)
    db.close()


PROCESSES = {
    10: ProcessInfo(10, "claude", "claude --resume"),
    11: ProcessInfo(11, "node", "node /opt/mcp/server.js"),
}


def service(store, connections, listeners=None, *, now=100):
    listener_resolver = AsyncMock(side_effect=lambda ports: {port: (listeners or {}).get(port, Listener("unknown"))
                                                           for port in ports})
    svc = CliRiskService(
        store, clock=lambda: now,
        network_collector=AsyncMock(return_value=NetworkSample("successful", tuple(connections))),
        resolver=SimpleNamespace(resolve=AsyncMock(
            return_value=ExpectedAddresses("successful", frozenset({"192.0.2.1"}), now))),
        listener_resolver=listener_resolver,
        process_describer=lambda pids: {pid: PROCESSES.get(pid, ProcessInfo(pid)) for pid in pids},
    )
    return svc, listener_resolver


async def observe(svc):
    pane = RiskPane("pane", "test", (10, 11), ("192.0.2.1",), ())
    await svc._network([pane])
    return {s["ip"] + f":{s['port']}": s for s in svc.current([pane])["pane"]["signals"]}


async def test_loopback_endpoint_records_listener_and_opening_process(store):
    vite = Listener("resolved", ProcessInfo(8812, "node", "node /repo/node_modules/.bin/vite"))
    svc, resolve = service(store, [Connection(10, "127.0.0.1", 56654), Connection(10, "127.0.0.1", 56654),
                                   Connection(11, "198.51.100.2", 443)], {56654: vite})
    signals = await observe(svc)
    loop = signals["127.0.0.1:56654"]
    assert loop["connections"] == 2
    assert loop["local"] == [{"pid": 10, "name": "claude", "command": "claude --resume"}]
    assert loop["listener"] == {"status": "resolved", "pid": 8812, "name": "node",
                                "command": "node /repo/node_modules/.bin/vite",
                                "observedAt": "1970-01-01T00:01:40Z"}
    # Non-loopback endpoints are never sent to the listener lookup and carry none.
    resolve.assert_awaited_once_with([56654])
    remote = signals["198.51.100.2:443"]
    assert "listener" not in remote and remote["local"][0]["name"] == "node"


async def test_unknown_listener_is_unknown_not_absent(store):
    svc, _ = service(store, [Connection(10, "::1", 5173)])
    signals = await observe(svc)
    assert signals["::1:5173"]["listener"] == {"status": "unknown"}


async def test_listener_resolver_failure_degrades_to_unknown(store):
    svc, resolve = service(store, [Connection(10, "127.0.0.1", 9000)])
    resolve.side_effect = RuntimeError("lsof exploded")
    signals = await observe(svc)
    assert signals["127.0.0.1:9000"]["listener"] == {"status": "unknown"}
    assert signals["127.0.0.1:9000"]["local"][0]["pid"] == 10


async def test_vanished_listener_keeps_what_was_captured(store):
    vite = Listener("resolved", ProcessInfo(8812, "node", "node vite"))
    first, _ = service(store, [Connection(10, "127.0.0.1", 56654)], {56654: vite}, now=100)
    await observe(first)
    later, _ = service(store, [Connection(10, "127.0.0.1", 56654)], now=130)
    signal = (await observe(later))["127.0.0.1:56654"]
    assert signal["listener"]["pid"] == 8812 and signal["listener"]["observedAt"] == "1970-01-01T00:01:40Z"


async def test_history_records_changes_only_and_is_bounded(store):
    conn = Connection(10, "127.0.0.1", 56654)
    for now in (100, 110):
        svc, _ = service(store, [conn], now=now)
        signal = (await observe(svc))["127.0.0.1:56654"]
    assert len(signal["history"]) == 1 and signal["history"][0]["at"] == "1970-01-01T00:01:50Z"
    for index in range(HISTORY_KEEP + 3):
        svc, _ = service(store, [conn] * (index + 2), now=200 + index)
        signal = (await observe(svc))["127.0.0.1:56654"]
    assert len(signal["history"]) == HISTORY_KEEP
    assert signal["history"][-1] == {"at": signal["lastObservedAt"], "connections": HISTORY_KEEP + 4,
                                     "local": [{"pid": 10, "name": "claude"}], "listener": {"status": "unknown"}}


# ── platform listings ──────────────────────────────────────────────────────
def test_parse_lsof_listeners_keeps_loopback_and_wildcard_only():
    output = "p8812\ncnode\nf20\nn127.0.0.1:5173\np900\ncpython\nf3\nn192.168.1.5:8000\n" \
             "p901\ncredis\nf6\nn*:6379\np902\ncother\nf7\nn[::1]:9999\n"
    assert cli_network.parse_lsof_listeners(output, {5173, 8000, 6379}) == {5173: (8812, "node"), 6379: (901, "redis")}


def test_parse_ss_listeners_requires_owner():
    output = ("State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n"
              'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=8812,fd=20))\n'
              "LISTEN 0 128 [::1]:6379 [::]:*\n")
    assert cli_network.parse_ss_listeners(output, {5173, 6379}) == {5173: (8812, "node")}


async def test_listing_failure_and_vanished_process(monkeypatch):
    monkeypatch.setattr(cli_network, "command", AsyncMock(return_value=(0, "p77\ncvite\nn127.0.0.1:5173\n", "")))
    monkeypatch.setattr(cli_network, "describe_processes", lambda pids: {77: ProcessInfo(77)})  # exited meanwhile
    found = await cli_network.listeners_lsof([5173, 5174])
    assert found[5173] == Listener("resolved", ProcessInfo(77, "vite", None))
    assert found[5174] == Listener("unknown")
    monkeypatch.setattr(cli_network, "command", AsyncMock(side_effect=TimeoutError()))
    assert await cli_network.listeners_lsof([5173]) == {5173: Listener("unknown")}
    assert await cli_network.listeners_unsupported([5173]) == {5173: Listener("unknown")}


def test_describe_processes_truncates_and_marks_unknown():
    import os

    me = cli_network.describe_processes([os.getpid(), 2 ** 22 + 12345])
    assert me[os.getpid()].name and len(me[os.getpid()].command or "") <= cli_network.MAX_COMMAND
    assert me[2 ** 22 + 12345] == ProcessInfo(2 ** 22 + 12345)
    assert cli_network.truncate_command(["x" * 500]).endswith("…")
    assert len(cli_network.truncate_command(["x" * 500])) == cli_network.MAX_COMMAND
    assert cli_network.truncate_command([]) is None


def test_listener_lookup_is_one_process_per_poll(monkeypatch):
    calls = []

    async def fake(argv):
        calls.append(argv)
        return 0, "", ""

    monkeypatch.setattr(cli_network, "command", fake)
    asyncio.run(cli_network.listeners_lsof([5173, 5174, 5173]))
    assert calls == [["lsof", "-nP", "-iTCP:5173,5174", "-sTCP:LISTEN", "-Fpcn"]]
