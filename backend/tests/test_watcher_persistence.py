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

from agent_team_backend.log_readers.base import LogReader, TokenUsage
from agent_team_backend.log_readers.watcher import LogWatcher


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


async def _drain_briefly(watcher: LogWatcher, ms: int = 1500) -> None:
    """Let the watcher's drain loop + save loop process whatever is queued.

    Must exceed (initial 0.5s rescan delay + save_interval_s) so the first
    scan completes AND a save flush happens before stop(). Bumped to 1500ms
    so the test isn't flaky when the full suite competes for CPU.
    """
    await asyncio.sleep(ms / 1000)


@pytest.mark.asyncio
async def test_seen_keys_persist_between_watcher_starts(tmp_path: Path) -> None:
    root = tmp_path / "logs"
    root.mkdir()
    f1 = root / "a.jsonl"; f1.write_text("")

    received: list[TokenUsage] = []

    async def sink(u: TokenUsage) -> None:
        received.append(u)

    seen_path = tmp_path / "seen.json"

    # ── First watcher run: should emit 1 event ────────────────────────────
    reader1 = _StaticReader(root)
    w1 = LogWatcher(
        sink=sink, seen_path=seen_path,
        rescan_interval_s=0.1, save_interval_s=0.05,
    )
    w1.add_reader(reader1)
    w1.start()
    await _drain_briefly(w1, 1500)
    w1.stop()
    assert len(received) == 1, f"expected 1 event from initial backfill, got {len(received)}"

    # seen_path should exist with the event's key persisted
    assert seen_path.exists(), "watcher should have written seen_keys to disk"
    data = json.loads(seen_path.read_text(encoding="utf-8"))
    assert any("event-for-a.jsonl" in keys for keys in data.values())

    # ── Second watcher run with same files: should emit 0 events ──────────
    received.clear()
    reader2 = _StaticReader(root)
    w2 = LogWatcher(
        sink=sink, seen_path=seen_path,
        rescan_interval_s=0.1, save_interval_s=0.05,
    )
    w2.add_reader(reader2)
    w2.start()
    await _drain_briefly(w2, 1500)
    w2.stop()
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

    async def sink(u: TokenUsage) -> None:
        received.append(u)

    seen_path = tmp_path / "seen.json"

    # Run 1: process the existing file
    w1 = LogWatcher(sink=sink, seen_path=seen_path,
                    rescan_interval_s=0.1, save_interval_s=0.05)
    w1.add_reader(_StaticReader(root))
    w1.start(); await _drain_briefly(w1, 1500); w1.stop()
    assert len(received) == 1

    # Run 2: new file appears between runs
    (root / "b.jsonl").write_text("")
    received.clear()
    w2 = LogWatcher(sink=sink, seen_path=seen_path,
                    rescan_interval_s=0.1, save_interval_s=0.05)
    w2.add_reader(_StaticReader(root))
    w2.start(); await _drain_briefly(w2, 1500); w2.stop()
    # Old file: no re-emit. New file: 1 event.
    assert len(received) == 1
    assert received[0].file_path.endswith("b.jsonl")


@pytest.mark.asyncio
async def test_corrupt_seen_file_starts_empty(tmp_path: Path) -> None:
    """Garbage in seen.json shouldn't crash startup."""
    root = tmp_path / "logs"; root.mkdir()
    (root / "x.jsonl").write_text("")
    seen_path = tmp_path / "seen.json"
    seen_path.write_text("{ not json", encoding="utf-8")

    received: list[TokenUsage] = []
    async def sink(u: TokenUsage) -> None:
        received.append(u)

    w = LogWatcher(sink=sink, seen_path=seen_path,
                   rescan_interval_s=0.1, save_interval_s=0.05)
    w.add_reader(_StaticReader(root))
    w.start(); await _drain_briefly(w, 1500); w.stop()
    # Fallback: start empty → emit once.
    assert len(received) == 1
