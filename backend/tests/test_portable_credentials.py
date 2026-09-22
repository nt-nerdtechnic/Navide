"""Portable credentials: classification is fail-closed, the plaintext never
shows up anywhere but the vault and the spawn env, and the injection plan
matches what ``terminals.create`` consumes.

Every vendor here is synthetic: the tests register throwaway specs in the
registry so they exercise the shared path without asserting anything about
a real vendor's interface (those declarations are a separate decision).
"""

from __future__ import annotations

import base64
import json
import logging
import os
from pathlib import Path

import pytest

from agent_team_backend import app, portable_credentials as pc
from agent_team_backend.cli_vendors import registry
from agent_team_backend.cli_vendors.base import (
    PortableCredential,
    SlotKind,
    VendorSpec,
)

TOKEN = "sk-synthetic-0123456789abcdefABCDEF"


def _register(monkeypatch, spec: VendorSpec) -> VendorSpec:
    monkeypatch.setitem(registry.VENDORS, spec.key, spec)
    return spec


@pytest.fixture
def portable_vendor(monkeypatch) -> VendorSpec:
    """A vendor with a full declaration: companions, conflicts, a shadowing
    file and a value shape."""
    return _register(monkeypatch, VendorSpec(
        key="zz_portable",
        label="Portable",
        portable_credential=PortableCredential(
            env="ZZ_TOKEN",
            env_extra=(("ZZ_BASE_URL", "https://example.invalid/v1"),),
            # ZZ_TOKEN itself and a companion are listed on purpose: a
            # declaration must not be able to remove what it just set.
            env_remove=("ZZ_API_KEY", "ZZ_TOKEN", "ZZ_BASE_URL", "ZZ_API_KEY"),
            shadowing_files=((".zz", "auth.json"), (".zz", "session")),
            shadowing_settings=(
                ("home", (".zz", "settings.json"), ("apiKeyHelper",)),
                ("home", (".zz", "settings.json"), ("env", "ZZ_BASE_URL")),
                ("cwd", (".zz", "settings.local.json"), ("env", "ZZ_API_KEY")),
            ),
            value_pattern=r"sk-[A-Za-z0-9-]{8,}",
            obtain_command="zz setup-token",
            docs_url="https://example.invalid/docs",
        ),
    ))


@pytest.fixture
def plain_vendor(monkeypatch) -> VendorSpec:
    """A vendor that declares nothing credential-related."""
    return _register(monkeypatch, VendorSpec(key="zz_plain", label="Plain"))


# ---- classify_slot ---------------------------------------------------------

@pytest.mark.parametrize("secret", [None, "", "   ", "\n\t"])
def test_classify_empty_slot(portable_vendor, secret):
    assert pc.classify_slot(portable_vendor.key, secret) is SlotKind.EMPTY


def test_classify_unknown_vendor_is_unknown():
    assert pc.classify_slot("zz_nobody", '{"token": "x"}') is SlotKind.UNKNOWN


def test_classify_vendor_without_classifier_is_unknown(plain_vendor):
    assert pc.classify_slot(plain_vendor.key, '{"token": "x"}') is SlotKind.UNKNOWN


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        (SlotKind.API_KEY, SlotKind.API_KEY),
        (SlotKind.OAUTH, SlotKind.OAUTH),
        # A classifier may answer with the plain vocabulary string.
        ("api_key", SlotKind.API_KEY),
        ("oauth", SlotKind.OAUTH),
    ],
)
def test_classify_passes_through_positive_answers(monkeypatch, answer, expected):
    spec = _register(monkeypatch, VendorSpec(
        key="zz_cls", label="Cls", classify_secret=lambda secret: answer))
    assert pc.classify_slot(spec.key, '{"k": 1}') is expected


@pytest.mark.parametrize(
    "answer",
    [SlotKind.EMPTY, SlotKind.UNKNOWN, "unknown", "empty", "bearer", None, 1, ""],
)
def test_classify_off_vocabulary_answer_is_unknown(monkeypatch, answer):
    """The shared side trusts a vendor for exactly two answers; anything
    else — including a vendor claiming EMPTY for a non-empty secret — is a
    refusal."""
    spec = _register(monkeypatch, VendorSpec(
        key="zz_cls", label="Cls", classify_secret=lambda secret: answer))
    assert pc.classify_slot(spec.key, '{"k": 1}') is SlotKind.UNKNOWN


