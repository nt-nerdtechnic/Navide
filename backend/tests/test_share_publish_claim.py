"""share.publish / share.claim / share.list_published / share.revoke_published.

The server is a fake here: what these tests pin down is the *seam* — that the
key never appears in what is sent, that the size gate fires before anything
is sent, that a mistyped code never reaches the server, and that a claimed
bundle comes back as a bundle and is not applied.
"""

from __future__ import annotations

import base64
import os
from typing import Any

import pytest

from agent_team_backend import share_codes, ws_handlers

SHARE_ID = "0123456789abcdef0123456789abcdef"


class FakeSession:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)

    @property
    def reply(self) -> dict[str, Any]:
        assert len(self.sent) == 1, self.sent
        return self.sent[0]


class FakeServer:
    """navide-server as the five wrappers see it: one stored blob."""

    def __init__(self) -> None:
        self.stored: dict[str, str] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.configured = True

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        link = ws_handlers.server_link
        monkeypatch.setattr(link, "create_share", self.create_share)
        monkeypatch.setattr(link, "claim_share", self.claim_share)
        monkeypatch.setattr(link, "list_shares", self.list_shares)
        monkeypatch.setattr(link, "revoke_share", self.revoke_share)

    async def create_share(self, *, blob: str, size_bytes: int, ttl_seconds: int) -> dict | None:
        self.calls.append(("shares.create", {"blob": blob, "sizeBytes": size_bytes, "ttlSeconds": ttl_seconds}))
        if not self.configured:
            return None
        self.stored[SHARE_ID] = blob
        return {"ok": True, "payload": {"shareId": SHARE_ID, "expiresAt": "2026-09-17T00:00:00Z"}}

    async def claim_share(self, share_id: str) -> dict | None:
        self.calls.append(("shares.claim", {"shareId": share_id}))
        if not self.configured:
            return None
        blob = self.stored.get(share_id)
        if blob is None:
            return {"ok": False, "error": {"code": "SHARE_NOT_FOUND", "message": "no such share"}}
        return {"ok": True, "payload": {"blob": blob, "sizeBytes": len(blob)}}

    async def list_shares(self) -> dict | None:
        self.calls.append(("shares.list", {}))
        if not self.configured:
            return None
        return {"ok": True, "payload": {"shares": [{"shareId": sid} for sid in self.stored]}}

    async def revoke_share(self, share_id: str) -> dict | None:
        self.calls.append(("shares.revoke", {"shareId": share_id}))
        if not self.configured:
            return None
        self.stored.pop(share_id, None)
        return {"ok": True, "payload": {}}


def a_bundle(filler: str = "") -> dict:
    return {
        "bundleVersion": 1,
        "name": "team defaults",
        "scopes": {"prompts": {"items": {"review": {"body": "look hard" + filler}}}},
        "redactions": [],
    }


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> FakeServer:
    fake = FakeServer()
    fake.install(monkeypatch)
    return fake


# ── publish ──────────────────────────────────────────────────────────────────
async def test_publish_returns_a_code_and_uploads_only_ciphertext(server: FakeServer):
    session = FakeSession()
    bundle = a_bundle()

    await ws_handlers.share_publish(session, "1", "share.publish", {"bundle": bundle, "ttlSeconds": 600})

    reply = session.reply
    assert reply["ok"], reply
    assert reply["payload"]["code"].startswith("NVD-")
    assert reply["payload"]["shareId"] == SHARE_ID
    assert reply["payload"]["expiresAt"] == "2026-09-17T00:00:00Z"

    (verb, sent), = server.calls
    assert verb == "shares.create"
    assert sent["ttlSeconds"] == 600
    assert sent["sizeBytes"] == len(sent["blob"])
    assert set(sent) == {"blob", "sizeBytes", "ttlSeconds"}
    # The key is only in the code; the server can open nothing it holds.
    _, key = share_codes.decode_share_code(reply["payload"]["code"])
    assert key not in base64.b64decode(sent["blob"])
    assert b"look hard" not in base64.b64decode(sent["blob"])
    assert share_codes.open_bundle(sent["blob"], key) == bundle


async def test_publish_defaults_the_ttl_when_none_is_given(server: FakeServer):
    session = FakeSession()

    await ws_handlers.share_publish(session, "1", "share.publish", {"bundle": a_bundle()})

    assert session.reply["ok"]
    assert server.calls[0][1]["ttlSeconds"] == ws_handlers._SHARE_TTL_DEFAULT_S


async def test_publish_refuses_an_oversized_bundle_before_sending(server: FakeServer):
    """Incompressible filler: gzip cannot bring this under the gate."""
    session = FakeSession()
    bundle = a_bundle(filler=base64.b64encode(os.urandom(1024 * 1024)).decode("ascii"))

    await ws_handlers.share_publish(session, "1", "share.publish", {"bundle": bundle})

    reply = session.reply
    assert not reply["ok"]
    assert reply["error"]["code"] == "SHARE_BLOB_TOO_LARGE"
    assert "Export to file" in reply["error"]["message"]
    assert reply["error"]["details"]["limit"] == share_codes.MAX_BLOB_CHARS
    assert server.calls == []


