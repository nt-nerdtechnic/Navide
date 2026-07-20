"""No-op backend entry: proves the plugin lifecycle runs end to end.

The host imports this module, then calls ``activate(context)`` and
``deactivate()`` at the matching lifecycle points. Both hooks only record that
they ran (and capture the context) -- no real work, no capabilities used.

State lives on the module object; the host imports a fresh module instance per
load, so these lists start empty for each loaded plugin.
"""

from __future__ import annotations

from typing import Any

# Records of lifecycle calls, for tests / introspection.
calls: list[str] = []
received_context: Any = None


def activate(context: Any) -> None:
    global received_context
    received_context = context
    calls.append("activate")


def deactivate() -> None:
    calls.append("deactivate")
