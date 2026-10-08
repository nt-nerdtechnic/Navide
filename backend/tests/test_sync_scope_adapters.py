"""Scope adapters against the rules the real server and the other device hold
them to: the protocol's itemId pattern, deletes that must stay deleted,
refusals that must be reported rather than swallowed, and files that must land
the way they left.

Two devices share one ``StrictServer`` — the test FakeServer plus the itemId
pattern ``Navide-Server/src/handlers/sync.ts`` enforces — and each device swaps
its own stores into ``app`` before every round, the real arrangement.
"""

from __future__ import annotations

import re

import pytest

from agent_team_backend import app, native_memory, sync_engine, sync_keyring, sync_scopes
from agent_team_backend.db import Database
from tests.test_sync_engine import FakeServer, FakeSettingsStore

#: Navide-Server sync.ts: one bad id refuses the whole batch.
ITEM_ID = re.compile(r"^[A-Za-z0-9._:@+-]{1,200}$")


class StrictServer(FakeServer):
    async def request(self, msg_type, payload):
        if msg_type == "sync.push":
            for item in payload["items"]:
                if not ITEM_ID.match(item["itemId"]):
                    return {"ok": False, "error": {"code": "BAD_REQUEST", "message": item["itemId"]}}
        return await super().request(msg_type, payload)


@pytest.fixture
def account_key():
    sync_keyring.ensure_account_key()
    yield
    sync_keyring.forget_account_key()


class Dev:
    """One machine: its own sync store, home and app-level stores."""

    def __init__(self, tmp_path, server, name, monkeypatch, adapter, *, home=None, **stores):
        self.name, self.mp, self.adapter, self.home = name, monkeypatch, adapter, home
        self.stores = {"ui_settings_store": FakeSettingsStore(), **stores}
        self.store = sync_engine.SyncStore(Database(tmp_path / f"{name}.db"))

        async def request(msg_type, payload):
            if msg_type == "sync.push":
                for item in payload["items"]:
                    item["deviceId"] = name
            return await server.request(msg_type, payload)

        self.engine = sync_engine.SyncEngine(
            self.store, request, device_id=lambda: name,
            enabled=lambda _s: True, signing_key_for=lambda _d: "",
        )
        self.engine.register(adapter)

    def use(self):
        for attr, value in self.stores.items():
            self.mp.setattr(app, attr, value)
        if self.home is not None:
            home = self.home
            self.mp.setattr(native_memory, "_home", lambda: home)

    async def sync(self):
        self.use()
        return await self.engine.sync(self.adapter.scope)


def _home(tmp_path, name):
    home = tmp_path / name
    (home / ".claude").mkdir(parents=True)
    return home


# ── memory: item ids ─────────────────────────────────────────────────────────
async def test_memory_item_ids_pass_the_servers_pattern(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    ha, hb = _home(tmp_path, "a"), _home(tmp_path, "b")
    (ha / ".claude" / "CLAUDE.md").write_text("hello\n")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.MemoryScope(), home=ha)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.MemoryScope(), home=hb)
    await a.sync()
    await b.sync()
    assert (hb / ".claude" / "CLAUDE.md").read_text() == "hello\n"


def test_memory_item_id_is_reversible_and_injective():
    paths = [".claude/CLAUDE.md", ".cursor/rules/a b.mdc", ".cursor/rules/a+b.mdc",
             ".cursor/rules/a:b.mdc", ".cursor/rules/規則.mdc", "x" * 250 + ".md"]
    ids = [sync_scopes.memory_item_id(p) for p in paths]
    assert all(ITEM_ID.match(i) for i in ids)
    assert len(set(ids)) == len(ids)
    assert ids[0] == ".claude:CLAUDE.md"


def test_memory_apply_still_accepts_a_plain_relative_path(tmp_path, monkeypatch):
    """A Bundle v1 file names memory items by their path; it must still import."""
    home = _home(tmp_path, "h")
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    assert sync_scopes.MemoryScope._resolve(".claude/CLAUDE.md") is not None
    assert sync_scopes.MemoryScope._resolve(".claude:CLAUDE.md") is not None


