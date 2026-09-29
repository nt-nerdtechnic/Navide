"""fs.read_range: byte-range reads with no whole-file size limit."""

from __future__ import annotations

import base64
import hashlib
import os
import stat
from pathlib import Path

import pytest

from agent_team_backend import fs_service, osplat


def _page_through(workspace: Path, rel_path: str, step: int) -> bytes:
    parts: list[bytes] = []
    offset = 0
    while True:
        result = fs_service.read_range(str(workspace), rel_path, offset, step)
        assert result["ok"] is True
        data = base64.b64decode(result["data_base64"])
        parts.append(data)
        offset += len(data)
        if result["eof"]:
            return b"".join(parts)
        assert data


def test_a_file_over_the_editor_limit_is_read_in_full_by_paging(tmp_path: Path) -> None:
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    payload = (b"0123456789abcdef" * 1024) * 400  # 6.4 MB
    target = plans / "huge.html"
    target.write_bytes(payload)
    assert len(payload) > fs_service._READ_SIZE_LIMIT

    # The whole-file reader still refuses it: the limit is unchanged for others.
    refused = fs_service.read_file(str(tmp_path), ".agent-team/plans/huge.html")
    assert refused["ok"] is False and "too large" in refused["error"]

    assembled = _page_through(tmp_path, ".agent-team/plans/huge.html", 96 * 1024)
    assert len(assembled) == len(payload)
    assert hashlib.sha256(assembled).hexdigest() == hashlib.sha256(payload).hexdigest()


def test_range_metadata_and_eof(tmp_path: Path) -> None:
    (tmp_path / "a.txt").write_bytes(b"hello world")
    result = fs_service.read_range(str(tmp_path), "a.txt", 6, 100)
    assert result["ok"] is True
    assert base64.b64decode(result["data_base64"]) == b"world"
    assert (result["offset"], result["size"], result["eof"]) == (6, 11, True)
    assert isinstance(result["mtime"], float)
    inner = fs_service.read_range(str(tmp_path), "a.txt", 0, 5)
    assert inner["eof"] is False
    assert fs_service.read_range(str(tmp_path), "a.txt", 11, 5)["eof"] is True


def test_invalid_ranges_and_paths_are_rejected(tmp_path: Path) -> None:
    (tmp_path / "a.txt").write_bytes(b"x")
    too_long = fs_service._READ_RANGE_MAX_BYTES + 1
    for offset, length in ((-1, 1), (0, 0), (0, too_long), (True, 1), (0, "5"), (None, 1)):
        assert fs_service.read_range(str(tmp_path), "a.txt", offset, length)["ok"] is False  # type: ignore[arg-type]
    assert fs_service.read_range(str(tmp_path), "../outside.txt", 0, 1)["ok"] is False
    assert fs_service.read_range(str(tmp_path), "missing.txt", 0, 1)["ok"] is False
    (tmp_path / "dir").mkdir()
    assert fs_service.read_range(str(tmp_path), "dir", 0, 1)["error"] == "not a file"


# ── chunked writes ──────────────────────────────────────────────────────────

UPLOAD = "0123456789abcdef0123456789abcdef"


def _can_symlink() -> bool:
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        try:
            (Path(directory) / "l").symlink_to(Path(directory))
        except (OSError, NotImplementedError):
            return False
    return True


_CAN_SYMLINK = _can_symlink()


def _stage(workspace: Path, rel_path: str, payload: bytes, step: int = 96 * 1024, upload: str = UPLOAD) -> None:
    offset = 0
    while True:
        part = payload[offset : offset + step]
        result = fs_service.write_part(str(workspace), rel_path, upload, offset, base64.b64encode(part).decode())
        assert result == {"ok": True, "size": offset + len(part)}
        offset += len(part)
        if offset >= len(payload):
            return


def test_a_multi_megabyte_file_is_written_in_parts_and_swapped_in_atomically(tmp_path: Path) -> None:
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    target = plans / "huge.html"
    target.write_bytes(b"old")
    if osplat.paths.enforces_posix_modes():
        os.chmod(target, 0o640)
    payload = (b"0123456789abcdef" * 1024) * 400  # 6.4 MB: far past one WebSocket / Backend Wire frame
    rel = ".agent-team/plans/huge.html"

    _stage(tmp_path, rel, payload)
    assert target.read_bytes() == b"old"  # nothing visible until commit
    committed = fs_service.write_commit(str(tmp_path), rel, UPLOAD, len(payload), target.stat().st_mtime)

    assert committed["ok"] is True and committed["mtime"] == target.stat().st_mtime
    assert hashlib.sha256(target.read_bytes()).hexdigest() == hashlib.sha256(payload).hexdigest()
    if osplat.paths.enforces_posix_modes():
        assert stat.S_IMODE(target.stat().st_mode) == 0o640
    assert list(plans.glob(".*.upload")) == []


