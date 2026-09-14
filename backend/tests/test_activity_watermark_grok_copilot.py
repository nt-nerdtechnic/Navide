"""copilot activity dedup must fit the durable "@activity" bag.

copilot's reader used to leave one key per item in the `seen_keys` bag
parse_activity is handed — an `act:<line>` per JSONL line plus a `db_act:*` per
store row. In a store that holds every session ever run, those bags cross the
watcher's
`_ACTIVITY_KEYS_PERSIST_LIMIT` within a handful of turns, and an over-limit bag
is dropped whole rather than truncated. So nothing was ever written to the
durable checkpoint and both vendors replayed their entire history — every
`agent_active`, every `turn_complete` with its turn text and MSG blocks — on
every backend start (GitHub #28).

The fix is the same consolidation cursor/antigravity/opencode already use: one
bounded watermark instead of per-item keys. These tests pin all three halves of
that — the bag stays persistable, a restart resumes from it, and the watermark
neither replays a row nor skips one.

grok used to be tested here too, on the same SQLite store. The official xAI CLI
keeps one JSONL transcript per session instead, so its half moved to
tests/vendors/test_grok.py with the reader; only the shared dispatch check at
the bottom still names it.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.copilot import CopilotLogReader
from agent_team_backend.cli_vendors.grok import GrokLogReader
from agent_team_backend.log_readers.watcher import _ACTIVITY_KEYS_PERSIST_LIMIT


# ── the bag round-trip the watcher actually performs ────────────────────────

def _persisted(bag: set[str]) -> set[str]:
    """The bag as it comes back out of the checkpoint store, or a failure.

    _persist_activity_seen refuses an over-limit bag outright, so a reader that
    exceeds the limit gets an empty bag back on the next start — which is
    exactly the full replay this is all about. Round-tripping through JSON also
    catches a sentinel that cannot survive serialization.
    """
    assert len(bag) <= _ACTIVITY_KEYS_PERSIST_LIMIT, (
        f"bag of {len(bag)} keys exceeds the persist limit "
        f"({_ACTIVITY_KEYS_PERSIST_LIMIT}); it would be dropped whole: "
        f"{sorted(bag)}"
    )
    return {str(k) for k in json.loads(json.dumps(sorted(bag)))}


# ── copilot fixtures ────────────────────────────────────────────────────────

def _copilot_db(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / "session-store.db"
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT,
          host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
          user_message TEXT, assistant_response TEXT, timestamp TEXT,
          UNIQUE(session_id, turn_index));
        CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL, turn_index INTEGER, agent_id TEXT,
          parent_tool_call_id TEXT, model TEXT NOT NULL, input_tokens INTEGER,
          output_tokens INTEGER, cache_read_tokens INTEGER,
          cache_write_tokens INTEGER, reasoning_tokens INTEGER,
          total_nano_aiu INTEGER, request_multiplier REAL, duration_ms INTEGER,
          time_to_first_token_ms INTEGER, inter_token_latency_ms INTEGER,
          initiator TEXT, api_endpoint TEXT, reasoning_effort TEXT,
          finish_reason TEXT, content_filter_triggered INTEGER,
          token_details_json TEXT, created_at TEXT);
        """
    )
    con.commit()
    con.close()
    return path


def _copilot_session(path: Path, sid: str, cwd: str = "/repo") -> None:
    con = sqlite3.connect(path)
    con.execute("INSERT OR IGNORE INTO sessions (id, cwd) VALUES (?,?)", (sid, cwd))
    con.commit()
    con.close()


def _copilot_turn(path: Path, sid: str, idx: int, user: str, reply: str) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO turns (session_id, turn_index, user_message, "
        "assistant_response, timestamp) VALUES (?,?,?,?,?)",
        (sid, idx, user, reply, "2026-09-07T00:00:00Z"),
    )
    con.execute(
        "INSERT INTO assistant_usage_events (session_id, turn_index, model, "
        "input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?,?)",
        (sid, idx, "gpt-5", 10, 5, "2026-09-07T00:00:00Z"),
    )
    con.commit()
    con.close()


