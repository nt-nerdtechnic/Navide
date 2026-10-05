"""The workspace write path lives in a standard-library-only module.

fs_service re-exports it unchanged, and a separately packaged plugin backend
bundles it; these tests pin both halves of that arrangement and the one write
property no other test pinned: a single-call write replaces the file by rename.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

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
    # Only what importing fs_write adds counts: site hooks may load
    # third-party modules before any code runs (pywin32's .pth does on
    # Windows), and those are not the write path's imports.
    probe = (
        "import sys\n"
        "before = set(sys.modules)\n"
        "import agent_team_backend.fs_write\n"
        "added = set(sys.modules) - before\n"
        "loaded = sorted(m for m in sys.modules if m.startswith('agent_team_backend'))\n"
        "third = sorted({m.split('.')[0] for m in added} - set(sys.stdlib_module_names)\n"
        "               - set(sys.builtin_module_names) - {'agent_team_backend'})\n"
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


# ── concurrent writers ───────────────────────────────────────────────────────
#
# Every writer reads the same mtime and then writes with it as expected_mtime:
# exactly one may land, every other one must be told "conflict", and the
# winner must be told it won. os.replace is slowed down so that, without a
# lock, every writer passes the mtime check before any of them renames.

_SLOW_REPLACE_S = 0.3

_CHILD_WRITER = """
import json, os, sys, time
from agent_team_backend import fs_write

root, expected, content, call = sys.argv[1], float(sys.argv[2]), sys.argv[3], sys.argv[4]
real_replace = os.replace
def slow_replace(src, dst):
    time.sleep(float(sys.argv[5]))
    real_replace(src, dst)
os.replace = slow_replace
upload_id = os.urandom(16).hex()
if call == "commit":
    data = content.encode()
    staged = fs_write.write_part(root, "doc.html", upload_id, 0, __import__("base64").b64encode(data).decode())
    assert staged["ok"], staged
print("ready", flush=True)
sys.stdin.readline()
if call == "commit":
    result = fs_write.write_commit(root, "doc.html", upload_id, len(content.encode()), expected)
else:
    result = fs_write.write_file(root, "doc.html", content, expected_mtime=expected)
print(json.dumps(result), flush=True)
"""


def _assert_exactly_one_writer_won(
    root: Path, results: list[dict], contents: list[str], before_mtime: float
) -> None:
    winners = [i for i, result in enumerate(results) if result.get("ok") is True]
    assert len(winners) == 1, results
    for i, result in enumerate(results):
        if i != winners[0]:
            assert result.get("conflict") is True, result
    assert (root / "doc.html").read_text(encoding="utf-8") == contents[winners[0]]
    assert results[winners[0]]["mtime"] == (root / "doc.html").stat().st_mtime
    assert results[winners[0]]["mtime"] != before_mtime
    assert sorted(path.name for path in root.iterdir()) == ["doc.html"]


def _race_in_processes(root: Path, call: str, writers: int = 4) -> None:
    target = root / "doc.html"
    target.write_text("old", encoding="utf-8")
    before = target.stat().st_mtime
    contents = [f"writer {i} " * 20_000 for i in range(writers)]
    children = [
        subprocess.Popen(
            [sys.executable, "-c", _CHILD_WRITER, str(root), repr(before), content, call,
             str(_SLOW_REPLACE_S)],
            cwd=BACKEND_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        for content in contents
    ]
    try:
        for child in children:
            assert child.stdout.readline().strip() == "ready"
        for child in children:
            child.stdin.write("go\n")
            child.stdin.flush()
        results = [json.loads(child.stdout.readline()) for child in children]
    finally:
        for child in children:
            child.stdin.close()
            child.wait(timeout=30)
            child.stdout.close()
    _assert_exactly_one_writer_won(root, results, contents, before)


def test_concurrent_writes_from_separate_processes_land_exactly_once(tmp_path: Path) -> None:
    _race_in_processes(tmp_path, "write")


def test_concurrent_chunked_commits_from_separate_processes_land_exactly_once(tmp_path: Path) -> None:
    _race_in_processes(tmp_path, "commit")


def test_concurrent_writes_from_threads_land_exactly_once(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "doc.html"
    target.write_text("old", encoding="utf-8")
    before = target.stat().st_mtime
    real_replace = os.replace

    def slow_replace(src, dst):
        time.sleep(_SLOW_REPLACE_S)
        real_replace(src, dst)

    monkeypatch.setattr(os, "replace", slow_replace)
    contents = [f"thread {i} " * 20_000 for i in range(4)]
    results: list[dict] = [{} for _ in contents]
    start = threading.Barrier(len(contents))

    def write(i: int) -> None:
        start.wait()
        results[i] = fs_write.write_file(str(tmp_path), "doc.html", contents[i], expected_mtime=before)

    threads = [threading.Thread(target=write, args=(i,)) for i in range(len(contents))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    _assert_exactly_one_writer_won(tmp_path, results, contents, before)


def test_a_write_leaves_a_sibling_named_like_its_old_temp_file_alone(tmp_path: Path) -> None:
    (tmp_path / "doc.html").write_text("old", encoding="utf-8")
    (tmp_path / "doc.html.tmp").write_text("the user's own file", encoding="utf-8")

    result = fs_write.write_file(str(tmp_path), "doc.html", "new")

    assert result["ok"] is True
    assert (tmp_path / "doc.html").read_text(encoding="utf-8") == "new"
    assert (tmp_path / "doc.html.tmp").read_text(encoding="utf-8") == "the user's own file"


@pytest.mark.skipif(sys.platform == "win32", reason="Windows cannot remove a lock file another handle has open")
def test_a_writer_woken_on_a_removed_lock_file_waits_for_the_current_one(
    tmp_path: Path, monkeypatch
) -> None:
    # The previous holder removed the lock file this writer was waiting on, and
    # a newcomer already holds the new one: entering now would let two in.
    lock_path = tmp_path / ".doc.html.lock"
    real_lock = fs_write._lock_fd
    rival: list[int] = []

    def lock_then_find_the_file_replaced(fd: int) -> None:
        real_lock(fd)
        if not rival:
            os.unlink(lock_path)
            rival.append(os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600))
            real_lock(rival[0])

            def release_rival() -> None:
                fs_write._unlock_fd(rival[0])
                os.close(rival[0])

            threading.Timer(_SLOW_REPLACE_S, release_rival).start()

    monkeypatch.setattr(fs_write, "_lock_fd", lock_then_find_the_file_replaced)
    started = time.monotonic()
    with fs_write._target_lock(tmp_path / "doc.html"):
        waited = time.monotonic() - started
    assert waited >= _SLOW_REPLACE_S
    assert not lock_path.exists()
