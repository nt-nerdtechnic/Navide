"""Example backend that actually uses a granted capability.

Declares ``requires: ["fs"]`` in its manifest, so on activation the host hands
it an ``fs`` capability in ``context.capabilities``. This proves the end-to-end
path: manifest -> host grant -> capability -> core service.

The plugin does not know a workspace to read at activation time, so it stashes
the capability and exposes ``read(...)`` for a caller (or test) to drive one
real delegation through it.
"""

from __future__ import annotations

from typing import Any

# Records / handles for tests and introspection.
fs: Any = None
declared_capabilities: list[str] = []


def activate(context: Any) -> None:
    global fs
    declared_capabilities.extend(sorted(context.capabilities))
    # Present because the manifest declared requires: ["fs"].
    fs = context.capabilities["fs"]


def read(workspace_path: str, rel_path: str) -> dict[str, Any]:
    if fs is None:
        raise RuntimeError("plugin not activated: fs capability unavailable")
    return fs.read_file(workspace_path, rel_path)
