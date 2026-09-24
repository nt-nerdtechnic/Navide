"""ChannelManager: owns every chat-platform connection and both message pipelines.

One manager per backend process (OpenClaw's Gateway model): a bot token can
have only one consumer, so connections can never follow panes around.

Inbound:  dedup -> sender gate (allowlist by sender id; DM strangers get a
          pairing code, group strangers are dropped) -> binding lookup ->
          stop words interrupt the pane -> delivery through the same seam
          cli_send uses (``_dispatch_delivery``).
Outbound: after a message is injected into pane P, the first ``turn_complete``
          activity for P goes back to P's bound location. Replies never pick
          their own destination.

Everything that touches the rest of the backend goes through ``Seams`` so the
pipeline is testable with fakes; ``default_seams()`` wires the real ones.
"""

from __future__ import annotations

import asyncio
import dataclasses
import importlib
import json
import logging
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from . import redact, relay
from .base import ChannelAdapter, InboundMessage, Location
from .pairing import SenderGate
from .store import Binding, ChannelStore
from .text import chunk_for

log = logging.getLogger(__name__)

PLATFORMS = ("telegram", "discord", "slack", "feishu", "dingtalk", "matrix", "mattermost", "imessage")
STOP_WORDS = {"stop", "停止", "/stop", "esc"}
DEDUP_MAX = 5000
MAX_QUEUED_PER_PANE = 20
STATUS_EDIT_MIN_INTERVAL_S = 1.0
STATUS_EDIT_MAX_FAILURES = 3
STATUS_EDIT_EVERY_S = 5.0
TYPING_EVERY_S = 4.0
AWAITING_PROBE_EVERY_S = 5.0
RUN_TICK_S = 0.5
RUN_WATCH_MAX_S = 1800.0  # stop typing/editing after this; a late turn_complete still replies
VERDICT_POLL_S = 5.0
HELD_NOTICE_AFTER_S = 600.0
HOLD_FAILURE_KEYS = {"gone", "not-ready"}
HOLD_FAILURE_AFTER_S = 60.0
VERDICT_WATCH_MAX_S = 3600.0
STATUS_POLL_S = 1.0
DEBOUNCE_S = 0.5  # lines from one sender to one location within this window become one message
DEBOUNCE_MAX_S = 3.0

MSG_RECEIVED_BUSY = "已收到，等 pane 空檔…"
MSG_WORKING = "⏳ pane 處理中…"
MSG_NOT_BOUND = "此主題尚未連接 pane"
MSG_INTERRUPTED = "⏹ 已送出中斷"
MSG_QUEUE_FULL = "⚠️ 這個 pane 已有太多訊息在排隊，請稍後再傳"
MSG_EMPTY_REPLY = "（pane 回合結束，沒有文字輸出）"
MSG_STILL_RUNNING = "⏳ 仍在執行，完成時會再回覆"
MSG_OFFLINE = "⚠️ pane 目前不在線上（可能在其他 workspace 或已關閉）"
MSG_RELAY_EXPIRED = "⚠️ 這個確認已失效"
MSG_RELAY_PERMANENT = "⚠️ 這個選項會永久放行，請在電腦前操作"


def _secret_name(platform: str) -> str:
    return f"channel-{platform}"


@dataclass
class Seams:
    """Everything the manager needs from the rest of the backend."""

    # (pane_id, text, from_display) -> {ok, msg_key, pane_id, error?}
    deliver: Callable[[str, str, str], Awaitable[dict[str, Any]]]
    # (msg_key, timeout) -> {status: queued|delivered|failed|cancelled, reason, hold, age_s}
    await_verdict: Callable[[str, float], Awaitable[dict[str, Any]]]
    interrupt: Callable[[str], Awaitable[dict[str, Any]]]
    # pane_id -> {exists, busy, display_status}; cheap, no UI round trip
    pane_state: Callable[[str], dict[str, Any]]
    # pane_id -> {kind: "permission"|"question"|"", prompt: str, options: [str]}, via the UI probe
    awaiting_info: Callable[[str], Awaitable[dict[str, Any]]]
    # (pane_id, answer) -> {ok, error?}; answer is the ui.pane.sendKeys payload
    answer: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
    resolve_pane: Callable[[str], str]  # alias -> current pane id ("" if unknown)
    broadcast: Callable[[str, dict[str, Any]], Awaitable[None]]
    read_secret: Callable[[str], Awaitable[str | None]]
    write_secret: Callable[[str, str | None], Awaitable[None]]


AdapterFactory = Callable[[dict[str, Any], dict[str, Any], ChannelStore], ChannelAdapter]


