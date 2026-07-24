"""Per-CLI-account (profile) token attribution: schema v2 dimension, the
v1→v2 migration, the flat read API, and the grok inode-keyed dedup invariant."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend import store_migrations as sm
from agent_team_backend.tokens_store import (
    DEFAULT_PROFILE_KEY,
    TOKENS_FILE,
    WORKSPACES_SUBDIR,
    TokensStore,
    migrate_tokens_v1_to_v2,
)


@pytest.fixture
def store(tmp_path: Path) -> TokensStore:
    return TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
    )


@pytest.fixture
def workspace(tmp_path: Path) -> str:
    ws = tmp_path / "ws"
    ws.mkdir()
    return str(ws)


def _write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


# ─────────────────── recording (schema v2) ───────────────────


def test_cli_record_credits_profile_globally_and_per_workspace(store, workspace) -> None:
    store.record(
        workspace, source="cli", vendor="claude", agent_key="claude",
        profile_id="acc1", input_tokens=10, output_tokens=20,
    )
    snap = store.snapshot(workspace)
    assert snap["global"]["by_profile"]["claude"]["acc1"] == {
        "input": 10, "output": 20, "calls": 1,
    }
    assert snap["workspace"]["cumulative"]["by_profile"]["claude"]["acc1"] == {
        "input": 10, "output": 20, "calls": 1,
    }
    # Existing dimensions stay backward-compatible.
    assert snap["global"]["by_vendor"]["claude"] == {"input": 10, "output": 20, "calls": 1}


def test_no_profile_records_as_default(store, workspace) -> None:
    store.record(
        workspace, source="cli", vendor="codex", agent_key="codex",
        input_tokens=5, output_tokens=7,
    )
    snap = store.snapshot(workspace)
    assert snap["global"]["by_profile"]["codex"] == {
        DEFAULT_PROFILE_KEY: {"input": 5, "output": 7, "calls": 1},
    }


def test_analyzer_source_has_no_profile_dimension(store, workspace) -> None:
    store.record(
        workspace, source="analyzer", vendor="analyzer",
        input_tokens=100, output_tokens=200,
    )
    snap = store.snapshot(workspace)
    assert snap["global"]["by_profile"] == {}
    assert snap["workspace"]["cumulative"]["by_profile"] == {}


def test_two_profiles_of_same_agent_are_separate(store, workspace) -> None:
    store.record(workspace, source="cli", vendor="claude", agent_key="claude",
                 profile_id="acc1", input_tokens=1, output_tokens=1)
    store.record(workspace, source="cli", vendor="claude", agent_key="claude",
                 profile_id="acc2", input_tokens=2, output_tokens=3)
    store.record(workspace, source="cli", vendor="claude", agent_key="claude",
                 input_tokens=4, output_tokens=5)  # default
    by_profile = store.snapshot(workspace)["global"]["by_profile"]["claude"]
    assert by_profile["acc1"] == {"input": 1, "output": 1, "calls": 1}
    assert by_profile["acc2"] == {"input": 2, "output": 3, "calls": 1}
    assert by_profile[DEFAULT_PROFILE_KEY] == {"input": 4, "output": 5, "calls": 1}


# ─────────────────── read API ───────────────────


def test_profile_usage_flat_list_translates_default_to_null(store, workspace) -> None:
    store.record(workspace, source="cli", vendor="claude", agent_key="claude",
                 profile_id="acc1", input_tokens=10, output_tokens=20)
    store.record(workspace, source="cli", vendor="claude", agent_key="claude",
                 input_tokens=1, output_tokens=2)  # default account
    store.record(workspace, source="analyzer", vendor="analyzer",
                 input_tokens=9, output_tokens=9)  # excluded from usage
    rows = store.profile_usage()
    keyed = {(r["agent_key"], r["profile_id"]): r["totals"] for r in rows}
    assert keyed[("claude", "acc1")] == {"input": 10, "output": 20, "calls": 1}
    assert keyed[("claude", None)] == {"input": 1, "output": 2, "calls": 1}
    assert ("analyzer", None) not in keyed


# ─────────────────── grok inode-keyed dedup invariant ───────────────────


def test_profile_does_not_break_grok_inode_dedup(store, workspace) -> None:
    """A replayed grok event (same dedup_key + checkpoint identity) must still
    be deduped — the profile_id dimension is not part of the dedup key."""
    checkpoint = {"kind": "sqlite", "identity": "inode-123", "row_id": 5}
    common = dict(
        source="cli", vendor="grok", agent_key="grok", profile_id="acc1",
        input_tokens=10, output_tokens=20, dedup_key="k1",
        ingestion_file="grok.db", ingestion_checkpoint=checkpoint,
    )
    assert store.record(workspace, **common) is True
    # Same event again → deduped, no double count (returns True = handled).
    assert store.record(workspace, **common) is True
    snap = store.snapshot(workspace)
    assert snap["global"]["all_time"] == {"input": 10, "output": 20, "calls": 1}
    assert snap["global"]["by_profile"]["grok"]["acc1"] == {
        "input": 10, "output": 20, "calls": 1,
    }


# ─────────────────── migration v1 → v2 ───────────────────


def _global_v1() -> dict:
    return {
        "schemaVersion": 1,
        "all_time": {"input": 30, "output": 60, "calls": 3},
        "by_vendor": {
            "claude": {"input": 20, "output": 40, "calls": 2},
            "analyzer": {"input": 10, "output": 20, "calls": 1},
        },
        "by_day": {},
    }


def _workspace_v1() -> dict:  # note: legacy workspace docs carry NO schemaVersion
    return {
        "current_run": None,
        "runs": [],
        "cumulative": {
            "totals": {"input": 20, "output": 40, "calls": 2},
            "by_vendor": {
                "claude": {"input": 20, "output": 40, "calls": 2},
                "analyzer": {"input": 5, "output": 5, "calls": 1},
            },
            "by_stage": {},
        },
    }


def test_migrate_global_seeds_default_and_excludes_analyzer() -> None:
    out = migrate_tokens_v1_to_v2(_global_v1())
    assert out["schemaVersion"] == 2
    assert out["by_profile"] == {
        "claude": {DEFAULT_PROFILE_KEY: {"input": 20, "output": 40, "calls": 2}},
    }


def test_migrate_workspace_seeds_cumulative_by_profile() -> None:
    out = migrate_tokens_v1_to_v2(_workspace_v1())
    assert out["schemaVersion"] == 2
    assert out["cumulative"]["by_profile"] == {
        "claude": {DEFAULT_PROFILE_KEY: {"input": 20, "output": 40, "calls": 2}},
    }


def test_migrate_is_idempotent() -> None:
    once = migrate_tokens_v1_to_v2(_global_v1())
    twice = migrate_tokens_v1_to_v2(once)
    assert twice is once  # already v2 → untouched (same object)
    assert twice["by_profile"]["claude"][DEFAULT_PROFILE_KEY]["calls"] == 2


def test_run_migrations_covers_global_and_per_workspace_files(tmp_path) -> None:
    global_path = tmp_path / TOKENS_FILE
    ws_path = tmp_path / WORKSPACES_SUBDIR / "abcd1234" / TOKENS_FILE
    _write_json(global_path, _global_v1())
    _write_json(ws_path, _workspace_v1())

    sm._run_migrations(tmp_path)

    g = json.loads(global_path.read_text(encoding="utf-8"))
    w = json.loads(ws_path.read_text(encoding="utf-8"))
    assert g["schemaVersion"] == 2
    assert g["by_profile"]["claude"][DEFAULT_PROFILE_KEY]["calls"] == 2
    assert w["schemaVersion"] == 2
    assert w["cumulative"]["by_profile"]["claude"][DEFAULT_PROFILE_KEY]["calls"] == 2

    # Idempotent on disk: a second pass leaves the bytes untouched.
    before_g, before_w = global_path.read_bytes(), ws_path.read_bytes()
    sm._run_migrations(tmp_path)
    assert global_path.read_bytes() == before_g
    assert ws_path.read_bytes() == before_w


def test_store_load_seeds_by_profile_from_v1_global(tmp_path) -> None:
    """The store is constructed before store_migrations runs at startup, so it
    must seed by_profile itself when it loads a v1 global doc on disk."""
    _write_json(tmp_path / "tokens.json", _global_v1())
    store = TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
    )
    snap = store.snapshot(None)
    assert snap["global"]["by_profile"]["claude"][DEFAULT_PROFILE_KEY]["calls"] == 2
