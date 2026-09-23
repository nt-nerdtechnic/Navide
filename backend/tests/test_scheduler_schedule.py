"""Schedule arithmetic and the one job validator of the in-process scheduler."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from agent_team_backend.scheduler import JobInvalid, next_run_after, normalize_job

TPE = ZoneInfo("Asia/Taipei")
NY = ZoneInfo("America/New_York")


def ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def local(ms_value: int, tz: ZoneInfo) -> datetime:
    return datetime.fromtimestamp(ms_value / 1000, tz)


def _job(**over) -> dict:
    job = {
        "name": "weekly report",
        "schedule": {"kind": "daily", "at": "09:00", "tz": "Asia/Taipei"},
        "action": {"kind": "message", "workspace": "/ws", "pane_name": "report", "text": "go"},
    }
    job.update(over)
    return job


def test_every_is_anchored_and_strictly_after() -> None:
    sched = {"kind": "every", "every_ms": 120_000, "anchor_ms": 1_000_000}
    assert next_run_after(sched, 0) == 1_000_000
    assert next_run_after(sched, 1_000_000) == 1_120_000
    assert next_run_after(sched, 1_119_999) == 1_120_000
    # No drift: a late evaluation lands on the anchor grid, not "now + every".
    assert next_run_after(sched, 1_500_000) == 1_600_000


def test_daily_today_or_tomorrow() -> None:
    sched = {"kind": "daily", "at": "09:00", "tz": "Asia/Taipei"}
    before = ms(datetime(2026, 9, 23, 8, 0, tzinfo=TPE))
    after = ms(datetime(2026, 9, 23, 9, 0, tzinfo=TPE))
    assert local(next_run_after(sched, before), TPE) == datetime(2026, 9, 23, 9, 0, tzinfo=TPE)
    assert local(next_run_after(sched, after), TPE) == datetime(2026, 9, 24, 9, 0, tzinfo=TPE)


def test_weekly_picks_next_listed_day() -> None:
    # 2026-09-23 is a Wednesday (isoweekday 3).
    sched = {"kind": "weekly", "days": [1, 5], "at": "02:00", "tz": "Asia/Taipei"}
    wed = ms(datetime(2026, 9, 23, 12, 0, tzinfo=TPE))
    friday = local(next_run_after(sched, wed), TPE)
    assert friday == datetime(2026, 9, 25, 2, 0, tzinfo=TPE)
    monday = local(next_run_after(sched, ms(friday)), TPE)
    assert monday == datetime(2026, 9, 28, 2, 0, tzinfo=TPE)


def test_daily_keeps_wall_clock_across_dst_spring_forward() -> None:
    # America/New_York springs forward on 2026-03-08: 09:00 stays 09:00 local,
    # so the UTC gap between the two slots is 23 hours, not 24.
    sched = {"kind": "daily", "at": "09:00", "tz": "America/New_York"}
    first = next_run_after(sched, ms(datetime(2026, 3, 7, 8, 0, tzinfo=NY)))
    second = next_run_after(sched, first)
    assert local(first, NY).hour == 9 and local(second, NY).hour == 9
    assert second - first == 23 * 3600 * 1000


def test_daily_keeps_wall_clock_across_dst_fall_back() -> None:
    sched = {"kind": "daily", "at": "09:00", "tz": "America/New_York"}
    first = next_run_after(sched, ms(datetime(2026, 10, 31, 8, 0, tzinfo=NY)))
    second = next_run_after(sched, first)
    assert local(second, NY) == datetime(2026, 11, 1, 9, 0, tzinfo=NY)
    assert second - first == 25 * 3600 * 1000


def test_daily_in_the_spring_forward_gap_still_fires_that_day() -> None:
    sched = {"kind": "daily", "at": "02:30", "tz": "America/New_York"}
    slot = next_run_after(sched, ms(datetime(2026, 3, 8, 0, 0, tzinfo=NY)))
    assert local(slot, NY).date().isoformat() == "2026-03-08"


def test_resave_does_not_advance_an_overdue_next_run() -> None:
    now = ms(datetime(2026, 9, 23, 8, 0, tzinfo=TPE))
    job = normalize_job(_job(), None, now)
    due = job["state"]["next_run_at"]
    # Later than the slot, the job is saved again unchanged (and listed).
    later = due + 3_600_000
    resaved = normalize_job({**_job(), "id": job["id"]}, job, later)
    assert resaved["state"]["next_run_at"] == due


def test_changed_schedule_rearms_from_now() -> None:
    now = ms(datetime(2026, 9, 23, 8, 0, tzinfo=TPE))
    job = normalize_job(_job(), None, now)
    later = now + 7_200_000
    changed = normalize_job(
        _job(schedule={"kind": "daily", "at": "18:00", "tz": "Asia/Taipei"}), job, later
    )
    assert local(changed["state"]["next_run_at"], TPE) == datetime(2026, 9, 23, 18, 0, tzinfo=TPE)


def test_new_job_defaults() -> None:
    job = normalize_job(_job(), None, 1_000)
    assert job["enabled"] is True
    assert job["policy"] == {"catch_up": "once", "max_runs_per_day": 24, "timeout_s": 1800}
    assert job["state"]["consecutive_errors"] == 0 and job["state"]["running_at"] is None
    assert len(job["id"]) == 36


def test_client_state_is_ignored() -> None:
    job = normalize_job(_job(state={"running_at": 5, "consecutive_errors": 9}), None, 1_000)
    assert job["state"]["running_at"] is None and job["state"]["consecutive_errors"] == 0


@pytest.mark.parametrize(
    "over, needle",
    [
        ({"name": ""}, "name"),
        ({"schedule": {"kind": "cron", "expr": "* * * * *"}}, "schedule.kind"),
        ({"schedule": {"kind": "every", "every_ms": 1000}}, "every_ms"),
        ({"schedule": {"kind": "daily", "at": "25:00", "tz": "UTC"}}, "HH:MM"),
        ({"schedule": {"kind": "daily", "at": "09:00", "tz": "Mars/Base"}}, "time zone"),
        ({"schedule": {"kind": "weekly", "days": [0], "at": "09:00", "tz": "UTC"}}, "days"),
        ({"action": {"kind": "spawn", "workspace": "/ws", "agent": "claude", "prompt": "x"}}, "message"),
        ({"action": {"kind": "message", "workspace": "/ws", "text": "x"}}, "pane_id or pane_name"),
        ({"action": {"kind": "message", "workspace": "/ws", "pane_name": "a", "text": " "}}, "text"),
        ({"action": {"kind": "message", "pane_name": "a", "text": "x"}}, "workspace"),
        ({"policy": {"catch_up": "all"}}, "catch_up"),
        ({"policy": {"max_runs_per_day": 0}}, "max_runs_per_day"),
    ],
)
def test_validation_rejects(over: dict, needle: str) -> None:
    with pytest.raises(JobInvalid, match=needle):
        normalize_job(_job(**over), None, 1_000)


def test_pane_id_alone_is_enough() -> None:
    job = normalize_job(
        _job(action={"kind": "message", "workspace": "/ws", "pane_id": "p-1", "text": "x"}), None, 1
    )
    assert job["action"] == {"kind": "message", "workspace": "/ws", "pane_id": "p-1", "text": "x"}


def test_update_keeps_fields_it_does_not_send() -> None:
    now = ms(datetime(2026, 9, 23, 8, 0, tzinfo=TPE))
    job = normalize_job(_job(policy={"max_runs_per_day": 3, "timeout_s": 600}), None, now)
    renamed = normalize_job({"id": job["id"], "name": "renamed"}, job, now + 1_000)
    assert renamed["name"] == "renamed"
    for key in ("schedule", "action", "policy", "enabled", "created_at", "id"):
        assert renamed[key] == job[key]
    assert renamed["state"]["next_run_at"] == job["state"]["next_run_at"]
    # null counts as "not sent" on an update.
    same = normalize_job({"id": job["id"], "schedule": None, "action": None}, job, now + 2_000)
    assert same["schedule"] == job["schedule"] and same["action"] == job["action"]


def test_update_merges_policy_key_by_key() -> None:
    job = normalize_job(_job(policy={"catch_up": "skip", "max_runs_per_day": 3}), None, 1_000)
    merged = normalize_job({"id": job["id"], "policy": {"timeout_s": 120}}, job, 2_000)
    assert merged["policy"] == {"catch_up": "skip", "max_runs_per_day": 3, "timeout_s": 120}
    with pytest.raises(JobInvalid, match="catch_up"):
        normalize_job({"id": job["id"], "policy": {"catch_up": "all"}}, job, 2_000)


def test_update_validates_a_sent_action_whole() -> None:
    job = normalize_job(_job(), None, 1_000)
    # No merge onto the stored action: the partial action lacks workspace.
    with pytest.raises(JobInvalid, match="workspace"):
        normalize_job({"id": job["id"], "action": {"kind": "message", "text": "new"}}, job, 2_000)
    swapped = normalize_job(
        {"id": job["id"], "action": {"kind": "message", "workspace": "/w2", "pane_id": "p9", "text": "t"}},
        job, 2_000,
    )
    assert swapped["action"] == {"kind": "message", "workspace": "/w2", "pane_id": "p9", "text": "t"}


def test_new_job_still_requires_every_field() -> None:
    for missing in ("name", "schedule", "action"):
        raw = _job()
        del raw[missing]
        with pytest.raises(JobInvalid):
            normalize_job(raw, None, 1_000)


# ── once ───────────────────────────────────────────────────────────────────

NOW = 1_800_000_000_000
TEN_YEARS = 10 * 365 * 24 * 3600 * 1000


def test_once_next_run_is_its_moment_then_nothing() -> None:
    sched = {"kind": "once", "at_ms": NOW}
    assert next_run_after(sched, NOW - 1) == NOW
    assert next_run_after(sched, NOW) is None
    assert next_run_after(sched, NOW + 5) is None


def test_once_in_ms_is_stored_as_at_ms() -> None:
    job = normalize_job(_job(schedule={"kind": "once", "in_ms": 3_600_000}), None, NOW)
    assert job["schedule"] == {"kind": "once", "at_ms": NOW + 3_600_000}
    assert job["state"]["next_run_at"] == NOW + 3_600_000


def test_once_within_the_grace_minute_fires_right_away() -> None:
    job = normalize_job(_job(schedule={"kind": "once", "at_ms": NOW - 59_000}), None, NOW)
    assert job["state"]["next_run_at"] == NOW - 59_000
    in_zero = normalize_job(_job(schedule={"kind": "once", "in_ms": 0}), None, NOW)
    assert in_zero["state"]["next_run_at"] == NOW


@pytest.mark.parametrize(
    "schedule, needle",
    [
        ({"kind": "once", "at_ms": NOW - 61_000}, "past"),
        ({"kind": "once", "at_ms": NOW + TEN_YEARS + 1}, "10 years"),
        ({"kind": "once", "in_ms": -1}, "in_ms"),
        ({"kind": "once", "in_ms": TEN_YEARS + 1}, "in_ms"),
        ({"kind": "once"}, "at_ms or schedule.in_ms"),
        ({"kind": "once", "at_ms": "soon"}, "integer"),
    ],
)
def test_once_validation(schedule: dict, needle: str) -> None:
    with pytest.raises(JobInvalid, match=needle):
        normalize_job(_job(schedule=schedule), None, NOW)


def test_once_passed_moment_survives_a_resave_but_not_a_reenable() -> None:
    job = normalize_job(_job(schedule={"kind": "once", "at_ms": NOW + 1_000}), None, NOW)
    ran = {**job, "enabled": False, "state": {**job["state"], "next_run_at": None}}
    later = NOW + 3_600_000
    # A full re-save of the finished job (as the editor sends it) still works.
    renamed = normalize_job({**_job(schedule=job["schedule"]), "name": "x", "enabled": False, "id": job["id"]}, ran, later)
    assert renamed["name"] == "x" and renamed["enabled"] is False
    with pytest.raises(JobInvalid, match="time has passed"):
        normalize_job({"id": job["id"], "enabled": True}, ran, later)
    # A new moment re-arms it.
    rearmed = normalize_job(
        {"id": job["id"], "enabled": True, "schedule": {"kind": "once", "in_ms": 60_000}}, ran, later
    )
    assert rearmed["enabled"] is True and rearmed["state"]["next_run_at"] == later + 60_000
