"""The account-wide key that makes synced records readable on every device.

Cross-device *messages* are sealed boxes: the sender needs only the
recipient's public key, nothing is stored, and the ephemeral half is thrown
away the moment the message is sealed. Synced *records* are the opposite
shape. They sit on the server until some device comes to read them — possibly
one that does not exist yet — so "seal it to the recipient" has no recipient
to name, and sealing one copy per device would leave a machine paired next
month unable to read anything written before it arrived.

So the records are encrypted with one symmetric key per account, and that key
is what travels by sealed box:

    account key (32 bytes, never leaves the Keychain in the clear)
        │
        ├─ AES-256-GCM ──→ every synced record body
        │
        └─ device_crypto.seal(recipient public key) ──→ handed to a new device
                                                        over the paired channel

Three decisions worth naming:

*The server never holds a key, and this module gives it no way to grow one.*
Only ciphertext is ever handed to ``server_link``; the plaintext boundary is
this file.

*A second key is refused, not merged.* Accepting a different account key would
orphan everything already written under the first one — silently, because the
old ciphertext would simply stop opening. ``accept_wrapped`` raises instead,
and the caller surfaces it.

*Scope and item are bound into the ciphertext.* They go in as AEAD associated
data, so a record lifted from one item cannot be replayed as another. Same
reason the message layer binds the device ids.
"""

from __future__ import annotations

import base64
import logging
import os
import threading

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import device_crypto

log = logging.getLogger("agent_team_backend.sync_keyring")

#: Vault entry holding the base64 account key. One per install, per account.
ACCOUNT_KEY_SECRET = "navide-sync-account-key"

_KEY_LEN = 32
_NONCE_LEN = 12
_AAD_PREFIX = b"navide/sync/v1"

#: The key, once read. A sync round encrypts or opens one record per item, and
#: without this every one of them was a separate Keychain call — slow, and on
#: macOS a queue of authorisation prompts waiting to happen. Cleared by the two
#: functions that change what is stored, so the cache can never outlive it.
_cached_key: bytes | None = None
_cache_lock = threading.Lock()


class KeyringError(Exception):
    """The account key could not be read, created, or agreed on."""


class KeyConflict(KeyringError):
    """A different account key arrived while this machine already holds one."""


def _vault():
    # Late import for the same reason server_link does it: app imports this
    # module, and tests swap the singleton wholesale to stay off the Keychain.
    from . import app

    return app.credential_vault


def _encode(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _decode(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def account_key() -> bytes | None:
    """The stored account key, or None when this machine has none yet.

    A vault that will not answer reads as "no key this time round" rather than
    "no key at all": a locked Keychain must not send the caller down the path
    that mints a second one.
    """
    with _cache_lock:
        if _cached_key is not None:
            return _cached_key
    try:
        stored = _vault().read_app_secret(ACCOUNT_KEY_SECRET)
    except Exception as err:  # noqa: BLE001 - a locked vault is not "no key"
        raise KeyringError(f"the sync key could not be read: {err}") from err
    if not stored:
        return None
    try:
        raw = _decode(stored.strip())
    except (ValueError, TypeError) as err:
        raise KeyringError("the stored sync key is not valid base64") from err
    if len(raw) != _KEY_LEN:
        raise KeyringError("the stored sync key is not 32 bytes")
    _remember(raw)
    return raw


def _remember(raw: bytes | None) -> None:
    global _cached_key
    with _cache_lock:
        _cached_key = raw


def has_account_key() -> bool:
    try:
        return account_key() is not None
    except KeyringError:
        return False


def ensure_account_key() -> bytes:
    """This machine's account key, minting one only when there is none.

    Minting is safe exactly once per account: the first device to sync creates
    it, every later device receives it through ``accept_wrapped``. A machine
    that mints a second one would write records nobody else can open, which is
    why callers must only reach here after the pairing path has had its chance.
    """
    existing = account_key()
    if existing is not None:
        return existing
    raw = os.urandom(_KEY_LEN)
    _vault().write_app_secret(ACCOUNT_KEY_SECRET, _encode(raw))
    _remember(raw)
    log.info("minted this account's sync key")
    return raw


def forget_account_key() -> None:
    """Erase the stored key — used when signing out of the account."""
    _vault().write_app_secret(ACCOUNT_KEY_SECRET, None)
    _remember(None)


def _aad(scope: str, item_id: str) -> bytes:
    return b"\x00".join((_AAD_PREFIX, scope.encode("utf-8"), item_id.encode("utf-8")))


def encrypt(plaintext: str, *, scope: str, item_id: str) -> str:
    """Seal one record body. Requires a key; never falls back to plaintext."""
    key = account_key()
    if key is None:
        raise KeyringError("this machine has no sync key yet")
    nonce = os.urandom(_NONCE_LEN)
    sealed = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), _aad(scope, item_id))
    return _encode(nonce + sealed)


