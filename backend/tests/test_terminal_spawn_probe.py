from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent_team_backend import app


def test_agent_cli_probe_reports_resolved_binary_and_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app.shutil, "which", lambda _name: "/opt/bin/claude")
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
    assert result["binary_path"] == "/opt/bin/claude"
    assert result["version"] == "2.1.210"
    assert result["exit_code"] == 0


def test_agent_cli_probe_surfaces_sigkill_with_structured_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app.shutil, "which", lambda _name: "/opt/bin/claude")
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


def test_agent_cli_probe_uses_explicit_binary_from_spawn_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def which(name: str) -> str | None:
        calls.append(name)
        return name if name == "/opt/homebrew/bin/claude" else "/broken/bin/claude"

    monkeypatch.setattr(app.shutil, "which", which)
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
