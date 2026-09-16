"""Quota cycle ledger: what one account spent, in tokens, per quota window.

Every usage snapshot the poller obtains (claude per account slot, the other
vendors per provider) is filed as a sample:

    quota_samples(agent, profile_id, window_kind, used_percent, resets_at, fetched_at)

and folded into the cycle it belongs to — one row per (account, window,
reset time):

    quota_cycles(agent, profile_id, window_kind, started_at, resets_at,
                 max_percent, exhausted_at, input, cache_read, cache_creation,
                 output, calls, turns, closed, samples)

``started_at`` is ``resets_at`` minus the window's fixed length
(:mod:`quota_windows`); a calendar window (monthly credits) starts where
the account's previous cycle of that kind reset, or is None. ``exhausted_at``
is the fetch time of the first sample at 100 %. A cycle stays open — its
token side is summed live from the account's usage slices (tokens_store) —
until ``resets_at`` passes, when the sums are frozen and ``closed`` set;
hitting 100 % does not close it early (the user's decision: the zero-spend
tail up to the reset belongs to the same cycle).

The token side depends on the pane account history: usage is credited to the
account its pane was pinned to, so a cycle only ever sums what that account
really spent (and "unknown" gets no cycles, having no quota).
"""

from __future__ import annotations

import logging
import math
import sqlite3
import time
from collections.abc import Callable
from datetime import datetime, timezone
from threading import RLock
from typing import Any

from .db import Database
from .pane_account_history import normalize_profile_id, parse_event_time
from .quota_windows import window_seconds

log = logging.getLogger(__name__)

_COMPONENT = "quota_ledger"
#: Two snapshots whose reset times differ by less than this describe the
#: same cycle (claude's panel prints the reset to the minute; a parked slot
#: replays its cached figure with the same stamp).
RESET_MATCH_TOLERANCE_S = 120.0
#: Window kinds counted as "weekly" in the period statistics; everything
#: else (session/5h, monthly credits, …) is the "cycles" column.
WEEKLY_KINDS = ("weekly", "weekly-model", "secondary")

TotalsProvider = Callable[[str, str, "float | None", float], dict[str, int]]

_TOKEN_FIELDS = ("input", "cache_read", "cache_creation", "output", "calls", "turns")
#: kv key holding the epoch at which token slices started being recorded on
#: this database — written once, on the ledger's first start. A cycle that
#: started before it has no usage detail (its six sums are not to be trusted).
SLICES_SINCE_KEY = "tokens.slices_since"


