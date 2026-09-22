"""Two people, two machines, one code read aloud.

The pairing this replaces went one way: you picked another device out of a list,
typed four characters of its fingerprint, and that machine was now allowed to
drive the CLIs here — without anybody at that machine being asked, or even told.
Whoever was sitting there found out when something started running.

This is the short-authentication-string dance instead. Both sides contribute a
nonce, both derive the same six digits from *both signing keys, both encryption
keys and both nonces*, and a person at each end confirms the digits match.
Neither machine is pinned until both have.

**Why the code is derived rather than sent.** The relay carries every one of
these messages and could rewrite any field in them. What it cannot do is make
two different key pairs hash to the same six digits: swap either public key on
the way past and the two ends compute different codes, so the people comparing
them see a mismatch. That is the whole of the protection, and it is why the SAS
covers the keys rather than only the nonces — a code over nonces alone would
match perfectly while the relay held a key of its own in the middle.

**Why the encryption key is in it too.** The signing key proves who *sent* a
frame; the X25519 encryption key decides who can *open* what is sealed — the
account sync key among other things. The first version hashed only the signing
keys and read the encryption key from the server's directory afterwards, so a
relay that left the signatures alone and swapped the directory entry had every
sealed box addressed to itself, with two people happily agreeing on the digits.
Both keys ride the pairing frames now, both are in the SAS, and both are pinned
together; a frame without an encryption key is refused rather than filled in
from the directory.

Six digits is 20 bits: a relay that guesses gets one attempt in a million per
try, and a mismatch ends the pairing rather than inviting another. That is the
usual trade — it is short enough for a person to read across a desk, which is
the property that makes anybody actually do it.

**What is deliberately not here.** No pairing survives a restart. The state is
in memory and a backend that comes back has forgotten every half-finished
exchange, which is the safe direction: the alternative is a pending request
somebody can confirm hours later without remembering what they started.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

#: The message kinds this exchange uses. They ride the ordinary encrypted
#: message channel, and the receiver picks them out before anything pane-shaped
#: happens to them — they address a machine, not a pane.
PAIR_REQUEST = "pair-request"
PAIR_RESPONSE = "pair-response"
PAIR_CONFIRM = "pair-confirm"
PAIR_REJECT = "pair-reject"
PAIR_REVOKED = "pair-revoked"

#: The account sync key travels between two ALREADY PAIRED devices on the same
#: reserved address as the pairing exchange, so its two frames are pairing
#: kinds too: ``envelope`` will not write a kind it does not know, and ``parse``
#: hands anything it does not know to the ordinary message path. They lived in
#: server_link alone for a while, which meant exactly that — the offer was
#: refused on the way out, and would have been typed into a pane on the way in.
SYNC_KEY_REQUEST = "sync-key-request"
SYNC_KEY_OFFER = "sync-key-offer"

PAIR_KINDS = frozenset(
    {
        PAIR_REQUEST,
        PAIR_RESPONSE,
        PAIR_CONFIRM,
        PAIR_REJECT,
        PAIR_REVOKED,
        SYNC_KEY_REQUEST,
        SYNC_KEY_OFFER,
    }
)

#: The marker that tells a pairing message from somebody's chat. Deliberately
#: not a word anyone would type: the body is otherwise free text going to a CLI,
#: and a message that could be mistaken for this one would be a way to put a
#: pairing card on a stranger's screen.
ENVELOPE_MARKER = "navide/pair/v1"

#: How long a request stays answerable. Long enough to walk to the other
#: machine, short enough that a request nobody remembers starting cannot be
#: confirmed later.
REQUEST_TTL_S = 300.0

#: Where each side is. The two "waiting" states are different questions: one
#: side is waiting to be *asked*, the other has already been asked and is
#: waiting for its own person.
STATE_AWAITING_RESPONSE = "awaiting-response"   # we asked; they have not replied
STATE_AWAITING_LOCAL = "awaiting-local"         # both nonces known; our turn to confirm
STATE_AWAITING_REMOTE = "awaiting-remote"       # we confirmed; waiting on them

#: Which side started it. Only used to say the right sentence on screen —
#: nothing about the exchange itself depends on it.
ROLE_INITIATOR = "initiator"
ROLE_RESPONDER = "responder"

_lock = threading.Lock()


@dataclass
class Pairing:
    """One in-flight exchange with one device."""

    device_id: str
    device_name: str
    role: str
    state: str
    #: Their signing key, as carried in the message that started this. Never
    #: read from the directory: the directory is the relay's word, and the code
    #: below exists precisely to check the relay.
    their_key: str
    our_nonce: str
    #: Their X25519 encryption key, fixed by the first frame that carries one
    #: and covered by the SAS like the signing key. Same rule about the
    #: directory: never read from it.
    their_enc_key: str = ""
    their_nonce: str = ""
    started_at: float = field(default_factory=time.time)
    #: When this exchange stops being answerable. Initialised to
    #: ``started_at + REQUEST_TTL_S`` and moved once — see ``extend_once``.
    #:
    #: Deliberately one field rather than a start time and a flag that
    #: ``expired`` has to combine: the question "is this still answerable" has
    #: one answer, and two time values compared at the point of asking is the
    #: shape the next off-by-one comes in.
    deadline: float = 0.0
    #: Whether the clock has already been restarted. Once, not per frame: a
    #: relay that keeps sending could otherwise hold an exchange open for ever.
    extended: bool = False
    #: Set once this side's person has said the digits match.
    we_confirmed: bool = False
    #: Set when their ``pair-confirm`` arrives.
    peer_confirmed: bool = False

    def __post_init__(self) -> None:
        if not self.deadline:
            self.deadline = self.started_at + REQUEST_TTL_S

    def expired(self, now: float | None = None) -> bool:
        return (now or time.time()) > self.deadline

    def extend_once(self, now: float) -> None:
        """Restart the clock when the digits first become displayable here.

        Five minutes from *pressing Pair* is the wrong window for the thing the
        initiator is now asked to do. It has to press, walk to the other
        machine, and compare — and the old clock was already running through the
        part where there was nothing to compare yet. Restarting when the SAS
        appears gives the comparison its own full window; a request nobody
        answers still expires on the original one, so a mistaken or hostile
        request does not sit on somebody's screen any longer than before.

        Once. Extending per frame would let a device that keeps sending hold the
        exchange open indefinitely, which is a denial of the expiry rather than
        a longer one.
        """
        if self.extended:
            return
        self.extended = True
        self.deadline = now + REQUEST_TTL_S


_pairings: dict[str, Pairing] = {}


# ---- the wire -----------------------------------------------------------------
#
# These ride the ordinary message channel as plain text rather than sealed.
# Nothing in them is a secret: the nonces and the public keys are meant to be
# seen, and the protection comes from the signature over the frame plus the
# digits two people compare. Sealing would need the other machine's encryption
# key before there is any relationship in which to have learned it, which is
# the problem this exchange exists to solve.


def envelope(kind: str, **fields: Any) -> str:
    """One pairing frame, as the text body of an ordinary message."""
    import json

    if kind not in PAIR_KINDS:
        raise PairingError(f"unknown pairing kind {kind!r}")
    return json.dumps({"marker": ENVELOPE_MARKER, "kind": kind, **fields}, sort_keys=True)


def parse(text: Any) -> dict[str, Any] | None:
    """The pairing frame in *text*, or None when it is not one.

    None for everything it cannot read, including well-formed JSON with the
    wrong marker: a body this build does not recognise as pairing has to fall
    through to being an ordinary message, or a future kind would silently
    vanish instead of being refused visibly.
    """
    import json

    if not isinstance(text, str) or ENVELOPE_MARKER not in text:
        return None
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("marker") != ENVELOPE_MARKER:
        return None
    if data.get("kind") not in PAIR_KINDS:
        return None
    return data


# ---- the code itself ---------------------------------------------------------


def new_nonce() -> str:
    """One side's contribution. 16 bytes, so neither end can steer the digits by
    grinding its own half: to force a chosen code a party would have to search
    the other's nonce space, and it does not get to choose that."""
    return base64.b64encode(secrets.token_bytes(16)).decode("ascii")