def test_commit_refuses_when_the_file_changed_on_disk_and_discards_the_upload(tmp_path: Path) -> None:
    target = tmp_path / "a.html"
    target.write_text("v1")
    stale = target.stat().st_mtime - 5
    _stage(tmp_path, "a.html", b"v2 bytes")
    result = fs_service.write_commit(str(tmp_path), "a.html", UPLOAD, len(b"v2 bytes"), stale)
    assert result["ok"] is False and result["conflict"] is True and result["error"] == "file changed on disk"
    assert target.read_text() == "v1"
    assert list(tmp_path.glob(".*.upload")) == []


def test_commit_without_expected_mtime_creates_a_new_file(tmp_path: Path) -> None:
    _stage(tmp_path, "new/dir/n.html", b"fresh")
    assert fs_service.write_commit(str(tmp_path), "new/dir/n.html", UPLOAD, 5)["ok"] is True
    assert (tmp_path / "new/dir/n.html").read_bytes() == b"fresh"


def test_out_of_order_incomplete_and_invalid_uploads_are_rejected(tmp_path: Path) -> None:
    b64 = base64.b64encode(b"abc").decode()
    assert fs_service.write_part(str(tmp_path), "f.html", UPLOAD, 0, b64)["ok"] is True
    assert fs_service.write_part(str(tmp_path), "f.html", UPLOAD, 5, b64)["error"] == "upload part out of order"
    # the failed part is not appended, the upload is still consistent
    assert fs_service.write_commit(str(tmp_path), "f.html", UPLOAD, 99)["error"] == "upload incomplete"
    assert list(tmp_path.glob(".*.upload")) == []  # a failed commit cleans up
    assert fs_service.write_commit(str(tmp_path), "f.html", UPLOAD, 3)["error"] == "no such upload"
    for bad_id in ("short", "../../etc/passwd", "G" * 32, None):
        assert fs_service.write_part(str(tmp_path), "f.html", bad_id, 0, b64)["ok"] is False  # type: ignore[arg-type]
    for offset in (-1, True, "0"):
        assert fs_service.write_part(str(tmp_path), "f.html", UPLOAD, offset, b64)["ok"] is False  # type: ignore[arg-type]
    assert fs_service.write_part(str(tmp_path), "f.html", UPLOAD, 0, "not base64!!")["ok"] is False
    too_big = base64.b64encode(b"x" * (fs_service._WRITE_PART_MAX_BYTES + 1)).decode()
    assert fs_service.write_part(str(tmp_path), "f.html", UPLOAD, 0, too_big)["error"] == "part too large"


def test_chunked_writes_stay_inside_the_workspace_and_off_protected_paths(tmp_path: Path) -> None:
    b64 = base64.b64encode(b"x").decode()
    assert fs_service.write_part(str(tmp_path), "../outside.html", UPLOAD, 0, b64)["ok"] is False
    assert fs_service.write_part(str(tmp_path), ".git/config", UPLOAD, 0, b64)["ok"] is False
    (tmp_path / "d.html").mkdir()
    assert fs_service.write_part(str(tmp_path), "d.html", UPLOAD, 0, b64)["error"] == "path is a directory"


def test_abort_removes_the_staged_file_and_is_idempotent(tmp_path: Path) -> None:
    _stage(tmp_path, "a.html", b"partial")
    assert len(list(tmp_path.glob(".*.upload"))) == 1
    assert fs_service.write_abort(str(tmp_path), "a.html", UPLOAD) == {"ok": True}
    assert fs_service.write_abort(str(tmp_path), "a.html", UPLOAD) == {"ok": True}
    assert list(tmp_path.glob(".*.upload")) == []


# ── plan documents read past the editor limit ───────────────────────────────


@pytest.mark.parametrize(
    ("rel_path", "expected"),
    [
        (".agent-team/plans/x.html", True),
        (".agent-team/reports/x.md", True),
        ("docs/plans/x.plan.md", True),
        ("nested_repo/.agent-team/plans/x.html", True),
        (".agent-team/plans/_template.html", False),
        (".agent-team/plans/.hidden.html", False),
        (".agent-team/plans/x.txt", False),
        (".agent-team/plans/sub/x.html", False),
        ("src/x.html", False),
        ("x.html", False),
        (".agent-team/plans/../x.html", False),
    ],
)
def test_only_plan_documents_are_exempt_from_the_editor_read_limit(rel_path: str, expected: bool) -> None:
    assert fs_service.is_plan_document_path(rel_path) is expected


def test_read_file_ws_handler_lifts_the_limit_for_plan_documents_only(tmp_path: Path) -> None:
    import asyncio

    from agent_team_backend import ws_handlers

    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    body = "<p>" + "x" * (6 * 1024 * 1024) + "</p>"
    (plans / "huge.html").write_text(body, encoding="utf-8", newline="")
    (tmp_path / "huge.txt").write_text(body, encoding="utf-8", newline="")

    class _Session:
        def __init__(self) -> None:
            self.sent: list[dict] = []

        async def send_json(self, message: dict) -> None:
            self.sent.append(message)

    async def read(rel: str) -> dict:
        session = _Session()
        await ws_handlers.fs_read_file(session, "1", "fs.read_file", {"workspace_path": str(tmp_path), "rel_path": rel})
        return session.sent[0]["payload"]

    plan = asyncio.run(read(".agent-team/plans/huge.html"))
    other = asyncio.run(read("huge.txt"))
    assert plan["ok"] is True and len(plan["content"]) == len(body)  # no multi-MB diff on failure
    assert hashlib.sha256(plan["content"].encode()).hexdigest() == hashlib.sha256(body.encode()).hexdigest()
    assert other["ok"] is False and "too large" in other["error"]


