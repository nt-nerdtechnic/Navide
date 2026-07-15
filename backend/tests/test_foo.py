import asyncio
from agent_team_backend.terminals import TerminalService
import sys
async def test_minimal():
    received = []
    async def emit(e):
        print("EMIT:", e)
        received.append(e)
    svc = TerminalService(emit)
    child = "import sys; sys.stdout.write('GOT IT\\n'); sys.stdout.flush()"
    session = svc.create(pane_id="p1", agent_key=None, command=[sys.executable, "-u", "-c", child], cwd=".")
    for _ in range(500):
        await asyncio.sleep(0.01)
        if received:
            break
    print("RECEIVED:", received)

asyncio.run(test_minimal())