def sas(
    *,
    key_a: str,
    key_b: str,
    enc_a: str,
    enc_b: str,
    nonce_a: str,
    nonce_b: str,
) -> str:
    """The six digits both machines show, as ``"482 913"``.

    The signing keys are sorted so that the two ends — which disagree about
    which of them is "a" — hash the same bytes. The encryption key and the nonce
    are ordered to match their signing key rather than sorted independently, or
    a relay could pair one side's nonce (or encryption key) with the other's
    signing key and still land on a matching digest.

    Empty on missing input rather than hashing whatever is there: a code
    computed from half an exchange would be a code two people could still
    successfully compare.
    """
    if not (key_a and key_b and enc_a and enc_b and nonce_a and nonce_b):
        return ""
    first, second = (
        ((key_a, enc_a, nonce_a), (key_b, enc_b, nonce_b))
        if key_a <= key_b
        else ((key_b, enc_b, nonce_b), (key_a, enc_a, nonce_a))
    )
    payload = "\x00".join(
        (
            ENVELOPE_MARKER,
            first[0], second[0],
            first[1], second[1],
            first[2], second[2],
        )
    ).encode("utf-8")
    digest = hashlib.sha256(payload).digest()
    code = int.from_bytes(digest[:4], "big") % 1_000_000
    text = f"{code:06d}"
    return f"{text[:3]} {text[3:]}"


