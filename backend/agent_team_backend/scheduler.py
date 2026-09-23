"""Navide's in-process scheduler: wakes a CLI pane with an instruction on time.

The scheduler only decides *when*. What happens at that moment is exactly one
existing path — the one ``cli_send(open_target=True)`` takes: resolve the pane,
open it first if it is a restore placeholder, hand the text to the owning
window and wait a bounded time for that window's delivery verdict. Nothing here
writes to a PTY, so the idle gate, echo verification, typing hold and per-pair
rate limit all apply to a scheduled message just as they do to an agent's.

It runs only while the backend runs. Slots missed while Navide was closed are
caught up at most once per job (``catch_up: "once"``) or dropped (``"skip"``).

Loop structure follows usage_service: a ``_wake`` event plus
``wait_for(timeout=_next_sleep)``; the sleep is the distance to the nearest due
job, capped at 60s and floored at 2s. The clock and the sleep are injectable
(cli_risk style), so tests drive time instead of waiting for it.

Invariant (OpenClaw #13992 / #16156 / #17852): ``next_run_at`` moves forward
only when its slot actually ran or was judged skipped. Reads and re-saves never
advance an overdue value — otherwise a daily job silently becomes a 48-hour one.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .scheduler_store import SchedulerStore

log = logging.getLogger(__name__)

MAX_SLEEP_S = 60.0
MIN_SLEEP_S = 2.0
#: Consecutive-failure backoff ladder; a success resets it. A periodic job is
#: never disabled automatically, however long it keeps failing.
BACKOFF_S = (30, 60, 300, 900, 3600)
#: Catch-up after a restart: this many run right away, the rest are spaced
#: CATCH_UP_SPACING_S apart — all of them strictly one after another.
CATCH_UP_BURST = 5
CATCH_UP_SPACING_S = 5.0
#: A restarted backend comes up before any window does, so catch-up waits for a
#: window (and then briefly for its panes to register) instead of skipping every
#: missed job as "no_window".
CATCH_UP_WINDOW_WAIT_S = 120.0
CATCH_UP_SETTLE_S = 10.0
#: How long one run waits for the receiving window's delivery verdict — the
#: same wait cli_send's wait_for_delivery_s performs.
DELIVERY_WAIT_S = 30.0

MIN_EVERY_MS = 60_000
MAX_EVERY_MS = 7 * 24 * 3600 * 1000
DEFAULT_POLICY: dict[str, Any] = {"catch_up": "once", "max_runs_per_day": 24, "timeout_s": 1800}
_MAX_NAME = 200
_MAX_TEXT = 64 * 1024
_AT_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

#: Skip reasons — a skip is an expected state, never an error: it does not
#: count toward consecutive_errors and does not trigger backoff.
SKIP_NO_WINDOW = "no_window"
SKIP_BUSY = "busy"
SKIP_BUDGET = "budget"
SKIP_TARGET_GONE = "target_gone"
SKIP_MISSED = "missed"
SKIP_INTERRUPTED = "interrupted"


class JobInvalid(ValueError):
    """A job definition that cannot be saved; the message is caller-facing."""


# ── schedule arithmetic ─────────────────────────────────────────────────────


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _local_ms(day: date, at: str, tz: ZoneInfo) -> int:
    """Epoch ms of wall-clock ``at`` on ``day`` in ``tz``.

    Built from the calendar date rather than by adding 24h, so a DST switch
    moves the UTC instant and keeps the wall-clock time. A wall time that does
    not exist that day (spring-forward gap) resolves with fold=0, i.e. just
    after the gap; an ambiguous one (fall-back) takes its first occurrence.
    """
    hour, minute = (int(part) for part in at.split(":"))
    when = datetime(day.year, day.month, day.day, hour, minute, tzinfo=tz)
    return int(when.timestamp() * 1000)


def next_run_after(schedule: dict[str, Any], after_ms: int) -> int:
    """The first slot strictly later than ``after_ms`` (epoch ms)."""
    kind = schedule.get("kind")
    if kind == "every":
        every = int(schedule["every_ms"])
        anchor = int(schedule["anchor_ms"])
        if after_ms < anchor:
            return anchor
        return anchor + ((after_ms - anchor) // every + 1) * every
    tz = _zone(str(schedule.get("tz") or "UTC"))
    at = str(schedule["at"])
    today = datetime.fromtimestamp(after_ms / 1000, tz).date()
    days = set(schedule.get("days") or range(1, 8)) if kind == "weekly" else set(range(1, 8))
    for offset in range(0, 9):
        day = today + timedelta(days=offset)
        if day.isoweekday() not in days:
            continue
        candidate = _local_ms(day, at, tz)
        if candidate > after_ms:
            return candidate
    raise ValueError(f"schedule has no slot: {schedule!r}")


def _day_start_ms(schedule: dict[str, Any], now_ms: int) -> int:
    """Local midnight of ``now_ms`` in the job's zone (system zone for every)."""
    tz = schedule.get("tz")
    zone = _zone(str(tz)) if tz else datetime.now().astimezone().tzinfo or timezone.utc
    local = datetime.fromtimestamp(now_ms / 1000, zone)
    return int(local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)


