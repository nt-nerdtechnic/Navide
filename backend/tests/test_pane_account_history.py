"""pane_account_history: which account a pane was pinned to, and when.

The token ledgers ask this store one question — ``profile_at(pane, ts)`` —
so the tests pin its answers: a two-segment pane (account A, then resumed
on account B) attributes by the event's own time, gaps and never-pinned
panes read "unknown", and intervals survive a restart.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.db import Database
from agent_team_backend.pane_account_history import (
    PIN_LEAD_TOLERANCE_S,
    PaneAccountHistory,
    normalize_profile_id,
    parse_event_time,
)


@pytest.fixture
def db(tmp_path: Path) -> Database:
    database = Database(tmp_path / "navide.db")
    yield database
    database.close()


def test_two_segments_attribute_by_event_time(db: Database) -> None:
    history = PaneAccountHistory(db)
    assert history.pin("pane-1", "acct-a", ts=1000.0) is True
    # The spawn bookkeeping repeats the same pin a beat later: no new row.
    assert history.pin("pane-1", "acct-a", ts=1001.0) is False
    # Resumed on another account at t=2000.
    assert history.pin("pane-1", "acct-b", ts=2000.0) is True

    assert history.profile_at("pane-1", 1500.0) == "acct-a"
    assert history.profile_at("pane-1", 1999.9) == "acct-a"
    assert history.profile_at("pane-1", 2000.0) == "acct-b"
    assert history.profile_at("pane-1", 9999.0) == "acct-b"   # still open
    assert history.profile_at("pane-1", None) == "acct-b"     # "now"
    assert history.intervals("pane-1") == [
        ("acct-a", 1000.0, 2000.0), ("acct-b", 2000.0, None),
    ]


def test_unknown_bucket_for_unpinned_gaps_and_legacy_ids(db: Database) -> None:
    history = PaneAccountHistory(db)
    assert history.profile_at("never-pinned", 1000.0) == "unknown"
    assert history.profile_at("", 1000.0) == "unknown"

    history.pin("pane-1", "acct-a", ts=1000.0)
    history.release("pane-1", ts=1500.0)
    assert history.profile_at("pane-1", 1600.0) == "unknown"   # closed
    assert history.profile_at("pane-1", None) == "unknown"
    # A turn from before the pin (a resumed transcript's history) is unknown
    # — except within the lead tolerance for the CLI's first call.
    assert history.profile_at("pane-1", 1000.0 - PIN_LEAD_TOLERANCE_S) == "acct-a"
    assert history.profile_at("pane-1", 1000.0 - PIN_LEAD_TOLERANCE_S - 1) == "unknown"

    # "" (pane older than pinning / vendor without accounts) is stored as unknown.
    history.pin("pane-2", "", ts=10.0)
    assert history.profile_at("pane-2", 11.0) == "unknown"
    assert normalize_profile_id("  ") == "unknown"
    assert normalize_profile_id("__default__") == "__default__"


def test_release_is_idempotent_and_repin_reopens(db: Database) -> None:
    history = PaneAccountHistory(db)
    assert history.release("pane-1", ts=5.0) is False
    history.pin("pane-1", "acct-a", ts=1000.0)
    assert history.release("pane-1", ts=1200.0) is True
    assert history.release("pane-1", ts=1300.0) is False
    # A respawn of the same pane id on the same account opens a NEW interval
    # — the closed one is not extended, so the gap stays unknown.
    assert history.pin("pane-1", "acct-a", ts=1400.0) is True
    assert history.profile_at("pane-1", 1250.0) == "unknown"
    assert history.profile_at("pane-1", 1450.0) == "acct-a"


def test_intervals_survive_a_restart(tmp_path: Path) -> None:
    db = Database(tmp_path / "navide.db")
    first = PaneAccountHistory(db)
    first.pin("pane-1", "acct-a", ts=1000.0)
    first.pin("pane-1", "acct-b", ts=2000.0)
    db.close()

    db = Database(tmp_path / "navide.db")
    try:
        second = PaneAccountHistory(db)
        assert second.profile_at("pane-1", 1500.0) == "acct-a"
        assert second.profile_at("pane-1", 2500.0) == "acct-b"
        # The open interval is still open and can be closed by the new process.
        assert second.release("pane-1", ts=3000.0) is True
    finally:
        db.close()


def test_parse_event_time_accepts_iso_and_epoch_millis() -> None:
    assert parse_event_time("2026-09-16T00:00:00Z") == 1789516800.0
    assert parse_event_time("2026-09-16T00:00:00+00:00") == 1789516800.0
    assert parse_event_time("2026-09-16T00:00:00") == 1789516800.0   # naive = UTC
    assert parse_event_time("1789516800000") == 1789516800.0          # opencode ms
    assert parse_event_time("1789516800") == 1789516800.0
    assert parse_event_time("") is None
    assert parse_event_time("not a date") is None