def code_for(pairing: Pairing, *, our_key: str, our_enc_key: str) -> str:
    return sas(
        key_a=our_key,
        key_b=pairing.their_key,
        enc_a=our_enc_key,
        enc_b=pairing.their_enc_key,
        nonce_a=pairing.our_nonce,
        nonce_b=pairing.their_nonce,
    )


# ---- the state machine -------------------------------------------------------


class PairingError(Exception):
    """A transition that must not happen. Carries a short reason for the wire."""


def _sweep(now: float) -> None:
    for device_id, pairing in list(_pairings.items()):
        if pairing.expired(now):
            log.info("pairing with %s expired before it was confirmed", device_id)
            _pairings.pop(device_id, None)


def get(device_id: str) -> Pairing | None:
    with _lock:
        _sweep(time.time())
        return _pairings.get(device_id)


def active() -> list[Pairing]:
    with _lock:
        _sweep(time.time())
        return list(_pairings.values())


def begin(
    device_id: str, *, device_name: str, their_key: str = "", their_enc_key: str = ""
) -> Pairing:
    """Start asking *device_id* to pair. Raises when one is already in flight.

    One at a time per device, because two exchanges would produce two codes for
    the same pair of machines and the person comparing them has no way to tell
    which card belongs to which.
    """
    with _lock:
        now = time.time()
        _sweep(now)
        if device_id in _pairings:
            raise PairingError("a pairing with that device is already in progress")
        pairing = Pairing(
            device_id=device_id,
            device_name=device_name,
            role=ROLE_INITIATOR,
            state=STATE_AWAITING_RESPONSE,
            their_key=their_key,
            their_enc_key=their_enc_key,
            our_nonce=new_nonce(),
        )
        _pairings[device_id] = pairing
        return pairing


def accept_request(
    device_id: str,
    *,
    device_name: str,
    their_key: str,
    their_enc_key: str,
    their_nonce: str,
) -> Pairing:
    """Record an incoming request. This side now owes a response and a decision.

    A request without an encryption key is refused, not completed from the
    directory: the directory is the relay's word, and a key taken from there
    would be the one key the six digits never checked.
    """
    if not their_key or not their_nonce:
        raise PairingError("the request carries no key or no nonce")
    if not their_enc_key:
        raise PairingError("the request carries no encryption key")
    with _lock:
        now = time.time()
        _sweep(now)
        if device_id in _pairings:
            # Their request and ours crossed, or they asked twice. Either way the
            # earlier exchange is the one with a code already on somebody's
            # screen, so the new request is refused rather than silently
            # replacing it.
            raise PairingError("a pairing with that device is already in progress")
        pairing = Pairing(
            device_id=device_id,
            device_name=device_name,
            role=ROLE_RESPONDER,
            state=STATE_AWAITING_LOCAL,
            their_key=their_key,
            their_enc_key=their_enc_key,
            our_nonce=new_nonce(),
            their_nonce=their_nonce,
        )
        # Both ends restart the clock when the digits appear on *their* screen,
        # and the person who has to walk over exists at either end. For this one
        # the two moments coincide — the request arrives with their nonce, so
        # the SAS is displayable the instant the exchange exists — but going
        # through the same call is what keeps the rule in one place instead of
        # being an argument about why one side does not need it.
        pairing.extend_once(now)
        _pairings[device_id] = pairing
        return pairing


