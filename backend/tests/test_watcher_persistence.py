"""LogWatcher: seen_keys persistence between backend restarts.

This is the fix for the "Global keeps jumping after restart" bug. Without
persistence, every restart re-emits all events from every existing log file
because seen_keys starts empty.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from agent_team_backend.log_readers.base import (
    IncrementalParseResult,
    LogReader,
    TokenSinkResult,
    TokenUsage,
)
from agent_team_backend.log_readers.watcher import LogWatcher
from agent_team_backend.tokens_store import TokensStore


class _StaticReader(LogReader):
    """Deterministic stub: returns the same events every parse, but uses
    seen_keys to dedup (so behaviour matches real readers)."""

    def __init__(self, root: Path) -> None:
        self.vendor = "claude"
        self.root = root
        self.call_count = 0

    def project_dirs(self) -> list[Path]:
        return [self.root] if self.root.is_dir() else []

    def session_files(self) -> list[Path]:
        if not self.root.is_dir():
            return []
        return list(self.root.rglob("*.jsonl"))

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        self.call_count += 1
        # One canonical event per file.
        key = f"event-for-{path.name}"
        if key in seen_keys:
            return []
        seen_keys.add(key)
        return [
            TokenUsage(
                vendor="claude",
                input_tokens=10,
                output_tokens=5,
                cwd="/x",
                session_id=path.stem,
                file_path=str(path),
                dedup_key=key,
            )
        ]


class _SharedReader(_StaticReader):
    """One source file containing events for two different workspaces."""

    def parse_incremental(self, path: Path, checkpoint: dict) -> IncrementalParseResult:
        if checkpoint:
            return IncrementalParseResult([], checkpoint)
        events = [
            TokenUsage(
                vendor="grok", input_tokens=10, output_tokens=1, cwd="/ws/other",
                session_id="s1", file_path=str(path), dedup_key="usage:1",
                checkpoint={"kind": "sqlite", "row_id": 1, "identity": "1:1"},
            ),
            TokenUsage(
                vendor="grok", input_tokens=20, output_tokens=2, cwd="/ws/target",
                session_id="s2", file_path=str(path), dedup_key="usage:2",
                checkpoint={"kind": "sqlite", "row_id": 2, "identity": "1:1"},
            ),
        ]
        return IncrementalParseResult(
            events, {"kind": "sqlite", "row_id": 2, "identity": "1:1"}
        )


async def _drain_briefly(watcher: LogWatcher, ms: int = 1500) -> None:
    """Let the watcher's drain loop + save loop process whatever is queued.

    Must exceed (initial 0.5s rescan delay + save_interval_s) so the first
    scan completes AND a save flush happens before stop(). Bumped to 1500ms
    so the test isn't flaky when the full suite competes for CPU.
    """
    await asyncio.sleep(ms / 1000)


def _checkpoint_store(tmp_path: Path) -> TokensStore:
    return TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
        ingestion_state_path=tmp_path / "token-ingestion-state.json",
    )


def _watcher(store: TokensStore, sink, **kwargs) -> LogWatcher:
    return LogWatcher(
        sink=sink,
        checkpoint_provider=store.get_ingestion_checkpoint,
        checkpoint_sink=store.advance_ingestion_checkpoint,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_seen_keys_persist_between_watcher_starts(tmp_path: Path) -> None:
    root = tmp_path / "logs"
    root.mkdir()
    f1 = root / "a.jsonl"; f1.write_text("")

    received: list[TokenUsage] = []

    async def sink(u: TokenUsage) -> TokenSinkResult:
        received.append(u)
        return TokenSinkResult(True, "/x")

    state_path = tmp_path / "token-ingestion-state.json"

    # ── First watcher run: should emit 1 event ────────────────────────────
    reader1 = _StaticReader(root)
    store1 = _checkpoint_store(tmp_path)
    w1 = _watcher(store1, sink, rescan_interval_s=0.1)
    w1.add_reader(reader1)
    w1.start()
    await _drain_briefly(w1, 1500)
    w1.stop()
    store1.flush()
    assert len(received) == 1, f"expected 1 event from initial backfill, got {len(received)}"

    assert state_path.exists(), "TokensStore should persist the unified checkpoint"
    data = json.loads(state_path.read_text(encoding="utf-8"))
    assert data["version"] == 2
    assert any(
        "event-for-a.jsonl" in entry["global"].get("legacy_seen", [])
        for entry in data["files"].values()
    )

    # ── Second watcher run with same files: should emit 0 events ──────────
    received.clear()
    reader2 = _StaticReader(root)
    store2 = _checkpoint_store(tmp_path)
    w2 = _watcher(store2, sink, rescan_interval_s=0.1)
    w2.add_reader(reader2)
    w2.start()
    await _drain_briefly(w2, 1500)
    w2.stop()
    store2.flush()
    assert received == [], (
        f"after restart, watcher must NOT re-emit historic events. "
        f"got {len(received)} (this is the 'Global keeps jumping' bug)"
    )


@pytest.mark.asyncio
async def test_new_file_after_restart_still_fires(tmp_path: Path) -> None:
    root = tmp_path / "logs"
    root.mkdir()
    (root / "a.jsonl").write_text("")

    received: list[TokenUsage] = []

    async def sink(u: TokenUsage) -> TokenSinkResult:
        received.append(u)
        return TokenSinkResult(True, "/x")

    # Run 1: process the existing file
    store1 = _checkpoint_store(tmp_path)
    w1 = _watcher(store1, sink, rescan_interval_s=0.1)
    w1.add_reader(_StaticReader(root))
    w1.start(); await _drain_briefly(w1, 1500); w1.stop(); store1.flush()
    assert len(received) == 1

    # Run 2: new file appears between runs
    (root / "b.jsonl").write_text("")
    received.clear()
    store2 = _checkpoint_store(tmp_path)
    w2 = _watcher(store2, sink, rescan_interval_s=0.1)
    w2.add_reader(_StaticReader(root))
    w2.start(); await _drain_briefly(w2, 1500); w2.stop(); store2.flush()
    # Old file: no re-emit. New file: 1 event.
    assert len(received) == 1
    assert received[0].file_path.endswith("b.jsonl")


@pytest.mark.asyncio
async def test_corrupt_seen_file_starts_empty(tmp_path: Path) -> None:
    """Garbage in seen.json shouldn't crash startup."""
    root = tmp_path / "logs"; root.mkdir()
    (root / "x.jsonl").write_text("")
    state_path = tmp_path / "token-ingestion-state.json"
    state_path.write_text("{ not json", encoding="utf-8")

    received: list[TokenUsage] = []
    async def sink(u: TokenUsage) -> TokenSinkResult:
        received.append(u)
        return TokenSinkResult(True, "/x")

    store = _checkpoint_store(tmp_path)
    w = _watcher(store, sink, rescan_interval_s=0.1)
    w.add_reader(_StaticReader(root))
    w.start(); await _drain_briefly(w, 1500); w.stop()
    # Fallback: start empty → emit once.
    assert len(received) == 1


@pytest.mark.asyncio
async def test_workspace_replay_continues_past_foreign_shared_source_rows(
    tmp_path: Path,
) -> None:
    root = tmp_path / "logs"
    root.mkdir()
    source = root / "grok.db"
    source.write_text("")
    handled: list[str] = []

    async def sink(usage: TokenUsage) -> TokenSinkResult:
        handled.append(usage.cwd)
        if usage.cwd != usage.replay_workspace:
            return TokenSinkResult(True)  # safely skipped for this replay scope
        return TokenSinkResult(True, usage.replay_workspace)

    watcher = LogWatcher(sink=sink)
    watcher.add_reader(_SharedReader(root))
    await watcher._process_path(source, "/ws/target")

    assert handled == ["/ws/other", "/ws/target"]
    checkpoint = watcher._local_checkpoint(str(source.resolve()), "/ws/target")
    assert checkpoint["row_id"] == 2