def default_adapter_factory(platform: str) -> AdapterFactory | None:
    """``channels.<platform>.create_adapter(config, secret, *, store)``, else the
    module's ``<Platform>Adapter(token, account=...)`` for single-token platforms."""
    try:
        mod = importlib.import_module(f"{__package__}.{platform}")
    except ImportError:
        return None
    create = getattr(mod, "create_adapter", None)
    if create is not None:
        return lambda config, secret, store: create(config, secret, store=store)
    cls = getattr(mod, f"{platform.capitalize()}Adapter", None)
    if cls is None:
        return None

    def build(config: dict[str, Any], secret: dict[str, Any], store: ChannelStore) -> ChannelAdapter:
        token = secret.get("token")
        if not token:
            raise ValueError("missing token")
        return cls(token, account=str(config.get("account") or "default"))

    return build


@dataclass
class _Pending:
    """A pane that owes its bound location a reply."""

    loc: Location
    armed_at: float | None = None  # monotonic time the message went in; None while queued
    status_id: str = ""
    status_failures: int = 0
    last_edit: float = 0.0
    started: float = field(default_factory=time.monotonic)
    awaiting_posted: bool = False
    task: asyncio.Task[None] | None = None


@dataclass
class _Worker:
    jobs: deque[Callable[[], Awaitable[None]]] = field(default_factory=deque)
    task: asyncio.Task[None] | None = None


@dataclass
class _Debounce:
    """Lines from one sender to one location, waiting to be joined."""

    msg: InboundMessage
    binding: Binding
    pane_id: str
    texts: list[str]
    first_at: float
    task: asyncio.Task[None] | None = None


