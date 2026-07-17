"""fs_service.list_archive — zip/tar listing, caps, corruption, path safety."""

from __future__ import annotations

import io
import tarfile
import zipfile
from pathlib import Path

from agent_team_backend import fs_service


def _ws(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    return ws


def _write_zip(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("dir/", "")
        zf.writestr("dir/file.txt", "hello")
        zf.writestr("top.md", "# hi")


def _write_tgz(path: Path) -> None:
    with tarfile.open(path, "w:gz") as tf:
        d = tarfile.TarInfo("dir")
        d.type = tarfile.DIRTYPE
        tf.addfile(d)
        f = tarfile.TarInfo("dir/file.txt")
        data = b"hello"
        f.size = len(data)
        tf.addfile(f, io.BytesIO(data))


# ── Happy paths ─────────────────────────────────────────────────────────────
def test_zip_listing(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    _write_zip(ws / "a.zip")
    res = fs_service.list_archive(str(ws), "a.zip")
    assert res["ok"] is True
    assert res["total_entries"] == 3
    assert res["truncated"] is False
    by_name = {e["name"]: e for e in res["entries"]}
    assert by_name["dir/"]["is_dir"] is True
    assert by_name["dir/file.txt"] == {"name": "dir/file.txt", "size": 5, "is_dir": False}
    assert by_name["top.md"]["is_dir"] is False


def test_tar_gz_listing(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    _write_tgz(ws / "a.tar.gz")
    res = fs_service.list_archive(str(ws), "a.tar.gz")
    assert res["ok"] is True
    assert res["total_entries"] == 2
    assert res["truncated"] is False
    by_name = {e["name"]: e for e in res["entries"]}
    assert by_name["dir"]["is_dir"] is True
    assert by_name["dir/file.txt"] == {"name": "dir/file.txt", "size": 5, "is_dir": False}


# ── Caps ────────────────────────────────────────────────────────────────────
def test_entry_cap_truncates_at_2000(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    with zipfile.ZipFile(ws / "big.zip", "w") as zf:
        for i in range(2005):
            zf.writestr(f"f{i:04}.txt", "")
    res = fs_service.list_archive(str(ws), "big.zip")
    assert res["ok"] is True
    assert len(res["entries"]) == 2000
    assert res["total_entries"] == 2005
    assert res["truncated"] is True


def test_size_cap_rejects_over_100mb(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    _write_zip(ws / "huge.zip")
    # Sparse-grow past the cap: st_size is what the guard checks.
    with (ws / "huge.zip").open("r+b") as fh:
        fh.truncate(100 * 1024 * 1024 + 1)
    res = fs_service.list_archive(str(ws), "huge.zip")
    assert res["ok"] is False
    assert "too large" in res["error"]


# ── Errors ──────────────────────────────────────────────────────────────────
def test_corrupted_zip_rejected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (ws / "bad.zip").write_bytes(b"this is not a zip archive")
    res = fs_service.list_archive(str(ws), "bad.zip")
    assert res["ok"] is False
    assert "corrupted" in res["error"]


def test_corrupted_tar_rejected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (ws / "bad.tar").write_bytes(b"garbage" * 100)
    res = fs_service.list_archive(str(ws), "bad.tar")
    assert res["ok"] is False
    assert "corrupted" in res["error"]


def test_encrypted_zip_rejected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    with zipfile.ZipFile(ws / "enc.zip", "w") as zf:
        zf.writestr("secret.txt", "data")
    # stdlib cannot write real crypto; set the encrypted bit in the central
    # directory entry (general-purpose flag at offset 8 after PK\x01\x02).
    raw = bytearray((ws / "enc.zip").read_bytes())
    cdh = raw.index(b"PK\x01\x02")
    raw[cdh + 8] |= 0x1
    (ws / "enc.zip").write_bytes(bytes(raw))
    res = fs_service.list_archive(str(ws), "enc.zip")
    assert res["ok"] is False
    assert "encrypted" in res["error"]


def test_unsupported_extension_rejected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (ws / "a.rar").write_bytes(b"Rar!")
    res = fs_service.list_archive(str(ws), "a.rar")
    assert res["ok"] is False
    assert "unsupported archive type" in res["error"]


def test_missing_file_rejected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.list_archive(str(ws), "nope.zip")
    assert res["ok"] is False


# ── Path safety ─────────────────────────────────────────────────────────────
def test_path_escape_rejected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    _write_zip(tmp_path / "outside.zip")
    res = fs_service.list_archive(str(ws), "../outside.zip")
    assert res["ok"] is False
    assert "escape" in res["error"].lower()
