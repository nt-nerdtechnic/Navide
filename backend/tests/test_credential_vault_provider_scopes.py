"""Per-provider credential stores through the vault: opencode, pi, muse, qwen
(and kilo as the single-scope case).

Every vendor here keeps more than one credential in one document. The vault
must switch exactly the profile's provider entry, both ways between the
reserved ``__default__`` slot and a scoped profile, and leave every other
provider's value where it was. Temp files only; no real home, no Keychain."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.credential_vault import (
    DEFAULT_SLOT_ID,
    CredentialVault,
    CredentialVaultError,
    LiveCredentials,
)


def _vault(tmp_path: Path) -> CredentialVault:
    return CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=lambda args, input_text=None: (1, ""),
        platform="linux",
    )


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


OPENCODE_LIVE = {
    "anthropic": {"type": "oauth", "access": "A-access", "refresh": "A-refresh", "expires": 1},
    "openai": {"type": "oauth", "access": "O-access", "refresh": "O-refresh", "expires": 2},
    "minimax-coding-plan": {"type": "api", "key": "mm-key"},
    "some-byok": {"type": "api", "key": "keep"},
}

PI_LIVE = {
    "anthropic": {"type": "oauth", "access": "A", "refresh": "AR", "expires": 1},
    "openai-codex": {"type": "oauth", "access": "C", "refresh": "CR", "expires": 2, "accountId": "acc"},
    "deepseek": {"type": "api_key", "key": "byok"},
}


@pytest.mark.parametrize("agent_key,live_rel,live_doc,scope,other", [
    ("opencode", ".local/share/opencode/auth.json", OPENCODE_LIVE, "anthropic", "openai"),
    ("opencode", ".local/share/opencode/auth.json", OPENCODE_LIVE, "minimax-coding-plan", "anthropic"),
    ("pi", ".pi/agent/auth.json", PI_LIVE, "openai-codex", "anthropic"),
])
def test_scoped_switch_round_trip_keeps_other_providers(
    tmp_path: Path, agent_key: str, live_rel: str, live_doc: dict, scope: str, other: str,
    monkeypatch,
) -> None:
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    monkeypatch.delenv("PI_CODING_AGENT_DIR", raising=False)
    vault = _vault(tmp_path)
    live = tmp_path / "home" / live_rel
    _write(live, json.dumps(live_doc, indent=2))
    incoming = {"type": "oauth", "access": "B-access", "refresh": "B-refresh", "expires": 9}
    vault.write_slot(agent_key, "b", LiveCredentials(secret=json.dumps(incoming)), scope=scope)

    # default -> B
    vault.switch(agent_key, DEFAULT_SLOT_ID, "b", scope=scope)
    after = json.loads(live.read_text(encoding="utf-8"))
    assert after[scope] == incoming
    for key, value in live_doc.items():
        if key != scope:
            assert after[key] == value, key
    assert json.loads(vault.read_slot(agent_key, DEFAULT_SLOT_ID, scope=scope).secret) == live_doc[scope]
    # The other provider is NOT parked: the default slot holds this scope only.
    assert vault.read_slot(agent_key, DEFAULT_SLOT_ID, scope=other).secret is None

    # B -> default: the original entry comes back, others still untouched.
    vault.switch(agent_key, "b", DEFAULT_SLOT_ID, scope=scope)
    restored = json.loads(live.read_text(encoding="utf-8"))
    assert restored == live_doc
    assert json.loads(vault.read_slot(agent_key, "b", scope=scope).secret) == incoming


def test_default_slot_parks_several_scopes_side_by_side(tmp_path: Path, monkeypatch) -> None:
    """Two scoped profiles of different providers each capture their own
    entry into ``__default__`` without clobbering the other's."""
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    vault = _vault(tmp_path)
    live = tmp_path / "home" / ".local/share/opencode/auth.json"
    _write(live, json.dumps(OPENCODE_LIVE))
    vault.write_slot("opencode", "a2", LiveCredentials(secret='{"type":"oauth","access":"A2","refresh":"r"}'), scope="anthropic")
    vault.write_slot("opencode", "o2", LiveCredentials(secret='{"type":"oauth","access":"O2","refresh":"r"}'), scope="openai")

    vault.switch("opencode", DEFAULT_SLOT_ID, "a2", scope="anthropic")
    vault.switch("opencode", DEFAULT_SLOT_ID, "o2", scope="openai")

    parked = json.loads((vault.slot_dir("opencode", DEFAULT_SLOT_ID) / "auth.json").read_text(encoding="utf-8"))
    assert parked == {"anthropic": OPENCODE_LIVE["anthropic"], "openai": OPENCODE_LIVE["openai"]}
    after = json.loads(live.read_text(encoding="utf-8"))
    assert after["anthropic"]["access"] == "A2" and after["openai"]["access"] == "O2"
    assert after["minimax-coding-plan"] == OPENCODE_LIVE["minimax-coding-plan"]


