"""`osplat.secret_files`: how each platform actually protects a secret file.

POSIX is tested against the real implementation on whatever machine runs the
suite — mode bits are mode bits. The Windows implementation is imported
directly and run with `crypt32` and `subprocess.run` stubbed, which tests
everything *around* the Win32 calls (the header, the blob marshalling, legacy
plaintext, atomicity, the `icacls` command shape) but not `CryptProtectData`
or `icacls` themselves. Those need a Windows box, and the win32-only class at
the end of this file is what checks them there.
"""

from __future__ import annotations

import ctypes
import os
import stat
import re
import subprocess
import sys
from types import SimpleNamespace

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

    # Mode bits protect nothing on NTFS, so the seam still has to create the
    # directory and still has to report a missing file the POSIX way.
    def test_the_directory_is_created_and_a_missing_file_still_raises(
        self, tmp_path, crypt32, icacls
    ):
        target = tmp_path / "a" / "b"
        _windows.secret_files.make_private_dir(target)
        assert target.is_dir()
        with pytest.raises(FileNotFoundError):
            _windows.secret_files.harden_file(tmp_path / "missing")
        # Nothing was handed to icacls for a file that does not exist.
        assert [argv[1] for argv in icacls.argvs] == [str(target)]


class _FakeIcacls:
    """Stands in for `subprocess.run`: records argv, answers as told."""

    def __init__(self) -> None:
        self.argvs: list[list[str]] = []
        self.returncode = 0
        self.raises: Exception | None = None

    def __call__(self, argv, **kwargs):
        self.argvs.append(list(argv))
        if self.raises is not None:
            raise self.raises
        return SimpleNamespace(returncode=self.returncode, stdout="", stderr="denied")


@pytest.fixture
def icacls(monkeypatch):
    fake = _FakeIcacls()
    monkeypatch.setattr(_windows.subprocess, "run", fake)
    monkeypatch.setenv("USERNAME", "navide")
    monkeypatch.setattr(_windows.os, "getlogin", lambda: "navide")
    return fake


class TestWindowsOwnerOnlyAcl:
    """The ACL that replaces mode bits, with `icacls` stubbed."""

    # `/inheritance:r` drops what the parent handed down (SYSTEM,
    # Administrators, and on a widened tree, Users); `/grant:r` replaces this
    # account's grant instead of adding a second ACE, so a repeated write does
    # not accumulate them.
    def test_write_private_plain_restricts_the_file_after_the_replace(
        self, tmp_path, crypt32, icacls
    ):
        path = tmp_path / "backend-ws-token"
        _windows.secret_files.write_private_plain(path, b"tok")
        assert path.read_bytes() == b"tok"
        assert icacls.argvs == [
            ["icacls", str(path), "/inheritance:r", "/grant:r", "navide:F"]
        ]

    def test_harden_file_restricts_an_existing_file(self, tmp_path, crypt32, icacls):
        path = tmp_path / "hosts.yml"
        path.write_bytes(b"token: x")
        _windows.secret_files.harden_file(path)
        assert icacls.argvs == [
            ["icacls", str(path), "/inheritance:r", "/grant:r", "navide:F"]
        ]

    # A directory needs the object and container inherit flags, so the files
    # written into it afterwards start owner-only too.
    def test_make_private_dir_grants_inheritable_rights(self, tmp_path, crypt32, icacls):
        path = tmp_path / "vault"
        _windows.secret_files.make_private_dir(path)
        assert icacls.argvs == [
            ["icacls", str(path), "/inheritance:r", "/grant:r", "navide:(OI)(CI)F"]
        ]

    # The secret is already written and correct by the time icacls runs. A box
    # where it is missing or refuses must still start, with the failure in the
    # log rather than in the caller.
    def test_a_failing_icacls_is_logged_and_swallowed(self, tmp_path, crypt32, icacls):
        icacls.returncode = 5
        path = tmp_path / "token"
        _windows.secret_files.write_private_plain(path, b"tok")
        assert path.read_bytes() == b"tok"

        icacls.raises = OSError("icacls not found")
        _windows.secret_files.write_private_plain(path, b"tok2")
        assert path.read_bytes() == b"tok2"

        icacls.raises = subprocess.TimeoutExpired("icacls", 10.0)
        _windows.secret_files.write_private_plain(path, b"tok3")
        assert path.read_bytes() == b"tok3"

    # No console attached (a service-started backend): `os.getlogin` raises and
    # the environment is the other place the session's user name is written.
    def test_the_account_name_falls_back_to_the_environment(
        self, tmp_path, crypt32, icacls, monkeypatch
    ):
        monkeypatch.setattr(_windows.os, "getlogin", _raise_no_console)
        monkeypatch.setenv("USERNAME", "from-env")
        _windows.secret_files.write_private_plain(tmp_path / "token", b"t")
        assert icacls.argvs[0][-1] == "from-env:F"

    def test_without_an_account_name_nothing_is_run(
        self, tmp_path, crypt32, icacls, monkeypatch
    ):
        monkeypatch.setattr(_windows.os, "getlogin", _raise_no_console)
        monkeypatch.delenv("USERNAME", raising=False)
        path = tmp_path / "token"
        _windows.secret_files.write_private_plain(path, b"t")
        assert path.read_bytes() == b"t"
        assert icacls.argvs == []