def test_classify_raising_classifier_is_unknown(monkeypatch, caplog):
    def boom(secret):
        raise RuntimeError("cannot parse " + secret)

    spec = _register(monkeypatch, VendorSpec(
        key="zz_cls", label="Cls", classify_secret=boom))
    with caplog.at_level(logging.WARNING, logger="agent_team_backend.portable_credentials"):
        assert pc.classify_slot(spec.key, "SECRET-BODY") is SlotKind.UNKNOWN
    assert "SECRET-BODY" not in caplog.text


def test_classifier_sees_the_secret_text_verbatim(monkeypatch):
    seen: list[str] = []

    def classify(secret):
        seen.append(secret)
        return SlotKind.OAUTH

    spec = _register(monkeypatch, VendorSpec(
        key="zz_cls", label="Cls", classify_secret=classify))
    body = json.dumps({"claudeAiOauth": {"accessToken": "a"}})
    assert pc.classify_slot(spec.key, body) is SlotKind.OAUTH
    assert seen == [body]


# ---- validation ------------------------------------------------------------

def test_validate_strips_surrounding_whitespace(portable_vendor):
    assert pc.validate_value(portable_vendor.key, f"  {TOKEN}\n") == TOKEN


@pytest.mark.parametrize(
    "value",
    [
        "",
        "   \n",
        f"{TOKEN}\nsecond-line",
        f"{TOKEN}\x07",
        "sk-short",                 # off the declared shape
        "not-a-key-at-all-000000",  # off the declared shape
        "sk-" + "a" * 9000,         # absurd length
    ],
)
def test_validate_rejects(portable_vendor, value):
    with pytest.raises(pc.PortableCredentialError):
        pc.validate_value(portable_vendor.key, value)


def test_validate_refuses_vendor_without_interface(plain_vendor):
    with pytest.raises(pc.PortableCredentialError, match="no portable credential"):
        pc.validate_value(plain_vendor.key, TOKEN)


def test_validate_refuses_unregistered_vendor():
    with pytest.raises(pc.PortableCredentialError):
        pc.validate_value("zz_nobody", TOKEN)


def test_pattern_is_a_full_match_not_a_prefix(monkeypatch):
    spec = _register(monkeypatch, VendorSpec(
        key="zz_pat", label="Pat",
        portable_credential=PortableCredential(env="P", value_pattern=r"sk-[a-z]+")))
    assert pc.validate_value(spec.key, "sk-abc") == "sk-abc"
    with pytest.raises(pc.PortableCredentialError):
        pc.validate_value(spec.key, "sk-abc; rm -rf /")


def test_no_pattern_accepts_any_single_line(monkeypatch):
    spec = _register(monkeypatch, VendorSpec(
        key="zz_any", label="Any", portable_credential=PortableCredential(env="P")))
    assert pc.validate_value(spec.key, "ghp_anything goes here") == "ghp_anything goes here"



# ---- storage ---------------------------------------------------------------

@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    """The KV document lives in navide.db, a process-wide singleton opened at
    import; point it at a fresh file so tests never see each other's (or the
    developer's) entries. The vault is already per-test (conftest)."""
    from agent_team_backend.db import Database

    monkeypatch.setattr(app, "database", Database(tmp_path / "navide.db"))
    pc.clear_memory()
    yield
    pc.clear_memory()


def _kv_doc() -> dict:
    return app.database.kv_get(pc.KV_KEY) or {}


def test_store_describe_forget_round_trip(portable_vendor):
    before = pc.describe(portable_vendor.key, "default")
    assert before["configured"] is False and before["enabled"] is False
    assert before["updatedAt"] is None
    assert before["env"] == "ZZ_TOKEN" and before["kind"] == "api_key"
    assert before["quotaVerified"] is False
    assert before["obtainCommand"] == "zz setup-token"
    assert before["keyStorage"] in ("keychain", "dpapi", "file")

    after = pc.store(portable_vendor.key, "default", f"{TOKEN}\n")
    assert after["configured"] is True and after["enabled"] is True
    assert isinstance(after["updatedAt"], str) and after["updatedAt"].endswith("Z")
    assert pc.list_stored() == [(portable_vendor.key, "default")]
    assert pc.read_secret(portable_vendor.key, "default") == TOKEN

    pc.forget(portable_vendor.key, "default")
    assert pc.describe(portable_vendor.key, "default")["configured"] is False
    assert pc.list_stored() == []
    assert pc.read_secret(portable_vendor.key, "default") is None
    assert pc.spawn_env(portable_vendor.key) is None


