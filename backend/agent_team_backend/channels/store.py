"""Channel persistence in the shared global ``navide.db`` (component ``channels``).

Only non-secret data lives here. Bot tokens and app secrets go to
``credential_vault.write_app_secret(f"channel-{platform}", ...)``.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from typing import Any

from ..db import Database
from .base import Location

COMPONENT = "channels"
KV_ENABLED = "channels.enabled"


def _v1(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE IF NOT EXISTS channel_accounts ("
        " platform TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,"
        " config_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)"
    )
    cur.execute(
        "CREATE TABLE IF NOT EXISTS channel_pairing_requests ("
        " platform TEXT NOT NULL, code TEXT NOT NULL, sender_id TEXT NOT NULL,"
        " sender_name TEXT NOT NULL, chat_id TEXT NOT NULL, created_at INTEGER NOT NULL,"
        " PRIMARY KEY (platform, code))"
    )
    cur.execute(
        "CREATE TABLE IF NOT EXISTS channel_allow ("
        " platform TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL,"
        " added_at INTEGER NOT NULL, PRIMARY KEY (platform, sender_id))"
    )
    cur.execute(
        "CREATE TABLE IF NOT EXISTS channel_bindings ("
        " pane_id TEXT PRIMARY KEY, platform TEXT NOT NULL, account TEXT NOT NULL,"
        " chat_id TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',"
        " created_at INTEGER NOT NULL, UNIQUE (platform, account, chat_id, thread_id))"
    )
    cur.execute(
        "CREATE TABLE IF NOT EXISTS channel_offsets ("
        " platform TEXT NOT NULL, account TEXT NOT NULL, bot_id TEXT NOT NULL,"
        " offset INTEGER NOT NULL, PRIMARY KEY (platform, account))"
    )


def _v2(cur: sqlite3.Cursor) -> None:
    # Chats a bot has seen, so the pane picker survives a backend restart.
    cur.execute(
        "CREATE TABLE IF NOT EXISTS channel_chats ("
        " platform TEXT NOT NULL, chat_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',"
        " kind TEXT NOT NULL DEFAULT 'group', supports_topics INTEGER NOT NULL DEFAULT 0,"
        " last_seen INTEGER NOT NULL, PRIMARY KEY (platform, chat_id))"
    )


def _v3(cur: sqlite3.Cursor) -> None:
    # Seen chats belong to the bot that saw them: a new token must not offer the
    # old bot's chats. Rows from v2 keep bot '' until their platform next starts.
    cur.execute(
        "CREATE TABLE channel_chats_v3 ("
        " platform TEXT NOT NULL, bot TEXT NOT NULL DEFAULT '', chat_id TEXT NOT NULL,"
        " title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'group',"
        " supports_topics INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL,"
        " PRIMARY KEY (platform, bot, chat_id))"
    )
    cur.execute(
        "INSERT INTO channel_chats_v3 (platform, bot, chat_id, title, kind, supports_topics, last_seen)"
        " SELECT platform, '', chat_id, title, kind, supports_topics, last_seen FROM channel_chats"
    )
    cur.execute("DROP TABLE channel_chats")
    cur.execute("ALTER TABLE channel_chats_v3 RENAME TO channel_chats")


@dataclass
class PairingRequest:
    platform: str
    code: str
    sender_id: str
    sender_name: str
    chat_id: str
    created_at: int

    def public(self) -> dict[str, Any]:
        return {"platform": self.platform, "code": self.code, "sender_id": self.sender_id,
                "sender_name": self.sender_name, "created_at": self.created_at}


@dataclass
class Binding:
    pane_id: str
    platform: str
    account: str
    chat_id: str
    thread_id: str
    title: str
    created_at: int

    def location(self) -> Location:
        return Location(self.platform, self.account, self.chat_id, self.thread_id, self.title)

    def public(self) -> dict[str, Any]:
        return {"pane_id": self.pane_id, "platform": self.platform, "account": self.account,
                "chat_id": self.chat_id, "thread_id": self.thread_id, "title": self.title}


class ChannelStore:
    def __init__(self, db: Database) -> None:
        self._db = db
        db.migrate(COMPONENT, 1, _v1)
        db.migrate(COMPONENT, 2, _v2)
        db.migrate(COMPONENT, 3, _v3)

    def _rows(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._db.transaction() as cur:
            return list(cur.execute(sql, args).fetchall())

    def _exec(self, sql: str, args: tuple = ()) -> int:
        with self._db.transaction() as cur:
            cur.execute(sql, args)
            return cur.rowcount

    # --- kill switch ----------------------------------------------------------

    def global_enabled(self) -> bool:
        return bool(self._db.kv_get(KV_ENABLED, True))

    def set_global_enabled(self, enabled: bool) -> None:
        self._db.kv_set(KV_ENABLED, bool(enabled), now=int(time.time()))

    # --- accounts -------------------------------------------------------------

    def accounts(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for r in self._rows("SELECT platform, enabled, config_json FROM channel_accounts"):
            try:
                config = json.loads(r["config_json"] or "{}")
            except json.JSONDecodeError:
                config = {}
            out[r["platform"]] = {"enabled": bool(r["enabled"]), "config": config}
        return out

    def upsert_account(self, platform: str, config: dict[str, Any], enabled: bool | None = None) -> None:
        payload = json.dumps(config, ensure_ascii=False, separators=(",", ":"))
        now = int(time.time())
        with self._db.transaction() as cur:
            cur.execute(
                "INSERT INTO channel_accounts (platform, enabled, config_json, updated_at)"
                " VALUES (?, ?, ?, ?) ON CONFLICT(platform) DO UPDATE SET"
                " config_json = excluded.config_json, updated_at = excluded.updated_at",
                (platform, 1 if enabled is None else int(bool(enabled)), payload, now),
            )
            if enabled is not None:
                cur.execute("UPDATE channel_accounts SET enabled = ? WHERE platform = ?",
                            (int(bool(enabled)), platform))

    def set_account_enabled(self, platform: str, enabled: bool) -> bool:
        return self._exec("UPDATE channel_accounts SET enabled = ?, updated_at = ? WHERE platform = ?",
                          (int(bool(enabled)), int(time.time()), platform)) > 0

    def remove_platform(self, platform: str) -> None:
        with self._db.transaction() as cur:
            for table in ("channel_accounts", "channel_pairing_requests", "channel_allow",
                          "channel_bindings", "channel_offsets", "channel_chats"):
                cur.execute(f"DELETE FROM {table} WHERE platform = ?", (platform,))

    # --- seen chats -----------------------------------------------------------

    def remember_chat(self, platform: str, bot: str, chat_id: str, title: str, kind: str,
                      supports_topics: bool, now: int) -> bool:
        """Upsert a chat ``bot`` has seen; True when it (or its topic support) is new."""
        with self._db.transaction() as cur:
            prev = cur.execute("SELECT supports_topics FROM channel_chats"
                               " WHERE platform = ? AND bot = ? AND chat_id = ?",
                               (platform, bot, chat_id)).fetchone()
            cur.execute(
                "INSERT INTO channel_chats (platform, bot, chat_id, title, kind, supports_topics, last_seen)"
                " VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform, bot, chat_id) DO UPDATE SET"
                " title = CASE WHEN excluded.title != '' THEN excluded.title ELSE channel_chats.title END,"
                " kind = excluded.kind,"
                " supports_topics = MAX(channel_chats.supports_topics, excluded.supports_topics),"
                " last_seen = excluded.last_seen",
                (platform, bot, chat_id, title, kind, int(bool(supports_topics)), now),
            )
        return prev is None or (bool(supports_topics) and not prev["supports_topics"])

    def adopt_chats(self, platform: str, bot: str) -> int:
        """Hand v2 rows (seen before chats had a bot) to the bot now running."""
        return self._exec("UPDATE OR IGNORE channel_chats SET bot = ? WHERE platform = ? AND bot = ''",
                          (bot, platform))

    def chats(self, platform: str, bot: str) -> list[dict[str, Any]]:
        return [{"chat_id": r["chat_id"], "title": r["title"], "kind": r["kind"],
                 "supports_topics": bool(r["supports_topics"])}
                for r in self._rows("SELECT * FROM channel_chats WHERE platform = ? AND bot = ?"
                                    " ORDER BY last_seen DESC", (platform, bot))]

    # --- pairing --------------------------------------------------------------

    def list_pairing(self, platform: str | None) -> list[PairingRequest]:
        if platform:
            rows = self._rows("SELECT * FROM channel_pairing_requests WHERE platform = ?"
                              " ORDER BY created_at", (platform,))
        else:
            rows = self._rows("SELECT * FROM channel_pairing_requests ORDER BY created_at")
        return [PairingRequest(r["platform"], r["code"], r["sender_id"], r["sender_name"],
                               r["chat_id"], int(r["created_at"])) for r in rows]

    def add_pairing(self, req: PairingRequest) -> None:
        self._exec("INSERT INTO channel_pairing_requests VALUES (?, ?, ?, ?, ?, ?)",
                   (req.platform, req.code, req.sender_id, req.sender_name, req.chat_id, req.created_at))

    def pop_pairing(self, platform: str, code: str) -> PairingRequest | None:
        with self._db.transaction() as cur:
            r = cur.execute("SELECT * FROM channel_pairing_requests WHERE platform = ? AND code = ?",
                            (platform, code)).fetchone()
            if r is None:
                return None
            cur.execute("DELETE FROM channel_pairing_requests WHERE platform = ? AND code = ?",
                        (platform, code))
            return PairingRequest(r["platform"], r["code"], r["sender_id"], r["sender_name"],
                                  r["chat_id"], int(r["created_at"]))

    def delete_pairing_older_than(self, cutoff: float) -> int:
        return self._exec("DELETE FROM channel_pairing_requests WHERE created_at < ?", (int(cutoff),))

    # --- allowlist ------------------------------------------------------------

    def is_allowed(self, platform: str, sender_id: str) -> bool:
        return bool(self._rows("SELECT 1 FROM channel_allow WHERE platform = ? AND sender_id = ?",
                               (platform, sender_id)))

    def add_allow(self, platform: str, sender_id: str, sender_name: str, added_at: int) -> None:
        self._exec("INSERT INTO channel_allow VALUES (?, ?, ?, ?) ON CONFLICT(platform, sender_id)"
                   " DO UPDATE SET sender_name = excluded.sender_name",
                   (platform, sender_id, sender_name, added_at))

    def list_allow(self, platform: str | None) -> list[dict[str, Any]]:
        if platform:
            rows = self._rows("SELECT * FROM channel_allow WHERE platform = ? ORDER BY added_at", (platform,))
        else:
            rows = self._rows("SELECT * FROM channel_allow ORDER BY added_at")
        return [dict(r) for r in rows]

    def remove_allow(self, platform: str, sender_id: str) -> bool:
        return self._exec("DELETE FROM channel_allow WHERE platform = ? AND sender_id = ?",
                          (platform, sender_id)) > 0

    # --- bindings -------------------------------------------------------------

    def bindings(self) -> list[Binding]:
        return [Binding(r["pane_id"], r["platform"], r["account"], r["chat_id"], r["thread_id"],
                        r["title"], int(r["created_at"]))
                for r in self._rows("SELECT * FROM channel_bindings ORDER BY created_at")]

    def bind(self, pane_id: str, loc: Location) -> Binding:
        now = int(time.time())
        with self._db.transaction() as cur:
            # One pane <-> one location: rebinding either side replaces the old row.
            cur.execute("DELETE FROM channel_bindings WHERE pane_id = ? OR (platform = ? AND account = ?"
                        " AND chat_id = ? AND thread_id = ?)",
                        (pane_id, loc.platform, loc.account, loc.chat_id, loc.thread_id))
            cur.execute("INSERT INTO channel_bindings VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (pane_id, loc.platform, loc.account, loc.chat_id, loc.thread_id, loc.title, now))
        return Binding(pane_id, loc.platform, loc.account, loc.chat_id, loc.thread_id, loc.title, now)

    def unbind(self, pane_id: str) -> Binding | None:
        with self._db.transaction() as cur:
            r = cur.execute("SELECT * FROM channel_bindings WHERE pane_id = ?", (pane_id,)).fetchone()
            if r is None:
                return None
            cur.execute("DELETE FROM channel_bindings WHERE pane_id = ?", (pane_id,))
            return Binding(r["pane_id"], r["platform"], r["account"], r["chat_id"], r["thread_id"],
                           r["title"], int(r["created_at"]))

    def rename_pane(self, old_pane_id: str, new_pane_id: str) -> bool:
        return self._exec("UPDATE channel_bindings SET pane_id = ? WHERE pane_id = ?",
                          (new_pane_id, old_pane_id)) > 0

    # --- offsets (Telegram OffsetStore protocol) --------------------------------

    def get_offset(self, platform: str, account: str, bot_id: str) -> int | None:
        rows = self._rows("SELECT bot_id, offset FROM channel_offsets WHERE platform = ? AND account = ?",
                          (platform, account))
        if not rows or rows[0]["bot_id"] != bot_id:
            return None  # none stored, or it belongs to a previous bot token
        return int(rows[0]["offset"])

    def set_offset(self, platform: str, account: str, bot_id: str, offset: int) -> None:
        self._exec("INSERT INTO channel_offsets VALUES (?, ?, ?, ?) ON CONFLICT(platform, account)"
                   " DO UPDATE SET bot_id = excluded.bot_id, offset = excluded.offset",
                   (platform, account, bot_id, int(offset)))
