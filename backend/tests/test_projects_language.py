"""Language backup on Project (mirror of the renderer's language setting).

The renderer treats a non-empty backup as the user's explicit choice and
persists it into the user-level settings. A new project therefore carries no
language at all: "" means follow the system locale until the user picks one.
"""

from __future__ import annotations

from agent_team_backend.projects import Project


def _project() -> Project:
    return Project(
        id="p", name="n", workspace_path="/ws", created_at="t", updated_at="t",
    )


def test_new_project_has_no_language_backup() -> None:
    assert _project().language == ""


def test_chosen_language_round_trips_through_dict() -> None:
    p = _project()
    p.language = "zh-TW"
    assert Project.from_dict(p.to_dict()).language == "zh-TW"


def test_old_project_json_without_language_loads_as_unset() -> None:
    legacy = {
        "id": "p", "name": "n", "workspace_path": "/ws",
        "created_at": "t", "updated_at": "t",
    }
    assert Project.from_dict(legacy).language == ""
