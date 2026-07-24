"""CliProfilesStore CRUD + spawn-env planning (profiles_store.py)."""

from __future__ import annotations

import json
import os
import unicodedata
from pathlib import Path

import pytest

from agent_team_backend import profiles_store as profiles_mod
from agent_team_backend.profiles_store import (
    CliProfilesStore,
    build_spawn_plan,
    canonical_path_str,
)


def _store(tmp_path: Path) -> CliProfilesStore:
    return CliProfilesStore(
        path=tmp_path / "cli-profiles.json",
        profiles_root=tmp_path / "cli-profiles",
    )


# ---- registry CRUD ----


def test_create_and_list(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Work")

    assert profile["agentKey"] == "claude"
    assert profile["name"] == "Work"
    assert len(profile["id"]) == 8
    assert profile["createdAt"].endswith("Z")

    doc = store.list()
    assert doc["profiles"] == [profile]
    assert doc["defaults"] == {"claude": None, "codex": None, "kimi": None, "grok": None}
    assert store.get(profile["id"]) == profile
    # Registry file carries the schema version.
    on_disk = json.loads(store.path.read_text(encoding="utf-8"))
    assert on_disk["schemaVersion"] == 1


@pytest.mark.parametrize("agent_key", ["antigravity", "terminal", "", "gemini"])
def test_create_rejects_unsupported_agent(tmp_path: Path, agent_key: str) -> None:
    store = _store(tmp_path)
    with pytest.raises(ValueError):
        store.create(agent_key=agent_key, name="X")


def test_create_rejects_blank_name(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with pytest.raises(ValueError):
        store.create(agent_key="claude", name="   ")


def test_create_does_not_touch_disk_dirs(tmp_path: Path) -> None:
    """Profile homes are lazy — created only via ensure_home (at spawn)."""
    store = _store(tmp_path)
    profile = store.create(agent_key="kimi", name="Alt")
    assert not store.home_path(profile).exists()
    home = store.ensure_home(profile)
    assert home.is_dir()
    assert home == store.home_path(profile)


def test_rename_updates_name_not_directory(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Old")
    home_before = store.ensure_home(profile)

    renamed = store.rename(profile["id"], "New")

    assert renamed["name"] == "New"
    assert renamed["id"] == profile["id"]
    assert store.home_path(renamed) == home_before
    assert home_before.is_dir()


def test_rename_unknown_raises(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with pytest.raises(KeyError):
        store.rename("nope1234", "X")


def test_delete_archives_home_dir_never_removes(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Work")
    home = store.ensure_home(profile)
    (home / ".credentials.json").write_text("{}", encoding="utf-8")

    doc = store.delete(profile["id"])

    assert doc["profiles"] == []
    assert not home.exists()
    archived = [
        p for p in home.parent.iterdir()
        if p.name.startswith(f"{profile['id']}.deleted-")
    ]
    assert len(archived) == 1
    # Content survives the archive rename.
    assert (archived[0] / ".credentials.json").read_text(encoding="utf-8") == "{}"


def test_delete_clears_default(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="grok", name="Work")
    store.set_default("grok", profile["id"])

    doc = store.delete(profile["id"])

    assert doc["defaults"]["grok"] is None


def test_delete_archive_name_avoids_same_instant_collision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two archives colliding on the same timestamp must not clobber each other:
    the second falls back to a suffixed name instead of failing to rename."""
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Work")
    home = store.ensure_home(profile)
    (home / ".credentials.json").write_text("secret", encoding="utf-8")
    # Freeze the timestamp and pre-create the exact archive name delete would
    # pick, forcing the collision the old int(time.time()) suffix couldn't dodge.
    monkeypatch.setattr(profiles_mod.time, "time_ns", lambda: 111)
    collider = home.with_name(f"{home.name}.deleted-111")
    collider.mkdir(parents=True)

    store.delete(profile["id"])

    assert not home.exists()
    archived = [
        p for p in home.parent.iterdir()
        if p.name.startswith(f"{profile['id']}.deleted-")
    ]
    # Both the pre-existing collider and the freshly archived home survive.
    assert len(archived) == 2
    with_creds = [p for p in archived if (p / ".credentials.json").exists()]
    assert len(with_creds) == 1
    assert (with_creds[0] / ".credentials.json").read_text(encoding="utf-8") == "secret"


def test_delete_unknown_raises(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with pytest.raises(KeyError):
        store.delete("nope1234")


def test_set_default_and_builtin_null(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="codex", name="Work")

    defaults = store.set_default("codex", profile["id"])
    assert defaults["codex"] == profile["id"]
    assert store.get_default_profile("codex") == profile

    defaults = store.set_default("codex", None)
    assert defaults["codex"] is None
    assert store.get_default_profile("codex") is None


def test_set_default_validates_agent_and_profile(tmp_path: Path) -> None:
    store = _store(tmp_path)
    claude_profile = store.create(agent_key="claude", name="Work")
    with pytest.raises(ValueError):
        store.set_default("antigravity", None)
    with pytest.raises(KeyError):
        store.set_default("claude", "nope1234")
    with pytest.raises(ValueError):
        store.set_default("codex", claude_profile["id"])


def test_corrupt_registry_starts_empty(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text("{not json", encoding="utf-8")
    assert store.list() == {
        "profiles": [],
        "defaults": {"claude": None, "codex": None, "kimi": None, "grok": None},
    }


# ---- path canonicalisation ----


def test_home_path_absolute_nfc_stable(tmp_path: Path) -> None:
    """Claude's Keychain entry hashes the literal CLAUDE_CONFIG_DIR string —
    the path must be absolute, NFC, no trailing slash, identical every call."""
    nfd_root = tmp_path / unicodedata.normalize("NFD", "café-profiles")
    store = CliProfilesStore(path=tmp_path / "reg.json", profiles_root=nfd_root)
    profile = store.create(agent_key="claude", name="Work")

    home = str(store.home_path(profile))

    assert os.path.isabs(home)
    assert home == unicodedata.normalize("NFC", home)
    assert not home.endswith(os.sep)
    assert str(store.home_path(profile)) == home  # verbatim-stable across calls
    assert str(store.ensure_home(profile)) == home


def test_canonical_path_str_strips_trailing_slash() -> None:
    assert canonical_path_str("/tmp/a/b/") == "/tmp/a/b"


# ---- spawn plans ----


def test_build_spawn_plan_claude(tmp_path: Path) -> None:
    plan = build_spawn_plan("claude", tmp_path / "home")
    assert plan.env_set == {"CLAUDE_CONFIG_DIR": str(tmp_path / "home")}
    assert plan.env_remove == ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
    assert plan.codex_source_home is None


def test_build_spawn_plan_kimi(tmp_path: Path) -> None:
    plan = build_spawn_plan("kimi", tmp_path / "home")
    assert plan.env_set == {"KIMI_CODE_HOME": str(tmp_path / "home")}
    assert plan.env_remove == []


def test_build_spawn_plan_codex(tmp_path: Path) -> None:
    plan = build_spawn_plan("codex", tmp_path / "home")
    assert plan.env_set == {}
    assert plan.codex_source_home == tmp_path / "home"


def test_build_spawn_plan_rejects_unsupported(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        build_spawn_plan("antigravity", tmp_path / "home")


def test_grok_shim_structure_and_refresh(tmp_path: Path) -> None:
    real_home = tmp_path / "real-home"
    real_home.mkdir()
    (real_home / ".zshrc").write_text("x", encoding="utf-8")
    (real_home / "Documents").mkdir()
    (real_home / ".grok").mkdir()
    (real_home / ".grok" / "auth.json").write_text("{}", encoding="utf-8")
    profile_home = tmp_path / "profiles" / "grok" / "abcd1234"
    profile_home.mkdir(parents=True)

    plan = build_spawn_plan("grok", profile_home, real_home=real_home)
    shim = Path(plan.env_set["HOME"])

    assert shim == profile_home / "home"
    assert (shim / ".zshrc").is_symlink()
    assert (shim / "Documents").is_symlink()
    assert (shim / "Documents").readlink() == real_home / "Documents"
    # .grok is the isolation point: a REAL directory, never a link to the
    # user's real ~/.grok.
    assert (shim / ".grok").is_dir()
    assert not (shim / ".grok").is_symlink()
    assert not (shim / ".grok" / "auth.json").exists()

    # Refresh on next spawn: picks up new entries, drops dangling links.
    (real_home / ".newfile").write_text("y", encoding="utf-8")
    (real_home / ".zshrc").unlink()
    plan2 = build_spawn_plan("grok", profile_home, real_home=real_home)

    assert plan2.env_set["HOME"] == str(shim)
    assert (shim / ".newfile").is_symlink()
    assert not (shim / ".zshrc").is_symlink()
    assert not (shim / ".zshrc").exists()
