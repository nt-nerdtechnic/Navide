from __future__ import annotations

import asyncio
import time

import pytest

from agent_team_backend.channels.base import ChannelSendError, InboundMessage, Location
from agent_team_backend.channels.telegram import TelegramAdapter

from .fake_telegram import FakeBotApi

TOKEN = "12345:SECRET"


class MemOffsets:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], tuple[str, int]] = {}

    def get_offset(self, platform: str, account: str, bot_id: str) -> int | None:
        row = self.rows.get((platform, account))
        return row[1] if row and row[0] == bot_id else None

    def set_offset(self, platform: str, account: str, bot_id: str, offset: int) -> None:
        self.rows[(platform, account)] = (bot_id, offset)


async def _until(pred, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.02)


def _adapter(api: FakeBotApi, offsets: MemOffsets | None = None, token: str = TOKEN) -> TelegramAdapter:
    return TelegramAdapter(token, base_url=api.base_url, offset_store=offsets,
                           backoff=lambda attempt, r: 0.05, poll_timeout_s=1)


@pytest.fixture
def api():
    with FakeBotApi(TOKEN) as fake:
        yield fake


async def test_poll_delivers_messages_and_persists_offset(api: FakeBotApi) -> None:
    offsets = MemOffsets()
    got: list[InboundMessage] = []

    async def emit(msg: InboundMessage) -> None:
        got.append(msg)

    ad = _adapter(api, offsets)
    uid = api.push_message(chat_id=42, text="hello")
    await ad.start(emit)
    try:
        await _until(lambda: got)
        assert ad.status.lifecycle == "ready" and ad.status.identity == "@navide_bot"
        m = got[0]
        assert (m.chat_id, m.sender_id, m.text, m.is_direct, m.thread_id) == ("42", "7", "hello", True, "")
        assert api.calls_of("deleteWebhook") == [{"drop_pending_updates": False}]
        await _until(lambda: offsets.rows.get(("telegram", "default")) == ("12345", uid + 1))
    finally:
        await ad.stop()
    assert ad.status.lifecycle == "stopped"


async def test_offset_resumes_for_same_bot_and_is_discarded_for_other_bot(api: FakeBotApi) -> None:
    offsets = MemOffsets()
    offsets.set_offset("telegram", "default", "12345", 777)
    ad = _adapter(api, offsets)

    async def emit(msg: InboundMessage) -> None:
        pass

    await ad.start(emit)
    await _until(lambda: api.calls_of("getUpdates"))
    await ad.stop()
    assert api.calls_of("getUpdates")[0]["offset"] == 777

    # Stored offset belongs to another bot id: the new bot starts without one.
    api.calls.clear()
    offsets.rows[("telegram", "default")] = ("99999", 555)
    ad2 = _adapter(api, offsets)
    await ad2.start(emit)
    await _until(lambda: api.calls_of("getUpdates"))
    await ad2.stop()
    assert "offset" not in api.calls_of("getUpdates")[0]


async def test_409_reports_another_consumer_and_recovers(api: FakeBotApi) -> None:
    api.fail("getUpdates", 409, "Conflict: terminated by other getUpdates request", times=2)
    got: list[InboundMessage] = []

    async def emit(msg: InboundMessage) -> None:
        got.append(msg)

    ad = TelegramAdapter(TOKEN, base_url=api.base_url, backoff=lambda a, r: 0.3, poll_timeout_s=1)
    await ad.start(emit)
    try:
        await _until(lambda: ad.status.lifecycle == "recovering")
        assert "409" in ad.status.last_error and "另一個程式" in ad.status.last_error
        assert TOKEN not in ad.status.last_error
        api.push_message(chat_id=1, text="after")
        await _until(lambda: got)
        assert ad.status.lifecycle == "ready" and ad.status.last_error == ""
    finally:
        await ad.stop()


@pytest.mark.parametrize("code", [401, 404])
async def test_auth_failure_blocks_and_stops(api: FakeBotApi, code: int) -> None:
    api.fail("getMe", code, "Unauthorized" if code == 401 else "Not Found")

    async def emit(msg: InboundMessage) -> None:
        pass

    ad = _adapter(api)
    await ad.start(emit)
    await _until(lambda: ad.status.lifecycle == "blocked")
    await asyncio.sleep(0.2)
    assert len(api.calls_of("getMe")) == 1  # no retry after a dead token
    await ad.stop()


async def test_429_on_send_honours_retry_after(api: FakeBotApi) -> None:
    api.fail("sendMessage", 429, "Too Many Requests: retry after 1", retry_after=1)
    ad = _adapter(api)
    t0 = time.monotonic()
    ids = await ad.send_text(Location("telegram", "default", "42"), "hi")
    assert time.monotonic() - t0 >= 0.9
    assert len(ids) == 1 and len(api.calls_of("sendMessage")) == 2


async def test_non_429_send_error_is_not_retried(api: FakeBotApi) -> None:
    api.fail("sendMessage", 400, "Bad Request: chat not found")
    ad = _adapter(api)
    with pytest.raises(ChannelSendError):
        await ad.send_text(Location("telegram", "default", "42"), "hi")
    assert len(api.calls_of("sendMessage")) == 1