def test_forget_missing_entry_is_a_noop(portable_vendor):
    pc.forget(portable_vendor.key, "default")
    assert pc.list_stored() == []


def test_describe_and_list_never_carry_the_value(portable_vendor):
    pc.store(portable_vendor.key, "default", TOKEN)
    assert TOKEN not in json.dumps(pc.describe(portable_vendor.key, "default"))
    assert TOKEN not in json.dumps(pc.describe_all())
    assert "value" not in pc.describe(portable_vendor.key, "default")
    assert list(pc.describe_all()) == ["zz_portable/default"]


def test_value_is_ciphertext_at_rest_and_key_is_in_the_vault(portable_vendor):
    """Nothing on disk holds the value: the KV document carries AES-GCM
    ciphertext, the wrapping key sits in the app-secret store (Keychain on
    macOS, a private file elsewhere), and the OAuth slot files are untouched."""
    pc.store(portable_vendor.key, "work", TOKEN)
    doc = _kv_doc()
    assert TOKEN not in json.dumps(doc)
    item = doc["items"]["zz_portable/work"]
    assert set(item) == {"agentKey", "slotId", "kind", "updatedAt", "ciphertext"}
    assert doc["selected"] == {"zz_portable": "work"}
    key = app.credential_vault.read_app_secret(pc.WRAPPING_KEY_SECRET)
    assert key and len(base64.b64decode(key)) == 32
    assert TOKEN not in key
    assert not app.credential_vault.slot_dir(portable_vendor.key, "work").exists()
    # And the old per-entry app secret is not used at all.
    assert app.credential_vault.read_app_secret(
        "navide-portable-credential/zz_portable/work") is None


def test_ciphertext_is_bound_to_agent_and_slot(portable_vendor):
    """Moving a record to another slot must not open: the AAD binds it."""
    pc.store(portable_vendor.key, "a", TOKEN)
    doc = _kv_doc()
    moved = dict(doc["items"]["zz_portable/a"], slotId="b")
    doc["items"]["zz_portable/b"] = moved
    app.database.kv_set(pc.KV_KEY, doc, now=0)
    assert pc.read_secret(portable_vendor.key, "a") == TOKEN
    assert pc.read_secret(portable_vendor.key, "b") is None
    pc.set_enabled(portable_vendor.key, "b", True)
    with pytest.raises(pc.PortableCredentialUnavailable) as raised:
        pc.spawn_env(portable_vendor.key)
    assert raised.value.reason == "corrupt" and raised.value.slot_id == "b"
    assert TOKEN not in str(raised.value)


def test_wrapping_key_is_minted_once_and_survives_cache_clear(portable_vendor):
    pc.store(portable_vendor.key, "a", TOKEN)
    first = app.credential_vault.read_app_secret(pc.WRAPPING_KEY_SECRET)
    pc.clear_memory()
    pc.store(portable_vendor.key, "b", TOKEN + "b")
    assert app.credential_vault.read_app_secret(pc.WRAPPING_KEY_SECRET) == first
    pc.clear_memory()
    assert pc.read_secret(portable_vendor.key, "a") == TOKEN
    assert pc.read_secret(portable_vendor.key, "b") == TOKEN + "b"


def test_lost_wrapping_key_reads_as_corrupt_not_as_absent(portable_vendor):
    pc.store(portable_vendor.key, "a", TOKEN)
    app.credential_vault.write_app_secret(pc.WRAPPING_KEY_SECRET, None)
    pc.clear_memory()
    assert pc.describe(portable_vendor.key, "a")["configured"] is True
    assert pc.read_secret(portable_vendor.key, "a") is None
    with pytest.raises(pc.PortableCredentialUnavailable) as raised:
        pc.spawn_env(portable_vendor.key)
    assert raised.value.reason == "corrupt"


