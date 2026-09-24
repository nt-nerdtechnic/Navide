from __future__ import annotations

import asyncio
import sqlite3
import stat
from pathlib import Path

import pytest

from agent_team_backend.channels import imessage as imessage_mod
from agent_team_backend.channels.base import ChannelSendError, InboundMessage, Location
from agent_team_backend.channels.imessage import (
    APPLE_EPOCH_S,
    SEND_SCRIPT,
    IMessageAdapter,
    parse_attributed_body,
)

SCHEMA = """
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, style INTEGER);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
    handle_id INTEGER, is_from_me INTEGER DEFAULT 0, date INTEGER, account TEXT,
    associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
INSERT INTO handle VALUES (1, '+15550001111'), (2, 'me@icloud.com');
INSERT INTO chat VALUES (1, 'iMessage;-;+15550001111', '+15550001111', NULL, 45),
                        (2, 'iMessage;+;chat123', 'chat123', 'Ops', 43),
                        (3, 'iMessage;-;me@icloud.com', 'me@icloud.com', NULL, 45);
"""
DATE_NS = 750000000 * 10**9  # 2024-10-08


def typedstream(text: str) -> bytes:
    """A minimal NSAttributedString typedstream blob, shaped like chat.db's attributedBody."""
    data = text.encode()
    if len(data) < 0x80:
        size = bytes([len(data)])
    else:
        size = b"\x81" + len(data).to_bytes(2, "little")
    return (b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00"
            b"\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+" + size + data
            + b"\x86\x84\x02iI\x01\x05\x92\x84\x84\x84\x0cNSDictionary\x00")


class ChatDb:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.conn = sqlite3.connect(path)
        self.conn.executescript(SCHEMA)
        self.next_id = 1

    def add(self, chat: int, text: str | None, *, handle: int = 1, from_me: int = 0, body: bytes | None = None,
            assoc: int = 0, account: str | None = None) -> int:
        rid = self.next_id
        self.next_id += 1
        self.conn.execute(
            "INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, is_from_me, date, account, "
            "associated_message_type) VALUES (?,?,?,?,?,?,?,?,?)",
            (rid, f"GUID-{rid}", text, body, handle, from_me, DATE_NS, account, assoc))
        self.conn.execute("INSERT INTO chat_message_join VALUES (?, ?)", (chat, rid))
        self.conn.commit()
        return rid


@pytest.fixture
def db(tmp_path: Path):
    d = ChatDb(tmp_path / "chat.db")
    yield d
    d.conn.close()


