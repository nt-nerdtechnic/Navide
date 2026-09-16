"""The encryption key through the pairing exchange, and what is sealed to it.

The pairing used to fix only the *signing* key: it rode the frames, went into
the six digits, and was pinned. The X25519 *encryption* key — the one the
account sync key is sealed to — was read from the server's directory after
the fact. A relay that left every signature alone and swapped that one
directory field was handed the sync key, and with it every synced record,
while two people agreed on the digits. These tests drive the real handler
against the fake relay and assert the shape that closes that: the encryption
key rides the frames, is fixed by them, is pinned with the signing key, and is
the only key anything is ever sealed to. Everything is synthetic — the peer is
a keypair generated per test, the vault is the per-test one.
"""

from __future__ import annotations

import base64
import json

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from agent_team_backend import (
    app,
    device_crypto,
    device_pairing,
    device_signing,
    remote_roster,
    server_link,
    sync_keyring,
    trust_store,
)

from .test_server_link import (  # noqa: F401 - broadcasts is a fixture
    ALLOW_ALL_POLICY,
    CONFIG,
    FakeServer,
    Peer,
    _connected,
    _until,
    broadcasts,
)
from .test_server_link_trust import _pair_frame

#: What a relay would put in the directory in place of the peer's real key: a
#: well-formed X25519 public key the relay holds the private half of.
RELAY_ENC_KEY = Peer("dev-relay").enc_key


def _open_as(peer: Peer, wire: str, *, from_device: str, to_device: str) -> str:
    """Open a sealed box with *peer*'s private key — the far end of ``seal``."""
    blob = base64.b64decode(wire)
    ephemeral, nonce, ciphertext = blob[:32], blob[32:44], blob[44:]
    shared = peer._enc_private.exchange(X25519PublicKey.from_public_bytes(ephemeral))
    key = device_crypto._derive(shared)
    aad = device_crypto._aad(from_device, to_device, peer.enc_key)
    return AESGCM(key).decrypt(nonce, ciphertext, aad).decode("utf-8")


def _directory_row(peer: Peer, *, enc_key: str) -> dict:
    """The directory as the relay writes it, encryption key included."""
    return peer.session_row(devicePublicKey=enc_key)


async def _pair_through_the_handler(link, conn, asker: Peer) -> None:
    """The responder's side of a whole exchange: their request arrives, this
    person presses Allow, their confirm arrives."""
    await conn.push(
        {
            "type": "messages.pending",
            "payload": _pair_frame(
                asker,
                device_pairing.PAIR_REQUEST,
                nonce="bm9uY2U=",
                signKey=asker.sign_key,
                encKey=asker.enc_key,
            ),
        }
    )
    await _until(lambda: device_pairing.get(asker.device_id) is not None)
    await link.confirm_pairing(asker.device_id, accept=True)
    await conn.push(
        {
            "type": "messages.pending",
            "payload": _pair_frame(asker, device_pairing.PAIR_CONFIRM, msg_key="pair-k2"),
        }
    )
    await _until(lambda: trust_store.pin_for(asker.device_id) is not None)


# ---- the exchange carries and pins the encryption key ----------------------------


async def test_a_completed_pairing_pins_the_key_the_frames_carried_not_the_directory():
    """The directory says one thing, the frames the six digits covered say
    another. The pin follows the frames."""
    device_pairing._reset_for_test()
    asker = Peer("dev-asker")
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(asker, enc_key=RELAY_ENC_KEY)]
    link = await _connected(server)
    try:
        await _pair_through_the_handler(link, server.opened[0], asker)

        pin = trust_store.pin_for(asker.device_id)
        assert pin["signKey"] == asker.sign_key
        assert pin["encKey"] == asker.enc_key
        assert trust_store.pinned_encryption_key(asker.device_id) == asker.enc_key
        assert remote_roster.public_key_for(asker.device_id) == RELAY_ENC_KEY
    finally:
        device_pairing._reset_for_test()
        await link.stop()


