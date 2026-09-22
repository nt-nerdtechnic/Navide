"""The six digits, and the state machine around them.

The pairing this replaced went one way: you picked a device out of a list, typed
four characters of its fingerprint, and it was allowed to drive the CLIs on your
machine — without anybody at that machine being asked or told. What follows pins
down the exchange that replaced it, and the property the whole thing rests on:
the relay carries every frame and can rewrite any field, but it cannot make two
different key pairs produce the same six digits.
"""

from __future__ import annotations

import contextlib
import time

import pytest

from agent_team_backend import device_pairing


@pytest.fixture(autouse=True)
def _clean():
    device_pairing._reset_for_test()
    yield
    device_pairing._reset_for_test()


KEY_A = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQT0="
KEY_B = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI9"
ENC_A = "RUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUU9"
ENC_B = "RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkY9"
NONCE_A = "bm9uY2UtYQ=="
NONCE_B = "bm9uY2UtYg=="


def _sas(**overrides):
    """The honest code, with any one input replaced."""
    inputs = dict(
        key_a=KEY_A, key_b=KEY_B, enc_a=ENC_A, enc_b=ENC_B, nonce_a=NONCE_A, nonce_b=NONCE_B
    )
    inputs.update(overrides)
    return device_pairing.sas(**inputs)


# ---- the code ----------------------------------------------------------------


def test_both_ends_derive_the_same_code_from_opposite_points_of_view() -> None:
    """Neither machine knows which of them is "a". The code has to come out the
    same anyway, or every honest pairing would look like an attack."""
    mine = _sas()
    theirs = _sas(
        key_a=KEY_B, key_b=KEY_A, enc_a=ENC_B, enc_b=ENC_A, nonce_a=NONCE_B, nonce_b=NONCE_A
    )
    assert mine == theirs
    assert mine


def test_a_known_input_gives_a_known_code() -> None:
    """A fixed answer, because every other test here compares the function with
    itself.

    Change the marker or the separator and all of them still pass — the two ends
    are computed by the same code, so they agree on whatever it now produces.
    What they would not agree with is a *peer running the previous build*, and
    the symptom is two people staring at different digits with no idea why. This
    is the one assertion that notices.

    Changed once on purpose, when the encryption keys joined the hash: a peer on
    the build before that shows different digits to this one, which is the
    intended outcome — it also sends no encryption key, and is refused.
    """
    assert _sas() == "505 222"


def test_the_code_is_six_digits_a_person_can_read_aloud() -> None:
    code = _sas()
    assert len(code) == 7 and code[3] == " "
    assert code.replace(" ", "").isdigit()


def test_swapping_a_key_makes_the_two_ends_disagree() -> None:
    """The whole protection, in one assertion.

    The relay carries every frame and can rewrite any field. What it cannot do
    is hold a key of its own in the middle *and* have both people see the same
    digits: change either public key and the two ends compute different codes,
    which is what the comparison catches.
    """
    honest = _sas()
    relay_key = "UkVMQVlSRUxBWVJFTEFZUkVMQVlSRUxBWVJFTEFZUkU9"
    # What the initiator computes when the relay substitutes its own key on the
    # way to it, while the responder still believes it is talking to the peer.
    tampered = _sas(key_b=relay_key)
    assert tampered != honest


def test_swapping_an_encryption_key_makes_the_two_ends_disagree_too() -> None:
    """The half the first version left out.

    The signing key says who sent a frame; the encryption key says who can open
    what is sealed to this device — the account sync key among other things. A
    code over the signing keys alone let a relay leave every signature intact,
    swap the encryption key in the directory, and be handed every sealed box
    while two people agreed on the digits. Swapping it now changes the digits.
    """
    honest = _sas()
    relay_enc = "UkVMQVktRU5DLUtFWS1SRUxBWS1FTkMtS0VZLVJFTEFZLQ=="
    assert _sas(enc_b=relay_enc) != honest
    assert _sas(enc_a=relay_enc) != honest


