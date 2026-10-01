"""What macOS ``security`` prints for a stored password, for Keychain fakes."""

from __future__ import annotations


def _printable(raw: bytes) -> bool:
    return all(0x20 <= b < 0x7F for b in raw)


def security_w_output(secret: str) -> str:
    """``find-generic-password -w``: the password verbatim when every byte is
    printable ASCII, otherwise the whole password as lowercase hex."""
    raw = secret.encode("utf-8")
    return (secret if _printable(raw) else raw.hex()) + "\n"


def security_g_output(secret: str) -> str:
    """``find-generic-password -g``: a ``password:`` line (on stderr) that is
    either the quoted password or, when it holds a non-printable byte or a
    backslash, ``0x`` + uppercase hex followed by an escaped rendering."""
    raw = secret.encode("utf-8")
    if not raw:
        return "password: \n"
    if _printable(raw) and b"\\" not in raw:
        return f'password: "{secret}"\n'
    escaped = "".join(
        chr(b) if 0x20 <= b < 0x7F and b != 0x5C else f"\\{b:03o}" for b in raw
    )
    return f'password: 0x{raw.hex().upper()}  "{escaped}"\n'
