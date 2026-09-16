"""quota_ledger: samples → cycles, on a fake clock.

Pinned: a sample opens the cycle its reset time names (start = reset − the
vendor's window length), repeated identical readings are not re-filed, the
first 100 % sample stamps exhausted_at without closing the cycle, the cycle
freezes its token sums the moment the reset passes, two per-model weekly
rows stay two cycles, a calendar window starts where the previous one
reset, and the period statistics split session vs weekly kinds.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.db import Database
from agent_team_backend.quota_ledger import QuotaLedger, window_kinds_of
from agent_team_backend.quota_windows import window_seconds

T0 = 1789516800.0  # 2026-09-16T00:00:00Z
H = 3600.0


class _Totals:
    """A totals provider that serves whatever the test says the account spent
    in [start, end), and records what it was asked."""

    def __init__(self) -> None:
        self.spent: dict[tuple[str, str], list[tuple[float, int]]] = {}
        self.calls: list[tuple[str, str, float | None, float]] = []

    def add(self, agent: str, profile: str, ts: float, tokens: int) -> None:
        self.spent.setdefault((agent, profile), []).append((ts, tokens))

    def __call__(self, agent: str, profile: str, start: float | None, end: float) -> dict[str, int]:
        self.calls.append((agent, profile, start, end))
        rows = [
            t for ts, t in self.spent.get((agent, profile), [])
            if (start is None or ts >= start) and ts < end
        ]
        return {
            "input": sum(rows), "cache_read": 0, "cache_creation": 0, "output": 0,
            "calls": len(rows), "turns": len(rows),
        }


@pytest.fixture
def totals() -> _Totals:
    return _Totals()


@pytest.fixture
def ledger(tmp_path: Path, totals: _Totals):
    db = Database(tmp_path / "navide.db")
    yield QuotaLedger(db, totals)
    db.close()


def _iso(ts: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def _snap(pct: float, resets: float, fetched: float, kind: str = "session",
          status: str = "ok", stale: bool = False, extra: list | None = None) -> dict:
    windows = [{"kind": kind, "label": "Session (5h)", "usedPercent": pct, "resetsAt": _iso(resets)}]
    if extra:
        windows.extend(extra)
    return {"provider": "claude", "status": status, "stale": stale,
            "windows": windows, "fetchedAt": _iso(fetched)}


def test_a_sample_opens_the_cycle_its_reset_names(ledger: QuotaLedger, totals: _Totals) -> None:
    resets = T0 + 5 * H
    assert window_seconds("claude", "session") == 5 * 3600
    changed = ledger.observe("claude", "acct-a", _snap(6.0, resets, T0 + 10), now=T0 + 10)
    assert changed == [("claude", "acct-a", "session")]
    totals.add("claude", "acct-a", T0 + 1000, 1_000)
    cycles = ledger.cycles("claude", "acct-a", now=T0 + 2000)
    assert len(cycles) == 1
    cycle = cycles[0]
    assert cycle["started_at"] == _iso(T0)
    assert cycle["resets_at"] == _iso(resets)
    assert cycle["closed"] is False
    assert cycle["max_percent"] == 6.0
    assert cycle["exhausted_at"] is None
    assert cycle["samples"] == 1
    # Open: summed live from the provider over [started_at, resets_at).
    assert (cycle["input"], cycle["total"], cycle["calls"], cycle["turns"]) == (1000, 1000, 1, 1)
    assert totals.calls[-1] == ("claude", "acct-a", T0, resets)


def test_identical_readings_are_not_refiled_but_changes_are(ledger: QuotaLedger) -> None:
    resets = T0 + 5 * H
    ledger.observe("claude", "acct-a", _snap(6.0, resets, T0 + 10), now=T0 + 10)
    assert ledger.observe("claude", "acct-a", _snap(6.0, resets, T0 + 900), now=T0 + 900) == []
    assert ledger.observe("claude", "acct-a", _snap(40.0, resets, T0 + 1800), now=T0 + 1800) == [
        ("claude", "acct-a", "session")
    ]
    cycle = ledger.cycles("claude", "acct-a", now=T0 + 1900)[0]
    assert cycle["max_percent"] == 40.0 and cycle["samples"] == 2
    # A reading that is not a fresh ok snapshot is ignored outright.
    assert ledger.observe("claude", "acct-a", _snap(99.0, resets, T0 + 2000, stale=True)) == []
    assert ledger.observe("claude", "acct-a", _snap(99.0, resets, T0 + 2000, status="error")) == []


def test_exhausted_at_is_the_first_full_sample_and_does_not_close(
    ledger: QuotaLedger, totals: _Totals,
) -> None:
    resets = T0 + 5 * H
    ledger.observe("claude", "acct-a", _snap(90.0, resets, T0 + 3 * H), now=T0 + 3 * H)
    ledger.observe("claude", "acct-a", _snap(100.0, resets, T0 + 4 * H), now=T0 + 4 * H)
    ledger.observe("claude", "acct-a", _snap(100.0, resets, T0 + 4.5 * H), now=T0 + 4.5 * H)
    cycle = ledger.cycles("claude", "acct-a", now=T0 + 4.6 * H)[0]
    assert cycle["exhausted_at"] == _iso(T0 + 4 * H)
    assert cycle["closed"] is False
    assert cycle["max_percent"] == 100.0
    # The zero-spend tail after 100 % still belongs to this cycle.
    totals.add("claude", "acct-a", T0 + 4.2 * H, 5)
    assert ledger.cycles("claude", "acct-a", now=T0 + 4.6 * H)[0]["input"] == 5


def test_a_cycle_freezes_when_its_reset_passes(ledger: QuotaLedger, totals: _Totals) -> None:
    resets = T0 + 5 * H
    ledger.observe("claude", "acct-a", _snap(50.0, resets, T0 + H), now=T0 + H)
    totals.add("claude", "acct-a", T0 + 2 * H, 700)
    # Still open at T0+4h.
    assert ledger.cycles("claude", "acct-a", now=T0 + 4 * H)[0]["closed"] is False
    # The next observation after the reset closes it — and opens the next.
    changed = ledger.observe(
        "claude", "acct-a", _snap(1.0, resets + 5 * H, resets + 60), now=resets + 60,
    )
    assert set(changed) == {("claude", "acct-a", "session")}
    cycles = ledger.cycles("claude", "acct-a", now=resets + 120)
    assert [c["closed"] for c in cycles] == [False, True]      # newest reset first
    frozen = cycles[1]
    assert frozen["input"] == 700 and frozen["calls"] == 1
    # Frozen: usage that arrives late for that window no longer changes it,
    # and a late sample for it changes nothing either.
    totals.add("claude", "acct-a", T0 + 3 * H, 999)
    ledger.observe("claude", "acct-a", _snap(77.0, resets, resets + 200), now=resets + 200)
    again = ledger.cycles("claude", "acct-a", now=resets + 300)[1]
    assert again["input"] == 700 and again["max_percent"] == 50.0 and again["samples"] == 1


def test_close_expired_runs_without_a_new_sample(ledger: QuotaLedger, totals: _Totals) -> None:
    resets = T0 + 5 * H
    ledger.observe("claude", "acct-a", _snap(50.0, resets, T0 + H), now=T0 + H)
    assert ledger.close_expired(now=T0 + 2 * H) == []
    assert ledger.close_expired(now=resets) == [("claude", "acct-a", "session")]
    assert ledger.close_expired(now=resets + 1) == []


def test_per_model_weekly_rows_stay_separate_cycles(ledger: QuotaLedger) -> None:
    weekly = T0 + 7 * 86400
    extra = [
        {"kind": "weekly", "label": "Weekly (all models)", "usedPercent": 30.0, "resetsAt": _iso(weekly)},
        {"kind": "weekly-model", "label": "Opus only", "usedPercent": 10.0, "resetsAt": _iso(weekly)},
        {"kind": "weekly-model", "label": "Fable only", "usedPercent": 90.0, "resetsAt": _iso(weekly)},
    ]
    snap = _snap(5.0, T0 + 5 * H, T0 + 10, extra=extra)
    assert [kind for _, kind in window_kinds_of(snap)] == [
        "session", "weekly", "weekly-model:Opus only", "weekly-model:Fable only",
    ]
    ledger.observe("claude", "acct-a", snap, now=T0 + 10)
    kinds = {c["window_kind"]: c for c in ledger.cycles("claude", "acct-a", now=T0 + 20)}
    assert set(kinds) == {"session", "weekly", "weekly-model:Opus only", "weekly-model:Fable only"}
    assert kinds["weekly-model:Fable only"]["max_percent"] == 90.0
    # weekly-model shares the weekly length.
    assert kinds["weekly-model:Opus only"]["started_at"] == _iso(T0)
    only = ledger.cycles("claude", "acct-a", window_kind="weekly", now=T0 + 20)
    assert [c["window_kind"] for c in only] == ["weekly"]


def test_calendar_windows_start_where_the_previous_cycle_reset(ledger: QuotaLedger) -> None:
    first_reset = T0 + 30 * 86400
    snap = {"provider": "grok", "status": "ok", "fetchedAt": _iso(T0),
            "windows": [{"kind": "monthly", "label": "Monthly credits",
                         "usedPercent": 20.0, "resetsAt": _iso(first_reset)}]}
    ledger.observe("grok", "__default__", snap, now=T0)
    [cycle] = ledger.cycles("grok", "__default__", now=T0 + 1)
    assert cycle["started_at"] is None          # nothing before it
    second_reset = first_reset + 31 * 86400
    snap["windows"][0].update({"usedPercent": 3.0, "resetsAt": _iso(second_reset)})
    snap["fetchedAt"] = _iso(first_reset + 10)
    ledger.observe("grok", "__default__", snap, now=first_reset + 10)
    newest = ledger.cycles("grok", "__default__", now=first_reset + 20)[0]
    assert newest["resets_at"] == _iso(second_reset)
    assert newest["started_at"] == _iso(first_reset)


def test_codex_window_minutes_win_over_the_table(ledger: QuotaLedger) -> None:
    resets = T0 + 3 * H
    snap = {"provider": "codex", "status": "ok", "fetchedAt": _iso(T0),
            "windows": [{"kind": "session", "label": "Session", "usedPercent": 1.0,
                         "resetsAt": _iso(resets), "windowMinutes": 180}]}
    ledger.observe("codex", "acct-c", snap, now=T0)
    assert ledger.cycles("codex", "acct-c", now=T0 + 1)[0]["started_at"] == _iso(T0)


def test_summary_and_period_stats(ledger: QuotaLedger, totals: _Totals) -> None:
    # Three 5h cycles, two exhausted, plus one exhausted weekly, all in 2026-09.
    for n, pct in enumerate((100.0, 100.0, 60.0)):
        start = T0 + n * 5 * H
        ledger.observe("claude", "acct-a", _snap(pct, start + 5 * H, start + H), now=start + H)
        totals.add("claude", "acct-a", start + 2 * H, 1000 * (n + 1))
    weekly = {"kind": "weekly", "label": "Weekly", "usedPercent": 100.0, "resetsAt": _iso(T0 + 7 * 86400)}
    ledger.observe("claude", "acct-a", _snap(60.0, T0 + 15 * H, T0 + 12 * H, extra=[weekly]),
                   now=T0 + 12 * H)
    # Everything older than the third cycle has reset by now.
    cycles = ledger.cycles("claude", "acct-a", now=T0 + 12 * H)
    summary = QuotaLedger.summarize(cycles)
    assert summary["session"] == {"cycles": 3, "exhausted": 2, "avg_total_exhausted": 1500.0}
    # The weekly window covers all three 5h cycles: 1000 + 2000 + 3000.
    assert summary["weekly"] == {"cycles": 1, "exhausted": 1, "avg_total_exhausted": 6000.0}
    stats = ledger.period_stats("month", now=T0 + 12 * H)
    assert stats == {("2026-09", "claude", "acct-a"): {
        "cycles": 3, "exhausted": 2, "avg_total_exhausted": 1500.0, "weekly_exhausted": 1,
    }}
    assert set(ledger.period_stats("year", now=T0 + 12 * H)) == {("2026", "claude", "acct-a")}


def test_last_samples_survive_a_restart(tmp_path: Path, totals: _Totals) -> None:
    resets = T0 + 5 * H
    db = Database(tmp_path / "navide.db")
    QuotaLedger(db, totals).observe("claude", "acct-a", _snap(6.0, resets, T0 + 10), now=T0 + 10)
    db.close()
    db = Database(tmp_path / "navide.db")
    try:
        again = QuotaLedger(db, totals)
        # The identical reading is still recognised as already filed.
        assert again.observe("claude", "acct-a", _snap(6.0, resets, T0 + 900), now=T0 + 900) == []
        assert again.cycles("claude", "acct-a", now=T0 + 1000)[0]["samples"] == 1
    finally:
        db.close()


def test_pane_detection_moves_exhausted_at_earlier_but_never_later(
    ledger: QuotaLedger,
) -> None:
    resets = T0 + 5 * H                      # window 00:00 → 05:00Z
    # First 100 % sample at 14:35 (relative: T0 + 4h35m); the pane saw ⛔ at 14:31.
    sample_at = T0 + 4 * H + 35 * 60
    seen_at = T0 + 4 * H + 31 * 60
    ledger.observe("claude", "acct-a", _snap(100.0, resets, sample_at), now=sample_at)
    assert ledger.mark_exhausted("claude", "acct-a", seen_at) == ["session"]
    assert ledger.cycles("claude", "acct-a", now=sample_at + 1)[0]["exhausted_at"] == _iso(seen_at)
    # A detection AFTER the sample does not override it; neither does a
    # detection outside the window, an unknown account, or a closed cycle.
    assert ledger.mark_exhausted("claude", "acct-a", sample_at + 60) == []
    assert ledger.cycles("claude", "acct-a", now=sample_at + 1)[0]["exhausted_at"] == _iso(seen_at)
    assert ledger.mark_exhausted("claude", "acct-a", resets + 10) == []
    assert ledger.mark_exhausted("claude", "unknown", seen_at) == []
    ledger.close_expired(now=resets)
    assert ledger.mark_exhausted("claude", "acct-a", seen_at - 60) == []
    # Without any sample at 100 % the detection sets exhausted_at on its own.
    ledger.observe("claude", "acct-b", _snap(80.0, resets, T0 + H), now=T0 + H)
    assert ledger.mark_exhausted("claude", "acct-b", T0 + 2 * H) == ["session"]
    assert ledger.cycles("claude", "acct-b", now=T0 + 3 * H)[0]["exhausted_at"] == _iso(T0 + 2 * H)