async def test_the_digits_shown_here_cover_the_encryption_key_from_the_frame():
    """A relay that swaps the directory entry changes nothing on the card; one
    that swaps the frame changes the digits, which is the mismatch two people
    see. Either way the directory never enters the code."""
    device_pairing._reset_for_test()
    asker = Peer("dev-asker")
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(asker, enc_key=RELAY_ENC_KEY)]
    link = await _connected(server)
    try:
        await server.opened[0].push(
            {
                "type": "messages.pending",
                "payload": _pair_frame(
                    asker,
                    device_pairing.PAIR_REQUEST,
                    nonce="bm9uY2U=",
                    signKey=asker.sign_key,
                    encKey=asker.enc_key,
                ),
            }
        )
        await _until(lambda: device_pairing.get(asker.device_id) is not None)
        pairing = device_pairing.get(asker.device_id)
        row = next(r for r in link.pairing_rows() if r["deviceId"] == asker.device_id)

        honest = device_pairing.sas(
            key_a=device_signing.public_key(),
            key_b=asker.sign_key,
            enc_a=device_crypto.public_key(),
            enc_b=asker.enc_key,
            nonce_a=pairing.our_nonce,
            nonce_b="bm9uY2U=",
        )
        swapped = device_pairing.sas(
            key_a=device_signing.public_key(),
            key_b=asker.sign_key,
            enc_a=device_crypto.public_key(),
            enc_b=RELAY_ENC_KEY,
            nonce_a=pairing.our_nonce,
            nonce_b="bm9uY2U=",
        )
        assert row["code"] == honest
        assert row["code"] != swapped
    finally:
        device_pairing._reset_for_test()
        await link.stop()


async def test_a_request_without_an_encryption_key_is_refused_on_the_wire():
    """Fail closed: nothing is filled in from the directory, no card goes up,
    and the sender is told why."""
    device_pairing._reset_for_test()
    asker = Peer("dev-old-build")
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(asker, enc_key=asker.enc_key)]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {
                "type": "messages.pending",
                "payload": _pair_frame(
                    asker, device_pairing.PAIR_REQUEST, nonce="bm9uY2U=", signKey=asker.sign_key
                ),
            }
        )
        await _until(lambda: bool(conn.acks))

        assert conn.acks[0]["state"] == "rejected"
        assert conn.acks[0]["reason"] == "pairing-refused"
        assert device_pairing.get(asker.device_id) is None
        assert trust_store.pin_for(asker.device_id) is None
    finally:
        device_pairing._reset_for_test()
        await link.stop()


async def test_both_frames_this_machine_sends_carry_its_encryption_key():
    """The request when it asks, the response when it answers — so the other
    end has something to put in its digits and its pin."""
    device_pairing._reset_for_test()
    asker = Peer("dev-asker")
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(asker, enc_key=asker.enc_key)]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        await conn.push(
            {
                "type": "messages.pending",
                "payload": _pair_frame(
                    asker,
                    device_pairing.PAIR_REQUEST,
                    nonce="bm9uY2U=",
                    signKey=asker.sign_key,
                    encKey=asker.enc_key,
                ),
            }
        )
        await _until(lambda: bool(conn.sends))
        response = json.loads(conn.sends[0]["text"])
        assert response["kind"] == device_pairing.PAIR_RESPONSE
        assert response["signKey"] == device_signing.public_key()
        assert response["encKey"] == device_crypto.public_key()

        link._online_devices = {"dev-other"}
        await link.start_pairing("dev-other")
        request = json.loads(conn.sends[-1]["text"])
        assert request["kind"] == device_pairing.PAIR_REQUEST
        assert request["encKey"] == device_crypto.public_key()
    finally:
        device_pairing._reset_for_test()
        await link.stop()


# ---- what the pinned key is used for ------------------------------------------------


async def test_the_sync_key_is_sealed_to_the_pinned_key_not_the_directory():
    """The break this closes. The directory names the relay; the pin names
    the peer; the offer opens for the peer and not for the relay."""
    device_pairing._reset_for_test()
    asker = Peer("dev-asker")
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(asker, enc_key=RELAY_ENC_KEY)]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        sync_keyring.ensure_account_key()
        expected = sync_keyring.ring()
        await _pair_through_the_handler(link, conn, asker)
        # _finish_pairing offers the key as its last step.
        await _until(
            lambda: any(
                json.loads(s.get("text") or "{}").get("kind") == server_link.SYNC_KEY_OFFER
                for s in conn.sends
            )
        )
        offer = next(
            json.loads(s["text"])
            for s in conn.sends
            if json.loads(s.get("text") or "{}").get("kind") == server_link.SYNC_KEY_OFFER
        )

        opened = _open_as(
            asker, offer["wrapped"], from_device=link._device_id, to_device=asker.device_id
        )
        ring = json.loads(opened)
        assert ring["active"] == expected["active"]
        assert base64.b64decode(ring["keys"][ring["active"]]) == (
            expected["keys"][expected["active"]]
        )
    finally:
        sync_keyring.forget_account_key()
        device_pairing._reset_for_test()
        await link.stop()


