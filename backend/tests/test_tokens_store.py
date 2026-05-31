"""Token aggregator + atomic JSON persistence tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.tokens_store import TokensStore


@pytest.fixture
def store(tmp_path: Path) -> TokensStore:
    """Fresh store with a temp global file (no contamination from real env)."""
    return TokensStore(global_path=tmp_path / "global-tokens.json")


@pytest.fixture
def workspace(tmp_path: Path) -> str:
    ws = tmp_path / "ws"
    ws.mkdir()
    return str(ws)


def test_no_recording_when_both_token_counts_zero(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(
        workspace, source="cli", vendor="claude",
        input_tokens=0, output_tokens=0,
    )
    snap = store.snapshot(workspace)
    assert snap["workspace"]["current_run"]["totals"]["calls"] == 0


def test_record_updates_current_run_cumulative_and_global(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(
        workspace, source="analyzer", vendor="analyzer",
        stage_id="01", pane_id="pane-a",
        input_tokens=100, output_tokens=200,
    )
    snap = store.snapshot(workspace)

    run = snap["workspace"]["current_run"]
    assert run["totals"] == {"input": 100, "output": 200, "calls": 1}
    assert run["by_vendor"]["analyzer"] == {"input": 100, "output": 200, "calls": 1}
    assert run["by_stage"]["01"] == {"input": 100, "output": 200, "calls": 1}
    assert run["by_pane"]["pane-a"] == {"input": 100, "output": 200, "calls": 1}

    cum = snap["workspace"]["cumulative"]
    assert cum["totals"] == {"input": 100, "output": 200, "calls": 1}

    assert snap["global"]["all_time"] == {"input": 100, "output": 200, "calls": 1}
    assert snap["global"]["by_vendor"]["analyzer"] == {"input": 100, "output": 200, "calls": 1}


def test_two_calls_sum_correctly(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(workspace, source="cli", vendor="claude", stage_id="02",
                 input_tokens=10, output_tokens=20)
    store.record(workspace, source="cli", vendor="claude", stage_id="02",
                 input_tokens=5, output_tokens=15)
    snap = store.snapshot(workspace)
    assert snap["workspace"]["current_run"]["by_vendor"]["claude"] == {
        "input": 15, "output": 35, "calls": 2,
    }


def test_starting_new_run_archives_previous(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t1", run_dir="runs/r1")
    store.record(workspace, source="cli", vendor="claude",
                 input_tokens=1, output_tokens=1)
    store.start_run(workspace, run_id="r2", task="t2", run_dir="runs/r2")
    snap = store.snapshot(workspace)
    assert snap["workspace"]["current_run"]["run_id"] == "r2"
    assert snap["workspace"]["current_run"]["totals"]["calls"] == 0
    # Previous run archived with its 1 call
    assert any(r["run_id"] == "r1" and r["totals"]["calls"] == 1
               for r in snap["workspace"]["runs"])


def test_persistence_roundtrip(tmp_path: Path) -> None:
    global_path = tmp_path / "global.json"
    workspace = tmp_path / "ws"
    workspace.mkdir()

    s1 = TokensStore(global_path=global_path)
    s1.start_run(str(workspace), run_id="r1", task="t", run_dir="runs/r1")
    s1.record(str(workspace), source="analyzer", vendor="analyzer",
              input_tokens=10, output_tokens=20)

    # Both files exist on disk
    assert global_path.exists()
    assert (workspace / ".agent-team" / "tokens.json").exists()

    # Fresh store reads back the same values
    s2 = TokensStore(global_path=global_path)
    snap = s2.snapshot(str(workspace))
    assert snap["workspace"]["cumulative"]["totals"]["input"] == 10
    assert snap["global"]["all_time"]["output"] == 20


def test_atomic_write_uses_tmp_then_replace(tmp_path: Path) -> None:
    """The .tmp file shouldn't survive after a successful save."""
    global_path = tmp_path / "global.json"
    workspace = tmp_path / "ws"
    workspace.mkdir()
    s = TokensStore(global_path=global_path)
    s.start_run(str(workspace), run_id="r1", task="t", run_dir="runs/r1")
    s.record(str(workspace), source="cli", vendor="codex",
             input_tokens=5, output_tokens=5)

    files = list((workspace / ".agent-team").iterdir())
    # Only tokens.json should remain — no leftover .tmp
    assert {f.name for f in files} == {"tokens.json"}


def test_reset_run_clears_current_but_keeps_cumulative(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(workspace, source="cli", vendor="claude",
                 input_tokens=100, output_tokens=200)
    snap = store.reset("run", workspace_path=workspace)
    assert snap["workspace"]["current_run"]["totals"]["calls"] == 0
    # Cumulative + global preserved
    assert snap["workspace"]["cumulative"]["totals"]["input"] == 100
    assert snap["global"]["all_time"]["input"] == 100


def test_reset_workspace_clears_only_workspace(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(workspace, source="cli", vendor="claude",
                 input_tokens=10, output_tokens=20)
    snap = store.reset("workspace", workspace_path=workspace)
    assert snap["workspace"]["cumulative"]["totals"]["calls"] == 0
    # Global preserved
    assert snap["global"]["all_time"]["calls"] == 1


def test_reset_global_clears_global(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    store.record(workspace, source="cli", vendor="claude",
                 input_tokens=10, output_tokens=20)
    snap = store.reset("global", workspace_path=workspace)
    assert snap["global"]["all_time"]["calls"] == 0
    # Workspace data preserved
    assert snap["workspace"]["cumulative"]["totals"]["calls"] == 1


def test_reset_unknown_scope_raises(store: TokensStore) -> None:
    with pytest.raises(ValueError):
        store.reset("bogus", workspace_path=None)


def test_record_with_no_workspace_only_updates_global(store: TokensStore, tmp_path: Path) -> None:
    # No workspace_path → workspace state is untouched, global still gets it
    store.record(None, source="analyzer", vendor="analyzer",
                 input_tokens=7, output_tokens=11)
    snap = store.snapshot(None)
    assert snap["global"]["all_time"]["input"] == 7
    # workspace doc should be a blank shell
    assert snap["workspace"]["cumulative"]["totals"]["calls"] == 0


def test_corrupt_json_recovers_gracefully(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / ".agent-team").mkdir()
    (workspace / ".agent-team" / "tokens.json").write_text("{not valid json", encoding="utf-8")

    s = TokensStore(global_path=tmp_path / "g.json")
    snap = s.snapshot(str(workspace))
    # Should fall back to empty doc, not raise
    assert snap["workspace"]["cumulative"]["totals"]["calls"] == 0


def test_record_negative_tokens_clamped_to_zero(store: TokensStore, workspace: str) -> None:
    store.start_run(workspace, run_id="r1", task="t", run_dir="runs/r1")
    # A bad parser might pass negatives — we silently treat as zero.
    store.record(workspace, source="cli", vendor="claude",
                 input_tokens=-10, output_tokens=5)
    snap = store.snapshot(workspace)
    # input clamped to 0, output 5 → still recorded (calls=1)
    assert snap["workspace"]["current_run"]["totals"] == {
        "input": 0, "output": 5, "calls": 1,
    }