@pytest.fixture
def osascript(tmp_path: Path) -> Path:
    """Stub osascript: logs argv and stdin; exits 1 when the text contains FAIL."""
    log = tmp_path / "osascript.log"
    script = tmp_path / "osascript"
    script.write_text(
        "#!/bin/sh\n"
        f'LOG="{log}"\n'
        'printf "ARGS:%s|%s|%s\\n" "$1" "$2" "$3" >> "$LOG"\n'
        'cat >> "$LOG"\n'
        'case "$2" in *FAIL*) echo "execution error: Messages got an error" >&2; exit 1;; esac\n'
        "exit 0\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


async def wait_for(pred, timeout: float = 5.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not pred():
        if loop.time() > end:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def make(db: ChatDb, osascript: Path | str = "osascript", **kw) -> IMessageAdapter:
    return IMessageAdapter(db_path=str(db.path), osascript=str(osascript), poll_interval_s=0.02,
                           backoff=lambda n, r: 0.01, platform_name="darwin", **kw)


async def start(adapter: IMessageAdapter, emitted: list[InboundMessage]) -> None:
    async def emit(m: InboundMessage) -> None:
        emitted.append(m)

    await adapter.start(emit)


def test_parse_attributed_body_short_and_long() -> None:
    assert parse_attributed_body(typedstream("hi there")) == "hi there"
    long = "長訊息 " * 100  # > 255 bytes: int16 length
    assert parse_attributed_body(typedstream(long)) == long
    assert parse_attributed_body(b"no string here") == ""
    assert parse_attributed_body(None) == ""


async def test_inbound_mapping_skips_history_own_and_reactions(db: ChatDb) -> None:
    db.add(1, "old history")  # before start: must not replay
    db.add(3, "sent from mac", handle=2, from_me=1, account="E:me@icloud.com")
    adapter = make(db)
    emitted: list[InboundMessage] = []
    await start(adapter, emitted)
    try:
        await wait_for(lambda: adapter.status.lifecycle == "ready")
        assert adapter.status.identity == "me@icloud.com"
        db.add(1, "hello pane")
        db.add(1, None, from_me=1)
        db.add(1, "Loved “hello”", assoc=2000)  # tapback
        db.add(2, None, body=typedstream("from the group￼"))
        await wait_for(lambda: len(emitted) == 2)
    finally:
        await adapter.stop()
    direct, group = emitted
    assert (direct.chat_id, direct.thread_id, direct.sender_id, direct.text) == (
        "iMessage;-;+15550001111", "", "+15550001111", "hello pane")
    assert direct.is_direct and direct.message_id == "GUID-3"
    assert direct.ts == pytest.approx(750000000 + APPLE_EPOCH_S)
    assert (group.chat_id, group.text, group.is_direct) == ("iMessage;+;chat123", "from the group", False)
    titles = {loc["chat_id"]: loc["title"] for loc in adapter.known_locations()}
    assert titles["iMessage;+;chat123"] == "Ops"


async def test_send_chunks_via_argv_and_filters_self_chat_echo(db: ChatDb, osascript: Path, tmp_path: Path) -> None:
    db.add(3, "x", handle=2, from_me=1, account="E:me@icloud.com")
    adapter = make(db, osascript)
    emitted: list[InboundMessage] = []
    await start(adapter, emitted)
    try:
        await wait_for(lambda: adapter.status.lifecycle == "ready")
        self_chat = Location("imessage", "default", "iMessage;-;me@icloud.com")
        ids = await adapter.send_text(self_chat, ("reply line\n" * 500).strip())
        assert ids == ["", ""]
        log = (tmp_path / "osascript.log").read_text()
        assert log.count("ARGS:-|reply line") == 2
        assert log.count("|iMessage;-;me@icloud.com\n") == 2
        assert SEND_SCRIPT in log

        await adapter.send_text(self_chat, "short answer")
        # The phone copy of our own reply comes back as is_from_me=0 from our address.
        db.add(3, "short answer", handle=2)
        db.add(3, "a real question", handle=2)
        await wait_for(lambda: emitted)
        await asyncio.sleep(0.1)
        assert [m.text for m in emitted] == ["a real question"]

        with pytest.raises(ChannelSendError, match="Messages got an error"):
            await adapter.send_text(self_chat, "FAIL now")
        with pytest.raises(NotImplementedError):
            await adapter.edit_text(self_chat, "", "x")
        with pytest.raises(NotImplementedError):
            await adapter.create_location("x", "pane")
        await adapter.send_typing(self_chat)  # no-op
    finally:
        await adapter.stop()


async def test_unreadable_db_blocks_with_full_disk_access_hint(tmp_path: Path) -> None:
    adapter = IMessageAdapter(db_path=str(tmp_path / "missing" / "chat.db"), poll_interval_s=0.02,
                              backoff=lambda n, r: 0.01, platform_name="darwin")
    await adapter.start(lambda m: asyncio.sleep(0))
    try:
        await wait_for(lambda: adapter.status.lifecycle == "blocked")
        assert "Full Disk Access" in adapter.status.last_error
    finally:
        await adapter.stop()


async def test_non_macos_is_blocked(db: ChatDb) -> None:
    adapter = IMessageAdapter(db_path=str(db.path), platform_name="linux")
    await adapter.start(lambda m: asyncio.sleep(0))
    assert adapter.status.lifecycle == "blocked" and "macOS" in adapter.status.last_error
    await adapter.stop()


async def test_reconnect_after_drop_keeps_watermark(db: ChatDb, monkeypatch) -> None:
    db.add(1, "old history")
    adapter = make(db)
    emitted: list[InboundMessage] = []
    await start(adapter, emitted)
    try:
        await wait_for(lambda: adapter.status.lifecycle == "ready")
        good_sql = imessage_mod._POLL_SQL
        # Break polling: every session now fails and the loop keeps reconnecting.
        monkeypatch.setattr(imessage_mod, "_POLL_SQL", "SELECT * FROM no_such_table WHERE ? > 0")
        await wait_for(lambda: "no_such_table" in adapter.status.last_error)
        db.add(1, "sent while down")
        monkeypatch.setattr(imessage_mod, "_POLL_SQL", good_sql)
        await wait_for(lambda: bool(emitted))
    finally:
        await adapter.stop()
    # The watermark survived the reconnects: nothing replayed, nothing lost.
    assert [m.text for m in emitted] == ["sent while down"]


def test_create_adapter_needs_no_secret(tmp_path: Path) -> None:
    a = imessage_mod.create_adapter({"db_path": str(tmp_path / "c.db")}, {}, store=None)
    assert isinstance(a, IMessageAdapter) and a.account == "default"
    assert a._db_path == str(tmp_path / "c.db") and a.known_locations() == []
