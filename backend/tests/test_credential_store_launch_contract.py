"""Public handlers with real helper subprocesses and synthetic shell startup."""
import asyncio
import json
import os
import shlex
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

from agent_team_backend import app, usage_service
from agent_team_backend.credential_store import CredentialStores, active_store_metadata
from agent_team_backend.pane_account_history import PaneAccountHistory
from tests.test_credential_launch import posix_bash  # noqa: F401
from tests.test_quota_failover_login_contract import call, rig, session  # noqa: F401


@pytest.fixture(params=[("kilo", "kilo", "@kilocode/cli"), ("opencode", "anthropic", "opencode-ai")])
def launch_rig(request, rig, tmp_path, monkeypatch, posix_bash):
    bash = posix_bash
    vendor, scope, package = request.param
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    stores = CredentialStores(rig.store._db, active_store_metadata)
    rig.vault.stores = stores
    monkeypatch.setattr(app, "pane_account_history", PaneAccountHistory(rig.store._db))
    monkeypatch.setattr(app, "_credential_watcher", None)
    home = rig.vault._real_home
    selected = tmp_path / "from fixture rc"
    live = selected / vendor / "auth.json"
    live.parent.mkdir(parents=True)
    live.write_text(json.dumps({scope: {"type": "api", "key": "FAKE-A"},
                               "unrelated-provider": {"type": "api", "key": "FAKE-SIBLING"}}))
    output = tmp_path / "observed.json"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "package.json").write_text(json.dumps({"name": package, "bin": {vendor: vendor}}))
    cli = bin_dir / vendor
    cli.write_text(f"#!{sys.executable}\n" +
        "import json,os,sys\nfrom pathlib import Path\n" +
        f"live=Path(os.environ['XDG_DATA_HOME'])/{vendor!r}/'auth.json'\n" +
        f"credential=json.loads(live.read_text()).get({scope!r}) if live.exists() else None\n" +
        f"Path({str(output)!r}).write_text(json.dumps({{'args':sys.argv[1:],'home':os.environ['HOME'],'xdg':os.environ['XDG_DATA_HOME'],'unrelated':os.environ['UNRELATED_SECRET'],'credential':credential}}))\n" +
        "if 'login' in sys.argv:\n" +
        "    snapshot=Path(os.environ['SYNTHETIC_SNAPSHOT'])\n" +
        "    assert 'FAKE-A' in snapshot.read_text()\n" +
        f"    data=json.loads(live.read_text()); data[{scope!r}]={{'type':'api','key':'FAKE-B'}}\n" +
        "    live.write_text(json.dumps(data))\n")
    cli.chmod(0o700)
    rc = tmp_path / "fixture.rc"
    rc.write_text("export XDG_DATA_HOME=" + shlex.quote(str(selected)) + "\n")
    monkeypatch.setattr(app, "get_terminals", lambda: SimpleNamespace())
    owner = session()
    processes = []
    snapshot_path = {"value": ""}

    def create(**kwargs):
        assert rig.vault.switch_lock(vendor).locked()
        owner.terminals.created.append(kwargs)
        command = kwargs.get("spawn_command") or kwargs["command"]
        env = {"HOME": str(home), "USERPROFILE": str(home),
               "PATH": str(bin_dir) + os.pathsep + os.defpath,
               "UNRELATED_SECRET": "FAKE-PRIVATE-ENV", "SYNTHETIC_SNAPSHOT": snapshot_path["value"],
               **(kwargs.get("env") or {})}
        actual = [bash, "--noprofile", "--norc", "-c", ". " + shlex.quote(str(rc)) + "; " + command[-1]]
        process = subprocess.Popen(actual, cwd=tmp_path, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        processes.append(process)
        term = SimpleNamespace(id=f"term-{len(processes)}", pane_id=kwargs["pane_id"],
            command=kwargs["command"], metadata=kwargs["metadata"], agent_key=vendor,
            cwd=str(tmp_path), closed=False, proc=process, started_monotonic=time.monotonic())
        owner.terminals.registry[term.id] = term
        return term

    async def kill(term_id, **_kwargs):
        term = owner.terminals.registry[term_id]
        if term.proc.poll() is None:
            term.proc.kill()
            await asyncio.to_thread(term.proc.wait)
        term.closed = True

    monkeypatch.setattr(owner.terminals, "create", create)
    monkeypatch.setattr(owner.terminals, "kill", kill, raising=False)
    yield SimpleNamespace(vendor=vendor, scope=scope, stores=stores, rig=rig, owner=owner,
        live=live, home=home, output=output, processes=processes, snapshot_path=snapshot_path, rc=rc,
        payload={"agent_key": vendor, "pane_id": "first-pane", "cwd": str(tmp_path),
                 "command": [bash, "-c", vendor], "metadata": {"workspace_path": str(tmp_path)}})
    for process in processes:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=15)


