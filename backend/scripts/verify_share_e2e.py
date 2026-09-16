"""End-to-end check: a cross-account share against a *real* Navide-Server.

backend/tests/test_share_publish_claim.py drives the four ``share.*`` handlers
against a fake server written from this repo's reading of the contract, so it
can only confirm that the desktop side agrees with itself. This script removes
that circularity the same way ``verify_server_link.py`` does: two real
``ServerLink`` instances — two *accounts*, not two devices of one — one sealing
a bundle and publishing it, the other claiming it back with nothing but the
share code.

What is checked, in order:

1. Two accounts register (``@example.invalid``, which the server's mailer skips).
2. A seals a bundle carrying all four scopes, sends the ciphertext with
   ``shares.create``, and builds the share code from the id it gets back.
3. B decodes the code, claims the blob, opens it, and the bundle compares equal
   byte for byte with what A sealed.
4. The refusals: the wrong key does not open the blob; a revoked share claims
   as SHARE_REVOKED; B revoking A's share is NOT_FOUND (the server does not
   say whether the id exists) and leaves the share claimable.
5. ``devices.list`` shows A only A's own device.
6. The same publish → claim through the real ``share.publish`` and
   ``share.claim`` WS handlers, so the whole desktop path is driven once.

Usage (server must already be running)::

    NAVIDE_WS=ws://localhost:8787/ws \\
        uv --project backend run python backend/scripts/verify_share_e2e.py

Environment:
    NAVIDE_WS   WebSocket URL (default ws://localhost:8787/ws)

Deliberately *not* a pytest module, for the same reason as its sibling: it
needs a server running somewhere else. It imports ``verify_server_link`` for
the connection, identity and isolation plumbing — the import redirects
app-data to a throwaway directory and the credential vault to the file backend
before anything touches a database or the Keychain.
"""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_server_link as vsl  # noqa: E402  (its import isolates app-data)
from verify_server_link import URL, check, open_link  # noqa: E402

from agent_team_backend import server_link, share_codes, ws_handlers  # noqa: E402

RUN = secrets.token_hex(4)
DEVICE_A = f"share-a-{RUN}"
DEVICE_B = f"share-b-{RUN}"
SHARE_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def a_bundle() -> dict[str, Any]:
    """Every scope populated, so a scope the server or the codec drops shows."""
    return {
        "bundleVersion": 1,
        "name": f"verify share {RUN}",
        "description": "built by verify_share_e2e.py",
        "createdAt": "2026-09-16T00:00:00+00:00",
        "createdBy": {"device": DEVICE_A, "app": "Navide verify"},
        "scopes": {
            "prompts": {"items": {"review": {"title": "Review", "body": "look hard — 仔細看"}}},
            "mcp": {"items": {"context7": {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]}}},
            "skills": {"items": {"verify": {"files": {"SKILL.md": "---\nname: verify\n---\n"}}}},
            "memory": {"items": {"CLAUDE.md": {"body": "# Memory\n- one line\n"}}},
        },
        "redactions": [{"scope": "mcp", "item": "context7", "fields": ["env"]}],
    }


def canonical(bundle: Any) -> bytes:
    return json.dumps(bundle, ensure_ascii=False, sort_keys=True).encode("utf-8")


def error_code(reply: dict[str, Any]) -> str:
    error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
    return str(error.get("code") or "")


async def register(label: str) -> tuple[str, str]:
    email = f"share-{label}-{RUN}@example.invalid"
    created = await server_link.account_request(
        URL, "auth.register", {"email": email, "password": f"verify-pwd-{secrets.token_hex(8)}"}
    )
    token = str(created.get("token") or "")
    member = str(created.get("memberId") or "")
    if not token:
        raise RuntimeError(f"auth.register returned no token for {email}: {created}")
    print(f"   registered {label}: {member} ({email})")
    return token, member


