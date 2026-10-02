"""The Codex guard hook run end to end, the way Codex runs it.

On Windows that is `%COMSPEC% /C "<text>"` with the text passed verbatim
(codex-rs hooks command_runner.rs, build_command: `raw_arg`), so the test hands
Popen the same command line as a string rather than letting Python quote a list.
"""

from __future__ import annotations

import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from agent_team_backend import codex_session_hooks as hooks
from agent_team_backend import osplat
from tests import hook_shell
from tests.test_claude_hooks import _run_to_completion

DENY = b'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'
ALLOW = b'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'


def _argv() -> list[str] | str:
    command = hooks.guard_hook_command()
    if osplat.platform_id == "win32":
        comspec = os.environ.get("COMSPEC") or "cmd.exe"
        return f'"{comspec}" /C "{command}"'
    return hook_shell.shell_argv({"command": command})


def _ceiling() -> float:
    if osplat.platform_id == "win32":
        return 45.0
    return hook_shell.hang_ceiling(hook_shell.shell_argv({"command": "exit 0"}), 45)


def _serve(status: int, body: bytes, listen_s: float):
    received: list[tuple[str, bytes, str | None]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            received.append((
                self.path,
                self.rfile.read(int(self.headers["Content-Length"])),
                self.headers.get(hooks.LAUNCH_HEADER),
            ))
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = listen_s
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    return server, thread, received


@pytest.fixture
def codex_env(tmp_path, monkeypatch):
    if osplat.paths.resolve_program("curl") is None:
        pytest.skip("curl is unavailable for the Codex hook")
    # A space and non-ASCII in every path the hook reads: user names carry both.
    home = tmp_path / "Navide 使用者"
    home.mkdir()
    auth = home / "hook auth"
    auth.write_text("X-Agent-Team-Hook: test-secret\n", encoding="utf-8")
    monkeypatch.setenv(hooks.LAUNCH_ENV, "test-launch")
    monkeypatch.setenv("NAVIDE_CODEX_PORT_FILE", str(home / "backend port"))
    monkeypatch.setenv("NAVIDE_CODEX_AUTH_FILE", str(auth))
    return home


PAYLOAD = '{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"C:/工作區"}'


@pytest.mark.parametrize("status,body,expected", [
    (200, DENY, DENY.decode()),
    (200, ALLOW, ALLOW.decode()),
    # A secret from another install: no decision, not an error.
    (403, b"", ""),
], ids=["deny", "allow", "403"])
def test_the_decision_reaches_stdout_and_the_exit_is_zero(codex_env, status, body, expected) -> None:
    ceiling = _ceiling()
    server, thread, received = _serve(status, body, listen_s=ceiling + 10)
    (codex_env / "backend port").write_text(f"{server.server_port}\n", encoding="utf-8")
    try:
        result = _run_to_completion(_argv(), PAYLOAD, timeout=ceiling)
        thread.join(timeout=ceiling + 11)
    finally:
        server.server_close()
    assert received == [("/hooks/codex/pretooluse", PAYLOAD.encode(), "test-launch")]
    assert result.returncode == 0
    assert result.stdout == expected


def test_a_missing_port_file_is_no_decision(codex_env) -> None:
    result = _run_to_completion(_argv(), PAYLOAD, timeout=_ceiling())
    assert (result.returncode, result.stdout) == (0, "")


def test_a_backend_that_is_down_is_no_decision(codex_env) -> None:
    server = HTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    port = server.server_port
    server.server_close()
    (codex_env / "backend port").write_text(str(port), encoding="utf-8")
    result = _run_to_completion(_argv(), PAYLOAD, timeout=_ceiling())
    assert (result.returncode, result.stdout) == (0, "")


def test_outside_a_navide_launch_nothing_is_sent(codex_env, monkeypatch) -> None:
    monkeypatch.delenv(hooks.LAUNCH_ENV)
    result = _run_to_completion(_argv(), PAYLOAD, timeout=_ceiling())
    assert (result.returncode, result.stdout) == (0, "")


def test_the_posix_command_is_unchanged(monkeypatch) -> None:
    # Pinned: the cmd rewrite is Windows-only.
    monkeypatch.setattr(osplat, "platform_id", "darwin")
    assert hooks.guard_hook_command() == (
        '[ -n "$NAVIDE_CODEX_LAUNCH" ] || exit 0; '
        'navide_port=$(cat "$NAVIDE_CODEX_PORT_FILE" 2>/dev/null); '
        '[ -n "$navide_port" ] || exit 0; '
        'curl -fsS -m 9 -X POST '
        '-H "Content-Type: application/json" '
        '-H "@$NAVIDE_CODEX_AUTH_FILE" '
        '-H "X-Navide-Codex-Launch: $NAVIDE_CODEX_LAUNCH" '
        '--data-binary @- "http://127.0.0.1:$navide_port/hooks/codex/pretooluse" '
        '2>/dev/null; exit 0'
    )
