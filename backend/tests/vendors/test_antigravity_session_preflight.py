"""Antigravity resume identity and on-disk preflight."""

from __future__ import annotations

from pathlib import Path

from agent_team_backend import app as app_module


def test_backend_claims_an_explicit_resume_but_not_a_fresh_launch() -> None:
    assert app_module._resume_id_for_agent(
        "antigravity", "agy --conversation abc123"
    ) == "abc123"
    assert app_module._resume_id_for_agent("antigravity", "agy") == ""


def test_lookup_path_names_the_conversation_db() -> None:
    path = app_module._session_lookup_path("antigravity", "/ws", "conv-7")
    assert path == str(
        Path.home() / ".gemini" / "antigravity-cli" / "conversations" / "conv-7.db"
    )


def test_session_exists_follows_lookup_path_generic_check() -> None:
    # No such conversation db on disk → the generic is_file() preflight fails.
    assert app_module._session_exists(
        "antigravity", "/ws", "definitely-not-a-real-conv-id"
    ) is False
