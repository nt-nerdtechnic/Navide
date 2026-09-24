from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from agent_team_backend.channels.base import InboundMessage, Location
from agent_team_backend.channels.feishu import (
    METHOD_CONTROL,
    METHOD_DATA,
    FeishuAdapter,
    Frame,
    decode_frame,
    encode_frame,
)

from .fake_platform import FakeHttp, FakeWs, Resp

# Produced by the official SDK's protobuf (lark_oapi/ws/pb/pbbp2_pb2.Frame.SerializeToString).
GOLDEN_PING = bytes.fromhex("0800100018f681801020002a0c0a0474797065120470696e67")
GOLDEN_DATA = bytes.fromhex(
    "080710ac02180520012a0d0a047479706512056576656e742a100a0a6d6573736167655f696412026d31"
    "2a080a0373756d1201312a080a037365711201302a0e0a0874726163655f696412027431420a7b2261223a"
    "22c3a9227d4a0178"
)


def test_frame_codec_matches_sdk_bytes() -> None:
    ping = Frame(service=33554678, method=METHOD_CONTROL, headers=[("type", "ping")])
    assert encode_frame(ping) == GOLDEN_PING
    data = Frame(seq_id=7, log_id=300, service=5, method=METHOD_DATA,
                 headers=[("type", "event"), ("message_id", "m1"), ("sum", "1"), ("seq", "0"),
                          ("trace_id", "t1")],
                 payload='{"a":"é"}'.encode(), log_id_new="x")
    assert encode_frame(data) == GOLDEN_DATA
    assert decode_frame(GOLDEN_DATA) == data
    assert decode_frame(GOLDEN_PING) == ping