async def test_send_html_falls_back_to_plain_on_parse_error(api: FakeBotApi) -> None:
    api.fail("sendMessage", 400, "Bad Request: can't parse entities: unexpected end tag")
    ad = _adapter(api)
    await ad.send_text(Location("telegram", "default", "42"), "**bold** <x>")
    first, second = api.calls_of("sendMessage")
    assert first["parse_mode"] == "HTML" and first["text"] == "<b>bold</b> &lt;x&gt;"
    assert "parse_mode" not in second and second["text"] == "**bold** <x>"


async def test_long_text_is_chunked_at_4000(api: FakeBotApi) -> None:
    ad = _adapter(api)
    ids = await ad.send_text(Location("telegram", "default", "42"), ("word " * 2000).strip())
    sent = api.calls_of("sendMessage")
    assert len(ids) == len(sent) == 3
    assert all(len(p["text"]) <= 4000 for p in sent)


async def test_topics_create_and_general_topic_omits_thread(api: FakeBotApi) -> None:
    ad = _adapter(api)
    loc = await ad.create_location("-100", "api-refactor")
    assert loc.thread_id == "50" and loc.title == "api-refactor"
    assert api.calls_of("createForumTopic") == [{"chat_id": "-100", "name": "api-refactor"}]
    await ad.send_text(loc, "in topic")
    await ad.send_text(Location("telegram", "default", "-100", "1"), "in general")
    await ad.send_typing(loc)
    topic_send, general_send = api.calls_of("sendMessage")
    assert topic_send["message_thread_id"] == 50
    assert "message_thread_id" not in general_send
    assert api.calls_of("sendChatAction") == [{"chat_id": "-100", "message_thread_id": 50, "action": "typing"}]


async def test_create_topic_without_rights_gives_clear_error(api: FakeBotApi) -> None:
    api.fail("createForumTopic", 400, "Bad Request: not enough rights to create a topic")
    ad = _adapter(api)
    with pytest.raises(ChannelSendError, match="管理主題"):
        await ad.create_location("-100", "x")


async def test_inbound_topic_vs_general_thread_ids(api: FakeBotApi) -> None:
    got: list[InboundMessage] = []

    async def emit(msg: InboundMessage) -> None:
        got.append(msg)

    ad = _adapter(api)
    api.push_message(chat_id=-100, text="topic", chat_type="supergroup", thread_id=50, topic=True, forum=True)
    api.push_message(chat_id=-100, text="general", chat_type="supergroup", forum=True)
    await ad.start(emit)
    try:
        await _until(lambda: len(got) == 2)
    finally:
        await ad.stop()
    assert [(m.thread_id, m.is_direct) for m in got] == [("50", False), ("", False)]
    assert ad.known_locations() == [
        {"chat_id": "-100", "title": "chat-100", "kind": "supergroup", "supports_topics": True}
    ]


async def test_edit_buttons_and_callback(api: FakeBotApi) -> None:
    got: list[InboundMessage] = []

    async def emit(msg: InboundMessage) -> None:
        got.append(msg)

    ad = _adapter(api)
    loc = Location("telegram", "default", "42")
    await ad.send_text(loc, "approve?", buttons=[("Yes", "nv1:abcde:y"), ("No", "nv1:abcde:n")])
    markup = api.calls_of("sendMessage")[0]["reply_markup"]
    assert markup["inline_keyboard"][0][1] == {"text": "No", "callback_data": "nv1:abcde:n"}
    await ad.edit_text(loc, "9", "working…")
    assert api.calls_of("editMessageText")[0]["message_id"] == 9

    api.push_callback(chat_id=42, data="nv1:abcde:y")
    await ad.start(emit)
    try:
        await _until(lambda: got)
    finally:
        await ad.stop()
    assert got[0].callback_data == "nv1:abcde:y" and got[0].text == ""
    assert api.calls_of("answerCallbackQuery")


async def test_edit_not_modified_is_ignored(api: FakeBotApi) -> None:
    api.fail("editMessageText", 400, "Bad Request: message is not modified")
    ad = _adapter(api)
    await ad.edit_text(Location("telegram", "default", "42"), "3", "same")


def test_fingerprint_is_sha256_of_token() -> None:
    import hashlib

    ad = TelegramAdapter(TOKEN)
    assert ad.token_fingerprint() == hashlib.sha256(TOKEN.encode()).hexdigest()


async def test_create_adapter_uses_self_hosted_api_base(api: FakeBotApi) -> None:
    from agent_team_backend.channels.telegram import create_adapter

    ad = create_adapter({"api_base": api.base_url + "/"}, {"token": TOKEN})
    me = await ad._call("getMe")
    assert me["username"] == "navide_bot"
    assert api.calls_of("getMe")


def test_create_adapter_defaults_to_public_api() -> None:
    from agent_team_backend.channels.telegram import DEFAULT_BASE_URL, create_adapter

    ad = create_adapter({}, {"token": TOKEN})
    assert ad._base == f"{DEFAULT_BASE_URL}/bot{TOKEN}"


@pytest.mark.parametrize("base", ["file:///etc/passwd", "ftp://example.com", "api.telegram.org", "http://"])
def test_create_adapter_rejects_non_http_api_base(base: str) -> None:
    from agent_team_backend.channels.telegram import create_adapter

    with pytest.raises(ValueError, match="api_base"):
        create_adapter({"api_base": base}, {"token": TOKEN})
