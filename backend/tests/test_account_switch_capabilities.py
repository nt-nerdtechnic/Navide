"""The account-switch capability contract every vendor spec must honour.

``registry.account_capabilities()`` is what the switch transaction and the
accounts UI read; these tests pin its shape and the invariants a declaration
has to satisfy so a half-filled adapter fails here rather than at switch time.
"""

from __future__ import annotations

import json

import pytest

from agent_team_backend.cli_vendors.base import AccountSwitchSpec, auth_scope_for
from agent_team_backend.cli_vendors.registry import (
    VENDORS,
    account_capabilities,
    account_capability,
)

METHODS = {"hot", "restart", "manual"}
STORES = {"file", "compound-file", "keychain", "pointer", "env"}
EVIDENCE = {"live", "source", "docs"}
RESUME = {"native", "lossy", "none"}
PLATFORMS = {"darwin", "linux", "win32"}

CAPABILITY_KEYS = {
    "agentKey", "supported", "authScope", "method", "store", "evidence",
    "verifiedVersion", "platforms", "scopes", "hasExpiry", "hasIdentity",
    "resume", "todo", "loginCommand",
}


def test_every_registry_key_has_a_capability_row() -> None:
    caps = account_capabilities()
    assert list(caps) == list(VENDORS)
    for key, row in caps.items():
        assert set(row) == CAPABILITY_KEYS, key
        assert row["agentKey"] == key
    # JSON-safe: the row travels over the websocket as is.
    json.dumps(caps)


def test_unknown_key_is_none() -> None:
    assert account_capability("terminal") is None
    assert account_capability("") is None


@pytest.mark.parametrize("key", sorted(VENDORS))
def test_declaration_invariants(key: str) -> None:
    spec = VENDORS[key]
    row = account_capability(key)
    assert row is not None
    switch = spec.account_switch
    if switch is None:
        # Fail closed: nothing about the vendor is offered as switchable.
        assert row["supported"] is False
        assert row["method"] is None and row["store"] is None
        assert row["todo"]
        return
    assert isinstance(switch, AccountSwitchSpec)
    assert row["supported"] is True
    assert switch.method in METHODS
    assert switch.store in STORES
    assert switch.evidence in EVIDENCE
    assert switch.resume in RESUME
    assert switch.auth_scope
    assert switch.platforms and set(switch.platforms) <= PLATFORMS
    assert switch.verified_version, "evidence needs the version it came from"
    if switch.evidence != "live":
        assert switch.todo, f"{key}: unverified adapters must say what is missing"
    # A parked credential needs somewhere to live unless it only ever rides
    # the spawn environment.
    if switch.store != "env":
        assert spec.slot_file is not None, key
    if switch.store in ("compound-file", "pointer"):
        assert switch.extract is not None and switch.merge is not None, key
        assert switch.scopes, f"{key}: a compound store must name its scopes"
        assert len(set(switch.scopes)) == len(switch.scopes)
    else:
        assert switch.extract is None and switch.merge is None, key
        assert switch.scopes == (), key
    if switch.store == "keychain":
        assert switch.keychain_items, key
    else:
        assert switch.keychain_items == (), key
    # A vendor that cannot name the conversation it started cannot resume it.
    if not spec.supports_session_resume:
        assert switch.resume != "native", key
    assert row["scopes"] == list(switch.scopes)
    assert row["hasExpiry"] == (switch.expires_at is not None)


def test_auth_scope_for_is_canonical_per_pool() -> None:
    claude = VENDORS["claude"]
    assert auth_scope_for(claude) == "claude"
    assert auth_scope_for(claude, "anything") == "claude"
    from dataclasses import replace
    assert auth_scope_for(replace(VENDORS["mcode"], account_switch=None)) is None
    # Single-scope provider map: a legacy profile without the field and one
    # naming it are the SAME pool, and the __default__ side of a switch too.
    kilo = VENDORS["kilo"]
    assert auth_scope_for(kilo) == "kilo:kilo"
    assert auth_scope_for(kilo, "kilo") == "kilo:kilo"
    assert auth_scope_for(kilo, "anthropic") is None
    for key, spec in VENDORS.items():
        switch = spec.account_switch
        if switch is None:
            assert auth_scope_for(spec) is None, key
            continue
        if not switch.scopes:
            continue
        for scope in switch.scopes:
            assert auth_scope_for(spec, scope) == f"{switch.auth_scope}:{scope}", key
        assert auth_scope_for(spec, "no-such-provider") is None, key
        if len(switch.scopes) > 1:
            # Unknown scope is unknown — never the bare prefix.
            assert auth_scope_for(spec) is None, key


def test_original_five_keep_their_switch_method() -> None:
    """The methods the shipped vault relied on: only claude re-reads its
    credential in a running process; the others load it at startup."""
    assert VENDORS["claude"].account_switch.method == "hot"
    for key in ("codex", "kimi", "grok"):
        assert VENDORS[key].account_switch.method == "restart", key
        assert VENDORS[key].account_switch.store == "file", key
    # kilo's auth.json is a provider map: only its "kilo" entry is the
    # account, so a switch must leave the user's other providers alone.
    kilo = VENDORS["kilo"].account_switch
    assert kilo.method == "restart"
    assert kilo.store == "compound-file" and kilo.scopes == ("kilo",)


