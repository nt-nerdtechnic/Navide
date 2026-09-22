"""mcode account switching: one namespace record of ``<data>/auth/auth.json``
plus the derived ``auth-state.json``. Temp data dirs and synthetic tokens
only. The last test hands the pair the vault wrote to mcode 0.4.12's own auth
module (``getStatus``) when that package is installed — a same-version parser
check, not a login."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors import mcode
from agent_team_backend.credential_vault import (
    DEFAULT_SLOT_ID,
    CredentialVault,
    CredentialVaultError,
    LiveCredentials,
)

MCODE_CHUNK = Path(
    "/Users/neillu/.nvm/versions/node/v22.19.0/lib/node_modules/@minimax-ai/code/chunks/chunk-WAVNKSSE.js"
)


def _vault(tmp_path: Path) -> CredentialVault:
    return CredentialVault(
        root=tmp_path / "root", real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""), platform="linux",
    )


def _account_hash(auth_home: Path) -> str:
    digest = hashlib.sha256(f"{auth_home}\0mcode-public".encode()).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def _cred(tag: str, generation: int) -> dict:
    return {
        "schemaVersion": 1, "accessToken": f"synthetic-access-{tag}",
        "refreshToken": f"synthetic-refresh-{tag}", "tokenType": "Bearer",
        "clientId": "mcode-public", "scopes": ["agent.default"],
        "audience": "agent-backend", "expiresAtMs": 1_800_000_000_000,
        "generation": generation, "loginEpoch": f"epoch-{tag}",
    }


def _state(region: str, generation: int, status: str = "authenticated") -> dict:
    return {
        "schemaVersion": 2, "status": status, "storeKind": "file",
        "clientId": "mcode-public", "scopes": ["agent.default"],
        "audience": "agent-backend", "buildEnv": "prod", "region": region,
        "generation": generation, "expiresAtMs": 1_800_000_000_000,
    }


def _seed(home: Path, region: str, tag: str, generation: int) -> tuple[Path, Path]:
    auth_home = home / ".minimax" / "auth"
    ns = auth_home / "prod" / region / "mcode-public"
    ns.mkdir(parents=True)
    key = f"com.minimax.mcode.oauth.prod.{region}\0{_account_hash(auth_home)}"
    (auth_home / "auth.json").write_text(json.dumps({"schemaVersion": 1, "records": {key: _cred(tag, generation)}}))
    (ns / "auth-state.json").write_text(json.dumps(_state(region, generation)))
    os.chmod(auth_home, 0o700)
    os.chmod(auth_home / "auth.json", 0o600)
    return auth_home, ns


def _read_pair(auth_home: Path, region: str) -> tuple[dict, dict]:
    payload = json.loads((auth_home / "auth.json").read_text())
    state = json.loads((auth_home / "prod" / region / "mcode-public" / "auth-state.json").read_text())
    return payload, state


def test_round_trip_keeps_generation_paired_and_other_namespace_intact(tmp_path: Path, monkeypatch) -> None:
    for var in ("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR", "MAVIS_REGION"):
        monkeypatch.delenv(var, raising=False)
    home = tmp_path / "home"
    auth_home, _ = _seed(home, "cn", "A", 3)
    # An unrelated namespace record (another env) must survive untouched.
    payload = json.loads((auth_home / "auth.json").read_text())
    payload["records"]["com.minimax.mcode.oauth.staging.cn\0" + _account_hash(auth_home)] = _cred("S", 1)
    (auth_home / "auth.json").write_text(json.dumps(payload))
    vault = _vault(tmp_path)
    vault.write_slot("mcode", "b", LiveCredentials(secret=json.dumps(_cred("B", 7))), scope="cn")

    vault.switch("mcode", DEFAULT_SLOT_ID, "b", scope="cn")

    payload, state = _read_pair(auth_home, "cn")
    live_key = "com.minimax.mcode.oauth.prod.cn\0" + _account_hash(auth_home)
    assert payload["records"][live_key]["accessToken"] == "synthetic-access-B"
    assert payload["records"]["com.minimax.mcode.oauth.staging.cn\0" + _account_hash(auth_home)]["accessToken"] == "synthetic-access-S"
    assert state["generation"] == 7 and state["status"] == "authenticated" and state["region"] == "cn"
    assert json.loads(vault.read_slot("mcode", DEFAULT_SLOT_ID, scope="cn").secret)["accessToken"] == "synthetic-access-A"
    assert vault.identity("mcode", scope="cn") == {"email": None, "signedIn": True}

    vault.switch("mcode", "b", DEFAULT_SLOT_ID, scope="cn")
    payload, state = _read_pair(auth_home, "cn")
    assert payload["records"][live_key]["accessToken"] == "synthetic-access-A"
    assert state["generation"] == 3


def test_empty_slot_removes_record_and_writes_anonymous_state(tmp_path: Path, monkeypatch) -> None:
    for var in ("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR", "MAVIS_REGION"):
        monkeypatch.delenv(var, raising=False)
    auth_home, _ = _seed(tmp_path / "home", "cn", "A", 3)
    vault = _vault(tmp_path)
    vault.switch("mcode", DEFAULT_SLOT_ID, "empty", scope="cn")
    payload, state = _read_pair(auth_home, "cn")
    assert not any(k.startswith("com.minimax.mcode.oauth.prod.cn\0") for k in payload["records"])
    assert state["status"] == "anonymous" and state["generation"] == 4


def test_login_home_record_is_rekeyed_to_the_real_data_dir(tmp_path: Path, monkeypatch) -> None:
    """A login pane runs under MINIMAX_DATA_DIR=<login home>: its record is
    keyed with THAT dir's hash. Harvest stores the credential only, and the
    restore keys it with the real data dir's hash."""
    for var in ("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR", "MAVIS_REGION"):
        monkeypatch.delenv(var, raising=False)
    auth_home, _ = _seed(tmp_path / "home", "cn", "A", 3)
    vault = _vault(tmp_path)
    env_set, _ = vault.login_spawn_env("mcode", "b", scope="cn")
    login_home = Path(env_set["MINIMAX_DATA_DIR"])
    login_auth = login_home / "auth"
    login_auth.mkdir(parents=True)
    foreign_key = "com.minimax.mcode.oauth.prod.cn\0" + _account_hash(login_auth)
    (login_auth / "auth.json").write_text(json.dumps({"schemaVersion": 1, "records": {foreign_key: _cred("B", 1)}}))
    assert vault.login_secret_present("mcode", "b", scope="cn") is True
    assert vault.harvest_login_home("mcode", "b", scope="cn") is True

    vault.switch("mcode", DEFAULT_SLOT_ID, "b", scope="cn")
    payload, state = _read_pair(auth_home, "cn")
    assert payload["records"]["com.minimax.mcode.oauth.prod.cn\0" + _account_hash(auth_home)]["accessToken"] == "synthetic-access-B"
    assert foreign_key not in payload["records"]
    assert state["generation"] == 1


