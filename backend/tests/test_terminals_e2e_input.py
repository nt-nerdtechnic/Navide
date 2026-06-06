"""End-to-end check that text written via TerminalService actually reaches the
spawned CLI process's stdin — i.e. "文字送出後 CLI 真的有收到".

Unlike test_terminals_write_eagain.py (which stands a plain os.pipe() in for the
PTY master), this spins up a REAL child process through a REAL pty and proves the
full backend half of the pipeline: write() → _flush_input() → os.write(master) →
pty → child stdin → child reacts. If this passes, a "sent but not received" bug
lives in the frontend / TUI handshake, not in TerminalService.
"""

import asyncio
import sys

import pytest

from agent_team_backend.terminals import TerminalService


async def test_written_text_reaches_child_stdin():
    # Collect every terminal.output event the service emits.
    received: list[str] = []

    async def emit(event):
        if event.get("type") == "terminal.output":
            received.append(event["payload"]["data"])

    svc = TerminalService(emit)

    # A tiny child that reads one line from stdin and echoes a marker back.
    # If the bytes never reach its stdin, "GOT:" never appears in the output.
    child = (
        "import sys; "
        "line = sys.stdin.readline().strip(); "
        "sys.stdout.write('GOT:' + line + '\\n'); "
        "sys.stdout.flush()"
    )
    session = svc.create(
        pane_id="p1",
        agent_key=None,
        command=[sys.executable, "-u", "-c", child],
        cwd=".",
    )
    try:
        # The action under test: send text exactly like terminal.input does.
        svc.write(session.id, "hello-pipeline\n")

        # Drain the event loop until the child echoes back (or we give up).
        for _ in range(500):
            await asyncio.sleep(0.01)
            if any("GOT:hello-pipeline" in chunk for chunk in received):
                break

        combined = "".join(received)
        assert "GOT:hello-pipeline" in combined, (
            f"child never received the input; saw: {combined!r}"
        )
    finally:
        svc.kill(session.id)