async def test_a_legacy_pin_without_an_encryption_key_gets_no_sync_key():
    """A pin taken before the encryption key was part of the exchange holds
    none. The directory has one — and it is refused, because a key the six
    digits never covered is exactly the one a relay can have put there."""
    peer = Peer("dev-legacy")
    trust_store.pin_device(peer.device_id, sign_key=peer.sign_key, member_id="m1")
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(peer, enc_key=peer.enc_key)]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        sync_keyring.ensure_account_key()
        assert remote_roster.public_key_for(peer.device_id) == peer.enc_key

        assert await link._offer_sync_key(peer.device_id) is False

        assert not [
            s for s in conn.sends
            if json.loads(s.get("text") or "{}").get("kind") == server_link.SYNC_KEY_OFFER
        ], "nothing was sealed to a key nobody compared"
    finally:
        sync_keyring.forget_account_key()
        await link.stop()


async def test_a_message_to_a_paired_device_is_sealed_to_the_pin():
    peer = Peer("dev-paired")
    trust_store.pin_paired_device(
        peer.device_id, sign_key=peer.sign_key, enc_key=peer.enc_key, member_id="m1"
    )
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(peer, enc_key=peer.enc_key)]
    link = await _connected(server)
    try:
        reply = await link.send_message(
            to={"deviceId": peer.device_id, "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="sealed to the pin",
            msg_key="pa:mcp:pin",
        )
        assert reply["ok"] is True
        sent = server.opened[0].sends[0]
        assert _open_as(
            peer, sent["cipher"], from_device=link._device_id, to_device=peer.device_id
        ) == "sealed to the pin"
    finally:
        await link.stop()


async def test_a_directory_that_contradicts_the_pin_is_refused_not_obeyed():
    """The relay swaps the directory entry after the pairing. The send is
    refused outright — not sealed to the relay, not sent in the clear."""
    peer = Peer("dev-paired")
    trust_store.pin_paired_device(
        peer.device_id, sign_key=peer.sign_key, enc_key=peer.enc_key, member_id="m1"
    )
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(peer, enc_key=RELAY_ENC_KEY)]
    link = await _connected(server)
    try:
        reply = await link.send_message(
            to={"deviceId": peer.device_id, "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="must not reach the relay",
            msg_key="pa:mcp:swap",
        )
        assert reply["ok"] is False
        assert reply["error"]["code"] == server_link.LINK_ENCRYPTION_FAILED
        assert server.opened[0].sends == []
    finally:
        await link.stop()


async def test_a_paired_device_the_directory_has_no_key_for_is_still_sealed_to():
    """A pin outranks an absent directory entry too: with the key pinned, the
    directory dropping the field is not a reason to fall back to plaintext."""
    peer = Peer("dev-paired")
    trust_store.pin_paired_device(
        peer.device_id, sign_key=peer.sign_key, enc_key=peer.enc_key, member_id="m1"
    )
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [peer.session_row()]  # no devicePublicKey at all
    link = await _connected(server)
    try:
        assert remote_roster.public_key_for(peer.device_id) == ""
        reply = await link.send_message(
            to={"deviceId": peer.device_id, "workspace": "beta", "paneName": "builder"},
            sender=None,
            text="still sealed",
            msg_key="pa:mcp:nodir",
        )
        assert reply["ok"] is True
        sent = server.opened[0].sends[0]
        assert "text" not in sent
        assert _open_as(
            peer, sent["cipher"], from_device=link._device_id, to_device=peer.device_id
        ) == "still sealed"
    finally:
        await link.stop()


# ---- the two sync-key frames, on the wire in both directions -----------------------


def test_the_sync_key_frames_are_kinds_the_envelope_writes_and_parse_reads():
    """They were server_link constants only, for a while: ``envelope`` refused
    to write them, so no offer ever left a machine, and ``parse`` did not know
    them, so one arriving would have gone to the ordinary message path. The
    tests around the offer stubbed the send and never noticed."""
    for kind in (server_link.SYNC_KEY_REQUEST, server_link.SYNC_KEY_OFFER):
        text = device_pairing.envelope(kind, wrapped="x")
        frame = device_pairing.parse(text)
        assert frame is not None and frame["kind"] == kind


async def test_a_sync_key_offer_from_a_paired_device_is_adopted_over_the_wire():
    peer = Peer("dev-holder")
    trust_store.pin_paired_device(
        peer.device_id, sign_key=peer.sign_key, enc_key=peer.enc_key, member_id="m1"
    )
    sync_keyring.forget_account_key()
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(peer, enc_key=peer.enc_key)]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        theirs = b"\x5a" * 32
        wrapped = device_crypto.seal(
            json.dumps(
                {
                    "v": sync_keyring.RING_VERSION,
                    "gen": 0,
                    "active": sync_keyring.key_id(theirs),
                    "keys": {sync_keyring.key_id(theirs): base64.b64encode(theirs).decode()},
                }
            ),
            recipient_public_key=device_crypto.public_key(),
            from_device=peer.device_id,
            to_device=link._device_id,
        )
        await conn.push(
            {
                "type": "messages.pending",
                "payload": _pair_frame(
                    peer, server_link.SYNC_KEY_OFFER, msg_key="pair-offer", wrapped=wrapped
                ),
            }
        )
        await _until(lambda: sync_keyring.has_account_key(), timeout=10)

        assert sync_keyring.account_key() == theirs
        assert conn.acks[0]["state"] == "delivered"
    finally:
        sync_keyring.forget_account_key()
        await link.stop()


