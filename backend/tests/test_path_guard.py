"""The path guard is a stdlib-only module that fs_service re-exports."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from agent_team_backend import fs_service, path_guard

_FORBIDDEN = (
    "agent_team_backend.fs_service",
    "agent_team_backend.projects",
    "agent_team_backend.db",
    "mammoth",
    "openpyxl",
    "send2trash",
)


def test_importing_the_guard_pulls_in_no_fs_service_or_third_party_module() -> None:
    script = (
        "import sys\n"
        "import agent_team_backend.path_guard\n"
        f"print(','.join(m for m in {_FORBIDDEN!r} if m in sys.modules))\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=True,
    )
    assert result.stdout.strip() == ""


def test_fs_service_re_exports_the_same_objects() -> None:
    assert fs_service._resolve_safe is path_guard._resolve_safe
    assert fs_service.FsError is path_guard.FsError
    assert fs_service._reject_protected_internal_dir is path_guard._reject_protected_internal_dir
    assert fs_service.PROJECT_DIR_NAME is path_guard.PROJECT_DIR_NAME


def _workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    (ws / ".agent-team" / "plans").mkdir(parents=True)
    (ws / ".agent-team" / "plans" / "x.html").write_text("<p>x</p>", encoding="utf-8")
    (ws / ".agent-team" / "chat-threads.json").write_text("{}", encoding="utf-8")
    return ws


def test_parent_traversal_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(path_guard.FsError, match="escape"):
        path_guard._resolve_safe(str(_workspace(tmp_path)), "../..")


def test_symlink_escape_is_rejected(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    (ws / "link.txt").symlink_to(outside)
    with pytest.raises(path_guard.FsError, match="escape"):
        path_guard._resolve_safe(str(ws), "link.txt")


def test_internal_state_file_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(path_guard.FsError, match="protected"):
        path_guard._resolve_safe(str(_workspace(tmp_path)), ".agent-team/chat-threads.json")


def test_plan_document_is_allowed(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    target = path_guard._resolve_safe(str(ws), ".agent-team/plans/x.html")
    assert target == (ws / ".agent-team" / "plans" / "x.html").resolve()