def test_selection_is_one_slot_per_agent(portable_vendor):
    """A paste selects its slot; selecting another moves the agent over;
    removing the selected one goes back to the CLI's own login even though
    the other slot is still stored."""
    pc.store(portable_vendor.key, "a", TOKEN)
    assert pc.selected_slot(portable_vendor.key) == "a"
    pc.store(portable_vendor.key, "b", TOKEN + "b")
    assert pc.selected_slot(portable_vendor.key) == "b"
    assert pc.spawn_env(portable_vendor.key).env["ZZ_TOKEN"] == TOKEN + "b"
    assert pc.describe(portable_vendor.key, "a")["enabled"] is False
    assert pc.describe(portable_vendor.key, "b")["enabled"] is True

    pc.set_enabled(portable_vendor.key, "a", True)
    assert pc.spawn_env(portable_vendor.key).env["ZZ_TOKEN"] == TOKEN
    assert pc.describe(portable_vendor.key, "b")["enabled"] is False
    # Deselecting a slot that is not the selected one changes nothing.
    pc.set_enabled(portable_vendor.key, "b", False)
    assert pc.selected_slot(portable_vendor.key) == "a"

    pc.forget(portable_vendor.key, "a")
    assert pc.selected_slot(portable_vendor.key) is None
    assert pc.spawn_env(portable_vendor.key) is None
    assert pc.read_secret(portable_vendor.key, "b") == TOKEN + "b"


def test_selection_does_not_touch_the_native_profiles_or_files(portable_vendor):
    """Choosing a portable credential is not an account switch: no profile
    default changes and no slot directory or live file is written."""
    before = app.cli_profiles_store.list()
    pc.store(portable_vendor.key, "a", TOKEN)
    pc.set_enabled(portable_vendor.key, "a", True)
    assert app.cli_profiles_store.list() == before
    assert not app.credential_vault.slot_dir(portable_vendor.key, "a").exists()
    home = Path(app.credential_vault._real_home)
    assert not home.exists() or not any(home.iterdir())


def test_store_rejects_before_touching_the_store(portable_vendor):
    with pytest.raises(pc.PortableCredentialError):
        pc.store(portable_vendor.key, "default", "bad value\nwith newline")
    assert pc.describe(portable_vendor.key, "default")["configured"] is False
    assert app.credential_vault.read_app_secret(pc.WRAPPING_KEY_SECRET) is None


def test_store_refuses_vendor_without_interface(plain_vendor):
    with pytest.raises(pc.PortableCredentialError):
        pc.store(plain_vendor.key, "default", TOKEN)
    with pytest.raises(pc.PortableCredentialError):
        pc.describe(plain_vendor.key, "default")


@pytest.mark.parametrize("slot_id", ["", "../x", "a/b", "a b", ".hidden", "x" * 65, "ä", "__other__"])
def test_slot_id_must_be_a_profile_id_or_the_reserved_default(portable_vendor, slot_id):
    with pytest.raises(pc.PortableCredentialError, match="slot id"):
        pc.store(portable_vendor.key, slot_id, TOKEN)


def test_reserved_default_slot_is_accepted(portable_vendor):
    pc.store(portable_vendor.key, pc.DEFAULT_SLOT_ID, TOKEN)
    assert pc.list_stored() == [(portable_vendor.key, "__default__")]
    assert pc.selected_slot(portable_vendor.key) == "__default__"
    assert pc.spawn_env(portable_vendor.key).env["ZZ_TOKEN"] == TOKEN


def test_set_enabled_records_intent_without_touching_the_value(portable_vendor):
    pc.store(portable_vendor.key, "default", TOKEN)
    before = _kv_doc()["items"]["zz_portable/default"]["ciphertext"]
    off = pc.set_enabled(portable_vendor.key, "default", False)
    assert off["configured"] is True and off["enabled"] is False
    assert _kv_doc()["items"]["zz_portable/default"]["ciphertext"] == before
    assert "enabled" not in _kv_doc()["items"]["zz_portable/default"]
    # Not selected: the spawn proceeds on the CLI's own login.
    assert pc.spawn_env(portable_vendor.key) is None
    assert pc.read_secret(portable_vendor.key, "default") == TOKEN
    on = pc.set_enabled(portable_vendor.key, "default", True)
    assert on["enabled"] is True
    assert pc.spawn_env(portable_vendor.key).active


def test_set_enabled_needs_a_stored_entry(portable_vendor):
    with pytest.raises(pc.PortableCredentialError):
        pc.set_enabled(portable_vendor.key, "default", True)


def test_store_never_writes_under_the_real_home(portable_vendor):
    home = Path(app.credential_vault._real_home)
    pc.store(portable_vendor.key, "default", TOKEN)
    for path in home.rglob("*") if home.exists() else ():
        if path.is_file():
            assert TOKEN not in path.read_text(errors="replace")


