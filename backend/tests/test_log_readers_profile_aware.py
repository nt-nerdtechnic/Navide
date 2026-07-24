"""Phase D: CLI-profile-aware log readers + attribution + watcher.

Profile panes (Phase B) run with their config home relocated under
~/.navide/cli-profiles/<agent>/<id>. These tests assert each reader now finds
sessions under an active profile home, that attribution credits them to the
workspace, that the watcher can watch the extra home, and — the hard regression
gate — that with NO active profile the behavior is byte-for-byte unchanged.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from agent_team_backend.log_readers import (
    ClaudeLogReader,
    GrokLogReader,
    KimiLogReader,
    TokenUsage,
)
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.claude import encode_claude_cwd
from agent_team_backend.log_readers.profile_registry import register_profile_home
from agent_team_backend.log_readers.watcher import LogWatcher

# Note: the profile_registry is cleared around every test by an autouse fixture
# in conftest.py (_reset_profile_registry), so these tests start clean.


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


# ── claude ────────────────────────────────────────────────────────────────────

def test_claude_no_profile_project_dirs_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    default = tmp_path / "projects"
    default.mkdir()
    reader = ClaudeLogReader()
    # No profile pane ran → exactly the single default root, as before Phase D.
    assert reader.project_dirs() == [default]


def test_claude_profile_root_scanned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "default"))
    (tmp_path / "default" / "projects").mkdir(parents=True)
    reader = ClaudeLogReader()

    home = tmp_path / "cli-profiles" / "claude" / "acct1"
    ws = "/Users/me/proj"
    encoded = encode_claude_cwd(ws)
    session = home / "projects" / encoded / "sess-1.jsonl"
    _write_jsonl(session, [{
        "type": "assistant", "requestId": "r1",
        "message": {"id": "m1", "model": "claude-opus-4-8",
                    "usage": {"input_tokens": 10, "output_tokens": 5}},
    }])

    register_profile_home("claude", "acct1", home)
    assert (home / "projects") in reader.project_dirs()
    assert session in reader.session_files()
    assert session in reader.session_files_for_workspace(ws)


# ── kimi ──────────────────────────────────────────────────────────────────────

def _kimi_wire(home: Path, workdir: str, sid: str) -> Path:
    sdir = home / "sessions" / "wd_abc" / sid
    (sdir).mkdir(parents=True, exist_ok=True)
    (sdir / "state.json").write_text(json.dumps({"workDir": workdir}), encoding="utf-8")
    return sdir / "agents" / "main" / "wire.jsonl"


def test_kimi_no_profile_roots_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / ".kimi-code"
    monkeypatch.setenv("KIMI_CODE_HOME", str(home))
    (home / "sessions").mkdir(parents=True)
    reader = KimiLogReader()
    assert reader.project_dirs() == [home / "sessions"]


def test_kimi_profile_sessions_scanned_and_resumable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / ".kimi-code"
    monkeypatch.setenv("KIMI_CODE_HOME", str(home))
    (home / "sessions").mkdir(parents=True)
    reader = KimiLogReader()

    prof = tmp_path / "cli-profiles" / "kimi" / "acct1"
    sid = "session_1111aaaa-2222-3333-4444-555566667777"
    wire = _kimi_wire(prof, "/Users/me/proj", sid)
    _write_jsonl(wire, [{
        "type": "usage.record", "model": "kimi", "time": 1,
        "usage": {"inputOther": 3, "inputCacheRead": 0, "output": 2},
    }])

    register_profile_home("kimi", "acct1", prof)
    assert (prof / "sessions") in reader.project_dirs()
    assert wire in reader.session_files()
    assert reader.has_session(sid) is True  # resume preflight sees profile dir


# ── grok ──────────────────────────────────────────────────────────────────────

_GROK_SCHEMA = """
CREATE TABLE workspaces (id TEXT PRIMARY KEY, scope_key TEXT NOT NULL UNIQUE,
  canonical_path TEXT NOT NULL, git_root TEXT, display_name TEXT NOT NULL,
  last_seen_at TEXT NOT NULL) STRICT;
CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT,
  recap_text TEXT, recap_model TEXT, recap_updated_at TEXT, model TEXT NOT NULL,
  mode TEXT NOT NULL, cwd_at_start TEXT NOT NULL, cwd_last TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE messages (session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
  message_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (session_id, seq)) STRICT;
CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  message_seq INTEGER, source TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL) STRICT;
"""
_NOW = "2026-07-24T00:00:00.000Z"


def _grok_db(db: Path, *, ws: str, sid: str, marker: str) -> None:
    db.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db)
    con.executescript(_GROK_SCHEMA)
    con.execute("INSERT INTO workspaces VALUES (?,?,?,?,?,?)",
                ("w" * 16, ws, ws, ws, "p", _NOW))
    con.execute("INSERT INTO sessions (id, workspace_id, model, mode, cwd_at_start,"
                " cwd_last, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (sid, "w" * 16, "grok-4", "chat", ws, ws, "active", _NOW, _NOW))
    con.execute("INSERT INTO messages VALUES (?,?,?,?,?)",
                (sid, 1, "user", json.dumps({"content": f"kickoff {marker}"}), _NOW))
    con.commit()
    con.close()


def test_grok_no_profile_single_db_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    (tmp_path / ".grok").mkdir()
    reader = GrokLogReader()
    assert reader.project_dirs() == [tmp_path / ".grok"]


def test_grok_profile_db_scanned_and_marker_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_home = tmp_path / "realhome"
    real_home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: real_home)
    (real_home / ".grok").mkdir()  # default db dir exists but empty
    reader = GrokLogReader()

    prof = tmp_path / "cli-profiles" / "grok" / "acct1"
    prof_db = prof / "home" / ".grok" / "grok.db"
    ws = "/Users/me/proj"
    marker = "at-pane:pane-grok-prof"
    _grok_db(prof_db, ws=ws, sid="abcdef012345", marker=marker)

    register_profile_home("grok", "acct1", prof)
    # The profile's separate db is now enumerated + watched.
    assert prof_db in reader.session_files()
    assert (prof / "home" / ".grok") in reader.project_dirs()
    # Marker binding scans the profile db too.
    found = reader.find_sessions_by_marker([marker])
    assert found == {marker: ("abcdef012345", ws)}


# ── attribution ───────────────────────────────────────────────────────────────

def _claude_usage(file_path: Path, cwd: str) -> TokenUsage:
    return TokenUsage(
        vendor="claude", input_tokens=10, output_tokens=5, cwd=cwd,
        session_id="sess-1", file_path=str(file_path), dedup_key="d1",
    )


def test_attribution_claude_profile_session_credited_to_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "default"))
    (tmp_path / "default" / "projects").mkdir(parents=True)
    reader = ClaudeLogReader()
    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")

    ws = "/Users/me/proj"
    attr.register_workspace(ws)
    encoded = encode_claude_cwd(ws)

    home = tmp_path / "cli-profiles" / "claude" / "acct1"
    prof_file = home / "projects" / encoded / "sess-1.jsonl"

    # No profile registered yet → profile file is NOT attributed (dropped).
    assert attr.attribute(_claude_usage(prof_file, ws)).workspace_path is None

    # After the profile pane registers its home, the same file credits the ws.
    register_profile_home("claude", "acct1", home)
    assert attr.attribute(_claude_usage(prof_file, ws)).workspace_path == ws


def test_attribution_claude_default_still_matches_with_profile_active(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: a non-profile (default-home) session still attributes even
    while a profile is active."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "default"))
    (tmp_path / "default" / "projects").mkdir(parents=True)
    reader = ClaudeLogReader()
    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")

    ws = "/Users/me/proj"
    attr.register_workspace(ws)
    encoded = encode_claude_cwd(ws)
    register_profile_home("claude", "acct1", tmp_path / "cli-profiles" / "claude" / "acct1")

    default_file = tmp_path / "default" / "projects" / encoded / "sess-9.jsonl"
    assert attr.attribute(_claude_usage(default_file, ws)).workspace_path == ws


# ── watcher ───────────────────────────────────────────────────────────────────

async def _noop(_u):  # noqa: ANN001
    return None


@pytest.mark.asyncio
async def test_watch_dir_adds_profile_home_lazily_and_dedups(tmp_path: Path) -> None:
    watcher = LogWatcher(sink=_noop)
    home = tmp_path / "cli-profiles" / "claude" / "acct1"
    home.mkdir(parents=True)

    # Before start(): no observer yet → no-op.
    assert watcher.watch_dir(home) is False

    watcher.start()
    try:
        assert watcher.watch_dir(home) is True          # newly scheduled
        assert home in watcher._watched_dirs            # noqa: SLF001
        assert watcher.watch_dir(home) is False         # dedup: already watched
        assert watcher.watch_dir(tmp_path / "nope") is False  # missing dir: no-op
    finally:
        watcher.stop()