async def test_regular_handler_binds_actual_post_rc_store_without_changing_environment(launch_rig):
    case = launch_rig
    result = await call(case.owner, "terminal.create", case.payload)
    assert result["ok"], result
    assert await asyncio.to_thread(case.processes[0].wait, 15) == 0
    term = case.owner.terminals.get("term-1")
    assert term.metadata["credential_store_verified"] is True
    assert case.stores.path(case.vendor) == case.live
    assert term.command[-1].startswith(case.vendor)
    assert "credential-path-helper" not in str(term.command)
    observed = json.loads(case.output.read_text())
    assert observed["home"] == str(case.home)
    assert observed["xdg"] == str(case.live.parent.parent)
    assert observed["unrelated"] == "FAKE-PRIVATE-ENV"
    record = json.dumps(case.stores._db.kv_get("credential-store:" + case.vendor))
    assert "FAKE-PRIVATE-ENV" not in record and "UNRELATED_SECRET" not in record
    assert "TOKEN" not in record and "token" not in record
    assert not case.rig.vault.switch_lock(case.vendor).locked()


async def test_public_create_then_first_login_common_xdg_parks_and_switches(launch_rig, monkeypatch):
    from agent_team_backend.cli_vendors.registry import VENDORS

    case = launch_rig
    monkeypatch.setenv("XDG_DATA_HOME", str(case.live.parent.parent))
    assert VENDORS[case.vendor].live_file_resolver(case.home).resolve() == case.live.resolve()
    before = json.loads(case.live.read_text())
    assert case.stores._record(case.vendor) is None
    created = await call(case.owner, "cli_profiles.create",
        {"agent_key": case.vendor, "name": "B", "scope": case.scope}, "create-B")
    assert created["ok"], created
    target = created["payload"]["profile"]["id"]
    assert case.rig.vault.slot_is_empty(case.vendor, target, scope=case.scope)
    snapshot = case.rig.vault._pre_login_snapshot_path(case.vendor, target)
    case.snapshot_path["value"] = str(snapshot)
    result = await call(case.owner, "terminal.create",
        {**case.payload, "pane_id": "login-B", "login_profile_id": target, "metadata": {}}, "login-B")
    assert result["ok"], result
    raw = snapshot.read_bytes()
    present, secret, scope = case.rig.vault._pre_login_snapshot(case.vendor, target)
    assert present and scope == case.scope
    assert json.loads(secret) == before[case.scope]
    assert await asyncio.to_thread(case.processes[-1].wait, 15) == 0
    assert json.loads(case.output.read_text())["credential"] == before[case.scope]
    assert json.loads(case.live.read_text())[case.scope]["key"] == "FAKE-B"
    assert snapshot.read_bytes() == raw
    assert case.stores.path(case.vendor) == case.live.resolve()
    case.owner.terminals.get("term-1").closed = True
    assert await usage_service._harvest_login_home_locked(case.rig.vault, case.vendor, target)
    assert json.loads(case.live.read_text()) == before
    assert not snapshot.exists()
    assert json.loads(case.rig.vault.read_slot(case.vendor, target, scope=case.scope).secret)["key"] == "FAKE-B"
    for profile_id, expected in ((target, "FAKE-B"), (None, "FAKE-A")):
        switched = await call(case.owner, "cli_profiles.set_default",
            {"agent_key": case.vendor, "profile_id": profile_id}, "switch-" + expected)
        assert switched["ok"], switched
        assert case.rig.store.list()["defaults"][case.vendor] == profile_id
        assert json.loads(case.live.read_text())[case.scope]["key"] == expected
        assert json.loads(case.live.read_text())["unrelated-provider"] == before["unrelated-provider"]
    assert not case.rig.vault.switch_lock(case.vendor).locked()


