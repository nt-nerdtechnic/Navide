from __future__ import annotations

import asyncio
import hashlib
import json
from http import HTTPStatus
from typing import Any

import pytest

from agent_team_backend.channels.base import ChannelSendError, InboundMessage, Location
from agent_team_backend.channels.mattermost import MattermostAdapter

from .fake_platform import FakeHttp, FakeWs, Resp

TOKEN = "mm-bot-token"


async def wait_for(pred, timeout: float = 5.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not pred():
        if loop.time() > end:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def posted(pid: str, message: str, *, channel: str = "ch1", user: str = "u42", root: str = "",
           channel_type: str = "O", ptype: str = "", props: dict[str, Any] | None = None) -> str:
    post = {"id": pid, "channel_id": channel, "user_id": user, "root_id": root, "message": message,
            "type": ptype, "props": props or {}}
    return json.dumps({"event": "posted", "seq": 1, "broadcast": {"channel_id": channel},
                       "data": {"post": json.dumps(post), "channel_type": channel_type,
                                "sender_name": "@alice", "team_id": "t1"}})


HELLO = json.dumps({"event": "hello", "data": {"server_version": "10.6"}, "seq": 0})


class Socket:
    def __init__(self) -> None:
        self.scripts: list[Any] = []
        self.received: list[dict[str, Any]] = []
        self.auth_headers: list[str] = []

    async def __call__(self, ws) -> None:
        self.auth_headers.append(ws.request.headers.get("Authorization", ""))
        script = self.scripts.pop(0) if self.scripts else None
        if script is None:
            await ws.wait_closed()
            return
        await script(ws, self)

    async def collect(self, ws) -> None:
        async for raw in ws:
            self.received.append(json.loads(raw))


def api(http: FakeHttp) -> None:
    def me(r):
        if r.headers.get("authorization") != f"Bearer {TOKEN}":
            return Resp(401, {"id": "api.context.session_expired.app_error", "message": "Invalid or expired session",
                              "status_code": 401})
        return {"id": "ubot", "username": "navide"}

    http.route("GET", "/api/v4/users/me", me)


@pytest.fixture
def http():
    with FakeHttp() as h:
        yield h


async def start(server: str, emitted: list[InboundMessage], token: str = TOKEN,
                ws_url: str = "") -> MattermostAdapter:
    # REST and WS fakes run on two ports; the adapter derives both from one server URL,
    # so the WS URL is pointed at the websocket fake explicitly.
    adapter = MattermostAdapter(server, token, backoff=lambda n, r: 0.01)
    if ws_url:
        adapter._ws_url = lambda: ws_url  # type: ignore[method-assign]

    async def emit(m: InboundMessage) -> None:
        emitted.append(m)

    await adapter.start(emit)
    return adapter


async def test_inbound_posted_mapping_and_typing(http: FakeHttp) -> None:
    api(http)
    sock = Socket()
    emitted: list[InboundMessage] = []

    async def script(ws, s: Socket) -> None:
        await ws.send(HELLO)
        await ws.send(posted("p1", "in thread", root="root1"))
        await ws.send(posted("p2", "dm", channel="dm1", channel_type="D"))
        await ws.send(posted("p3", "self", user="ubot"))
        await ws.send(posted("p4", "joined", ptype="system_join_channel"))
        await ws.send(posted("p5", "other bot", props={"from_bot": "true"}))
        await s.collect(ws)

    sock.scripts.append(script)
    async with FakeWs(sock) as fake:
        adapter = await start(http.base_url, emitted, ws_url=f"{fake.url}/api/v4/websocket")
        await wait_for(lambda: len(emitted) == 2)
        assert adapter.status.lifecycle == "ready" and adapter.status.identity == "@navide"
        assert sock.auth_headers == [f"Bearer {TOKEN}"]
        m1, m2 = emitted
        assert (m1.chat_id, m1.thread_id, m1.sender_id, m1.sender_name, m1.message_id, m1.is_direct) == (
            "ch1", "root1", "u42", "alice", "p1", False)
        assert (m2.chat_id, m2.thread_id, m2.is_direct) == ("dm1", "", True)

        await adapter.send_typing(Location("mattermost", "default", "ch1", "root1"))
        await wait_for(lambda: len(sock.received) == 1)
        assert sock.received[0]["action"] == "user_typing"
        assert sock.received[0]["data"] == {"channel_id": "ch1", "parent_id": "root1"}
        await adapter.stop()


def test_ws_url_scheme() -> None:
    assert MattermostAdapter("https://chat.example.com/", "t")._ws_url() == "wss://chat.example.com/api/v4/websocket"
    assert MattermostAdapter("http://127.0.0.1:8065", "t")._ws_url() == "ws://127.0.0.1:8065/api/v4/websocket"


async def test_send_chunks_edit_and_create_location(http: FakeHttp) -> None:
    counter = iter(range(1000))
    http.route("POST", "/api/v4/posts", lambda r: Resp(201, {"id": f"post{next(counter)}", **r.body}))
    http.route("PUT", r"/api/v4/posts/[^/]+/patch", lambda r: {"id": "x"})
    adapter = MattermostAdapter(http.base_url, TOKEN)

    loc = await adapter.create_location("ch1", "api-refactor")
    assert loc == Location("mattermost", "default", "ch1", "post0", "api-refactor")
    root = http.calls_to("POST", "/api/v4/posts")[0]
    assert root.body == {"channel_id": "ch1", "message": "🧵 api-refactor"}
    assert root.headers["authorization"] == f"Bearer {TOKEN}"

    ids = await adapter.send_text(loc, ("word " * 3000).strip(), buttons=[("Yes", "nv1:x:yes")])
    posts = http.calls_to("POST", "/api/v4/posts")[1:]
    assert len(ids) == len(posts) == 2
    assert all(p.body["root_id"] == "post0" and len(p.body["message"]) <= 8000 for p in posts)

    await adapter.edit_text(loc, ids[0], "edited")
    assert http.calls_to("PUT", f"/api/v4/posts/{ids[0]}/patch")[0].body == {"message": "edited"}
    # Typing without a live socket is a no-op.
    await adapter.send_typing(loc)
    await adapter.stop()


async def test_send_429_retry_and_error(http: FakeHttp) -> None:
    http.route("POST", "/api/v4/posts", lambda r: Resp(201, {"id": "ok"}))
    http.fail("POST", "/api/v4/posts", 429, "limit exceeded", {"X-Ratelimit-Reset": "0"})
    adapter = MattermostAdapter(http.base_url, TOKEN)
    loc = Location("mattermost", "default", "ch1")
    assert await adapter.send_text(loc, "hi") == ["ok"]
    assert len(http.calls_to("POST", "/api/v4/posts")) == 2
    http.fail("POST", "/api/v4/posts", 403, {"id": "api.context.permissions.app_error",
                                             "message": "You do not have the appropriate permissions."})
    with pytest.raises(ChannelSendError, match="permissions"):
        await adapter.send_text(loc, "hi")
    await adapter.stop()


async def test_bad_token_blocks(http: FakeHttp) -> None:
    api(http)
    adapter = await start(http.base_url, [], token="wrong")
    await wait_for(lambda: adapter.status.lifecycle == "blocked")
    assert "401" in adapter.status.last_error
    await asyncio.sleep(0.1)
    assert len(http.calls_to("GET", "/api/v4/users/me")) == 1
    await adapter.stop()


async def test_websocket_401_blocks(http: FakeHttp, monkeypatch) -> None:
    api(http)
    sock = Socket()

    def reject(connection, request):
        return connection.respond(HTTPStatus.UNAUTHORIZED, "Unauthorized\n")

    async with FakeWs(sock, process_request=reject) as fake:
        adapter = MattermostAdapter(http.base_url, TOKEN, backoff=lambda n, r: 0.01)
        monkeypatch.setattr(adapter, "_ws_url", lambda: f"{fake.url}/api/v4/websocket")

        async def emit(m: InboundMessage) -> None:
            pass

        await adapter.start(emit)
        await wait_for(lambda: adapter.status.lifecycle == "blocked")
        assert "websocket 401" in adapter.status.last_error
        await adapter.stop()


async def test_reconnect_after_drop(http: FakeHttp, monkeypatch) -> None:
    api(http)
    sock = Socket()
    emitted: list[InboundMessage] = []

    async def drop(ws, s: Socket) -> None:
        await ws.send(HELLO)
        await ws.close(code=1011)

    async def second(ws, s: Socket) -> None:
        await ws.send(HELLO)
        await ws.send(posted("p9", "back"))
        await ws.wait_closed()

    sock.scripts += [drop, second]
    async with FakeWs(sock) as fake:
        adapter = MattermostAdapter(http.base_url, TOKEN, backoff=lambda n, r: 0.01)
        monkeypatch.setattr(adapter, "_ws_url", lambda: f"{fake.url}/api/v4/websocket")

        async def emit(m: InboundMessage) -> None:
            emitted.append(m)

        await adapter.start(emit)
        await wait_for(lambda: len(emitted) == 1)
        assert adapter.status.lifecycle == "ready" and len(fake.connections) == 2
        await adapter.stop()


async def test_stall_watchdog_restarts_silent_connection(http: FakeHttp, monkeypatch) -> None:
    """No frames and no pongs within the stall window -> the connection is replaced."""
    api(http)
    sock = Socket()

    async def ignore_pings(ws, s: Socket) -> None:
        await ws.send(HELLO)
        await ws.wait_closed()

    sock.scripts += [ignore_pings, ignore_pings]
    async with FakeWs(sock) as fake:
        adapter = MattermostAdapter(http.base_url, TOKEN, backoff=lambda n, r: 0.01, stall_timeout_s=0.3,
                                    ping_interval_s=60)
        monkeypatch.setattr(adapter, "_ws_url", lambda: f"{fake.url}/api/v4/websocket")

        async def emit(m: InboundMessage) -> None:
            pass

        await adapter.start(emit)
        await wait_for(lambda: len(fake.connections) >= 2)  # stall watchdog fired
        await adapter.stop()


def test_token_fingerprint() -> None:
    assert MattermostAdapter("http://x", f" {TOKEN}\n").token_fingerprint() == hashlib.sha256(TOKEN.encode()).hexdigest()


def test_create_adapter_validates_config() -> None:
    from agent_team_backend.channels.mattermost import create_adapter

    a = create_adapter({"server_url": "https://chat.example.com", "account": "work"}, {"token": TOKEN}, store=None)
    assert isinstance(a, MattermostAdapter) and a.account == "work"
    assert a._ws_url() == "wss://chat.example.com/api/v4/websocket"
    with pytest.raises(ValueError):
        create_adapter({}, {"token": TOKEN}, store=None)
    with pytest.raises(ValueError):
        create_adapter({"server_url": "https://chat.example.com"}, {}, store=None)


async def test_known_locations_from_posted(http: FakeHttp) -> None:
    api(http)
    sock = Socket()
    emitted: list[InboundMessage] = []

    async def script(ws, s: Socket) -> None:
        await ws.send(HELLO)
        await ws.send(posted("p1", "hi"))
        await ws.wait_closed()

    sock.scripts.append(script)
    async with FakeWs(sock) as fake:
        adapter = await start(http.base_url, emitted, ws_url=f"{fake.url}/api/v4/websocket")
        await wait_for(lambda: len(emitted) == 1)
        assert adapter.known_locations() == [
            {"chat_id": "ch1", "title": "ch1", "kind": "O", "supports_topics": True}]
        await adapter.stop()