async def test_a_sync_key_request_from_a_paired_device_gets_an_offer_sealed_to_its_pin():
    peer = Peer("dev-newcomer")
    trust_store.pin_paired_device(
        peer.device_id, sign_key=peer.sign_key, enc_key=peer.enc_key, member_id="m1"
    )
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    # The directory names the relay; the offer must still open for the peer.
    server.directory = [_directory_row(peer, enc_key=RELAY_ENC_KEY)]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        mine = sync_keyring.ensure_account_key()
        await conn.push(
            {
                "type": "messages.pending",
                "payload": _pair_frame(peer, server_link.SYNC_KEY_REQUEST, msg_key="pair-req"),
            }
        )
        await _until(
            lambda: any(
                json.loads(s.get("text") or "{}").get("kind") == server_link.SYNC_KEY_OFFER
                for s in conn.sends
            )
        )
        offer = next(
            json.loads(s["text"])
            for s in conn.sends
            if json.loads(s.get("text") or "{}").get("kind") == server_link.SYNC_KEY_OFFER
        )
        ring = json.loads(
            _open_as(peer, offer["wrapped"], from_device=link._device_id, to_device=peer.device_id)
        )
        assert base64.b64decode(ring["keys"][ring["active"]]) == mine
    finally:
        sync_keyring.forget_account_key()
        await link.stop()


async def test_a_sync_key_offer_from_an_unpaired_device_is_ignored():
    """The pairing kinds exist to serve strangers; these two must not."""
    stranger = Peer("dev-stranger")
    sync_keyring.forget_account_key()
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(stranger, enc_key=stranger.enc_key)]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        wrapped = device_crypto.seal(
            base64.b64encode(b"\x5b" * 32).decode(),
            recipient_public_key=device_crypto.public_key(),
            from_device=stranger.device_id,
            to_device=link._device_id,
        )
        await conn.push(
            {
                "type": "messages.pending",
                "payload": _pair_frame(
                    stranger, server_link.SYNC_KEY_OFFER, msg_key="pair-cold", wrapped=wrapped
                ),
            }
        )
        await _until(lambda: bool(conn.acks))
        assert sync_keyring.has_account_key() is False
    finally:
        await link.stop()


# ---- the ring follows the account the link settled ---------------------------------


def _legacy_entry() -> str | None:
    return app.credential_vault.read_app_secret(sync_keyring.ACCOUNT_KEY_SECRET)