def test_multi_scope_vendor_refuses_a_missing_or_foreign_scope(tmp_path: Path) -> None:
    vault = _vault(tmp_path)
    for scope in (None, "deepseek", "kilo"):
        with pytest.raises(CredentialVaultError):
            vault.read_live("opencode", scope=scope)
        with pytest.raises(CredentialVaultError):
            vault.switch("pi", DEFAULT_SLOT_ID, "b", scope=scope)


def test_restore_from_empty_scoped_slot_removes_only_that_entry(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    vault = _vault(tmp_path)
    live = tmp_path / "home" / ".local/share/opencode/auth.json"
    _write(live, json.dumps(OPENCODE_LIVE))

    vault.switch("opencode", DEFAULT_SLOT_ID, "empty", scope="anthropic")

    after = json.loads(live.read_text(encoding="utf-8"))
    assert "anthropic" not in after
    assert after["openai"] == OPENCODE_LIVE["openai"]
    assert after["some-byok"] == OPENCODE_LIVE["some-byok"]


def test_switch_rollback_restores_the_scoped_entry(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    vault = _vault(tmp_path)
    live = tmp_path / "home" / ".local/share/opencode/auth.json"
    _write(live, json.dumps(OPENCODE_LIVE))
    vault.write_slot("opencode", "b", LiveCredentials(secret='{"type":"oauth","access":"B","refresh":"r"}'), scope="anthropic")
    from agent_team_backend import credential_vault as cv
    real_write = cv._write_live_file
    calls = {"n": 0}

    def flaky(path, text):
        calls["n"] += 1
        if calls["n"] == 1:  # the restore's write fails; the rollback's succeeds
            raise OSError("disk full")
        real_write(path, text)

    monkeypatch.setattr(cv, "_write_live_file", flaky)
    with pytest.raises(CredentialVaultError):
        vault.switch("opencode", DEFAULT_SLOT_ID, "b", scope="anthropic")

    assert json.loads(live.read_text(encoding="utf-8")) == OPENCODE_LIVE
    assert calls["n"] == 2


def test_identity_of_scoped_slots(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    vault = _vault(tmp_path)
    live = tmp_path / "home" / ".local/share/opencode/auth.json"
    _write(live, json.dumps(OPENCODE_LIVE))
    assert vault.identity("opencode", scope="anthropic") == {"email": None, "signedIn": True}
    assert vault.identity("opencode", scope="github-copilot") == {"email": None, "signedIn": False}
    vault.write_slot("opencode", "k", LiveCredentials(secret='{"type":"api","key":""}'), scope="minimax-coding-plan")
    assert vault.identity("opencode", "k", scope="minimax-coding-plan") == {"email": None, "signedIn": False}


def test_pi_login_home_harvests_only_the_profile_scope(tmp_path: Path, monkeypatch) -> None:
    """A pi login pane runs under PI_CODING_AGENT_DIR=<login home>; the
    auth.json it writes there may carry several providers, and only the
    profile's scope entry is taken into the slot."""
    monkeypatch.delenv("PI_CODING_AGENT_DIR", raising=False)
    vault = _vault(tmp_path)
    env_set, env_remove = vault.login_spawn_env("pi", "p1")
    home = vault.login_home_path("pi", "p1")
    assert env_set == {"PI_CODING_AGENT_DIR": str(home)} and env_remove == []
    assert vault.login_secret_present("pi", "p1", scope="xai") is False
    _write(home / "auth.json", json.dumps({
        "xai": {"type": "oauth", "access": "X", "refresh": "XR"},
        "anthropic": {"type": "oauth", "access": "A", "refresh": "AR"},
    }))
    assert vault.login_secret_present("pi", "p1", scope="xai") is True
    assert vault.login_secret_present("pi", "p1", scope="kimi-coding") is False

    assert vault.harvest_login_home("pi", "p1", scope="xai") is True

    parked = json.loads((vault.slot_dir("pi", "p1") / "auth.json").read_text(encoding="utf-8"))
    assert parked == {"xai": {"type": "oauth", "access": "X", "refresh": "XR"}}
    assert not home.exists()


def test_pi_live_file_follows_agent_dir_env(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "agentdir"))
    vault = _vault(tmp_path)
    _write(tmp_path / "agentdir" / "auth.json", json.dumps(PI_LIVE))
    assert vault.identity("pi", scope="anthropic")["signedIn"] is True


def test_opencode_live_file_follows_xdg_data_home(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    vault = _vault(tmp_path)
    _write(tmp_path / "xdg" / "opencode" / "auth.json", json.dumps(OPENCODE_LIVE))
    assert vault.identity("opencode", scope="openai")["signedIn"] is True


# ── muse: providers nested one level down ────────────────────────────────


MUSE_LIVE = {
    "providers": {
        "meta": {"mechanism": "oauth", "access_token": "M1", "expires_at": 1800000000},
        "other": {"mechanism": "api", "key": "keep"},
    },
    "unrelated": True,
}


def test_muse_switch_touches_only_providers_meta(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.delenv("MUSE_AUTH_PATH", raising=False)
    vault = _vault(tmp_path)
    live = tmp_path / "home" / ".config" / "muse" / "auth.json"
    _write(live, json.dumps(MUSE_LIVE))
    incoming = {"mechanism": "oauth", "access_token": "M2", "expires_at": 1900000000}
    vault.write_slot("muse", "b", LiveCredentials(secret=json.dumps(incoming)))  # single scope: implied

    vault.switch("muse", DEFAULT_SLOT_ID, "b")
    after = json.loads(live.read_text(encoding="utf-8"))
    assert after["providers"]["meta"] == incoming
    assert after["providers"]["other"] == MUSE_LIVE["providers"]["other"]
    assert after["unrelated"] is True
    assert vault.identity("muse") == {"email": None, "signedIn": True}

    vault.switch("muse", "b", DEFAULT_SLOT_ID, scope="meta")
    assert json.loads(live.read_text(encoding="utf-8")) == MUSE_LIVE


def test_muse_auth_path_env_wins(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MUSE_AUTH_PATH", str(tmp_path / "elsewhere" / "creds.json"))
    vault = _vault(tmp_path)
    _write(tmp_path / "elsewhere" / "creds.json", json.dumps(MUSE_LIVE))
    assert vault.identity("muse")["signedIn"] is True


# ── qwen: a key inside .env or settings.json ─────────────────────────────


def test_qwen_switch_rewrites_only_the_key_line_in_dotenv(tmp_path: Path) -> None:
    vault = _vault(tmp_path)
    env_file = tmp_path / "home" / ".qwen" / ".env"
    _write(env_file, "# my keys\nOTHER=1\nexport BAILIAN_CODING_PLAN_API_KEY='sk-A'\n")
    vault.write_slot("qwen", "b", LiveCredentials(secret='{"DASHSCOPE_API_KEY": "sk-B"}'))

    vault.switch("qwen", DEFAULT_SLOT_ID, "b")

    assert env_file.read_text(encoding="utf-8") == "# my keys\nOTHER=1\nDASHSCOPE_API_KEY=sk-B\n"
    assert json.loads(vault.read_slot("qwen", DEFAULT_SLOT_ID).secret) == {
        "BAILIAN_CODING_PLAN_API_KEY": "sk-A",
    }

    vault.switch("qwen", "b", DEFAULT_SLOT_ID)
    assert env_file.read_text(encoding="utf-8") == "# my keys\nOTHER=1\nBAILIAN_CODING_PLAN_API_KEY=sk-A\n"


def test_qwen_switch_rewrites_settings_env_when_the_key_lives_there(tmp_path: Path) -> None:
    vault = _vault(tmp_path)
    settings = tmp_path / "home" / ".qwen" / "settings.json"
    _write(settings, json.dumps({
        "theme": "dark",
        "env": {"DASHSCOPE_API_KEY": "sk-A", "HTTP_PROXY": "http://p"},
        "mcpServers": {"x": {"url": "u"}},
    }))
    vault.write_slot("qwen", "b", LiveCredentials(secret='{"DASHSCOPE_API_KEY": "sk-B"}'))

    vault.switch("qwen", DEFAULT_SLOT_ID, "b")

    after = json.loads(settings.read_text(encoding="utf-8"))
    assert after["env"] == {"HTTP_PROXY": "http://p", "DASHSCOPE_API_KEY": "sk-B"}
    assert after["theme"] == "dark" and after["mcpServers"] == {"x": {"url": "u"}}
    assert not (tmp_path / "home" / ".qwen" / ".env").exists()


def test_qwen_dotenv_outranks_settings_like_the_cli(tmp_path: Path) -> None:
    vault = _vault(tmp_path)
    _write(tmp_path / "home" / ".qwen" / ".env", "DASHSCOPE_API_KEY=from-env\n")
    _write(tmp_path / "home" / ".qwen" / "settings.json", json.dumps({"env": {"DASHSCOPE_API_KEY": "from-settings"}}))
    assert json.loads(vault.read_live("qwen").secret) == {"DASHSCOPE_API_KEY": "from-env"}


def test_qwen_identity_and_rejects_garbage_portion(tmp_path: Path) -> None:
    vault = _vault(tmp_path)
    assert vault.identity("qwen") == {"email": None, "signedIn": False}
    vault.write_slot("qwen", "b", LiveCredentials(secret='{"DASHSCOPE_API_KEY": "sk"}'))
    assert vault.identity("qwen", "b") == {"email": None, "signedIn": True}
    with pytest.raises(CredentialVaultError):
        vault.write_slot("qwen", "c", LiveCredentials(secret='{"NOT_A_QWEN_VAR": "x"}'))


@pytest.mark.parametrize("agent_key,live_rel,live_doc,scope,incoming", [
    ("opencode", ".local/share/opencode/auth.json", OPENCODE_LIVE, "anthropic",
     '{"type":"oauth","access":"B","refresh":"BR"}'),
    ("pi", ".pi/agent/auth.json", PI_LIVE, "openai-codex",
     '{"type":"oauth","access":"B","refresh":"BR"}'),
    ("muse", ".config/muse/auth.json", MUSE_LIVE, "meta",
     '{"mechanism":"oauth","access_token":"B","expires_at":1}'),
    ("kilo", ".local/share/kilo/auth.json", {"kilo": {"type": "api", "key": "A"}, "anthropic": {"type": "api", "key": "x"}}, "kilo",
     '{"type":"api","key":"B"}'),
])
def test_slot_identity_stays_signed_in_across_default_round_trip(
    tmp_path: Path, agent_key: str, live_rel: str, live_doc: dict, scope: str, incoming: str,
    monkeypatch,
) -> None:
    """The identity parser of every compound vendor reads the bare entry a
    scoped slot holds — not only the whole file — so a profile does not
    turn 'unknown' the moment its credential has been parked once."""
    for var in ("XDG_DATA_HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "MUSE_AUTH_PATH"):
        monkeypatch.delenv(var, raising=False)
    vault = _vault(tmp_path)
    _write(tmp_path / "home" / live_rel, json.dumps(live_doc))
    vault.write_slot(agent_key, "b", LiveCredentials(secret=incoming), scope=scope)
    assert vault.identity(agent_key, "b", scope=scope)["signedIn"] is True
    assert vault.identity(agent_key, scope=scope)["signedIn"] is True

    vault.switch(agent_key, DEFAULT_SLOT_ID, "b", scope=scope)
    assert vault.identity(agent_key, scope=scope)["signedIn"] is True            # live = B
    assert vault.identity(agent_key, DEFAULT_SLOT_ID, scope=scope)["signedIn"] is True  # parked A

    vault.switch(agent_key, "b", DEFAULT_SLOT_ID, scope=scope)
    assert vault.identity(agent_key, scope=scope)["signedIn"] is True            # live = A again
    assert vault.identity(agent_key, "b", scope=scope)["signedIn"] is True       # parked B


# ── aider: one provider key line in ~/.aider/oauth-keys.env ──────────────


def test_aider_switch_rewrites_only_that_providers_line(tmp_path: Path) -> None:
    vault = _vault(tmp_path)
    keys = tmp_path / "home" / ".aider" / "oauth-keys.env"
    _write(keys, 'OPENROUTER_API_KEY="or-A"\nANTHROPIC_API_KEY=ant-keep\n')
    vault.write_slot("aider", "b", LiveCredentials(secret='{"OPENROUTER_API_KEY": "or-B"}'), scope="openrouter")

    vault.switch("aider", DEFAULT_SLOT_ID, "b", scope="openrouter")
    assert keys.read_text(encoding="utf-8") == "ANTHROPIC_API_KEY=ant-keep\nOPENROUTER_API_KEY=or-B\n"
    assert json.loads(vault.read_slot("aider", DEFAULT_SLOT_ID, scope="openrouter").secret) == {"OPENROUTER_API_KEY": "or-A"}
    assert vault.identity("aider", scope="openrouter") == {"email": None, "signedIn": True}
    assert vault.identity("aider", scope="anthropic") == {"email": None, "signedIn": True}
    assert vault.identity("aider", scope="gemini") == {"email": None, "signedIn": False}

    vault.switch("aider", "b", DEFAULT_SLOT_ID, scope="openrouter")
    assert keys.read_text(encoding="utf-8") == "ANTHROPIC_API_KEY=ant-keep\nOPENROUTER_API_KEY=or-A\n"


def test_aider_is_manual_with_lossy_resume_and_rejects_foreign_scope(tmp_path: Path) -> None:
    from agent_team_backend.cli_vendors.registry import VENDORS

    switch = VENDORS["aider"].account_switch
    assert switch.method == "manual" and switch.resume == "lossy"
    vault = _vault(tmp_path)
    with pytest.raises(CredentialVaultError):
        vault.read_live("aider", scope="xai")
    with pytest.raises(CredentialVaultError):
        vault.write_slot("aider", "x", LiveCredentials(secret='{"OPENAI_API_KEY": "k"}'), scope="anthropic")


def test_identity_without_a_scope_means_any_provider_signed_in(tmp_path: Path, monkeypatch) -> None:
    """``identity("opencode")`` with no scope is the CLI-level question the
    spawn-time signed-out advisory asks: true when any declared provider
    entry exists, false on an empty/missing file — never a false "signed
    out" because no provider was named."""
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    vault = _vault(tmp_path)
    assert vault.identity("opencode") == {"email": None, "signedIn": False}
    _write(tmp_path / "home" / ".local/share/opencode/auth.json", json.dumps({"some-byok": {"type": "api", "key": "k"}}))
    assert vault.identity("opencode")["signedIn"] is False  # not a declared scope
    _write(tmp_path / "home" / ".local/share/opencode/auth.json", json.dumps(OPENCODE_LIVE))
    assert vault.identity("opencode")["signedIn"] is True
    vault.write_slot("opencode", "b", LiveCredentials(secret='{"type":"api","key":"x"}'), scope="google")
    assert vault.identity("opencode", "b")["signedIn"] is True
    assert vault.identity("opencode", "nope")["signedIn"] is False
