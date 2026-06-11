"""Session.send_json must serialize concurrent writers.

The websockets protocol forbids concurrent writes on one connection — two
coroutines hitting drain() together trip `assert waiter is None or
waiter.cancelled()` and wedge the socket permanently (observed 2026-06-11:
blank panes until the server aborted the TCP connection minutes later).
"""

from __future__ import annotations

import asyncio

from agent_team_backend.app import Session


class OverlapProbe:
    """Fake websocket that records the maximum number of concurrent sends."""

    def __init__(self) -> None:
        self.active = 0
        self.max_active = 0
        self.sent: list[dict] = []

    async def send_json(self, data: dict) -> None:
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        await asyncio.sleep(0.005)  # force overlap if callers aren't serialized
        self.sent.append(data)
        self.active -= 1


async def test_concurrent_send_json_never_overlaps() -> None:
    probe = OverlapProbe()
    session = Session(probe)  # type: ignore[arg-type]

    await asyncio.gather(*(session.send_json({"i": i}) for i in range(20)))

    assert probe.max_active == 1
    assert len(probe.sent) == 20


async def test_send_event_swallows_send_errors() -> None:
    class Exploding:
        async def send_json(self, data: dict) -> None:
            raise RuntimeError("boom")

    session = Session(Exploding())  # type: ignore[arg-type]
    # Must not raise — PTY output pump treats send failures as non-fatal.
    await session._send_event({"type": "terminal.output"})
