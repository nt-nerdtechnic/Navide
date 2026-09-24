"""Install limits apart from sync limits, sync that drops oversized content,
and repository housekeeping left out of installation."""
from __future__ import annotations

import json
import tarfile

import pytest

from agent_team_backend import skills_installer as module
from agent_team_backend import sync_engine, sync_keyring, sync_scopes
from agent_team_backend.skills_installer import SkillInstaller
from agent_team_backend.skills_store import SkillValidationError, SkillsStore

from .test_skills_installer import SKILL, archive, mock_github
from .test_sync_engine import account_key  # noqa: F401 - a fixture

MIB = 1024 * 1024


@pytest.fixture
def setup(tmp_path):
    store = SkillsStore(root=tmp_path / "shared", state_path=tmp_path / "state.json",
                        runtime_root=tmp_path / "runtime", native_roots=[])
    source = tmp_path / "source"
    source.mkdir()
    (source / "SKILL.md").write_bytes(SKILL)
    return store, SkillInstaller(store), source


def prepare(installer, source):
    return installer.preview(str(source), owner_key="owner")


def commit(installer, item):
    return installer.install(item["preview_id"], item["digest"], owner_key="owner",
                             targets=["codex"], consent=True)


# ── install limits ───────────────────────────────────────────────────────────
def test_install_limits_are_their_own_and_sync_limits_are_unchanged():
    assert (module.MAX_FILES, module.MAX_FILE_BYTES, module.MAX_TOTAL_BYTES) == (512, 8 * MIB, 32 * MIB)
    assert (module.MAX_DOWNLOAD_BYTES, module.MAX_ARCHIVE_BYTES, module.MAX_CACHE_BYTES) == (64 * MIB, 128 * MIB, 64 * MIB)
    assert (SkillsStore.MAX_CONTENT_FILES, SkillsStore.CONTENT_FILE_LIMIT, SkillsStore.CONTENT_TOTAL_LIMIT) == (64, 256 * 1024, 512 * 1024)


def test_skill_over_the_old_sync_limits_installs(setup):
    store, installer, source = setup
    (source / "video.bin").write_bytes(b"x" * (8 * MIB))
    for index in range(100):
        (source / f"part-{index}.md").write_bytes(b"x")
    item = prepare(installer, source)
    assert len(item["files"]) == 102
    commit(installer, item)
    assert (store.root / "example" / "video.bin").stat().st_size == 8 * MIB


def test_file_one_byte_over_the_install_limit_is_refused(setup):
    store, installer, source = setup
    (source / "video.bin").write_bytes(b"x" * (8 * MIB + 1))
    with pytest.raises(SkillValidationError, match="size limit"):
        prepare(installer, source)
    assert not store.root.exists()


def test_total_over_the_install_limit_is_refused(setup, monkeypatch):
    _, installer, source = setup
    monkeypatch.setattr(module, "MAX_TOTAL_BYTES", 1024)
    (source / "a.bin").write_bytes(b"x" * (1024 - len(SKILL)))
    prepare(installer, source)  # exactly at the limit
    (source / "b.bin").write_bytes(b"x")
    with pytest.raises(SkillValidationError, match="size limit"):
        prepare(installer, source)


def test_file_count_at_and_over_the_install_limit(setup):
    _, installer, source = setup
    for index in range(511):
        (source / f"f{index}").write_bytes(b"x")
    assert len(prepare(installer, source)["files"]) == 512
    (source / "one-more").write_bytes(b"x")
    with pytest.raises(SkillValidationError, match="file count"):
        prepare(installer, source)


def test_install_bundle_uses_install_limits(setup):
    store, _, _ = setup
    files = {"SKILL.md": {"data": SKILL, "executable": False},
             "big.bin": {"data": b"x" * (SkillsStore.CONTENT_FILE_LIMIT + 1), "executable": False}}
    store.install_bundle("example", files, targets=None, consent=True)
    assert (store.root / "example" / "big.bin").exists()
    files["huge.bin"] = {"data": b"x" * (SkillsStore.INSTALL_FILE_LIMIT + 1), "executable": False}
    with pytest.raises(SkillValidationError):
        store.install_bundle("other", {**files, "SKILL.md": {"data": SKILL.replace(b"example", b"other"), "executable": False}},
                             targets=None, consent=True)


