"""CONTRIBUTOR TEMPLATE — copy to ``<id>.py`` and fill in.

Files starting with ``_`` are ignored by the registry and its tests. Steps to
add a chat platform (full guide: ``docs/adding-a-chat-channel.md``):

1. Copy this file to ``<id>.py`` (short lowercase id, e.g. ``mychat``).
2. Rename ``TemplateAdapter`` to ``<Id>Adapter`` (``id.capitalize()`` + "Adapter")
   or keep the class name and return it from ``create_adapter`` — the manager
   prefers ``create_adapter`` when the module defines it.
3. Add the id to ``PLATFORMS`` in ``registry.py`` (one line) and to
   ``hiddenimports`` in ``backend/agent_team_backend.spec``.
4. Add ``"<id>"`` to ``Platform`` in ``base.py`` and a ``TEXT_LIMITS`` entry.
5. Add the renderer spec ``src/renderer/src/platform/channels/<id>.ts`` and
   register it in ``channels/index.ts``.
6. Add ``backend/tests/test_channels_<id>.py`` (fake transport, no real network)
   and run ``uv --project backend run pytest backend/tests -k "channels or pyinstaller"``.

Import rules: only ``base``, ``redact``, ``text``, ``adapter_runtime``, the
standard library, ``httpx`` and ``websockets``. Never import another platform
module or ``manager``.
"""

from __future__ import annotations

import hashlib
from typing import Any

from . import redact
from .base import AdapterStatus, Capabilities, Emit, InboundMessage, Location  # noqa: F401
from .text import TEXT_LIMITS


class TemplateAdapter:
    platform = "_template"  # must equal the module filename / registry id
    capabilities = Capabilities(
        threads=False,          # can a chat hold several panes as threads/topics?
        create_location=False,  # can the app create a new chat/thread on demand?
        edit=False,             # can a sent message be edited (live status line)?
        typing=False,           # is there a typing indicator?
        buttons=False,          # inline buttons (approval relay)?
        text_limit=TEXT_LIMITS.get("_template", 4000),  # add your id to text.TEXT_LIMITS
    )

    def __init__(self, token: str, *, account: str = "default") -> None:
        self._token = token.strip()
        redact.add_secret(self._token)  # keep the credential out of logs
        self.account = account          # the manager reads this via getattr
        self.status = AdapterStatus()

    # --- lifecycle ------------------------------------------------------------

    async def start(self, emit: Emit) -> None:
        """Connect and begin delivering ``InboundMessage`` to ``emit``; keep
        ``self.status`` current (lifecycle, connected, last_error, identity)."""
        raise NotImplementedError

    async def stop(self) -> None:
        raise NotImplementedError

    # --- outbound -------------------------------------------------------------

    async def send_text(
        self, loc: Location, text: str, *, buttons: list[tuple[str, str]] | None = None
    ) -> list[str]:
        """Send ``text`` and return the platform message ids. Raise
        ``ChannelSendError(retryable=True)`` only if the request provably did not go out."""
        raise NotImplementedError

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        raise NotImplementedError

    async def send_typing(self, loc: Location) -> None:
        raise NotImplementedError

    async def create_location(self, chat_id: str, title: str) -> Location:
        raise NotImplementedError

    def token_fingerprint(self) -> str:
        """sha256 hex of the credential; the manager's token lease is keyed on it."""
        return hashlib.sha256(self._token.encode()).hexdigest()

    # --- optional hooks the manager probes with getattr/callable ------------------

    def link_url(self, code: str, target: str) -> str:
        """Deep link that sends the pairing ``code`` (``target`` is "dm" or "group");
        return "" when the platform has none. Omit the method entirely if unsupported."""
        return ""

    def known_locations(self) -> list[dict[str, Any]]:
        """Chats the bot has seen, as ``{"chat_id", "title", ...}`` dicts; feeds the
        "existing chat" picker and pane titles. Omit if unsupported."""
        return []


def create_adapter(config: dict[str, Any], secret: dict[str, Any], *, store: Any = None) -> TemplateAdapter:
    """Factory the manager calls: ``config`` is the non-secret settings dict, ``secret`` the
    vault entry, ``store`` the ChannelStore (for persisted offsets/cursors)."""
    token = secret.get("token")
    if not token:
        raise ValueError("missing token")
    return TemplateAdapter(token, account=str(config.get("account") or "default"))
