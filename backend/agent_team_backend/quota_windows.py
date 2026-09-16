"""Quota window lengths per vendor, for turning a usage snapshot's
``resetsAt`` into a cycle's start (``started_at = resets_at - length``).

Only fixed-length windows are listed. A monthly / billing-cycle window
(copilot, grok, cursor, qwen monthly, kilo period…) has no fixed length: its
cycle starts where the previous cycle's ``resetsAt`` sample ended, and when
no such sample exists ``started_at`` is None.

A codex window carries its own ``windowMinutes`` (the API states
``limit_window_seconds``); that value wins over this table when present.
"""

from __future__ import annotations

_HOUR = 3600
_DAY = 86400

WINDOW_SECONDS: dict[str, dict[str, int]] = {
    "claude": {"session": 5 * _HOUR, "weekly": 7 * _DAY, "weekly-model": 7 * _DAY},
    "codex": {"session": 5 * _HOUR, "primary": 5 * _HOUR,
              "weekly": 7 * _DAY, "secondary": 7 * _DAY},
    "kimi": {"session": 5 * _HOUR, "weekly": 7 * _DAY},
    "opencode": {"session": 5 * _HOUR, "weekly": 7 * _DAY},
    "qwen": {"session": 5 * _HOUR, "weekly": 7 * _DAY},
    "antigravity": {"session": 5 * _HOUR, "weekly": 7 * _DAY},
    "pi": {"session": 5 * _HOUR, "weekly": 7 * _DAY},
}


def window_seconds(agent_key: str, window_kind: str, window_minutes: object = None) -> int | None:
    """Fixed length of ``(agent_key, window_kind)`` in seconds, or None for a
    calendar / billing window whose start must come from the previous sample."""
    if isinstance(window_minutes, (int, float)) and not isinstance(window_minutes, bool) \
            and window_minutes > 0:
        return int(window_minutes) * 60
    # "weekly-model:<label>" (several per-model windows in one snapshot) shares
    # the base kind's length.
    base = window_kind.split(":", 1)[0]
    return WINDOW_SECONDS.get(agent_key, {}).get(base)
