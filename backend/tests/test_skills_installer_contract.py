"""Approved acquisition limits, candidate selection and durable receipts."""

from __future__ import annotations

import json
from pathlib import Path
import tarfile

import pytest

from agent_team_backend import skills_installer as module, skills_store
from agent_team_backend.skills_installer import SkillInstaller
from agent_team_backend.skills_store import SkillConflictError, SkillValidationError, SkillsStore
from tests.test_skills_installer import SKILL, archive, mock_github


@pytest.fixture
def library(tmp_path):
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
                             targets=None, consent=True)


@pytest.mark.parametrize("kind", ["file", "total", "count"])
def test_approved_package_limits_reject_complete_package(library, kind):
    store, installer, source = library
    if kind == "file":
        (source / "large").write_bytes(b"x" * (256 * 1024 + 1))
    elif kind == "total":
        for name in ("a", "b"):
            (source / name).write_bytes(b"x" * (256 * 1024))
    else:
        for index in range(64):
            (source / f"file-{index}").write_bytes(b"x")
    with pytest.raises(SkillValidationError):
        prepare(installer, source)
    assert not store.root.exists()


def test_eight_live_preparations_are_retained_and_ninth_refused(library):
    _, installer, source = library
    items = [prepare(installer, source) for _ in range(8)]
    with pytest.raises(SkillValidationError, match="too many"):
        prepare(installer, source)
    assert commit(installer, items[0])["changed"] is True


def test_success_releases_payload_but_replay_cannot_write(library):
    store, installer, source = library
    item = prepare(installer, source)
    commit(installer, item)
    record = installer._previews[item["preview_id"]]
    assert not record.get("bundle")
    assert record["size"] == 0
    store.delete_skill("example")
    assert commit(installer, item)["changed"] is False
    assert not (store.root / "example").exists()


def test_shorthand_candidates_include_root_and_invalid_details(library, monkeypatch):
    store, installer, _ = library
    mock_github(monkeypatch, archive([
        ("repo/SKILL.md", SKILL, tarfile.REGTYPE),
        ("repo/broken/SKILL.md", b"invalid", tarfile.REGTYPE),
    ]))
    result = installer.preview("example/repo", owner_key="owner")
    assert "preview_id" not in result and "digest" not in result
    assert result["selection_required"] is True
    candidates = {entry["path"]: entry for entry in result["candidates"]}
    assert candidates["."]["name"] == "example"
    assert candidates["."]["description"] == "Example skill"
    assert candidates["broken"]["error"]
    assert not store.root.exists()
    assert not installer._previews
    selected = installer.preview("example/repo", subdir=".", owner_key="owner")
    assert selected["name"] == "example"


@pytest.mark.parametrize("entries", [
    [("repo/docs", b"", tarfile.DIRTYPE), ("repo/docs", b"", tarfile.DIRTYPE)],
    [("repo/Docs", b"", tarfile.DIRTYPE), ("repo/docs/file", b"x", tarfile.REGTYPE)],
    [("repo/docs", b"x", tarfile.REGTYPE), ("repo/docs", b"", tarfile.DIRTYPE)],
])
def test_archive_directory_aliases_are_rejected_even_outside_selection(library, monkeypatch, entries):
    _, installer, _ = library
    mock_github(monkeypatch, archive([
        ("repo/skill/SKILL.md", SKILL, tarfile.REGTYPE), *entries,
    ]))
    with pytest.raises(SkillValidationError):
        installer.preview("https://github.com/example/repo", subdir="skill", owner_key="owner")


def test_source_mutation_during_read_is_rejected(library, monkeypatch):
    store, installer, source = library
    original = module.os.fdopen

    class ChangedReader:
        def __init__(self, handle):
            self.handle = handle
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return self.handle.__exit__(*args)
        def fileno(self):
            return self.handle.fileno()
        def read(self, size):
            content = self.handle.read(size)
            (source / "SKILL.md").write_bytes(SKILL + b"changed during read")
            return content

    monkeypatch.setattr(module.os, "fdopen", lambda *args, **kwargs: ChangedReader(original(*args, **kwargs)))
    with pytest.raises(SkillValidationError, match="changed"):
        prepare(installer, source)
    assert not store.root.exists()