def test_switch_preflight_reports_why_a_swap_would_not_reach_the_pane() -> None:
    from agent_team_backend.cli_vendors.base import switch_preflight

    qwen = VENDORS["qwen"]
    ok = switch_preflight(qwen, env_names=["PATH", "HOME"], platform="darwin")
    assert ok == {"ok": True, "reason": None, "authScope": "qwen:coding-plan",
                  "method": "restart", "shadowedBy": []}
    shadowed = switch_preflight(qwen, env_names=["DASHSCOPE_API_KEY", "PATH"], platform="linux")
    assert shadowed["ok"] is False and shadowed["reason"] == "shadowed-by-env"
    assert shadowed["shadowedBy"] == ["DASHSCOPE_API_KEY"]
    # Names only ever go in; the answer never carries a value.
    assert "DASHSCOPE_API_KEY" not in shadowed["authScope"]

    # Multi-scope vendors need a provider scope; a spec with no adapter at
    # all is "unsupported" (none is left in the registry, so use a stub).
    from dataclasses import replace
    assert switch_preflight(replace(VENDORS["mcode"], account_switch=None), env_names=[])["reason"] == "unsupported"
    assert switch_preflight(VENDORS["mcode"], env_names=[])["reason"] == "unknown-scope"
    assert switch_preflight(VENDORS["aider"], env_names=[])["reason"] == "unknown-scope"
    assert switch_preflight(VENDORS["aider"], env_names=[], scope="openrouter")["ok"] is True
    unknown = switch_preflight(VENDORS["opencode"], env_names=[], scope="deepseek")
    assert unknown["reason"] == "unknown-scope" and unknown["authScope"] is None
    claude = switch_preflight(VENDORS["claude"], env_names=["ANTHROPIC_API_KEY"], platform="darwin")
    assert claude["reason"] == "shadowed-by-env" and claude["authScope"] == "claude"
    for key, spec in VENDORS.items():
        switch = spec.account_switch
        if switch is None:
            continue
        for platform in ("darwin", "linux", "win32"):
            row = switch_preflight(spec, env_names=[], scope=(switch.scopes or (None,))[0], platform=platform)
            assert (row["reason"] == "platform-unsupported") == (platform not in switch.platforms), (key, platform)


def test_quota_exhausted_patterns_mirror_the_frontend_spec() -> None:
    """The backend gate and the frontend detector must recognise the same
    text, or a cli-text report lands as text-did-not-match. Every declared
    source must compile, and it must not be a generic 429 / login matcher."""
    import re
    from pathlib import Path

    agents_dir = Path(__file__).resolve().parents[2] / "src/renderer/src/platform/plugin-shell/agents"
    for key, spec in VENDORS.items():
        patterns = spec.quota_exhausted_patterns
        for source in patterns:
            compiled = re.compile(source, re.I)
            for generic in ("rate limit", "429", "too many requests", "authentication failed", "login"):
                assert not compiled.search(generic), (key, source, generic)
        ts = agents_dir / f"{key}.ts"
        if not ts.exists():
            continue
        m = re.search(r"quotaExhausted:\s*\{\s*pattern:\s*/(.*?)/i", ts.read_text(encoding="utf-8"), re.S)
        if m is None:
            continue
        frontend = m.group(1)
        assert frontend in patterns, f"{key}: backend quota_exhausted_patterns lacks the frontend pattern {frontend!r}"


def test_droid_turn_detail_is_a_quota_pattern() -> None:
    import re

    patterns = [re.compile(p, re.I) for p in VENDORS["droid"].quota_exhausted_patterns]
    assert any(p.search("model_usage_exhausted") for p in patterns)
    assert not any(p.search("model_authentication_failed") for p in patterns)
    assert not any(p.search("rate_limited") for p in patterns)


def test_preflight_scopes_env_checks_to_the_panes_own_provider() -> None:
    from agent_team_backend.cli_vendors.base import switch_preflight

    opencode = VENDORS["opencode"]
    # Another provider's key must not block this provider's switch.
    assert switch_preflight(opencode, env_names=["OPENAI_API_KEY"], scope="anthropic", platform="darwin")["ok"] is True
    row = switch_preflight(opencode, env_names=["ANTHROPIC_API_KEY"], scope="anthropic", platform="darwin")
    assert row["reason"] == "credential-source-unknown" and row["shadowedBy"] == ["ANTHROPIC_API_KEY"]
    # codex: a known credential variable with unverified precedence.
    codex = switch_preflight(VENDORS["codex"], env_names=["CODEX_API_KEY"], platform="darwin")
    assert codex["reason"] == "credential-source-unknown"
    # kilo: single scope implied, its own key only.
    assert switch_preflight(VENDORS["kilo"], env_names=["KILO_API_KEY"], platform="linux")["reason"] == "credential-source-unknown"
    assert switch_preflight(VENDORS["kilo"], env_names=["ANTHROPIC_API_KEY"], platform="linux")["ok"] is True
    # pi: env never outranks the stored credential (auth/resolve.js).
    assert switch_preflight(VENDORS["pi"], env_names=["ANTHROPIC_API_KEY", "OPENAI_API_KEY"], scope="anthropic", platform="darwin")["ok"] is True