# ── the one validator (WS scheduler.upsert and MCP scheduler_upsert) ────────


def _require_str(obj: dict, key: str, what: str, *, limit: int = 4096) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        raise JobInvalid(f"{what} is required")
    if len(value) > limit:
        raise JobInvalid(f"{what} is too long")
    return value.strip()


def _int(value: Any, what: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise JobInvalid(f"{what} must be an integer")
    if not low <= int(value) <= high:
        raise JobInvalid(f"{what} must be between {low} and {high}")
    return int(value)


def _valid_tz(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise JobInvalid("schedule.tz is required (an IANA zone such as \"Asia/Taipei\")")
    try:
        ZoneInfo(value.strip())
    except (ZoneInfoNotFoundError, ValueError):
        raise JobInvalid(f'unknown time zone "{value}"') from None
    return value.strip()


def _valid_at(value: Any) -> str:
    if not isinstance(value, str) or not _AT_RE.match(value.strip()):
        raise JobInvalid('schedule.at must be "HH:MM" (24-hour)')
    return value.strip()


def _normalize_schedule(raw: Any, now_ms: int, previous: dict | None) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobInvalid("schedule must be an object")
    kind = raw.get("kind")
    if kind == "every":
        every = _int(raw.get("every_ms"), "schedule.every_ms", MIN_EVERY_MS, MAX_EVERY_MS)
        anchor = raw.get("anchor_ms")
        if anchor is None:
            # Keep the phase an unchanged interval already had.
            same = previous and previous.get("kind") == "every" and previous.get("every_ms") == every
            anchor = previous["anchor_ms"] if same else now_ms
        anchor = _int(anchor, "schedule.anchor_ms", 0, 2**53)
        return {"kind": "every", "every_ms": every, "anchor_ms": anchor}
    if kind == "daily":
        return {"kind": "daily", "at": _valid_at(raw.get("at")), "tz": _valid_tz(raw.get("tz"))}
    if kind == "weekly":
        days = raw.get("days")
        if not isinstance(days, list) or not days:
            raise JobInvalid("schedule.days must be a non-empty list of 1 (Mon) .. 7 (Sun)")
        clean = sorted({_int(d, "schedule.days[]", 1, 7) for d in days})
        return {
            "kind": "weekly", "days": clean,
            "at": _valid_at(raw.get("at")), "tz": _valid_tz(raw.get("tz")),
        }
    raise JobInvalid('schedule.kind must be "every", "daily" or "weekly"')


def _normalize_action(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobInvalid("action must be an object")
    if raw.get("kind") != "message":
        raise JobInvalid('action.kind must be "message"')
    action: dict[str, Any] = {
        "kind": "message",
        "workspace": _require_str(raw, "workspace", "action.workspace"),
    }
    for key in ("pane_id", "pane_name"):
        value = raw.get(key)
        if value is None or value == "":
            continue
        if not isinstance(value, str) or not value.strip() or "/" in value or len(value) > 256:
            raise JobInvalid(f"action.{key} must be a pane id / name without '/'")
        action[key] = value.strip()
    if "pane_id" not in action and "pane_name" not in action:
        raise JobInvalid("action needs pane_id or pane_name")
    action["text"] = _require_str(raw, "text", "action.text", limit=_MAX_TEXT)
    return action


def _normalize_policy(raw: Any) -> dict[str, Any]:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise JobInvalid("policy must be an object")
    policy = dict(DEFAULT_POLICY)
    if raw.get("catch_up") is not None:
        if raw["catch_up"] not in ("once", "skip"):
            raise JobInvalid('policy.catch_up must be "once" or "skip"')
        policy["catch_up"] = raw["catch_up"]
    if raw.get("max_runs_per_day") is not None:
        policy["max_runs_per_day"] = _int(raw["max_runs_per_day"], "policy.max_runs_per_day", 1, 1440)
    if raw.get("timeout_s") is not None:
        policy["timeout_s"] = _int(raw["timeout_s"], "policy.timeout_s", 60, 86400)
    return policy


def _initial_state() -> dict[str, Any]:
    return {
        "next_run_at": None,
        "running_at": None,
        "last_run_at": None,
        "last_status": None,
        "last_skip_reason": None,
        "last_error": None,
        "last_duration_ms": None,
        "consecutive_errors": 0,
        "backoff_until": None,
        "last_msg_key": None,
    }


def normalize_job(raw: Any, existing: dict[str, Any] | None, now_ms: int) -> dict[str, Any]:
    """Validate a job from a client and merge it onto the stored one.

    The single validator shared by the WS handler and the MCP tool. ``state``
    is server-owned: anything the client sends there is ignored. ``next_run_at``
    is recomputed only when the schedule changes or the job is (re-)enabled —
    never merely because the job was saved again (see the module invariant).
    """
    if not isinstance(raw, dict):
        raise JobInvalid("job must be an object")
    name = _require_str(raw, "name", "name", limit=_MAX_NAME)
    enabled = raw.get("enabled", existing["enabled"] if existing else True)
    if not isinstance(enabled, bool):
        raise JobInvalid("enabled must be true or false")
    schedule = _normalize_schedule(
        raw.get("schedule"), now_ms, existing["schedule"] if existing else None
    )
    action = _normalize_action(raw.get("action"))
    policy = _normalize_policy(raw.get("policy"))
    state = dict(existing["state"]) if existing else _initial_state()
    rearm = (
        existing is None
        or schedule != existing["schedule"]
        or (enabled and not existing["enabled"])
        or state.get("next_run_at") is None
    )
    if rearm:
        state["next_run_at"] = next_run_after(schedule, now_ms)
    return {
        "id": existing["id"] if existing else str(uuid.uuid4()),
        "name": name,
        "enabled": enabled,
        "created_at": existing["created_at"] if existing else now_ms,
        "updated_at": now_ms,
        "schedule": schedule,
        "action": action,
        "policy": policy,
        "state": state,
    }


# ── bridge to the existing delivery path ────────────────────────────────────


class LiveBridge:
    """What the service needs from the rest of the backend, in one seam.

    Tests swap this for a fake; production reaches cli_send's own send path in
    the MCP server module (imported late — it imports this package's app).
    """

    def has_window(self) -> bool:
        from . import app

        return any(not getattr(s, "dead", False) for s in list(app._SESSIONS))

    def still_queued(self, msg_key: str | None) -> bool:
        """True while this job's previous message still waits in the target's queue."""
        if not msg_key:
            return False
        from .mcp_server import server as mcp

        entry = mcp._mcp_message_status.get(msg_key)
        return entry is not None and entry.get("status") == "queued"

    async def budget_limited(self, action: dict[str, Any]) -> bool:
        """True when the target pane's CLI is marked out of quota in the usage cache.

        Cache only — never asks a vendor for a fresh reading.
        """
        from . import agent_messaging
        from .usage_service import service

        entry = None
        if action.get("pane_id"):
            entry = agent_messaging.current(action["pane_id"])
        elif action.get("pane_name"):
            entry = agent_messaging.resolve("", _qualified(action)).pane
        if entry is None or not entry.agent_key:
            return False
        try:
            payload = await asyncio.to_thread(service.payload)
        except Exception:  # noqa: BLE001 — no reading is not "limited"
            return False
        snap = (payload.get("providers") or {}).get(entry.agent_key)
        if not isinstance(snap, dict):
            return False
        if snap.get("status") == "rate-limited":
            return True
        for window in snap.get("windows") or []:
            used = window.get("usedPercent") if isinstance(window, dict) else None
            if isinstance(used, (int, float)) and used >= 100:
                return True
        return False

    async def deliver(self, action: dict[str, Any]) -> dict[str, Any]:
        """Send through cli_send's path with open_target=True; map its answer."""
        from .mcp_server import server as mcp

        answer = await mcp._send(
            mcp._Caller(kind="host"),
            "" if action.get("pane_id") else _qualified(action),
            action["text"],
            wait_for_delivery_s=DELIVERY_WAIT_S,
            pane_id=action.get("pane_id") or "",
            open_target=True,
        )
        return outcome_of_send(answer)


def _qualified(action: dict[str, Any]) -> str:
    """``<workspace path>/<pane name>`` — the qualified form cli_send resolves."""
    return f"{str(action['workspace']).rstrip('/')}/{action['pane_name']}"


def outcome_of_send(answer: dict[str, Any]) -> dict[str, Any]:
    """Map a cli_send answer to a run outcome {status, reason?, detail?, msg_key?}."""
    if not answer.get("ok"):
        code = str(answer.get("error_code") or "")
        detail = str(answer.get("error") or "send refused")
        if code == "target-offline":
            return {"status": "skipped", "reason": SKIP_NO_WINDOW, "detail": detail}
        if code == "unknown-pane-id":
            # Never fall back to another pane of the same name.
            return {"status": "skipped", "reason": SKIP_TARGET_GONE, "detail": detail}
        return {"status": "error", "reason": code or None, "detail": detail}
    msg_key = answer.get("msg_key")
    status = answer.get("status")
    if status in ("failed", "rejected"):
        return {
            "status": "error", "reason": status,
            "detail": str(answer.get("reason") or status), "msg_key": msg_key,
        }
    if status == "queued":
        hold = (answer.get("hold") or {}).get("key") or "pending"
        return {"status": "ok", "detail": f"queued ({hold})", "msg_key": msg_key}
    return {"status": "ok", "detail": str(status or "sent"), "msg_key": msg_key}


# ── the service ─────────────────────────────────────────────────────────────


Notify = Callable[[list[dict[str, Any]]], Awaitable[None]]


async def _broadcast_jobs(jobs: list[dict[str, Any]], exclude: Any = None) -> None:
    from . import app
    from .ipc import make_event

    await app.broadcast(make_event("scheduler.changed", {"jobs": jobs}), exclude=exclude)


class SchedulerService:
    def __init__(
        self,
        store: SchedulerStore,
        *,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
        bridge: Any = None,
        notify: Notify | None = None,
    ) -> None:
        self.store = store
        self.clock = clock
        self._sleep = sleep
        self.bridge = bridge or LiveBridge()
        self._notify = notify or _broadcast_jobs
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._catch_up_task: asyncio.Task | None = None
        self._catch_up_pending: set[str] = set()
        self._runs: dict[str, tuple[asyncio.Task, bool]] = {}
        self._ticking = False

    def now_ms(self) -> int:
        return int(self.clock() * 1000)

    def wake(self) -> None:
        self._wake.set()

    # ── lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Clear leftovers of the previous run, plan catch-up, start the loop."""
        now = self.now_ms()
        overdue: list[dict[str, Any]] = []
        async with self._lock:
            for job in await self.store.list_jobs():
                state = job["state"]
                if state.get("running_at") is not None:
                    # Interrupted by the restart: cleared, and not caught up
                    # this round.
                    state["running_at"] = None
                    await self._record_skip(job, now, SKIP_INTERRUPTED, "backend restarted mid-run")
                    continue
                if state.get("next_run_at") is None:
                    state["next_run_at"] = next_run_after(job["schedule"], now)
                    await self.store.set_state(job["id"], state)
                    continue
                if job["enabled"] and state["next_run_at"] <= now:
                    if job["policy"].get("catch_up") == "skip":
                        await self._record_skip(job, now, SKIP_MISSED, "missed while Navide was closed")
                    else:
                        overdue.append(job)
        overdue.sort(key=lambda j: j["state"]["next_run_at"])
        if overdue:
            self._catch_up_pending = {job["id"] for job in overdue}
            self._catch_up_task = asyncio.create_task(self._catch_up([j["id"] for j in overdue]))
        self._task = asyncio.create_task(self._run())

    async def close(self) -> None:
        tasks = [t for t in (self._task, self._catch_up_task) if t is not None]
        tasks += [task for task, _manual in self._runs.values()]
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._task = self._catch_up_task = None
        self._runs.clear()

    async def _run(self) -> None:
        while True:
            self._wake.clear()
            try:
                delay = await self.tick()
            except Exception as err:  # noqa: BLE001 — the loop must survive anything
                log.warning("scheduler tick failed: %s", err)
                delay = MAX_SLEEP_S
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

    async def _catch_up(self, job_ids: list[str]) -> None:
        """Run missed jobs once each, strictly in sequence, burst then spaced."""
        waited = 0.0
        while not self.bridge.has_window() and waited < CATCH_UP_WINDOW_WAIT_S:
            await self._sleep(MIN_SLEEP_S)
            waited += MIN_SLEEP_S
        if waited:
            await self._sleep(CATCH_UP_SETTLE_S)
        try:
            for index, job_id in enumerate(job_ids):
                if index >= CATCH_UP_BURST:
                    await self._sleep(CATCH_UP_SPACING_S)
                self._catch_up_pending.discard(job_id)
                job = await self.store.get_job(job_id)
                if job is None or not job["enabled"] or job["state"].get("running_at") is not None:
                    continue
                task = await self._fire(job, self.now_ms())
                if task is not None:
                    await asyncio.shield(task)
        finally:
            self._catch_up_pending.clear()
            self.wake()

    # ── engine ───────────────────────────────────────────────────────────

    async def tick(self) -> float:
        """Fire every due job; return how long to sleep before the next tick."""
        if self._ticking:
            return MAX_SLEEP_S
        self._ticking = True
        try:
            now = self.now_ms()
            nearest: int | None = None

            def consider(at: int) -> None:
                nonlocal nearest
                nearest = at if nearest is None else min(nearest, at)

            for job in await self.store.list_jobs():
                state = job["state"]
                running_at = state.get("running_at")
                if running_at is not None:
                    deadline = running_at + int(job["policy"].get("timeout_s", 1800)) * 1000
                    if now >= deadline:
                        await self._fail_stuck(job["id"], now)
                    else:
                        consider(deadline)
                    continue
                if not job["enabled"] or job["id"] in self._catch_up_pending:
                    continue
                backoff = state.get("backoff_until")
                if backoff is not None and now < backoff:
                    consider(backoff)
                    continue
                due = state.get("next_run_at")
                if due is None:
                    continue
                if now < due:
                    consider(due)
                    continue
                await self._fire(job, now)
            if nearest is None:
                return MAX_SLEEP_S
            return max(MIN_SLEEP_S, min(MAX_SLEEP_S, (nearest - now) / 1000))
        finally:
            self._ticking = False

    async def _gate(self, job: dict[str, Any], now: int) -> str | None:
        if not self.bridge.has_window():
            return SKIP_NO_WINDOW
        if self.bridge.still_queued(job["state"].get("last_msg_key")):
            return SKIP_BUSY
        cap = int(job["policy"].get("max_runs_per_day", DEFAULT_POLICY["max_runs_per_day"]))
        used = await self.store.count_dispatched_since(job["id"], _day_start_ms(job["schedule"], now))
        if used >= cap or await self.bridge.budget_limited(job["action"]):
            return SKIP_BUDGET
        return None

    async def _fire(self, job: dict[str, Any], now: int) -> asyncio.Task | None:
        reason = await self._gate(job, now)
        if reason is not None:
            async with self._lock:
                fresh = await self.store.get_job(job["id"])
                if fresh is not None and fresh["state"].get("running_at") is None:
                    await self._record_skip(fresh, now, reason, None)
            await self._changed()
            return None
        return await self._start(job["id"], manual=False)

    async def _start(self, job_id: str, *, manual: bool) -> asyncio.Task | None:
        async with self._lock:
            job = await self.store.get_job(job_id)
            if job is None or job["state"].get("running_at") is not None:
                return None
            started = self.now_ms()
            job["state"]["running_at"] = started
            # Written before anything is dispatched: this is the reentry lock.
            await self.store.set_state(job_id, job["state"])
            task = asyncio.create_task(self._execute(job, started, manual))
            self._runs[job_id] = (task, manual)
        await self._changed()
        return task

    async def _execute(self, job: dict[str, Any], started: int, manual: bool) -> None:
        try:
            outcome = await self.bridge.deliver(job["action"])
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001 — a failed run is an error row
            outcome = {"status": "error", "detail": str(err) or type(err).__name__}
        await self._finish(job["id"], started, outcome, manual)

    async def _finish(
        self, job_id: str, started: int, outcome: dict[str, Any], manual: bool
    ) -> None:
        try:
            await self._settle(job_id, started, outcome, manual)
        finally:
            entry = self._runs.get(job_id)
            if entry is not None and entry[0] is asyncio.current_task():
                self._runs.pop(job_id, None)
        await self._changed()

    async def _settle(
        self, job_id: str, started: int, outcome: dict[str, Any], manual: bool
    ) -> None:
        async with self._lock:
            job = await self.store.get_job(job_id)
            if job is None or job["state"].get("running_at") != started:
                return  # removed, or already settled by the stuck sweep
            now = self.now_ms()
            state = job["state"]
            status = outcome["status"]
            state["running_at"] = None
            state["last_run_at"] = started
            state["last_duration_ms"] = max(0, now - started)
            state["last_status"] = status
            state["last_skip_reason"] = outcome.get("reason") if status == "skipped" else None
            if outcome.get("msg_key"):
                state["last_msg_key"] = outcome["msg_key"]
            if status == "ok":
                state["consecutive_errors"] = 0
                state["backoff_until"] = None
                state["last_error"] = None
            elif status == "error":
                errors = int(state.get("consecutive_errors") or 0) + 1
                state["consecutive_errors"] = errors
                state["backoff_until"] = now + BACKOFF_S[min(errors, len(BACKOFF_S)) - 1] * 1000
                state["last_error"] = outcome.get("detail") or outcome.get("reason") or "error"
            if not manual:
                state["next_run_at"] = next_run_after(job["schedule"], now)
            await self.store.set_state(job_id, state)
            await self.store.append_run(job_id, {
                "started_at": started, "ended_at": now, "status": status,
                "reason": outcome.get("reason"), "detail": outcome.get("detail"),
            })

    async def _fail_stuck(self, job_id: str, now: int) -> None:
        entry = self._runs.pop(job_id, None)
        manual = entry[1] if entry else False
        if entry is not None:
            entry[0].cancel()
        job = await self.store.get_job(job_id)
        if job is None or job["state"].get("running_at") is None:
            return
        await self._finish(
            job_id, job["state"]["running_at"],
            {"status": "error", "reason": "timeout", "detail": "run exceeded policy.timeout_s"},
            manual,
        )

    async def _record_skip(
        self, job: dict[str, Any], now: int, reason: str, detail: str | None
    ) -> None:
        """Skipped slot: advance next_run_at, leave the error count alone."""
        state = job["state"]
        state["last_status"] = "skipped"
        state["last_skip_reason"] = reason
        state["next_run_at"] = next_run_after(job["schedule"], now)
        await self.store.set_state(job["id"], state)
        await self.store.append_run(job["id"], {
            "started_at": now, "ended_at": now, "status": "skipped",
            "reason": reason, "detail": detail,
        })

    async def _changed(self) -> None:
        try:
            await self._notify(await self.store.list_jobs())
        except Exception as err:  # noqa: BLE001 — a notify failure must not stop a run
            log.warning("scheduler.changed broadcast failed: %s", err)

    # ── API shared by the WS handlers and the MCP tools ──────────────────

    async def list(self) -> dict[str, Any]:
        return {"ok": True, "jobs": await self.store.list_jobs(), "now": self.now_ms()}

    async def upsert(self, raw: Any) -> dict[str, Any]:
        """Create or update a job. Raises :class:`JobInvalid` for a bad definition."""
        job_id = raw.get("id") if isinstance(raw, dict) else None
        async with self._lock:
            existing = None
            if job_id:
                if not isinstance(job_id, str):
                    raise JobInvalid("id must be a string")
                existing = await self.store.get_job(job_id)
                if existing is None:
                    raise JobInvalid(f'unknown job id "{job_id}"')
            job = normalize_job(raw, existing, self.now_ms())
            await self.store.put_job(job)
        self.wake()
        return {"ok": True, "job": job}

    async def remove(self, job_id: str) -> dict[str, Any]:
        async with self._lock:
            removed = await self.store.delete_job(job_id)
            entry = self._runs.pop(job_id, None)
        if entry is not None:
            entry[0].cancel()
        if not removed:
            return {"ok": False, "error": f'unknown job id "{job_id}"'}
        self.wake()
        return {"ok": True}

    async def set_enabled(self, job_id: str, enabled: bool) -> dict[str, Any]:
        async with self._lock:
            job = await self.store.get_job(job_id)
            if job is None:
                return {"ok": False, "error": f'unknown job id "{job_id}"'}
            state = job["state"]
            if enabled and not job["enabled"]:
                # Re-enabling never fires a slot that passed while disabled.
                state["next_run_at"] = next_run_after(job["schedule"], self.now_ms())
            await self.store.set_enabled(job_id, enabled, state, self.now_ms())
        self.wake()
        return {"ok": True}

    async def run_now(self, job_id: str) -> dict[str, Any]:
        """Start one run immediately, outside the schedule; answers before it ends.

        Bypasses the skip gates (the user asked for it) but not the reentry
        lock. Clears any backoff window, which is what "repair" needs; the
        error count resets only if this run succeeds.
        """
        async with self._lock:
            job = await self.store.get_job(job_id)
            if job is None:
                return {"ok": False, "error": f'unknown job id "{job_id}"'}
            if job["state"].get("running_at") is not None:
                return {"ok": False, "error": "that job is already running"}
            if job["state"].get("backoff_until") is not None:
                job["state"]["backoff_until"] = None
                await self.store.set_state(job_id, job["state"])
        task = await self._start(job_id, manual=True)
        if task is None:
            return {"ok": False, "error": "that job is already running"}
        return {"ok": True, "enqueued": True}

    async def runs(self, job_id: str, limit: int = 20) -> dict[str, Any]:
        if await self.store.get_job(job_id) is None:
            return {"ok": False, "error": f'unknown job id "{job_id}"'}
        return {"ok": True, "runs": await self.store.list_runs(job_id, max(1, min(int(limit), 200)))}


_service: SchedulerService | None = None


def get_service() -> SchedulerService:
    """The process-wide scheduler, built on the global database on first use."""
    global _service
    if _service is None:
        from . import app

        _service = SchedulerService(SchedulerStore(app.database))
    return _service


async def broadcast_changed(exclude: Any = None) -> None:
    """Push the whole job list to every window (optionally minus the requester)."""
    await _broadcast_jobs(await get_service().store.list_jobs(), exclude=exclude)


async def shutdown() -> None:
    """Stop the loop and any in-flight run (app shutdown).

    The instance is dropped too: its asyncio primitives belong to this loop.
    """
    global _service
    if _service is not None:
        service, _service = _service, None
        await service.close()