def test_preview_cache_is_a_fixed_budget(setup, monkeypatch):
    _, installer, source = setup
    monkeypatch.setattr(module, "MAX_CACHE_BYTES", 3 * 1024)
    (source / "data.bin").write_bytes(b"x" * 1024)
    prepare(installer, source)
    prepare(installer, source)
    with pytest.raises(SkillValidationError, match="cache size"):
        prepare(installer, source)


# ── repository housekeeping ──────────────────────────────────────────────────
def test_local_clone_housekeeping_is_excluded_and_listed(setup):
    store, installer, source = setup
    (source / ".git" / "objects").mkdir(parents=True)
    (source / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (source / ".git" / "objects" / "pack").write_bytes(b"x" * (9 * MIB))  # never read
    (source / ".github" / "workflows").mkdir(parents=True)
    (source / ".github" / "workflows" / "ci.yml").write_text("on: push\n")
    (source / ".gitignore").write_text("node_modules\n")
    (source / "assets").mkdir()
    (source / "assets" / ".gitkeep").write_text("")
    (source / "assets" / ".DS_Store").write_bytes(b"\x00")
    item = prepare(installer, source)
    assert [entry["path"] for entry in item["files"]] == ["SKILL.md"]
    assert item["excluded"] == [
        {"path": ".git/", "reason": "repository metadata"},
        {"path": ".github/", "reason": "repository metadata"},
        {"path": ".gitignore", "reason": "repository housekeeping file"},
        {"path": "assets/.DS_Store", "reason": "repository housekeeping file"},
        {"path": "assets/.gitkeep", "reason": "repository housekeeping file"},
    ]
    assert any("excluded" in warning for warning in item["warnings"])
    commit(installer, item)
    assert sorted(path.name for path in (store.root / "example").iterdir()) == [".navide", "SKILL.md"]


def test_worktree_git_file_is_excluded(setup):
    _, installer, source = setup
    (source / ".git").write_text("gitdir: /elsewhere\n")
    assert prepare(installer, source)["excluded"] == [{"path": ".git/", "reason": "repository metadata"}]


def test_clean_source_has_no_exclusions_or_warning(setup):
    _, installer, source = setup
    item = prepare(installer, source)
    assert item["excluded"] == []
    assert not any("excluded" in warning for warning in item["warnings"])


@pytest.mark.parametrize("name", [".navide", ".env", ".hidden/notes.md", "refs/.secret"])
def test_other_dotfiles_still_refuse_the_source(setup, name):
    store, installer, source = setup
    path = source / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x")
    with pytest.raises(SkillValidationError, match="unsafe skill path"):
        prepare(installer, source)
    assert not store.root.exists()


def test_github_housekeeping_is_excluded_and_listed(setup, monkeypatch):
    store, installer, _ = setup
    mock_github(monkeypatch, archive([
        ("repo/SKILL.md", SKILL, tarfile.REGTYPE),
        ("repo/.gitignore", b"dist\n", tarfile.REGTYPE),
        ("repo/.github/workflows/ci.yml", b"on: push\n", tarfile.REGTYPE),
        ("repo/.github/SKILL.md", SKILL, tarfile.REGTYPE),  # never a candidate
        ("repo/refs/guide.md", b"guide", tarfile.REGTYPE),
    ]))
    item = installer.preview("example/repo", owner_key="owner")
    assert [entry["path"] for entry in item["files"]] == ["SKILL.md", "refs/guide.md"]
    assert item["excluded"] == [{"path": ".github/", "reason": "repository metadata"},
                                {"path": ".gitignore", "reason": "repository housekeeping file"}]
    peeked = installer.peek(item["preview_id"], item["digest"], owner_key="owner", targets=["codex"])
    assert peeked["preview"]["excluded"] == item["excluded"]
    commit(installer, item)
    assert not (store.root / "example" / ".gitignore").exists()


def test_github_other_dotfile_still_refuses(setup, monkeypatch):
    _, installer, _ = setup
    mock_github(monkeypatch, archive([("repo/SKILL.md", SKILL, tarfile.REGTYPE),
                                      ("repo/.navide", b"", tarfile.REGTYPE)]))
    with pytest.raises(SkillValidationError):
        installer.preview("example/repo", owner_key="owner")


# ── sync of oversized content ────────────────────────────────────────────────
@pytest.mark.parametrize("text", ["", "a", "ab", "abc", '{"k":"日本語"}', "x" * 10_000])
def test_sealed_length_matches_encrypt(account_key, text):  # noqa: F811
    assert sync_keyring.sealed_length(text) == len(sync_keyring.encrypt(text, scope="skills", item_id="s"))


@pytest.fixture
def scope(setup, monkeypatch):
    store, _, _ = setup
    from agent_team_backend import app

    monkeypatch.setattr(app, "skills_store", store, raising=False)
    return store, sync_scopes.SkillsStateScope()


def _managed(store, name, **files):
    store.create_skill(name, "d", consent=True)
    for relative, data in files.items():
        (store.root / name / relative).write_bytes(data)


def test_small_managed_skill_carries_content(scope):
    store, skills = scope
    _managed(store, "small", **{"notes.md": b"note"})
    entry = skills._present()["small"]
    assert entry["content"]["notes.md"] == {"t": "text", "v": "note"}
    listing = sync_scopes.annotate_content_sync(store.list_skills(), store)
    assert listing["skills"][0]["sync_too_large"] is False


def test_entry_whose_sealed_body_exceeds_the_record_drops_content(scope, account_key):  # noqa: F811
    store, skills = scope
    # 400 KiB of binary passes export_content's own 512 KiB check but grows to
    # well over 512 KiB once base64-encoded twice.
    _managed(store, "binary", **{"a.bin": bytes(range(256)) * 800, "b.bin": bytes(range(256)) * 800})
    assert store.export_content("binary") is not None
    entry = skills._present()["binary"]
    assert set(entry) == {"enabled", "targets"}
    body = sync_keyring.encrypt(sync_engine.canonical(entry), scope="skills", item_id="binary")
    assert len(body) <= sync_engine.MAX_BODY_BYTES
    listing = sync_scopes.annotate_content_sync(store.list_skills(), store)
    assert listing["skills"][0]["sync_too_large"] is True


def test_skill_over_export_limits_is_marked_and_still_routes(scope):
    store, skills = scope
    _managed(store, "video", **{"clip.bin": b"x" * (SkillsStore.CONTENT_FILE_LIMIT + 1), "notes.md": b"n"})
    store.set_enabled("video", False)
    # A file too big to carry withholds the whole skill, never part of it.
    assert store.export_content("video") is None
    assert skills._present()["video"] == {"enabled": False, "targets": None}
    listing = sync_scopes.annotate_content_sync(store.list_skills(), store)
    assert listing["skills"][0]["sync_too_large"] is True


def test_unmanaged_skill_is_not_marked(scope):
    store, _ = scope
    (store.root / "theirs").mkdir(parents=True)
    (store.root / "theirs" / "SKILL.md").write_text("---\nname: theirs\ndescription: d\n---\nbody\n")
    listing = sync_scopes.annotate_content_sync(store.list_skills(), store)
    assert "sync_too_large" not in listing["skills"][0]


def test_receiver_applies_settings_of_an_entry_without_content(scope, monkeypatch):
    """What an older client does with the content-less entry this build sends."""
    store, skills = scope
    _managed(store, "video")
    intent = {}
    monkeypatch.setattr(skills, "_intent", lambda: dict(intent))
    monkeypatch.setattr(skills, "_set_intent", lambda value: intent.update(value))
    imported = []
    monkeypatch.setattr(store, "import_content", lambda *a: imported.append(a))
    skills.apply("video", {"enabled": False, "targets": ["codex"]})
    assert imported == []
    assert store.get_skill("video")["skill"]["enabled"] is False
    assert store.get_skill("video")["skill"]["targets"] == ["codex"]
    # And a skill it does not have keeps the decision for later.
    skills.apply("elsewhere", json.loads('{"enabled": true, "targets": null}'))
    assert intent["elsewhere"] == {"enabled": True, "targets": None}
