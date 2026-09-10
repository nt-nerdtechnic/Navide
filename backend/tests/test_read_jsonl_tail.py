"""read_jsonl_tail: the byte-offset resume shared by every JSONL reader."""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.log_readers.base import read_jsonl_tail


def _write(path: Path, records: list[dict]) -> None:
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")


def test_replacement_on_a_reused_inode_restarts_from_zero(tmp_path: Path) -> None:
    # Linux hands a freed inode number to the next file created in its place,
    # so a replacement no shorter than the offset used to pass the identity
    # and shrink checks and be read from the stale offset.
    log = tmp_path / "session.jsonl"
    _write(log, [{"n": 1}, {"n": 2}])
    _, checkpoint, _ = read_jsonl_tail(log, {})

    _write(log, [{"n": 10, "pad": "x" * 40}, {"n": 11}])
    stat = log.stat()
    same_inode = {**checkpoint, "identity": f"{stat.st_dev}:{stat.st_ino}"}
    records, after, rotated = read_jsonl_tail(log, same_inode)

    assert rotated is True
    assert [rec["n"] for _end, rec in records] == [10, 11]
    # The new generation is now the tracked one: nothing is credited twice.
    assert read_jsonl_tail(log, after)[0] == []


def test_a_checkpoint_without_an_anchor_resumes_as_before(tmp_path: Path) -> None:
    # Persisted before the anchor existed: trusted on identity and size alone,
    # so an upgrade does not re-read every tracked log.
    log = tmp_path / "session.jsonl"
    _write(log, [{"n": 1}])
    _, checkpoint, _ = read_jsonl_tail(log, {})
    del checkpoint["anchor"]
    with log.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"n": 2}) + "\n")

    records, after, rotated = read_jsonl_tail(log, checkpoint)

    assert rotated is False
    assert [rec["n"] for _end, rec in records] == [2]
    assert after["anchor"]