# ── hardening round ─────────────────────────────────────────────────────────


@pytest.mark.skipif(not _CAN_SYMLINK, reason="needs symlink creation (unavailable to unprivileged Windows)")
@pytest.mark.parametrize("nofollow", [True, False], ids=["O_NOFOLLOW", "no-O_NOFOLLOW"])
def test_a_planted_symlink_staging_file_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nofollow: bool) -> None:
    if not nofollow:  # as on Windows, where the open itself follows the link
        monkeypatch.delattr(os, "O_NOFOLLOW", raising=False)
    victim = tmp_path / "victim.txt"
    victim.write_text("keep")
    staging = tmp_path / f".a.html.{UPLOAD}.upload"
    staging.symlink_to(victim)
    b64 = base64.b64encode(b"evil").decode()
    assert fs_service.write_part(str(tmp_path), "a.html", UPLOAD, 0, b64)["ok"] is False
    assert fs_service.write_part(str(tmp_path), "a.html", UPLOAD, 4, b64)["ok"] is False
    assert fs_service.write_commit(str(tmp_path), "a.html", UPLOAD, 4)["ok"] is False
    assert victim.read_text() == "keep" and not (tmp_path / "a.html").exists()


@pytest.mark.skipif(not _CAN_SYMLINK, reason="needs symlink creation (unavailable to unprivileged Windows)")
def test_a_staging_symlink_planted_after_the_check_is_still_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Without O_NOFOLLOW (Windows) only the lstat check guards the open; a link
    # swapped in between that check and the open must still be refused.
    monkeypatch.delattr(os, "O_NOFOLLOW", raising=False)
    victim = tmp_path / "victim.txt"
    victim.write_text("keep")
    _stage(tmp_path, "a.html", b"abcd")
    staging = tmp_path / f".a.html.{UPLOAD}.upload"
    real_open = os.open

    def racing_open(path, flags, mode=0o777):  # type: ignore[no-untyped-def]
        if Path(path) == staging:
            staging.unlink()
            staging.symlink_to(victim)
        return real_open(path, flags, mode)

    monkeypatch.setattr(os, "open", racing_open)
    b64 = base64.b64encode(b"evil").decode()
    assert fs_service.write_part(str(tmp_path), "a.html", UPLOAD, 4, b64)["ok"] is False
    assert victim.read_text() == "keep"


def test_stale_staging_files_are_swept_but_nothing_else(tmp_path: Path) -> None:
    old = tmp_path / f".x.html.{'1' * 32}.upload"
    fresh = tmp_path / f".y.html.{'2' * 32}.upload"
    lookalikes = [tmp_path / "notes.upload", tmp_path / f"x.html.{'3' * 32}.upload", tmp_path / ".hidden"]
    for path in (old, fresh, *lookalikes):
        path.write_text("x")
    past = old.stat().st_mtime - 7200
    for path in (old, *lookalikes):
        os.utime(path, (past, past))
    _stage(tmp_path, "z.html", b"data", upload="4" * 32)
    assert not old.exists() and fresh.exists()
    assert all(path.exists() for path in lookalikes)


@pytest.mark.skipif(not _CAN_SYMLINK, reason="needs symlink creation (unavailable to unprivileged Windows)")
def test_a_symlink_to_a_non_plan_file_keeps_the_normal_read_limit(tmp_path: Path) -> None:
    import asyncio

    from agent_team_backend import ws_handlers

    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    big = tmp_path / "big.txt"
    big.write_bytes(b"x" * (6 * 1024 * 1024))
    (plans / "link.html").symlink_to(big)
    (plans / "real.html").write_bytes(b"x" * (6 * 1024 * 1024))
    assert fs_service.is_plan_document(str(tmp_path), ".agent-team/plans/real.html") is True
    assert fs_service.is_plan_document(str(tmp_path), ".agent-team/plans/link.html") is False

    class _S:
        sent: list = []

        async def send_json(self, m: dict) -> None:
            self.sent.append(m)

    async def read(rel: str) -> dict:
        session = _S()
        session.sent = []
        await ws_handlers.fs_read_file(session, "1", "fs.read_file", {"workspace_path": str(tmp_path), "rel_path": rel})
        return session.sent[0]["payload"]

    assert asyncio.run(read(".agent-team/plans/real.html"))["ok"] is True
    assert "too large" in asyncio.run(read(".agent-team/plans/link.html"))["error"]