@pytest.mark.parametrize("evidence", ["old-empty-target", "secret-target", "other-empty-profile",
    "unknown-history", "different-store", "different-empty-store", "unknown-pane", "active-slot-mismatch"])
async def test_first_login_does_not_exempt_existing_or_conflicting_evidence(launch_rig, monkeypatch, evidence):
    from agent_team_backend.cli_vendors.registry import VENDORS
    from agent_team_backend.credential_vault import LiveCredentials

    case = launch_rig
    monkeypatch.setenv("XDG_DATA_HOME", str(case.live.parent.parent))
    if evidence == "old-empty-target":
        target = case.rig.store.create(agent_key=case.vendor, name="Old B", scope=case.scope)["id"]
    else:
        created = await call(case.owner, "cli_profiles.create",
            {"agent_key": case.vendor, "name": "New B", "scope": case.scope}, "create-B")
        assert created["ok"], created
        target = created["payload"]["profile"]["id"]
    if evidence in ("secret-target", "active-slot-mismatch"):
        slot = target if evidence == "secret-target" else "__default__"
        case.rig.vault.write_slot(case.vendor, slot,
            LiveCredentials('{"type":"api","key":"FAKE-OLD"}'), scope=case.scope)
    if evidence == "other-empty-profile":
        case.rig.store.create(agent_key=case.vendor, name="Old C", scope=case.scope)
    if evidence == "unknown-history":
        app.pane_account_history.pin("old-pane", "__default__")
    if evidence in ("different-store", "different-empty-store"):
        monkeypatch.delenv("XDG_DATA_HOME")
        if evidence == "different-store":
            legacy = VENDORS[case.vendor].live_file_resolver(case.home)
            legacy.parent.mkdir(parents=True)
            legacy.write_bytes(case.live.read_bytes())
    if evidence == "unknown-pane":
        other = SimpleNamespace(id="unknown-term", pane_id="old-pane", agent_key=case.vendor,
            closed=False, metadata={})
        case.owner.terminals.registry[other.id] = other
        app._PTY_OWNERS[other.id] = case.owner
    snapshot = case.rig.vault._pre_login_snapshot_path(case.vendor, target)
    case.snapshot_path["value"] = str(snapshot)
    before = case.live.read_bytes()
    doc = case.rig.store.list()
    slots = {p: p.read_bytes() for p in (case.rig.vault._root / case.vendor).glob("*/" + VENDORS[case.vendor].slot_file)}
    result = await call(case.owner, "terminal.create",
        {**case.payload, "pane_id": "login-B", "login_profile_id": target, "metadata": {}}, "login-B")
    assert not result["ok"] and result["error"]["code"] in ("CREDENTIAL_STORE_UNVERIFIED", "LOGIN_BLOCKED_BY_LIVE_PANES")
    assert case.live.read_bytes() == before
    assert case.rig.store.list() == doc
    assert {p: p.read_bytes() for p in (case.rig.vault._root / case.vendor).glob("*/" + VENDORS[case.vendor].slot_file)} == slots
    assert case.stores._record(case.vendor) is None
    assert not snapshot.exists() and not case.output.exists()
    assert not case.rig.vault.switch_lock(case.vendor).locked()


@pytest.mark.parametrize("evidence", ["other-history", "other-live-and-history", "same-vendor",
    "unknown", "deleted", "registry-conflict", "duplicate-profile"])
