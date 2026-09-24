"""Large skills across devices: the engine's hooks for the ``skill-files``
scope, and the scope itself end to end over a fake record server and a fake
object store (real HTTP on 127.0.0.1)."""

from __future__ import annotations

import asyncio
import os
import stat
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, skill_blobs, sync_engine, sync_keyring, sync_scopes
from agent_team_backend.db import Database
from agent_team_backend.skills_store import SkillsStore

from .test_skill_blobs import SMALL, FakeStore
from .test_sync_engine import FakeServer, account_key  # noqa: F401 - a fixture


def _run(coro):
    return asyncio.run(coro)


def _engine(tmp_path: Path, name: str, server: Any, adapter: Any, enabled=lambda _s: True):
    store = sync_engine.SyncStore(Database(tmp_path / f"{name}.db"))

    async def request(kind: str, payload: dict) -> dict:
        if kind == "sync.push":
            for item in payload["items"]:
                item["deviceId"] = name
        return await server.request(kind, payload)

    engine = sync_engine.SyncEngine(
        store, request, device_id=lambda: name, enabled=enabled, signing_key_for=lambda _d: ""
    )
    engine.register(adapter)
    return engine, store


class HookScope:
    """A skill-files-shaped adapter with the engine hooks, driven by flags."""

    scope = "skill-files"

    def __init__(self, items: dict | None = None) -> None:
        self.items = dict(items or {})
        self.applied: dict[str, Any] = {}
        self.ready_answer = True
        self.defer = False
        self.supported = True

    async def prepare(self, request, kick) -> bool:
        return self.supported

    def snapshot(self) -> dict:
        return dict(self.items)

    def refs(self, payload: Any) -> list[str]:
        return sorted(payload.get("blobs", []))

    async def ready(self, item_id: str, payload: Any) -> bool:
        return self.ready_answer

    def apply(self, item_id: str, payload: Any) -> None:
        if self.defer:
            raise sync_engine.DeferItem(item_id)
        self.applied[item_id] = payload
        self.items[item_id] = payload


class RecordingServer(FakeServer):
    def __init__(self) -> None:
        super().__init__()
        self.wire: list[dict] = []

    async def request(self, msg_type: str, payload: dict) -> dict:
        if msg_type == "sync.push":
            self.wire.extend(dict(i) for i in payload["items"])
        return await super().request(msg_type, payload)


# ── engine hooks ─────────────────────────────────────────────────────


def test_skill_files_is_a_protocol_scope_but_not_a_switch() -> None:
    assert "skill-files" in sync_engine.INTERNAL_SCOPES
    assert "skill-files" not in sync_engine.SCOPES


def test_skill_files_rides_with_the_skills_switch(monkeypatch) -> None:
    monkeypatch.setattr(sync_scopes, "enabled_scopes", lambda: {"skills": True})
    assert sync_scopes.scope_enabled("skill-files") is True
    monkeypatch.setattr(sync_scopes, "enabled_scopes", lambda: {"skills": False})
    assert sync_scopes.scope_enabled("skill-files") is False


def test_a_push_names_the_blobs_its_record_uses(tmp_path, account_key) -> None:  # noqa: F811
    server = RecordingServer()
    adapter = HookScope({"big": {"blobs": ["b" * 64, "a" * 64]}})
    engine, _ = _engine(tmp_path, "d1", server, adapter)
    _run(engine.sync("skill-files"))
    assert server.wire[0]["refs"] == ["a" * 64, "b" * 64]


def test_an_item_whose_files_are_not_up_yet_waits(tmp_path, account_key) -> None:  # noqa: F811
    server = RecordingServer()
    adapter = HookScope({"big": {"blobs": ["a" * 64]}})
    adapter.ready_answer = False
    engine, store = _engine(tmp_path, "d1", server, adapter)
    _run(engine.sync("skill-files"))
    assert server.wire == []
    assert store.state("skill-files", "big") is None
    adapter.ready_answer = True
    _run(engine.sync("skill-files"))
    assert [i["itemId"] for i in server.wire] == ["big"]