def test_an_encryption_key_cannot_be_moved_to_the_other_signing_key() -> None:
    """Ordered with its signing key, like the nonce, for the same reason."""
    assert _sas(enc_a=ENC_B, enc_b=ENC_A) != _sas()


def test_changing_either_nonce_changes_the_code() -> None:
    """Both sides contribute, so neither can pick the digits on its own."""
    base = _sas()
    assert _sas(nonce_a="b3RoZXI=") != base
    assert _sas(nonce_b="b3RoZXI=") != base


def test_a_nonce_cannot_be_moved_to_the_other_key() -> None:
    """The nonces travel with their keys rather than being sorted separately.

    Sorted apart, a relay could pair one side's nonce with the other's key and
    still land on the same digest — the digits would match while the two ends
    were describing different pairings.
    """
    honest = _sas()
    crossed = _sas(nonce_a=NONCE_B, nonce_b=NONCE_A)
    assert crossed != honest


def test_half_an_exchange_produces_no_code_at_all() -> None:
    """A code over missing input would still be six digits, and two people could
    still successfully compare it."""
    assert _sas(key_b="") == ""
    assert _sas(nonce_a="") == ""
    assert _sas(enc_a="") == ""
    assert _sas(enc_b="") == ""


def test_nonces_are_not_predictable() -> None:
    assert len({device_pairing.new_nonce() for _ in range(50)}) == 50


# ---- the state machine -------------------------------------------------------


def test_the_initiator_walks_request_response_confirm() -> None:
    pairing = device_pairing.begin("dev-b", device_name="M3")
    assert pairing.state == device_pairing.STATE_AWAITING_RESPONSE
    assert pairing.role == device_pairing.ROLE_INITIATOR
    assert pairing.our_nonce and not pairing.their_nonce

    device_pairing.accept_response("dev-b", their_key=KEY_B, their_enc_key=ENC_B, their_nonce=NONCE_B)
    assert device_pairing.get("dev-b").state == device_pairing.STATE_AWAITING_LOCAL

    device_pairing.confirm("dev-b")
    assert device_pairing.get("dev-b").state == device_pairing.STATE_AWAITING_REMOTE


def test_the_responder_starts_with_both_nonces_and_its_own_turn() -> None:
    pairing = device_pairing.accept_request(
        "dev-a", device_name="M4", their_key=KEY_A, their_enc_key=ENC_A, their_nonce=NONCE_A
    )
    assert pairing.role == device_pairing.ROLE_RESPONDER
    assert pairing.state == device_pairing.STATE_AWAITING_LOCAL
    assert pairing.their_nonce == NONCE_A and pairing.our_nonce


def test_only_one_exchange_per_device_at_a_time() -> None:
    """Two would put two codes on screen for the same pair of machines, and the
    person comparing has no way to tell which card belongs to which."""
    device_pairing.begin("dev-b", device_name="M3")
    with pytest.raises(device_pairing.PairingError):
        device_pairing.begin("dev-b", device_name="M3")
    with pytest.raises(device_pairing.PairingError):
        device_pairing.accept_request(
            "dev-b", device_name="M3", their_key=KEY_B, their_enc_key=ENC_B, their_nonce=NONCE_B
        )


@contextlib.contextmanager
def _frozen(when: float):
    """Run the block as if it were *when*. The clock is what these tests are
    about, so it has to be an input rather than however long the test took."""
    real = time.time
    device_pairing.time.time = lambda: when  # type: ignore[assignment]
    try:
        yield
    finally:
        device_pairing.time.time = real  # type: ignore[assignment]


def test_a_request_expires_and_stops_being_answerable() -> None:
    """A request nobody remembers starting must not be confirmable later.

    Driven by ``deadline``, not by ``started_at``: the clock restarts once when
    the digits appear, and expiry has to follow the clock that is running rather
    than the one it replaced.
    """
    pairing = device_pairing.begin("dev-b", device_name="M3")
    pairing.deadline = time.time() - 1

    assert device_pairing.get("dev-b") is None
    with pytest.raises(device_pairing.PairingError):
        device_pairing.confirm("dev-b")


