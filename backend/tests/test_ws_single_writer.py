"""Single-writer invariant: only Session.send_json may touch the raw websocket.

The websockets protocol forbids concurrent writes on one connection — two
coroutines hitting drain() together trip its waiter assertion and wedge the
socket permanently (see the pitfall comment on Session._send_lock in app.py).
Session.send_json serializes every outbound frame behind that lock, so it must
stay the ONLY call site of a raw websocket send method. This test scans the
backend source and fails if a raw send appears anywhere else; new code must
route through session.send_json() instead.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parents[1] / "agent_team_backend"

RAW_SEND_RE = re.compile(r"\b(?:websocket|ws)\.send(?:_json|_text|_bytes)?\(")


def _session_send_json_span(source: str) -> tuple[int, int]:
    """Line span (inclusive) of the Session.send_json method body."""
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ClassDef) and node.name == "Session":
            for item in node.body:
                if (
                    isinstance(item, (ast.AsyncFunctionDef, ast.FunctionDef))
                    and item.name == "send_json"
                ):
                    return item.lineno, item.end_lineno or item.lineno
    raise AssertionError("Session.send_json not found in app.py")


def test_only_session_send_json_touches_the_raw_websocket() -> None:
    offenders: list[str] = []
    for path in sorted(PACKAGE_DIR.rglob("*.py")):
        source = path.read_text(encoding="utf-8")
        allowed_span = _session_send_json_span(source) if path.name == "app.py" else None
        for lineno, line in enumerate(source.splitlines(), start=1):
            if not RAW_SEND_RE.search(line):
                continue
            if allowed_span and allowed_span[0] <= lineno <= allowed_span[1]:
                continue
            offenders.append(f"{path.relative_to(PACKAGE_DIR)}:{lineno}: {line.strip()}")
    assert not offenders, (
        "Raw websocket send outside Session.send_json — route it through "
        "session.send_json() (single-writer invariant):\n" + "\n".join(offenders)
    )
