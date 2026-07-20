"""Signature verification seam.

The registry has its OWN signing chain (independent of Apple DevID). This slice
only defines the interface and records the signature on each version. Real
crypto verification is deferred to the `p3-security` todo.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class SignatureVerifier(Protocol):
    def verify(self, package: bytes, signature: str | None) -> bool:
        """Return True if `signature` is a valid signature over `package`."""
        ...


class AcceptingSignatureVerifier:
    """Placeholder verifier used until p3-security lands.

    TODO(p3-security): implement real detached-signature verification against
    the registry's trusted publisher keys. Until then every package is
    accepted and the raw signature (if any) is stored verbatim.
    """

    def verify(self, package: bytes, signature: str | None) -> bool:
        return True
