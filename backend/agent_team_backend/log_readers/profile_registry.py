"""Process-global registry of active CLI-profile config homes.

Phase B moves a profile pane's config home out of the default location into
``~/.navide/cli-profiles/<agentKey>/<profileId>`` (claude → CLAUDE_CONFIG_DIR,
kimi → KIMI_CODE_HOME, grok → a HOME shim whose real ``.grok`` lives inside).
The log readers are stateless singletons that scan only the *default* roots, so
without knowing the active profile homes they would silently miss a profile
pane's sessions (token accounting, RUNNING detection, resume all break).

This registry is the single source of truth for "which profile homes are live
this run". It is populated lazily when a profile pane spawns and consulted by
the readers to extend their scan/watch roots. Only homes with an actual pane
this session are tracked, so a user's accumulated (persistent) profiles are not
all scanned/watched at once. Entries are kept for the process lifetime — a home
that ran once keeps its stats/resume working even after its pane closes; the set
stays tiny so there is nothing to reclaim.

``home`` is the profile home directory (``CliProfilesStore.home_path``); each
reader derives its own vendor-specific session subdir from it.
"""

from __future__ import annotations

import threading
from pathlib import Path

_lock = threading.Lock()
# agent_key -> {profile_id: home_path}
_homes: dict[str, dict[str, Path]] = {}


def register_profile_home(agent_key: str, profile_id: str, home: Path | str) -> None:
    """Record a profile's config home as active. Idempotent."""
    if not agent_key or not profile_id:
        return
    with _lock:
        _homes.setdefault(agent_key, {})[profile_id] = Path(home)


def profile_homes(agent_key: str) -> list[Path]:
    """Active config homes for ``agent_key`` (empty when no profile pane ran)."""
    with _lock:
        return list(_homes.get(agent_key, {}).values())


def clear_profile_homes() -> None:
    """Drop all registrations — test isolation only (process-global state)."""
    with _lock:
        _homes.clear()