def _raise_no_console():
    raise OSError("no controlling console")


@pytest.mark.skipif(sys.platform != "win32", reason="a real ACL needs a real NTFS")
class TestWindowsAclForReal:
    """The one check that runs `icacls` against the file it just protected.

    Everything above stubs the call; this is what proves the flags mean what
    the command shape claims — that after `write_private_plain` no *user*
    account but this one can reach the file.

    The machine's own principals are not user accounts and they stay. A file
    created here carries SYSTEM, and for an administrator the local
    Administrators group, as *explicit* ACEs taken from the creating process
    token's default DACL: `/inheritance:r` does not touch them because they
    were never inherited, and `/grant:r` rewrites only the entry it names.
    Removing them would buy nothing anyway — an administrator holds
    SeTakeOwnership and can put any DACL back — so this is the same boundary
    0600 draws on POSIX, where root reads the file too. What must never appear
    is a second person.
    """

    #: What the OS itself and its administrators are called, as an en-US
    #: Windows prints them; a localized box would need the SIDs (S-1-5-18,
    #: S-1-5-32-544) resolved instead, and neither CI nor a dev box is one.
    #: OWNER RIGHTS (S-1-3-4) is not a party at all: it is whoever owns the
    #: file, which is the account that wrote it — the same principal the
    #: named ACE above grants, spelled the way the creating token's default
    #: DACL stamps it.
    _MACHINE_PRINCIPALS = {
        "nt authority\\system",
        "builtin\\administrators",
        "owner rights",
    }

    def test_no_other_user_account_appears_in_the_dacl(self, tmp_path):
        path = tmp_path / "backend-ws-token"
        osplat.secret_files.write_private_plain(path, b"tok")
        assert path.read_bytes() == b"tok"
        proc = subprocess.run(
            ["icacls", str(path)], capture_output=True, text=True, timeout=30
        )
        assert proc.returncode == 0, proc.stderr
        # `icacls <file>` prints the path, then one `ACCOUNT:(rights)` entry
        # per ACE, then a summary line ("Successfully processed 1 files;
        # Failed processing 0 files") — which is why an ACE is recognised by
        # its shape rather than by skipping lines that look like a summary.
        ace_re = re.compile(r"^(?P<account>[^:]+):\((?P<rights>[^)]*)\)")
        aces = []
        for line in proc.stdout.splitlines():
            text = line.replace(str(path), "", 1).strip()
            if ace_re.match(text):
                aces.append(text)
        assert aces, f"no ACE printed: {proc.stdout!r}"
        user = _windows._current_user()
        assert user

        def account_of(ace: str) -> str:
            return ace.split(":", 1)[0]

        mine = [a for a in aces if account_of(a).split("\\")[-1].casefold() == user.casefold()]
        assert mine, f"this account cannot reach its own secret: {aces!r}"
        for ace in aces:
            if ace in mine:
                continue
            assert account_of(ace).casefold() in self._MACHINE_PRINCIPALS, (
                f"a third party is in the DACL: {ace!r}"
            )
