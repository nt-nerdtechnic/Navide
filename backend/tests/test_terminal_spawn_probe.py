from __future__ import annotations

import os
import signal
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import app


def _resolves_to(monkeypatch: pytest.MonkeyPatch, target: str | None) -> None:
    """Where the launch seam finds the CLI — the probe's only PATH lookup."""
    monkeypatch.setattr(
        app.osplat.paths, "resolve_program", lambda _name, *, path=None: target
    )


def test_agent_cli_probe_reports_resolved_binary_and_version(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    binary = tmp_path / "claude"
    binary.write_text("#!/bin/sh\n")
    _resolves_to(monkeypatch, str(binary))
    monkeypatch.setattr(
        app.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout="2.1.210 (Claude Code)\n",
            stderr="",
        ),
    )

    result = app._probe_agent_cli_for_spawn("claude")

    assert result is not None
    assert result["binary_path"] == str(binary)
    assert result["resolved_path"] == os.path.realpath(binary)
    assert result["version"] == "2.1.210"
    assert result["exit_code"] == 0


@pytest.mark.skipif(not hasattr(signal, "SIGKILL"), reason="no POSIX SIGKILL to name")
def test_agent_cli_probe_surfaces_sigkill_with_structured_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _resolves_to(monkeypatch, "/opt/bin/claude")
    monkeypatch.setattr(
        app.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=-9, stdout="", stderr=""),
    )

    with pytest.raises(app.AgentCliProbeError) as caught:
        app._probe_agent_cli_for_spawn("claude")

    assert "SIGKILL" in str(caught.value)
    assert caught.value.details["binary_path"] == "/opt/bin/claude"
    assert caught.value.details["signal"] == "SIGKILL"
    assert caught.value.details["exit_code"] == -9
    # Fast SIGKILL death → quarantine/corruption hint.
    assert "quarantined or corrupt" in str(caught.value)
    assert "hint" in caught.value.details


def test_agent_cli_probe_non_sigkill_signal_has_no_hint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _resolves_to(monkeypatch, "/opt/bin/claude")
    monkeypatch.setattr(
        app.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=-15, stdout="", stderr=""),
    )

    with pytest.raises(app.AgentCliProbeError) as caught:
        app._probe_agent_cli_for_spawn("claude")

    assert "SIGTERM" in str(caught.value)
    assert "quarantined or corrupt" not in str(caught.value)
    assert "hint" not in caught.value.details


def test_agent_cli_probe_error_shows_symlink_target(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    real = tmp_path / "claude-real"
    real.write_text("#!/bin/sh\n")
    link = tmp_path / "claude"
    link.symlink_to(real)
    resolved = str(real.resolve())
    _resolves_to(monkeypatch, str(link))
    monkeypatch.setattr(
        app.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=1, stdout="", stderr=""),
    )

    with pytest.raises(app.AgentCliProbeError) as caught:
        app._probe_agent_cli_for_spawn("claude")

    assert f"({link} → {resolved})" in str(caught.value)
    assert caught.value.details["binary_path"] == str(link)
    assert caught.value.details["resolved_path"] == resolved


def test_agent_cli_probe_success_payload_carries_resolved_symlink_target(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    real = tmp_path / "claude-real"
    real.write_text("#!/bin/sh\n")
    link = tmp_path / "claude"
    link.symlink_to(real)
    _resolves_to(monkeypatch, str(link))
    monkeypatch.setattr(
        app.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout="2.1.210 (Claude Code)\n",
            stderr="",
        ),
    )

    result = app._probe_agent_cli_for_spawn("claude")

    assert result is not None
    assert result["binary_path"] == str(link)
    assert result["resolved_path"] == str(real.resolve())


def test_agent_cli_probe_uses_explicit_binary_from_spawn_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def resolve(name: str, *, path: str | None = None) -> str | None:
        calls.append(name)
        return name if name == "/opt/homebrew/bin/claude" else "/broken/bin/claude"

    monkeypatch.setattr(app.osplat.paths, "resolve_program", resolve)
    monkeypatch.setattr(
        app.subprocess,
        "run",
        lambda command, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout="2.1.168 (Claude Code)\n",
            stderr="",
        ) if command[0] == "/opt/homebrew/bin/claude" else None,
    )

    result = app._probe_agent_cli_for_spawn(
        "claude", "'/opt/homebrew/bin/claude' --session-id test"
    )

    assert result is not None
    assert result["binary_path"] == "/opt/homebrew/bin/claude"
    assert result["version"] == "2.1.168"
    assert calls == ["/opt/homebrew/bin/claude"]


# The shim npm installs on Windows: `CreateProcess` refuses a `.cmd`, so the
# probe has to name the interpreter. Before this the OSError was caught and
# downgraded to "degraded", leaving the probe permanently useless there.
def test_agent_cli_probe_runs_a_windows_shim_through_cmd(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent_team_backend.osplat import _windows

    monkeypatch.setattr(app.osplat, "paths", _windows.paths)
    monkeypatch.setattr(
        _windows.paths,
        "resolve_program",
        lambda _name, *, path=None: r"C:\Users\a\AppData\Roaming\npm\claude.cmd",
    )
    monkeypatch.setattr(
        app.subprocess,
        "run",
        lambda command, **_kwargs: SimpleNamespace(
            returncode=0, stdout="2.1.210 (Claude Code)\n", stderr=""
        ),
    )

    result = app._probe_agent_cli_for_spawn("claude")

    assert result is not None
    assert result["probe_command"] == [
        "cmd.exe", "/d", "/c",
        r"C:\Users\a\AppData\Roaming\npm\claude.cmd", "--version",
    ]
    assert result["binary_path"] == r"C:\Users\a\AppData\Roaming\npm\claude.cmd"
    assert result["version"] == "2.1.210"


def test_plain_terminal_skips_agent_cli_probe() -> None:
    assert app._probe_agent_cli_for_spawn("terminal") is None


def test_persisted_cli_binary_rewrites_spawn_and_resume_commands(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        app.onboarding_deps,
        "cli_binary_override",
        lambda _agent_key: "/opt/homebrew/bin/claude",
    )

    assert app._command_with_persisted_cli_binary(
        "claude", "claude --session-id abc"
    ) == "/opt/homebrew/bin/claude --session-id abc"
    assert app._command_with_persisted_cli_binary(
        "claude", ["/bin/zsh", "-lc", "claude --resume abc"]
    ) == ["/bin/zsh", "-lc", "/opt/homebrew/bin/claude --resume abc"]
