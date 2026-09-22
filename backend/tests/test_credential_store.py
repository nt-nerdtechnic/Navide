"""Managed destinations use disposable homes, stores and database rows only."""
import json
from pathlib import Path

import pytest

from agent_team_backend.credential_store import CredentialStores, StoreUnverified
from agent_team_backend.credential_vault import CredentialVault, LiveCredentials
from agent_team_backend.credential_watcher import _watch_targets
from agent_team_backend.db import Database
from agent_team_backend.cli_vendors.kilo import read_kilo_credentials
from agent_team_backend.cli_vendors.opencode import read_opencode_credentials


@pytest.fixture(params=[("kilo", "kilo"), ("opencode", "anthropic")])
def store_case(request, tmp_path, monkeypatch):
    vendor, scope = request.param
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    home = tmp_path / "home"
    home.mkdir()
    db = Database(tmp_path / "state.db")
    active = []
    stores = CredentialStores(db, lambda _: active)
    vault = CredentialVault(root=tmp_path / "slots", real_home=home, stores=stores)
    path = tmp_path / "selected" / vendor / "auth.json"
    path.parent.mkdir(parents=True)
    entry = {"type": "api", "key": "FAKE-A"}
    path.write_text(json.dumps({scope: entry, "untouched": {"key": "FAKE-OTHER"}}))
    report = {"home": str(home), "cwd": str(tmp_path), "env": {"XDG_DATA_HOME": "selected"},
              "verified": True, "credentialEnv": [], "token": "never-persist-this"}
    yield vendor, scope, vault, stores, db, active, path, report
    db.close()


def bind(case, **kwargs):
    vendor, scope, vault, stores, _, _, _, report = case
    return stores.bind(vendor, report, vault=vault, slot_id="__default__", scope=scope, **kwargs)


def test_first_store_persists_only_path_metadata_and_switches_same_file(store_case):
    vendor, scope, vault, stores, db, active, path, report = store_case
    identity = bind(store_case)
    assert vault._live_file(vendor) == path
    assert _watch_targets(vault._real_home, (vendor,), vault._live_file) == {path.parent: {path.name: vendor}}
    original = vault.read_live(vendor, scope=scope)
    vault.write_slot(vendor, "B", LiveCredentials(json.dumps({"type": "api", "key": "FAKE-B"})), scope=scope)
    vault.switch(vendor, "__default__", "B", scope=scope)
    assert json.loads(path.read_text())[scope]["key"] == "FAKE-B"
    vault.switch(vendor, "B", "__default__", scope=scope)
    assert json.loads(vault.read_live(vendor, scope=scope).secret) == json.loads(original.secret)
    assert json.loads(path.read_text())["untouched"] == {"key": "FAKE-OTHER"}
    context = stores.context(vendor)
    if vendor == "kilo":
        assert read_kilo_credentials(context.home, dict(context.env), bound_store=True)["token"] == "FAKE-A"
    else:
        assert read_opencode_credentials(context.home, dict(context.env))[scope]["key"] == "FAKE-A"
    persisted = db.kv_get("credential-store:" + vendor)
    assert set(persisted) == {"home", "cwd", "env", "path"}
    assert persisted["env"] == {"XDG_DATA_HOME": str(path.parent.parent)}
    assert "FAKE-" not in json.dumps(persisted) and "never-persist" not in json.dumps(persisted)
    reopened = Database(db._path)
    try:
        restored = CredentialStores(reopened, lambda _: active)
        assert restored.store_id(vendor) == identity
        assert restored.path(vendor) == path
    finally:
        reopened.close()
    assert report["env"] == {"XDG_DATA_HOME": "selected"}


@pytest.mark.parametrize("reason", ["other-live", "different-slot", "unknown-pane", "ledger", "extra-env", "wrapper"])
def test_upgrade_ambiguity_refuses_without_mutation(store_case, reason):
    vendor, scope, vault, stores, db, active, path, report = store_case
    if reason == "other-live":
        other = vault._real_home / ".local/share" / vendor / "auth.json"
        other.parent.mkdir(parents=True)
        other.write_bytes(path.read_bytes())  # Even identical credentials do not identify a store.
    if reason == "different-slot":
        vault.write_slot(vendor, "__default__", LiveCredentials('{"key":"FAKE-FOREIGN"}'), scope=scope)
    if reason == "unknown-pane":
        active.append({})
    if reason == "extra-env":
        report["env"]["UNRELATED_TOKEN"] = "FAKE-SECRET"
    if reason == "wrapper":
        report["verified"] = False
    before = path.read_bytes()
    slot_before = vault.read_slot(vendor, "__default__", scope=scope).secret
    with pytest.raises(StoreUnverified):
        bind(store_case, has_managed_state=reason == "ledger")
    assert db.kv_get("credential-store:" + vendor) is None
    assert path.read_bytes() == before
    assert vault.read_slot(vendor, "__default__", scope=scope).secret == slot_before


