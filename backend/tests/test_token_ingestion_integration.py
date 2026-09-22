"""End-to-end token ingestion across reader, watcher, attribution, and store."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.log_readers import (
    ClaudeLogReader,
    LogWatcher,
    TokenSinkResult,
    TokenUsage,
)
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.claude import encode_claude_cwd
from agent_team_backend.tokens_store import TokensStore


def _usage_record(msg_id: str, request_id: str, input_tokens: int, output_tokens: int) -> dict:
    return {
        "type": "assistant",
        "requestId": request_id,
        "timestamp": "2026-07-15T00:00:00Z",
        "message": {
            "id": msg_id,
            "model": "claude-test",
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            },
        },
    }


def _append(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def _store(tmp_path: Path) -> TokensStore:
    return TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
        ingestion_state_path=tmp_path / "token-ingestion-state.json",
    )


def _watcher(
    reader: ClaudeLogReader,
    attribution: Attribution,
    store: TokensStore,
) -> LogWatcher:
    async def sink(usage: TokenUsage) -> TokenSinkResult:
        attributed = attribution.attribute(usage)
        workspace = usage.replay_workspace or attributed.workspace_path
        if not workspace:
            return TokenSinkResult(False)
        composite = f"{usage.vendor}::{usage.file_path}::{usage.dedup_key}"
        handled = store.record(
            workspace,
            source="cli",
            vendor=usage.vendor,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            dedup_key=composite,
            legacy_dedup_key=usage.dedup_key,
            ingestion_file=usage.file_path,
            ingestion_checkpoint=usage.checkpoint,
            replay_workspace=usage.replay_workspace,
        )
        return TokenSinkResult(handled, workspace)

    watcher = LogWatcher(
        sink=sink,
        checkpoint_provider=store.get_ingestion_checkpoint,
        checkpoint_sink=store.advance_ingestion_checkpoint,
    )
    watcher.add_reader(reader)
    return watcher


@pytest.mark.asyncio
async def test_ingestion_restart_append_and_workspace_replay(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = tmp_path / "claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(config))
    workspace_path = tmp_path / "workspace"
    workspace_path.mkdir()
    workspace = str(workspace_path)
    project_dir = config / "projects" / encode_claude_cwd(workspace)
    session = project_dir / "session-1.jsonl"
    _append(session, _usage_record("m1", "r1", 100, 40))

    reader = ClaudeLogReader()
    attribution = Attribution([reader], workspaces_path=tmp_path / "known-workspaces.json")
    attribution.register_workspace(workspace)

    first_store = _store(tmp_path)
    first_watcher = _watcher(reader, attribution, first_store)
    await first_watcher._process_path(session)
    first = first_store.snapshot(workspace)
    assert first["global"]["all_time"] == {"input": 100, "output": 40, "calls": 1}
    assert first["workspace"]["cumulative"]["totals"] == first["global"]["all_time"]
    first_store.flush()

    # A new backend instance reads the persisted checkpoint and does not replay
    # the unchanged historic event.
    restarted_store = _store(tmp_path)
    restarted_watcher = _watcher(reader, attribution, restarted_store)
    await restarted_watcher._process_path(session)
    unchanged = restarted_store.snapshot(workspace)
    assert unchanged["global"]["all_time"]["calls"] == 1

    _append(session, _usage_record("m2", "r2", 25, 10))
    await restarted_watcher._process_path(session)
    appended = restarted_store.snapshot(workspace)
    assert appended["global"]["all_time"] == {"input": 125, "output": 50, "calls": 2}
    assert appended["workspace"]["cumulative"]["totals"] == appended["global"]["all_time"]

    # Resetting one workspace clears only its checkpoint. Replaying the source
    # restores workspace totals while Global remains unchanged.
    restarted_store.reset("workspace", workspace)
    await restarted_watcher._process_path(session, workspace)
    replayed = restarted_store.snapshot(workspace)
    assert replayed["global"]["all_time"] == {"input": 125, "output": 50, "calls": 2}
    assert replayed["workspace"]["cumulative"]["totals"] == {
        "input": 125,
        "output": 50,
        "calls": 2,
    }
    restarted_store.flush()


# ── run-group attribution through the real handler + sink ────────────────────

from agent_team_backend import app  # noqa: E402

from .test_app_terminal_create import _session, _stub_agent_cli_probe  # noqa: E402, F401


@pytest.mark.asyncio
async def test_terminal_create_run_group_reaches_cumulative_by_group(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """terminal.create with metadata.run_group_id → usage on that pane's
    session → the workspace snapshot carries cumulative.by_group[<group>]."""
    config = tmp_path / "claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(config))
    workspace_path = tmp_path / "workspace"
    workspace_path.mkdir()
    workspace = str(workspace_path)
    session_file = config / "projects" / encode_claude_cwd(workspace) / "sess-1.jsonl"
    session_file.parent.mkdir(parents=True)
    session_file.write_text("")

    attribution = Attribution([ClaudeLogReader()], workspaces_path=tmp_path / "known-workspaces.json")
    store = _store(tmp_path)
    monkeypatch.setattr(app, "attribution", attribution)
    monkeypatch.setattr(app, "tokens_store", store)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(app, "track_live_session", lambda **_kwargs: None)
    monkeypatch.setattr(app, "_schedule_tokens_broadcast", lambda _ws: None)

    await app.handle_message(_session(), {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "grouped-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": workspace,
            "metadata": {
                "workspace_path": workspace,
                "explicit_session_id": "sess-1",
                "run_group_id": "rg-1",
            },
        },
    })

    result = await app._on_log_token_usage(TokenUsage(
        vendor="claude", input_tokens=100, output_tokens=40, cwd=workspace,
        session_id="sess-1", file_path=str(session_file), dedup_key="m1::r1",
    ))
    assert result.handled is True

    cumulative = store.snapshot(workspace)["workspace"]["cumulative"]
    assert cumulative["by_group"] == {"rg-1": {"input": 100, "output": 40, "calls": 1}}

    # Moving the pane re-points what comes next; the first bucket stays put.
    assert attribution.set_pane_group("grouped-pane", "rg-2") is True
    await app._on_log_token_usage(TokenUsage(
        vendor="claude", input_tokens=1, output_tokens=2, cwd=workspace,
        session_id="sess-1", file_path=str(session_file), dedup_key="m2::r2",
    ))
    cumulative = store.snapshot(workspace)["workspace"]["cumulative"]
    assert cumulative["by_group"] == {
        "rg-1": {"input": 100, "output": 40, "calls": 1},
        "rg-2": {"input": 1, "output": 2, "calls": 1},
    }