async def test_the_link_binds_the_ring_to_the_pinned_account_and_unbinds_on_stop():
    sync_keyring.unbind()
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        assert link.member_id == "m1"
        assert sync_keyring.bound_namespace() == sync_keyring.namespace_for(CONFIG.url, "m1")
        assert sync_keyring.has_account_key() is False  # nothing minted by binding
    finally:
        await link.stop()
    assert sync_keyring.bound_namespace() is None
    sync_keyring._reset_for_test()


async def test_signing_back_in_to_the_same_account_reads_the_same_ring():
    """Sign out is a stop; the ring is not touched by it."""
    sync_keyring.unbind()
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        assert await link.ensure_sync_key() is True
        minted = sync_keyring.account_key()
    finally:
        await link.stop()
    assert sync_keyring.has_account_key() is False

    again = await _connected(FakeServer(policy=ALLOW_ALL_POLICY))
    try:
        assert sync_keyring.account_key() == minted
    finally:
        await again.stop()
    sync_keyring._reset_for_test()
    sync_keyring.bind(sync_keyring.namespace_for(CONFIG.url, "m1"))
    sync_keyring.forget_account_key()
    sync_keyring._reset_for_test()


async def test_the_older_unbound_ring_is_offered_not_adopted_on_sign_in():
    """Signing in never adopts it, even when it can only be this account's.

    Adoption deletes the bare-name secret the previous release reads, which
    that release answers by minting a fresh key — orphaning every record the
    old one wrote, with no way back. So a sign-in leaves it where it is and
    ``legacy_ring_pending`` stays true for the Settings button, which is the
    "explicit, once, never inferred" route ``sync.adopt_legacy_key`` documents.
    """
    sync_keyring.unbind()
    raw = b"\x71" * 32
    app.credential_vault.write_app_secret(
        sync_keyring.ACCOUNT_KEY_SECRET, base64.b64encode(raw).decode()
    )
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        assert sync_keyring.has_account_key() is False, "connecting must not adopt it"
        assert _legacy_entry() is not None, "the bare-name secret is still readable"
        assert sync_keyring.legacy_ring_pending() is True, "Settings can offer it"

        # …and the explicit route still works, which is the whole point of
        # leaving it pending rather than discarding it.
        sync_keyring.adopt_legacy_ring()
        assert sync_keyring.account_key() == raw
        assert _legacy_entry() is None
        assert sync_keyring.legacy_ring_pending() is False
    finally:
        await link.stop()
    sync_keyring.bind(sync_keyring.namespace_for(CONFIG.url, "m1"))
    sync_keyring.forget_account_key()
    sync_keyring._reset_for_test()


async def test_the_older_unbound_ring_is_left_alone_when_another_account_was_seen_here():
    """Two members have been pinned on this machine, so the old ring could be
    either's. It is not attributed, and the account does not mint over it."""
    sync_keyring.unbind()
    trust_store.adopt_own_member(CONFIG.url, "tok-someone-else", "m-other")
    raw = b"\x72" * 32
    app.credential_vault.write_app_secret(
        sync_keyring.ACCOUNT_KEY_SECRET, base64.b64encode(raw).decode()
    )
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    link = await _connected(server)
    try:
        assert sync_keyring.has_account_key() is False
        assert _legacy_entry() is not None
        assert sync_keyring.legacy_ring_pending() is True
        assert await link.ensure_sync_key() is False
        assert sync_keyring.has_account_key() is False, "nothing was minted over it"
        assert _legacy_entry() is not None
    finally:
        await link.stop()
    app.credential_vault.write_app_secret(sync_keyring.ACCOUNT_KEY_SECRET, None)
    sync_keyring._reset_for_test()


# ---- the key goes only to this account's own approved devices ----------------------


def _pinned_for_member(peer: Peer, member_id: str) -> None:
    trust_store.pin_paired_device(
        peer.device_id, sign_key=peer.sign_key, enc_key=peer.enc_key, member_id=member_id
    )


def test_the_sync_key_peer_test_refuses_every_shape_but_one():
    link = server_link.ServerLink(connect=lambda url: None, config_loader=lambda: None)
    link._own_member = "m1"
    ok = {"approved": True, "memberId": "m1", "encKey": "enc"}
    assert link._sync_key_peer(ok, device_id="d", kind="k") == "enc"
    assert link._sync_key_peer(None, device_id="d", kind="k") == ""
    assert link._sync_key_peer({**ok, "approved": False}, device_id="d", kind="k") == ""
    assert link._sync_key_peer({**ok, "memberId": "m-other"}, device_id="d", kind="k") == ""
    assert link._sync_key_peer({**ok, "encKey": ""}, device_id="d", kind="k") == ""
    # And with this machine's own identity unsettled, nobody qualifies.
    link._own_member = ""
    assert link._sync_key_peer(ok, device_id="d", kind="k") == ""


