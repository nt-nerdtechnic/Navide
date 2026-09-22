"""Pane account history: which CLI account each pane was pinned to, and when.

A CLI transcript names no account — every profile of a vendor shares the
same session directory — so the only way to say "this usage was made on
account X" is to remember which account the pane was pinned to at the moment
the usage happened. This store keeps one open/closed interval per pin:

    pane_account_history(pane_id, profile_id, since, until NULL = still open)

Writers: ``pin`` on terminal.create and on the spawn bookkeeping messages
(a repeat pin of the same account is a no-op, a different account closes
the open interval and opens a new one); ``release`` when the pane's
attribution registration is dropped (kill, unspawn, PTY death after the
grace period). Readers: the token ingestion sink and the per-turn scan ask
``profile_at(pane_id, ts)``.

``profile_id`` is stored normalized: "" (a pane older than pinning, or a
vendor without accounts) becomes "unknown", the bucket the UI shows as
"未知". "__default__" stays as-is (the unmanaged real-home account).

Rows live in the global ``navide.db`` because pane ids are global UUIDs and
the ingestion sink resolves them without knowing the workspace. The whole
table is mirrored in memory (a few rows per pane ever opened) so the sink's
per-event lookup never touches SQLite.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from bisect import bisect_right
from datetime import datetime, timezone
from threading import RLock

from .db import Database

log = logging.getLogger(__name__)

_COMPONENT = "pane_account_history"
UNKNOWN_PROFILE_ID = "unknown"

#: A usage stamped this many seconds before its pane's first pin still counts
#: for that pin. The pin arrives with the spawn bookkeeping, a beat after the
#: PTY started; a CLI that answers within that beat must not lose its first
#: call to "unknown".
PIN_LEAD_TOLERANCE_S = 15.0


def normalize_profile_id(profile_id: object) -> str:
    text = str(profile_id or "").strip()
    return text or UNKNOWN_PROFILE_ID


def parse_event_time(raw: str | None) -> float | None:
    """Epoch seconds of a log's ISO-8601 stamp, or None when it has none
    (callers then mean "now"). Naive values are taken as UTC."""
    text = (raw or "").strip()
    if not text:
        return None
    if text.isdigit():
        # opencode/kilo stamp epoch milliseconds; anything past 1e11 cannot be
        # seconds of any date this app will see.
        value = int(text)
        return value / 1000.0 if value > 100_000_000_000 else float(value)
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _create_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE pane_account_history ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " pane_id TEXT NOT NULL,"
        " profile_id TEXT NOT NULL,"
        " since REAL NOT NULL,"
        " until REAL)"
    )
    cur.execute(
        "CREATE INDEX pane_account_history_pane"
        " ON pane_account_history (pane_id, since)"
    )


class _Interval:
    __slots__ = ("row_id", "profile_id", "since", "until")

    def __init__(self, row_id: int, profile_id: str, since: float, until: float | None):
        self.row_id = row_id
        self.profile_id = profile_id
        self.since = since
        self.until = until


class PaneAccountHistory:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._db.migrate(_COMPONENT, 1, _create_schema)
        self._lock = RLock()
        # pane_id -> intervals ordered by `since`
        self._by_pane: dict[str, list[_Interval]] = {}
        self._load()

    def _load(self) -> None:
        with self._db.transaction() as cur:
            rows = cur.execute(
                "SELECT id, pane_id, profile_id, since, until"
                " FROM pane_account_history ORDER BY pane_id, since, id"
            ).fetchall()
        for row in rows:
            self._by_pane.setdefault(str(row["pane_id"]), []).append(
                _Interval(int(row["id"]), str(row["profile_id"]),
                          float(row["since"]), row["until"])
            )

    # ── writers ──────────────────────────────────────────────────────

    def pin(self, pane_id: str, profile_id: object, ts: float | None = None) -> bool:
        """Record that ``pane_id`` runs on ``profile_id`` from ``ts`` on.

        Returns True when a new interval was opened. A pin equal to the open
        interval's account is a no-op (the spawn bookkeeping repeats what
        terminal.create already recorded)."""
        if not pane_id:
            return False
        profile = normalize_profile_id(profile_id)
        now = time.time() if ts is None else float(ts)
        with self._lock:
            intervals = self._by_pane.setdefault(pane_id, [])
            open_iv = intervals[-1] if intervals and intervals[-1].until is None else None
            if open_iv is not None:
                if open_iv.profile_id == profile:
                    return False
                self._close_locked(open_iv, now)
            with self._db.transaction() as cur:
                cur.execute(
                    "INSERT INTO pane_account_history (pane_id, profile_id, since, until)"
                    " VALUES (?, ?, ?, NULL)",
                    (pane_id, profile, now),
                )
                row_id = int(cur.lastrowid)
            intervals.append(_Interval(row_id, profile, now, None))
            return True

    def release(self, pane_id: str, ts: float | None = None) -> bool:
        """Close the pane's open interval at ``ts``. False when none is open."""
        if not pane_id:
            return False
        now = time.time() if ts is None else float(ts)
        with self._lock:
            intervals = self._by_pane.get(pane_id)
            if not intervals or intervals[-1].until is not None:
                return False
            self._close_locked(intervals[-1], now)
            return True

    def _close_locked(self, interval: _Interval, until: float) -> None:
        until = max(until, interval.since)
        with self._db.transaction() as cur:
            cur.execute(
                "UPDATE pane_account_history SET until = ? WHERE id = ?",
                (until, interval.row_id),
            )
        interval.until = until

    # ── readers ──────────────────────────────────────────────────────

    def profile_at(self, pane_id: str, ts: float | None) -> str:
        """The account ``pane_id`` was pinned to at ``ts`` (epoch seconds);
        ``None`` means "now" (the open interval). "unknown" when the pane has
        no interval covering that moment."""
        if not pane_id:
            return UNKNOWN_PROFILE_ID
        with self._lock:
            intervals = self._by_pane.get(pane_id)
            if not intervals:
                return UNKNOWN_PROFILE_ID
            if ts is None:
                last = intervals[-1]
                return last.profile_id if last.until is None else UNKNOWN_PROFILE_ID
            when = float(ts)
            # Rightmost interval starting at or before `when`.
            idx = bisect_right([iv.since for iv in intervals], when) - 1
            if idx >= 0:
                iv = intervals[idx]
                if iv.until is None or when < iv.until:
                    return iv.profile_id
            elif when >= intervals[0].since - PIN_LEAD_TOLERANCE_S:
                return intervals[0].profile_id
            return UNKNOWN_PROFILE_ID

    def current_profile(self, pane_id: str) -> str:
        return self.profile_at(pane_id, None)

    def intervals(self, pane_id: str) -> list[tuple[str, float, float | None]]:
        """(profile_id, since, until) rows for tests and diagnostics."""
        with self._lock:
            return [
                (iv.profile_id, iv.since, iv.until)
                for iv in self._by_pane.get(pane_id, [])
            ]
