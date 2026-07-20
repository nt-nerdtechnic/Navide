from __future__ import annotations

from registry.signing import (
    AcceptingSignatureVerifier,
    Ed25519SignatureVerifier,
    generate_keypair,
    sign_digest,
)

DIGEST = "a" * 64


def test_valid_signature_accepted() -> None:
    private_pem, public_pem = generate_keypair()
    sig = sign_digest(private_pem, DIGEST)
    verifier = Ed25519SignatureVerifier()
    assert verifier.verify(digest=DIGEST, signature=sig, public_key=public_pem)


def test_tampered_digest_rejected() -> None:
    private_pem, public_pem = generate_keypair()
    sig = sign_digest(private_pem, DIGEST)
    verifier = Ed25519SignatureVerifier()
    tampered = "b" * 64
    assert not verifier.verify(
        digest=tampered, signature=sig, public_key=public_pem
    )


def test_wrong_key_rejected() -> None:
    signer_private, _ = generate_keypair()
    _, other_public = generate_keypair()
    sig = sign_digest(signer_private, DIGEST)
    verifier = Ed25519SignatureVerifier()
    assert not verifier.verify(
        digest=DIGEST, signature=sig, public_key=other_public
    )


def test_missing_signature_or_key_rejected() -> None:
    _, public_pem = generate_keypair()
    verifier = Ed25519SignatureVerifier()
    assert not verifier.verify(digest=DIGEST, signature=None, public_key=public_pem)
    assert not verifier.verify(digest=DIGEST, signature="x", public_key=None)


def test_garbage_signature_rejected() -> None:
    _, public_pem = generate_keypair()
    verifier = Ed25519SignatureVerifier()
    assert not verifier.verify(
        digest=DIGEST, signature="not-base64!!", public_key=public_pem
    )


def test_accepting_verifier_accepts_anything() -> None:
    verifier = AcceptingSignatureVerifier()
    assert verifier.verify(digest=DIGEST, signature=None, public_key=None)
    assert verifier.verify(digest=DIGEST, signature="whatever", public_key=None)
