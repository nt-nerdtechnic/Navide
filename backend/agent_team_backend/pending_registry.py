"""Generic registry for request/response flows where a WebSocket handler
resolves a Future that a coroutine elsewhere is awaiting with a timeout."""

from __future__ import annotations

import asyncio
from typing import Generic, TypeVar

T = TypeVar("T")

TIMEOUT = object()  # sentinel distinguishing "timed out" from any real T value


class PendingRegistry(Generic[T]):
    """Maps a string key to a pending ``asyncio.Future[T]``."""

    def __init__(self) -> None:
        self.pending: dict[str, "asyncio.Future[T]"] = {}

    def register(self, key: str) -> "asyncio.Future[T]":
        """Create and register a pending Future for *key*.

        Register before notifying whoever will eventually call resolve() --
        otherwise a fast resolve() could arrive before the key exists and be
        silently dropped.
        """
        fut: asyncio.Future[T] = asyncio.get_running_loop().create_future()
        self.pending[key] = fut
        return fut

    def resolve(self, key: str, value: T) -> bool:
        """Resolve the Future for *key*. Returns False if not found or already done."""
        fut = self.pending.get(key)
        if fut is None or fut.done():
            return False
        fut.set_result(value)
        return True

    def discard(self, key: str) -> None:
        """Drop a registered entry without resolving it -- for a caller that
        errors out between register() and wait() and must not leak the entry."""
        self.pending.pop(key, None)

    async def wait(self, key: str, fut: "asyncio.Future[T]", timeout: float) -> T | object:
        """Await *fut* (previously returned by ``register(key)``) bounded by
        *timeout*, always removing *key* from the registry afterward.

        Returns the resolved value, or the ``TIMEOUT`` sentinel if *timeout*
        elapses first.
        """
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout=timeout)
        except asyncio.TimeoutError:
            return TIMEOUT
        finally:
            self.pending.pop(key, None)
