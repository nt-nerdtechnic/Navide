from __future__ import annotations

import asyncio
import hashlib
import threading
import time
from typing import Any

import pytest

from agent_team_backend.channels.base import ChannelSendError, InboundMessage, Location
from agent_team_backend.channels.matrix import MatrixAdapter

from .fake_platform import FakeHttp, Req, Resp

TOKEN = "syt_matrix_token"
BOT = "@navide:example.org"


async def wait_for(pred, timeout: float = 5.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not pred():
        if loop.time() > end:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def text_event(eid: str, body: str, sender: str = "@alice:example.org", thread: str = "",
               msgtype: str = "m.text", relates: dict[str, Any] | None = None) -> dict[str, Any]:
    content: dict[str, Any] = {"msgtype": msgtype, "body": body}
    if thread:
        content["m.relates_to"] = {"rel_type": "m.thread", "event_id": thread, "is_falling_back": True}
    if relates:
        content["m.relates_to"] = relates
    return {"type": "m.room.message", "event_id": eid, "sender": sender, "content": content,
            "origin_server_ts": 1}


class Homeserver:
    """A fake /sync: batches queued with push() are served in order; an empty queue long-polls briefly."""

    def __init__(self, http: FakeHttp) -> None:
        self.http = http
        self.batches: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        self.pos = 0
        self.initial: dict[str, Any] = {"rooms": {}}
        http.route("GET", "/_matrix/client/v3/account/whoami", self.whoami)
        http.route("GET", "/_matrix/client/v3/sync", self.sync)
        http.route("GET", r"/_matrix/client/v3/profile/.+/displayname", lambda r: {"displayname": "Alice"})

    def whoami(self, r: Req) -> Resp | dict[str, Any]:
        if r.headers.get("authorization") != f"Bearer {TOKEN}":
            return Resp(401, {"errcode": "M_UNKNOWN_TOKEN", "error": "Invalid access token passed."})
        return {"user_id": BOT}

    def push(self, rooms: dict[str, Any]) -> None:
        with self.lock:
            self.batches.append(rooms)

    def sync(self, r: Req) -> dict[str, Any]:
        if "since" not in r.query:
            return {"next_batch": "s0", **self.initial}
        deadline = time.time() + min(int(r.query.get("timeout", "0")) / 1000.0, 0.2)
        while True:
            with self.lock:
                if self.batches:
                    self.pos += 1
                    return {"next_batch": f"s{self.pos}", "rooms": self.batches.pop(0)}
            if time.time() > deadline:
                return {"next_batch": r.query["since"], "rooms": {}}
            time.sleep(0.02)


@pytest.fixture
def http():
    with FakeHttp() as h:
        yield h


async def start(http: FakeHttp, emitted: list[InboundMessage], token: str = TOKEN) -> MatrixAdapter:
    adapter = MatrixAdapter(http.base_url, token, backoff=lambda n, r: 0.01, sync_timeout_ms=1000)

    async def emit(m: InboundMessage) -> None:
        emitted.append(m)

    await adapter.start(emit)
    return adapter


async def test_sync_skips_history_then_maps_threads_and_directs(http: FakeHttp) -> None:
    hs = Homeserver(http)
    hs.initial = {"rooms": {"join": {"!old:x": {"timeline": {"events": [text_event("$old", "history")]}}}}}
    emitted: list[InboundMessage] = []
    adapter = await start(http, emitted)
    await wait_for(lambda: adapter.status.lifecycle == "ready")
    assert adapter.status.identity == BOT

    hs.push({"join": {
        "!room:x": {"summary": {"m.joined_member_count": 5}, "timeline": {"events": [
            text_event("$t1", "in thread", thread="$root"),
            text_event("$m1", "plain"),
            text_event("$self", "mine", sender=BOT),
            text_event("$n1", "notice", msgtype="m.notice"),
            text_event("$e1", "* edit", relates={"rel_type": "m.replace", "event_id": "$m1"}),
        ]}},
        "!dm:x": {"summary": {"m.joined_member_count": 2}, "timeline": {"events": [text_event("$d1", "dm")]}},
    }})
    await wait_for(lambda: len(emitted) == 3)
    t1, m1, d1 = emitted
    assert (t1.chat_id, t1.thread_id, t1.sender_id, t1.sender_name, t1.message_id, t1.is_direct) == (
        "!room:x", "$root", "@alice:example.org", "Alice", "$t1", False)
    assert (m1.chat_id, m1.thread_id, m1.text) == ("!room:x", "", "plain")
    assert (d1.chat_id, d1.is_direct) == ("!dm:x", True)
    # The first sync was a position-only snapshot: no replay of history.
    assert all(m.message_id != "$old" for m in emitted)
    first = http.calls_to("GET", "/_matrix/client/v3/sync")[0]
    assert first.query["timeout"] == "0" and "since" not in first.query
    later = http.calls_to("GET", "/_matrix/client/v3/sync")[-1]
    assert later.query["since"].startswith("s") and later.query["timeout"] == "1000"
    await adapter.stop()


async def test_invites_are_joined(http: FakeHttp) -> None:
    hs = Homeserver(http)
    http.route("POST", r"/_matrix/client/v3/rooms/.+/join", lambda r: {"room_id": "!new:x"})
    adapter = await start(http, [])
    await wait_for(lambda: adapter.status.lifecycle == "ready")
    hs.push({"invite": {"!new:x": {"invite_state": {"events": []}}}})
    await wait_for(lambda: bool(http.calls_to("POST", r"/_matrix/client/v3/rooms/.+/join")))
    assert http.calls_to("POST", r"/_matrix/client/v3/rooms/.+/join")[0].path == "/_matrix/client/v3/rooms/%21new%3Ax/join"
    await adapter.stop()


async def test_send_thread_edit_typing_and_create_location(http: FakeHttp) -> None:
    Homeserver(http)
    counter = iter(range(1000))
    http.route("PUT", r"/_matrix/client/v3/rooms/[^/]+/send/m\.room\.message/[^/]+",
               lambda r: {"event_id": f"$ev{next(counter)}"})
    http.route("PUT", r"/_matrix/client/v3/rooms/[^/]+/typing/[^/]+", lambda r: {})
    adapter = await start(http, [])
    await wait_for(lambda: adapter.status.lifecycle == "ready")

    loc = await adapter.create_location("!room:x", "api-refactor")
    assert loc == Location("matrix", "default", "!room:x", "$ev0", "api-refactor")
    sends = lambda: http.calls_to("PUT", r"/_matrix/client/v3/rooms/[^/]+/send/m\.room\.message/[^/]+")  # noqa: E731
    assert sends()[0].body == {"msgtype": "m.text", "body": "🧵 api-refactor"}
    assert sends()[0].path.startswith("/_matrix/client/v3/rooms/%21room%3Ax/send/")

    ids = await adapter.send_text(loc, ("word " * 3000).strip(), buttons=[("Yes", "nv1:x:yes")])
    thread_posts = sends()[1:]
    assert len(ids) == len(thread_posts) == 2
    for p in thread_posts:
        assert p.body["m.relates_to"] == {"rel_type": "m.thread", "event_id": "$ev0", "is_falling_back": True,
                                          "m.in_reply_to": {"event_id": "$ev0"}}
        assert len(p.body["body"]) <= 8000
    assert len({p.path for p in sends()}) == len(sends())  # a fresh txnId per event

    await adapter.edit_text(loc, ids[0], "edited")
    edit = sends()[-1].body
    assert edit == {"msgtype": "m.text", "body": "* edited", "m.new_content": {"msgtype": "m.text", "body": "edited"},
                    "m.relates_to": {"rel_type": "m.replace", "event_id": ids[0]}}

    await adapter.send_typing(loc)
    typing = http.calls_to("PUT", r"/_matrix/client/v3/rooms/[^/]+/typing/[^/]+")[0]
    assert typing.path == "/_matrix/client/v3/rooms/%21room%3Ax/typing/%40navide%3Aexample.org"
    assert typing.body["typing"] is True
    await adapter.stop()


async def test_send_429_retries_same_txn_and_reports_forbidden(http: FakeHttp) -> None:
    Homeserver(http)
    route = r"/_matrix/client/v3/rooms/[^/]+/send/m\.room\.message/[^/]+"
    http.route("PUT", route, lambda r: {"event_id": "$ok"})
    http.fail("PUT", route, 429, {"errcode": "M_LIMIT_EXCEEDED", "error": "Too many requests", "retry_after_ms": 10})
    adapter = MatrixAdapter(http.base_url, TOKEN)
    loc = Location("matrix", "default", "!room:x")
    assert await adapter.send_text(loc, "hi") == ["$ok"]
    a, b = http.calls_to("PUT", route)
    assert a.path == b.path  # the retry reuses the txnId -> homeserver dedups

    http.fail("PUT", route, 403, {"errcode": "M_FORBIDDEN", "error": "You are not in this room"})
    with pytest.raises(ChannelSendError, match="M_FORBIDDEN|not in this room"):
        await adapter.send_text(loc, "hi")
    await adapter.stop()


async def test_unknown_token_blocks(http: FakeHttp) -> None:
    Homeserver(http)
    adapter = await start(http, [], token="bad")
    await wait_for(lambda: adapter.status.lifecycle == "blocked")
    await asyncio.sleep(0.1)
    assert len(http.calls_to("GET", "/_matrix/client/v3/account/whoami")) == 1
    assert "401" in adapter.status.last_error or "token" in adapter.status.last_error
    await adapter.stop()


async def test_reconnect_after_sync_failure_keeps_position(http: FakeHttp) -> None:
    hs = Homeserver(http)
    emitted: list[InboundMessage] = []
    adapter = await start(http, emitted)
    await wait_for(lambda: adapter.status.lifecycle == "ready")
    http.fail("GET", "/_matrix/client/v3/sync", 502, {"errcode": "M_UNKNOWN", "error": "bad gateway"})
    await wait_for(lambda: not http._errors)  # the 502 was served
    hs.push({"join": {"!room:x": {"timeline": {"events": [text_event("$after", "after drop")]}}}})
    await wait_for(lambda: len(emitted) == 1)
    assert adapter.status.lifecycle == "ready"
    # After the failure the loop resumes from the saved since token (no second initial sync).
    initial = [c for c in http.calls_to("GET", "/_matrix/client/v3/sync") if "since" not in c.query]
    assert len(initial) == 1
    await adapter.stop()


def test_token_fingerprint() -> None:
    assert MatrixAdapter("https://m", f" {TOKEN} ").token_fingerprint() == hashlib.sha256(TOKEN.encode()).hexdigest()


def test_create_adapter_validates_config() -> None:
    from agent_team_backend.channels.matrix import create_adapter

    a = create_adapter({"homeserver": "https://matrix.example.org", "account": "work"},
                       {"access_token": TOKEN}, store=None)
    assert isinstance(a, MatrixAdapter) and a.account == "work"
    assert a.token_fingerprint() == MatrixAdapter("https://m", TOKEN).token_fingerprint()
    assert create_adapter({"homeserver": "https://m"}, {"token": TOKEN}, store=None).token_fingerprint() == a.token_fingerprint()
    with pytest.raises(ValueError):
        create_adapter({}, {"access_token": TOKEN}, store=None)
    with pytest.raises(ValueError):
        create_adapter({"homeserver": "https://m"}, {}, store=None)


async def test_known_locations_include_joined_rooms(http: FakeHttp) -> None:
    hs = Homeserver(http)
    hs.initial = {"rooms": {"join": {"!dm:x": {"summary": {"m.joined_member_count": 2}, "timeline": {"events": []}}}}}
    adapter = await start(http, [])
    await wait_for(lambda: adapter.status.lifecycle == "ready")
    assert adapter.known_locations() == [
        {"chat_id": "!dm:x", "title": "!dm:x", "kind": "direct", "supports_topics": True}]
    await adapter.stop()
