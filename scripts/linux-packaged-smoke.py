#!/usr/bin/env python3
"""Open the packaged Linux app and prove a pane's PTY really runs a command.

The release job only proves the installers build; this proves they start. It
launches the AppImage or the installed deb under a virtual display, waits for
the bundled backend to answer /health, then asks the backend's own MCP server
to open a plain terminal pane and checks that a command typed into it was
actually executed by the shell.

    python3 scripts/linux-packaged-smoke.py --appimage dist-release/Navide-*.AppImage
    python3 scripts/linux-packaged-smoke.py --deb dist-release/Navide-*.deb

Runs under `xvfb-run` unless DISPLAY is already set or --no-xvfb is given.
HOME is a throwaway directory, so the run sees a first-launch account and
cannot touch the real user's state. Exits non-zero on any failure, after
printing the app's stdout and backend.log. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

DEB_EXECUTABLE = "/opt/Navide/navide"


def log(message: str) -> None:
    print(f"[smoke] {message}", flush=True)


class Failure(Exception):
    pass


def http_get(url: str, timeout: float) -> tuple[int, str]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.status, response.read().decode(errors="replace")


def mcp_call(url: str, tool: str, arguments: dict, timeout: float = 120) -> dict:
    """One stateless streamable-HTTP tools/call; returns the tool's JSON result."""
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": random.randint(1, 1 << 30),
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }
    ).encode()
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        envelope = json.loads(response.read().decode())
    if "error" in envelope:
        raise Failure(f"{tool}: JSON-RPC error {envelope['error']}")
    result = envelope["result"]
    if result.get("structuredContent") is not None:
        payload = result["structuredContent"]
        # FastMCP wraps non-object returns as {"result": ...}.
        if set(payload) == {"result"} and isinstance(payload["result"], dict):
            payload = payload["result"]
    else:
        payload = json.loads(result["content"][0]["text"])
    if result.get("isError"):
        raise Failure(f"{tool}: tool error {payload}")
    return payload


def wait_for(what: str, deadline: float, probe):
    """Call probe() until it returns a truthy value or the deadline passes."""
    last = None
    while time.monotonic() < deadline:
        try:
            value = probe()
            if value:
                return value
        except Exception as err:  # noqa: BLE001 - still starting
            last = err
        time.sleep(1)
    raise Failure(f"timed out waiting for {what} (last error: {last})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--appimage", type=Path)
    target.add_argument("--deb", type=Path)
    parser.add_argument("--health-timeout", type=float, default=240)
    parser.add_argument("--no-xvfb", action="store_true")
    args = parser.parse_args()

    if args.deb:
        log(f"installing {args.deb}")
        subprocess.run(
            ["sudo", "apt-get", "install", "-y", "--allow-downgrades", str(args.deb.resolve())],
            check=True,
        )
        executable = DEB_EXECUTABLE
    else:
        args.appimage.chmod(0o755)
        executable = str(args.appimage.resolve())

    home = Path(tempfile.mkdtemp(prefix="navide-packaged-smoke-"))
    env = {k: v for k, v in os.environ.items() if not k.startswith("XDG_") or k == "XDG_RUNTIME_DIR"}
    env["HOME"] = str(home)
    env.pop("AGENT_TEAM_DATA_DIR", None)
    data_dir = home / ".local" / "share" / "Agent-Team"
    workspace = (home / "workspace").resolve()
    workspace.mkdir()
    stdout_path = home / "main-stdout.log"

    command = [executable]
    if not args.no_xvfb and not env.get("DISPLAY"):
        command = ["xvfb-run", "-a", "-s", "-screen 0 1440x900x24", *command]
    log(f"HOME={home}")
    log(f"launching: {' '.join(command)}")
    started = time.monotonic()
    stdout = stdout_path.open("wb")
    app = subprocess.Popen(
        command, env=env, stdout=stdout, stderr=subprocess.STDOUT, start_new_session=True
    )

    ok = False
    try:
        deadline = started + args.health_timeout

        def health():
            if app.poll() is not None:
                raise Failure(f"app exited with {app.returncode} before the backend was healthy")
            port = (data_dir / "backend-port").read_text().strip()
            status, body = http_get(f"http://127.0.0.1:{port}/health", timeout=3)
            return (port, body) if status == 200 else None

        try:
            port, body = wait_for("backend /health", deadline, health)
        except Failure:
            if app.poll() is not None:
                raise Failure(f"app exited with {app.returncode} before the backend was healthy")
            raise
        log(f"backend healthy on port {port} after {time.monotonic() - started:.1f}s: {body}")

        config = json.loads((data_dir / "plan-mcp.json").read_text())
        url = config["mcpServers"]["navide"]["url"]

        # The pane request is answered by a renderer window holding the
        # workspace; opening one also proves the window loaded at all.
        def open_workspace():
            result = mcp_call(url, "workspace_open", {"path": str(workspace)})
            if not result.get("ok"):
                raise Failure(f"workspace_open: {result}")
            return result

        wait_for("workspace_open", time.monotonic() + 120, open_workspace)
        log(f"workspace opened after {time.monotonic() - started:.1f}s: {workspace}")

        n = random.randint(1000, 99999)
        # The marker only appears once the shell evaluates the arithmetic, so
        # the echoed command line itself can never satisfy the check.
        task = f"echo NAVIDE_PTY_OK_$((40+2))_{n}"
        expected = f"NAVIDE_PTY_OK_42_{n}"
        pane = None
        for attempt in range(1, 4):
            result = mcp_call(
                url,
                "cli_open_agent",
                {
                    "agent": "terminal",
                    "name": f"smoke-{attempt}",
                    "task": task,
                    "workspace_path": str(workspace),
                },
            )
            log(f"cli_open_agent attempt {attempt}: {json.dumps(result)}")
            if result.get("ok"):
                pane = result
                break
            time.sleep(5)
        if pane is None:
            raise Failure("cli_open_agent never opened a terminal pane")

        def marker():
            result = mcp_call(url, "cli_read_log", {"target": "", "pane_id": pane["pane_id"]})
            return result.get("ok") and expected in result.get("text", "") and result

        try:
            result = wait_for(f"{expected} in the pane log", time.monotonic() + 60, marker)
        except Failure:
            last = mcp_call(url, "cli_read_log", {"target": "", "pane_id": pane["pane_id"]})
            log(f"last cli_read_log: {json.dumps(last)[-2000:]}")
            raise
        log(f"PTY ok after {time.monotonic() - started:.1f}s: {expected} in {result['log_path']}")
        ok = True
    except Failure as err:
        log(f"FAIL: {err}")
    finally:
        try:
            os.killpg(app.pid, signal.SIGTERM)
            app.wait(timeout=15)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(app.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        stdout.close()
        if not ok:
            for title, path in (
                ("main stdout", stdout_path),
                ("backend.log", data_dir / "logs" / "backend.log"),
            ):
                print(f"\n===== {title}: {path} =====", flush=True)
                try:
                    print(path.read_text(errors="replace"), flush=True)
                except OSError as err:
                    print(f"(unreadable: {err})", flush=True)
        else:
            shutil.rmtree(home, ignore_errors=True)

    log("PASS" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