def _events_jsonl(root: Path, sid: str, turns: int) -> Path:
    d = root / "session-state" / sid
    d.mkdir(parents=True, exist_ok=True)
    path = d / "events.jsonl"
    with path.open("w", encoding="utf-8") as fh:
        for i in range(turns):
            for rec in (
                {"type": "user.message", "data": {"content": f"q{i}"},
                 "timestamp": f"2026-09-07T00:00:{i:02d}Z"},
                {"type": "assistant.message", "data": {"content": f"a{i}"},
                 "timestamp": f"2026-09-07T00:00:{i:02d}Z"},
                {"type": "assistant.turn_end", "data": {},
                 "timestamp": f"2026-09-07T00:00:{i:02d}Z"},
            ):
                fh.write(json.dumps(rec) + "\n")
    return path


# ── copilot: the store ──────────────────────────────────────────────────────

def test_copilot_store_bag_stays_persistable(tmp_path: Path) -> None:
    """One store holds every session. 30 sessions x 8 turns used to leave 480
    `db_act:*` keys — 60x the limit."""
    root = tmp_path / ".copilot"
    db = _copilot_db(root)
    # One connection and one commit, for the same reason as the grok bag test.
    con = sqlite3.connect(db)
    for s in range(30):
        sid = f"sess-{s}"
        con.execute("INSERT OR IGNORE INTO sessions (id, cwd) VALUES (?,?)", (sid, "/repo"))
        for t in range(8):
            con.execute(
                "INSERT INTO turns (session_id, turn_index, user_message, "
                "assistant_response, timestamp) VALUES (?,?,?,?,?)",
                (sid, t, f"q{t}", f"a{t}", "2026-09-07T00:00:00Z"),
            )
            con.execute(
                "INSERT INTO assistant_usage_events (session_id, turn_index, model, "
                "input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?,?)",
                (sid, t, "gpt-5", 10, 5, "2026-09-07T00:00:00Z"),
            )
    con.commit()
    con.close()

    seen: set[str] = set()
    events = CopilotLogReader().parse_activity(db, seen)

    assert events
    assert len(seen) <= _ACTIVITY_KEYS_PERSIST_LIMIT, sorted(seen)
    _persisted(seen)


def test_copilot_store_restart_replays_nothing(tmp_path: Path) -> None:
    """The #28 regression for copilot's store path."""
    root = tmp_path / ".copilot"
    db = _copilot_db(root)
    _copilot_session(db, "s1")
    for t in range(5):
        _copilot_turn(db, "s1", t, f"q{t}", f"a{t}")

    first = CopilotLogReader().parse_activity(db, (bag := set()))
    assert first

    second = CopilotLogReader().parse_activity(db, _persisted(bag))
    assert second == [], f"replayed {len(second)} historic event(s)"


def test_copilot_store_delivers_every_row_exactly_once(tmp_path: Path) -> None:
    root = tmp_path / ".copilot"
    db = _copilot_db(root)
    _copilot_session(db, "s1")

    reader = CopilotLogReader()
    bag: set[str] = set()
    turns: list[str] = []
    for t in range(8):
        _copilot_turn(db, "s1", t, f"q{t}", f"a{t}")
        bag = _persisted(bag)
        turns += [e.dedup_key for e in reader.parse_activity(db, bag)
                  if e.event_type == "turn_complete"]

    assert turns == [f"db_turn:{n}" for n in range(1, 9)]


def test_copilot_store_re_anchors_when_it_is_replaced(tmp_path: Path) -> None:
    """AUTOINCREMENT ids never repeat — but a REPLACED store restarts them at
    1, and the bag is keyed by path, so the old mark would swallow the lot."""
    root = tmp_path / ".copilot"
    db = _copilot_db(root)
    _copilot_session(db, "s1")
    for t in range(5):
        _copilot_turn(db, "s1", t, f"q{t}", f"a{t}")

    reader = CopilotLogReader()
    bag: set[str] = set()
    reader.parse_activity(db, bag)

    db.unlink()
    _copilot_db(root)
    _copilot_session(db, "s2")
    _copilot_turn(db, "s2", 0, "fresh", "reply")

    # Re-anchoring to the new MAX(id) instead of 0 would step straight over
    # this row: it carries id 1, below a mark of 5, yet has never been sent.
    keys = [e.dedup_key for e in reader.parse_activity(db, _persisted(bag))
            if e.event_type == "turn_complete"]
    assert keys == ["db_turn:1"], keys


