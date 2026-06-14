from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.applog import app_data_dir


def test_app_data_dir_honors_env_override(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An explicit AGENT_TEAM_DATA_DIR wins over the platform default — this is
    how the dev launcher keeps its backend state separate from a packaged app."""
    override = tmp_path / "dev-data"
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(override))
    assert app_data_dir() == override


def test_app_data_dir_expands_user_in_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", "~/some-dev-dir")
    assert app_data_dir() == Path.home() / "some-dev-dir"


def test_app_data_dir_default_without_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No override → the platform default, whose leaf is always 'Agent-Team'."""
    monkeypatch.delenv("AGENT_TEAM_DATA_DIR", raising=False)
    assert app_data_dir().name == "Agent-Team"