def test_receipt_is_versioned_and_survives_edit_toggle_and_migration_line(library):
    store, installer, source = library
    item = prepare(installer, source)
    result = commit(installer, item)
    receipt = result["skill"]["provenance"]
    assert receipt["schema_version"] == 1
    assert receipt["prepared_at"]
    marker = store.root / "example" / ".navide"
    document = json.loads(marker.read_text())
    assert document["installation"] == receipt
    origin = source.parent / "original"
    marker.write_text(f"migrated-from: {origin}\n" + json.dumps(document) + "\n")
    current = store.get_skill("example")["skill"]
    store.save_skill("example", current["fields"], "Edited locally", current["revision"])
    store.set_enabled("example", False)
    reloaded = SkillsStore(root=store.root, state_path=store.state_path,
                           runtime_root=store.runtime_root, native_roots=[])
    saved = reloaded.get_skill("example")["skill"]
    assert saved["provenance"] == receipt
    assert saved["migrated_from"] == str(origin)
    assert saved["enabled"] is False
    assert reloaded.list_skills()["skills"][0]["provenance"] == receipt


def test_complete_package_at_all_content_boundaries_is_installable(library):
    store, installer, source = library
    (source / "large").write_bytes(b"x" * (256 * 1024))
    for index in range(61):
        (source / f"small-{index}").write_bytes(b"x")
    (source / "remaining").write_bytes(b"x" * (512 * 1024 - 256 * 1024 - len(SKILL) - 61))
    item = prepare(installer, source)
    assert len(item["files"]) == 64
    assert sum(entry["size"] for entry in item["files"]) == 512 * 1024
    commit(installer, item)
    assert len(store.export_content("example")) == 64


def test_archive_expanded_metadata_is_bounded_before_tar_parse(library, monkeypatch):
    import gzip
    _, installer, _ = library
    monkeypatch.setattr(module, "MAX_ARCHIVE_BYTES", 1024)
    mock_github(monkeypatch, gzip.compress(b"large PAX metadata" * 1024))
    def unexpected(*args, **kwargs):
        pytest.fail("oversized expanded metadata must be rejected before tar parsing")
    monkeypatch.setattr(module.tarfile, "open", unexpected)
    with pytest.raises(SkillValidationError, match="expands"):
        installer.preview("example/repo", owner_key="owner")


def test_racing_destination_is_never_replaced(library, monkeypatch):
    store, installer, source = library
    item = prepare(installer, source)
    destination = store.root / "example"
    original = module.os.mkdir
    def mkdir(path, *args, **kwargs):
        if Path(path) in {destination, Path(destination.name)}:
            original(path, *args, **kwargs)
            (destination / "foreign").write_text("keep")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(module.os, "mkdir", mkdir)
    with pytest.raises(FileExistsError):
        commit(installer, item)
    assert (destination / "foreign").read_text() == "keep"
    assert not store.state_path.exists()


def test_racing_file_during_publication_is_preserved_on_rollback(library, monkeypatch):
    store, installer, source = library
    (source / "helper.txt").write_text("ours")
    item = prepare(installer, source)
    original = module.os.link
    def link(source_path, target_path, **kwargs):
        if Path(target_path).name == "helper.txt":
            (store.root / "example" / "helper.txt").write_text("foreign")
        return original(source_path, target_path, **kwargs)
    monkeypatch.setattr(module.os, "link", link)
    with pytest.raises(FileExistsError):
        commit(installer, item)
    destination = store.root / "example"
    assert (destination / "helper.txt").read_text() == "foreign"
    assert not (destination / "SKILL.md").exists()
    assert not (destination / ".navide").exists()
    assert not store.state_path.exists()


