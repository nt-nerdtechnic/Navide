"""Permission / question relay (Phase F): answer a pane's awaiting prompt from chat.

On by default per platform; ``permission_relay: false`` turns it off. A request id is 5
letters a-z without ``l`` (Claude Code channels format) and is single-use: it
expires when answered, when the pane leaves awaiting, or after 30 minutes.

Answers: ``yes <id>`` / ``no <id>`` (also ``y`` / ``n``) for a permission,
``<n> <id>`` for a question option, or a button whose callback data is
``nv1:<id>:<choice>`` (choice ``y`` / ``n`` / ``1``..``9``, well under
Telegram's 64-byte limit).
"""

from __future__ import annotations

import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from .base import Location

ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz"
ID_LENGTH = 5
REQUEST_TTL_S = 1800.0
MAX_BUTTON_OPTIONS = 9
CALLBACK_PREFIX = "nv1:"

_TEXT_ANSWER_RE = re.compile(rf"^\s*(yes|y|no|n|[1-9])\s+([{ID_ALPHABET}]{{{ID_LENGTH}}})\s*$", re.IGNORECASE)
_CALLBACK_RE = re.compile(rf"^nv1:([{ID_ALPHABET}]{{{ID_LENGTH}}}):(y|n|[1-9])$")


def new_request_id() -> str:
    return "".join(secrets.choice(ID_ALPHABET) for _ in range(ID_LENGTH))


@dataclass
class RelayRequest:
    id: str
    pane_id: str
    kind: str  # "permission" | "question"
    options: list[str]
    loc: Location
    created: float = field(default_factory=time.monotonic)


@dataclass(frozen=True)
class RelayAnswer:
    request_id: str
    choice: str  # "y" | "n" | "1".."9"


def parse_answer(text: str, callback_data: str) -> RelayAnswer | None:
    """A relay answer in a chat message or button press, or None for ordinary text."""
    if callback_data:
        m = _CALLBACK_RE.match(callback_data)
        return RelayAnswer(m.group(1), m.group(2)) if m else None
    m = _TEXT_ANSWER_RE.match(text or "")
    if not m:
        return None
    word = m.group(1).lower()
    choice = "y" if word in ("yes", "y") else "n" if word in ("no", "n") else word
    return RelayAnswer(m.group(2).lower(), choice)


def answer_payload(request: RelayRequest, choice: str) -> dict[str, Any] | None:
    """The ``ui.pane.sendKeys`` answer for ``choice``, or None if it does not fit the request."""
    if request.kind == "permission" and choice in ("y", "n"):
        return {"kind": "permission", "choice": "allow" if choice == "y" else "deny"}
    if request.kind == "question" and choice.isdigit():
        n = int(choice)
        if request.options and n > len(request.options):
            return None
        return {"kind": "question", "option": n}
    return None


def describe_answer(answer: dict[str, Any]) -> str:
    if answer["kind"] == "permission":
        return "允許" if answer["choice"] == "allow" else "拒絕"
    return f"選項 {answer['option']}"


def prompt_text(request: RelayRequest, prompt: str) -> str:
    lines = [f"⏸ pane 需要確認（{request.kind}）"]
    if prompt.strip():
        lines.append(prompt.strip())
    if request.kind == "question":
        for i, opt in enumerate(request.options[:MAX_BUTTON_OPTIONS], 1):
            lines.append(f"{i}. {opt}")
        lines.append(f"回覆 <選項編號> {request.id}")
    else:
        lines.append(f"回覆 yes {request.id} / no {request.id}")
    return "\n".join(lines)


def buttons_for(request: RelayRequest) -> list[tuple[str, str]]:
    if request.kind == "permission":
        return [("允許", f"{CALLBACK_PREFIX}{request.id}:y"), ("拒絕", f"{CALLBACK_PREFIX}{request.id}:n")]
    return [(f"{i}. {opt}"[:40], f"{CALLBACK_PREFIX}{request.id}:{i}")
            for i, opt in enumerate(request.options[:MAX_BUTTON_OPTIONS], 1)]


class RelayTable:
    def __init__(self, *, clock=time.monotonic) -> None:
        self._clock = clock
        self._by_id: dict[str, RelayRequest] = {}

    def create(self, pane_id: str, kind: str, options: list[str], loc: Location) -> RelayRequest:
        self.prune()
        rid = new_request_id()
        while rid in self._by_id:
            rid = new_request_id()
        req = RelayRequest(rid, pane_id, kind, list(options), loc, self._clock())
        self._by_id[rid] = req
        return req

    def take(self, request_id: str) -> RelayRequest | None:
        """Single use: the request is gone once taken."""
        self.prune()
        return self._by_id.pop(request_id, None)

    def expire_pane(self, pane_id: str) -> None:
        for rid, req in list(self._by_id.items()):
            if req.pane_id == pane_id:
                del self._by_id[rid]

    def prune(self) -> None:
        cutoff = self._clock() - REQUEST_TTL_S
        for rid, req in list(self._by_id.items()):
            if req.created < cutoff:
                del self._by_id[rid]

    def for_pane(self, pane_id: str) -> list[RelayRequest]:
        return [r for r in self._by_id.values() if r.pane_id == pane_id]
