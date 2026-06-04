"""Theme persistence fields on Project (backup for the renderer's localStorage).

Project gained `theme` / `theme_custom`; these cover defaults, round-trip
through project.json, and backward compatibility with pre-feature files.
"""

from __future__ import annotations

from agent_team_backend.projects import Project


def _project() -> Project:
    return Project(
        id="p", name="n", workspace_path="/ws", created_at="t", updated_at="t",
    )


def test_theme_defaults() -> None:
    p = _project()
    assert p.theme == "dark-github"
    assert p.theme_custom == {}


def test_theme_round_trips_through_dict() -> None:
    p = _project()
    p.theme = "dark-forest"
    p.theme_custom = {"--accent-fg": "#abcdef"}
    restored = Project.from_dict(p.to_dict())
    assert restored.theme == "dark-forest"
    assert restored.theme_custom == {"--accent-fg": "#abcdef"}


def test_old_project_json_without_theme_loads() -> None:
    """Backward compat: pre-feature project.json has no theme keys."""
    legacy = {
        "id": "p", "name": "n", "workspace_path": "/ws",
        "created_at": "t", "updated_at": "t",
    }
    restored = Project.from_dict(legacy)
    assert restored.theme == "dark-github"
    assert restored.theme_custom == {}


def test_theme_custom_is_independent_per_instance() -> None:
    """field(default_factory=dict) must not share a mutable default."""
    a = _project()
    b = _project()
    a.theme_custom["--bg-base"] = "#000000"
    assert b.theme_custom == {}