async def test_common_xdg_history_requires_unique_consistent_vendor(launch_rig, monkeypatch, evidence):
    case = launch_rig
    monkeypatch.setenv("XDG_DATA_HOME", str(case.live.parent.parent))
    profile_id = "__default__"
    if evidence != "unknown":
        vendor = case.vendor if evidence == "same-vendor" else "claude"
        profile_id = case.rig.store.create(agent_key=vendor, name="Existing",
            **({"scope": case.scope} if vendor == case.vendor else {}))["id"]
        if evidence == "deleted":
            case.rig.store.delete(profile_id)
    app.pane_account_history.pin("history-pane", profile_id)
    if evidence in ("other-live-and-history", "registry-conflict"):
        vendor = "codex" if evidence == "registry-conflict" else "claude"
        other = SimpleNamespace(id="other-term", pane_id="history-pane", agent_key=vendor,
            closed=False, metadata={"launch_profile_id": profile_id})
        case.owner.terminals.registry[other.id] = other
        app._PTY_OWNERS[other.id] = case.owner
    if evidence == "duplicate-profile":
        original_list = case.rig.store.list

        def duplicate():
            doc = original_list()
            doc["profiles"].append(dict(doc["profiles"][0]))
            return doc

        monkeypatch.setattr(case.rig.store, "list", duplicate)
    before = case.live.read_bytes()
    result = await call(case.owner, "terminal.create", case.payload)
    assert result["ok"], result  # Ordinary launches remain usable on refusal.
    assert await asyncio.to_thread(case.processes[-1].wait, 15) == 0
    accepted = evidence in ("other-history", "other-live-and-history")
    assert case.owner.terminals.get("term-1").metadata["credential_store_verified"] is accepted
    assert (case.stores._record(case.vendor) is not None) is accepted
    assert case.live.read_bytes() == before
    assert case.rig.vault.slot_is_empty(case.vendor, "__default__", scope=case.scope)
    assert case.rig.store.list()["defaults"][case.vendor] is None


async def test_finder_public_launch_binds_then_public_switch_round_trips(launch_rig):
    from agent_team_backend.credential_vault import LiveCredentials

    case = launch_rig
    assert case.stores._db.kv_get("credential-store:" + case.vendor) is None
    assert case.rig.store.list()["defaults"][case.vendor] is None
    assert case.rig.vault.slot_is_empty(case.vendor, "__default__", scope=case.scope)
    result = await call(case.owner, "terminal.create", case.payload)
    assert result["ok"], result
    assert await asyncio.to_thread(case.processes[-1].wait, 15) == 0
    term = case.owner.terminals.get("term-1")
    assert term.metadata["credential_store_verified"] is True
    assert case.stores.path(case.vendor) == case.live
    assert json.loads(case.output.read_text())["credential"]["key"] == "FAKE-A"
    term.closed = True
    binding = case.stores._db.kv_get("credential-store:" + case.vendor)
    target = case.rig.store.create(agent_key=case.vendor, name="B", scope=case.scope)["id"]
    case.rig.vault.write_slot(case.vendor, target,
        LiveCredentials('{"type":"api","key":"FAKE-B"}'), scope=case.scope)

    for index, (profile_id, expected) in enumerate(((target, "FAKE-B"), (None, "FAKE-A")), start=2):
        switched = await call(case.owner, "cli_profiles.set_default",
            {"agent_key": case.vendor, "profile_id": profile_id}, f"switch-{index}")
        assert switched["ok"], switched
        assert case.rig.store.list()["defaults"][case.vendor] == profile_id
        assert json.loads(case.live.read_text())[case.scope]["key"] == expected
        launched = await call(case.owner, "terminal.create",
            {**case.payload, "pane_id": f"pane-{index}", "metadata": {}}, f"launch-{index}")
        assert launched["ok"], launched
        assert await asyncio.to_thread(case.processes[-1].wait, 15) == 0
        observed = json.loads(case.output.read_text())
        assert observed["credential"]["key"] == expected
        assert observed["home"] == str(case.home)
        assert observed["xdg"] == str(case.live.parent.parent)
        assert observed["unrelated"] == "FAKE-PRIVATE-ENV"
        term = case.owner.terminals.get(f"term-{index}")
        assert term.metadata["credential_store_verified"] is True
        term.closed = True
        assert case.stores._db.kv_get("credential-store:" + case.vendor) == binding
        assert not case.rig.vault.switch_lock(case.vendor).locked()


