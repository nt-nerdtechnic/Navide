"""Level x source (x taint) -> allow / ask / deny.

Pure and deterministic; the matrix is the approved plan's decision table
(Phase 0 decisions recorded in GUARD-CONTRACT.md):

| source \\ level           | critical | high             | normal |
|--------------------------|----------|------------------|--------|
| local                    | ask      | allow (+audit)   | allow  |
| relay (chat approval)    | deny     | deny (need local)| allow  |
| remote / agent           | ask      | allow (+audit)   | allow  |
| tainted pane, any source | ask      | ask              | allow  |

Relay wins over taint: a chat approval can never become "ask", because the
person answering is not at the computer. The relay row also holds while the
Guard switch is off (see enforced()). Unparseable commands count as
"high" on a tainted pane.
"""

from __future__ import annotations

import fnmatch

from .classify import LEVEL_ORDER

_MATRIX = {
    "local": {"critical": "ask", "high": "allow", "normal": "allow"},
    "relay": {"critical": "deny", "high": "deny", "normal": "allow"},
    "remote": {"critical": "ask", "high": "allow", "normal": "allow"},
    "agent": {"critical": "ask", "high": "allow", "normal": "allow"},
}


def effective_level(level: str, *, parseable: bool, tainted: bool) -> str:
    if tainted and not parseable and LEVEL_ORDER[level] < LEVEL_ORDER["high"]:
        return "high"
    return level


def enforced(enabled: bool, source: str) -> bool:
    """Whether the matrix applies. The Guard switch turns it off everywhere
    except the chat relay: approving a high/critical action from chat always
    needs someone at the computer, whatever the switch says."""
    return enabled or source == "relay"


def decide(level: str, source: str, *, tainted: bool) -> str:
    row = _MATRIX.get(source, _MATRIX["agent"])
    action = row[level]
    if source != "relay" and tainted and level in ("high", "critical"):
        return "ask"
    return action


def pattern_matches(pattern: str, subject: str) -> bool:
    """Glob when the pattern has glob characters, otherwise substring."""
    pattern = (pattern or "").strip()
    if not pattern or not subject:
        return False
    if any(ch in pattern for ch in "*?["):
        return fnmatch.fnmatchcase(subject, pattern)
    return pattern in subject


def apply_user_rules(level: str, rule_ids: tuple[str, ...], subject: str, rules: list[dict]) -> tuple[str, tuple[str, ...]]:
    """Deny patterns force critical; allow patterns lower high to normal
    (never critical — a critical action always needs a human)."""
    for r in rules:
        if r.get("kind") == "deny" and pattern_matches(r.get("pattern", ""), subject):
            return "critical", rule_ids + (f"user-deny:{r.get('id')}",)
    if level == "high":
        for r in rules:
            if r.get("kind") == "allow" and pattern_matches(r.get("pattern", ""), subject):
                return "normal", rule_ids + (f"user-allow:{r.get('id')}",)
    return level, rule_ids
