"""Secret files on POSIX: mode bits, exactly as the feature modules did them.

Every shape here is lifted from a site that used to do it inline — `os.open`
with the mode given at creation, an explicit `chmod` afterwards, a same-
directory temp file moved into place with `os.replace`. Nothing is new; the
point of collecting it is that macOS and Linux keep running this code while
Windows gets to run something else behind the same name.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

_OWNER_RW = 0o600
_OWNER_RWX = 0o700


def write_owner_only(path: Path, data: bytes) -> None:
    """Atomic 0600 write: a same-directory temp file that replaces `path`.

    The mode is given at creation rather than set afterwards: between a
    default-mode create and a chmod the file exists at whatever the umask
    allowed, and by then it has content. The explicit chmod after the write
    covers the other direction — `mkstemp` already creates 0600, but a file
    that is *exactly* 0600 is the contract, umask or not. `os.replace` carries
    the temp file's mode over to the final name.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".")
    tmp = Path(tmp_name)
    try:
        try:
            os.write(handle, data)
        finally:
            os.close(handle)
        os.chmod(tmp, _OWNER_RW)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


class PosixSecretFiles:
    """`SecretFiles` through mode bits — the one protection POSIX offers here."""

    def write_private(self, path: Path, data: bytes) -> None:
        write_owner_only(path, data)

    def write_private_plain(self, path: Path, data: bytes) -> None:
        write_owner_only(path, data)

    def read_private(self, path: Path) -> bytes:
        return path.read_bytes()

    def harden_file(self, path: Path) -> None:
        # Only touch a file that is actually wider than owner-only, so a read
        # path that hardens on every call does not rewrite metadata each time.
        if path.stat().st_mode & 0o077:
            os.chmod(path, _OWNER_RW)

    def make_private_dir(self, path: Path) -> None:
        path.mkdir(mode=_OWNER_RWX, parents=True, exist_ok=True)
        # `mkdir` leaves an existing directory's mode alone, and even a fresh
        # one is `mode & ~umask`; the chmod makes the leaf exactly 0700.
        os.chmod(path, _OWNER_RWX)


secret_files = PosixSecretFiles()
