"""Share codes: what the code carries, and what it refuses to carry.

The assertions worth having here are the negative ones. A share code is the
*only* thing standing between a bundle and anybody who asks the server for it,
so the tests that matter are "a typo is caught here rather than reported as a
missing share", "the wrong key does not open the document", and "an oversized
share is refused before the request is sent" — the last one because the server
answers that case by closing the connection, which tells the user nothing.
"""

from __future__ import annotations

import base64
import gzip
import json
import os

import pytest

from agent_team_backend import share_codes


def a_bundle(filler: str = "") -> dict:
    return {
        "bundleVersion": 1,
        "name": "team defaults",
        "description": "",
        "createdAt": "2026-09-16T00:00:00+00:00",
        "createdBy": {"device": "laptop", "app": "Navide 0.2.3"},
        "scopes": {
            "prompts": {"items": {"review": {"title": "Review", "body": "look hard" + filler}}},
            "mcp": {"items": {}},
            "skills": {"items": {}},
            "memory": {"items": {}},
        },
        "redactions": [],
    }


SHARE_ID = "0123456789abcdef0123456789abcdef"


# ── the code itself ──────────────────────────────────────────────────────────
def test_code_round_trips_id_and_key():
    key = share_codes.new_key()
    code = share_codes.encode_share_code(SHARE_ID, key)

    assert code.startswith("NVD-")
    assert share_codes.decode_share_code(code) == (SHARE_ID, key)


def test_code_ignores_formatting():
    """Hyphens, case and stray spaces are how it was written down, not content."""
    key = share_codes.new_key()
    code = share_codes.encode_share_code(SHARE_ID, key)

    retyped = "  " + code.replace("-", "").lower() + " "
    assert share_codes.decode_share_code(retyped) == (SHARE_ID, key)


def test_dashed_share_id_is_normalized():
    """A UUID-spelled id and its plain hex are the same id, both ways."""
    key = share_codes.new_key()
    dashed = "01234567-89ab-cdef-0123-456789abcdef"

    assert share_codes.encode_share_code(dashed, key) == share_codes.encode_share_code(
        SHARE_ID, key
    )
    assert share_codes.decode_share_code(share_codes.encode_share_code(dashed, key))[0] == SHARE_ID


def test_one_wrong_character_is_caught_by_the_checksum():
    """Every single-character substitution, not a sampled one."""
    code = share_codes.encode_share_code(SHARE_ID, share_codes.new_key())
    body = code[len("NVD-") :].replace("-", "")
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    for index, original in enumerate(body):
        for replacement in alphabet:
            if replacement == original:
                continue
            typo = "NVD-" + body[:index] + replacement + body[index + 1 :]
            with pytest.raises(share_codes.ShareCodeError) as caught:
                share_codes.decode_share_code(typo)
            assert caught.value.code in {"SHARE_CODE_CHECKSUM", "BAD_SHARE_CODE"}


def test_truncated_code_is_refused():
    code = share_codes.encode_share_code(SHARE_ID, share_codes.new_key())

    with pytest.raises(share_codes.ShareCodeError) as caught:
        share_codes.decode_share_code(code[:-4])
    assert caught.value.code == "BAD_SHARE_CODE"


def test_code_with_impossible_characters_is_refused():
    with pytest.raises(share_codes.ShareCodeError) as caught:
        share_codes.decode_share_code("NVD-AAAAAAAA-!!!!!!!!")
    assert caught.value.code == "BAD_SHARE_CODE"


def test_empty_code_is_refused():
    with pytest.raises(share_codes.ShareCodeError) as caught:
        share_codes.decode_share_code("NVD-")
    assert caught.value.code == "BAD_SHARE_CODE"


def test_share_id_that_is_not_sixteen_bytes_is_refused():
    with pytest.raises(share_codes.ShareCodeError) as caught:
        share_codes.encode_share_code("abc", share_codes.new_key())
    assert caught.value.code == "BAD_SHARE_ID"


def test_key_of_the_wrong_length_is_refused():
    with pytest.raises(share_codes.ShareCodeError) as caught:
        share_codes.encode_share_code(SHARE_ID, os.urandom(16))
    assert caught.value.code == "BAD_SHARE_KEY"


# ── the sealed document ──────────────────────────────────────────────────────
def test_bundle_round_trips_through_a_blob():
    key = share_codes.new_key()
    bundle = a_bundle()

    assert share_codes.open_bundle(share_codes.seal_bundle(bundle, key), key) == bundle


def test_whole_pipeline_round_trips_from_code_alone():
    """What actually happens: publish mints, the reader holds only the code."""
    key = share_codes.new_key()
    bundle = a_bundle()
    blob = share_codes.seal_bundle(bundle, key)
    code = share_codes.encode_share_code(SHARE_ID, key)

    share_id, recovered_key = share_codes.decode_share_code(code)

    assert share_id == SHARE_ID
    assert share_codes.open_bundle(blob, recovered_key) == bundle


