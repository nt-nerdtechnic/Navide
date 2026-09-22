"""tokens_store: the account / version dimensions and the per-account ledgers.

Conservation is the property that matters — every new bucket family
(by_account, by_version, by_account_day, token_slices) is fed from the same
delta as by_vendor, so their sums must always equal by_vendor's. The rest
pins where an event lands (its own day and 5-minute slice, "unknown" for an
unresolved account, ``vendor@unknown`` for a missing version) and that the
slices survive a restart and a global reset.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

from agent_team_backend.db import Database
from agent_team_backend.tokens_store import SLICE_RETENTION_S, SLICE_S, TokensStore


@pytest.fixture
def store(tmp_path: Path) -> TokensStore:
    return TokensStore(
        global_path=tmp_path / "global-tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
    )


@pytest.fixture
def workspace(tmp_path: Path) -> str:
    ws = tmp_path / "ws"
    ws.mkdir()
    return str(ws)


_EVENTS = [
    # vendor, profile, version, input, cache_read, cache_creation, output, ts
    ("claude", "acct-a", "2.1.273", 1000, 800, 100, 50, "2026-09-16T01:00:00Z"),
    ("claude", "acct-a", "2.1.273", 2000, 1500, 0, 70, "2026-09-16T01:03:00Z"),
    ("claude", "acct-b", "2.1.270", 300, 0, 0, 20, "2026-09-16T02:00:00Z"),
    ("claude", "", "", 40, 0, 0, 5, "2026-09-15T23:59:59Z"),
    ("codex", "acct-a", "0.154.0", 500, 0, 0, 60, "2026-09-16T01:04:00Z"),
    ("codex", "unknown", "", 10, 0, 0, 1, ""),  # no stamp: lands on today
]


def _feed(store: TokensStore, workspace: str) -> None:
    for n, (vendor, profile, version, inp, cr, cc, out, ts) in enumerate(_EVENTS):
        assert store.record(
            workspace, source="cli", vendor=vendor,
            input_tokens=inp, output_tokens=out, dedup_key=f"e{n}",
            profile_id=profile, cli_version=version,
            cache_read_tokens=cr, cache_creation_tokens=cc, timestamp=ts,
        )


def _sum(buckets: dict, field: str) -> int:
    return sum(int(b[field]) for b in buckets.values())


def test_by_account_and_by_version_conserve_by_vendor(store: TokensStore, workspace: str) -> None:
    _feed(store, workspace)
    snap = store.snapshot(workspace)
    for scope in (snap["workspace"]["cumulative"], snap["global"]):
        for field in ("input", "output", "calls"):
            assert _sum(scope["by_account"], field) == _sum(scope["by_vendor"], field)
            assert _sum(scope["by_version"], field) == _sum(scope["by_vendor"], field)
    cum = snap["workspace"]["cumulative"]
    # Buckets have the by_vendor shape; "" and "unknown" share one bucket.
    assert cum["by_account"]["acct-a"] == {"input": 3500, "output": 180, "calls": 3}
    assert cum["by_account"]["acct-b"] == {"input": 300, "output": 20, "calls": 1}
    assert cum["by_account"]["unknown"] == {"input": 50, "output": 6, "calls": 2}
    assert set(cum["by_version"]) == {
        "claude@2.1.273", "claude@2.1.270", "claude@unknown", "codex@0.154.0", "codex@unknown",
    }
    assert cum["by_version"]["claude@2.1.273"] == {"input": 3000, "output": 120, "calls": 2}


def test_by_account_day_conserves_by_vendor_with_the_four_way_split(
    store: TokensStore, workspace: str,
) -> None:
    _feed(store, workspace)
    g = store.snapshot(workspace)["global"]
    days = g["by_account_day"]
    for vendor, vendor_bucket in g["by_vendor"].items():
        rows = [
            bucket
            for profiles in [days[vendor]]
            for by_day in profiles.values()
            for bucket in by_day.values()
        ]
        assert sum(b["input"] + b["cache_read"] + b["cache_creation"] for b in rows) == vendor_bucket["input"]
        assert sum(b["output"] for b in rows) == vendor_bucket["output"]
        assert sum(b["calls"] for b in rows) == vendor_bucket["calls"]
    # The event lands on ITS OWN UTC day, not the ingestion day.
    assert days["claude"]["acct-a"]["2026-09-16"] == {
        "input": 600, "cache_read": 2300, "cache_creation": 100, "output": 120,
        "calls": 2, "turns": 0,
    }
    assert days["claude"]["unknown"]["2026-09-15"]["calls"] == 1
    today = time.strftime("%Y-%m-%d", time.gmtime())
    assert days["codex"]["unknown"][today]["calls"] == 1
    # account_day_rows flattens the same ledger.
    rows = store.account_day_rows()
    assert ("claude", "acct-b", "2026-09-16") in {(a, p, d) for a, p, d, _ in rows}


def test_record_turn_counts_on_the_events_day_and_slice(store: TokensStore, workspace: str) -> None:
    now = time.time()
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
    store.record(
        workspace, source="cli", vendor="claude", input_tokens=10, output_tokens=1,
        dedup_key="k1", profile_id="acct-a", timestamp=stamp,
    )
    store.record_turn("claude", "acct-a", stamp)
    store.record_turn("claude", "acct-a", stamp)
    store.record_turn("claude", "", stamp)   # unknown bucket, tokens unchanged
    day = time.strftime("%Y-%m-%d", time.gmtime(now))
    days = store.snapshot(None)["global"]["by_account_day"]["claude"]
    assert days["acct-a"][day]["turns"] == 2
    assert days["acct-a"][day]["calls"] == 1
    assert days["unknown"][day] == {
        "input": 0, "cache_read": 0, "cache_creation": 0, "output": 0, "calls": 0, "turns": 1,
    }
    slice_start = int(now // SLICE_S) * SLICE_S
    totals = store.account_window_totals("claude", "acct-a", slice_start, slice_start + SLICE_S)
    assert {k: totals[k] for k in ("input", "cache_read", "cache_creation", "output", "calls", "turns", "total")} == {
        "input": 10, "cache_read": 0, "cache_creation": 0, "output": 1,
        "calls": 1, "turns": 2, "total": 11,
    }


def test_window_totals_select_slices_by_start_and_end(store: TokensStore, workspace: str) -> None:
    base = int(time.time() // SLICE_S) * SLICE_S - 10 * SLICE_S
    for n in range(4):
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(base + n * SLICE_S + 1))
        store.record(
            workspace, source="cli", vendor="claude", input_tokens=100, output_tokens=1,
            dedup_key=f"s{n}", profile_id="acct-a", timestamp=stamp,
        )
    # [base + 1 slice, base + 3 slices) → slices 1 and 2.
    totals = store.account_window_totals(
        "claude", "acct-a", base + SLICE_S, base + 3 * SLICE_S,
    )
    assert totals["calls"] == 2 and totals["input"] == 200
    # start None = everything retained before `end`.
    assert store.account_window_totals("claude", "acct-a", None, base + 4 * SLICE_S)["calls"] == 4
    # Another account / vendor sees nothing.
    assert store.account_window_totals("claude", "acct-b", None, base + 9 * SLICE_S)["calls"] == 0
    assert store.account_window_totals("codex", "acct-a", None, base + 9 * SLICE_S)["calls"] == 0


def test_slices_persist_across_restart_and_clear_on_global_reset(tmp_path: Path, workspace: str) -> None:
    now = time.time()
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
    first = TokensStore(global_path=tmp_path / "g.json", workspace_base_dir=tmp_path / "w")
    first.record(
        workspace, source="cli", vendor="claude", input_tokens=7, output_tokens=3,
        dedup_key="k1", profile_id="acct-a", timestamp=stamp,
    )
    first.flush()
    with sqlite3.connect(tmp_path / "navide.db") as con:
        rows = con.execute(
            "SELECT agent, profile_id, input, output, calls FROM token_slices"
        ).fetchall()
    assert rows == [("claude", "acct-a", 7, 3, 1)]

    second = TokensStore(global_path=tmp_path / "g.json", workspace_base_dir=tmp_path / "w")
    assert second.account_window_totals("claude", "acct-a", None, now + SLICE_S)["calls"] == 1
    second.reset("global")
    assert second.account_window_totals("claude", "acct-a", None, now + SLICE_S)["calls"] == 0
    assert second.snapshot(None)["global"]["by_account_day"] == {}
    with sqlite3.connect(tmp_path / "navide.db") as con:
        assert con.execute("SELECT COUNT(*) FROM token_slices").fetchone()[0] == 0


def test_cache_split_is_clamped_into_the_folded_input(store: TokensStore, workspace: str) -> None:
    """A reader that over-reports the cache parts cannot make the un-cached
    input negative: the split is clamped to what input_tokens holds."""
    store.record(
        workspace, source="cli", vendor="claude", input_tokens=100, output_tokens=1,
        dedup_key="k1", profile_id="acct-a", cache_read_tokens=80, cache_creation_tokens=50,
        timestamp="2026-09-16T00:00:00Z",
    )
    bucket = store.snapshot(None)["global"]["by_account_day"]["claude"]["acct-a"]["2026-09-16"]
    assert bucket["input"] + bucket["cache_read"] + bucket["cache_creation"] == 100
    assert bucket["cache_read"] == 80 and bucket["cache_creation"] == 20


def test_old_documents_gain_the_new_buckets(tmp_path: Path, workspace: str) -> None:
    """A workspace / global doc persisted before the account dimension
    existed loads with empty by_account / by_version rather than KeyError."""
    db = Database(tmp_path / "navide.db")
    db.kv_set("tokens.global", {
        "schemaVersion": 3, "all_time": {"input": 1, "output": 1, "calls": 1},
        "by_vendor": {"claude": {"input": 1, "output": 1, "calls": 1}}, "by_day": {},
    }, now=1)
    db.close()
    store = TokensStore(global_path=tmp_path / "g.json", workspace_base_dir=tmp_path / "w")
    g = store.snapshot(None)["global"]
    assert g["by_account"] == {} and g["by_version"] == {} and g["by_account_day"] == {}
    store.record(workspace, source="cli", vendor="claude", input_tokens=1, output_tokens=1, dedup_key="k")
    cum = store.snapshot(workspace)["workspace"]["cumulative"]
    assert cum["by_account"] == {"unknown": {"input": 1, "output": 1, "calls": 1}}
    assert cum["by_version"] == {"claude@unknown": {"input": 1, "output": 1, "calls": 1}}


def test_token_slices_conserve_by_vendor(store: TokensStore, workspace: str) -> None:
    """The slices are the only source of a quota cycle's token side: summed
    over every slice they must equal by_vendor exactly (input folded back
    from the four-way split), for each vendor."""
    now = time.time()
    events = [
        ("claude", "acct-a", 1000, 800, 100, 50, now - 3600),
        ("claude", "acct-a", 2000, 1500, 0, 70, now - 1800),
        ("claude", "acct-b", 300, 0, 0, 20, now - 900),
        ("claude", "", 40, 0, 0, 5, now - 60),
        ("codex", "acct-a", 500, 0, 0, 60, now - 120),
    ]
    for n, (vendor, profile, inp, cr, cc, out, ts) in enumerate(events):
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))
        assert store.record(
            workspace, source="cli", vendor=vendor, input_tokens=inp, output_tokens=out,
            dedup_key=f"s{n}", profile_id=profile, cache_read_tokens=cr,
            cache_creation_tokens=cc, timestamp=stamp,
        )
    by_vendor = store.snapshot(workspace)["workspace"]["cumulative"]["by_vendor"]
    for vendor in ("claude", "codex"):
        folded = {"input": 0, "output": 0, "calls": 0}
        for profile in ("acct-a", "acct-b", "unknown"):
            bucket = store.account_window_totals(vendor, profile, None, now + 1)
            folded["input"] += bucket["input"] + bucket["cache_read"] + bucket["cache_creation"]
            folded["output"] += bucket["output"]
            folded["calls"] += bucket["calls"]
        assert folded == by_vendor[vendor], vendor


def test_slice_retention_covers_a_calendar_window() -> None:
    """A monthly credit window (copilot / grok / qwen) starts where the
    previous reset landed — up to 31 days back. Its open cycle sums live
    from the slices, so anything shorter silently undercounts the month."""
    assert SLICE_RETENTION_S >= 32 * 86400
