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


def test_summary_and_period_stats(tmp_path: Path, totals: _Totals) -> None:
    from agent_team_backend.quota_ledger import SLICES_SINCE_KEY

    # Slices have existed since T0, so every cycle below has known detail.
    db = Database(tmp_path / "navide.db")
    db.kv_set(SLICES_SINCE_KEY, T0, now=1)
    ledger = QuotaLedger(db, totals)
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
    db.close()


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


def test_close_expired_never_asks_for_totals_inside_a_transaction(tmp_path: Path) -> None:
    """The totals provider takes the tokens store's lock; the store takes the
    database lock while holding its own (a workspace cache miss inside
    record()). Asking for the sums inside close_expired's transaction is a
    lock-order inversion — with a provider that yields to a thread doing
    exactly that, the old code deadlocked both threads."""
    import threading

    from agent_team_backend.tokens_store import TokensStore

    db = Database(tmp_path / "navide.db")
    store = TokensStore(global_path=tmp_path / "g.json", workspace_base_dir=tmp_path / "w", db=db)
    in_totals = threading.Event()
    other_holds_store_lock = threading.Event()

    def totals(agent: str, profile: str, start: float | None, end: float) -> dict[str, int]:
        in_totals.set()
        other_holds_store_lock.wait(2)
        return store.account_window_totals(agent, profile, start, end)

    ledger = QuotaLedger(db, totals)
    resets = T0 + 5 * H
    ledger.observe("claude", "acct-a", _snap(50.0, resets, T0 + H), now=T0 + H)

    def store_then_db() -> None:
        in_totals.wait(2)
        with store._lock:
            other_holds_store_lock.set()
            with db.transaction() as cur:
                cur.execute("SELECT 1")

    closer = threading.Thread(target=lambda: ledger.close_expired(resets + 1), daemon=True)
    other = threading.Thread(target=store_then_db, daemon=True)
    closer.start()
    other.start()
    closer.join(5)
    other.join(5)
    # Deadlocked threads hold the database lock, so close() would hang too:
    # leave the daemon threads behind and fail plainly.
    deadlocked = closer.is_alive() or other.is_alive()
    if not deadlocked:
        [cycle] = ledger.cycles("claude", "acct-a", now=resets + 1)
        assert cycle["closed"] is True
        db.close()
    assert not deadlocked, "lock-order deadlock between the ledger and the tokens store"


def test_weekly_model_is_keyed_by_label_even_when_it_is_the_only_row(ledger: QuotaLedger) -> None:
    """The per-model weekly rows come and go (a promotional model's week);
    keying by count would rename the same window when a second row appears
    and open a duplicate cycle for it."""
    weekly = T0 + 7 * 86400
    single = _snap(5.0, T0 + 5 * H, T0 + 10, extra=[
        {"kind": "weekly-model", "label": "Opus only", "usedPercent": 5.0, "resetsAt": _iso(weekly)},
    ])
    ledger.observe("claude", "acct-a", single, now=T0 + 10)
    assert [c["window_kind"] for c in ledger.cycles("claude", "acct-a", now=T0 + 10)] == [
        "weekly-model:Opus only", "session",
    ]
    both = _snap(5.0, T0 + 5 * H, T0 + 900, extra=[
        {"kind": "weekly-model", "label": "Opus only", "usedPercent": 6.0, "resetsAt": _iso(weekly)},
        {"kind": "weekly-model", "label": "Sonnet only", "usedPercent": 1.0, "resetsAt": _iso(weekly)},
    ])
    ledger.observe("claude", "acct-a", both, now=T0 + 900)
    kinds = {c["window_kind"]: c for c in ledger.cycles("claude", "acct-a", now=T0 + 900)}
    assert set(kinds) == {"weekly-model:Opus only", "weekly-model:Sonnet only", "session"}
    # The same Opus window kept its cycle (two samples), not a second one.
    assert kinds["weekly-model:Opus only"]["samples"] == 2
    assert kinds["weekly-model:Opus only"]["max_percent"] == 6.0


