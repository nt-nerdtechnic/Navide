"""Shared types for chat-channel adapters (Telegram, Discord, Slack, ...).

Every adapter implements ``ChannelAdapter``. The manager owns the pipeline
(gate, pairing, bindings, delivery); an adapter only speaks its platform's
wire protocol and turns platform events into ``InboundMessage`` values.

Adapters own their receive loop: ``start()`` spawns an asyncio task and
returns, never blocking the event loop.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Literal, Protocol

Platform = Literal[
    "telegram", "discord", "slack", "feishu", "dingtalk", "matrix", "mattermost", "imessage"
]
Lifecycle = Literal["stopped", "starting", "ready", "recovering", "blocked"]

# Reconnect policy shared by every adapter (OpenClaw model).
RECONNECT_BASE_S = 30.0
RECONNECT_CAP_S = 600.0
RECONNECT_JITTER = 0.2
STALL_WATCHDOG_S = 120.0
RETRY_AFTER_CAP_S = 60.0


@dataclass(frozen=True)
class Location:
    """Where one pane lives on a platform."""

    platform: str
    account: str
    chat_id: str
    thread_id: str = ""
    title: str = ""

    def key(self) -> str:
        return f"{self.platform}:{self.account}:{self.chat_id}:{self.thread_id}"


@dataclass
class InboundMessage:
    platform: str
    account: str
    chat_id: str
    thread_id: str
    sender_id: str
    sender_name: str
    text: str
    message_id: str
    is_direct: bool
    ts: float
    # Button press payload (permission relay); empty for plain text.
    callback_data: str = ""

    def location_key(self) -> str:
        return Location(self.platform, self.account, self.chat_id, self.thread_id).key()


@dataclass
class AdapterStatus:
    lifecycle: Lifecycle = "stopped"
    connected: bool = False
    reconnect_attempts: int = 0
    last_error: str = ""
    last_connected_at: float | None = None
    last_inbound_at: float | None = None
    identity: str = ""  # e.g. "@navide_bot"


@dataclass(frozen=True)
class Capabilities:
    threads: bool
    create_location: bool
    edit: bool
    typing: bool
    buttons: bool
    text_limit: int


Emit = Callable[[InboundMessage], Awaitable[None]]


class ChannelAdapter(Protocol):
    platform: str
    capabilities: Capabilities
    status: AdapterStatus

    async def start(self, emit: Emit) -> None: ...

    async def stop(self) -> None: ...

    async def send_text(
        self, loc: Location, text: str, *, buttons: list[tuple[str, str]] | None = None
    ) -> list[str]:
        """Send ``text`` (already chunked or not) and return the message ids."""
        ...

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None: ...

    async def send_typing(self, loc: Location) -> None: ...

    async def create_location(self, chat_id: str, title: str) -> Location: ...

    def token_fingerprint(self) -> str:
        """sha256 hex of the credential, used by the manager's token lease."""
        ...


class ChannelAuthError(Exception):
    """The credential was rejected (401/403/404-on-token). Stop retrying."""


class ChannelSendError(Exception):
    """A send failed. ``retryable`` is true only when the request provably did not go out."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


def backoff_delay(attempt: int, rand: float) -> float:
    """Reconnect delay for ``attempt`` (1-based); ``rand`` in [0, 1) supplies jitter."""
    base = min(RECONNECT_BASE_S * (2 ** max(0, attempt - 1)), RECONNECT_CAP_S)
    return base * (1 - RECONNECT_JITTER + 2 * RECONNECT_JITTER * rand)
