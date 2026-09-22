"""Share codes: the key travels with the person, never with the server.

A bundle handed to somebody on another account cannot be sealed with the key
``sync_keyring`` holds. That key belongs to one account by construction — it is
minted per account and handed between *paired devices* — and the whole point of
a share is that the reader is not on it. So each share mints a key of its own,
spends it once, and puts it in the code the sender copies out:

    NVD-XXXXXXXX-XXXXXXXX-…   ← shareId (16 bytes) ‖ key (32 bytes) ‖ checksum
        │           │
        │           └─ base32, grouped, so it survives being read aloud
        └─ prefix, so a code pasted into a chat is recognisable as one

The server is handed the ciphertext and nothing else. That is not a rule this
module asks callers to keep — it is why the key is generated here and returned
only inside the code: ``seal_bundle`` gives back a blob, ``encode_share_code``
gives back a string for the human, and there is no shape of this API that hands
a key to anything that talks to the network.

The checksum is here because these codes are transcribed by hand. Without it a
mistyped character reaches the server as a ``shareId`` nobody has, and the
answer — "no such share" — reads exactly like the sender having revoked it. Two
bytes of SHA-256 turn that into "this code is mistyped", on this machine,
before any request leaves it.

Two shapes are deliberate:

*The bundle is gzipped before it is sealed, not after.* Compressing ciphertext
does nothing, and the size gate that matters is the one on what gets uploaded.

*The bundle version is a cleartext byte at the front of the blob, and is also
the AEAD associated data.* A reader has to know which version it is holding
before it can decide how to read it, and binding it as AAD means the byte
cannot be edited without the tag failing — it is readable, not trustworthy on
its own, which is the exact distinction AAD exists for.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import os
import zlib
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

#: Human-facing prefix. Stripped on the way in, so a code pasted with or
#: without it is the same code.
CODE_PREFIX = "NVD"

#: Characters per hyphen-separated group in a rendered code.
_GROUP = 8

_KEY_LEN = 32
_NONCE_LEN = 12
_SHARE_ID_LEN = 16
_CHECKSUM_LEN = 2

_AAD_PREFIX = b"navide/share/v1"

#: Cap on the base64 blob this machine will hand to the server. The server's
#: WebSocket ``maxPayload`` is 1 MiB and a frame over it is closed at the
#: framing layer (1009), which reaches the user as "the connection dropped" and
#: says nothing about why. So the gate is here, below the server's own, and it
#: is checked before ``shares.create`` is sent rather than after.
MAX_BLOB_CHARS = 768 * 1024

#: Ceiling on what one blob is allowed to expand into. The sender chose the
#: compression, and gzip will happily turn a few hundred kilobytes into
#: hundreds of megabytes; the same number ``settings_bundle`` caps a bundle at
#: is the honest limit, since anything larger could not have been exported.
MAX_PLAIN_BYTES = 8 * 1024 * 1024


class ShareCodeError(Exception):
    """A code could not be read, or a blob could not be sealed or opened.

    Carries a code for the wire, the same shape as ``settings_bundle``'s
    ``BundleError``, so both can be reported by the one handler path.
    """

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


# ── keys and codes ───────────────────────────────────────────────────────────
def new_key() -> bytes:
    """A fresh per-bundle key. Used once, and only ever leaves inside a code."""
    return os.urandom(_KEY_LEN)


def normalize_share_id(share_id: str) -> str:
    """The canonical wire spelling of a share id: 32 lowercase hex characters.

    A share id is 16 bytes, and 16 bytes have several spellings — dashed UUID,
    upper case, plain hex. The code carries the *bytes*, so whatever spelling
    the server issued is gone by the time a reader decodes one. Rather than let
    that mismatch surface as a share that cannot be claimed, every id crossing
    this module is put into one form, on the way out as well as the way in.
    """
    raw = share_id.strip().replace("-", "").lower()
    if len(raw) != _SHARE_ID_LEN * 2:
        raise ShareCodeError(
            "BAD_SHARE_ID",
            f"a share id is {_SHARE_ID_LEN} bytes as hex; this one is {len(raw)} characters",
            {"shareId": share_id},
        )
    try:
        bytes.fromhex(raw)
    except ValueError as err:
        raise ShareCodeError(
            "BAD_SHARE_ID", "a share id must be hexadecimal", {"shareId": share_id}
        ) from err
    return raw


def _checksum(body: bytes) -> bytes:
    return hashlib.sha256(_AAD_PREFIX + b"\x00" + body).digest()[:_CHECKSUM_LEN]


def encode_share_code(share_id: str, key: bytes) -> str:
    """Render the one string the sender hands over."""
    if len(key) != _KEY_LEN:
        raise ShareCodeError(
            "BAD_SHARE_KEY", f"a share key is {_KEY_LEN} bytes, not {len(key)}"
        )
    body = bytes.fromhex(normalize_share_id(share_id)) + key
    raw = body + _checksum(body)
    text = base64.b32encode(raw).decode("ascii").rstrip("=")
    groups = [text[i : i + _GROUP] for i in range(0, len(text), _GROUP)]
    return "-".join([CODE_PREFIX, *groups])


def decode_share_code(code: str) -> tuple[str, bytes]:
    """Read a code back into ``(shareId, key)``.

    Hyphens, spaces and case are formatting, not content: a code read off a
    screen and retyped is the same code. What is content is the checksum, and
    it is checked before anything is returned.
    """
    text = "".join(code.split()).replace("-", "").upper()
    if text.startswith(CODE_PREFIX):
        text = text[len(CODE_PREFIX) :]
    if not text:
        raise ShareCodeError("BAD_SHARE_CODE", "that is not a share code — it is empty")
    padding = "=" * (-len(text) % 8)
    try:
        raw = base64.b32decode(text + padding)
    except Exception as err:  # noqa: BLE001 - binascii raises several types here
        raise ShareCodeError(
            "BAD_SHARE_CODE",
            "that share code contains characters a share code cannot contain — "
            "check it against the original",
        ) from err
    expected = _SHARE_ID_LEN + _KEY_LEN + _CHECKSUM_LEN
    if len(raw) != expected:
        raise ShareCodeError(
            "BAD_SHARE_CODE",
            "that share code is the wrong length — check that none of it was "
            "cut off when it was copied",
            {"expected": expected, "found": len(raw)},
        )
    body, checksum = raw[:-_CHECKSUM_LEN], raw[-_CHECKSUM_LEN:]
    if checksum != _checksum(body):
        raise ShareCodeError(
            "SHARE_CODE_CHECKSUM",
            "that share code has a typo in it — the check digits do not match "
            "the rest of the code",
        )
    return body[:_SHARE_ID_LEN].hex(), body[_SHARE_ID_LEN:]


# ── sealing ──────────────────────────────────────────────────────────────────
def _aad(bundle_version: int) -> bytes:
    return _AAD_PREFIX + b"\x00" + str(bundle_version).encode("ascii")


def _bundle_version(bundle: Any) -> int:
    version = bundle.get("bundleVersion") if isinstance(bundle, dict) else None
    if not isinstance(version, int) or isinstance(version, bool) or not 0 <= version <= 255:
        raise ShareCodeError(
            "BAD_BUNDLE",
            "that bundle has no usable bundleVersion, so there is nothing to "
            "bind the ciphertext to",
            {"found": version},
        )
    return version


def seal_bundle(bundle: dict[str, Any], key: bytes) -> str:
    """Compress and encrypt one bundle into the blob the server will store."""
    if len(key) != _KEY_LEN:
        raise ShareCodeError(
            "BAD_SHARE_KEY", f"a share key is {_KEY_LEN} bytes, not {len(key)}"
        )
    version = _bundle_version(bundle)
    plain = json.dumps(bundle, ensure_ascii=False, sort_keys=True).encode("utf-8")
    # mtime=0: the blob is content, and a timestamp baked into it would make two
    # shares of the same bundle differ for no reason anybody can see.
    packed = gzip.compress(plain, compresslevel=9, mtime=0)
    nonce = os.urandom(_NONCE_LEN)
    sealed = AESGCM(key).encrypt(nonce, packed, _aad(version))
    return base64.b64encode(bytes([version]) + nonce + sealed).decode("ascii")


def open_bundle(blob: str, key: bytes) -> dict[str, Any]:
    """Open a blob sealed by ``seal_bundle`` under the same key."""
    try:
        raw = base64.b64decode(blob, validate=True)
    except Exception as err:  # noqa: BLE001 - binascii raises several types here
        raise ShareCodeError(
            "BAD_SHARE_BLOB", "the shared document is not valid base64"
        ) from err
    if len(raw) <= 1 + _NONCE_LEN:
        raise ShareCodeError(
            "BAD_SHARE_BLOB", "the shared document is too short to be a sealed bundle"
        )
    version = raw[0]
    try:
        packed = AESGCM(key).decrypt(raw[1 : 1 + _NONCE_LEN], raw[1 + _NONCE_LEN :], _aad(version))
    except Exception as err:  # noqa: BLE001 - cryptography raises a bare InvalidTag
        raise ShareCodeError(
            "SHARE_DECRYPT_FAILED",
            "that share code does not open this document — check the code, or "
            "ask the sender for a new one",
        ) from err
    plain = _gunzip(packed)
    try:
        bundle = json.loads(plain.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as err:
        raise ShareCodeError(
            "BAD_SHARE_BLOB", "the shared document did not decode into a bundle"
        ) from err
    if not isinstance(bundle, dict) or bundle.get("bundleVersion") != version:
        # The header byte is authenticated, so disagreeing with the document it
        # authenticates means the document was built wrong, not tampered with.
        raise ShareCodeError(
            "BAD_SHARE_BLOB",
            "the shared document disagrees with its own version header",
            {"header": version},
        )
    return bundle


def _gunzip(packed: bytes) -> bytes:
    """Inflate with a ceiling, because the sender chose the compression."""
    engine = zlib.decompressobj(16 + zlib.MAX_WBITS)
    plain = engine.decompress(packed, MAX_PLAIN_BYTES)
    if engine.unconsumed_tail or not engine.eof:
        raise ShareCodeError(
            "SHARE_BUNDLE_TOO_LARGE",
            f"the shared document expands past the {MAX_PLAIN_BYTES} byte limit",
            {"limit": MAX_PLAIN_BYTES},
        )
    return plain


def ensure_blob_within_limit(blob: str) -> int:
    """The blob's size, or ``ShareCodeError`` naming the way out that still works.

    Checked before ``shares.create``: over the limit the server closes the
    connection at the framing layer, and "Navide disconnected" is not something
    anybody can act on. Exporting to a file has no such ceiling, so the error
    says so rather than leaving the sender to guess what to drop.
    """
    size = len(blob)
    if size <= MAX_BLOB_CHARS:
        return size
    raise ShareCodeError(
        "SHARE_BLOB_TOO_LARGE",
        f"this share is {size} bytes encrypted and the limit for a share code "
        f"is {MAX_BLOB_CHARS}; share fewer items, or use Export to file and "
        f"send the file instead",
        {"size": size, "limit": MAX_BLOB_CHARS},
    )
