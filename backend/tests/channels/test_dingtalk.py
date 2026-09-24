from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from agent_team_backend.channels.base import InboundMessage, Location
from agent_team_backend.channels.dingtalk import BOT_MESSAGE_TOPIC, DingTalkAdapter

from .fake_platform import FakeHttp, FakeWs, Resp


async def wait_for(pred, timeout: float = 5.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not pred():
        if loop.time() > end:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def bot_frame(mid: str, data: dict[str, Any]) -> str:
    return json.dumps({
        "specVersion": "1.0", "type": "CALLBACK",
        "headers": {"messageId": mid, "topic": BOT_MESSAGE_TOPIC, "contentType": "application/json"},
        "data": json.dumps(data),
    })


def group_msg(msg_id: str, text: str) -> dict[str, Any]:
    return {
        "msgId": msg_id, "conversationId": "cidGroup1", "conversationType": "2",
        "conversationTitle": "Navide Ops", "senderStaffId": "staff42", "senderId": "$:LWCP:42",
        "senderNick": "Alice", "createAt": 1700000000000, "msgtype": "text",
        "text": {"content": f" {text} "},
    }


class Stream:
    """Scripted stream server: each connection runs the next script."""

    def __init__(self) -> None:
        self.scripts: list[Any] = []
        self.acks: list[dict[str, Any]] = []

    async def __call__(self, ws) -> None:
        script = self.scripts.pop(0) if self.scripts else None
        if script is None:
            await ws.wait_closed()
            return
        await script(ws, self)

    async def ack(self, ws) -> dict[str, Any]:
        msg = json.loads(await ws.recv())
        self.acks.append(msg)
        return msg


@pytest.fixture
def http():
    with FakeHttp() as h:
        yield h


def route_open(http: FakeHttp, ws_url: str) -> None:
    http.route("POST", "/v1.0/gateway/connections/open",
               lambda r: {"endpoint": ws_url, "ticket": "tk/1+2"})


async def start(http: FakeHttp, emitted: list[InboundMessage], **kw) -> DingTalkAdapter:
    adapter = DingTalkAdapter("ding-client", "ding-secret", base_url=http.base_url,
                              backoff=lambda n, r: 0.01, **kw)

    async def emit(m: InboundMessage) -> None:
        emitted.append(m)

    await adapter.start(emit)
    return adapter


async def test_connect_inbound_group_message_and_acks(http: FakeHttp) -> None:
    stream = Stream()
    emitted: list[InboundMessage] = []
    done = asyncio.Event()

    async def script(ws, s: Stream) -> None:
        await ws.send(json.dumps({"specVersion": "1.0", "type": "SYSTEM",
                                  "headers": {"messageId": "p1", "topic": "ping"},
                                  "data": json.dumps({"opaque": "x"})}))
        ping_ack = await s.ack(ws)
        assert ping_ack["code"] == 200 and json.loads(ping_ack["data"]) == {"opaque": "x"}
        await ws.send(bot_frame("f1", group_msg("msgA", "hello pane")))
        await s.ack(ws)
        done.set()
        await ws.wait_closed()

    stream.scripts.append(script)
    async with FakeWs(stream) as ws_server:
        route_open(http, ws_server.url)
        adapter = await start(http, emitted)
        await asyncio.wait_for(done.wait(), 5)
        await adapter.stop()

    open_call = http.calls_to("POST", "/v1.0/gateway/connections/open")[0]
    assert open_call.body["clientId"] == "ding-client"
    assert open_call.body["subscriptions"] == [{"type": "CALLBACK", "topic": BOT_MESSAGE_TOPIC}]
    assert ws_server.connections[0].request.path.endswith("?ticket=tk%2F1%2B2")
    assert stream.acks[1]["headers"]["messageId"] == "f1" and stream.acks[1]["code"] == 200
    [m] = emitted
    assert (m.chat_id, m.thread_id, m.sender_id, m.sender_name) == ("cidGroup1", "", "staff42", "Alice")
    assert (m.text, m.message_id, m.is_direct, m.ts) == ("hello pane", "msgA", False, 1700000000.0)
    assert adapter.known_locations() == [{"chat_id": "cidGroup1", "title": "Navide Ops", "kind": "group",
                                          "supports_topics": False}]


async def test_direct_message_uses_staff_id_location(http: FakeHttp) -> None:
    stream = Stream()
    emitted: list[InboundMessage] = []

    async def script(ws, s: Stream) -> None:
        data = group_msg("msgD", "hi")
        data.update(conversationType="1", conversationId="cidDM")
        await ws.send(bot_frame("f2", data))
        await s.ack(ws)
        await ws.wait_closed()

    stream.scripts.append(script)
    async with FakeWs(stream) as ws_server:
        route_open(http, ws_server.url)
        adapter = await start(http, emitted)
        await wait_for(lambda: emitted)
        await adapter.stop()
    assert emitted[0].chat_id == "user:staff42" and emitted[0].is_direct


async def test_send_group_chunks_dm_and_token_refresh(http: FakeHttp) -> None:
    tokens = iter(["tok1", "tok2"])
    http.route("POST", "/v1.0/oauth2/accessToken", lambda r: {"accessToken": next(tokens), "expireIn": 7200})
    http.route("POST", "/v1.0/robot/groupMessages/send", lambda r: {"processQueryKey": f"q{len(http.calls)}"})
    http.route("POST", "/v1.0/robot/oToMessages/batchSend", lambda r: {"processQueryKey": "qdm"})
    adapter = DingTalkAdapter("ding-client", "ding-secret", base_url=http.base_url)
    try:
        group = Location("dingtalk", "default", "cidGroup1")
        long_text = ("line of output\n" * 400).strip()  # > 4000 chars
        ids = await adapter.send_text(group, long_text)
        assert len(ids) == 2 and all(ids)
        sends = http.calls_to("POST", "/v1.0/robot/groupMessages/send")
        assert [c.headers["x-acs-dingtalk-access-token"] for c in sends] == ["tok1", "tok1"]
        body = sends[0].body
        assert body["robotCode"] == "ding-client" and body["openConversationId"] == "cidGroup1"
        assert body["msgKey"] == "sampleMarkdown"
        param = json.loads(body["msgParam"])
        assert param["title"] == "line of output" and len(param["text"]) <= 4000

        # Expired token: 401 once -> refresh -> retried with the new token.
        http.fail("POST", "/v1.0/robot/oToMessages/batchSend", 401, {"code": "InvalidAuthentication"})
        ids = await adapter.send_text(Location("dingtalk", "default", "user:staff42"), "done")
        assert ids == ["qdm"]
        dm = http.calls_to("POST", "/v1.0/robot/oToMessages/batchSend")
        assert [c.headers["x-acs-dingtalk-access-token"] for c in dm] == ["tok1", "tok2"]
        assert dm[-1].body["userIds"] == ["staff42"]
        assert len(http.calls_to("POST", "/v1.0/oauth2/accessToken")) == 2

        with pytest.raises(NotImplementedError):
            await adapter.edit_text(group, "q1", "x")
        with pytest.raises(NotImplementedError):
            await adapter.create_location("cidGroup1", "pane")
        await adapter.send_typing(group)  # no-op
    finally:
        await adapter.stop()


async def test_auth_failure_blocks_without_retry(http: FakeHttp) -> None:
    http.route("POST", "/v1.0/gateway/connections/open",
               lambda r: Resp(401, {"code": "InvalidAuthentication", "message": "bad secret"}))
    adapter = await start(http, [])
    await wait_for(lambda: adapter.status.lifecycle == "blocked")
    await asyncio.sleep(0.1)
    assert len(http.calls_to("POST", "/v1.0/gateway/connections/open")) == 1
    assert "401" in adapter.status.last_error
    await adapter.stop()


async def test_reconnect_after_drop_and_disconnect_frame(http: FakeHttp) -> None:
    stream = Stream()
    emitted: list[InboundMessage] = []

    async def drop(ws, s: Stream) -> None:
        await ws.close()

    async def server_disconnect(ws, s: Stream) -> None:
        await ws.send(json.dumps({"specVersion": "1.0", "type": "SYSTEM",
                                  "headers": {"messageId": "d1", "topic": "disconnect"}, "data": "{}"}))
        await s.ack(ws)
        await ws.wait_closed()

    async def deliver(ws, s: Stream) -> None:
        await ws.send(bot_frame("f3", group_msg("msgR", "after reconnect")))
        await s.ack(ws)
        await ws.wait_closed()

    stream.scripts += [drop, server_disconnect, deliver]
    async with FakeWs(stream) as ws_server:
        route_open(http, ws_server.url)
        adapter = await start(http, emitted)
        await wait_for(lambda: emitted)
        assert adapter.status.lifecycle == "ready"
        await adapter.stop()
    assert emitted[0].text == "after reconnect"
    assert len(http.calls_to("POST", "/v1.0/gateway/connections/open")) == 3


def test_create_adapter_reads_two_part_secret() -> None:
    from agent_team_backend.channels.dingtalk import create_adapter

    a = create_adapter({"account": "acme"}, {"client_id": "cid", "client_secret": "sec"}, store=None)
    b = create_adapter({}, {"client_id": "cid", "client_secret": "other"}, store=None)
    assert isinstance(a, DingTalkAdapter) and a.account == "acme" and a._robot_code == "cid"
    assert a.token_fingerprint() != b.token_fingerprint()
