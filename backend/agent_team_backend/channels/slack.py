"""Slack adapter: Socket Mode (WebSocket) for inbound, Web API for outbound.

Verified facts (docs.slack.dev, read 2026-09-24):
- apps.connections.open: POST with the app-level token (xapp-) in the Authorization
  header -> {"ok":true,"url":"wss://..."}; errors invalid_auth, not_authed,
  not_allowed_token_type, token_expired, token_revoked, account_inactive.
  https://docs.slack.dev/reference/methods/apps.connections.open
- Socket Mode: Slack sends {"type":"hello"}; every envelope {envelope_id, type
  (events_api|interactive|slash_commands), payload} must be acked with
  {"envelope_id": ...}; {"type":"disconnect","reason": warning|refresh_requested|
  link_disabled} -> open a new URL (link_disabled = Socket Mode turned off).
  https://docs.slack.dev/apis/events-api/using-socket-mode
- message events: channel, user, text, ts, thread_ts, channel_type im|channel|group|mpim,
  subtype (bot_message, message_changed, ... skipped), bot_id on integration posts.
  A mention arrives twice (message + app_mention): dedup by (channel, ts).
  https://docs.slack.dev/reference/events/message
- chat.postMessage (chat:write) channel/text/thread_ts/blocks -> ts; ~1 msg/s per
  channel; 429 carries Retry-After. chat.update channel/ts/text, msg_too_long > 4000.
  https://docs.slack.dev/reference/methods/chat.postMessage , .../chat.update
Gaps: bots have no typing indicator over the Web API / Socket Mode (typing=False).
Markdown is sent as-is (Slack mrkdwn differs: **bold** shows literally).
Not verified against a live workspace (tests use local fakes).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import random
import time
from collections import OrderedDict
from typing import Any, Callable

import httpx
from websockets.asyncio.client import connect as ws_connect

from .adapter_runtime import ReceiveLoop, ReconnectNow, send_request, ws_keepalive
from .base import (
    STALL_WATCHDOG_S,
    AdapterStatus,
    Capabilities,
    ChannelAuthError,
    ChannelSendError,
    Emit,
    InboundMessage,
    Location,
    backoff_delay,
)
from .text import TEXT_LIMITS, chunk_text

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://slack.com/api"
AUTH_ERRORS = {
    "invalid_auth", "not_authed", "not_allowed_token_type", "token_expired",
    "token_revoked", "account_inactive",
}
# Subtypes that still carry a human's text.
TEXT_SUBTYPES = {"", "thread_broadcast", "file_share"}
EDIT_LIMIT = 4000
SECTION_LIMIT = 3000
DEDUP_SIZE = 2000


class SlackApiError(Exception):
    def __init__(self, method: str, error: str) -> None:
        super().__init__(f"{method}: {error}")
        self.error = error


class SlackAdapter:
    platform = "slack"
    capabilities = Capabilities(
        threads=True, create_location=True, edit=True, typing=False, buttons=True,
        text_limit=TEXT_LIMITS["slack"],
    )

    def __init__(
        self,
        app_token: str,
        bot_token: str,
        *,
        account: str = "default",
        base_url: str = DEFAULT_BASE_URL,
        backoff: Callable[[int, float], float] = backoff_delay,
        stall_timeout_s: float = STALL_WATCHDOG_S,
        ping_interval_s: float = 30.0,
    ) -> None:
        self._app_token = app_token.strip()
        self._bot_token = bot_token.strip()
        self.account = account
        self._base = base_url.rstrip("/")
        self.status = AdapterStatus()
        self._emit: Emit | None = None
        self._client: httpx.AsyncClient | None = None
        self._loop = ReceiveLoop(
            "slack", self.status, self._connect_once,
            stall_s=stall_timeout_s, delay=lambda n: backoff(n, random.random()),
        )
        self._ping_interval_s = ping_interval_s
        self._user_id = ""
        self._bot_id = ""
        self._names: dict[str, str] = {}
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._known: dict[str, dict[str, Any]] = {}
        self._ws_lock = asyncio.Lock()

    # --- lifecycle ------------------------------------------------------------

    def token_fingerprint(self) -> str:
        # The app-level token owns the Socket Mode connection; the bot token is the
        # identity. Either one shared with another consumer is a conflict.
        return hashlib.sha256(f"{self._app_token}\n{self._bot_token}".encode()).hexdigest()

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self._base, timeout=httpx.Timeout(20.0, connect=10.0),
            )
        return self._client

    async def start(self, emit: Emit) -> None:
        self._emit = emit
        self._loop.start()

    async def stop(self) -> None:
        await self._loop.stop()
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # --- Web API ----------------------------------------------------------------

    async def _call(self, method: str, *, token: str, json_body: dict[str, Any] | None = None,
                    form: dict[str, str] | None = None) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"headers": {"Authorization": f"Bearer {token}"}}
        if json_body is not None:
            kwargs["json"] = json_body
        elif form is not None:
            kwargs["data"] = form
        resp = await send_request(self._http(), "POST", f"/{method}", **kwargs)
        try:
            body = resp.json()
        except ValueError as exc:
            raise SlackApiError(method, f"HTTP {resp.status_code}") from exc
        if not body.get("ok"):
            error = str(body.get("error") or f"HTTP {resp.status_code}")
            if error in AUTH_ERRORS:
                raise ChannelAuthError(f"Slack rejected the token ({method}: {error})")
            raise SlackApiError(method, error)
        return body

    async def _write(self, method: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            return await self._call(method, token=self._bot_token, json_body=body)
        except (ChannelAuthError, SlackApiError) as exc:
            raise ChannelSendError(str(exc)) from exc

    # --- Socket Mode ------------------------------------------------------------

    async def _connect_once(self) -> None:
        if not self._user_id:
            me = await self._call("auth.test", token=self._bot_token, form={})
            self._user_id = str(me.get("user_id") or "")
            self._bot_id = str(me.get("bot_id") or "")
            self.status.identity = f"@{me.get('user')}" if me.get("user") else ""
        opened = await self._call("apps.connections.open", token=self._app_token, form={})
        url = str(opened.get("url") or "")
        if not url:
            raise ConnectionError("apps.connections.open returned no url")
        async with ws_connect(url, max_size=None, ping_interval=None) as ws:
            keepalive = asyncio.create_task(ws_keepalive(ws, self._loop.touch, self._ping_interval_s))
            try:
                async for raw in ws:
                    self._loop.touch()
                    await self._on_frame(ws, json.loads(raw))
            finally:
                keepalive.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await keepalive

    async def _ws_send(self, ws: Any, payload: dict[str, Any]) -> None:
        """The only websocket writer: every frame goes through one lock."""
        async with self._ws_lock:
            await ws.send(json.dumps(payload))

    async def _on_frame(self, ws: Any, frame: dict[str, Any]) -> None:
        kind = frame.get("type")
        if kind == "hello":
            self._loop.mark_ready()
            return
        if kind == "disconnect":
            reason = str(frame.get("reason") or "")
            if reason == "link_disabled":
                raise ChannelAuthError("Socket Mode is disabled for this Slack app (link_disabled)")
            raise ReconnectNow(f"disconnect: {reason}")
        envelope_id = frame.get("envelope_id")
        if envelope_id:
            await self._ws_send(ws, {"envelope_id": envelope_id})
        payload = frame.get("payload") or {}
        if kind == "events_api":
            await self._on_event(payload.get("event") or {})
        elif kind == "interactive" and payload.get("type") == "block_actions":
            await self._on_block_action(payload)

    def _first_sighting(self, key: str) -> bool:
        if key in self._seen:
            return False
        self._seen[key] = None
        if len(self._seen) > DEDUP_SIZE:
            self._seen.popitem(last=False)
        return True

    async def _sender_name(self, user_id: str) -> str:
        if user_id in self._names:
            return self._names[user_id]
        name = user_id
        with contextlib.suppress(Exception):
            info = await self._call("users.info", token=self._bot_token, form={"user": user_id})
            user = info.get("user") or {}
            profile = user.get("profile") or {}
            name = str(profile.get("display_name") or user.get("real_name") or user.get("name") or user_id)
        self._names[user_id] = name
        return name

    async def _on_event(self, event: dict[str, Any]) -> None:
        if event.get("type") not in ("message", "app_mention"):
            return
        if str(event.get("subtype") or "") not in TEXT_SUBTYPES or event.get("bot_id"):
            return
        user = str(event.get("user") or "")
        channel = str(event.get("channel") or "")
        ts = str(event.get("ts") or "")
        if not user or user == self._user_id or not channel or not ts or self._emit is None:
            return
        if not self._first_sighting(f"{channel}:{ts}"):
            return
        thread_ts = str(event.get("thread_ts") or "")
        self._known[channel] = {"chat_id": channel, "title": channel,
                                "kind": str(event.get("channel_type") or ""), "supports_topics": True}
        self.status.last_inbound_at = time.time()
        await self._emit(InboundMessage(
            platform=self.platform, account=self.account, chat_id=channel, thread_id=thread_ts,
            sender_id=user, sender_name=await self._sender_name(user),
            text=str(event.get("text") or ""), message_id=f"{channel}:{ts}",
            is_direct=event.get("channel_type") == "im", ts=time.time(),
        ))

    async def _on_block_action(self, payload: dict[str, Any]) -> None:
        actions = payload.get("actions") or []
        user = payload.get("user") or {}
        channel = str((payload.get("channel") or {}).get("id") or "")
        if not actions or not channel or self._emit is None:
            return
        message = payload.get("message") or {}
        container = payload.get("container") or {}
        thread_ts = str(message.get("thread_ts") or container.get("thread_ts") or "")
        self.status.last_inbound_at = time.time()
        await self._emit(InboundMessage(
            platform=self.platform, account=self.account, chat_id=channel, thread_id=thread_ts,
            sender_id=str(user.get("id") or ""),
            sender_name=str(user.get("username") or user.get("name") or user.get("id") or ""),
            text="", message_id=f"action:{payload.get('trigger_id') or actions[0].get('action_ts', '')}",
            is_direct=channel.startswith("D"), ts=time.time(),
            callback_data=str(actions[0].get("value") or ""),
        ))

    def known_locations(self) -> list[dict[str, Any]]:
        """Chats seen so far, for the "use existing" picker."""
        return list(self._known.values())

    # --- outbound -------------------------------------------------------------

    def _base_body(self, loc: Location) -> dict[str, Any]:
        body: dict[str, Any] = {"channel": loc.chat_id}
        if loc.thread_id:
            body["thread_ts"] = loc.thread_id
        return body

    async def send_text(
        self, loc: Location, text: str, *, buttons: list[tuple[str, str]] | None = None
    ) -> list[str]:
        chunks = chunk_text(text, self.capabilities.text_limit) or [text or "…"]
        ids: list[str] = []
        for i, chunk in enumerate(chunks):
            body = {**self._base_body(loc), "text": chunk}
            last = i == len(chunks) - 1
            if buttons and last and len(chunk) <= SECTION_LIMIT:
                body["blocks"] = [
                    {"type": "section", "text": {"type": "mrkdwn", "text": chunk}},
                    self._actions_block(buttons),
                ]
            ids.append(str((await self._write("chat.postMessage", body)).get("ts") or ""))
            if buttons and last and len(chunk) > SECTION_LIMIT:
                extra = {**self._base_body(loc), "text": "…", "blocks": [self._actions_block(buttons)]}
                ids.append(str((await self._write("chat.postMessage", extra)).get("ts") or ""))
        return ids

    @staticmethod
    def _actions_block(buttons: list[tuple[str, str]]) -> dict[str, Any]:
        return {"type": "actions", "elements": [
            {"type": "button", "action_id": f"nv_{n}", "value": data[:2000],
             "text": {"type": "plain_text", "text": label[:75]}}
            for n, (label, data) in enumerate(buttons[:5])
        ]}

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        await self._write("chat.update", {"channel": loc.chat_id, "ts": message_id, "text": text[:EDIT_LIMIT]})

    async def send_typing(self, loc: Location) -> None:
        return None  # Slack exposes no bot typing indicator over Socket Mode / Web API.

    async def create_location(self, chat_id: str, title: str) -> Location:
        name = (title or "navide").strip() or "navide"
        root = await self._write("chat.postMessage", {"channel": chat_id, "text": f"🧵 {name}"})
        return Location(self.platform, self.account, chat_id, str(root.get("ts") or ""), name)


def create_adapter(config: dict[str, Any], secret: dict[str, Any], *, store: Any = None) -> SlackAdapter:
    app_token = str(secret.get("app_token") or "").strip()
    bot_token = str(secret.get("bot_token") or "").strip()
    if not app_token.startswith("xapp-"):
        raise ValueError("missing or invalid app-level token (xapp-...)")
    if not bot_token.startswith("xoxb-"):
        raise ValueError("missing or invalid bot token (xoxb-...)")
    return SlackAdapter(app_token, bot_token, account=str(config.get("account") or "default"))