def accept_response(
    device_id: str, *, their_key: str, their_enc_key: str, their_nonce: str
) -> Pairing:
    """The other side answered our request. Both nonces are now known."""
    with _lock:
        _sweep(time.time())
        pairing = _pairings.get(device_id)
        if pairing is None:
            raise PairingError("no pairing with that device is in progress")
        if pairing.state != STATE_AWAITING_RESPONSE:
            raise PairingError(f"a response does not belong in state {pairing.state}")
        if not their_nonce:
            raise PairingError("the response carries no nonce")
        # Their key is fixed by the first message that carried one. Letting a
        # later frame revise it would let the relay wait until the code was on
        # screen and then swap the key it covers.
        if pairing.their_key and their_key and their_key != pairing.their_key:
            raise PairingError("the response offers a different signing key")
        if not their_enc_key:
            raise PairingError("the response carries no encryption key")
        if pairing.their_enc_key and their_enc_key != pairing.their_enc_key:
            raise PairingError("the response offers a different encryption key")
        pairing.their_key = pairing.their_key or their_key
        pairing.their_enc_key = pairing.their_enc_key or their_enc_key
        pairing.their_nonce = their_nonce
        pairing.state = STATE_AWAITING_LOCAL
        # The moment this side has six digits to show. Not "they confirmed" —
        # that is a different event and a later one, and by then the window this
        # restarts is the one already running.
        pairing.extend_once(time.time())
        return pairing


def confirm(device_id: str) -> Pairing:
    """This side's person says the digits match. Not yet a pairing."""
    with _lock:
        _sweep(time.time())
        pairing = _pairings.get(device_id)
        if pairing is None:
            raise PairingError("no pairing with that device is in progress")
        if pairing.state != STATE_AWAITING_LOCAL:
            raise PairingError(f"nothing to confirm in state {pairing.state}")
        pairing.we_confirmed = True
        pairing.state = STATE_AWAITING_REMOTE
        return pairing


def note_peer_confirmed(device_id: str) -> Pairing | None:
    """Their ``pair-confirm`` arrived. Returns the exchange, or None when there
    is nothing in flight — a confirm for something this side already forgot is
    not an error, it is late."""
    with _lock:
        _sweep(time.time())
        pairing = _pairings.get(device_id)
        if pairing is None:
            return None
        pairing.peer_confirmed = True
        return pairing


def complete(device_id: str) -> Pairing | None:
    """The finished exchange, or None while it is still waiting on somebody.

    **Both sides confirm.** Neither is written until a person at that machine
    has said the six digits match the ones on the other screen.

    This was asymmetric once: the initiator needed only the other side's
    confirm, on the reasoning that comparing digits is one act performed by one
    person looking at two screens, and that pressing "Pair with…" had already
    said what this side wanted. The reasoning holds — *when there is another
    machine and another person*. A relay is what breaks that premise, and it
    breaks it completely: it can decline to forward the request at all and
    answer with its own key, because the first frame of an exchange is verified
    against the key it carries. The initiator would then pin the relay, approved
    and in ``RING_SELF``, with every policy rule skipped, having compared
    nothing with nobody.

    So the earlier trade was not wrong about its shape — "press Pair and walk
    away and the other end finishes it" — it was wrong about the size. The other
    end is not necessarily a machine you own.

    **And the check cannot be automated.** The SAS is derived from two public
    keys and two nonces; a relay supplies half of them and receives the other
    half, so it *knows the six digits*. Anything that asks the far side to prove
    it saw them — signing them back, echoing them — a relay can compute and
    sign. The whole security property comes from one person reading two screens.
    A button is not ceremony here; it is the only place the property lives.

    What this costs is the step the asymmetry was avoiding: somebody who presses
    Pair and walks away comes back to a card still waiting. Nothing is granted
    in the meantime — no pin, no ring, no exception — which is the point.
    """
    with _lock:
        _sweep(time.time())
        pairing = _pairings.get(device_id)
        if pairing is None:
            return None
        if not (pairing.we_confirmed and pairing.peer_confirmed):
            return None
        _pairings.pop(device_id, None)
        return pairing


def cancel(device_id: str) -> Pairing | None:
    """Drop an exchange: refused here, refused there, or expired."""
    with _lock:
        return _pairings.pop(device_id, None)


def _reset_for_test() -> None:
    with _lock:
        _pairings.clear()