def test_detail_known_follows_the_slices_since_mark(tmp_path: Path, totals: _Totals) -> None:
    from agent_team_backend.quota_ledger import SLICES_SINCE_KEY

    db = Database(tmp_path / "navide.db")
    try:
        # An existing database without the mark gets "now", written once.
        first = QuotaLedger(db, totals)
        assert first.slices_since == pytest.approx(db.kv_get(SLICES_SINCE_KEY))
        assert first.slices_since > T0
        db.kv_set(SLICES_SINCE_KEY, T0 + 5 * H, now=1)
        ledger = QuotaLedger(db, totals)
        assert ledger.slices_since == T0 + 5 * H      # kept, not overwritten
        # Cycle that started (and closed) before the mark → false.
        ledger.observe("claude", "acct-a", _snap(100.0, T0 + 5 * H, T0 + H), now=T0 + H)
        # Cycle starting exactly at the mark → true; a later one → true.
        ledger.observe("claude", "acct-a", _snap(10.0, T0 + 10 * H, T0 + 6 * H), now=T0 + 6 * H)
        # A calendar window with no start → false.
        ledger.observe("grok", "__default__", {
            "provider": "grok", "status": "ok", "fetchedAt": _iso(T0 + 6 * H),
            "windows": [{"kind": "monthly", "label": "Monthly credits",
                         "usedPercent": 1.0, "resetsAt": _iso(T0 + 40 * 86400)}],
        }, now=T0 + 6 * H)
        cycles = ledger.cycles("claude", "acct-a", now=T0 + 7 * H)
        assert [(c["resets_at"], c["closed"], c["detail_known"]) for c in cycles] == [
            (_iso(T0 + 10 * H), False, True), (_iso(T0 + 5 * H), True, False),
        ]
        [monthly] = ledger.cycles("grok", "__default__", now=T0 + 7 * H)
        assert monthly["started_at"] is None and monthly["detail_known"] is False
    finally:
        db.close()


def test_avg_total_exhausted_ignores_cycles_without_detail(tmp_path: Path, totals: _Totals) -> None:
    from agent_team_backend.quota_ledger import SLICES_SINCE_KEY

    db = Database(tmp_path / "navide.db")
    try:
        db.kv_set(SLICES_SINCE_KEY, T0 + 5 * H, now=1)   # slices exist from the 2nd cycle on
        ledger = QuotaLedger(db, totals)
        # Cycle 0: exhausted, started before the mark → detail_known False; its
        # (unrecorded) usage must not drag the mean down.
        ledger.observe("claude", "acct-a", _snap(100.0, T0 + 5 * H, T0 + H), now=T0 + H)
        # Cycles 1 and 2: exhausted with known detail, 2000 and 4000 tokens.
        for n, tokens in ((1, 2000), (2, 4000)):
            start = T0 + n * 5 * H
            ledger.observe("claude", "acct-a", _snap(100.0, start + 5 * H, start + H), now=start + H)
            totals.add("claude", "acct-a", start + 2 * H, tokens)
        # Cycle 3: known detail but not exhausted → not in the mean either.
        start = T0 + 15 * H
        ledger.observe("claude", "acct-a", _snap(30.0, start + 5 * H, start + H), now=start + H)
        totals.add("claude", "acct-a", start + 2 * H, 999)

        cycles = ledger.cycles("claude", "acct-a", now=start + 2 * H)
        assert [c["detail_known"] for c in cycles] == [True, True, True, False]
        summary = QuotaLedger.summarize(cycles)["session"]
        assert summary == {"cycles": 4, "exhausted": 3, "avg_total_exhausted": 3000.0}
        stats = ledger.period_stats("month", now=start + 2 * H)[("2026-09", "claude", "acct-a")]
        assert (stats["cycles"], stats["exhausted"], stats["avg_total_exhausted"]) == (4, 3, 3000.0)

        # Only the detail-less exhausted cycle → null, not 0.0.
        assert QuotaLedger.summarize([cycles[-1]])["session"]["avg_total_exhausted"] is None
    finally:
        db.close()
