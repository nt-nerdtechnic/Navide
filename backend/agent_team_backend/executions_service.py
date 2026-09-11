"""Read and manage the machine's registered background executions.

A façade over `osplat.scheduler`, kept so the WebSocket handlers keep their
names: the crontab and launchd code lives in `osplat/_posix_scheduler.py`
(chosen by `_darwin` with launchd and by `_linux` without), and Windows
answers with inert "unsupported" results without spawning anything. This
module is a pure service layer — it knows nothing about WebSocket sessions
and never touches app state.
"""

from __future__ import annotations

import asyncio
import time

from . import osplat
from .osplat._posix_scheduler import (  # noqa: F401 - re-exported for callers and tests
    DISABLED_PREFIX,
    parse_crontab,
    parse_launchctl_list,
)
from .osplat.spec import SchedulerError as ExecutionsError  # noqa: F401 - re-exported

__all__ = [
    "DISABLED_PREFIX",
    "ExecutionsError",
    "list_crontab",
    "list_executions",
    "list_launch_agents",
    "parse_crontab",
    "parse_launchctl_list",
    "remove_crontab_entry",
    "remove_launch_agent",
    "set_crontab_enabled",
    "set_launch_agent_enabled",
]


async def list_crontab() -> dict:
    """List the current user's crontab entries; unsupported is an empty list."""
    return await osplat.scheduler.list_jobs("crontab")


async def set_crontab_enabled(raw: str, enabled: bool) -> None:
    await osplat.scheduler.set_enabled("crontab", raw, enabled)


async def remove_crontab_entry(raw: str) -> None:
    await osplat.scheduler.remove("crontab", raw)


async def list_launch_agents() -> dict:
    """List launchd jobs; unsupported off macOS."""
    return await osplat.scheduler.list_jobs("launchagent")


async def set_launch_agent_enabled(label: str, enabled: bool) -> None:
    await osplat.scheduler.set_enabled("launchagent", label, enabled)


async def remove_launch_agent(label: str) -> None:
    await osplat.scheduler.remove("launchagent", label)


async def list_executions() -> dict:
    """Full scan of both sources for the Tasker panel."""
    crontab, launch_agents = await asyncio.gather(list_crontab(), list_launch_agents())
    return {
        "platform": osplat.platform_id,
        "scanned_at": time.time(),
        "crontab": crontab,
        # The panel contract names this list "agents"; the scanner returns "entries".
        "launch_agents": {
            "supported": launch_agents["supported"],
            "error": launch_agents["error"],
            "unreadable": launch_agents["unreadable"],
            "agents": launch_agents["entries"],
        },
    }