def test_store_spawn_forget_do_not_log_the_value(portable_vendor, caplog):
    with caplog.at_level(logging.DEBUG):
        pc.store(portable_vendor.key, "default", TOKEN)
        pc.spawn_env(portable_vendor.key)
        pc.forget(portable_vendor.key, "default")
    assert TOKEN not in caplog.text
    assert "zz_portable/default" in caplog.text


def test_malformed_document_entries_are_ignored(portable_vendor):
    app.database.kv_set(pc.KV_KEY, {
        "items": {"zz_portable/x": "junk", "zz_portable/y": {"kind": "api_key"}},
        "selected": {"zz_portable": "y", "other": 3},
    }, now=0)
    assert pc.list_stored() == []
    assert pc.describe(portable_vendor.key, "x")["configured"] is False
    assert pc.selected_slot("other") is None
    # A selected slot that has lost its ciphertext (and has no imported
    # copy) is refused, not skipped: the user asked for this credential.
    with pytest.raises(pc.PortableCredentialUnavailable) as raised:
        pc.spawn_env(portable_vendor.key)
    assert raised.value.reason == "missing" and raised.value.slot_id == "y"


# ---- sync hooks ------------------------------------------------------------

@pytest.fixture
def sync_hooks(monkeypatch):
    from agent_team_backend import sync_scopes

    calls: list[tuple] = []
    imported: dict[tuple[str, str], str] = {}
    monkeypatch.setattr(sync_scopes, "credential_saved",
                        lambda a, s: calls.append(("saved", a, s)), raising=False)
    monkeypatch.setattr(sync_scopes, "forget_credential",
                        lambda a, s: calls.append(("forget", a, s)), raising=False)
    monkeypatch.setattr(sync_scopes, "imported_credential",
                        lambda a, s: imported.get((a, s)), raising=False)
    monkeypatch.setattr(sync_scopes, "imported_credentials",
                        lambda: [{"agentKey": a, "slotId": s, "available": True,
                                  "updatedAt": "2026-09-16T00:00:00Z"} for a, s in imported],
                        raising=False)
    return calls, imported


def test_store_does_not_notify_sync_itself_forget_does(portable_vendor, sync_hooks):
    """store() runs off the loop; the saved notification belongs to the
    async caller (notify_saved) because sync schedules a loop task from it."""
    calls, _ = sync_hooks
    pc.store(portable_vendor.key, "default", TOKEN)
    assert calls == []
    pc.notify_saved(portable_vendor.key, "default")
    pc.forget(portable_vendor.key, "default")
    assert calls == [("saved", "zz_portable", "default"), ("forget", "zz_portable", "default")]


def test_forget_can_skip_the_sync_notification(portable_vendor, sync_hooks):
    calls, _ = sync_hooks
    pc.store(portable_vendor.key, "default", TOKEN)
    pc.forget(portable_vendor.key, "default", notify_sync=False)
    assert calls == []


def test_failing_sync_hook_never_blocks_a_save(portable_vendor, monkeypatch, caplog):
    from agent_team_backend import sync_scopes

    def boom(a, s):
        raise RuntimeError("sync is down")

    monkeypatch.setattr(sync_scopes, "credential_saved", boom, raising=False)
    monkeypatch.setattr(sync_scopes, "forget_credential", boom, raising=False)
    with caplog.at_level(logging.WARNING):
        assert pc.store(portable_vendor.key, "default", TOKEN)["configured"] is True
        pc.notify_saved(portable_vendor.key, "default")
        pc.forget(portable_vendor.key, "default")
    assert "sync is down" in caplog.text and TOKEN not in caplog.text
    assert pc.list_stored() == []


def test_failing_imported_lookup_refuses_the_spawn(portable_vendor, monkeypatch):
    """Sync may hold a selected credential it cannot open right now; that
    is not "nothing selected" and must not start the pane on the native
    login."""
    from agent_team_backend import sync_scopes

    def boom(a, s):
        raise RuntimeError("account key locked")

    monkeypatch.setattr(sync_scopes, "imported_credential", boom, raising=False)
    app.database.kv_set(pc.KV_KEY, {"items": {}, "selected": {"zz_portable": "default"}}, now=0)
    with pytest.raises(pc.PortableCredentialUnavailable) as raised:
        pc.spawn_env(portable_vendor.key)
    assert raised.value.reason == "import_failed"


