"""One TLS context for every outbound httpx client.

``httpx.AsyncClient()`` builds a fresh ``ssl.SSLContext`` unless one is passed
as ``verify=``. Building it reads and parses the CA bundle synchronously; on
Windows under load that took seconds per client and, because analyzer_ollama
opened a new client for every health poll, stalled the event loop for about
half of every minute (loop_watchdog: analyzer_health_h → httpx.AsyncClient
→ ssl.create_default_context). The context is immutable for our purposes, so
build it once, off the loop, and share it. Verification stays exactly what
httpx would have configured on its own.
"""

from __future__ import annotations

import asyncio
import ssl

import httpx

_context: ssl.SSLContext | None = None
# Serialises the first build so concurrent first callers (the health poll and
# a pane-name request landing together) share one context instead of each
# building their own.
_build_lock = asyncio.Lock()


async def default_ssl_context() -> ssl.SSLContext:
    """The process-wide context; built in a worker thread on first use."""
    global _context
    if _context is None:
        async with _build_lock:
            if _context is None:
                _context = await asyncio.to_thread(httpx.create_ssl_context)
    return _context
