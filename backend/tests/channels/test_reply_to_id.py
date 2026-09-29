"""``InboundMessage.reply_to_id``: what each adapter's real inbound payload says a message replies to.

The mirror uses it to route a reply to a child's message to that child, so the id
must be the one ``send_text`` returned for the bot message being replied to.
"""

from __future__ import annotations

import json
from typing import Any

from agent_team_backend.channels.base import InboundMessage
from agent_team_backend.channels.dingtalk import DingTalkAdapter
from agent_team_backend.channels.discord import DiscordAdapter
from agent_team_backend.channels.feishu import FeishuAdapter
from agent_team_backend.channels.matrix import MatrixAdapter, _reply_target
from agent_team_backend.channels.mattermost import MattermostAdapter
from agent_team_backend.channels.slack import SlackAdapter


def _collect(adapter: Any) -> list[InboundMessage]:
    got: list[InboundMessage] = []

    async def emit(msg: InboundMessage) -> None:
        got.append(msg)

    adapter._emit = emit
    return got


async def test_discord_message_reference() -> None:
    adapter = DiscordAdapter("tok")
    adapter._bot_id = "bot"
    adapter._parents["C1"] = ""
    got = _collect(adapter)
    base = {"channel_id": "C1", "guild_id": "g", "type": 0, "content": "hi",
            "author": {"id": "42", "username": "a"}}
    await adapter._on_message({**base, "id": "m1", "message_reference": {"message_id": "bot-msg-9"}})
    await adapter._on_message({**base, "id": "m2"})
    assert [m.reply_to_id for m in got] == ["bot-msg-9", ""]


async def test_slack_thread_reply_points_at_the_thread_root() -> None:
    adapter = SlackAdapter("xapp-1", "xoxb-1")
    adapter._user_id = "UBOT"
    adapter._names["U1"] = "alice"
    got = _collect(adapter)
    base = {"type": "message", "channel": "C1", "user": "U1", "text": "hi", "channel_type": "channel"}
    await adapter._on_event({**base, "ts": "10.1", "thread_ts": "9.0"})
    await adapter._on_event({**base, "ts": "11.1"})
    await adapter._on_event({**base, "ts": "12.1", "thread_ts": "12.1"})  # the root itself is not a reply
    assert [m.reply_to_id for m in got] == ["9.0", "", ""]


def test_matrix_reply_target_ignores_the_thread_fallback() -> None:
    assert _reply_target({"m.in_reply_to": {"event_id": "$bot"}}) == "$bot"
    assert _reply_target({"rel_type": "m.thread", "event_id": "$root", "is_falling_back": True,
                          "m.in_reply_to": {"event_id": "$root"}}) == ""
    assert _reply_target({"rel_type": "m.thread", "event_id": "$root", "is_falling_back": False,
                          "m.in_reply_to": {"event_id": "$bot"}}) == "$bot"
    assert _reply_target({}) == ""


async def test_matrix_event_carries_the_reply_target() -> None:
    adapter = MatrixAdapter("https://hs", "tok")
    adapter._user_id = "@bot:hs"
    adapter._names["@a:hs"] = "a"
    got = _collect(adapter)
    event = {"type": "m.room.message", "sender": "@a:hs", "event_id": "$e1",
             "content": {"msgtype": "m.text", "body": "again",
                         "m.relates_to": {"m.in_reply_to": {"event_id": "$bot-msg"}}}}
    await adapter._on_event("!r:hs", event)
    assert got[0].reply_to_id == "$bot-msg" and got[0].thread_id == ""


async def test_mattermost_reply_points_at_the_root_post() -> None:
    adapter = MattermostAdapter("https://mm", "tok")
    adapter._user_id = "bot"
    got = _collect(adapter)
    for post in ({"id": "p2", "user_id": "u1", "channel_id": "c", "message": "x", "root_id": "p1"},
                 {"id": "p3", "user_id": "u1", "channel_id": "c", "message": "y", "root_id": ""}):
        await adapter._on_posted({"post": json.dumps(post), "channel_type": "O", "sender_name": "@a"})
    assert [m.reply_to_id for m in got] == ["p1", ""]


async def test_feishu_parent_id() -> None:
    adapter = FeishuAdapter("id", "secret")
    adapter._names["ou_1"] = "alice"
    got = _collect(adapter)
    msg = {"chat_id": "oc_1", "chat_type": "group", "message_id": "om_2", "message_type": "text",
           "content": json.dumps({"text": "again"})}
    for extra in ({"parent_id": "om_bot", "root_id": "om_bot"}, {}):
        body = {"header": {"event_type": "im.message.receive_v1"},
                "event": {"sender": {"sender_type": "user", "sender_id": {"open_id": "ou_1"}},
                          "message": {**msg, **extra}}}
        await adapter._on_event(body)
    assert [m.reply_to_id for m in got] == ["om_bot", ""]


async def test_dingtalk_cannot_map_replies_and_says_so() -> None:
    # DingTalk's send API answers with processQueryKey, never the msgId a quoted
    # reply would name, so replies cannot be tied to a bot message: always "".
    adapter = DingTalkAdapter("cid", "secret")
    got = _collect(adapter)
    await adapter._on_bot_message({
        "conversationType": "2", "conversationId": "cid1", "senderStaffId": "u1", "senderNick": "a",
        "msgId": "m1", "msgtype": "text", "text": {"content": "hi", "isReplyMsg": True}})
    assert got and got[0].reply_to_id == ""
