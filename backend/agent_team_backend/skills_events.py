"""Notify every Skills view after a committed WS or MCP mutation."""

import logging

from .ipc import make_event

logger = logging.getLogger(__name__)


async def notify_skills_changed(name: str, operation: str) -> None:
    from . import app

    try:
        await app.broadcast(make_event("skills.changed", {"name": name, "operation": operation}))
    except Exception:
        # A failed notification must not report a committed write as failed.
        logger.exception("Could not broadcast Skills change for %s", name)