async def test_an_offer_from_another_members_paired_device_is_not_adopted():
    """Paired, approved, encryption key pinned — and somebody else's machine.
    The pane policy may let it drive a pane here; it does not get to decide
    which key this account's records are under."""
    other = Peer("dev-theirs")
    _pinned_for_member(other, "m-other")
    sync_keyring.forget_account_key()
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(other, enc_key=other.enc_key)]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        assert link._own_member == "m1"
        wrapped = device_crypto.seal(
            base64.b64encode(b"\x5c" * 32).decode(),
            recipient_public_key=device_crypto.public_key(),
            from_device=other.device_id,
            to_device=link._device_id,
        )
        await conn.push(
            {
                "type": "messages.pending",
                "payload": _pair_frame(
                    other, server_link.SYNC_KEY_OFFER, msg_key="pair-x", wrapped=wrapped
                ),
            }
        )
        await _until(lambda: bool(conn.acks))
        assert sync_keyring.has_account_key() is False
    finally:
        await link.stop()


async def test_a_request_from_another_members_paired_device_is_not_answered():
    other = Peer("dev-theirs")
    _pinned_for_member(other, "m-other")
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(other, enc_key=other.enc_key)]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        sync_keyring.ensure_account_key()
        await conn.push(
            {
                "type": "messages.pending",
                "payload": _pair_frame(other, server_link.SYNC_KEY_REQUEST, msg_key="pair-r"),
            }
        )
        await _until(lambda: bool(conn.acks))
        assert not [
            s for s in conn.sends
            if json.loads(s.get("text") or "{}").get("kind") == server_link.SYNC_KEY_OFFER
        ], "the account key was handed to another account's device"
        # The direct path refuses the same way.
        assert await link._offer_sync_key(other.device_id) is False
    finally:
        sync_keyring.forget_account_key()
        await link.stop()


async def test_a_legacy_pin_is_named_as_needing_an_unpair_and_a_new_pairing():
    """The route for a pin from before the encryption key was pinned is the
    existing explicit one — unpair, then pair — and the store says which."""
    old = Peer("dev-old")
    trust_store.pin_device(old.device_id, sign_key=old.sign_key, member_id="m1")
    trust_store.approve_device(old.device_id)
    fresh = Peer("dev-new")
    _pinned_for_member(fresh, "m1")
    assert trust_store.legacy_pinned_devices() == ["dev-old"]
    assert trust_store.forget_device("dev-old")["found"] is True
    assert trust_store.legacy_pinned_devices() == []


# ---- provenance for the ring from before accounts were bound -------------------------


async def test_a_second_credential_on_this_machine_blocks_automatic_adoption():
    """Same member, signed in twice — the second fingerprint says nothing about
    which server it was for, so the old ring is not attributed."""
    sync_keyring.unbind()
    trust_store.adopt_own_member(CONFIG.url, "tok-earlier-session", "m1")
    app.credential_vault.write_app_secret(
        sync_keyring.ACCOUNT_KEY_SECRET, base64.b64encode(b"\x73" * 32).decode()
    )
    link = await _connected(FakeServer(policy=ALLOW_ALL_POLICY))
    try:
        assert sync_keyring.legacy_ring_pending() is True
        assert sync_keyring.has_account_key() is False
    finally:
        await link.stop()
    app.credential_vault.write_app_secret(sync_keyring.ACCOUNT_KEY_SECRET, None)
    sync_keyring._reset_for_test()


async def test_the_same_member_on_another_server_blocks_automatic_adoption():
    sync_keyring.unbind()
    trust_store.adopt_own_member("wss://elsewhere.example/ws", "tok-abc", "m1")
    app.credential_vault.write_app_secret(
        sync_keyring.ACCOUNT_KEY_SECRET, base64.b64encode(b"\x74" * 32).decode()
    )
    link = await _connected(FakeServer(policy=ALLOW_ALL_POLICY))
    try:
        assert sync_keyring.legacy_ring_pending() is True
        assert sync_keyring.has_account_key() is False
    finally:
        await link.stop()
    app.credential_vault.write_app_secret(sync_keyring.ACCOUNT_KEY_SECRET, None)
    sync_keyring._reset_for_test()