def decrypt(wire: str, *, scope: str, item_id: str) -> str:
    """Open one record body sealed by ``encrypt`` under the same key."""
    key = account_key()
    if key is None:
        raise KeyringError("this machine has no sync key yet")
    try:
        raw = _decode(wire)
    except (ValueError, TypeError) as err:
        raise KeyringError("the record body is not valid base64") from err
    if len(raw) <= _NONCE_LEN:
        raise KeyringError("the record body is too short to be a sealed record")
    try:
        opened = AESGCM(key).decrypt(
            raw[:_NONCE_LEN], raw[_NONCE_LEN:], _aad(scope, item_id)
        )
    except Exception as err:  # noqa: BLE001 - cryptography raises a bare InvalidTag
        raise KeyringError("the record body did not open with this account key") from err
    return opened.decode("utf-8")


def wrap_for(*, recipient_public_key: str, from_device: str, to_device: str) -> str:
    """The account key, sealed to one device so it can join the account.

    Goes over the paired channel, which is already signed and verified by a
    short authentication string — so the newcomer's public key has been
    confirmed by a human before anything is wrapped for it.
    """
    key = account_key()
    if key is None:
        raise KeyringError("this machine has no sync key to share")
    return device_crypto.seal(
        _encode(key),
        recipient_public_key=recipient_public_key,
        from_device=from_device,
        to_device=to_device,
    )


def accept_wrapped(wire: str, *, from_device: str, to_device: str) -> bytes:
    """Open an account key another device sealed for us, and store it.

    Idempotent for the same key — a peer re-sending it is ordinary. A
    *different* key is refused: adopting it would leave every record written
    under the old one permanently unreadable, and doing that quietly is worse
    than stopping.
    """
    try:
        opened = device_crypto.open_sealed(
            wire, from_device=from_device, to_device=to_device
        )
    except Exception as err:  # noqa: BLE001 - any failure here means "not for us"
        raise KeyringError(f"the wrapped sync key did not open: {err}") from err
    try:
        raw = _decode(opened.strip())
    except (ValueError, TypeError) as err:
        raise KeyringError("the wrapped sync key is not valid base64") from err
    if len(raw) != _KEY_LEN:
        raise KeyringError("the wrapped sync key is not 32 bytes")
    current = account_key()
    if current is not None and current != raw:
        raise KeyConflict(
            "this machine already holds a different sync key for this account"
        )
    if current is None:
        _vault().write_app_secret(ACCOUNT_KEY_SECRET, _encode(raw))
        _remember(raw)
        log.info("adopted the account sync key from %s", from_device)
    return raw


def _reset_for_test() -> None:
    """Drop the in-process key cache.

    The cache is what stops a sync round from making one Keychain call per
    record; it also outlives the per-test vault, so a test that expects "no key
    yet" would otherwise see one a previous test minted. Reset alongside the
    other process-wide singletons in conftest.
    """
    _remember(None)
