"""Real process / PTY / authenticated WebSocket lifecycle composition."""
import asyncio
import json
import re

import psutil
import pytest


pytestmark = [pytest.mark.cli_regression, pytest.mark.cli_shared]


async def assert_dead(pid):
    async with asyncio.timeout(10):
        while psutil.pid_exists(pid):
            await asyncio.sleep(0.02)


async def test_disconnect_reattach_preserves_process_and_io(backend_process):
    backend = backend_process
    async with backend.connect() as first:
        created = await backend.create(first)
        tid, pid = created["terminal_session_id"], created["pid"]
        await backend.request(first, "terminal.input", {"terminal_session_id": tid, "data": "before\r"})
        await backend.expect_output(first, tid, '"text": "before"')
        fake_pid = int(re.search(r'ACK \{"pid": (\d+), "text": "before"\}', backend.output[tid]).group(1))
        backend.track_child(fake_pid)
    assert psutil.pid_exists(pid)
    async with backend.connect() as second:
        response = await backend.request(second, "terminal.reattach", {
            "terminal_session_ids": [tid], "cols": 120, "rows": 40,
        })
        assert response["payload"]["alive"] == [tid]
        await backend.request(second, "terminal.input", {"terminal_session_id": tid, "data": "after-世界\r"})
        output = await backend.expect_output(second, tid, '"text": "after-世界"')
        assert json.dumps({"pid": fake_pid, "text": "after-世界"}, ensure_ascii=False) in output
        await backend.request(second, "terminal.kill", {"terminal_session_id": tid})
        await assert_dead(pid)


async def test_cancelled_generation_never_spawns_and_replacement_reaps(backend_process):
    backend = backend_process
    async with backend.connect() as ws:
        await backend.request(ws, "terminal.create.cancel", {
            "pane_id": "cancelled", "create_generation": "cancelled-generation",
        })
        refused = await backend.request(ws, "terminal.create", {
            "pane_id": "cancelled", "create_generation": "cancelled-generation",
            "agent_key": "terminal", "cwd": str(backend.root), "command": backend.fake_command(),
        }, ok=False)
        assert not refused["ok"]
        first = await backend.create(ws, pane_id="replace")
        second = await backend.create(ws, pane_id="replace", replaces_terminal_id=first["terminal_session_id"])
        assert first["terminal_session_id"] != second["terminal_session_id"]
        await assert_dead(first["pid"])
        assert psutil.pid_exists(second["pid"])
        await backend.request(ws, "terminal.kill", {"terminal_session_id": second["terminal_session_id"]})
        await assert_dead(second["pid"])


async def test_output_flood_accepts_input_then_natural_eof(backend_process):
    backend = backend_process
    async with backend.connect() as ws:
        created = await backend.create(ws)
        tid = created["terminal_session_id"]
        await backend.request(ws, "terminal.input", {"terminal_session_id": tid, "data": "flood\r"})
        await backend.expect_output(ws, tid, "FLOOD ")
        await backend.request(ws, "terminal.input", {"terminal_session_id": tid, "data": "responsive\r"})
        await backend.expect_output(ws, tid, '"text": "responsive"')
        await backend.request(ws, "terminal.input", {"terminal_session_id": tid, "data": "exit\r"})
        async with asyncio.timeout(15):
            while not any(event.get("type") == "terminal.exit" and
                          event.get("payload", {}).get("terminal_session_id") == tid
                          for event in backend.events):
                await backend.receive(ws)
        await assert_dead(created["pid"])
        response = await backend.request(ws, "terminal.reattach", {"terminal_session_ids": [tid]})
        assert response["payload"]["dead"] == [tid]