def test_an_unanswered_request_still_expires_on_the_original_clock() -> None:
    """The half that must not get longer. Nobody answered, so nothing was ever
    on a second screen — a mistaken or hostile request goes away exactly as
    fast as it did before."""
    pairing = device_pairing.begin("dev-quiet", device_name="M3")

    assert pairing.deadline == pytest.approx(pairing.started_at + device_pairing.REQUEST_TTL_S)
    assert pairing.extended is False
    assert pairing.expired(pairing.started_at + device_pairing.REQUEST_TTL_S + 1)


def test_the_clock_restarts_when_the_digits_appear() -> None:
    """Five minutes from pressing Pair is the wrong window for the thing the
    initiator is now asked to do: press, walk to the other machine, compare.
    Most of that window used to run out while there was nothing to compare."""
    pairing = device_pairing.begin("dev-late", device_name="M3")
    original = pairing.deadline
    late = pairing.started_at + device_pairing.REQUEST_TTL_S - 1

    with _frozen(late):
        device_pairing.accept_response("dev-late", their_key=KEY_B, their_enc_key=ENC_B, their_nonce=NONCE_B)

    assert pairing.deadline > original
    assert pairing.deadline == pytest.approx(late + device_pairing.REQUEST_TTL_S)
    # Comfortably past the original deadline, and still answerable.
    assert not pairing.expired(original + 1)


def test_the_clock_restarts_once_and_not_per_frame() -> None:
    """Otherwise a device that keeps sending holds the exchange open for ever,
    which is not a longer expiry — it is the absence of one."""
    pairing = device_pairing.accept_request(
        "dev-chatty", device_name="M4", their_key=KEY_A, their_enc_key=ENC_A, their_nonce=NONCE_A
    )
    after_first = pairing.deadline

    # Every later frame goes through the same call; none of them may move it.
    for offset in (60, 120, 240):
        pairing.extend_once(pairing.started_at + offset)

    assert pairing.deadline == after_first
    assert pairing.expired(after_first + 1)


def test_a_response_out_of_order_is_refused() -> None:
    device_pairing.accept_request(
        "dev-a", device_name="M4", their_key=KEY_A, their_enc_key=ENC_A, their_nonce=NONCE_A
    )
    with pytest.raises(device_pairing.PairingError):
        device_pairing.accept_response("dev-a", their_key=KEY_A, their_enc_key=ENC_A, their_nonce=NONCE_A)


def test_a_response_cannot_revise_the_key_the_request_carried() -> None:
    """Otherwise the relay could wait until the code was on screen and then swap
    the key it covers."""
    device_pairing.begin("dev-b", device_name="M3", their_key=KEY_B, their_enc_key=ENC_B)
    with pytest.raises(device_pairing.PairingError):
        device_pairing.accept_response(
            "dev-b", their_key=KEY_A, their_enc_key=ENC_B, their_nonce=NONCE_B
        )


def test_a_response_cannot_revise_the_encryption_key_either() -> None:
    device_pairing.begin("dev-b", device_name="M3", their_key=KEY_B, their_enc_key=ENC_B)
    with pytest.raises(device_pairing.PairingError):
        device_pairing.accept_response(
            "dev-b", their_key=KEY_B, their_enc_key=ENC_A, their_nonce=NONCE_B
        )
    assert device_pairing.get("dev-b").their_enc_key == ENC_B


