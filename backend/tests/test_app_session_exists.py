from __future__ import annotations

from pathlib import Path

from agent_team_backend.app import _session_exists
from agent_team_backend.codex_home import CodexHomeManager


def test_claude_session_exists_checks_workspace_transcript(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    ws = "/Users/neillu/Desktop/Agent-Team-main/01-web"
    session_id = "sess-123"
    transcript = (
        tmp_path
        / ".claude"
        / "projects"
        / "-Users-neillu-Desktop-Agent-Team-main-01-web"
        / f"{session_id}.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}\n", encoding="utf-8")

    assert _session_exists("claude", ws, session_id) is True
    assert _session_exists("claude", ws, "missing") is False


def test_claude_session_file_encodes_non_alphanumeric_chars(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Claude Code turns every non-alphanumeric cwd char into '-', not just '/'."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    ws = "/Users/neillu/Desktop/AI Coding/my.app_v2"
    session_id = "sess-456"
    transcript = (
        tmp_path
        / ".claude"
        / "projects"
        / "-Users-neillu-Desktop-AI-Coding-my-app-v2"
        / f"{session_id}.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}\n", encoding="utf-8")

    assert _session_exists("claude", ws, session_id) is True


def test_claude_session_exists_tolerates_trailing_slash(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """A trailing slash on the workspace path must not break resume lookup.

    Claude encodes its normalized cwd (no trailing separator); the frontend may
    pass a path with one. Without rstrip the extra '-' misses the real dir.
    """
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    ws = "/Users/neillu/Desktop/Agent-Team"
    session_id = "sess-789"
    transcript = (
        tmp_path
        / ".claude"
        / "projects"
        / "-Users-neillu-Desktop-Agent-Team"
        / f"{session_id}.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}\n", encoding="utf-8")

    assert _session_exists("claude", ws + "/", session_id) is True
    assert _session_exists("claude", ws, session_id) is True


def test_codex_session_exists_checks_real_and_pane_homes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    real_home = tmp_path / "real-codex"
    real_session = real_home / "sessions" / "2026" / "07" / "14"
    real_session.mkdir(parents=True)
    (real_session / "rollout-real-session.jsonl").write_text("{}\n", encoding="utf-8")

    panes_root = tmp_path / "codex-panes"
    pane_session = panes_root / "pane-1" / "sessions" / "2026" / "07" / "14"
    pane_session.mkdir(parents=True)
    (pane_session / "rollout-pane-session.jsonl").write_text("{}\n", encoding="utf-8")

    manager = CodexHomeManager(real_home=real_home, panes_root=panes_root)
    monkeypatch.setattr("agent_team_backend.app.codex_home_manager", manager)

    assert _session_exists("codex", "/tmp/ws", "real-session") is True
    assert _session_exists("codex", "/tmp/ws", "pane-session") is True
    assert _session_exists("codex", "/tmp/ws", "missing-session") is False
    assert _session_exists("codex", "/tmp/ws", "") is False
    assert _session_exists("codex", "/tmp/ws", "../unsafe") is False


def test_antigravity_session_checks_conversation_db(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    session_id = "286db9c5-814a-4391-9244-ae51bd0083d8"
    db = tmp_path / ".gemini" / "antigravity-cli" / "conversations" / f"{session_id}.db"
    db.parent.mkdir(parents=True)
    db.write_bytes(b"")

    assert _session_exists("antigravity", "/tmp/ws", session_id) is True
    assert _session_exists("antigravity", "/tmp/ws", "missing-id") is False