# ── copilot: events.jsonl ───────────────────────────────────────────────────

def test_copilot_jsonl_bag_is_one_mark_not_one_key_per_line(tmp_path: Path) -> None:
    root = tmp_path / ".copilot"
    path = _events_jsonl(root, "s1", turns=200)

    seen: set[str] = set()
    events = CopilotLogReader().parse_activity(path, seen)

    assert len(events) == 600
    assert len(seen) <= _ACTIVITY_KEYS_PERSIST_LIMIT, sorted(seen)
    _persisted(seen)


def test_copilot_jsonl_restart_replays_nothing(tmp_path: Path) -> None:
    root = tmp_path / ".copilot"
    path = _events_jsonl(root, "s1", turns=20)

    first = CopilotLogReader().parse_activity(path, (bag := set()))
    assert first

    second = CopilotLogReader().parse_activity(path, _persisted(bag))
    assert second == [], f"replayed {len(second)} historic event(s)"


def test_copilot_jsonl_delivers_appended_lines_exactly_once(tmp_path: Path) -> None:
    root = tmp_path / ".copilot"
    path = _events_jsonl(root, "s1", turns=3)

    reader = CopilotLogReader()
    bag: set[str] = set()
    seen_keys = [e.dedup_key for e in reader.parse_activity(path, bag)]

    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "user.message", "data": {"content": "q3"},
                             "timestamp": "t"}) + "\n")
    bag = _persisted(bag)
    after = [e.dedup_key for e in reader.parse_activity(path, bag)]

    assert after == ["act:10"], after
    assert "act:10" not in seen_keys


def test_copilot_jsonl_holds_the_mark_behind_a_partial_line(tmp_path: Path) -> None:
    """GitHub #21: advancing past a half-written turn-end record drops it for
    good and leaves the pane mid-turn forever."""
    root = tmp_path / ".copilot"
    path = _events_jsonl(root, "s1", turns=1)
    reader = CopilotLogReader()
    bag: set[str] = set()
    reader.parse_activity(path, bag)

    complete = json.dumps({"type": "assistant.turn_end", "data": {},
                           "timestamp": "t9"})
    with path.open("a", encoding="utf-8") as fh:
        fh.write(complete[:20])                       # mid-write, no newline
    assert reader.parse_activity(path, bag) == []

    with path.open("a", encoding="utf-8") as fh:
        fh.write(complete[20:] + "\n")                # the CLI finishes it
    kinds = [e.event_type for e in reader.parse_activity(path, _persisted(bag))]
    assert kinds == ["turn_complete"], kinds


def test_copilot_jsonl_steps_over_a_terminated_corrupt_line(tmp_path: Path) -> None:
    """Unchanged behaviour, and why the partial-line test checks the newline:
    a terminated line that will not parse never will, so holding the mark
    behind it would re-emit the whole rest of the file on every poll."""
    root = tmp_path / ".copilot"
    path = _events_jsonl(root, "s1", turns=1)
    with path.open("a", encoding="utf-8") as fh:
        fh.write("NOT JSON AT ALL\n")
        fh.write(json.dumps({"type": "user.message", "data": {"content": "q"},
                             "timestamp": "t"}) + "\n")

    reader = CopilotLogReader()
    bag: set[str] = set()
    reader.parse_activity(path, bag)

    assert reader.parse_activity(path, _persisted(bag)) == []


# ── the dispatch these two were missing ─────────────────────────────────────

@pytest.mark.parametrize("vendor", ["grok", "copilot"])
def test_neither_vendor_declares_the_line_seeding_hook(vendor: str) -> None:
    """Neither resumes by counting lines: copilot's ONE reader serves both a
    JSONL log and a SQLite store, and grok's cursor is a byte offset because its
    eventId sequence is not written in order. So neither may claim
    `activity_resumes_by_line` — the watcher would count newlines and drop a
    line number into a bag nothing consults."""
    reader = {"grok": GrokLogReader, "copilot": CopilotLogReader}[vendor]()
    assert reader.activity_resumes_by_line is False