def test_a_frame_without_an_encryption_key_is_refused_not_completed() -> None:
    """Fail closed. The alternative — reading the missing key from the directory
    — is exactly the substitution the six digits now exist to catch, and a peer
    on the previous build is one that has to update before it can pair."""
    with pytest.raises(device_pairing.PairingError):
        device_pairing.accept_request(
            "dev-old", device_name="M4", their_key=KEY_A, their_enc_key="", their_nonce=NONCE_A
        )
    assert device_pairing.get("dev-old") is None

    device_pairing.begin("dev-b", device_name="M3")
    with pytest.raises(device_pairing.PairingError):
        device_pairing.accept_response(
            "dev-b", their_key=KEY_B, their_enc_key="", their_nonce=NONCE_B
        )
    assert device_pairing.get("dev-b").state == device_pairing.STATE_AWAITING_RESPONSE


def test_the_code_covers_the_encryption_key_the_exchange_fixed() -> None:
    pairing = device_pairing.accept_request(
        "dev-a", device_name="M4", their_key=KEY_A, their_enc_key=ENC_A, their_nonce=NONCE_A
    )
    shown = device_pairing.code_for(pairing, our_key=KEY_B, our_enc_key=ENC_B)
    assert shown == device_pairing.sas(
        key_a=KEY_B, key_b=KEY_A, enc_a=ENC_B, enc_b=ENC_A,
        nonce_a=pairing.our_nonce, nonce_b=NONCE_A,
    )
    assert shown != device_pairing.code_for(pairing, our_key=KEY_B, our_enc_key=ENC_A)


def test_confirming_twice_is_refused() -> None:
    device_pairing.accept_request(
        "dev-a", device_name="M4", their_key=KEY_A, their_enc_key=ENC_A, their_nonce=NONCE_A
    )
    device_pairing.confirm("dev-a")
    with pytest.raises(device_pairing.PairingError):
        device_pairing.confirm("dev-a")


def test_cancelling_leaves_nothing_to_confirm() -> None:
    device_pairing.begin("dev-b", device_name="M3")
    assert device_pairing.cancel("dev-b") is not None
    assert device_pairing.cancel("dev-b") is None
    with pytest.raises(device_pairing.PairingError):
        device_pairing.confirm("dev-b")


# ---- the wire ----------------------------------------------------------------


def test_a_frame_survives_the_round_trip() -> None:
    text = device_pairing.envelope(
        device_pairing.PAIR_REQUEST, nonce=NONCE_A, signKey=KEY_A
    )
    frame = device_pairing.parse(text)
    assert frame["kind"] == device_pairing.PAIR_REQUEST
    assert frame["nonce"] == NONCE_A and frame["signKey"] == KEY_A


def test_an_ordinary_message_is_not_mistaken_for_a_frame() -> None:
    """The body is otherwise free text going to a CLI. Something a person could
    plausibly type must never put a pairing card on somebody's screen."""
    for text in (
        "please review the diff",
        '{"kind": "pair-request"}',
        '{"marker": "something-else", "kind": "pair-request"}',
        "navide/pair/v1",
        "",
    ):
        assert device_pairing.parse(text) is None


def test_an_unknown_kind_is_not_a_frame() -> None:
    """A body this build cannot read has to fall through to being an ordinary
    message, or a future kind would vanish instead of being refused visibly."""
    assert device_pairing.parse('{"marker": "navide/pair/v1", "kind": "pair-later"}') is None


def test_an_unknown_kind_cannot_be_sent_either() -> None:
    with pytest.raises(device_pairing.PairingError):
        device_pairing.envelope("pair-whatever")


# ---- both sides, or neither --------------------------------------------------


def test_the_responder_alone_cannot_finish_it() -> None:
    """The half that carries the security property.

    Somebody asked to come in; a person here says whether the digits match. The
    asking side's own click could never be that check — it is the party being
    authenticated — so a responder that confirmed and then heard nothing back
    must still not be paired.
    """
    device_pairing.accept_request(
        "dev-a", device_name="M4", their_key=KEY_A, their_enc_key=ENC_A, their_nonce=NONCE_A
    )
    device_pairing.confirm("dev-a")

    assert device_pairing.complete("dev-a") is None
    assert device_pairing.get("dev-a").state == device_pairing.STATE_AWAITING_REMOTE