def test_a_deferred_record_holds_the_cursor_until_it_lands(tmp_path, account_key) -> None:  # noqa: F811
    server = RecordingServer()
    sender, _ = _engine(tmp_path, "d1", server, HookScope({"big": {"blobs": ["a" * 64]}}))
    _run(sender.sync("skill-files"))
    receiver_adapter = HookScope()
    receiver_adapter.defer = True
    receiver, store = _engine(tmp_path, "d2", server, receiver_adapter)
    _run(receiver.sync("skill-files"))
    assert receiver_adapter.applied == {}
    assert store.cursor("skill-files") == 0
    receiver_adapter.defer = False
    _run(receiver.sync("skill-files"))
    assert receiver_adapter.applied == {"big": {"blobs": ["a" * 64]}}
    assert store.cursor("skill-files") == 1


def test_a_server_without_blob_storage_skips_the_round(tmp_path, account_key) -> None:  # noqa: F811
    server = RecordingServer()
    adapter = HookScope({"big": {"blobs": ["a" * 64]}})
    adapter.supported = False
    engine, _ = _engine(tmp_path, "d1", server, adapter)
    assert _run(engine.sync("skill-files")) == {"scope": "skill-files", "skipped": "unsupported"}
    assert server.wire == []


def test_choosing_a_copy_whose_files_are_still_downloading_keeps_the_conflict(tmp_path, account_key) -> None:  # noqa: F811
    server = RecordingServer()
    sender, _ = _engine(tmp_path, "d1", server, HookScope({"big": {"blobs": ["a" * 64]}}))
    _run(sender.sync("skill-files"))
    adapter = HookScope({"big": {"blobs": ["c" * 64]}})
    receiver, store = _engine(tmp_path, "d2", server, adapter)
    _run(receiver.sync("skill-files"))
    assert store.conflict_ids("skill-files") == {"big"}
    adapter.defer = True
    with pytest.raises(sync_engine.SyncError, match="still downloading"):
        receiver.resolve("skill-files", "big", sync_engine.KEEP_REMOTE)
    assert store.conflict_ids("skill-files") == {"big"}


# ── the scope, two devices ───────────────────────────────────────────


class Device:
    def __init__(self, tmp_path: Path, name: str, server: FakeServer, blobs: FakeStore) -> None:
        self.name = name
        self.store = SkillsStore(root=tmp_path / name / "shared", state_path=tmp_path / name / "state.json",
                                 runtime_root=tmp_path / name / "runtime", native_roots=[])
        self.adapter = sync_scopes.SkillFilesScope()
        self.adapter._digests = skill_blobs.DigestCache(Database(tmp_path / f"{name}-digests.db"))
        staging = tmp_path / name / "staging"
        staging.mkdir(parents=True)
        self.adapter._staging = lambda: staging

        async def request(kind: str, payload: dict) -> dict:
            if kind.startswith("blobs."):
                return await blobs.request(kind, payload)
            if kind == "sync.push":
                for item in payload["items"]:
                    item["deviceId"] = name
            return await server.request(kind, payload)

        self.engine = sync_engine.SyncEngine(
            sync_engine.SyncStore(Database(tmp_path / f"{name}.db")), request,
            device_id=lambda: name, enabled=lambda _s: True, signing_key_for=lambda _d: "",
        )
        self.engine.register(self.adapter)

    async def settle(self, monkeypatch) -> None:
        """One round, then every transfer it started and the rounds those kick."""
        monkeypatch.setattr(app, "skills_store", self.store, raising=False)
        await self.engine.sync("skill-files")
        for _ in range(50):
            pending = [t for t in list(self.adapter._tasks.values()) + list(self.engine._kicked) if not t.done()]
            if not pending:
                return
            await asyncio.gather(*pending, return_exceptions=True)
        raise AssertionError("transfers did not settle")


@pytest.fixture
def blobs(tmp_path):
    root = tmp_path / "s3"
    root.mkdir()
    s = FakeStore(root, SMALL)
    yield s
    s.close()