def test_switch_into_the_other_region_is_refused(tmp_path: Path, monkeypatch) -> None:
    for var in ("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR", "MAVIS_REGION"):
        monkeypatch.delenv(var, raising=False)
    auth_home, _ = _seed(tmp_path / "home", "cn", "A", 3)
    vault = _vault(tmp_path)
    vault.write_slot("mcode", "en-acct", LiveCredentials(secret=json.dumps(_cred("E", 2))), scope="en")
    with pytest.raises(CredentialVaultError):
        vault.switch("mcode", DEFAULT_SLOT_ID, "en-acct", scope="en")
    payload, state = _read_pair(auth_home, "cn")
    assert state["generation"] == 3 and payload["records"]["com.minimax.mcode.oauth.prod.cn\0" + _account_hash(auth_home)]["accessToken"] == "synthetic-access-A"


def test_held_cli_lock_refuses_the_switch(tmp_path: Path, monkeypatch) -> None:
    for var in ("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR", "MAVIS_REGION"):
        monkeypatch.delenv(var, raising=False)
    auth_home, ns = _seed(tmp_path / "home", "cn", "A", 3)
    (ns / "auth.lock.lock").mkdir()
    vault = _vault(tmp_path)
    with pytest.raises(CredentialVaultError):
        vault.read_live("mcode", scope="cn")


def test_fresh_data_dir_gets_the_record_keyed_to_its_own_hash(tmp_path: Path, monkeypatch) -> None:
    """No record on this machine yet: the merge cannot know the hash, the
    companion pass computes it from the data dir and re-keys the record."""
    for var in ("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR", "MAVIS_REGION"):
        monkeypatch.delenv(var, raising=False)
    auth_home = tmp_path / "home" / ".minimax" / "auth"
    auth_home.mkdir(parents=True)
    vault = _vault(tmp_path)
    vault.write_slot("mcode", "b", LiveCredentials(secret=json.dumps(_cred("B", 7))), scope="cn")
    vault.restore("mcode", "b", scope="cn")
    payload, state = _read_pair(auth_home, "cn")
    assert list(payload["records"]) == ["com.minimax.mcode.oauth.prod.cn\0" + _account_hash(auth_home)]
    assert state["generation"] == 7


def test_merge_refuses_a_non_credential_portion() -> None:
    doc = json.dumps({"schemaVersion": 1, "records": {"com.minimax.mcode.oauth.prod.cn\0h": _cred("A", 1)}})
    with pytest.raises(ValueError):
        mcode._mcode_merge(doc, "cn", json.dumps({"accessToken": "only"}))
    with pytest.raises(ValueError):
        mcode._mcode_merge(doc, "jp", None)


@pytest.mark.skipif(not MCODE_CHUNK.exists() or shutil.which("node") is None, reason="mcode 0.4.12 package not installed here")
def test_pair_written_by_the_vault_is_authenticated_for_mcodes_own_auth_module(tmp_path: Path, monkeypatch) -> None:
    for var in ("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR", "MAVIS_REGION"):
        monkeypatch.delenv(var, raising=False)
    auth_home, _ = _seed(tmp_path / "home", "cn", "A", 3)
    vault = _vault(tmp_path)
    vault.write_slot("mcode", "b", LiveCredentials(secret=json.dumps(_cred("B", 7))), scope="cn")
    vault.switch("mcode", DEFAULT_SLOT_ID, "b", scope="cn")
    os.chmod(auth_home, 0o700)

    script = f"""
    const m = await import({json.dumps(str(MCODE_CHUNK))});
    const ns = m.b({{ dataDir: {json.dumps(str(tmp_path / 'home' / '.minimax'))}, buildEnv: 'prod', region: 'cn' }});
    const mgr = new m.h({{ namespace: ns, credentialStore: m.i(ns), oauthClient: {{}}, now: () => 1700000000000 }});
    console.log(JSON.stringify(await mgr.getStatus()));
    """
    out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    status = json.loads(out.stdout.strip().splitlines()[-1])
    assert status["status"] == "authenticated" and status["generation"] == 7
