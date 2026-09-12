import json
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from agent_team_backend import osplat
from agent_team_backend.claude_hooks import _build_curl_command
from tests import hook_shell


def _run_hook(tmp_path, event_kind: str, body: bytes, endpoint: str = "claude"):
    """Run one installed hook command against a one-shot HTTP server.

    Returns (payloads the server received, the command's stdout) — stdout being
    the interesting half, because that is the only channel a CLI reads a hook's
    decision from.
    """
    # Which shell this text is for is the installer's declaration, not a guess:
    # `shell=True` would hand it to cmd.exe on Windows, and bash would get
    # PowerShell there. Resolved before the server thread starts, so a box with
    # neither shell skips rather than leaving one hanging.
    port_file = tmp_path / "backend.port"
    argv = hook_shell.shell_argv(
        osplat.scripts.hook_entry(
            _build_curl_command(str(port_file), event_kind, endpoint=endpoint)
        )
    )
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
    # Generous because powershell.exe can take seconds to start on a busy
    # Windows runner; sh returns long before any of these are reached.
    server.timeout = 30
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    port_file.write_text(str(server.server_port), encoding="utf-8")
    payload = '{"hook_event_name":"Stop","session_id":"session-1"}'

    try:
        result = subprocess.run(
            argv, input=payload, text=True, capture_output=True, timeout=40, check=False
        )
    finally:
        thread.join(timeout=31)
        server.server_close()

    assert received == [payload.encode()]
    # One trailing line ending is the shell's, not the hook's: PowerShell ends
    # a native command's output with a newline where sh passes curl's bytes
    # through untouched, and a CLI parsing the JSON object cannot tell. Every
    # other byte is compared exactly.
    return received, result.stdout.removesuffix("\n").removesuffix("\r")


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
    # How a shell spells "discard" (`-o /dev/null`, `-o NUL`) is the renderer's
    # business, so the expected text comes from the same seam the installer
    # wrote the command through rather than from a literal here.
    shape = dict(
        port_file=str(port_file),
        header_file=str(tmp_path / "hook-auth"),
        url_path="/hooks/claude",
        event="subagent_stop",
        timeout_s=2,
    )
    sink = re.search(r"-o \S+", osplat.scripts.hook_post_json(**shape, keep_body=False))
    assert sink, "the renderer no longer discards a signal hook's response"
    # It really is the discard, not boilerplate the kept-body form shares.
    assert sink.group(0) not in osplat.scripts.hook_post_json(**shape, keep_body=True)
    assert all(sink.group(0) in c for c in commands)


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