def _create_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE quota_samples ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " agent TEXT NOT NULL,"
        " profile_id TEXT NOT NULL,"
        " window_kind TEXT NOT NULL,"
        " used_percent REAL NOT NULL,"
        " resets_at REAL NOT NULL,"    # unix ts
        " fetched_at REAL NOT NULL)"   # unix ts
    )
    cur.execute(
        "CREATE INDEX quota_samples_key"
        " ON quota_samples (agent, profile_id, window_kind, fetched_at)"
    )
    cur.execute(
        "CREATE TABLE quota_cycles ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " agent TEXT NOT NULL,"
        " profile_id TEXT NOT NULL,"
        " window_kind TEXT NOT NULL,"
        " started_at REAL,"
        " resets_at REAL NOT NULL,"
        " max_percent REAL NOT NULL DEFAULT 0,"
        " exhausted_at REAL,"
        " input INTEGER NOT NULL DEFAULT 0,"
        " cache_read INTEGER NOT NULL DEFAULT 0,"
        " cache_creation INTEGER NOT NULL DEFAULT 0,"
        " output INTEGER NOT NULL DEFAULT 0,"
        " calls INTEGER NOT NULL DEFAULT 0,"
        " turns INTEGER NOT NULL DEFAULT 0,"
        " closed INTEGER NOT NULL DEFAULT 0,"
        " samples INTEGER NOT NULL DEFAULT 0,"
        " UNIQUE (agent, profile_id, window_kind, resets_at))"
    )


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return (
        datetime.fromtimestamp(ts, timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _period_of(ts: float, granularity: str) -> str:
    when = datetime.fromtimestamp(ts, timezone.utc)
    return when.strftime("%Y") if granularity == "year" else when.strftime("%Y-%m")


#: Kinds that are one row per model / bucket rather than one per account
#: and always carry their label in the cycle key. Keyed by the label even
#: when a snapshot happens to hold a single row: a count-based rule would
#: rename the key when a row appears or disappears (Claude's promotional
#: "Fable only" week) and split one window into two cycles.
LABELLED_KINDS = frozenset({"weekly-model"})


def window_kinds_of(snapshot: dict) -> list[tuple[dict, str]]:
    """(window, kind) pairs of a snapshot; a labelled kind (``weekly-model``)
    and any other kind that appears more than once are suffixed with the
    label so the rows do not collapse into one cycle."""
    windows = [w for w in snapshot.get("windows", []) if isinstance(w, dict)]
    counts: dict[str, int] = {}
    for window in windows:
        kind = str(window.get("kind") or "")
        counts[kind] = counts.get(kind, 0) + 1
    out: list[tuple[dict, str]] = []
    for window in windows:
        kind = str(window.get("kind") or "")
        if not kind:
            continue
        if kind in LABELLED_KINDS or counts[kind] > 1:
            kind = f"{kind}:{window.get('label') or ''}"
        out.append((window, kind))
    return out


class QuotaLedger:
    def __init__(self, db: Database, totals_provider: TotalsProvider) -> None:
        self._db = db
        self._db.migrate(_COMPONENT, 1, _create_schema)
        self._lock = RLock()
        self._totals = totals_provider
        # (agent, profile_id, window_kind) -> (used_percent, resets_at) of the
        # last sample written, the dedup rule for repeated identical readings.
        self._last_sample: dict[tuple[str, str, str], tuple[float, float]] = {}
        self._load_last_samples()
        since = self._db.kv_get(SLICES_SINCE_KEY)
        if not isinstance(since, (int, float)) or isinstance(since, bool):
            since = time.time()
            self._db.kv_set(SLICES_SINCE_KEY, since, now=int(since))
        self.slices_since: float = float(since)

    def _load_last_samples(self) -> None:
        with self._db.transaction() as cur:
            rows = cur.execute(
                "SELECT agent, profile_id, window_kind, used_percent, resets_at"
                " FROM quota_samples WHERE id IN ("
                "  SELECT MAX(id) FROM quota_samples"
                "  GROUP BY agent, profile_id, window_kind)"
            ).fetchall()
        for row in rows:
            key = (str(row["agent"]), str(row["profile_id"]), str(row["window_kind"]))
            self._last_sample[key] = (float(row["used_percent"]), float(row["resets_at"]))

    # ── writers ──────────────────────────────────────────────────────

    def observe(
        self, agent: str, profile_id: str, snapshot: dict, now: float | None = None
    ) -> list[tuple[str, str, str]]:
        """File a usage snapshot. Returns the (agent, profile_id, window_kind)
        keys whose cycle changed (new sample, new cycle, or a close)."""
        if not agent or not isinstance(snapshot, dict):
            return []
        if snapshot.get("status") != "ok" or snapshot.get("stale"):
            return []
        profile = normalize_profile_id(profile_id)
        wall = _now(now)
        fetched = parse_event_time(str(snapshot.get("fetchedAt") or "")) or wall
        changed: list[tuple[str, str, str]] = []
        with self._lock:
            for window, kind in window_kinds_of(snapshot):
                pct = window.get("usedPercent")
                if isinstance(pct, bool) or not isinstance(pct, (int, float)):
                    continue
                if not math.isfinite(pct):
                    continue
                pct = max(0.0, min(100.0, float(pct)))
                resets = parse_event_time(str(window.get("resetsAt") or ""))
                if resets is None:
                    continue
                key = (agent, profile, kind)
                if self._last_sample.get(key) == (pct, resets):
                    continue
                self._last_sample[key] = (pct, resets)
                with self._db.transaction() as cur:
                    cur.execute(
                        "INSERT INTO quota_samples (agent, profile_id, window_kind,"
                        " used_percent, resets_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (agent, profile, kind, pct, resets, fetched),
                    )
                    self._fold_sample_locked(
                        cur, agent, profile, kind, pct, resets, fetched,
                        window.get("windowMinutes"),
                    )
                changed.append(key)
            for key in self.close_expired(wall):
                if key not in changed:
                    changed.append(key)
        return changed

    def _fold_sample_locked(
        self, cur: sqlite3.Cursor, agent: str, profile: str, kind: str,
        pct: float, resets: float, fetched: float, window_minutes: object,
    ) -> None:
        row = cur.execute(
            "SELECT id, max_percent, exhausted_at, closed FROM quota_cycles"
            " WHERE agent = ? AND profile_id = ? AND window_kind = ?"
            " AND ABS(resets_at - ?) <= ? ORDER BY ABS(resets_at - ?) LIMIT 1",
            (agent, profile, kind, resets, RESET_MATCH_TOLERANCE_S, resets),
        ).fetchone()
        exhausted_at = fetched if pct >= 100.0 else None
        if row is None:
            length = window_seconds(agent, kind, window_minutes)
            if length is not None:
                started_at: float | None = resets - length
            else:
                # Calendar window: the previous cycle's reset is this one's start.
                prev = cur.execute(
                    "SELECT MAX(resets_at) FROM quota_cycles"
                    " WHERE agent = ? AND profile_id = ? AND window_kind = ?"
                    " AND resets_at < ?",
                    (agent, profile, kind, resets),
                ).fetchone()
                started_at = float(prev[0]) if prev and prev[0] is not None else None
            cur.execute(
                "INSERT INTO quota_cycles (agent, profile_id, window_kind, started_at,"
                " resets_at, max_percent, exhausted_at, samples)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
                (agent, profile, kind, started_at, resets, pct, exhausted_at),
            )
            return
        if int(row["closed"]):
            return  # a late reading of a frozen cycle changes nothing
        new_max = max(float(row["max_percent"]), pct)
        new_exhausted = row["exhausted_at"]
        if new_exhausted is None and exhausted_at is not None:
            new_exhausted = exhausted_at
        elif new_exhausted is not None and exhausted_at is not None:
            new_exhausted = min(float(new_exhausted), exhausted_at)
        cur.execute(
            "UPDATE quota_cycles SET max_percent = ?, exhausted_at = ?, samples = samples + 1"
            " WHERE id = ? AND closed = 0",
            (new_max, new_exhausted, int(row["id"])),
        )

    def mark_exhausted(self, agent: str, profile_id: str, at: float) -> list[str]:
        """The pane's own ⛔ detection (`tokens.quota_exhausted`): for every
        open cycle of the account whose window contains ``at``, move
        ``exhausted_at`` to ``at`` when it is unset or later — the pane sees
        the wall up to 15 minutes before the next usage sample does. A later
        detection never overrides an earlier sample. Returns the window kinds
        updated."""
        profile = normalize_profile_id(profile_id)
        updated: list[str] = []
        with self._lock:
            with self._db.transaction() as cur:
                rows = cur.execute(
                    "SELECT id, window_kind, exhausted_at FROM quota_cycles"
                    " WHERE agent = ? AND profile_id = ? AND closed = 0"
                    " AND resets_at > ? AND (started_at IS NULL OR started_at <= ?)",
                    (agent, profile, at, at),
                ).fetchall()
                for row in rows:
                    current = row["exhausted_at"]
                    if current is not None and float(current) <= at:
                        continue
                    cur.execute(
                        "UPDATE quota_cycles SET exhausted_at = ? WHERE id = ?",
                        (at, int(row["id"])),
                    )
                    updated.append(str(row["window_kind"]))
        return updated

    def close_expired(self, now: float | None = None) -> list[tuple[str, str, str]]:
        """Freeze every open cycle whose reset time has passed. Returns the
        keys that were closed."""
        wall = _now(now)
        closed: list[tuple[str, str, str]] = []
        with self._lock:
            with self._db.transaction() as cur:
                rows = cur.execute(
                    "SELECT id, agent, profile_id, window_kind, started_at, resets_at"
                    " FROM quota_cycles WHERE closed = 0 AND resets_at <= ?",
                    (wall,),
                ).fetchall()
            for row in rows:
                # The totals provider takes the tokens store's lock, and the
                # store takes the database lock while holding its own (a
                # workspace cache miss inside record()) — so never ask for
                # the sums inside a transaction, or the two threads deadlock.
                totals = self._totals(
                    str(row["agent"]), str(row["profile_id"]),
                    row["started_at"], float(row["resets_at"]),
                )
                with self._db.transaction() as cur:
                    cur.execute(
                        "UPDATE quota_cycles SET input = ?, cache_read = ?, cache_creation = ?,"
                        " output = ?, calls = ?, turns = ?, closed = 1 WHERE id = ?",
                        (*(int(totals.get(f, 0)) for f in _TOKEN_FIELDS), int(row["id"])),
                    )
                closed.append(
                    (str(row["agent"]), str(row["profile_id"]), str(row["window_kind"]))
                )
        return closed

    # ── readers ──────────────────────────────────────────────────────

    def cycles(
        self, agent: str, profile_id: str, window_kind: str | None = None,
        now: float | None = None,
    ) -> list[dict[str, Any]]:
        """The account's cycles, newest reset first, open ones summed live."""
        profile = normalize_profile_id(profile_id)
        wall = _now(now)
        with self._lock:
            self.close_expired(wall)
            with self._db.transaction() as cur:
                sql = (
                    "SELECT * FROM quota_cycles WHERE agent = ? AND profile_id = ?"
                )
                params: list[Any] = [agent, profile]
                if window_kind:
                    sql += " AND window_kind = ?"
                    params.append(window_kind)
                sql += " ORDER BY resets_at DESC, id DESC"
                rows = cur.execute(sql, params).fetchall()
            return [self._row_to_cycle(row, wall) for row in rows]

    def _row_to_cycle(self, row: sqlite3.Row, wall: float) -> dict[str, Any]:
        closed = bool(row["closed"])
        if closed:
            totals = {f: int(row[f]) for f in _TOKEN_FIELDS}
        else:
            totals = self._totals(
                str(row["agent"]), str(row["profile_id"]),
                row["started_at"], float(row["resets_at"]),
            )
        total = (
            int(totals.get("input", 0)) + int(totals.get("cache_read", 0))
            + int(totals.get("cache_creation", 0)) + int(totals.get("output", 0))
        )
        return {
            "window_kind": str(row["window_kind"]),
            "started_at": _iso(row["started_at"]),
            "resets_at": _iso(float(row["resets_at"])),
            "closed": closed,
            "max_percent": float(row["max_percent"]),
            "exhausted_at": _iso(row["exhausted_at"]),
            "input": int(totals.get("input", 0)),
            "cache_read": int(totals.get("cache_read", 0)),
            "cache_creation": int(totals.get("cache_creation", 0)),
            "output": int(totals.get("output", 0)),
            "total": total,
            "calls": int(totals.get("calls", 0)),
            "turns": int(totals.get("turns", 0)),
            "samples": int(row["samples"]),
            # False = the cycle started before slices existed on this
            # database: the sums above are incomplete, not "nothing spent".
            "detail_known": (
                row["started_at"] is not None
                and float(row["started_at"]) >= self.slices_since
            ),
        }

    @staticmethod
    def summarize(cycles: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """Per window kind: how many cycles, how many exhausted, and the mean
        total of the exhausted ones. Only cycles whose detail is known enter
        the mean — a pre-slices cycle would dilute it with zeros — so it is
        None when no exhausted cycle has known detail."""
        out: dict[str, dict[str, Any]] = {}
        for cycle in cycles:
            entry = out.setdefault(
                cycle["window_kind"], {"cycles": 0, "exhausted": 0, "_sum": 0, "_n": 0}
            )
            entry["cycles"] += 1
            if cycle["exhausted_at"] is not None:
                entry["exhausted"] += 1
                if cycle.get("detail_known"):
                    entry["_sum"] += cycle["total"]
                    entry["_n"] += 1
        for entry in out.values():
            total, n = entry.pop("_sum"), entry.pop("_n")
            entry["avg_total_exhausted"] = total / n if n else None
        return out

    def period_stats(
        self, granularity: str, now: float | None = None
    ) -> dict[tuple[str, str, str], dict[str, Any]]:
        """(period, agent, profile_id) -> cycle counts for account_periods.
        A cycle belongs to the period of its start (its reset when the start
        is unknown). ``cycles`` / ``exhausted`` / ``avg_total_exhausted``
        cover the non-weekly kinds (the 5h session window for most vendors);
        ``weekly_exhausted`` counts the weekly kinds."""
        wall = _now(now)
        with self._lock:
            self.close_expired(wall)
            with self._db.transaction() as cur:
                rows = cur.execute("SELECT * FROM quota_cycles").fetchall()
            stats: dict[tuple[str, str, str], dict[str, Any]] = {}
            for row in rows:
                anchor = row["started_at"]
                if anchor is None:
                    anchor = float(row["resets_at"])
                key = (
                    _period_of(float(anchor), granularity),
                    str(row["agent"]), str(row["profile_id"]),
                )
                entry = stats.setdefault(key, {
                    "cycles": 0, "exhausted": 0, "_sum": 0, "_n": 0, "weekly_exhausted": 0,
                })
                kind = str(row["window_kind"]).split(":", 1)[0]
                exhausted = row["exhausted_at"] is not None
                if kind in WEEKLY_KINDS:
                    if exhausted:
                        entry["weekly_exhausted"] += 1
                    continue
                entry["cycles"] += 1
                if exhausted:
                    entry["exhausted"] += 1
                    cycle = self._row_to_cycle(row, wall)
                    if cycle["detail_known"]:
                        entry["_sum"] += cycle["total"]
                        entry["_n"] += 1
            for entry in stats.values():
                total, n = entry.pop("_sum"), entry.pop("_n")
                entry["avg_total_exhausted"] = total / n if n else None
            return stats

    def reset(self) -> None:
        with self._lock:
            with self._db.transaction() as cur:
                cur.execute("DELETE FROM quota_samples")
                cur.execute("DELETE FROM quota_cycles")
            self._last_sample.clear()


def _now(now: float | None) -> float:
    return time.time() if now is None else float(now)