async def test_conflicting_regular_launch_runs_but_public_switch_cannot_mutate(launch_rig):
    from agent_team_backend.credential_vault import LiveCredentials

    case = launch_rig
    assert (await call(case.owner, "terminal.create", case.payload))["ok"]
    assert await asyncio.to_thread(case.processes[0].wait, 15) == 0
    case.owner.terminals.get("term-1").closed = True
    target = case.rig.store.create(agent_key=case.vendor, name="B", scope=case.scope)["id"]
    case.rig.vault.write_slot(case.vendor, target, LiveCredentials('{"type":"api","key":"FAKE-B"}'), scope=case.scope)
    record = case.stores._db.kv_get("credential-store:" + case.vendor)
    before = case.live.read_bytes()
    case.rc.write_text("export XDG_DATA_HOME=" + shlex.quote(str(case.live.parent.parent / "different")) + "\n")
    result = await call(case.owner, "terminal.create", {**case.payload, "pane_id": "conflict", "metadata": {}}, "conflict")
    assert result["ok"], result
    assert await asyncio.to_thread(case.processes[-1].wait, 15) == 0
    assert case.owner.terminals.get("term-2").metadata["credential_store_verified"] is False
    switched = await call(case.owner, "cli_profiles.set_default", {"agent_key": case.vendor, "profile_id": target}, "switch")
    assert not switched["ok"] and switched["error"]["code"] == "CREDENTIAL_STORE_UNVERIFIED"
    assert case.live.read_bytes() == before
    assert case.stores._db.kv_get("credential-store:" + case.vendor) == record
    assert case.rig.store.list()["defaults"][case.vendor] is None


async def test_cancel_during_snapshot_waits_then_removes_own_snapshot(launch_rig, monkeypatch):
    import threading

    case = launch_rig
    assert (await call(case.owner, "terminal.create", case.payload))["ok"]
    assert await asyncio.to_thread(case.processes[0].wait, 15) == 0
    case.owner.terminals.get("term-1").closed = True
    case.rig.vault.capture(case.vendor, "__default__", scope=case.scope)
    target = case.rig.store.create(agent_key=case.vendor, name="B", scope=case.scope)["id"]
    snapshot = case.rig.vault._pre_login_snapshot_path(case.vendor, target)
    case.snapshot_path["value"] = str(snapshot)
    entered, release = threading.Event(), threading.Event()
    original = case.rig.vault.login_spawn_env

    def paused(agent_key, slot_id, *, scope=None):
        result = original(agent_key, slot_id, scope=scope)
        entered.set()
        assert release.wait(10)
        return result

    monkeypatch.setattr(case.rig.vault, "login_spawn_env", paused)
    payload = {**case.payload, "pane_id": "cancelled", "login_profile_id": target, "metadata": {}}
    task = asyncio.create_task(call(case.owner, "terminal.create", payload, "cancel"))
    try:
        assert await asyncio.to_thread(entered.wait, 10)
        task.cancel()
        await asyncio.sleep(0)
        assert case.rig.vault.switch_lock(case.vendor).locked()
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
    assert task.cancelled()
    assert not snapshot.exists()
    assert not case.rig.vault.switch_lock(case.vendor).locked()
    assert case.owner.terminals.get("term-2").closed
    assert case.processes[-1].poll() is not None
    assert "login" not in json.loads(case.output.read_text())["args"]
    assert json.loads(case.live.read_text())[case.scope]["key"] == "FAKE-A"