def test_rollback_after_manifest_publication_preserves_existing_consent(library, monkeypatch):
    store, installer, source = library
    store.create_skill("existing", "Keep", consent=True)
    before = store.state_path.read_bytes()
    item = prepare(installer, source)
    original = store._write_state
    def write(*args, **kwargs):
        assert (store.root / "example" / "SKILL.md").read_bytes() == SKILL
        original(*args, **kwargs)
        raise OSError("after consent write")
    monkeypatch.setattr(store, "_write_state", write)
    with pytest.raises(OSError):
        commit(installer, item)
    assert store.state_path.read_bytes() == before
    assert not (store.root / "example").exists()


def test_expiry_and_new_store_cannot_install_previous_token(library, monkeypatch):
    store, installer, source = library
    item = prepare(installer, source)
    with pytest.raises(SkillValidationError, match="expired"):
        commit(SkillInstaller(store), item)
    monkeypatch.setattr(module.time, "time", lambda: item["expires_at"] + 1)
    with pytest.raises(SkillValidationError, match="expired"):
        commit(installer, item)
    assert not installer._previews
    assert not store.root.exists()


def test_receipts_do_not_consume_active_preview_capacity(library):
    store, installer, source = library
    for index in range(9):
        (source / "SKILL.md").write_bytes(SKILL.replace(b"example", f"example-{index}".encode()))
        commit(installer, prepare(installer, source))
    assert len(installer._previews) <= 8
    assert len(store.list_skills()["skills"]) == 9
    assert "preview_id" in prepare(installer, source)


@pytest.mark.parametrize("replace_subdirectory", [False, True])
def test_replaced_publication_directory_never_receives_skill_files(library, monkeypatch, replace_subdirectory):
    if not skills_store._DIRECTORY_FDS:
        pytest.skip("requires descriptor-relative publication")
    store, installer, source = library
    (source / "helpers").mkdir()
    (source / "helpers" / "check.py").write_text("print('review')")
    item = prepare(installer, source)
    foreign = source.parent / "foreign"
    foreign.mkdir()
    (foreign / "keep").write_text("foreign asset")
    swapped = source.parent / "moved"
    original = module.os.link
    changed = False
    def link(source_path, target_path, **kwargs):
        nonlocal changed
        if not changed and (not replace_subdirectory or Path(target_path).name == "check.py"):
            changed = True
            target = store.root / "example"
            if replace_subdirectory:
                target = target / "helpers"
            target.rename(swapped)
            target.symlink_to(foreign, target_is_directory=True)
        return original(source_path, target_path, **kwargs)
    monkeypatch.setattr(module.os, "link", link)
    with pytest.raises(SkillConflictError):
        commit(installer, item)
    assert sorted(path.name for path in foreign.iterdir()) == ["keep"]
    assert not list(swapped.rglob("SKILL.md"))
    assert not store.state_path.exists()


def test_path_fallback_rejects_observed_directory_replacement(library, monkeypatch):
    store, installer, source = library
    item = prepare(installer, source)
    monkeypatch.setattr(skills_store, "_DIRECTORY_FDS", False)
    original = module.os.link
    def link(source_path, target_path, **kwargs):
        result = original(source_path, target_path, **kwargs)
        destination = store.root / "example"
        destination.rename(source.parent / "moved")
        destination.mkdir()
        (destination / "foreign").write_text("keep")
        return result
    monkeypatch.setattr(module.os, "link", link)
    with pytest.raises(SkillConflictError):
        commit(installer, item)
    assert (store.root / "example" / "foreign").read_text() == "keep"
    assert not (store.root / "example" / "SKILL.md").exists()
    assert not store.state_path.exists()


def test_path_fallback_installs_on_platforms_without_directory_descriptors(library, monkeypatch):
    store, installer, source = library
    monkeypatch.setattr(skills_store, "_DIRECTORY_FDS", False)
    commit(installer, prepare(installer, source))
    assert (store.root / "example" / "SKILL.md").read_bytes() == SKILL
    assert store.write_consented() is True
