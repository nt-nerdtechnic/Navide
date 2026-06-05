"""Append-only pipeline history (timeline) per run.

Each run gets a `history.jsonl` next to its `pipeline.log`:

    <workspace>/.agent-team/<run_dir>/history.jsonl

(one JSON `HistoryEvent` per line). When no run is active the events land in
`<workspace>/.agent-team/history.jsonl`.

Unlike `tokens_store` (which rewrites a single aggregated JSON file), history is
strictly append-only: fast writes, complete audit trail, `tail -f`-friendly, and
trivial to import into SQLite later. A small in-memory tail buffer per run backs
instant `tail()` reads and WS broadcasts; older events are read back from disk.

The bulk of events arrive as freeform orchestrator log lines from the frontend
(`project.log_event`); `classify_orchestrator_line()` derives a structured
`type` + clean `summary` from the stable emoji/keyword conventions the
orchestrator already uses, so no frontend changes are required for v1.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any

from .projects import PROJECT_DIR_NAME

log = logging.getLogger("agent_team_backend.history")

HISTORY_FILE = "history.jsonl"
TAIL_LIMIT = 500  # in-memory ring buffer size per run


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ── Orchestrator-line classification ────────────────────────────────────────
# The frontend emits timestamped lines like "[3:02:42 AM] Stage 02 ▶ activate
# 1 slot(s)". We strip the leading "[time] " and map the well-known prefixes to
# a structured event type. Order matters — first match wins.
_TIME_PREFIX_RE = re.compile(r"^\[[^\]]*\]\s*")

_LINE_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"🎉|Pipeline completed"), "pipeline_complete"),
    (re.compile(r"sentinel detected|✓ sentinel"), "sentinel_detected"),
    (re.compile(r"analyzer says complete|完成已確認|turn_complete \+ clean"), "stage_completed"),
    (re.compile(r"completion 待確認|完成取消"), "analyzer_result"),
    (re.compile(r"🧠|asking analyzer|intent="), "analyzer_result"),
    (re.compile(r"🔀|handoff|context_handoff|Handoff"), "context_handoff"),
    (re.compile(r"🎯|Manager|DISPATCH|ASK FROM|REPORT FROM"), "manager"),
    (re.compile(r"❓|question|問題"), "question_detected"),
    (re.compile(r"↩|answered|已回答"), "question_answered"),
    (re.compile(r"🤖|auto-?answer|自動回答"), "question_auto_answered"),
    (re.compile(r"▶ activate|watcher armed"), "stage_advance"),
    (re.compile(r"pre-spawn|pane_spawn|injecting role|injecting kickoff|kickoff sent|role prompt sent"), "pane_spawn"),
    (re.compile(r"⏰|idle|hard cap|stall|stalled|卡住"), "stage_stalled"),
    (re.compile(r"⚠|error|failed|錯誤"), "warning"),
]


def classify_orchestrator_line(line: str) -> tuple[str, str]:
    """Return (event_type, summary) for a freeform orchestrator log line."""
    summary = _TIME_PREFIX_RE.sub("", line or "").strip()
    for pat, etype in _LINE_RULES:
        if pat.search(summary):
            return etype, summary
    return "log", summary


def _extract_stage_id(summary: str) -> str | None:
    m = re.search(r"\bStage\s+(\d{1,2})\b", summary)
    return m.group(1) if m else None


class HistoryStore:
    """Thread-safe append-only history with per-run in-memory tail buffers."""

    def __init__(self) -> None:
        self._lock = RLock()
        # key: history file path string → ring buffer of recent events
        self._tails: dict[str, deque[dict[str, Any]]] = {}

    # ───────────────────────── Paths ────────────────────────────────
    def _history_path(self, workspace_path: str, run_dir: str) -> Path:
        base = Path(workspace_path) / PROJECT_DIR_NAME
        return (base / run_dir / HISTORY_FILE) if run_dir else (base / HISTORY_FILE)

    def path_str(self, workspace_path: str, run_dir: str) -> str:
        return str(self._history_path(workspace_path, run_dir))

    # ───────────────────────── Recording ────────────────────────────
    def record(
        self,
        workspace_path: str,
        *,
        run_dir: str = "",
        type: str,
        summary: str,
        run_id: str = "",
        stage_id: str | None = None,
        pane_id: str | None = None,
        vendor: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append one HistoryEvent and return it (for WS broadcast)."""
        event: dict[str, Any] = {
            "id": uuid.uuid4().hex,
            "ts": _now_iso(),
            "run_id": run_id or run_dir,
            "type": type,
            "summary": summary,
        }
        if stage_id:
            event["stage_id"] = stage_id
        if pane_id:
            event["pane_id"] = pane_id
        if vendor:
            event["vendor"] = vendor
        if detail:
            event["detail"] = detail

        path = self._history_path(workspace_path, run_dir)
        key = str(path)
        with self._lock:
            buf = self._tails.get(key)
            if buf is None:
                buf = deque(maxlen=TAIL_LIMIT)
                self._tails[key] = buf
            buf.append(event)
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(event, ensure_ascii=False) + "\n")
            except OSError as err:
                log.warning("history append failed at %s: %s", path, err)
        return event

    def record_line(
        self,
        workspace_path: str,
        line: str,
        *,
        run_dir: str = "",
        run_id: str = "",
        pane_id: str | None = None,
        vendor: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Classify a freeform orchestrator log line and record it."""
        etype, summary = classify_orchestrator_line(line)
        return self.record(
            workspace_path,
            run_dir=run_dir,
            type=etype,
            summary=summary,
            run_id=run_id,
            stage_id=_extract_stage_id(summary),
            pane_id=pane_id,
            vendor=vendor,
            detail=detail,
        )

    # ───────────────────────── Reading ──────────────────────────────
    def tail(
        self, workspace_path: str, run_dir: str = "", limit: int = TAIL_LIMIT
    ) -> list[dict[str, Any]]:
        """Return the most recent `limit` events, newest last.

        Serves from the in-memory ring buffer when warm, otherwise reads the
        tail of the on-disk JSONL (tolerating partial/corrupt trailing lines).
        """
        path = self._history_path(workspace_path, run_dir)
        key = str(path)
        with self._lock:
            buf = self._tails.get(key)
            if buf is not None and len(buf) > 0:
                items = list(buf)
                return items[-limit:]
        # Cold read from disk.
        if not path.exists():
            return []
        _COLD_READ_LIMIT = 50 * 1024 * 1024  # 50 MB guard — avoids OOM on huge files
        try:
            if path.stat().st_size > _COLD_READ_LIMIT:
                log.warning("history file %s exceeds 50 MB — returning empty tail", path)
                return []
        except OSError:
            return []
        events: list[dict[str, Any]] = []
        try:
            with path.open("r", encoding="utf-8") as fh:
                for raw in fh:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        events.append(json.loads(raw))
                    except json.JSONDecodeError:
                        continue  # skip a torn line
        except OSError as err:
            log.warning("history read failed at %s: %s", path, err)
            return []
        # Warm the buffer for next time.
        with self._lock:
            buf = deque(events[-TAIL_LIMIT:], maxlen=TAIL_LIMIT)
            self._tails[key] = buf
        return events[-limit:]

    def snapshot(
        self, workspace_path: str, run_dir: str = "", limit: int = TAIL_LIMIT
    ) -> dict[str, Any]:
        return {
            "workspace_path": workspace_path or "",
            "run_dir": run_dir,
            "path": self.path_str(workspace_path, run_dir),
            "events": self.tail(workspace_path, run_dir, limit),
        }