def test_the_peer_confirming_does_not_answer_for_the_responder() -> None:
    """If their confirm alone finished it, the person at this end could still be
    looking at the card when the pin was written — and "refuse" would mean
    nothing, because the answer had already been given for them."""
    device_pairing.accept_request(
        "dev-a", device_name="M4", their_key=KEY_A, their_enc_key=ENC_A, their_nonce=NONCE_A
    )
    device_pairing.note_peer_confirmed("dev-a")

    assert device_pairing.complete("dev-a") is None
    assert device_pairing.get("dev-a") is not None


def test_the_initiator_is_not_finished_by_the_other_side_alone() -> None:
    """The asymmetry this replaced was a CRITICAL, and the reason is the relay.

    It used to finish on the far end's confirm alone, reasoning that comparing
    digits is one act by one person at two screens. That holds when there *is*
    another machine and another person. A relay can decline to forward the
    request and answer with its own key — the first frame of an exchange is
    verified against the key it carries — and the initiator would pin it,
    approved, having compared nothing with nobody.

    The digits cannot rescue it either: the SAS comes from two public keys and
    two nonces, and a relay supplies half and receives the other half, so it
    knows them. Only a person reading two screens is outside its reach.
    """
    device_pairing.begin("dev-b", device_name="M3")
    device_pairing.accept_response("dev-b", their_key=KEY_B, their_enc_key=ENC_B, their_nonce=NONCE_B)

    # The far side answers. On its own that used to be enough.
    device_pairing.note_peer_confirmed("dev-b")
    assert device_pairing.complete("dev-b") is None, "nobody here compared anything yet"

    device_pairing.confirm("dev-b")
    finished = device_pairing.complete("dev-b")
    assert finished is not None and finished.their_key == KEY_B
    assert finished.we_confirmed and finished.peer_confirmed


def test_the_initiator_grants_nothing_while_it_waits() -> None:
    """What the extra step buys: pressing Pair and walking away is safe.

    Not "less is granted" — *nothing* is. No pin, so no ring and no policy
    exception; a message from that device is refused as unpaired like any
    stranger's.
    """
    device_pairing.begin("dev-wait", device_name="M3")
    device_pairing.accept_response("dev-wait", their_key=KEY_B, their_enc_key=ENC_B, their_nonce=NONCE_B)
    device_pairing.note_peer_confirmed("dev-wait")

    assert device_pairing.complete("dev-wait") is None
    pending = device_pairing.get("dev-wait")
    assert pending is not None and pending.we_confirmed is False
    # And the digits are on the card, which is the whole point of the wait.
    assert device_pairing.code_for(pending, our_key=KEY_A, our_enc_key=ENC_A)


def test_both_confirming_pairs_the_responder_once_in_either_order() -> None:
    for first_is_peer in (False, True):
        device_pairing._reset_for_test()
        device_pairing.accept_request(
            "dev-a", device_name="M4", their_key=KEY_A, their_enc_key=ENC_A, their_nonce=NONCE_A
        )
        if first_is_peer:
            device_pairing.note_peer_confirmed("dev-a")
            device_pairing.confirm("dev-a")
        else:
            device_pairing.confirm("dev-a")
            device_pairing.note_peer_confirmed("dev-a")

        finished = device_pairing.complete("dev-a")
        assert finished is not None and finished.their_key == KEY_A
        # Gone, so a duplicate confirm cannot pin a second time.
        assert device_pairing.complete("dev-a") is None


def test_a_late_peer_confirm_finds_nothing_to_agree_with() -> None:
    """Their confirm for an exchange this side already dropped — a refusal here,
    or an expiry — must not resurrect it."""
    device_pairing.begin("dev-b", device_name="M3")
    device_pairing.cancel("dev-b")

    assert device_pairing.note_peer_confirmed("dev-b") is None
    assert device_pairing.complete("dev-b") is None