async def wait_for(pred, timeout: float = 5.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not pred():
        if loop.time() > end:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def event_body(mid: str, text: str, *, chat_type: str = "group", thread: bool = False,
               sender_type: str = "user") -> dict[str, Any]:
    msg: dict[str, Any] = {
        "message_id": mid, "chat_id": "oc_chat1", "chat_type": chat_type, "message_type": "text",
        "content": json.dumps({"text": text}), "create_time": "1700000000000",
    }
    if thread:
        msg.update(root_id="om_root", parent_id="om_root", thread_id="omt_1")
    return {"schema": "2.0",
            "header": {"event_id": f"e-{mid}", "event_type": "im.message.receive_v1"},
            "event": {"sender": {"sender_id": {"open_id": "ou_alice"}, "sender_type": sender_type},
                      "message": msg}}


def data_frame(mid: str, payload: bytes, *, total: int = 1, seq: int = 0) -> bytes:
    return encode_frame(Frame(service=77, method=METHOD_DATA, headers=[
        ("type", "event"), ("message_id", mid), ("sum", str(total)), ("seq", str(seq)), ("trace_id", "t")],
        payload=payload))


class LongConn:
    def __init__(self) -> None:
        self.scripts: list[Any] = []
        self.received: list[Frame] = []

    async def __call__(self, ws) -> None:
        script = self.scripts.pop(0) if self.scripts else None
        if script is None:
            await ws.wait_closed()
            return
        await script(ws, self)

    async def next_data(self, ws) -> Frame:
        while True:
            f = decode_frame(await ws.recv())
            self.received.append(f)
            if f.method == METHOD_DATA:
                return f


@pytest.fixture
def http():
    with FakeHttp() as h:
        yield h


def route_auth(http: FakeHttp, ws_url: str) -> None:
    http.route("POST", "/open-apis/auth/v3/tenant_access_token/internal",
               lambda r: {"code": 0, "msg": "ok", "tenant_access_token": "t-1", "expire": 7200})
    http.route("POST", "/callback/ws/endpoint", lambda r: {"code": 0, "data": {
        "URL": f"{ws_url}/?device_id=d1&service_id=77", "ClientConfig": {"PingInterval": 120}}})
    http.route("GET", "/open-apis/bot/v3/info", lambda r: {"code": 0, "bot": {"app_name": "Navide Bot"}})
    http.route("GET", "/open-apis/contact/v3/users/ou_alice",
               lambda r: {"code": 0, "data": {"user": {"name": "Alice"}}})


async def start(http: FakeHttp, emitted: list[InboundMessage], **kw) -> FeishuAdapter:
    adapter = FeishuAdapter("cli_app", "app-secret", base_url=http.base_url,
                            backoff=lambda n, r: 0.01, **kw)

    async def emit(m: InboundMessage) -> None:
        emitted.append(m)

    await adapter.start(emit)
    return adapter


async def test_connect_inbound_ack_ping_and_split_payload(http: FakeHttp) -> None:
    conn = LongConn()
    emitted: list[InboundMessage] = []
    done = asyncio.Event()

    async def script(ws, c: LongConn) -> None:
        first = decode_frame(await ws.recv())
        c.received.append(first)
        assert first.method == METHOD_CONTROL and first.header("type") == "ping" and first.service == 77
        await ws.send(encode_frame(Frame(service=77, method=METHOD_CONTROL, headers=[("type", "pong")],
                                         payload=json.dumps({"PingInterval": 60}).encode())))
        await ws.send(data_frame("m1", json.dumps(event_body("om_1", "@_user_1 hello pane")).encode()))
        ack = await c.next_data(ws)
        assert ack.header("message_id") == "m1" and json.loads(ack.payload) == {"code": 200}
        assert ack.header("biz_rt") != ""
        # Bot's own messages are ignored but still acked.
        await ws.send(data_frame("m2", json.dumps(event_body("om_2", "x", sender_type="app")).encode()))
        await c.next_data(ws)
        whole = json.dumps(event_body("om_3", "in thread", thread=True)).encode()
        await ws.send(data_frame("m3", whole[:20], total=2, seq=0))
        await ws.send(data_frame("m3", whole[20:], total=2, seq=1))
        await c.next_data(ws)
        done.set()
        await ws.wait_closed()

    conn.scripts.append(script)
    async with FakeWs(conn) as ws_server:
        route_auth(http, ws_server.url)
        adapter = await start(http, emitted)
        await asyncio.wait_for(done.wait(), 5)
        assert adapter.status.lifecycle == "ready" and adapter.status.identity == "Navide Bot"
        await adapter.stop()

    assert http.calls_to("POST", "/callback/ws/endpoint")[0].body == {"AppID": "cli_app", "AppSecret": "app-secret"}
    assert [m.message_id for m in emitted] == ["om_1", "om_3"]
    first, threaded = emitted
    assert (first.chat_id, first.thread_id, first.sender_id, first.sender_name) == ("oc_chat1", "", "ou_alice", "Alice")
    assert (first.text, first.is_direct, first.ts) == ("hello pane", False, 1700000000.0)
    assert (threaded.thread_id, threaded.text) == ("om_root", "in thread")
    assert len(http.calls_to("GET", "/open-apis/contact/v3/users/ou_alice")) == 1  # cached


async def test_send_reply_in_thread_edit_and_create_location(http: FakeHttp) -> None:
    http.route("POST", "/open-apis/auth/v3/tenant_access_token/internal",
               lambda r: {"code": 0, "tenant_access_token": f"t-{len(http.calls)}", "expire": 7200})
    http.route("POST", "/open-apis/im/v1/messages", lambda r: {"code": 0, "data": {"message_id": "om_new"}})
    http.route("POST", "/open-apis/im/v1/messages/om_root/reply",
               lambda r: {"code": 0, "data": {"message_id": f"om_r{len(http.calls)}"}})
    http.route("PUT", "/open-apis/im/v1/messages/om_new", lambda r: {"code": 0, "data": {}})
    adapter = FeishuAdapter("cli_app", "app-secret", base_url=http.base_url, rate_limit_wait_s=0.01)
    try:
        loc = await adapter.create_location("oc_chat1", "api-refactor")
        assert loc == Location("feishu", "default", "oc_chat1", "om_new", "api-refactor")
        root_post = http.calls_to("POST", "/open-apis/im/v1/messages")[0]
        assert root_post.query == {"receive_id_type": "chat_id"}
        assert root_post.body["receive_id"] == "oc_chat1" and root_post.body["uuid"]
        assert json.loads(root_post.body["content"]) == {"text": "🧵 api-refactor"}

        thread = Location("feishu", "default", "oc_chat1", "om_root")
        ids = await adapter.send_text(thread, ("output line\n" * 500).strip())
        replies = http.calls_to("POST", "/open-apis/im/v1/messages/om_root/reply")
        assert len(ids) == 2 and len(replies) == 2
        assert all(r.body["reply_in_thread"] is True and r.body["msg_type"] == "text" for r in replies)
        assert len({r.body["uuid"] for r in replies}) == 2
        assert all(len(json.loads(r.body["content"])["text"]) <= 4000 for r in replies)
        assert replies[0].headers["authorization"].startswith("Bearer t-")

        # Invalid token -> refresh once; rate limited -> retried with the same uuid.
        http.fail("PUT", "/open-apis/im/v1/messages/om_new", 400, {"code": 99991663, "msg": "token invalid"})
        http.fail("PUT", "/open-apis/im/v1/messages/om_new", 400, {"code": 230020, "msg": "rate limited"})
        await adapter.edit_text(loc, "om_new", "edited")
        edits = http.calls_to("PUT", "/open-apis/im/v1/messages/om_new")
        assert len(edits) == 3 and json.loads(edits[-1].body["content"]) == {"text": "edited"}
        assert edits[0].headers["authorization"] != edits[1].headers["authorization"]
        await adapter.send_typing(thread)  # no-op
    finally:
        await adapter.stop()


async def test_auth_failure_blocks_without_retry(http: FakeHttp) -> None:
    http.route("POST", "/open-apis/auth/v3/tenant_access_token/internal",
               lambda r: Resp(400, {"code": 10014, "msg": "app secret invalid"}))
    adapter = await start(http, [])
    await wait_for(lambda: adapter.status.lifecycle == "blocked")
    await asyncio.sleep(0.1)
    assert len(http.calls_to("POST", "/open-apis/auth/v3/tenant_access_token/internal")) == 1
    assert "10014" in adapter.status.last_error
    await adapter.stop()


async def test_reconnect_after_drop(http: FakeHttp) -> None:
    conn = LongConn()
    emitted: list[InboundMessage] = []

    async def drop(ws, c: LongConn) -> None:
        await ws.recv()  # the first ping
        await ws.close(code=1011)

    async def deliver(ws, c: LongConn) -> None:
        await ws.send(data_frame("m9", json.dumps(event_body("om_9", "back", chat_type="p2p")).encode()))
        await c.next_data(ws)
        await ws.wait_closed()

    conn.scripts += [drop, deliver]
    async with FakeWs(conn) as ws_server:
        route_auth(http, ws_server.url)
        adapter = await start(http, emitted)
        await wait_for(lambda: emitted)
        await adapter.stop()
    assert emitted[0].text == "back" and emitted[0].is_direct
    assert len(http.calls_to("POST", "/callback/ws/endpoint")) == 2


def test_create_adapter_reads_two_part_secret_and_domain() -> None:
    from agent_team_backend.channels.feishu import LARK_BASE_URL, create_adapter

    a = create_adapter({}, {"app_id": "cli_x", "app_secret": "s1"}, store=None)
    b = create_adapter({"domain": "lark", "account": "intl"}, {"app_id": "cli_x", "app_secret": "s2"}, store=None)
    assert isinstance(a, FeishuAdapter) and a.account == "default" and b.account == "intl"
    assert b._base == LARK_BASE_URL and a._base != LARK_BASE_URL
    assert a.token_fingerprint() != b.token_fingerprint()
