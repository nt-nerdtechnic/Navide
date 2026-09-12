"""`osplat.secret_files`: how each platform actually protects a secret file.

POSIX is tested against the real implementation on whatever machine runs the
suite — mode bits are mode bits. The Windows implementation is imported
directly and run with `crypt32` stubbed, which tests everything *around* the
Win32 call (the header, the blob marshalling, legacy plaintext, atomicity)
but not `CryptProtectData` itself; that needs a Windows box.
"""

from __future__ import annotations

import ctypes
import os
import stat
import sys

import pytest

from agent_team_backend import osplat
from agent_team_backend.osplat import _windows, _posix_secrets


@pytest.mark.skipif(sys.platform == "win32", reason="mode bits are POSIX")
class TestPosixModeBits:
    def test_the_selected_implementation_is_the_posix_one(self):
        assert isinstance(osplat.secret_files, _posix_secrets.PosixSecretFiles)

    def test_write_private_is_owner_only_and_round_trips(self, tmp_path):
        path = tmp_path / "keys.json"
        osplat.secret_files.write_private(path, b"secret")
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert osplat.secret_files.read_private(path) == b"secret"

    def test_write_private_plain_is_owner_only_and_left_as_is(self, tmp_path):
        path = tmp_path / "token"
        osplat.secret_files.write_private_plain(path, b"tok")
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert path.read_bytes() == b"tok"

    # A wide umask must not widen the file: the mode is set explicitly, not
    # inherited from the process.
    def test_write_ignores_a_permissive_umask(self, tmp_path):
        old = os.umask(0o000)
        try:
            path = tmp_path / "wide"
            osplat.secret_files.write_private(path, b"x")
        finally:
            os.umask(old)
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600

    def test_replacing_a_wider_file_ends_up_owner_only(self, tmp_path):
        path = tmp_path / "old"
        path.write_bytes(b"old")
        path.chmod(0o644)
        osplat.secret_files.write_private(path, b"new")
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert path.read_bytes() == b"new"

    def test_a_failed_write_leaves_no_temp_file_behind(self, tmp_path, monkeypatch):
        path = tmp_path / "target"

        def boom(*args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(os, "replace", boom)
        with pytest.raises(OSError):
            osplat.secret_files.write_private(path, b"x")
        assert list(tmp_path.iterdir()) == []

    def test_harden_file_tightens_only_a_wide_file(self, tmp_path):
        path = tmp_path / "wide"
        path.write_bytes(b"x")
        path.chmod(0o644)
        osplat.secret_files.harden_file(path)
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        with pytest.raises(FileNotFoundError):
            osplat.secret_files.harden_file(tmp_path / "missing")

    def test_make_private_dir_is_owner_only_even_when_it_already_existed(self, tmp_path):
        path = tmp_path / "a" / "b"
        osplat.secret_files.make_private_dir(path)
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o700
        path.chmod(0o755)
        osplat.secret_files.make_private_dir(path)
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o700


class _FakeCrypt32:
    """Stands in for `ctypes.windll.crypt32`: XORs the blob so the ciphertext
    is visibly different from the plaintext, and records the flags."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []
        self._keep: list[object] = []  # output buffers must outlive the call
        self.fail = False

    @staticmethod
    def _transform(data: bytes) -> bytes:
        return bytes(b ^ 0x5A for b in data)

    def _run(self, name, blob_in, flags, blob_out) -> int:
        self.calls.append((name, flags))
        if self.fail:
            return 0
        src = blob_in._obj
        out = self._transform(ctypes.string_at(src.pbData, src.cbData))
        buffer = ctypes.create_string_buffer(out, len(out))
        self._keep.append(buffer)
        dst = blob_out._obj
        dst.cbData = len(out)
        dst.pbData = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char))
        return 1

    def CryptProtectData(self, blob_in, descr, entropy, reserved, prompt, flags, blob_out):
        return self._run("CryptProtectData", blob_in, flags, blob_out)

    def CryptUnprotectData(self, blob_in, descr, entropy, reserved, prompt, flags, blob_out):
        return self._run("CryptUnprotectData", blob_in, flags, blob_out)


@pytest.fixture
def crypt32(monkeypatch):
    fake = _FakeCrypt32()
    monkeypatch.setattr(_windows, "_crypt32", lambda: fake)
    monkeypatch.setattr(_windows, "_local_free", lambda pointer: None)
    return fake


class TestWindowsDpapi:
    """The Windows implementation, with the Win32 calls stubbed."""

    def test_write_private_stores_ciphertext_behind_the_magic_header(self, tmp_path, crypt32):
        path = tmp_path / "keys.json"
        _windows.secret_files.write_private(path, b"secret")
        raw = path.read_bytes()
        assert raw.startswith(_windows.DPAPI_MAGIC)
        assert raw[len(_windows.DPAPI_MAGIC):] == _FakeCrypt32._transform(b"secret")
        assert b"secret" not in raw

    def test_read_private_unwraps_what_write_private_stored(self, tmp_path, crypt32):
        path = tmp_path / "keys.json"
        _windows.secret_files.write_private(path, b"round trip")
        assert _windows.secret_files.read_private(path) == b"round trip"
        assert [name for name, _ in crypt32.calls] == ["CryptProtectData", "CryptUnprotectData"]

    # A headless backend must never pop a credential dialog.
    def test_dpapi_is_called_with_ui_forbidden(self, tmp_path, crypt32):
        _windows.secret_files.write_private(tmp_path / "k", b"x")
        assert all(flags & 0x1 for _, flags in crypt32.calls)

    # Files written before this seam existed (or copied over from a POSIX
    # machine) carry no header and are read as they are.
    def test_a_legacy_plaintext_file_is_still_readable(self, tmp_path, crypt32):
        path = tmp_path / "legacy.json"
        path.write_bytes(b'{"x25519_private": "abc"}')
        assert _windows.secret_files.read_private(path) == b'{"x25519_private": "abc"}'
        assert crypt32.calls == []

    def test_write_private_plain_is_not_wrapped(self, tmp_path, crypt32):
        path = tmp_path / "backend-ws-token"
        _windows.secret_files.write_private_plain(path, b"tok")
        assert path.read_bytes() == b"tok"
        assert crypt32.calls == []

    def test_a_failed_dpapi_call_raises_oserror_and_writes_nothing(self, tmp_path, crypt32):
        crypt32.fail = True
        path = tmp_path / "keys.json"
        with pytest.raises(OSError):
            _windows.secret_files.write_private(path, b"x")
        assert not path.exists()
        assert list(tmp_path.iterdir()) == []

    def test_a_failed_replace_leaves_no_temp_file_behind(self, tmp_path, crypt32, monkeypatch):
        def boom(*args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(os, "replace", boom)
        with pytest.raises(OSError):
            _windows.secret_files.write_private(tmp_path / "k", b"x")
        assert list(tmp_path.iterdir()) == []

    def test_read_private_of_a_missing_file_raises_like_a_plain_read(self, tmp_path, crypt32):
        with pytest.raises(FileNotFoundError):
            _windows.secret_files.read_private(tmp_path / "missing")

    # Directory ACLs are out of scope on Windows (see `_windows`); the seam
    # still creates the directory and still reports a missing file.
    def test_directory_and_harden_are_creation_only(self, tmp_path, crypt32):
        target = tmp_path / "a" / "b"
        _windows.secret_files.make_private_dir(target)
        assert target.is_dir()
        with pytest.raises(FileNotFoundError):
            _windows.secret_files.harden_file(tmp_path / "missing")
        (tmp_path / "present").write_bytes(b"x")
        _windows.secret_files.harden_file(tmp_path / "present")
