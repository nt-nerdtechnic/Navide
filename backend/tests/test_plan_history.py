"""plan_history: stage parsing + stage-transition snapshots + retention cap."""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend import plan_history


def _meta_island(stage: str) -> str:
    meta = {
        "schemaVersion": 1,
        "name": "Test Plan",
        "overview": "",
        "stage": stage,
        "approvedAt": None,
        "todos": [],
        "reviewNotes": [],
    }
    return f'<script type="application/json" id="plan-meta">{json.dumps(meta)}</script>'


def _plan_html(stage: str) -> str:
    return f"<!doctype html><html><head>{_meta_island(stage)}</head><body>x</body></html>"


def _plans_dir(ws: Path) -> Path:
    d = ws / ".agent-team" / "plans"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── parse_plan_stage ─────────────────────────────────────────────────────


def test_parse_stage_valid() -> None:
    assert plan_history.parse_plan_stage(_plan_html("approved")) == "approved"


def test_parse_stage_single_quoted_id() -> None:
    html = _plan_html("draft").replace('id="plan-meta"', "id='plan-meta'")
    assert plan_history.parse_plan_stage(html) == "draft"


def test_parse_stage_missing_island() -> None:
    assert plan_history.parse_plan_stage("<html><body>doc</body></html>") is None


def test_parse_stage_malformed_json() -> None:
    html = '<script type="application/json" id="plan-meta">{nope</script>'
    assert plan_history.parse_plan_stage(html) is None


def test_parse_stage_unknown_stage_value() -> None:
    assert plan_history.parse_plan_stage(_plan_html("shipped")) is None


# ── snapshot_plans ───────────────────────────────────────────────────────


def test_first_sight_creates_baseline_snapshot(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    (plans / "my-plan_ab12cd.html").write_text(_plan_html("in-review"), encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert len(created) == 1
    assert created[0].startswith(".agent-team/plans/.history/my-plan_ab12cd/")
    assert created[0].endswith("_in-review.html")
    snap = tmp_path / created[0]
    assert snap.read_text(encoding="utf-8") == _plan_html("in-review")


def test_same_stage_creates_no_new_snapshot(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    (plans / "my-plan_ab12cd.html").write_text(_plan_html("draft"), encoding="utf-8")
    assert len(plan_history.snapshot_plans(str(tmp_path))) == 1
    # Content edit without a stage change must not snapshot again.
    (plans / "my-plan_ab12cd.html").write_text(
        _plan_html("draft").replace("body>x", "body>y"), encoding="utf-8"
    )
    assert plan_history.snapshot_plans(str(tmp_path)) == []


def test_stage_transition_creates_snapshot(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    plan = plans / "my-plan_ab12cd.html"
    plan.write_text(_plan_html("in-review"), encoding="utf-8")
    plan_history.snapshot_plans(str(tmp_path))
    plan.write_text(_plan_html("approved"), encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert len(created) == 1
    assert created[0].endswith("_approved.html")
    history = plans / ".history" / "my-plan_ab12cd"
    assert len(list(history.glob("*.html"))) == 2


def test_infra_hidden_and_metaless_files_skipped(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    (plans / "_template.html").write_text(_plan_html("draft"), encoding="utf-8")
    (plans / ".hidden.html").write_text(_plan_html("draft"), encoding="utf-8")
    (plans / "plain-doc_ab12cd.html").write_text("<html><body>no meta</body></html>", encoding="utf-8")

    assert plan_history.snapshot_plans(str(tmp_path)) == []
    assert not (plans / ".history").exists()


def test_retention_prunes_oldest_beyond_cap(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    plan = plans / "my-plan_ab12cd.html"
    plan.write_text(_plan_html("approved"), encoding="utf-8")
    history = plans / ".history" / "my-plan_ab12cd"
    history.mkdir(parents=True)
    # Seed 25 old snapshots, newest recording stage "draft" (≠ approved).
    for i in range(25):
        (history / f"20000101T0000{i:02d}_draft.html").write_text("old", encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert len(created) == 1
    remaining = sorted(p.name for p in history.glob("*.html"))
    assert len(remaining) == plan_history.MAX_SNAPSHOTS_PER_PLAN
    # The oldest seeds were pruned; the newest entry is the fresh snapshot.
    assert "20000101T000000_draft.html" not in remaining
    assert remaining[-1].endswith("_approved.html")


def test_missing_plans_dir_is_noop(tmp_path: Path) -> None:
    assert plan_history.snapshot_plans(str(tmp_path)) == []