class FakeSession:
    """What a window would receive from the WS handlers."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)

    @property
    def reply(self) -> dict[str, Any]:
        return self.sent[-1] if self.sent else {}


async def main() -> int:
    print(f"== target {URL} ==")
    print(f"   deviceA={DEVICE_A}  deviceB={DEVICE_B}")

    print("\n== 1. two accounts ==")
    token_a, member_a = await register("a")
    token_b, member_b = await register("b")
    check(member_a != member_b, "A and B are different accounts", (member_a, member_b))

    link_a, _ = await open_link(DEVICE_A, "A", token=token_a)
    link_b, _ = await open_link(DEVICE_B, "B", token=token_b)
    try:
        # ---- 2. A publishes -------------------------------------------------
        print("\n== 2. A seals and publishes ==")
        bundle = a_bundle()
        original = canonical(bundle)
        key = share_codes.new_key()
        blob = share_codes.seal_bundle(bundle, key)
        check(
            share_codes.ensure_blob_within_limit(blob) == len(blob),
            f"blob is under the gate ({len(blob)} of {share_codes.MAX_BLOB_CHARS} chars)",
        )
        created = await link_a.create_share(blob=blob, size_bytes=len(blob), ttl_seconds=600)
        check(created.get("ok") is True, "shares.create accepted", created)
        payload = created.get("payload") if isinstance(created.get("payload"), dict) else {}
        share_id = str(payload.get("shareId") or "")
        check(bool(SHARE_ID_RE.match(share_id)), "shareId is 32 lowercase hex", share_id)
        check(bool(payload.get("expiresAt")), "expiresAt is set", payload.get("expiresAt"))
        code = share_codes.encode_share_code(share_id, key)
        print(f"   code: {code}")

        listed = await link_a.list_shares()
        rows = (listed.get("payload") or {}).get("shares") if listed.get("ok") else None
        ids = [str(r.get("shareId") or "") for r in rows] if isinstance(rows, list) else []
        check(share_id in ids, "shares.list on A includes the new share", listed)

        # ---- 3. B claims ----------------------------------------------------
        print("\n== 3. B claims from the code alone ==")
        decoded_id, decoded_key = share_codes.decode_share_code(code)
        check(decoded_id == share_id and decoded_key == key, "code decodes to the same id and key")
        claimed = await link_b.claim_share(decoded_id)
        check(claimed.get("ok") is True, "shares.claim accepted for B", claimed)
        got = claimed.get("payload") if isinstance(claimed.get("payload"), dict) else {}
        check(got.get("blob") == blob, "blob came back byte for byte", {"len": len(got.get("blob") or "")})
        check(got.get("sizeBytes") == len(blob), "sizeBytes matches", got.get("sizeBytes"))
        opened = share_codes.open_bundle(str(got.get("blob") or ""), decoded_key)
        check(canonical(opened) == original, "bundle compares equal byte for byte after the round trip")
        check(
            all(opened["scopes"][s]["items"] for s in ("prompts", "mcp", "skills", "memory")),
            "all four scopes survived",
            list(opened.get("scopes", {})),
        )

        # ---- 4. refusals ----------------------------------------------------
        print("\n== 4. refusals ==")
        try:
            share_codes.open_bundle(str(got.get("blob") or ""), share_codes.new_key())
            check(False, "the wrong key must not open the blob")
        except share_codes.ShareCodeError as err:
            check(err.code == "SHARE_DECRYPT_FAILED", "wrong key → SHARE_DECRYPT_FAILED", err.code)

        # A second live share, so B's revoke attempt has a real id to name.
        second = await link_a.create_share(blob=blob, size_bytes=len(blob), ttl_seconds=600)
        second_id = str(((second.get("payload") or {}) if second.get("ok") else {}).get("shareId") or "")
        check(bool(SHARE_ID_RE.match(second_id)), "second share created for the cross-account revoke", second)
        foreign = await link_b.revoke_share(second_id)
        check(
            foreign.get("ok") is False and error_code(foreign) == "NOT_FOUND",
            "B revoking A's share → NOT_FOUND (existence not revealed)",
            foreign,
        )
        still = await link_b.claim_share(second_id)
        check(still.get("ok") is True, "…and the share is still claimable afterwards", still)

        revoked = await link_a.revoke_share(share_id)
        check(revoked.get("ok") is True, "A revokes the first share", revoked)
        after = await link_b.claim_share(share_id)
        check(
            after.get("ok") is False and error_code(after) == "SHARE_REVOKED",
            "B claiming a revoked share → SHARE_REVOKED",
            after,
        )
        unknown = await link_b.claim_share("0" * 32)
        check(unknown.get("ok") is False, "claiming an id that never existed is refused", unknown)

        # ---- 5. devices.list ------------------------------------------------
        print("\n== 5. devices.list ==")
        devices = await link_a.list_devices()
        check(devices.get("ok") is True, "devices.list accepted", devices)
        dev_rows = (devices.get("payload") or {}).get("devices") if devices.get("ok") else None
        if not isinstance(dev_rows, list):
            dev_rows = devices.get("payload") if isinstance(devices.get("payload"), list) else []
        dev_ids = [str(r.get("deviceId") or "") for r in dev_rows if isinstance(r, dict)]
        check(DEVICE_A in dev_ids, "A sees its own device", dev_ids)
        check(DEVICE_B not in dev_ids, "A does not see B's device (other account)", dev_ids)
        check(
            all({"deviceId", "deviceName", "lastSeenAt"} <= set(r) for r in dev_rows if isinstance(r, dict)),
            "rows carry deviceId / deviceName / lastSeenAt",
            dev_rows,
        )

        # ---- 6. the real WS handlers ----------------------------------------
        print("\n== 6. share.publish / share.claim through the WS handlers ==")
        # The module-level wrappers route through server_link._link, which
        # open_link does not set; pointing it at each link in turn drives the
        # exact code a window's request would.
        server_link._link = link_a
        session = FakeSession()
        await ws_handlers.share_publish(session, "1", "share.publish", {"bundle": bundle, "ttlSeconds": 600})
        published = session.reply
        check(published.get("ok") is True, "share.publish handler answered ok", published)
        h_payload = published.get("payload") if isinstance(published.get("payload"), dict) else {}
        h_code = str(h_payload.get("code") or "")
        check(h_code.startswith("NVD-"), "handler returned a share code", h_code)

        server_link._link = link_b
        session = FakeSession()
        await ws_handlers.share_claim(session, "2", "share.claim", {"code": h_code})
        claimed_h = session.reply
        check(claimed_h.get("ok") is True, "share.claim handler answered ok", claimed_h)
        h_bundle = (claimed_h.get("payload") or {}).get("bundle") if claimed_h.get("ok") else None
        check(canonical(h_bundle) == original, "handler path returns the identical bundle")

        session = FakeSession()
        typo = h_code[:-1] + ("A" if h_code[-1] != "A" else "B")
        await ws_handlers.share_claim(session, "3", "share.claim", {"code": typo})
        check(
            session.reply.get("ok") is False
            and session.reply["error"]["code"] in {"SHARE_CODE_CHECKSUM", "BAD_SHARE_CODE"},
            "handler refuses a one-character typo locally",
            session.reply.get("error"),
        )

        server_link._link = link_a
        session = FakeSession()
        await ws_handlers.share_list_published(session, "4", "share.list_published", {})
        listed_h = session.reply
        h_ids = [str(r.get("shareId") or "") for r in (listed_h.get("payload") or {}).get("shares", [])]
        check(
            listed_h.get("ok") is True and str(h_payload.get("shareId") or "") in h_ids,
            "share.list_published handler lists the handler-published share",
            listed_h,
        )
        session = FakeSession()
        await ws_handlers.share_revoke_published(
            session, "5", "share.revoke_published", {"shareId": str(h_payload.get("shareId") or "")}
        )
        check(session.reply.get("ok") is True, "share.revoke_published handler answered ok", session.reply)
    finally:
        server_link._link = None
        await link_a.stop()
        await link_b.stop()

    print(f"\n== result: {vsl._passed} passed / {vsl._failed} failed ==")
    return 1 if vsl._failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
