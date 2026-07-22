"""SpawnHistoryStore — full per-workspace spawn history + pagination.

Covers merge upsert semantics (replace by paneId, never delete), the one-time
migration seeded from the project.json mirror, newest-first page reads with
offset/limit edge cases, corrupt-file recovery, the runaway-size cap, and the
project.get_spawn_history ws handler.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agent_team_backend import spawn_history as spawn_history_module
from agent_team_backend.projects import ProjectStore
from agent_team_backend.spawn_history import SpawnHistoryStore


def _entry(pane_id: str, **fields: Any) -> dict[str, Any]:
    return {"paneId": pane_id, "agentKey": "claude", **fields}


def _stored_entries(store: SpawnHistoryStore, ws: Path) -> list[dict[str, Any]]:
    data = json.loads(store.history_file(str(ws)).read_text(encoding="utf-8"))
    return data["entries"]


# ── merge ────────────────────────────────────────────────────────────────────


def test_merge_appends_new_entries_in_order(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    total = store.merge(str(tmp_path), [_entry("p1"), _entry("p2")])
    assert total == 2
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == ["p1", "p2"]


def test_merge_upserts_existing_entry_in_place(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("p1"), _entry("p2")])
    store.merge(str(tmp_path), [_entry("p1", customName="Renamed", sessionId="s-1")])
    entries = _stored_entries(store, tmp_path)
    # Position preserved (oldest → newest by spawn), fields updated.
    assert [e["paneId"] for e in entries] == ["p1", "p2"]
    assert entries[0]["customName"] == "Renamed"
    assert entries[0]["sessionId"] == "s-1"


def test_merge_replacement_clears_fields_the_renderer_removed(tmp_path: Path) -> None:
    """A reset customName is dropped from the entry JSON — replacement must not
    resurrect it from the stored copy."""
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("p1", customName="Old name")])
    store.merge(str(tmp_path), [_entry("p1")])
    assert "customName" not in _stored_entries(store, tmp_path)[0]


def test_merge_never_deletes_entries_absent_from_payload(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry(f"p{i}") for i in range(5)])
    # A later (windowed) snapshot containing only the newest entry.
    store.merge(str(tmp_path), [_entry("p4", removedAt="2026-07-22T00:00:00Z")])
    entries = _stored_entries(store, tmp_path)
    assert [e["paneId"] for e in entries] == ["p0", "p1", "p2", "p3", "p4"]
    assert entries[4]["removedAt"] == "2026-07-22T00:00:00Z"


def test_merge_skips_entries_without_pane_id(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    total = store.merge(
        str(tmp_path), [_entry("p1"), {"agentKey": "claude"}, {"paneId": ""}, "junk"]  # type: ignore[list-item]
    )
    assert total == 1
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == ["p1"]


def test_merge_cap_drops_oldest_and_warns(tmp_path: Path, monkeypatch, caplog) -> None:
    monkeypatch.setattr(spawn_history_module, "MAX_ENTRIES", 3)
    store = SpawnHistoryStore()
    with caplog.at_level("WARNING", logger="agent_team_backend.spawn_history"):
        total = store.merge(str(tmp_path), [_entry(f"p{i}") for i in range(5)])
    assert total == 3
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == ["p2", "p3", "p4"]
    assert any("dropped 2 oldest" in r.message for r in caplog.records)


def test_merge_seeds_from_mirror_only_when_file_missing(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    seed = [_entry("old-1"), _entry("old-2")]
    store.merge(str(tmp_path), [_entry("new-1")], seed=seed)
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == [
        "old-1", "old-2", "new-1",
    ]
    # Once the file exists the seed is ignored — no duplicate resurrection.
    store.merge(str(tmp_path), [_entry("new-2")], seed=seed)
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == [
        "old-1", "old-2", "new-1", "new-2",
    ]


# ── read_page ────────────────────────────────────────────────────────────────


def test_read_page_returns_newest_first_with_total(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry(f"p{i}") for i in range(5)])
    page, total = store.read_page(str(tmp_path), offset=0, limit=2)
    assert total == 5
    assert [e["paneId"] for e in page] == ["p4", "p3"]


def test_read_page_offset_walks_toward_oldest(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry(f"p{i}") for i in range(5)])
    page, _ = store.read_page(str(tmp_path), offset=2, limit=2)
    assert [e["paneId"] for e in page] == ["p2", "p1"]


def test_read_page_limit_past_end_clips(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry(f"p{i}") for i in range(3)])
    page, total = store.read_page(str(tmp_path), offset=2, limit=10)
    assert total == 3
    assert [e["paneId"] for e in page] == ["p0"]


def test_read_page_out_of_range_offset_returns_empty(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("p0")])
    page, total = store.read_page(str(tmp_path), offset=99, limit=10)
    assert page == []
    assert total == 1


def test_read_page_missing_file_and_no_seed_is_empty(tmp_path: Path) -> None:
    page, total = SpawnHistoryStore().read_page(str(tmp_path), offset=0, limit=10)
    assert page == []
    assert total == 0
    assert not SpawnHistoryStore().history_file(str(tmp_path)).exists()


def test_read_page_seeds_migration_from_mirror_and_persists(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    seed = [_entry("m1"), _entry("m2")]
    page, total = store.read_page(str(tmp_path), offset=0, limit=10, seed=seed)
    assert total == 2
    assert [e["paneId"] for e in page] == ["m2", "m1"]
    # The migration is written through: later reads work without the mirror.
    assert store.history_file(str(tmp_path)).exists()
    page2, total2 = store.read_page(str(tmp_path), offset=0, limit=10)
    assert total2 == 2
    assert [e["paneId"] for e in page2] == ["m2", "m1"]


# ── corrupt-file recovery ────────────────────────────────────────────────────


def test_corrupt_file_is_backed_up_and_store_starts_empty(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    hf = store.history_file(str(tmp_path))
    hf.parent.mkdir(parents=True)
    hf.write_text("{ not json", encoding="utf-8")
    page, total = store.read_page(str(tmp_path), offset=0, limit=10)
    assert page == []
    assert total == 0
    backup = hf.with_suffix(hf.suffix + ".corrupt")
    assert backup.read_text(encoding="utf-8") == "{ not json"
    # The store recovers: merging works again on the fresh file.
    store.merge(str(tmp_path), [_entry("p1")])
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == ["p1"]


def test_wrong_shape_is_treated_as_corrupt(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    hf = store.history_file(str(tmp_path))
    hf.parent.mkdir(parents=True)
    hf.write_text(json.dumps({"entries": "nope"}), encoding="utf-8")
    page, total = store.read_page(str(tmp_path), offset=0, limit=10)
    assert page == []
    assert total == 0
    assert hf.with_suffix(hf.suffix + ".corrupt").exists()


# ── project.get_spawn_history ws handler ─────────────────────────────────────


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


async def test_get_spawn_history_handler_pages_and_migrates(
    tmp_path: Path, monkeypatch
) -> None:
    """The handler pages newest-first and seeds the full store from the
    project.json mirror on first read (old-project migration)."""
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    mirror = [_entry(f"p{i}", workspacePath=str(tmp_path)) for i in range(3)]
    store.set_ui_state(str(tmp_path), spawn_history=mirror)
    monkeypatch.setattr(app, "project_store", store)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.get_spawn_history")
    assert fn is not None
    await fn(session, "m1", "project.get_spawn_history", {
        "workspace_path": str(tmp_path),
        "offset": 1,
        "limit": 1,
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["total"] == 3
    assert resp["payload"]["offset"] == 1
    assert [e["paneId"] for e in resp["payload"]["entries"]] == ["p1"]
    # First paged read migrated the mirror into the full store.
    assert app.spawn_history_store.history_file(str(tmp_path)).exists()


async def test_get_spawn_history_handler_defaults_bad_params(
    tmp_path: Path, monkeypatch
) -> None:
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    app.spawn_history_store.merge(str(tmp_path), [_entry("p1")])
    monkeypatch.setattr(app, "project_store", store)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.get_spawn_history")
    assert fn is not None
    await fn(session, "m1", "project.get_spawn_history", {
        "workspace_path": str(tmp_path),
        "offset": -5,
        "limit": "huge",
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["offset"] == 0
    assert resp["payload"]["total"] == 1
    assert [e["paneId"] for e in resp["payload"]["entries"]] == ["p1"]


# ── workspace isolation (write-layer filter + symlink canonicalization) ─────


def test_merge_drops_foreign_workspace_entries_and_warns(
    tmp_path: Path, caplog
) -> None:
    """merge() never persists another workspace's entries; entries without a
    workspacePath (legacy data) still pass through."""
    ws = tmp_path / "ws"
    other = tmp_path / "other"
    ws.mkdir()
    other.mkdir()
    store = SpawnHistoryStore()
    with caplog.at_level("WARNING", logger="agent_team_backend.spawn_history"):
        total = store.merge(str(ws), [
            _entry("mine", workspacePath=str(ws)),
            _entry("foreign", workspacePath=str(other)),
            _entry("legacy"),
        ])
    assert total == 2
    assert [e["paneId"] for e in _stored_entries(store, ws)] == ["mine", "legacy"]
    assert any(
        "dropped 1 foreign spawn-history entries" in r.message for r in caplog.records
    )


def test_symlink_alias_and_real_path_share_one_store(tmp_path: Path) -> None:
    """Both spellings of a symlinked workspace read/write the same file, and
    entries recorded under either spelling count as equivalent."""
    real = tmp_path / "real"
    real.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    store = SpawnHistoryStore()
    # Cross-spelled on purpose: each merge target uses the other spelling.
    store.merge(str(real), [_entry("p1", workspacePath=str(alias))])
    store.merge(str(alias), [_entry("p2", workspacePath=str(real))])
    assert store.history_file(str(alias)) == store.history_file(str(real))
    page, total = store.read_page(str(alias))
    assert total == 2
    assert [e["paneId"] for e in page] == ["p2", "p1"]


def test_seed_migration_drops_foreign_mirror_entries(tmp_path: Path) -> None:
    """A pre-filter mirror may hold foreign entries — they never migrate in."""
    ws = tmp_path / "ws"
    ws.mkdir()
    store = SpawnHistoryStore()
    seed = [
        _entry("mine", workspacePath=str(ws)),
        _entry("foreign", workspacePath=str(tmp_path / "other")),
    ]
    page, total = store.read_page(str(ws), seed=seed)
    assert total == 1
    assert [e["paneId"] for e in page] == ["mine"]


async def test_get_spawn_history_handler_returns_canonical_workspace_path(
    tmp_path: Path, monkeypatch
) -> None:
    """The response carries the symlink-resolved workspace identity, and an
    alias spelling serves the store written under the real one."""
    from agent_team_backend import app, ws_handlers

    real = tmp_path / "real"
    real.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    store = ProjectStore()
    store.save(store.load_or_create(str(alias)))
    monkeypatch.setattr(app, "project_store", store)
    app.spawn_history_store.merge(str(real), [_entry("p1", workspacePath=str(real))])

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.get_spawn_history")
    assert fn is not None
    await fn(session, "m1", "project.get_spawn_history", {
        "workspace_path": str(alias),
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["canonical_workspace_path"] == str(real.resolve())
    assert [e["paneId"] for e in resp["payload"]["entries"]] == ["p1"]