class ChannelManager:
    def __init__(
        self,
        store: ChannelStore,
        seams: Seams,
        *,
        factory_for: Callable[[str], AdapterFactory | None] = default_adapter_factory,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.store = store
        self.gate = SenderGate(store)
        self._seams = seams
        self._factory_for = factory_for
        self._clock = clock
        self._adapters: dict[str, ChannelAdapter] = {}
        self._lease: dict[str, str] = {}  # token fingerprint -> platform
        self._errors: dict[str, str] = {}  # platform -> config error shown in status
        self._secret_hints: dict[str, str] = {}
        self._dedup: OrderedDict[tuple[str, str], None] = OrderedDict()
        self._pending: dict[str, _Pending] = {}
        self._queued: dict[str, set[str]] = {}  # pane_id -> msg_keys still queued
        self._seen_chats: dict[str, dict[str, dict[str, Any]]] = {}
        self._last_status: dict[str, dict[str, Any]] = {}
        self._tasks: set[asyncio.Task[Any]] = set()
        self._status_task: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = asyncio.Lock()
        self.relay = relay.RelayTable(clock=clock)
        self._debounce: dict[tuple[str, str], _Debounce] = {}
        # One serial worker per location: order kept within a chat, chats never block each other.
        self._workers: dict[str, _Worker] = {}
        self._known_panes: set[str] = set()

    # --- lifecycle --------------------------------------------------------------

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        if self._status_task is None:
            self._status_task = asyncio.create_task(self._status_watch(), name="channels-status")
        if self.store.global_enabled():
            for platform, acct in self.store.accounts().items():
                if acct["enabled"]:
                    await self._start_platform(platform)

    async def stop(self) -> None:
        if self._status_task:
            self._status_task.cancel()
            self._status_task = None
        for platform in list(self._adapters):
            await self._stop_platform(platform)
        self._workers.clear()
        self._debounce.clear()
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()

    # --- per-location workers ---------------------------------------------------------

    def _enqueue(self, location_key: str, job: Callable[[], Awaitable[None]]) -> None:
        worker = self._workers.get(location_key)
        if worker is None:
            worker = _Worker()
            self._workers[location_key] = worker
        worker.jobs.append(job)
        if worker.task is None:
            worker.task = self._spawn(self._run_worker(location_key, worker))

    async def _run_worker(self, location_key: str, worker: _Worker) -> None:
        while worker.jobs:
            job = worker.jobs.popleft()
            try:
                await job()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — one bad message must not stall the chat
                log.exception("channels: inbound job for %s failed", location_key)
        # Idle: retire. No await between the empty check above and this removal,
        # so a job enqueued from here on starts a fresh worker.
        if self._workers.get(location_key) is worker:
            del self._workers[location_key]

    def _cancel_workers(self) -> None:
        for worker in self._workers.values():
            if worker.task:
                worker.task.cancel()
        self._workers.clear()
        for buf in self._debounce.values():
            if buf.task:
                buf.task.cancel()
        self._debounce.clear()

    async def wait_idle(self) -> None:
        """Until every queued inbound job has run (tests, orderly shutdown)."""
        while self._workers or self._debounce:
            pending = [w.task for w in self._workers.values() if w.task]
            pending += [b.task for b in self._debounce.values() if b.task]
            if not pending:
                return
            await asyncio.wait(pending)

    def _spawn(self, coro: Awaitable[Any]) -> asyncio.Task[Any]:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def _load_secret(self, platform: str) -> dict[str, Any] | None:
        raw = await self._seams.read_secret(_secret_name(platform))
        if not raw:
            return None
        try:
            secret = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return secret if isinstance(secret, dict) else None

    def _build(self, platform: str, config: dict[str, Any], secret: dict[str, Any]) -> ChannelAdapter:
        factory = self._factory_for(platform)
        if factory is None:
            raise ValueError(f"{platform} adapter is not available in this build")
        return factory(config, secret, self.store)

    def _lease_holder(self, fingerprint: str, platform: str) -> str | None:
        holder = self._lease.get(fingerprint)
        return holder if holder and holder != platform else None

    async def _start_platform(self, platform: str, secret: dict[str, Any] | None = None) -> str | None:
        """Start (or restart) one platform. Returns an error string or None."""
        await self._stop_platform(platform)
        acct = self.store.accounts().get(platform)
        if acct is None:
            return "not configured"
        try:
            if secret is None:
                secret = await self._load_secret(platform)
            if not secret:
                raise ValueError("尚未設定憑證 (no credential stored)")
            self._secret_hints[platform] = _mask_secret(secret)
            for value in secret.values():
                if isinstance(value, str):
                    redact.add_secret(value)
            adapter = self._build(platform, acct["config"], secret)
        except Exception as exc:  # noqa: BLE001 — surfaced as the platform's status
            self._errors[platform] = str(exc)
            return str(exc)
        fp = adapter.token_fingerprint()
        holder = self._lease_holder(fp, platform)
        if holder:
            err = f"同一個 token 已被 {holder} 使用 (token already leased by {holder})"
            self._errors[platform] = err
            return err
        self._lease[fp] = platform
        self._errors.pop(platform, None)
        self._adapters[platform] = adapter

        async def emit(msg: InboundMessage) -> None:
            await self.handle_inbound(msg)

        await adapter.start(emit)
        return None

    async def _stop_platform(self, platform: str) -> None:
        adapter = self._adapters.pop(platform, None)
        if adapter is None:
            return
        for fp, holder in list(self._lease.items()):
            if holder == platform:
                del self._lease[fp]
        try:
            await adapter.stop()
        except Exception:  # noqa: BLE001
            log.exception("channels: stopping %s failed", platform)

    # --- status -----------------------------------------------------------------

    def _status_of(self, platform: str) -> dict[str, Any]:
        adapter = self._adapters.get(platform)
        if adapter is not None:
            return dataclasses.asdict(adapter.status)
        status: dict[str, Any] = {
            "lifecycle": "stopped", "connected": False, "reconnect_attempts": 0,
            "last_error": "", "last_connected_at": None, "last_inbound_at": None, "identity": "",
        }
        if platform in self._errors:
            status["lifecycle"] = "blocked"
            status["last_error"] = self._errors[platform]
        return status

    async def _status_watch(self) -> None:
        while True:
            await asyncio.sleep(STATUS_POLL_S)
            try:
                await self.broadcast_status_changes()
            except Exception:  # noqa: BLE001
                log.exception("channels: status broadcast failed")

    async def broadcast_status_changes(self) -> None:
        for platform in PLATFORMS:
            status = self._status_of(platform)
            if self._last_status.get(platform) != status:
                self._last_status[platform] = status
                await self._seams.broadcast("channels.status", {"platform": platform, "status": status})

    async def _changed(self) -> None:
        await self._seams.broadcast("channels.changed", {})

    # --- WS-facing API ------------------------------------------------------------

    def _sync_bindings(self) -> bool:
        """Follow panes to their current ids (an app restart re-registers every
        pane under a new id with its old ones as aliases). True if any moved."""
        changed = False
        bindings = self.store.bindings()
        taken = {b.pane_id for b in bindings}
        for b in bindings:
            current = self._seams.resolve_pane(b.pane_id)
            if current and current != b.pane_id and current not in taken:
                if self.store.rename_pane(b.pane_id, current):
                    taken.discard(b.pane_id)
                    taken.add(current)
                    changed = True
        if changed and self._loop is not None:
            self._spawn(self._changed())
        return changed

    def list(self) -> dict[str, Any]:
        self._sync_bindings()
        accounts = self.store.accounts()
        platforms = []
        for platform in PLATFORMS:
            acct = accounts.get(platform)
            adapter = self._adapters.get(platform)
            caps = dataclasses.asdict(adapter.capabilities) if adapter is not None else None
            platforms.append({
                "platform": platform,
                "configured": acct is not None,
                "enabled": bool(acct and acct["enabled"]),
                "status": self._status_of(platform),
                "config": {**(acct["config"] if acct else {}),
                           "secret_hint": self._secret_hints.get(platform, "")},
                "capabilities": caps,
            })
        return {"enabled": self.store.global_enabled(), "platforms": platforms}

    async def configure(self, platform: str, config: dict[str, Any], secret: dict[str, Any] | None) -> dict[str, Any]:
        _check_platform(platform)
        config = {k: v for k, v in (config or {}).items() if k != "secret_hint"}
        async with self._lock:
            if secret is not None:
                # Refuse a token another platform already polls with before storing anything.
                try:
                    probe = self._build(platform, config, secret)
                except Exception as exc:  # noqa: BLE001
                    return {"ok": False, "error": str(exc)}
                holder = self._lease_holder(probe.token_fingerprint(), platform)
                if holder:
                    return {"ok": False, "error": f"同一個 token 已被 {holder} 使用 (token already in use by {holder})"}
                await self._seams.write_secret(
                    _secret_name(platform), json.dumps(secret, separators=(",", ":"), ensure_ascii=True)
                )
            self.store.upsert_account(platform, config)
            err = None
            acct = self.store.accounts()[platform]
            if self.store.global_enabled() and acct["enabled"]:
                err = await self._start_platform(platform, secret)
        await self._changed()
        await self.broadcast_status_changes()
        return {"ok": err is None, "platform": platform, **({"error": err} if err else {})}

    async def set_enabled(self, platform: str, enabled: bool) -> dict[str, Any]:
        _check_platform(platform)
        async with self._lock:
            if not self.store.set_account_enabled(platform, enabled):
                return {"ok": False, "error": "not configured"}
            err = None
            if not enabled:
                await self._stop_platform(platform)
                self._errors.pop(platform, None)
            elif self.store.global_enabled():
                err = await self._start_platform(platform)
        await self._changed()
        await self.broadcast_status_changes()
        return {"ok": err is None, **({"error": err} if err else {})}

    async def set_global_enabled(self, enabled: bool) -> dict[str, Any]:
        async with self._lock:
            self.store.set_global_enabled(enabled)
            if not enabled:
                self._cancel_workers()
                for platform in list(self._adapters):
                    await self._stop_platform(platform)
                for pending in self._pending.values():
                    if pending.task:
                        pending.task.cancel()
                self._pending.clear()
            else:
                for platform, acct in self.store.accounts().items():
                    if acct["enabled"]:
                        await self._start_platform(platform)
        await self._changed()
        await self.broadcast_status_changes()
        return {"ok": True}

    async def remove(self, platform: str) -> dict[str, Any]:
        _check_platform(platform)
        async with self._lock:
            await self._stop_platform(platform)
            self.store.remove_platform(platform)
            await self._seams.write_secret(_secret_name(platform), None)
            self._errors.pop(platform, None)
            self._secret_hints.pop(platform, None)
            self._seen_chats.pop(platform, None)
            for pane_id, p in list(self._pending.items()):
                if p.loc.platform == platform:
                    self._drop_pending(pane_id)
        await self._changed()
        await self.broadcast_status_changes()
        return {"ok": True}

    def pairing_list(self, platform: str | None) -> dict[str, Any]:
        self.gate.prune()
        return {"ok": True, "requests": [r.public() for r in self.store.list_pairing(platform or None)]}

    async def pairing_approve(self, platform: str, code: str) -> dict[str, Any]:
        req = self.gate.approve(platform, code)
        if req is None:
            return {"ok": False, "error": "配對碼不存在或已過期 (unknown or expired code)"}
        adapter = self._adapters.get(platform)
        if adapter is not None:
            try:
                await adapter.send_text(Location(platform, getattr(adapter, "account", "default"), req.chat_id),
                                        "✅ 已核准，可以開始對話")
            except Exception:  # noqa: BLE001
                log.warning("channels: approval notice to %s failed", platform)
        await self._changed()
        return {"ok": True, "sender_id": req.sender_id}

    async def pairing_reject(self, platform: str, code: str) -> dict[str, Any]:
        req = self.gate.reject(platform, code)
        await self._changed()
        return {"ok": req is not None, **({} if req else {"error": "unknown code"})}

    def allow_list(self, platform: str | None) -> dict[str, Any]:
        return {"ok": True, "entries": self.store.list_allow(platform or None)}

    async def allow_remove(self, platform: str, sender_id: str) -> dict[str, Any]:
        removed = self.store.remove_allow(platform, sender_id)
        await self._changed()
        return {"ok": removed, **({} if removed else {"error": "not found"})}

    def locations(self, platform: str) -> dict[str, Any]:
        merged: dict[str, dict[str, Any]] = dict(self._seen_chats.get(platform, {}))
        adapter = self._adapters.get(platform)
        known = getattr(adapter, "known_locations", None)
        if callable(known):
            for loc in known():
                merged[str(loc.get("chat_id"))] = {**merged.get(str(loc.get("chat_id")), {}), **loc}
        return {"ok": True, "locations": list(merged.values())}

    async def bind(self, pane_id: str, pane_name: str, platform: str, mode: str,
                   chat_id: str, thread_id: str = "", title: str = "") -> dict[str, Any]:
        _check_platform(platform)
        if not pane_id or not chat_id:
            return {"ok": False, "error": "pane_id and chat_id are required"}
        # Restore placeholders are registered too, so they still resolve and bind.
        current = self._seams.resolve_pane(pane_id)
        if not current:
            return {"ok": False, "error": "pane not found"}
        pane_id = current
        adapter = self._adapters.get(platform)
        if adapter is None:
            return {"ok": False, "error": f"{platform} is not connected"}
        account = str(getattr(adapter, "account", "default"))
        if mode == "new":
            if not adapter.capabilities.create_location:
                return {"ok": False, "error": f"{platform} cannot create topics"}
            try:
                loc = await adapter.create_location(chat_id, title or pane_name or "Navide")
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "error": str(exc)}
        elif mode == "existing":
            loc = Location(platform, account, str(chat_id), str(thread_id or ""), title or pane_name)
        else:
            return {"ok": False, "error": f"unknown mode {mode!r}"}
        binding = self.store.bind(pane_id, loc)
        await self._changed()
        return {"ok": True, "binding": binding.public()}

    async def unbind(self, pane_id: str) -> dict[str, Any]:
        removed = self.store.unbind(pane_id)
        self._drop_pending(pane_id)
        if removed:
            await self._changed()
        return {"ok": True, "removed": removed is not None}

    async def rebind(self, from_pane_id: str, to_pane_id: str) -> dict[str, Any]:
        """Move a binding to the pane that replaced ``from_pane_id`` (rebuild)."""
        if not from_pane_id or not to_pane_id:
            return {"ok": False, "error": "from_pane_id and to_pane_id are required"}
        if from_pane_id == to_pane_id or not self.store.rename_pane(from_pane_id, to_pane_id):
            return {"ok": True}
        pending = self._pending.pop(from_pane_id, None)
        if pending is not None:
            if pending.task:
                pending.task.cancel()
                pending.task = None
            self._pending[to_pane_id] = pending
            if pending.armed_at is not None:
                pending.task = self._spawn(self._while_running(to_pane_id, pending))
        binding = next((b for b in self.store.bindings() if b.pane_id == to_pane_id), None)
        await self._changed()
        return {"ok": True, **({"binding": binding.public()} if binding else {})}

    def bindings(self) -> dict[str, Any]:
        self._sync_bindings()
        return {"ok": True, "bindings": [b.public() for b in self.store.bindings()]}

    # --- pane activity (app.pane_activity_listeners) --------------------------------

    def on_pane_activity(self, pane_id: str, entry: dict[str, Any] | None) -> None:
        """Sync listener registered in app.pane_activity_listeners. Never raises."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            self._handle_activity(pane_id, entry)
        else:
            loop.call_soon_threadsafe(self._handle_activity, pane_id, entry)

    def _handle_activity(self, pane_id: str, entry: dict[str, Any] | None) -> None:
        if entry is None:
            # Unregistered is not closed: a rebuild, detach or workspace switch
            # unregisters too. Only the running watch goes; the binding stays
            # until channels.unbind / channels.rebind.
            self._drop_pending(pane_id)
            self.relay.expire_pane(pane_id)
            self._known_panes.discard(pane_id)
            return
        if pane_id not in self._known_panes:
            # First activity from this id (e.g. after a restart): rebind by alias.
            self._known_panes.add(pane_id)
            self._sync_bindings()
        pending = self._pending.get(pane_id)
        if pending is None or pending.armed_at is None or entry.get("event_type") != "turn_complete":
            return
        if float(entry.get("ts_monotonic") or 0) <= pending.armed_at:
            return  # the turn that was running when the message went in
        self._pending.pop(pane_id, None)
        if pending.task:
            pending.task.cancel()
        self.relay.expire_pane(pane_id)
        self._spawn(self._send_reply(pending, str(entry.get("text") or "")))

    async def _send_reply(self, pending: _Pending, text: str) -> None:
        adapter = self._adapters.get(pending.loc.platform)
        if adapter is None:
            return
        if pending.status_id:
            elapsed = int(self._clock() - pending.started)
            await self._edit_status(adapter, pending, f"✅ 完成（{elapsed}s）", force=True)
        chunks = chunk_for(pending.loc.platform, text) or [MSG_EMPTY_REPLY]
        for chunk in chunks:
            try:
                await adapter.send_text(pending.loc, chunk)
            except Exception as exc:  # noqa: BLE001
                log.warning("channels: reply to %s failed: %s", pending.loc.key(), exc)
                return

    # --- inbound ------------------------------------------------------------------

    def _is_duplicate(self, msg: InboundMessage) -> bool:
        key = (msg.platform, msg.message_id)
        if key in self._dedup:
            self._dedup.move_to_end(key)
            return True
        self._dedup[key] = None
        while len(self._dedup) > DEDUP_MAX:
            self._dedup.popitem(last=False)
        return False

    def _remember_chat(self, msg: InboundMessage) -> None:
        chats = self._seen_chats.setdefault(msg.platform, {})
        entry = chats.setdefault(msg.chat_id, {
            "chat_id": msg.chat_id, "title": msg.sender_name if msg.is_direct else msg.chat_id,
            "kind": "direct" if msg.is_direct else "group", "supports_topics": False,
        })
        if msg.thread_id:
            entry["supports_topics"] = True

    def _binding_for(self, msg: InboundMessage) -> Binding | None:
        key = msg.location_key()
        for b in self.store.bindings():
            if b.location().key() == key:
                return b
        return None

    async def _reply(self, msg: InboundMessage, text: str) -> str:
        adapter = self._adapters.get(msg.platform)
        if adapter is None:
            return ""
        loc = Location(msg.platform, msg.account, msg.chat_id, msg.thread_id)
        try:
            ids = await adapter.send_text(loc, text)
            return ids[0] if ids else ""
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: reply on %s failed: %s", msg.platform, exc)
            return ""

    async def handle_inbound(self, msg: InboundMessage) -> None:
        """Called on the adapter's receive loop: only fast, synchronous checks here.

        Everything that awaits the network or a UI round trip (replies, delivery,
        interrupt, relay answers) runs on the location's worker, so one slow
        chat never stalls receiving for every platform.
        """
        if not self.store.global_enabled() or msg.platform not in self._adapters:
            return
        if self._is_duplicate(msg):
            return
        if not msg.is_direct and not self.gate.is_allowed(msg.platform, msg.sender_id):
            return  # group strangers are dropped silently
        self._enqueue(msg.location_key(), lambda: self._process_inbound(msg))

    async def _process_inbound(self, msg: InboundMessage) -> None:
        if not self.store.global_enabled() or msg.platform not in self._adapters:
            return
        if not self.gate.is_allowed(msg.platform, msg.sender_id):
            await self._pairing_reply(msg)  # only DMs get this far
            return
        self._remember_chat(msg)
        # Relay answers go before any queueing: the pane is blocked on exactly this.
        if self._relay_enabled(msg.platform):
            answer = relay.parse_answer(msg.text, msg.callback_data)
            if answer is not None:
                await self._handle_relay_answer(msg, answer)
                return
        if msg.callback_data and not msg.text:
            return  # a button press with the relay off, or not ours
        binding = self._binding_for(msg)
        if binding is None:
            await self._reply(msg, MSG_NOT_BOUND)
            return
        pane_id = self._seams.resolve_pane(binding.pane_id)
        if not pane_id:
            await self._reply(msg, MSG_OFFLINE)  # binding kept: it may come back
            return
        if pane_id != binding.pane_id:
            self.store.rename_pane(binding.pane_id, pane_id)
        if _is_stop_word(msg.text):
            await self._interrupt(msg, pane_id)
            return
        await self._debounced_deliver(msg, binding, pane_id)

    async def _debounced_deliver(self, msg: InboundMessage, binding: Binding, pane_id: str) -> None:
        if DEBOUNCE_S <= 0:
            await self._deliver(msg, binding, pane_id)
            return
        key = (msg.location_key(), msg.sender_id)
        now = self._clock()
        buf = self._debounce.get(key)
        if buf is None:
            buf = _Debounce(msg, binding, pane_id, [], now)
            self._debounce[key] = buf
        buf.msg, buf.binding, buf.pane_id = msg, binding, pane_id
        buf.texts.append(msg.text)
        if buf.task is not None:
            buf.task.cancel()
        wait = max(0.0, min(DEBOUNCE_S, buf.first_at + DEBOUNCE_MAX_S - now))
        buf.task = self._spawn(self._flush_debounce(key, buf, wait))

    async def _flush_debounce(self, key: tuple[str, str], buf: _Debounce, wait: float) -> None:
        await asyncio.sleep(wait)
        if self._debounce.get(key) is not buf:
            return
        del self._debounce[key]
        joined = dataclasses.replace(buf.msg, text="\n".join(buf.texts))
        # Back onto the location's worker so it stays ordered with that chat's other jobs.
        self._enqueue(joined.location_key(), lambda: self._deliver(joined, buf.binding, buf.pane_id))

    def _relay_enabled(self, platform: str) -> bool:
        acct = self.store.accounts().get(platform)
        return bool(acct) and acct["config"].get("permission_relay") is not False

    async def _handle_relay_answer(self, msg: InboundMessage, answer: relay.RelayAnswer) -> None:
        request = self.relay.take(answer.request_id)
        if request is None or request.loc.platform != msg.platform or request.loc.chat_id != msg.chat_id:
            await self._reply(msg, MSG_RELAY_EXPIRED)
            return
        if relay.refuses_permanent(request, answer.choice):
            await self._reply(msg, MSG_RELAY_PERMANENT)
            return
        payload = relay.answer_payload(request, answer.choice)
        if payload is None:
            await self._reply(msg, MSG_RELAY_EXPIRED if request.kind == "permission"
                              else "⚠️ 請回覆有效的選項編號")
            return
        try:
            result = await self._seams.answer(request.pane_id, payload)
        except Exception as exc:  # noqa: BLE001
            result = {"ok": False, "error": str(exc)}
        if result.get("ok"):
            await self._reply(msg, f"✅ 已送出：{relay.describe_answer(payload)}")
        else:
            await self._reply(msg, f"⚠️ 送出失敗：{result.get('error') or 'not sent'}")

    async def _pairing_reply(self, msg: InboundMessage) -> None:
        outcome = self.gate.request_pairing(msg.platform, msg.sender_id, msg.sender_name, msg.chat_id)
        if outcome.full or outcome.request is None:
            return
        code = outcome.request.code
        await self._reply(msg, f"這個 bot 需要配對。請在 Navide 的 Settings → Channels 核准配對碼：{code[:4]}-{code[4:]}")
        if outcome.created:
            await self._seams.broadcast("channels.pairing_request", {
                "platform": msg.platform, "code": code, "sender_name": msg.sender_name,
            })
            await self._changed()

    async def _interrupt(self, msg: InboundMessage, pane_id: str) -> None:
        try:
            result = await self._seams.interrupt(pane_id)
        except Exception as exc:  # noqa: BLE001
            result = {"ok": False, "error": str(exc)}
        if result.get("ok") and result.get("sent", True):
            await self._reply(msg, MSG_INTERRUPTED)
        else:
            await self._reply(msg, f"⚠️ 中斷失敗：{result.get('error') or 'not sent'}")

    async def _deliver(self, msg: InboundMessage, binding: Binding, pane_id: str) -> None:
        queued = self._queued.setdefault(pane_id, set())
        if len(queued) >= MAX_QUEUED_PER_PANE:
            await self._reply(msg, MSG_QUEUE_FULL)
            return
        state = self._seams.pane_state(pane_id)
        try:
            result = await self._seams.deliver(pane_id, msg.text, f"{msg.platform}:{msg.sender_name}")
        except Exception as exc:  # noqa: BLE001
            result = {"ok": False, "error": str(exc)}
        if not result.get("ok"):
            await self._reply(msg, f"⚠️ 無法送達 pane：{result.get('error') or 'unknown'}")
            return
        msg_key = str(result.get("msg_key") or "")
        pane_id = str(result.get("pane_id") or pane_id)
        loc = binding.location()
        pending = self._pending.get(pane_id)
        if pending is None or pending.loc != loc:
            pending = _Pending(loc=loc)
            self._pending[pane_id] = pending
        if state.get("busy") and not pending.status_id:
            pending.status_id = await self._reply(msg, MSG_RECEIVED_BUSY)
        queued.add(msg_key)
        self._spawn(self._watch_delivery(pane_id, msg_key, pending))

    async def _watch_delivery(self, pane_id: str, msg_key: str, pending: _Pending) -> None:
        adapter = self._adapters.get(pending.loc.platform)
        started = self._clock()
        held_notice = False
        try:
            while True:
                verdict = await self._seams.await_verdict(msg_key, VERDICT_POLL_S)
                status = verdict.get("status")
                if status == "delivered":
                    self._arm(pane_id, pending)
                    return
                if status in ("failed", "cancelled"):
                    if adapter is not None and status == "failed":
                        await self._notice(adapter, pending.loc, f"⚠️ 訊息沒有送進 pane（{verdict.get('reason') or 'failed'}）")
                    return
                age = self._clock() - started
                hold = (verdict.get("hold") or {}).get("key") or ""
                if adapter is not None and not held_notice:
                    if hold in HOLD_FAILURE_KEYS and age >= HOLD_FAILURE_AFTER_S:
                        held_notice = True
                        await self._notice(adapter, pending.loc, f"⚠️ pane 目前無法接收訊息（{hold}），訊息仍在排隊")
                    elif age >= HELD_NOTICE_AFTER_S:
                        held_notice = True
                        await self._notice(adapter, pending.loc, f"⚠️ 訊息已排隊超過 {int(age // 60)} 分鐘（{hold or 'queued'}）")
                if age >= VERDICT_WATCH_MAX_S or verdict.get("unknown"):
                    return
        finally:
            q = self._queued.get(pane_id)
            if q is not None:
                q.discard(msg_key)
                if not q:
                    self._queued.pop(pane_id, None)

    def _arm(self, pane_id: str, pending: _Pending) -> None:
        """The message is in the pane: its next turn_complete is the reply.

        The pending this delivery started with may already be gone — an earlier
        message's turn ended (and was answered) while this one sat in the pane's
        queue. Re-create it for the same location, unless the pane was unbound
        or rebound meanwhile.
        """
        current = self._pending.get(pane_id)
        if current is None or current.loc != pending.loc:
            bound = next((b for b in self.store.bindings() if b.pane_id == pane_id), None)
            if bound is None or bound.location() != pending.loc:
                return
            current = _Pending(loc=pending.loc)
            self._pending[pane_id] = current
        if current.armed_at is None:
            current.armed_at = self._clock()
            current.started = current.armed_at
        if current.task is None or current.task.done():
            current.task = self._spawn(self._while_running(pane_id, current))

    async def _notice(self, adapter: ChannelAdapter, loc: Location, text: str) -> None:
        try:
            await adapter.send_text(loc, text)
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: notice to %s failed: %s", loc.key(), exc)

    async def _while_running(self, pane_id: str, pending: _Pending) -> None:
        """Typing every 4s, one status message edited in place, awaiting notices."""
        adapter = self._adapters.get(pending.loc.platform)
        if adapter is None:
            return
        caps = adapter.capabilities
        if caps.edit:
            if pending.status_id:
                await self._edit_status(adapter, pending, MSG_WORKING, force=True)
            else:
                try:
                    ids = await adapter.send_text(pending.loc, MSG_WORKING)
                    pending.status_id = ids[0] if ids else ""
                except Exception:  # noqa: BLE001
                    pending.status_id = ""
        next_typing = next_edit = next_probe = self._clock()
        while self._pending.get(pane_id) is pending:
            now = self._clock()
            if now - pending.started >= RUN_WATCH_MAX_S:
                # No turn end in sight (crashed pane, missed event): stop the
                # indicators but keep the pending so a late turn_complete still replies.
                await self._edit_status(adapter, pending, MSG_STILL_RUNNING, force=True)
                return
            if caps.typing and now >= next_typing:
                next_typing = now + TYPING_EVERY_S
                try:
                    await adapter.send_typing(pending.loc)
                except Exception:  # noqa: BLE001
                    pass
            if caps.edit and pending.status_id and now >= next_edit:
                next_edit = now + STATUS_EDIT_EVERY_S
                await self._edit_status(adapter, pending, f"{MSG_WORKING}（{int(now - pending.started)}s）")
            if now >= next_probe:
                next_probe = now + AWAITING_PROBE_EVERY_S
                await self._check_awaiting(adapter, pane_id, pending)
            await asyncio.sleep(RUN_TICK_S)

    async def _edit_status(self, adapter: ChannelAdapter, pending: _Pending, text: str, *, force: bool = False) -> None:
        if not pending.status_id or pending.status_failures >= STATUS_EDIT_MAX_FAILURES:
            return
        now = self._clock()
        if not force and now - pending.last_edit < STATUS_EDIT_MIN_INTERVAL_S:
            return
        pending.last_edit = now
        try:
            await adapter.edit_text(pending.loc, pending.status_id, text)
            pending.status_failures = 0
        except Exception:  # noqa: BLE001
            pending.status_failures += 1

    async def _check_awaiting(self, adapter: ChannelAdapter, pane_id: str, pending: _Pending) -> None:
        state = self._seams.pane_state(pane_id)
        if state.get("display_status") != "awaiting":
            if pending.awaiting_posted:
                self.relay.expire_pane(pane_id)  # the prompt was answered at the keyboard
            pending.awaiting_posted = False
            return
        if pending.awaiting_posted:
            return
        pending.awaiting_posted = True
        try:
            info = await self._seams.awaiting_info(pane_id)
        except Exception:  # noqa: BLE001
            info = {}
        kind = str(info.get("kind") or "") or "permission"
        options = [str(o) for o in (info.get("options") or [])]
        # Claude's AskUserQuestion reports "permission"; the options tell them apart.
        if options:
            kind = "permission" if options[0].strip().lower().startswith("yes") else "question"
        if not self._relay_enabled(pending.loc.platform):
            await self._notice(adapter, pending.loc, f"⏸ pane 等待確認（{kind}）")
            return
        self.relay.expire_pane(pane_id)  # one live request per pane
        request = self.relay.create(pane_id, kind, options, pending.loc)
        text = relay.prompt_text(request, str(info.get("prompt") or ""))
        buttons = relay.buttons_for(request) if adapter.capabilities.buttons else None
        try:
            await adapter.send_text(pending.loc, text, buttons=buttons or None)
        except Exception as exc:  # noqa: BLE001
            log.warning("channels: relay prompt to %s failed: %s", pending.loc.key(), exc)

    def _drop_pending(self, pane_id: str) -> None:
        pending = self._pending.pop(pane_id, None)
        if pending and pending.task:
            pending.task.cancel()


def _check_platform(platform: str) -> None:
    if platform not in PLATFORMS:
        raise ValueError(f"unknown platform {platform!r}")


def _is_stop_word(text: str) -> bool:
    word = (text or "").strip().lower()
    if word.startswith("/") and "@" in word:
        word = word.split("@", 1)[0]  # Telegram group command form: /stop@navide_bot
    return word in STOP_WORDS


def _mask_secret(secret: dict[str, Any]) -> str:
    for value in secret.values():
        if isinstance(value, str) and value:
            return f"{value[:4]}…{value[-4:]}" if len(value) > 12 else "••••"
    return ""
