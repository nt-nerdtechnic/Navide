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


def test_plain_terminal_skips_agent_cli_probe() -> None:
    assert app._probe_agent_cli_for_spawn("terminal") is None
