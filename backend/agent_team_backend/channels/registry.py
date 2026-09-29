"""The chat-platform registry — one entry per platform, one line to register.

Adding a platform: create ``<id>.py`` from ``_template.py``, then add its id to
``PLATFORMS`` below and to ``hiddenimports`` in ``backend/agent_team_backend.spec``
(``test_pyinstaller_spec.py`` fails when they drift). ``test_channels_registry.py``
checks that every id imports and exposes a usable adapter.

Modules are imported lazily (``load_module``): a platform whose optional
dependency is missing degrades to "not available" instead of breaking every
other platform at import time. The tuple order is the display order and must
match the renderer registry in ``src/renderer/src/platform/channels/index.ts``.
"""

from __future__ import annotations

import importlib
from types import ModuleType

PLATFORMS: tuple[str, ...] = (
    "telegram",
    "discord",
    "slack",
    "feishu",
    "dingtalk",
    "matrix",
    "mattermost",
    "imessage",
)


def is_platform(platform: str) -> bool:
    return platform in PLATFORMS


def load_module(platform: str) -> ModuleType | None:
    """The adapter module of a registered platform, or None if unknown or not importable."""
    if platform not in PLATFORMS:
        return None
    try:
        return importlib.import_module(f"{__package__}.{platform}")
    except ImportError:
        return None