def _big_skill(store: SkillsStore) -> dict[str, bytes]:
    store.create_skill("big", "d", consent=True)
    files = {"clip.bin": os.urandom(300 * 1024), "notes/a.md": b"# notes\n", "run.sh": b"#!/bin/sh\necho hi\n"}
    for rel, data in files.items():
        (store.root / "big" / rel).parent.mkdir(parents=True, exist_ok=True)
        (store.root / "big" / rel).write_bytes(data)
    (store.root / "big" / "run.sh").chmod(0o755)
    return files


def test_a_large_skill_reaches_another_device_whole(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    files = _big_skill(a.store)
    # The settings travelled through ``skills`` and wait for the files on b.
    monkeypatch.setattr(sync_scopes.SkillsStateScope, "_intent",
                        lambda self: {"big": {"enabled": False, "targets": ["codex"]}})

    async def flow() -> None:
        await a.settle(monkeypatch)
        assert ("skill-files", "big") in server.rows
        await b.settle(monkeypatch)

    _run(flow())
    landed = b.store.root / "big"
    for rel, data in files.items():
        assert (landed / rel).read_bytes() == data
    assert (landed / "run.sh").stat().st_mode & stat.S_IXUSR
    skill = b.store.get_skill("big")["skill"]
    assert skill["enabled"] is False and skill["targets"] == ["codex"]
    # b now names the same files the same way: nothing to send back.
    pushes = server.pushes
    _run(b.settle(monkeypatch))
    assert server.pushes == pushes
    assert not any(b.adapter._staging().iterdir())


def test_a_removal_elsewhere_never_deletes_files_here(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    server = FakeServer()
    b = Device(tmp_path, "b", server, blobs)
    _big_skill(b.store)
    monkeypatch.setattr(app, "skills_store", b.store, raising=False)
    assert b.adapter.apply("big", None) is None
    assert (b.store.root / "big" / "clip.bin").exists()


def test_a_skill_that_is_not_navides_here_is_not_fetched(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    b = Device(tmp_path, "b", server, blobs)
    _big_skill(a.store)
    (b.store.root / "big").mkdir(parents=True)
    (b.store.root / "big" / "SKILL.md").write_text("---\nname: big\ndescription: mine\n---\nbody\n")

    async def flow() -> None:
        await a.settle(monkeypatch)
        gets = len(blobs.gets)
        await b.settle(monkeypatch)
        assert len(blobs.gets) == gets

    _run(flow())
    assert (b.store.root / "big" / "SKILL.md").read_text().endswith("body\n")
    assert not (b.store.root / "big" / "clip.bin").exists()


def test_small_skills_stay_in_the_skills_scope(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    a.store.create_skill("small", "d", consent=True)
    (a.store.root / "small" / "notes.md").write_bytes(b"note")
    _run(a.settle(monkeypatch))
    assert ("skill-files", "small") not in server.rows


def test_the_listing_says_blobs_carry_a_large_skill_once_the_server_can(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    _big_skill(a.store)
    monkeypatch.setattr(sync_scopes, "_skill_files", a.adapter)
    listing = sync_scopes.annotate_content_sync(a.store.list_skills(), a.store)
    assert listing["skills"][0]["sync_too_large"] is True  # server not asked yet
    _run(a.adapter.prepare(blobs.request, lambda: None))
    listing = sync_scopes.annotate_content_sync(a.store.list_skills(), a.store)
    assert listing["skills"][0]["sync_too_large"] is False
    assert listing["skills"][0]["sync_via_blobs"] is True


def test_the_skills_record_of_a_large_skill_keeps_its_old_shape(tmp_path, monkeypatch, blobs, account_key) -> None:  # noqa: F811
    """Old builds push back whatever they store; a new field here would be erased."""
    server = FakeServer()
    a = Device(tmp_path, "a", server, blobs)
    _big_skill(a.store)
    monkeypatch.setattr(app, "skills_store", a.store, raising=False)
    _run(a.adapter.prepare(blobs.request, lambda: None))
    entry = sync_scopes.SkillsStateScope()._present()["big"]
    assert set(entry) == {"enabled", "targets"}