def test_conflicting_and_unverified_panes_block_account_mutation(store_case):
    vendor, scope, vault, stores, db, active, path, report = store_case
    identity = bind(store_case)
    record = db.kv_get("credential-store:" + vendor)
    report["env"]["XDG_DATA_HOME"] = "elsewhere"
    with pytest.raises(StoreUnverified, match="different credential store"):
        bind(store_case)
    assert db.kv_get("credential-store:" + vendor) == record
    before = path.read_bytes()
    for meta in ({}, {"credential_store_verified": True, "credential_store_id": "wrong"}):
        active[:] = [meta]
        with pytest.raises(StoreUnverified):
            vault.capture(vendor, "__default__", scope=scope)
        with pytest.raises(StoreUnverified):
            vault.write_live(vendor, LiveCredentials(), scope=scope)
        assert path.read_bytes() == before
        assert vault.read_slot(vendor, "__default__", scope=scope).secret is None
    active[:] = [{"credential_store_verified": True, "credential_store_id": identity}]
    vault.capture(vendor, "__default__", scope=scope)
    assert vault.read_slot(vendor, "__default__", scope=scope).secret is not None


def test_symlink_destination_drift_is_not_silently_adopted(store_case):
    vendor, _, _, stores, _, _, path, _ = store_case
    bind(store_case)
    target = path.with_name("other.json")
    target.write_bytes(path.read_bytes())
    path.unlink()
    try:
        path.symlink_to(target)
    except OSError:
        pytest.skip("symlinks are unavailable")
    with pytest.raises(StoreUnverified, match="destination changed"):
        stores.path(vendor)


def test_empty_install_can_bind_without_old_identity(store_case):
    vendor, _, vault, stores, _, _, path, _ = store_case
    path.unlink()
    bind(store_case)
    assert stores.path(vendor) == path
    assert not path.exists()
    assert not vault.slot_dir(vendor, "__default__").exists()


async def test_watcher_filters_events_by_bound_destination(store_case):
    from types import SimpleNamespace
    from watchdog.events import FileModifiedEvent
    from agent_team_backend.credential_watcher import CredentialWatcher

    vendor, _, vault, _, _, _, path, _ = store_case
    bind(store_case)
    scheduled, touched = [], []

    async def sink(_key):
        pass

    watcher = CredentialWatcher(sink, agent_keys=(vendor,), real_home=vault._real_home,
                                fingerprint=lambda _: "FAKE-IDENTITY", resolver=vault._live_file)
    watcher._observer = SimpleNamespace(schedule=lambda handler, directory, **kwargs: scheduled.append((handler, directory)))
    watcher._mark_touched_threadsafe = touched.append
    await watcher.watch_bound_store(vendor, path)
    assert len(scheduled) == 1 and scheduled[0][1] == str(path.parent)
    handler = scheduled[0][0]
    handler.on_any_event(FileModifiedEvent(str(vault._real_home / ".local/share" / vendor / "auth.json")))
    assert touched == []
    handler.on_any_event(FileModifiedEvent(str(path)))
    assert touched == [vendor]


async def test_usage_poll_consumes_bound_context_not_backend_environment(store_case, monkeypatch, tmp_path):
    from agent_team_backend import usage_service as usage
    from agent_team_backend.cli_vendors import kilo, opencode
    from agent_team_backend.cli_vendors.registry import VENDORS

    vendor, scope, vault, _, _, _, path, _ = store_case
    bind(store_case)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "backend-decoy"))
    monkeypatch.setattr(usage, "_get_profiles_store", lambda: None)
    monkeypatch.setattr(usage, "_get_credential_vault", lambda: vault)
    monkeypatch.setattr(usage, "_CLI_VENDORS", {vendor: VENDORS[vendor]})
    calls = []

    async def empty(_home):
        return usage._snapshot("claude", "no-credentials")

    async def fetch(home, env=None, **kwargs):
        calls.append((home, env))
        assert env == {"XDG_DATA_HOME": str(path.parent.parent)}
        if vendor == "kilo":
            assert kwargs == {"bound_store": True}
            assert kilo.read_kilo_credentials(home, env, **kwargs)["token"] == "FAKE-A"
        else:
            assert opencode.read_opencode_credentials(home, env)[scope]["key"] == "FAKE-A"
        return usage._snapshot(vendor, "no-credentials")

    monkeypatch.setattr(usage, "fetch_claude", empty)
    monkeypatch.setattr(kilo if vendor == "kilo" else opencode, "fetch_" + vendor, fetch)
    result = await usage.UsageService(cache_path=tmp_path / "usage.json").poll_once(vault._real_home)
    assert result["providers"][vendor]["status"] == "no-credentials"
    assert len(calls) == 1