# ---- what a change of account lets go of --------------------------------------------


async def test_reconnecting_as_the_same_account_clears_nothing(monkeypatch):
    from agent_team_backend import sync_scopes

    calls: list[str] = []
    monkeypatch.setattr(sync_scopes, "on_account_changed", lambda: calls.append("cleared"))
    monkeypatch.setattr(server_link, "_settled_account", None)
    for _ in range(2):
        link = await _connected(FakeServer(policy=ALLOW_ALL_POLICY))
        await link.stop()
    assert calls == []
    assert server_link._settled_account == sync_keyring.namespace_for(CONFIG.url, "m1")
    sync_keyring._reset_for_test()


async def test_a_different_account_signing_in_clears_the_previous_ones_imports(monkeypatch):
    """Switching accounts is where imported credentials would otherwise wait
    for the next account to publish them. The ring is not what goes: it stays
    under the first account's namespace for its next sign-in."""
    from agent_team_backend import sync_scopes
    from agent_team_backend.server_link import ServerLinkConfig

    from .test_server_link_trust import _impersonating

    calls: list[str] = []
    monkeypatch.setattr(sync_scopes, "on_account_changed", lambda: calls.append("cleared"))
    monkeypatch.setattr(server_link, "_settled_account", None)

    first = await _connected(FakeServer(policy=ALLOW_ALL_POLICY))
    assert await first.ensure_sync_key() is True
    first_key = sync_keyring.account_key()
    await first.stop()
    assert calls == []

    other = FakeServer(responder=_impersonating("m2"), policy=ALLOW_ALL_POLICY)
    second = await _connected(other, config=ServerLinkConfig(url=CONFIG.url, token="tok-other"))
    try:
        assert second.member_id == "m2"
        assert calls == ["cleared"]
        assert sync_keyring.has_account_key() is False
    finally:
        await second.stop()

    # Signing out afterwards clears once more; the first account's ring survived both.
    await server_link._note_account(None)
    assert calls == ["cleared", "cleared"]
    sync_keyring.bind(sync_keyring.namespace_for(CONFIG.url, "m1"))
    assert sync_keyring.account_key() == first_key
    sync_keyring.forget_account_key()
    sync_keyring._reset_for_test()
    monkeypatch.setattr(server_link, "_settled_account", None)


# ---- after a rotation, every eligible peer is offered the ring ---------------------


async def test_after_a_rotation_every_eligible_peer_is_offered_the_ring_and_no_other():
    mine = Peer("dev-mine")
    _pinned_for_member(mine, "m1")
    theirs = Peer("dev-theirs")
    _pinned_for_member(theirs, "m-other")
    old = Peer("dev-old")
    trust_store.pin_device(old.device_id, sign_key=old.sign_key, member_id="m1")
    trust_store.approve_device(old.device_id)
    server = FakeServer(policy=ALLOW_ALL_POLICY)
    server.directory = [_directory_row(mine, enc_key=RELAY_ENC_KEY)]
    link = await _connected(server)
    try:
        conn = server.opened[0]
        sync_keyring.ensure_account_key()
        new_kid = sync_keyring.rotate_account_key()

        summary = await link.offer_sync_key_to_peers()

        assert summary["offered"] == ["dev-mine"]
        assert sorted(summary["skipped"]) == ["dev-old", "dev-theirs"]
        offers = [
            json.loads(s["text"]) for s in conn.sends
            if json.loads(s.get("text") or "{}").get("kind") == server_link.SYNC_KEY_OFFER
        ]
        assert [s["to"]["deviceId"] for s in conn.sends if "text" in s] == ["dev-mine"]
        ring = json.loads(
            _open_as(mine, offers[0]["wrapped"], from_device=link._device_id, to_device="dev-mine")
        )
        assert ring["active"] == new_kid and ring["gen"] == 1
    finally:
        sync_keyring.forget_account_key()
        await link.stop()
    assert (await server_link.offer_sync_key_to_peers())["error"] == "not-connected"
