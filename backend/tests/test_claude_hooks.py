import json
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from agent_team_backend.claude_hooks import _build_curl_command


def _bash() -> str | None:
    """Git for Windows' bash first: a bare `which("bash")` can land on the WSL
    stub in System32, which has no distribution to run anything with."""
    git = shutil.which("git")
    if git is not None:
        candidate = Path(git).resolve().parent.parent / "bin" / "bash.exe"
        if candidate.is_file():
            return str(candidate)
    return shutil.which("bash")


def _run_hook(tmp_path, event_kind: str, body: bytes, endpoint: str = "claude"):
    """Run one installed hook command against a one-shot HTTP server.

    Returns (payloads the server received, the command's stdout) — stdout being
    the interesting half, because that is the only channel a CLI reads a hook's
    decision from.
    """
    # The hook command is a POSIX sh script: `shell=True` would hand it to
    # cmd.exe on Windows, so run it under an explicit bash (Git for Windows
    # ships one) — checked before the server thread starts.
    bash = _bash()
    if bash is None:
        pytest.skip("hook commands are POSIX sh scripts and no bash is on PATH")
    received: list[bytes] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers["Content-Length"])
            received.append(self.rfile.read(length))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 5
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    port_file = tmp_path / "backend.port"
    port_file.write_text(str(server.server_port), encoding="utf-8")
    payload = '{"hook_event_name":"Stop","session_id":"session-1"}'

    try:
        result = subprocess.run(
            [bash, "-c", _build_curl_command(str(port_file), event_kind, endpoint=endpoint)],
            input=payload,
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
    finally:
        thread.join(timeout=6)
        server.server_close()

    assert received == [payload.encode()]
    return received, result.stdout


def test_stop_hook_puts_the_response_on_stdout_where_the_cli_reads_decisions(tmp_path) -> None:
    """A queued inter-CLI message comes back as the Stop hook's own decision,
    and Claude Code only ever sees it if the hook prints it."""
    decision = b'{"decision":"block","reason":"[Navide MSG] from: builder"}'

    _received, stdout = _run_hook(tmp_path, "stop", decision)

    assert stdout == decision.decode()


def test_other_events_still_discard_the_response(tmp_path) -> None:
    # Their replies are acks, and an unrecognized object on a hook's stdout is
    # reported to the user as a hook error.
    _received, stdout = _run_hook(tmp_path, "pre_tool_use", b'{"ok":true}')

    assert stdout == ""


def test_qwens_stop_hook_keeps_discarding_the_response(tmp_path) -> None:
    # qwen borrows this builder; the decision contract is claude's alone.
    _received, stdout = _run_hook(tmp_path, "stop", b'{"ok":true}', endpoint="qwen")

    assert stdout == ""


def test_dev_instance_does_not_overwrite_production_hook(tmp_path) -> None:
    from agent_team_backend.claude_hooks import install_hooks

    settings_file = tmp_path / "settings.json"
    prod_port_file = tmp_path / "production" / "backend.port"
    prod_port_file.parent.mkdir(parents=True, exist_ok=True)
    prod_port_file.write_text("50000", encoding="utf-8")

    # Install production hook
    install_hooks(str(prod_port_file), settings_file=settings_file)
    initial_content = settings_file.read_text(encoding="utf-8")
    # Through the JSON, not the raw text: a Windows path's backslashes are
    # escaped in the file.
    commands = [
        h["command"]
        for entries in json.loads(initial_content)["hooks"].values()
        for entry in entries
        for h in entry.get("hooks", [])
    ]
    assert any(str(prod_port_file) in c for c in commands)

    # Attempt to install dev hook (port_file containing -dev)
    dev_port_file = tmp_path / "Agent-Team-dev" / "backend-port"
    dev_port_file.parent.mkdir(parents=True, exist_ok=True)
    dev_port_file.write_text("60000", encoding="utf-8")

    res = install_hooks(str(dev_port_file), settings_file=settings_file)
    assert res.get("status") == "skipped"
    # Settings file remains pointing to production port file
    assert settings_file.read_text(encoding="utf-8") == initial_content



def test_subagent_stop_hook_is_installed(tmp_path) -> None:
    """The event that closes the loop's blind spot must actually get written.

    PreToolUse alone can only count subagents going in. Without SubagentStop
    nothing ever counts one coming back out, so the pending count would climb
    and never fall — worse than not counting at all.
    """
    from agent_team_backend.claude_hooks import install_hooks

    settings_file = tmp_path / "settings.json"
    port_file = tmp_path / "port"
    port_file.write_text("1234")
    install_hooks(str(port_file), settings_file=settings_file)

    import json

    hooks = json.loads(settings_file.read_text())["hooks"]
    assert "SubagentStop" in hooks, "SubagentStop hook was not installed"
    commands = [
        h["command"]
        for entry in hooks["SubagentStop"]
        for h in entry.get("hooks", [])
    ]
    assert any("kind=subagent_stop" in c for c in commands)
    # It is a plain signal hook: its response is discarded, unlike Stop's.
    assert all("-o /dev/null" in c for c in commands)


def test_subagent_stop_hook_reaches_the_endpoint(tmp_path) -> None:
    payloads, stdout = _run_hook(tmp_path, "subagent_stop", b'{"ok":true}')
    assert payloads, "the hook sent nothing"
    assert stdout == "", "a signal hook's response must not reach the CLI"


def test_a_windows_install_writes_powershell_and_says_so(tmp_path, monkeypatch) -> None:
    """On Windows a hook's `command` runs under Git Bash, or PowerShell when
    Git Bash is not installed — and the entry declares which it was written
    for. Nothing here can assume sh, so the renderer is the seam and this
    exercises its Windows arm on whatever machine runs the suite.
    """
    from agent_team_backend import claude_hooks, osplat
    from agent_team_backend.osplat import _windows

    monkeypatch.setattr(osplat, "scripts", _windows.scripts)
    monkeypatch.setattr(claude_hooks, "_rewake_wanted", lambda: True)

    settings_file = tmp_path / "settings.json"
    port_file = tmp_path / "port"
    port_file.write_text("1234", encoding="utf-8")
    claude_hooks.install_hooks(str(port_file), settings_file=settings_file)

    entries = [
        h
        for event in json.loads(settings_file.read_text(encoding="utf-8"))["hooks"].values()
        for entry in event
        for h in entry.get("hooks", [])
    ]
    assert entries
    for hook in entries:
        assert hook["shell"] == "powershell"
        # The marker comment, then one PowerShell line — `#` comments in both
        # shells, so the marker still reads the same to the installer.
        marker, command = hook["command"].split("\n", 1)
        assert marker.startswith("# agent-team-hook")
        assert "\n" not in command
        assert command.startswith("$PORT = Get-Content -ErrorAction SilentlyContinue ")
        assert "curl.exe" in command
        assert command.endswith("exit 0") or command.endswith("exit 2 }; exit 0")

    rewake = [h for h in entries if h.get("asyncRewake")]
    assert rewake, "the rewake waiter was not installed"
    assert "[Console]::Error.WriteLine($BODY); exit 2" in rewake[0]["command"]
