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
is the earliest trustworthy sample or CLI limit observation, with its source.
A cycle stays open — its
token side is summed live from the account's usage slices (tokens_store) —
until ``resets_at`` passes, when the sums are finalized and ``closed`` set;
hitting 100 % does not close it early (the user's decision: the zero-spend
tail up to the reset belongs to the same cycle). Retained late token events
can reconcile those sums without reopening the quota lifecycle.

The token side depends on the pane account history: usage is credited to the
account its pane was pinned to, so a cycle only ever sums what that account
really spent (and "unknown" gets no cycles, having no quota).
"""

from __future__ import annotations

import logging
import math
import re
import sqlite3
import time
from collections.abc import Callable
from datetime import datetime, timezone
from threading import RLock
from typing import Any

from .db import Database
from .pane_account_history import normalize_profile_id, parse_event_time
from .quota_windows import window_seconds
from .tokens_store import SLICE_RETENTION_S, SLICE_S, slice_coverage

log = logging.getLogger(__name__)

_COMPONENT = "quota_ledger"
#: Two snapshots whose reset times differ by less than this describe the
#: same cycle (claude's panel prints the reset to the minute; a parked slot
#: replays its cached figure with the same stamp).
RESET_MATCH_TOLERANCE_S = 120.0
#: How far the reset clock a pane's limit message states may sit from a
#: cycle's own reset before the two describe different windows. Wider than
#: RESET_MATCH_TOLERANCE_S because these are not the same measurement: the
#: cycle's reset is the panel's, to the minute, while the message states a
#: wall clock the CLI prints with the minutes sometimes left off.
EXHAUSTED_MATCH_TOLERANCE_S = 3600.0
#: Window kinds counted as "weekly" in the period statistics; everything
#: else (session/5h, monthly credits, …) is the "cycles" column.
WEEKLY_KINDS = ("weekly", "weekly-model", "secondary")

TotalsProvider = Callable[[str, str, "float | None", float], dict[str, Any]]

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
        .isoformat()
        .replace("+00:00", "Z")
    )


def _add_evidence_schema(cur: sqlite3.Cursor) -> None:
    cur.execute("ALTER TABLE quota_cycles ADD COLUMN exhausted_source TEXT")
    cur.execute("ALTER TABLE quota_cycles ADD COLUMN coverage_state TEXT")
    cur.execute("ALTER TABLE quota_cycles ADD COLUMN coverage_reason TEXT")
    cur.execute("ALTER TABLE quota_cycles ADD COLUMN reconciled_at REAL")
    cur.execute("ALTER TABLE quota_cycles ADD COLUMN last_sample_at REAL")
    cur.execute("UPDATE quota_cycles SET exhausted_source = 'legacy_unknown' WHERE exhausted_at IS NOT NULL")
    cur.execute("UPDATE quota_cycles SET coverage_state = 'unavailable',"
                " coverage_reason = 'legacy_coverage_unknown' WHERE closed = 1")
    cur.execute("UPDATE quota_cycles SET last_sample_at = (SELECT MAX(fetched_at)"
                " FROM quota_samples s WHERE s.agent = quota_cycles.agent"
                " AND s.profile_id = quota_cycles.profile_id"
                " AND s.window_kind = quota_cycles.window_kind"
                " AND ABS(s.resets_at - quota_cycles.resets_at) <= 120)")
    cur.execute("CREATE INDEX quota_cycles_account_reset"
                " ON quota_cycles(agent, profile_id, closed, resets_at)")


def _exclusion(cycle: dict[str, Any]) -> str | None:
    if not cycle["closed"]:
        return "ongoing"
    if cycle["exhausted_at"] is None:
        return "no_limit"
    if cycle["exhausted_source"] not in ("sample", "cli"):
        return "untrusted_source"
    if not cycle["detail_known"]:
        return "unavailable_detail"
    return None


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
        self._db.migrate(_COMPONENT, 2, _add_evidence_schema)
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
                    # A duplicate is not another changed reading, but still
                    # advances freshness and may carry earlier full evidence.
                    with self._db.transaction() as cur:
                        cur.execute(
                            "UPDATE quota_cycles SET last_sample_at = MAX(COALESCE(last_sample_at, ?), ?)"
                            " WHERE agent = ? AND profile_id = ? AND window_kind = ?"
                            " AND ABS(resets_at - ?) <= ?",
                            (fetched, fetched, agent, profile, kind, resets, RESET_MATCH_TOLERANCE_S),
                        )
                        if pct >= 100:
                            cur.execute(
                                "UPDATE quota_cycles SET exhausted_at = ?, exhausted_source = 'sample'"
                                " WHERE agent = ? AND profile_id = ? AND window_kind = ? AND closed = 0"
                                " AND ABS(resets_at - ?) <= ? AND (exhausted_at IS NULL OR exhausted_at > ?)",
                                (fetched, agent, profile, kind, resets, RESET_MATCH_TOLERANCE_S, fetched),
                            )
                            if cur.rowcount:
                                changed.append(key)
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
            "SELECT id, max_percent, exhausted_at, exhausted_source, closed FROM quota_cycles"
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
                " resets_at, max_percent, exhausted_at, exhausted_source, last_sample_at, samples)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                (agent, profile, kind, started_at, resets, pct, exhausted_at,
                 "sample" if exhausted_at is not None else None, fetched),
            )
            return
        if int(row["closed"]):
            return  # a late reading of a frozen cycle changes nothing
        new_max = max(float(row["max_percent"]), pct)
        new_exhausted = row["exhausted_at"]
        source = row["exhausted_source"]
        if exhausted_at is not None and (new_exhausted is None or exhausted_at < new_exhausted):
            new_exhausted = exhausted_at
            source = "sample"
        cur.execute(
            "UPDATE quota_cycles SET max_percent = ?, exhausted_at = ?, exhausted_source = ?,"
            " last_sample_at = MAX(COALESCE(last_sample_at, ?), ?), samples = samples + 1"
            " WHERE id = ? AND closed = 0",
            (new_max, new_exhausted, source, fetched, fetched, int(row["id"])),
        )

    def mark_exhausted(
        self, agent: str, profile_id: str, at: float, resets_at: float | None = None,
        *, window_kind: str | None = None, model_scope: str | None = None,
        reset_precision: str = "unknown",
    ) -> list[str]:
        """Stamp exactly one compatible window; ambiguity is not evidence."""
        if resets_at is None or not math.isfinite(at) or not math.isfinite(resets_at):
            return []
        if reset_precision not in ("exact", "minute", "hour", "clock_only"):
            return []
        if reset_precision == "clock_only" and window_kind != "session":
            return []
        tolerance = EXHAUSTED_MATCH_TOLERANCE_S if reset_precision == "hour" else RESET_MATCH_TOLERANCE_S
        profile = normalize_profile_id(profile_id)
        if profile == "unknown":
            return []

        def model_label(value: str) -> str:
            return re.sub(r"\b(weekly|week|only|model|models)\b|[^a-z0-9]", "", value.casefold())

        def compatible(kind: str) -> bool:
            base, _, label = kind.partition(":")
            if window_kind and ":" in window_kind and kind != window_kind:
                return False
            requested = (window_kind or "").split(":", 1)[0]
            if requested == "weekly":
                if base not in ("weekly", "weekly-model"):
                    return False
            elif requested and base != requested:
                return False
            if model_scope == "all":
                return base != "weekly-model" and not label
            if model_scope:
                return bool(label) and model_label(label) == model_label(model_scope)
            return True

        with self._lock:
            with self._db.transaction() as cur:
                rows = cur.execute(
                    "SELECT id, window_kind, exhausted_at FROM quota_cycles"
                    " WHERE agent = ? AND profile_id = ? AND closed = 0"
                    " AND resets_at > ? AND (started_at IS NULL OR started_at <= ?) AND ABS(resets_at - ?) <= ?",
                    (agent, profile, at, at, resets_at, tolerance),
                ).fetchall()
                candidates = [row for row in rows if compatible(str(row["window_kind"]))]
                if len(candidates) != 1:
                    return []
                row = candidates[0]
                if row["exhausted_at"] is not None and float(row["exhausted_at"]) <= at:
                    return []
                cur.execute(
                    "UPDATE quota_cycles SET exhausted_at = ?, exhausted_source = 'cli' WHERE id = ?",
                    (at, int(row["id"])),
                )
                return [str(row["window_kind"])]

    def _local_totals(self, row: sqlite3.Row, wall: float) -> dict[str, Any]:
        totals = dict(self._totals(
            str(row["agent"]), str(row["profile_id"]), row["started_at"], float(row["resets_at"]),
        ))
        if "coverage_state" not in totals:
            state, reason = slice_coverage(row["started_at"], float(row["resets_at"]), self.slices_since, wall)
            totals.update(coverage_state=state, coverage_reason=reason)
        return totals

    def reconcile_pending(self, store: Any, now: float | None = None) -> list[tuple[str, str, str]]:
        """Re-sum only cycles touched by a bounded batch of retained slices.

        The store drains its own queue before we acquire the ledger lock;
        no store method is called while a database transaction is held.
        Replayed batches are harmless because totals replace, never add.
        """
        wall = _now(now)
        changed: list[tuple[str, str, str]] = []
        changes = store.take_quota_changes(256)
        with self._lock:
            rows_by_id: dict[int, sqlite3.Row] = {}
            with self._db.transaction() as cur:
                for agent, profile, bucket in changes:
                    rows = cur.execute(
                        "SELECT * FROM quota_cycles WHERE agent = ? AND profile_id = ? AND closed = 1"
                        " AND started_at <= ? AND resets_at > ? AND started_at >= ?",
                        (agent, profile, bucket, bucket, wall - SLICE_RETENTION_S),
                    ).fetchall()
                    rows_by_id.update((int(row["id"]), row) for row in rows)
            for row in rows_by_id.values():
                totals = self._local_totals(row, wall)
                if totals["coverage_state"] != "available":
                    continue
                if row["coverage_state"] == "available" and all(int(row[f]) == int(totals.get(f, 0)) for f in _TOKEN_FIELDS):
                    continue
                with self._db.transaction() as cur:
                    cur.execute(
                        "UPDATE quota_cycles SET input = ?, cache_read = ?, cache_creation = ?,"
                        " output = ?, calls = ?, turns = ?, coverage_state = 'available',"
                        " coverage_reason = NULL, reconciled_at = ? WHERE id = ? AND closed = 1",
                        (*(int(totals.get(f, 0)) for f in _TOKEN_FIELDS), wall, int(row["id"])),
                    )
                key = (str(row["agent"]), str(row["profile_id"]), str(row["window_kind"]))
                if key not in changed:
                    changed.append(key)
        return changed

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
                totals = self._local_totals(row, wall)
                with self._db.transaction() as cur:
                    cur.execute(
                        "UPDATE quota_cycles SET input = ?, cache_read = ?, cache_creation = ?,"
                        " output = ?, calls = ?, turns = ?, closed = 1, coverage_state = ?,"
                        " coverage_reason = ?, reconciled_at = ? WHERE id = ?",
                        (*(int(totals.get(f, 0)) for f in _TOKEN_FIELDS), totals["coverage_state"],
                         totals.get("coverage_reason"), wall, int(row["id"])),
                    )
                closed.append(
                    (str(row["agent"]), str(row["profile_id"]), str(row["window_kind"]))
                )
        return closed

    # ── readers ──────────────────────────────────────────────────────

    def identities(self) -> set[tuple[str, str]]:
        with self._db.transaction() as cur:
            return {(str(row[0]), str(row[1])) for row in cur.execute(
                "SELECT DISTINCT agent, profile_id FROM quota_cycles"
            ).fetchall()}

    def query_cycles(
        self, agent: str, profile_id: str, window_kind: str | None = None, *,
        range_start: str | None = None, range_end: str | None = None,
        include_current: bool = True, limit: int = 50,
        cursor: dict | None = None, snapshot: dict | None = None,
        export: bool = False, now: float | None = None,
    ) -> dict[str, Any]:
        """Bounded history with whole-range summary and exclusive keyset pages.

        A page cutoff freezes membership only. Export reads the complete
        bounded range once and derives its summary from those same DTOs.
        """
        wall = _now(now)
        profile = normalize_profile_id(profile_id)
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("invalid-limit")
        if type(include_current) is not bool or type(export) is not bool:
            raise ValueError("invalid-query")
        if export and (cursor is not None or snapshot is not None):
            raise ValueError("export-requires-fresh-query")
        cutoff = wall
        max_id = None
        if snapshot is not None:
            if not isinstance(snapshot, dict):
                raise ValueError("invalid-snapshot")
            cutoff = parse_event_time(str(snapshot.get("at") or ""))
            max_id = snapshot.get("max_cycle_id")
            if cutoff is None or type(max_id) is not int or max_id < 0 or cutoff > wall:
                raise ValueError("invalid-snapshot")
        start = parse_event_time(str(range_start)) if range_start is not None else cutoff - 30 * 86400
        end = parse_event_time(str(range_end)) if range_end is not None else cutoff
        if start is None or end is None or start >= end:
            raise ValueError("invalid-range")
        before = None
        if cursor is not None:
            if not isinstance(cursor, dict):
                raise ValueError("invalid-cursor")
            reset = parse_event_time(str(cursor.get("resets_at") or ""))
            ident = cursor.get("id")
            if reset is None or type(ident) is not int or ident < 1:
                raise ValueError("invalid-cursor")
            before = (reset, ident)
        with self._lock:
            self.close_expired(wall)
            with self._db.transaction() as cur:
                if max_id is None:
                    max_id = cur.execute("SELECT COALESCE(MAX(id), 0) FROM quota_cycles").fetchone()[0]
                sql = "SELECT * FROM quota_cycles WHERE agent = ? AND profile_id = ? AND id <= ?"
                params: list[Any] = [agent, profile, max_id]
                if window_kind:
                    sql += " AND window_kind = ?"
                    params.append(window_kind)
                sql += " AND ((resets_at >= ? AND resets_at < ?)"
                params.extend([start, end])
                if include_current and end >= cutoff:
                    sql += " OR (resets_at > ? AND (started_at IS NULL OR started_at <= ?))"
                    params.extend([cutoff, cutoff])
                sql += ") ORDER BY resets_at DESC, id DESC LIMIT 10001"
                rows = cur.execute(sql, params).fetchall()
                kinds = [str(row[0]) for row in cur.execute(
                    "SELECT DISTINCT window_kind FROM quota_cycles WHERE agent = ? AND profile_id = ? ORDER BY window_kind",
                    (agent, profile),
                ).fetchall()]
            if len(rows) > 10000:
                raise ValueError("range-too-large")
            all_cycles = [self._row_to_cycle(row, wall) for row in rows]
            pairs = [(row, cycle) for row, cycle in zip(rows, all_cycles, strict=True)
                     if before is None or (float(row["resets_at"]), int(row["id"])) < before]
            page = pairs if export else pairs[:limit]
            next_cursor = None
            if len(page) < len(pairs):
                last = page[-1][0]
                next_cursor = {"resets_at": datetime.fromtimestamp(float(last["resets_at"]), timezone.utc).isoformat(),
                               "id": int(last["id"])}
            return {
                "ok": True, "schema_version": 2, "agent_key": agent, "profile_id": profile,
                "cycles": [cycle for _, cycle in page], "summary": self.summarize(all_cycles),
                "total_count": len(rows), "next_cursor": next_cursor,
                "snapshot": {"at": _iso(cutoff), "max_cycle_id": max_id},
                "range_start": _iso(start), "range_end": _iso(end), "include_current": include_current,
                "refreshed_at": _iso(wall), "window_kinds": kinds, "export": export,
            }

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
            state, reason = row["coverage_state"], row["coverage_reason"]
        else:
            totals = self._local_totals(row, wall)
            state, reason = totals["coverage_state"], totals.get("coverage_reason")
        recorded = {f: int(totals.get(f, 0)) for f in _TOKEN_FIELDS}
        recorded["total"] = sum(recorded[f] for f in _TOKEN_FIELDS[:4])
        cycle = {
            "id": int(row["id"]), "agent_key": str(row["agent"]), "profile_id": str(row["profile_id"]),
            "window_kind": str(row["window_kind"]),
            "started_at": _iso(row["started_at"]), "resets_at": _iso(float(row["resets_at"])),
            "closed": closed, "provisional": not closed,
            "max_percent": float(row["max_percent"]),
            "exhausted_at": _iso(row["exhausted_at"]), "exhausted_source": row["exhausted_source"],
            **{f: value if state == "available" else None for f, value in recorded.items()},
            "recorded_totals": recorded, "samples": int(row["samples"]),
            "detail_known": state == "available", "coverage_state": state, "coverage_reason": reason,
            "last_sample_at": _iso(row["last_sample_at"]), "reconciled_at": _iso(row["reconciled_at"]),
            "token_scope": "local_account_all_models", "bucket_seconds": SLICE_S,
        }
        cycle["average_eligible"] = _exclusion(cycle) is None
        return cycle

    @staticmethod
    def summarize(cycles: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """Completed cycles with trusted limit evidence and usable detail only."""
        out: dict[str, dict[str, Any]] = {}
        for cycle in cycles:
            entry = out.setdefault(cycle["window_kind"], {
                "cycles": 0, "exhausted": 0, "_sum": 0, "eligible_count": 0, "excluded_count": 0,
                "exclusions": {k: 0 for k in ("ongoing", "no_limit", "untrusted_source", "unavailable_detail")},
            })
            entry["cycles"] += 1
            entry["exhausted"] += int(cycle["exhausted_at"] is not None)
            reason = _exclusion(cycle)
            if reason is None:
                entry["_sum"] += cycle["total"]
                entry["eligible_count"] += 1
            else:
                entry["excluded_count"] += 1
                entry["exclusions"][reason] += 1
        for entry in out.values():
            total = entry.pop("_sum")
            n = entry["eligible_count"]
            entry["avg_total_exhausted"] = total / n if n else None
        return out

    def period_stats(
        self, granularity: str, now: float | None = None, window_kind: str | None = None,
    ) -> dict[tuple[str, str, str], dict[str, Any]]:
        """(period, agent, profile_id) -> cycle counts for account_periods.
        A cycle belongs to the period of its start (its reset when the start
        is unknown). ``cycles`` / ``exhausted`` / ``avg_total_exhausted``
        cover the non-weekly kinds by default, or the exact selected kind.
        ``weekly_exhausted`` counts the weekly subset; with an explicit
        weekly filter it is already included in ``exhausted``."""
        wall = _now(now)
        with self._lock:
            self.close_expired(wall)
            with self._db.transaction() as cur:
                rows = cur.execute(
                    "SELECT * FROM quota_cycles" + (" WHERE window_kind = ?" if window_kind else ""),
                    (window_kind,) if window_kind else (),
                ).fetchall()
            grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
            weekly: dict[tuple[str, str, str], int] = {}
            for row in rows:
                anchor = row["started_at"] if row["started_at"] is not None else float(row["resets_at"])
                key = (_period_of(float(anchor), granularity), str(row["agent"]), str(row["profile_id"]))
                cycles = grouped.setdefault(key, [])
                if str(row["window_kind"]).split(":", 1)[0] in WEEKLY_KINDS:
                    weekly[key] = weekly.get(key, 0) + int(row["exhausted_at"] is not None)
                    if not window_kind:
                        continue
                cycle = self._row_to_cycle(row, wall)
                cycle["window_kind"] = "selected"
                cycles.append(cycle)
            empty = {"cycles": 0, "exhausted": 0, "avg_total_exhausted": None,
                     "eligible_count": 0, "excluded_count": 0,
                     "exclusions": {k: 0 for k in ("ongoing", "no_limit", "untrusted_source", "unavailable_detail")}}
            return {key: {**self.summarize(cycles).get("selected", empty),
                          "weekly_exhausted": weekly.get(key, 0)} for key, cycles in grouped.items()}

    def reset(self) -> None:
        with self._lock:
            with self._db.transaction() as cur:
                cur.execute("DELETE FROM quota_samples")
                cur.execute("DELETE FROM quota_cycles")
            self._last_sample.clear()


def _now(now: float | None) -> float:
    return time.time() if now is None else float(now)