def test_concurrent_first_saves_share_one_wrapping_key(portable_vendor):
    """Two first saves racing must not each mint a key: the loser's
    ciphertext would never open again. Every entry opens afterwards and
    every entry is present (the document read-modify-write is serialised)."""
    import threading

    errors: list[BaseException] = []

    def save(i: int) -> None:
        try:
            pc.store(portable_vendor.key, f"slot{i}", f"{TOKEN}{i}")
        except BaseException as err:  # noqa: BLE001
            errors.append(err)

    threads = [threading.Thread(target=save, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert sorted(pc.list_stored()) == sorted((portable_vendor.key, f"slot{i}") for i in range(8))
    pc.clear_memory()
    for i in range(8):
        assert pc.read_secret(portable_vendor.key, f"slot{i}") == f"{TOKEN}{i}"


def test_imported_entry_is_listed_selectable_and_used(portable_vendor, sync_hooks):
    """A credential synced from another machine has no local record and no
    local profile; it still shows up, can be selected, and runs the spawn."""
    _, imported = sync_hooks
    imported[("zz_portable", "work")] = "sk-imported-from-device-a"
    # Listed, but not selected until the user says so.
    listed = pc.describe_all()
    assert list(listed) == ["zz_portable/work"]
    assert listed["zz_portable/work"]["source"] == "imported"
    assert listed["zz_portable/work"]["configured"] is True
    assert listed["zz_portable/work"]["available"] is True
    assert listed["zz_portable/work"]["enabled"] is False
    assert listed["zz_portable/work"]["updatedAt"] == "2026-09-16T00:00:00Z"
    assert "sk-imported" not in json.dumps(listed)
    assert pc.spawn_env(portable_vendor.key) is None

    pc.set_enabled(portable_vendor.key, "work", True)
    plan = pc.spawn_env(portable_vendor.key)
    assert plan is not None and plan.env["ZZ_TOKEN"] == "sk-imported-from-device-a"
    # A local paste under the same slot takes precedence over the import.
    pc.store(portable_vendor.key, "work", TOKEN)
    assert pc.describe(portable_vendor.key, "work")["source"] == "local"
    assert pc.spawn_env(portable_vendor.key).env["ZZ_TOKEN"] == TOKEN
    # The imported value is never written down.
    assert "sk-imported" not in json.dumps(_kv_doc())
    # The sync adapter retiring the local paste keeps the selection, and the
    # imported copy is served again.
    pc.forget(portable_vendor.key, "work", notify_sync=False)
    assert pc.selected_slot(portable_vendor.key) == "work"
    assert pc.spawn_env(portable_vendor.key).env["ZZ_TOKEN"] == "sk-imported-from-device-a"
    assert pc.read_secret(portable_vendor.key, "work") is None


def test_selecting_a_slot_that_exists_nowhere_is_refused(portable_vendor, sync_hooks):
    with pytest.raises(pc.PortableCredentialError):
        pc.set_enabled(portable_vendor.key, "ghost", True)
    assert pc.selected_slot(portable_vendor.key) is None


def test_unavailable_imported_entry_is_listed_but_not_selectable(portable_vendor, monkeypatch):
    from agent_team_backend import sync_scopes

    monkeypatch.setattr(sync_scopes, "imported_credentials",
                        lambda: [{"agentKey": "zz_portable", "slotId": "work",
                                  "available": False, "updatedAt": None}], raising=False)
    listed = pc.describe_all()
    assert listed["zz_portable/work"]["available"] is False
    assert listed["zz_portable/work"]["configured"] is True
    with pytest.raises(pc.PortableCredentialError):
        pc.set_enabled(portable_vendor.key, "work", True)


def test_failing_imported_listing_hides_nothing_local(portable_vendor, monkeypatch, caplog):
    from agent_team_backend import sync_scopes

    def boom():
        raise RuntimeError("no account key")

    monkeypatch.setattr(sync_scopes, "imported_credentials", boom, raising=False)
    pc.store(portable_vendor.key, "default", TOKEN)
    with caplog.at_level(logging.WARNING):
        listed = pc.describe_all()
    assert list(listed) == ["zz_portable/default"]
    assert "no account key" in caplog.text and TOKEN not in caplog.text


def test_imported_value_is_shadow_checked_too(portable_vendor, sync_hooks, tmp_path):
    _, imported = sync_hooks
    imported[("zz_portable", "default")] = "sk-imported-from-device-a"
    pc.set_enabled(portable_vendor.key, "default", True)
    home = tmp_path / "home"
    (home / ".zz").mkdir(parents=True)
    (home / ".zz" / "auth.json").write_text("{}")
    with pytest.raises(pc.PortableCredentialUnavailable) as raised:
        pc.spawn_env(portable_vendor.key, home=home)
    assert raised.value.reason == "shadowed"
    assert raised.value.shadowed_by == (".zz/auth.json",)


# ---- injection plan --------------------------------------------------------

def test_plan_sets_env_and_companions(portable_vendor):
    plan = pc.plan_injection(portable_vendor.key, TOKEN)
    assert plan.env == {
        "ZZ_TOKEN": TOKEN,
        "ZZ_BASE_URL": "https://example.invalid/v1",
    }


def test_plan_removes_conflicts_but_never_its_own_variables(portable_vendor):
    plan = pc.plan_injection(portable_vendor.key, TOKEN)
    assert plan.env_remove == ("ZZ_API_KEY",)


def test_plan_is_empty_while_a_shadowing_file_is_present(portable_vendor, tmp_path):
    """Fail closed: a session file the CLI ranks above the variable means
    nothing is injected — the value would be ignored, or used under the
    wrong identity — and the report names the file."""
    home = tmp_path / "home"
    (home / ".zz").mkdir(parents=True)
    (home / ".zz" / "auth.json").write_text("{}")
    unshadowed = pc.plan_injection(portable_vendor.key, TOKEN)
    assert unshadowed.shadowed_by == () and unshadowed.active

    plan = pc.plan_injection(portable_vendor.key, TOKEN, home=home)
    assert plan.shadowed_by == (".zz/auth.json",)
    assert plan.env == {} and plan.env_remove == ()
    assert not plan.active
    assert TOKEN not in repr(plan)
    assert pc.describe(portable_vendor.key, "default", home=home)["shadowedBy"] == [
        ".zz/auth.json"
    ]


def _settings(root: Path, *parts: str, body) -> None:
    path = root.joinpath(*parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body if isinstance(body, str) else json.dumps(body))


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"apiKeyHelper": "/usr/local/bin/get-key"}, "home:.zz/settings.json:apiKeyHelper"),
        ({"env": {"ZZ_BASE_URL": "https://proxy.invalid"}}, "home:.zz/settings.json:env.ZZ_BASE_URL"),
        ("{not json", "home:.zz/settings.json:apiKeyHelper"),
    ],
)
def test_plan_is_empty_while_a_setting_routes_auth_elsewhere(
    portable_vendor, tmp_path, body, expected
):
    """A key helper or a provider route in the CLI's own settings outranks
    the variable; an unparseable settings file cannot be shown not to, so it
    counts too."""
    home = tmp_path / "home"
    _settings(home, ".zz", "settings.json", body=body)
    plan = pc.plan_injection(portable_vendor.key, TOKEN, home=home)
    assert expected in plan.shadowed_by
    assert plan.env == {} and not plan.active


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"apiKeyHelper": ""},
        {"apiKeyHelper": None},
        {"env": {}},
        {"env": {"ZZ_BASE_URL": ""}},
        {"env": {"OTHER": "x"}},
        {"model": "zz-large"},
    ],
)
def test_settings_without_the_routing_keys_do_not_shadow(portable_vendor, tmp_path, body):
    home = tmp_path / "home"
    _settings(home, ".zz", "settings.json", body=body)
    plan = pc.plan_injection(portable_vendor.key, TOKEN, home=home)
    assert plan.shadowed_by == () and plan.active


