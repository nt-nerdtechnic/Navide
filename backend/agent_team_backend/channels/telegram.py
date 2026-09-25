"""Telegram adapter: Bot API ``getUpdates`` long polling (reference implementation).

Receive loop (OpenClaw polling-session.ts):
- ``deleteWebhook`` first (``drop_pending_updates=false``) — getUpdates is refused
  while a webhook is set.
- The update offset is persisted per bot id; a stored offset for a different bot
  id (token changed) is discarded.
- 409 means another consumer is polling the same bot (e.g. Claude Code
  ``--channels``): report it and back off, never crash.
- 401/404 mean the token is dead: lifecycle ``blocked``, stop retrying.
- 429 honours ``retry_after`` capped at 60s.
- A getUpdates call that does not finish within the stall watchdog restarts.

Sends are not idempotent: they are retried only on 429 or when the connection
provably never carried the request (connect errors).

Forum topics are pane locations. The General topic (id 1) must be addressed
without ``message_thread_id``, and its inbound messages carry no topic flag, so
it maps to ``thread_id == ""``.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import random
import time
from typing import Any, Callable, Protocol
from urllib.parse import urlsplit

import httpx

from .base import (
    RETRY_AFTER_CAP_S,
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
from . import redact
from .adapter_runtime import cancel_and_wait
from .text import TEXT_LIMITS, chunk_text, is_telegram_parse_error, markdown_to_telegram_html

log = logging.getLogger(__name__)
# httpx logs every request URL at INFO, and the Bot API puts the token in the URL.
redact.install()

DEFAULT_BASE_URL = "https://api.telegram.org"
POLL_TIMEOUT_S = 30
GENERAL_TOPIC_ID = "1"
SEND_CONNECT_RETRIES = 2


class OffsetStore(Protocol):
    def get_offset(self, platform: str, account: str, bot_id: str) -> int | None: ...

    def set_offset(self, platform: str, account: str, bot_id: str, offset: int) -> None: ...


class TelegramApiError(Exception):
    def __init__(self, code: int, description: str, retry_after: float | None = None) -> None:
        super().__init__(f"{code}: {description}")
        self.code = code
        self.description = description
        self.retry_after = retry_after


class TelegramAdapter:
    platform = "telegram"
    capabilities = Capabilities(
        threads=True, create_location=True, edit=True, typing=True, buttons=True,
        text_limit=TEXT_LIMITS["telegram"],
    )

    def __init__(
        self,
        token: str,
        *,
        account: str = "default",
        base_url: str = DEFAULT_BASE_URL,
        offset_store: OffsetStore | None = None,
        backoff: Callable[[int, float], float] = backoff_delay,
        stall_timeout_s: float = STALL_WATCHDOG_S,
        poll_timeout_s: int = POLL_TIMEOUT_S,
    ) -> None:
        self._token = token.strip()
        redact.add_secret(self._token)
        self.account = account
        self._base = f"{base_url.rstrip('/')}/bot{self._token}"
        self._offsets = offset_store
        self._backoff = backoff
        self._stall_timeout_s = stall_timeout_s
        self._poll_timeout_s = poll_timeout_s
        self.status = AdapterStatus()
        self.bot_id = self._token.split(":", 1)[0]
        self._client: httpx.AsyncClient | None = None
        self._task: asyncio.Task[None] | None = None
        self._emit: Emit | None = None
        self._offset: int | None = None
        # chat_id -> {chat_id, title, kind, supports_topics}; feeds the "existing chat" picker.
        self._known_chats: dict[str, dict[str, Any]] = {}

    # --- lifecycle ------------------------------------------------------------

    def token_fingerprint(self) -> str:
        return hashlib.sha256(self._token.encode()).hexdigest()

    async def start(self, emit: Emit) -> None:
        if self._task and not self._task.done():
            return
        self._emit = emit
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(20.0, read=self._poll_timeout_s + 15.0))
        self.status.lifecycle = "starting"
        self.status.last_error = ""
        self._task = asyncio.create_task(self._run(), name="channels-telegram")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task:
            await cancel_and_wait(task)
        if self._client:
            await self._client.aclose()
            self._client = None
        self.status.lifecycle = "stopped"
        self.status.connected = False

    async def _run(self) -> None:
        attempt = 0
        while True:
            try:
                await self._session()
                return
            except asyncio.CancelledError:
                raise
            except ChannelAuthError as exc:
                self.status.lifecycle = "blocked"
                self.status.connected = False
                self.status.last_error = str(exc)
                log.warning("telegram: token rejected, polling stopped: %s", exc)
                return
            except Exception as exc:  # noqa: BLE001 — every other failure is transient
                attempt += 1
                self.status.lifecycle = "recovering"
                self.status.connected = False
                self.status.reconnect_attempts = attempt
                self.status.last_error = self._redact(_describe_failure(exc))
                delay = self._backoff(attempt, random.random())
                log.info("telegram: poll failed (%s); retry in %.1fs", self.status.last_error, delay)
                await asyncio.sleep(delay)

    async def _session(self) -> None:
        me = await self._call("getMe")
        username = me.get("username") or ""
        self.status.identity = f"@{username}" if username else str(me.get("id", ""))
        if me.get("id"):
            self.bot_id = str(me["id"])
        await self._call("deleteWebhook", {"drop_pending_updates": False})
        if self._offsets is not None:
            self._offset = self._offsets.get_offset(self.platform, self.account, self.bot_id)
        self.status.lifecycle = "ready"
        self.status.connected = True
        self.status.last_connected_at = time.time()
        while True:
            params: dict[str, Any] = {
                "timeout": self._poll_timeout_s,
                "allowed_updates": ["message", "callback_query"],
            }
            if self._offset is not None:
                params["offset"] = self._offset
            try:
                updates = await asyncio.wait_for(
                    self._call("getUpdates", params), timeout=self._stall_timeout_s
                )
            except asyncio.TimeoutError as exc:
                raise RuntimeError("getUpdates stalled; restarting") from exc
            self.status.lifecycle = "ready"
            self.status.connected = True
            self.status.reconnect_attempts = 0
            self.status.last_error = ""
            for update in updates or []:
                uid = int(update.get("update_id", 0))
                try:
                    await self._handle_update(update)
                except Exception:  # noqa: BLE001 — one bad update must not stop polling
                    log.exception("telegram: update %s failed", uid)
                self._offset = uid + 1
                if self._offsets is not None:
                    self._offsets.set_offset(self.platform, self.account, self.bot_id, self._offset)

    # --- inbound --------------------------------------------------------------

    async def _handle_update(self, update: dict[str, Any]) -> None:
        cb = update.get("callback_query")
        if cb:
            msg = cb.get("message") or {}
            chat = msg.get("chat") or {}
            self._remember_chat(chat)
            try:
                await self._call("answerCallbackQuery", {"callback_query_id": cb.get("id")})
            except Exception:  # noqa: BLE001 — cosmetic (stops the button spinner)
                pass
            await self._deliver(
                chat=chat, sender=cb.get("from") or {}, text="", thread=_thread_of(msg),
                message_id=f"cb:{cb.get('id')}", ts=time.time(),
                callback_data=str(cb.get("data") or ""),
            )
            return
        msg = update.get("message")
        if not msg:
            return
        chat = msg.get("chat") or {}
        self._remember_chat(chat)
        text = msg.get("text") or msg.get("caption") or ""
        if not text or (msg.get("from") or {}).get("is_bot"):
            return
        await self._deliver(
            chat=chat, sender=msg.get("from") or {}, text=text, thread=_thread_of(msg),
            message_id=f"{chat.get('id')}:{msg.get('message_id')}",
            ts=float(msg.get("date") or time.time()),
        )

    async def _deliver(
        self, *, chat: dict[str, Any], sender: dict[str, Any], text: str, thread: str,
        message_id: str, ts: float, callback_data: str = "",
    ) -> None:
        self.status.last_inbound_at = time.time()
        if self._emit is None:
            return
        name = sender.get("username") or " ".join(
            p for p in (sender.get("first_name"), sender.get("last_name")) if p
        ) or str(sender.get("id", ""))
        await self._emit(InboundMessage(
            platform=self.platform, account=self.account, chat_id=str(chat.get("id", "")),
            thread_id=thread, sender_id=str(sender.get("id", "")), sender_name=name,
            text=text, message_id=message_id, is_direct=chat.get("type") == "private", ts=ts,
            callback_data=callback_data,
        ))

    def _remember_chat(self, chat: dict[str, Any]) -> None:
        cid = chat.get("id")
        if cid is None:
            return
        title = chat.get("title") or chat.get("username") or chat.get("first_name") or str(cid)
        self._known_chats[str(cid)] = {
            "chat_id": str(cid), "title": title, "kind": chat.get("type") or "",
            "supports_topics": bool(chat.get("is_forum")),
        }

    def known_locations(self) -> list[dict[str, Any]]:
        return list(self._known_chats.values())

    # --- outbound -------------------------------------------------------------

    def _target(self, loc: Location) -> dict[str, Any]:
        params: dict[str, Any] = {"chat_id": loc.chat_id}
        if loc.thread_id and loc.thread_id != GENERAL_TOPIC_ID:
            params["message_thread_id"] = int(loc.thread_id)
        return params

    async def send_text(
        self, loc: Location, text: str, *, buttons: list[tuple[str, str]] | None = None
    ) -> list[str]:
        ids: list[str] = []
        chunks = chunk_text(text, self.capabilities.text_limit) or [text or "…"]
        for i, chunk in enumerate(chunks):
            params = self._target(loc)
            if buttons and i == len(chunks) - 1:
                params["reply_markup"] = {
                    "inline_keyboard": [[{"text": label, "callback_data": data} for label, data in buttons]]
                }
            result = await self._send_rich("sendMessage", params, chunk)
            ids.append(str(result.get("message_id", "")))
        return ids

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        params = {"chat_id": loc.chat_id, "message_id": int(message_id)}
        text = text[: self.capabilities.text_limit]
        try:
            await self._send_rich("editMessageText", params, text)
        except ChannelSendError as exc:
            if "message is not modified" in str(exc).lower():
                return
            raise

    async def send_typing(self, loc: Location) -> None:
        await self._send_call("sendChatAction", {**self._target(loc), "action": "typing"})

    async def create_location(self, chat_id: str, title: str) -> Location:
        try:
            result = await self._send_call(
                "createForumTopic", {"chat_id": chat_id, "name": (title or "Navide")[:128]}
            )
        except ChannelSendError as exc:
            low = str(exc).lower()
            if "not enough rights" in low or "not_enough_rights" in low:
                raise ChannelSendError(
                    "bot 需要是群組管理員並有「管理主題」權限 (not enough rights to create a topic)"
                ) from exc
            if "not a forum" in low:
                raise ChannelSendError("這個群組沒有開啟主題功能 (the chat is not a forum)") from exc
            raise
        thread = str(result.get("message_thread_id", ""))
        return Location(self.platform, self.account, str(chat_id), thread, result.get("name") or title)

    async def _send_rich(self, method: str, params: dict[str, Any], markdown: str) -> dict[str, Any]:
        """Send as HTML; on a markup parse error resend the plain text."""
        try:
            return await self._send_call(
                method, {**params, "text": markdown_to_telegram_html(markdown), "parse_mode": "HTML"}
            )
        except ChannelSendError as exc:
            if not is_telegram_parse_error(str(exc)):
                raise
            return await self._send_call(method, {**params, "text": markdown})

    async def _send_call(self, method: str, params: dict[str, Any]) -> Any:
        connect_failures = 0
        while True:
            try:
                return await self._call(method, params)
            except TelegramApiError as exc:
                if exc.code == 429:
                    await asyncio.sleep(min(exc.retry_after or 1.0, RETRY_AFTER_CAP_S))
                    continue
                raise ChannelSendError(exc.description, retryable=False) from exc
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                # The request never left: safe to retry.
                connect_failures += 1
                if connect_failures > SEND_CONNECT_RETRIES:
                    raise ChannelSendError(self._redact(f"connect failed: {exc}"), retryable=True) from exc
                await asyncio.sleep(0.5 * connect_failures)
            except ChannelAuthError as exc:
                raise ChannelSendError(str(exc)) from exc
            except httpx.HTTPError as exc:
                raise ChannelSendError(self._redact(f"{type(exc).__name__}: {exc}")) from exc

    # --- transport ------------------------------------------------------------

    def _redact(self, text: str) -> str:
        # The token is part of every request URL; keep it out of status and logs.
        return text.replace(self._token, "***") if self._token else text

    async def _call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        client = self._client
        own = client is None
        if own:
            client = httpx.AsyncClient(timeout=20.0)
        try:
            resp = await client.post(f"{self._base}/{method}", json=params or {})
        finally:
            if own:
                await client.aclose()
        try:
            body = resp.json()
        except ValueError:
            body = {"ok": False, "error_code": resp.status_code, "description": resp.text[:200]}
        if body.get("ok"):
            return body.get("result")
        code = int(body.get("error_code") or resp.status_code)
        desc = str(body.get("description") or f"HTTP {resp.status_code}")
        if code in (401, 404) or (code == 403 and method in ("getMe", "getUpdates")):
            raise ChannelAuthError(f"Telegram rejected the bot token ({code}: {desc})")
        retry_after = (body.get("parameters") or {}).get("retry_after")
        err = TelegramApiError(code, desc, float(retry_after) if retry_after is not None else None)
        if code == 429 and method == "getUpdates":
            await asyncio.sleep(min(err.retry_after or 1.0, RETRY_AFTER_CAP_S))
            return []
        raise err


def create_adapter(config: dict[str, Any], secret: dict[str, Any], *, store: OffsetStore | None = None) -> TelegramAdapter:
    token = str(secret.get("token") or "").strip()
    if not token:
        raise ValueError("missing bot token")
    # A self-hosted Bot API server (https://github.com/tdlib/telegram-bot-api) may replace the public one.
    base_url = str(config.get("api_base") or "").strip() or DEFAULT_BASE_URL
    parsed = urlsplit(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"api_base must be an http(s) URL, got {base_url!r}")
    return TelegramAdapter(
        token, account=str(config.get("account") or "default"), base_url=base_url, offset_store=store
    )


def _thread_of(msg: dict[str, Any]) -> str:
    # Only forum topic messages carry a meaningful thread; General (id 1) has no flag.
    if msg.get("is_topic_message") and msg.get("message_thread_id") is not None:
        return str(msg["message_thread_id"])
    return ""


def _describe_failure(exc: Exception) -> str:
    if isinstance(exc, TelegramApiError) and exc.code == 409:
        return "另一個程式也在用這個 bot（409 Conflict: another getUpdates consumer）"
    return f"{type(exc).__name__}: {exc}"
