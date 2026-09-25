"""Sender gate: pairing codes and the per-platform allowlist.

Two layers (OpenClaw): the chat id says *where* a pane lives, the sender id says
*who* may talk to it. Only the sender id is gated here; group membership never
grants access. An unknown sender in a DM gets a pairing code the user approves
in Settings; an unknown sender in a group is dropped silently.

Codes: 8 chars from an alphabet without look-alikes, ``secrets`` module,
expire after an hour, at most 3 pending per platform.
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass

from .store import ChannelStore, PairingRequest

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
CODE_TTL_S = 3600
MAX_PENDING = 3


def new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def normalize_code(code: str) -> str:
    return "".join(ch for ch in (code or "").upper() if ch.isalnum())


@dataclass
class PairingOutcome:
    """Result of an unknown DM sender knocking."""

    request: PairingRequest | None
    created: bool  # False: an existing pending code was reused
    full: bool = False  # True: the platform already has MAX_PENDING pending codes


class SenderGate:
    def __init__(self, store: ChannelStore, *, now=time.time) -> None:
        self._store = store
        self._now = now

    def is_allowed(self, platform: str, sender_id: str) -> bool:
        return bool(sender_id) and self._store.is_allowed(platform, sender_id)

    def prune(self) -> None:
        self._store.delete_pairing_older_than(self._now() - CODE_TTL_S)

    def request_pairing(self, platform: str, sender_id: str, sender_name: str, chat_id: str) -> PairingOutcome:
        self.prune()
        pending = self._store.list_pairing(platform)
        for req in pending:
            if req.sender_id == sender_id:
                return PairingOutcome(req, created=False)
        if len(pending) >= MAX_PENDING:
            return PairingOutcome(None, created=False, full=True)
        existing = {r.code for r in self._store.list_pairing(None)}
        code = new_code()
        while code in existing:
            code = new_code()
        req = PairingRequest(platform, code, sender_id, sender_name, chat_id, int(self._now()))
        self._store.add_pairing(req)
        return PairingOutcome(req, created=True)

    def approve(self, platform: str, code: str) -> PairingRequest | None:
        self.prune()
        req = self._store.pop_pairing(platform, normalize_code(code))
        if req is None:
            return None
        self._store.add_allow(platform, req.sender_id, req.sender_name, int(self._now()))
        return req

    def reject(self, platform: str, code: str) -> PairingRequest | None:
        return self._store.pop_pairing(platform, normalize_code(code))