async def test_publish_refuses_a_non_bundle(server: FakeServer):
    session = FakeSession()

    await ws_handlers.share_publish(session, "1", "share.publish", {"bundle": "nope"})

    assert session.reply["error"]["code"] == "INVALID_BUNDLE"
    assert server.calls == []


async def test_publish_without_a_server_says_so(server: FakeServer):
    server.configured = False
    session = FakeSession()

    await ws_handlers.share_publish(session, "1", "share.publish", {"bundle": a_bundle()})

    assert session.reply["error"]["code"] == "P2P_NOT_CONFIGURED"


async def test_publish_passes_the_servers_refusal_through(monkeypatch: pytest.MonkeyPatch):
    async def refuse(**kwargs: Any) -> dict:
        return {"ok": False, "error": {"code": "LINK_OFFLINE", "message": "not connected"}}

    monkeypatch.setattr(ws_handlers.server_link, "create_share", refuse)
    session = FakeSession()

    await ws_handlers.share_publish(session, "1", "share.publish", {"bundle": a_bundle()})

    assert session.reply["error"] == {"code": "LINK_OFFLINE", "message": "not connected", "details": {}}


# ── claim ────────────────────────────────────────────────────────────────────
async def publish(server: FakeServer, bundle: dict) -> str:
    session = FakeSession()
    await ws_handlers.share_publish(session, "1", "share.publish", {"bundle": bundle})
    assert session.reply["ok"], session.reply
    return session.reply["payload"]["code"]


async def test_claim_returns_the_bundle_and_nothing_else(server: FakeServer):
    bundle = a_bundle()
    code = await publish(server, bundle)
    session = FakeSession()

    await ws_handlers.share_claim(session, "2", "share.claim", {"code": code})

    reply = session.reply
    assert reply["ok"], reply
    assert reply["payload"] == {"bundle": bundle, "shareId": SHARE_ID}
    assert server.calls[-1] == ("shares.claim", {"shareId": SHARE_ID})


async def test_claim_survives_the_code_being_retyped(server: FakeServer):
    bundle = a_bundle()
    code = await publish(server, bundle)
    session = FakeSession()

    retyped = code.lower().replace("-", " ")
    await ws_handlers.share_claim(session, "2", "share.claim", {"code": retyped})

    assert session.reply["payload"]["bundle"] == bundle


async def test_claim_with_a_typo_never_reaches_the_server(server: FakeServer):
    code = await publish(server, a_bundle())
    calls_before = len(server.calls)
    session = FakeSession()

    typo = code[:-1] + ("A" if code[-1] != "A" else "B")
    await ws_handlers.share_claim(session, "2", "share.claim", {"code": typo})

    assert session.reply["error"]["code"] in {"SHARE_CODE_CHECKSUM", "BAD_SHARE_CODE"}
    assert len(server.calls) == calls_before


async def test_claim_of_a_revoked_share_is_the_servers_word(server: FakeServer):
    code = await publish(server, a_bundle())
    server.stored.clear()
    session = FakeSession()

    await ws_handlers.share_claim(session, "2", "share.claim", {"code": code})

    assert session.reply["error"]["code"] == "SHARE_NOT_FOUND"


async def test_claim_with_the_wrong_key_does_not_open(server: FakeServer):
    """Same shareId, different key: the server hands over the blob, it stays shut."""
    await publish(server, a_bundle())
    wrong = share_codes.encode_share_code(SHARE_ID, share_codes.new_key())
    session = FakeSession()

    await ws_handlers.share_claim(session, "2", "share.claim", {"code": wrong})

    assert session.reply["error"]["code"] == "SHARE_DECRYPT_FAILED"


async def test_claim_refuses_an_empty_code(server: FakeServer):
    session = FakeSession()

    await ws_handlers.share_claim(session, "2", "share.claim", {"code": "   "})

    assert session.reply["error"]["code"] == "INVALID_SHARE_CODE"
    assert server.calls == []


# ── list / revoke ────────────────────────────────────────────────────────────
async def test_list_published_passes_the_rows_through(server: FakeServer):
    await publish(server, a_bundle())
    session = FakeSession()

    await ws_handlers.share_list_published(session, "3", "share.list_published", {})

    assert session.reply["payload"] == {"shares": [{"shareId": SHARE_ID}]}


async def test_revoke_normalizes_the_id_and_reports_ok(server: FakeServer):
    await publish(server, a_bundle())
    session = FakeSession()

    dashed = "01234567-89AB-CDEF-0123-456789ABCDEF"
    await ws_handlers.share_revoke_published(session, "4", "share.revoke_published", {"shareId": dashed})

    assert session.reply["payload"] == {"ok": True, "shareId": SHARE_ID}
    assert server.calls[-1] == ("shares.revoke", {"shareId": SHARE_ID})
    assert server.stored == {}


async def test_revoke_refuses_a_malformed_id_locally(server: FakeServer):
    session = FakeSession()

    await ws_handlers.share_revoke_published(session, "4", "share.revoke_published", {"shareId": "zz"})

    assert session.reply["error"]["code"] == "BAD_SHARE_ID"
    assert server.calls == []
