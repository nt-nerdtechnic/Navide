"""Tests for the append-only pipeline history store."""

from __future__ import annotations

import json

from agent_team_backend.history_store import (
    HistoryStore,
    classify_orchestrator_line,
)


def test_record_appends_jsonl_and_returns_event(tmp_path):
    ws = str(tmp_path)
    store = HistoryStore()
    ev = store.record(ws, run_dir="runs/r1", type="sentinel_detected", summary="---SPEC-DONE---")
    assert ev["type"] == "sentinel_detected"
    assert ev["id"] and ev["ts"]
    path = tmp_path / ".agent-team" / "runs" / "r1" / "history.jsonl"
    assert path.exists()
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["summary"] == "---SPEC-DONE---"


def test_tail_serves_memory_then_disk(tmp_path):
    ws = str(tmp_path)
    store = HistoryStore()
    for i in range(5):
        store.record(ws, run_dir="runs/r1", type="log", summary=f"line {i}")
    # Warm read from memory buffer.
    tail = store.tail(ws, "runs/r1", limit=3)
    assert [e["summary"] for e in tail] == ["line 2", "line 3", "line 4"]

    # A fresh store (cold) must read the same data back from disk.
    cold = HistoryStore()
    got = cold.tail(ws, "runs/r1")
    assert [e["summary"] for e in got] == [f"line {i}" for i in range(5)]


def test_tail_skips_corrupt_trailing_line(tmp_path):
    ws = str(tmp_path)
    store = HistoryStore()
    store.record(ws, run_dir="runs/r1", type="log", summary="good")
    path = tmp_path / ".agent-team" / "runs" / "r1" / "history.jsonl"
    with path.open("a", encoding="utf-8") as fh:
        fh.write("{ this is not valid json\n")
    cold = HistoryStore()
    got = cold.tail(ws, "runs/r1")
    assert [e["summary"] for e in got] == ["good"]


def test_record_line_classifies_and_extracts_stage(tmp_path):
    ws = str(tmp_path)
    store = HistoryStore()
    ev = store.record_line(ws, "[3:02:42 AM] Stage 02 ✓ sentinel detected", run_dir="runs/r1")
    assert ev["type"] == "sentinel_detected"
    assert ev["stage_id"] == "02"
    assert ev["summary"] == "Stage 02 ✓ sentinel detected"  # time prefix stripped


def test_classify_orchestrator_line_rules():
    cases = {
        "[t] 🎉 Pipeline completed all stages": "pipeline_complete",
        "[t] Stage 02 ✓ sentinel detected": "sentinel_detected",
        "[t] Stage 04 ✓ turn_complete + clean-quiet (no sentinel)": "stage_completed",
        "[t] Stage 01 🧠 asking analyzer (1211 chars)": "analyzer_result",
        "[t] Stage 02 🔀 handoff: Backend → Frontend": "context_handoff",
        "[t] Stage 02 🎯 Manager router poll started": "manager",
        "[t] Stage 01 ❓ agent asked 1 question(s)": "question_detected",
        "[t] Stage 03 ▶ activate 1 slot(s)": "stage_advance",
        "[t] [04/Backend] ✓ kickoff sent": "pane_spawn",
        "[t] some plain status line": "log",
    }
    for line, expected in cases.items():
        etype, _summary = classify_orchestrator_line(line)
        assert etype == expected, f"{line!r} → {etype} (expected {expected})"
