"""The workspace write path lives in a standard-library-only module.

fs_service re-exports it unchanged, and a separately packaged plugin backend
bundles it; these tests pin both halves of that arrangement and the one write
property no other test pinned: a single-call write replaces the file by rename.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from agent_team_backend import fs_service, fs_write

BACKEND_ROOT = Path(__file__).resolve().parents[1]
MOVED = (
    "_ENC_DISPLAY", "_ENC_FROM_LABEL", "_STAGING_MAX_AGE_S", "_STAGING_NAME_RE", "_UPLOAD_ID_RE",
    "_WRITE_PART_MAX_BYTES", "_WRITE_SIZE_LIMIT", "_resolve_mutation_safe", "_staging_path",
    "_sweep_stale_staging", "write_abort", "write_commit", "write_file", "write_part",
)


def test_fs_service_reexports_the_write_path_unchanged() -> None:
    for name in MOVED:
        assert getattr(fs_service, name) is getattr(fs_write, name), name


def test_the_write_path_imports_only_the_standard_library() -> None:
    probe = (
        "import sys\n"
        "import agent_team_backend.fs_write\n"
        "loaded = sorted(m for m in sys.modules if m.startswith('agent_team_backend'))\n"
        "third = sorted({m.split('.')[0] for m in sys.modules} - set(sys.stdlib_module_names)\n"
        "               - set(sys.builtin_module_names) - {'agent_team_backend', '__main__'}\n"
        "               - {'_distutils_hack', '_virtualenv', 'sitecustomize', 'usercustomize'})\n"
        "print(loaded); print(third)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], cwd=BACKEND_ROOT, capture_output=True, text=True, check=True,
    )
    loaded, third = result.stdout.splitlines()
    assert loaded == str([
        "agent_team_backend", "agent_team_backend.fs_write",
        "agent_team_backend.git_security", "agent_team_backend.path_guard",
    ])
    assert third == "[]"


def test_a_single_call_write_replaces_the_file_by_rename(tmp_path: Path) -> None:
    target = tmp_path / "doc.html"
    target.write_text("old", encoding="utf-8")
    before = target.stat()

    result = fs_service.write_file(str(tmp_path), "doc.html", "new", expected_mtime=before.st_mtime)

    assert result["ok"] is True
    assert target.read_text(encoding="utf-8") == "new"
    assert target.stat().st_ino != before.st_ino
    assert sorted(path.name for path in tmp_path.iterdir()) == ["doc.html"]