def test_project_settings_are_checked_under_cwd_not_home(portable_vendor, tmp_path):
    home, cwd = tmp_path / "home", tmp_path / "repo"
    _settings(cwd, ".zz", "settings.local.json", body={"env": {"ZZ_API_KEY": "sk-x"}})
    assert pc.plan_injection(portable_vendor.key, TOKEN, home=home).active
    plan = pc.plan_injection(portable_vendor.key, TOKEN, home=home, cwd=cwd)
    assert plan.shadowed_by == ("cwd:.zz/settings.local.json:env.ZZ_API_KEY",)
    assert not plan.active



def test_plan_repr_redacts_the_value(portable_vendor):
    plan = pc.plan_injection(portable_vendor.key, TOKEN)
    assert TOKEN not in repr(plan)
    assert TOKEN not in str(plan)
    assert "ZZ_API_KEY" in repr(plan)




def test_plan_matches_terminals_create_contract(portable_vendor, monkeypatch):
    """``terminals.create`` merges ``env`` over the inherited environment
    and then pops ``env_remove``; the plan has to survive that in the
    order the spawn applies it — the conflicting variable inherited from the
    user's shell must be gone, and the injected one must win."""
    monkeypatch.setenv("ZZ_API_KEY", "inherited-key-that-outranks-the-token")
    monkeypatch.setenv("ZZ_TOKEN", "stale-inherited-token")
    plan = pc.plan_injection(portable_vendor.key, TOKEN)

    final_env = os.environ.copy()
    final_env.update(plan.env)
    for key in list(plan.env_remove):
        final_env.pop(key, None)

    assert final_env["ZZ_TOKEN"] == TOKEN
    assert final_env["ZZ_BASE_URL"] == "https://example.invalid/v1"
    assert "ZZ_API_KEY" not in final_env
    # The same tuple shape the login path already hands the spawn.
    env_set, env_remove = plan.env, list(plan.env_remove)
    assert isinstance(env_set, dict) and env_remove == ["ZZ_API_KEY"]


