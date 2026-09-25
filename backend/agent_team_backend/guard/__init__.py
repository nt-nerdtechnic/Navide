"""Navide Guard: deterministic danger judgement of CLI tool calls.

Public API (GUARD-CONTRACT.md) — other packages import only these names.
"""

from __future__ import annotations

from typing import Literal

from .classify import Verdict, classify, classify_prompt_text
from .engine import Decision, evaluate
from .taint import clear_taint, is_tainted, mark_tainted

Level = Literal["normal", "high", "critical"]
Source = Literal["local", "relay", "remote", "agent"]
Action = Literal["allow", "ask", "deny"]

__all__ = [
    "Action", "Decision", "Level", "Source", "Verdict", "classify", "classify_prompt_text",
    "clear_taint", "evaluate", "is_tainted", "mark_tainted",
]
