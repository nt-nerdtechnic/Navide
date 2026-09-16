"""Local Claude turn history and account-slot quota observations.

Transcript usage is deliberately not attributed to the signed-in account:
Claude's projects directory is shared by account profiles. Quota observations
come only from successful existing usage polls, never an extra CLI invocation.
"""

from __future__ import annotations

import asyncio
import json
import math
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAX_SESSIONS = 200
MAX_TURNS = 10000
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_SCAN_BYTES = 256 * 1024 * 1024
CACHE_SECONDS = 60
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="token-monitor")


def _date(value: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except (ValueError, TypeError):
        return None


class QuotaHistory:
    """A bounded, numeric-only history, isolated from existing token storage."""

    def __init__(self, path: Path):
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("CREATE TABLE IF NOT EXISTS samples "
                   "(slot TEXT NOT NULL, fetched TEXT NOT NULL, data TEXT NOT NULL, "
                   "PRIMARY KEY(slot, fetched))")
        return db

    def record(self, slot_id: str, snapshot: dict) -> None:
        fetched = _date(snapshot.get("fetchedAt"))
        if not slot_id or snapshot.get("status") != "ok" or snapshot.get("stale") or fetched is None:
            return
        windows = []
        for window in snapshot.get("windows", []):
            value = window.get("usedPercent")
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            if not math.isfinite(value) or not 0 <= value <= 100:
                continue
            windows.append({key: window.get(key) for key in (
                "kind", "label", "usedPercent", "resetsAt", "windowMinutes"
            )})
        if not windows:
            return
        stamp = fetched.astimezone(timezone.utc).isoformat()
        sample = {"slot_id": slot_id, "fetched_at": stamp,
                  "plan_type": snapshot.get("planType"), "windows": windows}
        cutoff = (datetime.now(timezone.utc) - timedelta(days=180)).isoformat()
        with closing(self._connect()) as db, db:
            db.execute("INSERT OR IGNORE INTO samples VALUES (?, ?, ?)",
                       (slot_id, stamp, json.dumps(sample, allow_nan=False)))
            db.execute("DELETE FROM samples WHERE fetched < ?", (cutoff,))
            db.execute("DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples "
                       "ORDER BY fetched DESC LIMIT -1 OFFSET 50000)")

    def samples(self, slot_id: str, days: int) -> list[dict]:
        if not self.path.exists():
            return []
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with closing(self._connect()) as db, db:
            return [json.loads(row[0]) for row in db.execute(
                "SELECT data FROM samples WHERE slot = ? AND fetched >= ? ORDER BY fetched",
                (slot_id, cutoff),
            )]


class TurnHistory:
    def __init__(self):
        self._cache: dict[int, tuple[float, dict]] = {}
        self._files: dict[str, tuple[tuple[int, int], list[dict]]] = {}

    def scan(self, reader, days: int) -> dict:
        cached = self._cache.get(days)
        if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
            return cached[1]
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        files = []
        errors = 0
        for path in reader.session_files():
            try:
                stat = path.stat()
                if stat.st_mtime >= cutoff.timestamp():
                    files.append((stat.st_mtime_ns, stat.st_size, path))
            except OSError:
                errors += 1
        files.sort(key=lambda item: item[0], reverse=True)
        truncated = len(files) > MAX_SESSIONS
        rows = []
        scanned = 0
        scanned_bytes = 0
        retained = {}
        seen_sessions = set()
        for mtime, size, path in files[:MAX_SESSIONS]:
            if path.stem in seen_sessions:
                continue
            seen_sessions.add(path.stem)
            if size > MAX_FILE_BYTES or scanned_bytes + size > MAX_SCAN_BYTES:
                truncated = True
                continue
            scanned_bytes += size
            identity = (mtime, size)
            key = str(path)
            entry = self._files.get(key)
            try:
                if entry is None or entry[0] != identity:
                    turns = reader.turns_for_session(path, path.stem)
                    parsed = []
                    for turn in turns:
                        models = {call.model for call in turn.calls if call.model}
                        parsed.append({
                            "session_id": turn.session_id, "turn_index": turn.turn_index,
                            "started_at": turn.started_at, "ended_at": turn.ended_at,
                            "model": next(iter(models)) if len(models) == 1 else
                                     "mixed" if models else "unknown",
                            "input": turn.input, "cache_read": turn.cache_read,
                            "cache_creation": turn.cache_creation, "output": turn.output,
                            "total": turn.total, "calls": turn.call_count,
                        })
                    entry = (identity, parsed)
                retained[key] = entry
                scanned += 1
                for row in entry[1]:
                    started = _date(row["started_at"])
                    if started is None:
                        errors += 1
                    elif cutoff <= started <= datetime.now(timezone.utc):
                        rows.append(row)
            except (OSError, ValueError, TypeError, AttributeError):
                errors += 1
        self._files = retained
        rows.sort(key=lambda row: (_date(row["started_at"]), row["session_id"], row["turn_index"]))
        truncated = truncated or len(rows) > MAX_TURNS
        result = {"turns": rows[-MAX_TURNS:], "coverage": {
            "sessions_scanned": scanned, "sessions_available": len(files),
            "truncated": truncated, "errors": errors,
        }}
        self._cache[days] = (time.monotonic(), result)
        return result


history = TurnHistory()


async def snapshot(days: object = 30) -> dict:
    from . import app
    from .usage_service import service

    if type(days) is not int or days not in (14, 30, 90):
        return {"ok": False, "error": "days must be 14, 30, or 90"}
    reader = next((r for r in app._readers if r.vendor == "claude"), None)
    if reader is None:
        return {"ok": False, "error": "Claude log reader unavailable"}
    active_slot = service._active_claude_slot or "unknown"
    enabled = service.enabled

    def read() -> dict:
        result = history.scan(reader, days)
        quota_error = None
        try:
            samples = service.quota_history.samples(active_slot, days) if service.quota_history else []
        except (OSError, sqlite3.Error, ValueError):
            samples = []
            quota_error = "Quota history could not be read. Existing history has not been reset."
        return {"ok": True, "scope": "local-claude-history",
                "account_attribution": "unknown", **result,
                "quota": {"active_slot_id": active_slot, "enabled": enabled,
                          "samples": samples, "error": quota_error},
                "limitations": [
                    "Local transcripts cannot be verified as belonging to the current account.",
                    "Other devices, web chats and subagent logs are not included.",
                    "Tokens are observed usage, not the account's token allowance.",
                    "Effort and separate thinking tokens are unavailable; changes do not prove throttling.",
                    "Running turns may be partial until the assistant finishes.",
                    "Quota history identifies a local profile slot, not a verified account identity; signing into another account in the same slot may mix observations.",
                    "Quota history retains up to 180 days or 50000 observations, only while existing usage polling is enabled.",
                    "History is bounded to 200 sessions, 10000 turns and 256 MiB per scan; refresh is cached for 60 seconds.",
                ]}

    return await asyncio.get_running_loop().run_in_executor(_pool, read)
