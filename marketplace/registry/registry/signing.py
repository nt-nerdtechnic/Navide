"""Signature verification + Ed25519 signing primitives.

The registry has its OWN plugin-signing chain, independent of Apple DevID
(that's macOS notarization -- the wrong tool for cross-platform plugin trust).
A publisher registers an Ed25519 public key; a package carries a detached
signature (base64) computed over the package's sha256 **digest**. At publish
time the registry verifies the signature against the publisher's registered key.

`AcceptingSignatureVerifier` is retained for dev/tests (accepts anything) and is
selected via config; `Ed25519SignatureVerifier` is the real default.
"""

from __future__ import annotations

import base64
from typing import Protocol, runtime_checkable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)


@runtime_checkable
class SignatureVerifier(Protocol):
    def verify(
        self, *, digest: str, signature: str | None, public_key: str | None
    ) -> bool:
        """Return True if `signature` is valid over `digest` for `public_key`."""
        ...


class AcceptingSignatureVerifier:
    """Dev/test verifier: trusts any signature. Selected via config only."""

    def verify(
        self, *, digest: str, signature: str | None, public_key: str | None
    ) -> bool:
        return True


class Ed25519SignatureVerifier:
    """Verifies a detached Ed25519 signature over the package digest."""

    def verify(
        self, *, digest: str, signature: str | None, public_key: str | None
    ) -> bool:
        if not signature or not public_key:
            return False
        try:
            pub = _load_public_key(public_key)
            raw = base64.b64decode(signature, validate=True)
        except (ValueError, TypeError):
            return False
        try:
            pub.verify(raw, digest.encode("ascii"))
        except InvalidSignature:
            return False
        return True


# -- key + signing helpers (used by the CLI and registration) -----------
def generate_keypair() -> tuple[str, str]:
    """Return (private_key_pem, public_key_pem) for a fresh Ed25519 keypair."""
    private = Ed25519PrivateKey.generate()
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    public_pem = private.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    return private_pem, public_pem


def sign_digest(private_key_pem: str, digest: str) -> str:
    """Sign a hex digest with a PEM private key; return a base64 signature."""
    private = serialization.load_pem_private_key(
        private_key_pem.encode("ascii"), password=None
    )
    if not isinstance(private, Ed25519PrivateKey):
        raise ValueError("private key is not an Ed25519 key")
    return base64.b64encode(private.sign(digest.encode("ascii"))).decode("ascii")


def _load_public_key(public_key_pem: str) -> Ed25519PublicKey:
    pub = serialization.load_pem_public_key(public_key_pem.encode("ascii"))
    if not isinstance(pub, Ed25519PublicKey):
        raise ValueError("public key is not an Ed25519 key")
    return pub
