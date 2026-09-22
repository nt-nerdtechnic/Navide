"""The stdin shutdown line: the cooperative stop Electron uses on Windows,
where there is no SIGTERM to deliver."""

from __future__ import annotations

import io

from agent_team_backend.__main__ import SHUTDOWN_LINE, _watch_stdin_for_shutdown


class _Server:
    should_exit = False


class _Tty(io.StringIO):
    def isatty(self) -> bool:  # noqa: D401
        return True


def test_the_shutdown_line_sets_uvicorn_should_exit() -> None:
    server = _Server()
    _watch_stdin_for_shutdown(server, io.StringIO(f"noise\n  {SHUTDOWN_LINE}\n"))
    assert server.should_exit is True


def test_eof_without_the_line_is_not_a_shutdown() -> None:
    server = _Server()
    _watch_stdin_for_shutdown(server, io.StringIO("just-the-confirm-key\n"))
    assert server.should_exit is False


def test_a_tty_or_missing_stdin_is_never_read() -> None:
    server = _Server()
    _watch_stdin_for_shutdown(server, _Tty(f"{SHUTDOWN_LINE}\n"))
    assert server.should_exit is False
