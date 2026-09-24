from __future__ import annotations

import asyncio
import time

from agent_team_backend.channels.adapter_runtime import ReceiveLoop
from agent_team_backend.channels.base import AdapterStatus


async def test_stop_ends_the_loop_even_if_a_cancel_is_swallowed() -> None:
    # A long-poll connect_once that loses one cancel the way anyio's connect_tcp
    # can, then keeps polling: stop must still end the receive task.
    swallowed: list[bool] = []

    async def connect_once() -> None:
        loop.mark_ready()
        while True:
            try:
                await asyncio.sleep(0.2)
            except asyncio.CancelledError:
                if swallowed:
                    raise
                asyncio.current_task().uncancel()
                swallowed.append(True)
            loop.touch()

    loop = ReceiveLoop("test", AdapterStatus(), connect_once, delay=lambda attempt: 0.01)
    loop.start()
    await asyncio.sleep(0.05)
    started = time.monotonic()
    # Not wait_for: a stop that swallows wait_for's own cancel returns normally.
    done, _ = await asyncio.wait({asyncio.ensure_future(loop.stop())}, timeout=3)
    assert done, "stop() did not return"
    assert time.monotonic() - started < 2
    assert swallowed and loop.status.lifecycle == "stopped"
