from __future__ import annotations

from pathlib import Path

from agent_team_backend.app import _session_exists


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


def test_detected_codex_gemini_sessions_are_trusted() -> None:
    assert _session_exists("codex", "/tmp/ws", "codex-sess") is True
    assert _session_exists("gemini", "/tmp/ws", "gemini-sess") is True
    assert _session_exists("codex", "/tmp/ws", "") is False


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


def test_gemini_session_file_path_must_exist(tmp_path: Path) -> None:
    session_file = tmp_path / "session.json"
    session_file.write_text("{}", encoding="utf-8")

    assert _session_exists("gemini", "/tmp/ws", str(session_file)) is True
    assert _session_exists("gemini", "/tmp/ws", str(tmp_path / "missing.json")) is False