def test_memory_leaves_out_files_only_aider_config_names(tmp_path, monkeypatch):
    """A home ``.aider.conf.yml`` can name any file under the home — a project
    file included — and syncing it would copy that file into another machine's
    home. Only the rows the table declares travel."""
    home = _home(tmp_path, "h")
    (home / ".claude" / "CLAUDE.md").write_text("mine\n")
    (home / "work" / "repo").mkdir(parents=True)
    (home / "work" / "repo" / "NOTES.md").write_text("project notes\n")
    (home / ".aider.conf.yml").write_text("read: [work/repo/NOTES.md]\n")
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    assert any(f.relative == "work/repo/NOTES.md" for f in native_memory.scan())  # still listed in the editor
    scope = sync_scopes.MemoryScope()
    assert set(scope.snapshot_by_path()) == {".claude/CLAUDE.md"}
    assert scope._resolve("work/repo/NOTES.md") is None
    assert scope.apply(sync_scopes.memory_item_id("work/repo/NOTES.md"), {"text": "x"}) is False
    assert (home / "work" / "repo" / "NOTES.md").read_text() == "project notes\n"


def test_memory_apply_writes_through_a_symlinked_file(tmp_path, monkeypatch):
    """Keeping ~/.claude/CLAUDE.md as a link into a dotfiles repo is common;
    a synced write must land in the repo, not replace the link."""
    home = _home(tmp_path, "h")
    (home / "dotfiles").mkdir()
    real = home / "dotfiles" / "CLAUDE.md"
    real.write_text("old\n")
    link = home / ".claude" / "CLAUDE.md"
    link.symlink_to(real)
    monkeypatch.setattr(native_memory, "_home", lambda: home)
    monkeypatch.setattr(app, "ui_settings_store", FakeSettingsStore())
    assert sync_scopes.MemoryScope().apply(".claude:CLAUDE.md", {"text": "new\n"}) is True
    assert link.is_symlink()
    assert real.read_text() == "new\n"


# ── deletes: kept here, never pushed back (memory and skills, one rule) ──────
async def test_memory_delete_elsewhere_keeps_the_file_and_does_not_resurrect(tmp_path, account_key, monkeypatch):
    server = StrictServer()
    ha, hb = _home(tmp_path, "a"), _home(tmp_path, "b")
    (ha / ".claude" / "CLAUDE.md").write_text("hello\n")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.MemoryScope(), home=ha)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.MemoryScope(), home=hb)
    await a.sync(); await b.sync()
    (ha / ".claude" / "CLAUDE.md").unlink()
    for _ in range(2):
        await a.sync(); await b.sync()
    assert not (ha / ".claude" / "CLAUDE.md").exists()           # stays deleted where it was deleted
    assert (hb / ".claude" / "CLAUDE.md").read_text() == "hello\n"  # B's file is the user's, kept
    assert server.rows[("memory", ".claude:CLAUDE.md")]["deleted"] == 1
    pushes = server.pushes
    await a.sync(); await b.sync()
    assert server.pushes == pushes                                 # settled

    # Editing the kept copy is a new decision: it goes up again.
    (hb / ".claude" / "CLAUDE.md").write_text("hello again\n")
    await b.sync(); await a.sync()
    assert (ha / ".claude" / "CLAUDE.md").read_text() == "hello again\n"


def _skills(tmp_path, tag):
    from agent_team_backend.skills_store import SkillsStore

    root = tmp_path / tag / "agents" / "skills"
    store = SkillsStore(root=root, state_path=tmp_path / tag / "skills.json",
                        runtime_root=tmp_path / tag / "runtime", native_roots=[tmp_path / tag / "native"])
    return store, root


def _skill_pair(tmp_path, monkeypatch, server=None):
    server = server or StrictServer()
    sa, ra = _skills(tmp_path, "A")
    sb, rb = _skills(tmp_path, "B")
    a = Dev(tmp_path, server, "A", monkeypatch, sync_scopes.SkillsStateScope(), skills_store=sa)
    b = Dev(tmp_path, server, "B", monkeypatch, sync_scopes.SkillsStateScope(), skills_store=sb)
    return server, a, b, sa, ra, sb, rb


async def test_skill_delete_elsewhere_keeps_the_files_and_does_not_resurrect(tmp_path, account_key, monkeypatch):
    monkeypatch.setattr(sync_scopes.SkillFilesScope, "available", lambda self: False)
    server, a, b, sa, ra, sb, rb = _skill_pair(tmp_path, monkeypatch)
    sa.create_skill("writer", "writes", consent=True)
    await a.sync(); await b.sync()
    assert (rb / "writer" / "SKILL.md").is_file()
    a.use(); sa.delete_skill("writer")
    for _ in range(2):
        await a.sync(); await b.sync()
    assert not (ra / "writer").exists()
    assert (rb / "writer" / "SKILL.md").is_file()
    assert server.rows[("skills", "writer")]["deleted"] == 1
    pushes = server.pushes
    await a.sync(); await b.sync()
    assert server.pushes == pushes