def test_the_wrong_key_does_not_open_the_document():
    blob = share_codes.seal_bundle(a_bundle(), share_codes.new_key())

    with pytest.raises(share_codes.ShareCodeError) as caught:
        share_codes.open_bundle(blob, share_codes.new_key())
    assert caught.value.code == "SHARE_DECRYPT_FAILED"


def test_the_blob_never_contains_the_key():
    key = share_codes.new_key()
    blob = share_codes.seal_bundle(a_bundle(), key)

    assert key not in base64.b64decode(blob)


def test_two_seals_of_one_bundle_differ():
    """A fresh nonce every time, so an eavesdropper cannot match two shares."""
    key = share_codes.new_key()

    assert share_codes.seal_bundle(a_bundle(), key) != share_codes.seal_bundle(a_bundle(), key)


def test_tampering_with_the_version_header_fails_the_tag():
    """The header is readable before decryption, and authenticated by it."""
    key = share_codes.new_key()
    raw = bytearray(base64.b64decode(share_codes.seal_bundle(a_bundle(), key)))
    raw[0] = 2

    with pytest.raises(share_codes.ShareCodeError) as caught:
        share_codes.open_bundle(base64.b64encode(bytes(raw)).decode("ascii"), key)
    assert caught.value.code == "SHARE_DECRYPT_FAILED"


def test_tampering_with_the_ciphertext_fails_the_tag():
    key = share_codes.new_key()
    raw = bytearray(base64.b64decode(share_codes.seal_bundle(a_bundle(), key)))
    raw[-1] ^= 0xFF

    with pytest.raises(share_codes.ShareCodeError) as caught:
        share_codes.open_bundle(base64.b64encode(bytes(raw)).decode("ascii"), key)
    assert caught.value.code == "SHARE_DECRYPT_FAILED"


def test_a_bundle_without_a_version_cannot_be_sealed():
    with pytest.raises(share_codes.ShareCodeError) as caught:
        share_codes.seal_bundle({"scopes": {}}, share_codes.new_key())
    assert caught.value.code == "BAD_BUNDLE"


def test_blob_that_is_not_base64_is_refused():
    with pytest.raises(share_codes.ShareCodeError) as caught:
        share_codes.open_bundle("not a blob!", share_codes.new_key())
    assert caught.value.code == "BAD_SHARE_BLOB"


def test_a_compression_bomb_is_refused_rather_than_inflated():
    """The sender chose the compression, so the ceiling is on this side."""
    key = share_codes.new_key()
    bomb = gzip.compress(b"\x00" * (share_codes.MAX_PLAIN_BYTES + 1024), mtime=0)
    nonce = os.urandom(12)
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    sealed = AESGCM(key).encrypt(nonce, bomb, b"navide/share/v1\x001")
    blob = base64.b64encode(bytes([1]) + nonce + sealed).decode("ascii")

    with pytest.raises(share_codes.ShareCodeError) as caught:
        share_codes.open_bundle(blob, key)
    assert caught.value.code == "SHARE_BUNDLE_TOO_LARGE"


# ── the size gate ────────────────────────────────────────────────────────────
def test_a_blob_at_the_limit_passes():
    blob = "A" * share_codes.MAX_BLOB_CHARS

    assert share_codes.ensure_blob_within_limit(blob) == share_codes.MAX_BLOB_CHARS


def test_an_oversized_blob_is_refused_and_names_the_file_route():
    blob = "A" * (share_codes.MAX_BLOB_CHARS + 1)

    with pytest.raises(share_codes.ShareCodeError) as caught:
        share_codes.ensure_blob_within_limit(blob)
    assert caught.value.code == "SHARE_BLOB_TOO_LARGE"
    assert "Export to file" in caught.value.message
    assert caught.value.details["limit"] == share_codes.MAX_BLOB_CHARS


def test_an_oversized_bundle_is_caught_before_it_could_be_sent():
    """Incompressible filler, so gzip cannot rescue a bundle this big."""
    key = share_codes.new_key()
    bundle = a_bundle(filler=base64.b64encode(os.urandom(1024 * 1024)).decode("ascii"))
    blob = share_codes.seal_bundle(bundle, key)

    assert len(blob) > share_codes.MAX_BLOB_CHARS
    with pytest.raises(share_codes.ShareCodeError):
        share_codes.ensure_blob_within_limit(blob)


def test_the_sealed_document_is_compressed():
    """A bundle is repetitive JSON; sealing it must not grow it by a third."""
    key = share_codes.new_key()
    bundle = a_bundle(filler=" repeated phrase" * 4000)
    plain = len(json.dumps(bundle))

    assert len(share_codes.seal_bundle(bundle, key)) < plain // 2
