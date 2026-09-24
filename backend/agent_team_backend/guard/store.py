"""navide.db persistence for the guard: audit log, taint marks, user rules.

Component "guard", schema v1. Only guard_* tables and the ``guard.enabled``
kv key are touched.
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from ..db import Database

COMPONENT = "guard"
KV_ENABLED = "guard.enabled"
AUDIT_KEEP = 5000


def _v1(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE IF NOT EXISTS guard_audit ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL,"
        " pane_id TEXT NOT NULL, vendor TEXT NOT NULL, source TEXT NOT NULL,"
        " tool TEXT NOT NULL, excerpt TEXT NOT NULL, level TEXT NOT NULL,"
        " action TEXT NOT NULL, rule_ids TEXT NOT NULL, tainted INTEGER NOT NULL)"
    )
    cur.execute("CREATE INDEX IF NOT EXISTS guard_audit_ts ON guard_audit(ts)")
    cur.execute("CREATE INDEX IF NOT EXISTS guard_audit_pane ON guard_audit(pane_id, ts)")
    cur.execute(
        "CREATE TABLE IF NOT EXISTS guard_taint ("
        " pane_id TEXT PRIMARY KEY, sources_json TEXT NOT NULL,"
        " since REAL NOT NULL, detail TEXT NOT NULL)"
    )
    cur.execute(
        "CREATE TABLE IF NOT EXISTS guard_rules ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " kind TEXT NOT NULL CHECK (kind IN ('allow', 'deny')),"
        " pattern TEXT NOT NULL, note TEXT NOT NULL, created REAL NOT NULL)"
    )


class GuardStore:
    def __init__(self, db: Database) -> None:
        self._db = db
        db.migrate(COMPONENT, 1, _v1)
        self._inserts = 0

    # ── enabled ──────────────────────────────────────────────────────

    def enabled(self) -> bool:
        return bool(self._db.kv_get(KV_ENABLED, True))

    def set_enabled(self, enabled: bool) -> None:
        self._db.kv_set(KV_ENABLED, bool(enabled), now=int(time.time()))

    # ── audit ────────────────────────────────────────────────────────

    def audit_add(self, entry: dict[str, Any]) -> None:
        with self._db.transaction() as cur:
            cur.execute(
                "INSERT INTO guard_audit (ts, pane_id, vendor, source, tool, excerpt,"
                " level, action, rule_ids, tainted) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    entry.get("ts", time.time()), entry["pane_id"], entry["vendor"],
                    entry["source"], entry["tool"], entry["excerpt"], entry["level"],
                    entry["action"], json.dumps(list(entry["rule_ids"])), int(bool(entry["tainted"])),
                ),
            )
            self._inserts += 1
            if self._inserts % 100 == 0:
                cur.execute(
                    "DELETE FROM guard_audit WHERE id <= (SELECT id FROM guard_audit"
                    " ORDER BY id DESC LIMIT 1 OFFSET ?)",
                    (AUDIT_KEEP,),
                )

    def audit_list(self, limit: int = 100, pane_id: str | None = None) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit or 100), 1000))
        sql = "SELECT * FROM guard_audit"
        args: tuple = ()
        if pane_id:
            sql += " WHERE pane_id = ?"
            args = (pane_id,)
        sql += " ORDER BY id DESC LIMIT ?"
        with self._db.transaction() as cur:
            rows = cur.execute(sql, args + (limit,)).fetchall()
        return [
            {**dict(r), "rule_ids": json.loads(r["rule_ids"]), "tainted": bool(r["tainted"])}
            for r in rows
        ]

    def audit_counts(self, since: float) -> dict[str, int]:
        with self._db.transaction() as cur:
            row = cur.execute(
                "SELECT"
                " SUM(level = 'critical') AS critical, SUM(level = 'high') AS high,"
                " SUM(action = 'ask') AS asks, SUM(action = 'deny') AS denies_24h"
                " FROM guard_audit WHERE ts >= ?",
                (since,),
            ).fetchone()
        return {k: int(row[k] or 0) for k in ("critical", "high", "asks", "denies_24h")}

    # ── taint ────────────────────────────────────────────────────────

    def taint_get(self, pane_id: str) -> dict[str, Any] | None:
        with self._db.transaction() as cur:
            row = cur.execute("SELECT * FROM guard_taint WHERE pane_id = ?", (pane_id,)).fetchone()
        return self._taint_row(row) if row else None

    def taint_upsert(self, pane_id: str, sources: list[str], since: float, detail: str) -> None:
        with self._db.transaction() as cur:
            cur.execute(
                "INSERT INTO guard_taint (pane_id, sources_json, since, detail) VALUES (?,?,?,?)"
                " ON CONFLICT(pane_id) DO UPDATE SET sources_json = excluded.sources_json,"
                " detail = excluded.detail",
                (pane_id, json.dumps(sorted(set(sources))), since, detail),
            )

    def taint_delete(self, pane_id: str) -> bool:
        with self._db.transaction() as cur:
            cur.execute("DELETE FROM guard_taint WHERE pane_id = ?", (pane_id,))
            return cur.rowcount > 0

    def taint_list(self) -> list[dict[str, Any]]:
        with self._db.transaction() as cur:
            rows = cur.execute("SELECT * FROM guard_taint ORDER BY since DESC").fetchall()
        return [self._taint_row(r) for r in rows]

    @staticmethod
    def _taint_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "pane_id": row["pane_id"],
            "sources": json.loads(row["sources_json"]),
            "since": row["since"],
            "detail": row["detail"],
        }

    # ── user rules ───────────────────────────────────────────────────

    def rules_list(self) -> list[dict[str, Any]]:
        with self._db.transaction() as cur:
            rows = cur.execute("SELECT * FROM guard_rules ORDER BY id").fetchall()
        return [dict(r) for r in rows]

    def rules_add(self, kind: str, pattern: str, note: str = "") -> int:
        if kind not in ("allow", "deny"):
            raise ValueError("kind must be 'allow' or 'deny'")
        pattern = (pattern or "").strip()
        if not pattern:
            raise ValueError("pattern is empty")
        with self._db.transaction() as cur:
            cur.execute(
                "INSERT INTO guard_rules (kind, pattern, note, created) VALUES (?,?,?,?)",
                (kind, pattern[:500], (note or "")[:500], time.time()),
            )
            return int(cur.lastrowid)

    def rules_remove(self, rule_id: int) -> bool:
        with self._db.transaction() as cur:
            cur.execute("DELETE FROM guard_rules WHERE id = ?", (int(rule_id),))
            return cur.rowcount > 0