def test_spawn_env_none_for_vendor_without_interface(plain_vendor):
    assert pc.spawn_env(plain_vendor.key) is None


def test_spawn_env_reads_the_stored_value(portable_vendor):
    pc.store(portable_vendor.key, "default", TOKEN)
    plan = pc.spawn_env(portable_vendor.key)
    assert plan is not None and plan.active
    assert plan.env["ZZ_TOKEN"] == TOKEN
    assert plan.env_remove == ("ZZ_API_KEY",)


def test_spawn_env_refuses_a_shadowed_selection_without_logging_the_value(
    portable_vendor, tmp_path, caplog
):
    home = tmp_path / "home"
    (home / ".zz").mkdir(parents=True)
    (home / ".zz" / "session").write_text("")
    pc.store(portable_vendor.key, "default", TOKEN)
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(pc.PortableCredentialUnavailable) as raised:
            pc.spawn_env(portable_vendor.key, home=home)
    assert raised.value.reason == "shadowed"
    assert raised.value.shadowed_by == (".zz/session",)
    assert TOKEN not in str(raised.value) and TOKEN not in caplog.text


def test_managed_policy_root_is_resolved_from_the_platform(monkeypatch, tmp_path):
    from agent_team_backend import osplat

    managed = tmp_path / "policy"
    spec = _register(monkeypatch, VendorSpec(
        key="zz_managed", label="Managed",
        portable_credential=PortableCredential(
            env="ZZ_TOKEN",
            shadowing_settings=(("managed", ("managed-settings.json",), ("forceLoginMethod",)),),
            managed_roots=(("darwin", str(managed)), ("linux", str(managed)), ("win32", str(managed))),
        )))
    assert pc.managed_root(spec.portable_credential) == managed
    assert pc.plan_injection(spec.key, TOKEN).active
    _settings(managed, "managed-settings.json", body={"forceLoginMethod": "gateway"})
    plan = pc.plan_injection(spec.key, TOKEN)
    assert plan.shadowed_by == ("managed:managed-settings.json:forceLoginMethod",)
    assert not plan.active
    # The policy file is never touched.
    assert json.loads((managed / "managed-settings.json").read_text()) == {"forceLoginMethod": "gateway"}
    # A platform the vendor did not name has no managed root at all.
    monkeypatch.setattr(osplat, "platform_id", "plan9")
    assert pc.managed_root(spec.portable_credential) is None
    assert pc.plan_injection(spec.key, TOKEN).active


# ---- declaration schema ----------------------------------------------------

def test_registered_vendors_default_to_no_interface_and_unknown():
    """Nothing here decides which real vendor supports what: until a vendor
    declares an interface, storing is refused and every slot is UNKNOWN."""
    for key, spec in registry.VENDORS.items():
        if spec.portable_credential is None:
            with pytest.raises(pc.PortableCredentialError):
                pc.validate_value(key, TOKEN)
        if spec.classify_secret is None:
            assert pc.classify_slot(key, '{"any": "thing"}') is SlotKind.UNKNOWN


def test_declaration_is_immutable():
    declared = PortableCredential(env="X")
    with pytest.raises(AttributeError):
        declared.env = "Y"  # type: ignore[misc]