async def test_helper_timeout_during_snapshot_refuses_login_and_cleans_pending(launch_rig, monkeypatch):
    import threading
    from agent_team_backend.credential_launch import CredentialLaunch

    case = launch_rig
    assert (await call(case.owner, "terminal.create", case.payload))["ok"]
    assert await asyncio.to_thread(case.processes[0].wait, 15) == 0
    case.owner.terminals.get("term-1").closed = True
    case.rig.vault.capture(case.vendor, "__default__", scope=case.scope)
    target = case.rig.store.create(agent_key=case.vendor, name="B", scope=case.scope)["id"]
    snapshot = case.rig.vault._pre_login_snapshot_path(case.vendor, target)
    case.snapshot_path["value"] = str(snapshot)
    original_start = CredentialLaunch.start
    launches = []

    async def short_start(path_inputs):
        launch = await original_start(path_inputs, timeout=1)
        launches.append(launch)
        return launch

    async def wait_for_started_helper(launch):
        # Process startup is not the timeout under test. The connected helper
        # still times out waiting for GO while the snapshot worker is paused.
        return await asyncio.wait_for(asyncio.shield(launch._report), 10)

    monkeypatch.setattr(CredentialLaunch, "start", short_start)
    monkeypatch.setattr(CredentialLaunch, "wait_report", wait_for_started_helper)
    entered, release = threading.Event(), threading.Event()
    original_snapshot = case.rig.vault.login_spawn_env

    def paused(agent_key, slot_id, *, scope=None):
        result = original_snapshot(agent_key, slot_id, scope=scope)
        entered.set()
        assert release.wait(5)
        return result

    monkeypatch.setattr(case.rig.vault, "login_spawn_env", paused)
    payload = {**case.payload, "pane_id": "timed-out", "login_profile_id": target, "metadata": {}}
    task = asyncio.create_task(call(case.owner, "terminal.create", payload, "timeout"))
    try:
        assert await asyncio.to_thread(entered.wait, 10)
        assert await asyncio.wait_for(asyncio.shield(launches[0]._received), 3) is False
        assert case.rig.vault.switch_lock(case.vendor).locked()
    finally:
        release.set()
    result = await task
    assert not result["ok"] and result["error"]["code"] == "CREDENTIAL_STORE_UNVERIFIED"
    assert not snapshot.exists()
    assert not launches[0]._connections
    assert not launches[0]._server.is_serving()
    assert not case.rig.vault.switch_lock(case.vendor).locked()
    assert case.owner.terminals.get("term-2").closed
    assert case.processes[-1].poll() is not None
    assert "login" not in json.loads(case.output.read_text())["args"]
    assert json.loads(case.live.read_text())[case.scope]["key"] == "FAKE-A"


async def test_login_handler_snapshots_before_go_and_duplicate_keeps_original_bytes(launch_rig):
    case = launch_rig
    assert (await call(case.owner, "terminal.create", case.payload))["ok"]
    assert await asyncio.to_thread(case.processes[0].wait, 15) == 0
    case.owner.terminals.get("term-1").closed = True
    case.rig.vault.capture(case.vendor, "__default__", scope=case.scope)
    target = case.rig.store.create(agent_key=case.vendor, name="B", scope=case.scope)["id"]
    snapshot = case.rig.vault._pre_login_snapshot_path(case.vendor, target)
    case.snapshot_path["value"] = str(snapshot)
    payload = {**case.payload, "pane_id": "login-pane", "login_profile_id": target, "metadata": {}}
    result = await call(case.owner, "terminal.create", payload, "login")
    assert result["ok"], result
    raw = snapshot.read_bytes()
    process = case.processes[-1]
    assert await asyncio.to_thread(process.wait, 15) == 0, process.stderr.read().decode()
    assert json.loads(case.live.read_text())[case.scope]["key"] == "FAKE-B"
    duplicate = await call(case.owner, "terminal.create", {**payload, "pane_id": "duplicate"}, "duplicate")
    assert not duplicate["ok"]
    assert snapshot.read_bytes() == raw
    assert len(case.processes) == 2
    case.owner.terminals.get("term-2").closed = True
    assert await usage_service._harvest_login_home_locked(case.rig.vault, case.vendor, target)
    assert json.loads(case.live.read_text())[case.scope]["key"] == "FAKE-A"
    assert json.loads(case.rig.vault.read_slot(case.vendor, target, scope=case.scope).secret)["key"] == "FAKE-B"
    assert not case.rig.vault.switch_lock(case.vendor).locked()
