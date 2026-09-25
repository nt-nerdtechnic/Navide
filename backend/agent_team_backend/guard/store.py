"""navide.db persistence for the guard: audit log, taint marks, user rules.

Component "guard", schema v4. Only guard_* tables and the ``guard.enabled``
kv key are touched.
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
from typing import Any

from ..db import Database

COMPONENT = "guard"
KV_ENABLED = "guard.enabled"
AUDIT_KEEP = 5000
TAINT_EVENTS_KEEP = 50  # per pane
TAINT_EVENTS_TOTAL = 5000  # across panes: a closed pane never clears its own rows


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


def _v2(cur: sqlite3.Cursor) -> None:
    """One row per delivery that marked a pane. ``msg_key`` is the routing key
    the message log stores as ``correlation_id``, so the text is looked up
    there instead of being stored twice; empty when the path mints none."""
    cur.execute(
        "CREATE TABLE IF NOT EXISTS guard_taint_events ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT, pane_id TEXT NOT NULL, ts REAL NOT NULL,"
        " source TEXT NOT NULL, detail TEXT NOT NULL, msg_key TEXT NOT NULL)"
    )
    cur.execute("CREATE INDEX IF NOT EXISTS guard_taint_events_pane ON guard_taint_events(pane_id, id)")


def _v3(cur: sqlite3.Cursor) -> None:
    """Terminal command protection (see terminal_policy): one row per built-in
    category, seeded with its default, and the user's block patterns / allow
    prefixes. A category with no row — one added after this migration ran —
    takes its default."""
    from .terminal_policy import CATEGORY_IDS, DEFAULT_OFF

    cur.execute(
        "CREATE TABLE IF NOT EXISTS guard_terminal_categories ("
        " id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)"
    )
    cur.executemany(
        "INSERT OR IGNORE INTO guard_terminal_categories (id, enabled) VALUES (?, ?)",
        [(c, int(c not in DEFAULT_OFF)) for c in CATEGORY_IDS],
    )
    cur.execute(
        "CREATE TABLE IF NOT EXISTS guard_terminal_patterns ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " kind TEXT NOT NULL CHECK (kind IN ('block', 'allow')),"
        " pattern TEXT NOT NULL, created REAL NOT NULL)"
    )


def _v4(cur: sqlite3.Cursor) -> None:
    """Editable grading: a level per custom rule (rows written before this
    were forced critical, so a deny keeps "critical"; an allow never raises
    anything and records "normal"), the user's level per built-in rule (no
    row = its default), and the protected-branch list shared by Guard and
    terminal command protection, seeded with the old hard-coded pair."""
    from .classify import PROTECTED_BRANCHES

    cur.execute("ALTER TABLE guard_rules ADD COLUMN level TEXT NOT NULL DEFAULT 'critical'")
    cur.execute("UPDATE guard_rules SET level = 'normal' WHERE kind = 'allow'")
    cur.execute(
        "CREATE TABLE IF NOT EXISTS guard_rule_overrides ("
        " id TEXT PRIMARY KEY, level TEXT NOT NULL CHECK (level IN ('critical', 'high', 'normal')))"
    )
    cur.execute("CREATE TABLE IF NOT EXISTS guard_protected_branches (name TEXT PRIMARY KEY)")
    cur.executemany(
        "INSERT OR IGNORE INTO guard_protected_branches (name) VALUES (?)",
        [(b,) for b in sorted(PROTECTED_BRANCHES)],
    )


_BRANCH_RE = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")


class GuardStore:
    def __init__(self, db: Database) -> None:
        self._db = db
        db.migrate(COMPONENT, 1, _v1)
        db.migrate(COMPONENT, 2, _v2)
        db.migrate(COMPONENT, 3, _v3)
        db.migrate(COMPONENT, 4, _v4)
        self._inserts = 0
        self._terminal_cache: Any = None
        self._grading_cache: tuple[dict[str, str], frozenset[str]] | None = None

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

    def taint_event_add(self, pane_id: str, ts: float, source: str, detail: str, msg_key: str) -> None:
        with self._db.transaction() as cur:
            cur.execute(
                "INSERT INTO guard_taint_events (pane_id, ts, source, detail, msg_key) VALUES (?,?,?,?,?)",
                (pane_id, ts, source, detail, msg_key),
            )
            cur.execute(
                "DELETE FROM guard_taint_events WHERE pane_id = ? AND id NOT IN"
                " (SELECT id FROM guard_taint_events WHERE pane_id = ? ORDER BY id DESC LIMIT ?)",
                (pane_id, pane_id, TAINT_EVENTS_KEEP),
            )
            cur.execute(
                "DELETE FROM guard_taint_events WHERE id <= (SELECT id FROM guard_taint_events"
                " ORDER BY id DESC LIMIT 1 OFFSET ?)",
                (TAINT_EVENTS_TOTAL,),
            )

    def taint_events(self, pane_ids: list[str]) -> list[dict[str, Any]]:
        """Newest first."""
        if not pane_ids:
            return []
        with self._db.transaction() as cur:
            rows = cur.execute(
                "SELECT id, pane_id, ts, source, detail, msg_key FROM guard_taint_events"
                f" WHERE pane_id IN ({','.join('?' * len(pane_ids))}) ORDER BY ts DESC, id DESC LIMIT ?",
                (*pane_ids, TAINT_EVENTS_KEEP),
            ).fetchall()
        return [dict(r) for r in rows]

    def taint_events_move(self, old: str, new: str) -> None:
        with self._db.transaction() as cur:
            cur.execute("UPDATE guard_taint_events SET pane_id = ? WHERE pane_id = ?", (new, old))

    def taint_events_delete(self, pane_id: str) -> None:
        with self._db.transaction() as cur:
            cur.execute("DELETE FROM guard_taint_events WHERE pane_id = ?", (pane_id,))

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

    def rules_add(self, kind: str, pattern: str, note: str = "", level: str = "critical") -> int:
        """``level``: what a matching deny raises to (critical or high); an
        allow always records "normal" — it only ever lowers high."""
        if kind not in ("allow", "deny"):
            raise ValueError("kind must be 'allow' or 'deny'")
        if kind == "allow":
            level = "normal"
        elif level not in ("critical", "high"):
            raise ValueError("level must be 'critical' or 'high'")
        pattern = (pattern or "").strip()
        if not pattern:
            raise ValueError("pattern is empty")
        with self._db.transaction() as cur:
            cur.execute(
                "INSERT INTO guard_rules (kind, pattern, note, created, level) VALUES (?,?,?,?,?)",
                (kind, pattern[:500], (note or "")[:500], time.time(), level),
            )
            return int(cur.lastrowid)

    def rule_get(self, rule_id: int) -> dict[str, Any] | None:
        with self._db.transaction() as cur:
            row = cur.execute("SELECT * FROM guard_rules WHERE id = ?", (int(rule_id),)).fetchone()
        return dict(row) if row else None

    def rules_remove(self, rule_id: int) -> bool:
        with self._db.transaction() as cur:
            cur.execute("DELETE FROM guard_rules WHERE id = ?", (int(rule_id),))
            return cur.rowcount > 0

    # ── built-in rule levels + protected branches ───────────────────

    def grading(self) -> tuple[dict[str, str], frozenset[str]]:
        """(built-in rule level overrides, protected branches) as saved,
        cached until a setter runs: read on every graded tool call."""
        cached = self._grading_cache
        if cached is not None:
            return cached
        with self._db.transaction() as cur:
            overrides = {r["id"]: r["level"] for r in cur.execute(
                "SELECT id, level FROM guard_rule_overrides").fetchall()}
            branches = frozenset(r["name"] for r in cur.execute(
                "SELECT name FROM guard_protected_branches").fetchall())
        self._grading_cache = (overrides, branches)
        return self._grading_cache

    def rule_overrides(self) -> dict[str, str]:
        return dict(self.grading()[0])

    def protected_branches(self) -> frozenset[str]:
        return self.grading()[1]

    def set_rule_level(self, rule_id: str, level: str) -> None:
        """Save the user's level for one built-in rule; its default level
        removes the override row."""
        from .builtin_rules import FLOOR_RULES, LEVELS, RULES_BY_ID

        rule = RULES_BY_ID.get(rule_id)
        if rule is None:
            raise ValueError(f"unknown rule: {rule_id}")
        if level not in LEVELS:
            raise ValueError("level must be 'critical', 'high' or 'normal'")
        if rule_id in FLOOR_RULES and level == "normal":
            raise ValueError(f"{rule_id} can be lowered to high at most")
        with self._db.transaction() as cur:
            if level == rule.level:
                cur.execute("DELETE FROM guard_rule_overrides WHERE id = ?", (rule_id,))
            else:
                cur.execute(
                    "INSERT INTO guard_rule_overrides (id, level) VALUES (?, ?)"
                    " ON CONFLICT(id) DO UPDATE SET level = excluded.level",
                    (rule_id, level),
                )
        self._grading_cache = None

    @staticmethod
    def validate_branch(name: str) -> str:
        name = (name or "").strip().removeprefix("refs/heads/")
        if not _BRANCH_RE.match(name) or ".." in name or name.startswith(("-", "/")) or name.endswith("/"):
            raise ValueError("not a valid branch name")
        return name

    def add_protected_branch(self, name: str) -> None:
        name = self.validate_branch(name)
        with self._db.transaction() as cur:
            cur.execute("INSERT OR IGNORE INTO guard_protected_branches (name) VALUES (?)", (name,))
        self._grading_cache = None
        self._terminal_cache = None

    def remove_protected_branch(self, name: str) -> bool:
        with self._db.transaction() as cur:
            cur.execute("DELETE FROM guard_protected_branches WHERE name = ?", (name,))
            removed = cur.rowcount > 0
        self._grading_cache = None
        self._terminal_cache = None
        return removed

    # ── terminal command protection ──────────────────────────────────

    def terminal_settings(self) -> Any:
        """terminal_policy.Settings as saved, cached until a setter runs."""
        from .terminal_policy import CATEGORY_IDS, DEFAULT_OFF, Settings

        cached = self._terminal_cache
        if cached is not None:
            return cached
        with self._db.transaction() as cur:
            rows = {r["id"]: bool(r["enabled"]) for r in cur.execute(
                "SELECT id, enabled FROM guard_terminal_categories").fetchall()}
        off = [c for c in CATEGORY_IDS if not rows.get(c, c not in DEFAULT_OFF)]
        with self._db.transaction() as cur:
            pats = cur.execute("SELECT kind, pattern FROM guard_terminal_patterns ORDER BY id").fetchall()
        settings = Settings(
            disabled=frozenset(off),
            block_patterns=tuple(r["pattern"] for r in pats if r["kind"] == "block"),
            allow_prefixes=tuple(r["pattern"] for r in pats if r["kind"] == "allow"),
            protected_branches=self.protected_branches(),
        )
        self._terminal_cache = settings
        return settings

    def terminal_patterns(self) -> list[dict[str, Any]]:
        with self._db.transaction() as cur:
            rows = cur.execute("SELECT * FROM guard_terminal_patterns ORDER BY id").fetchall()
        return [dict(r) for r in rows]

    def terminal_set_category(self, category: str, enabled: bool) -> None:
        from .terminal_policy import CATEGORY_IDS

        if category not in CATEGORY_IDS:
            raise ValueError(f"unknown category: {category}")
        with self._db.transaction() as cur:
            cur.execute(
                "INSERT INTO guard_terminal_categories (id, enabled) VALUES (?, ?)"
                " ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled",
                (category, int(bool(enabled))),
            )
        self._terminal_cache = None

    def terminal_add_pattern(self, kind: str, pattern: str) -> int:
        from .terminal_policy import validate_pattern

        if kind not in ("block", "allow"):
            raise ValueError("kind must be 'block' or 'allow'")
        problem = validate_pattern(pattern)
        if problem:
            raise ValueError(problem)
        with self._db.transaction() as cur:
            cur.execute(
                "INSERT INTO guard_terminal_patterns (kind, pattern, created) VALUES (?,?,?)",
                (kind, pattern.strip(), time.time()),
            )
            new_id = int(cur.lastrowid)
        self._terminal_cache = None
        return new_id

    def terminal_pattern(self, pattern_id: int) -> dict[str, Any] | None:
        with self._db.transaction() as cur:
            row = cur.execute("SELECT * FROM guard_terminal_patterns WHERE id = ?", (int(pattern_id),)).fetchone()
        return dict(row) if row else None

    def terminal_remove_pattern(self, pattern_id: int) -> bool:
        with self._db.transaction() as cur:
            cur.execute("DELETE FROM guard_terminal_patterns WHERE id = ?", (int(pattern_id),))
            removed = cur.rowcount > 0
        self._terminal_cache = None
        return removed
