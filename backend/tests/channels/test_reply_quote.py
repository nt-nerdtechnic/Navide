"""A chat's native reply carries the quoted message into the pane.

Telegram and Discord put the replied-to message in the inbound payload, so the
adapter fills ``reply_to_text`` / ``reply_to_sender`` and the manager prefixes the
delivered text with a quote block the agent can read.
"""

from __future__ import annotations

from typing import Any

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels.base import InboundMessage
from agent_team_backend.channels.discord import DiscordAdapter
from agent_team_backend.channels.telegram import TelegramAdapter

from .test_manager import Env, _until, env, fast_timers  # noqa: F401 — fixtures

TOKEN = "123:abc"


def _collect(adapter: Any) -> list[InboundMessage]:
    got: list[InboundMessage] = []

    async def emit(msg: InboundMessage) -> None:
        got.append(msg)

    adapter._emit = emit
    return got


def _tg_update(**extra: Any) -> dict[str, Any]:
    msg = {"message_id": 5, "date": 1, "chat": {"id": -100, "type": "supergroup"},
           "from": {"id": 7, "username": "alice"}, "text": "do it", **extra}
    return {"update_id": 1, "message": msg}


# --- Telegram ---------------------------------------------------------------------


async def test_telegram_reply_carries_the_quoted_text_and_sender() -> None:
    ad = TelegramAdapter(TOKEN)
    got = _collect(ad)
    await ad._handle_update(_tg_update(reply_to_message={
        "message_id": 3, "from": {"id": 9, "username": "bob"}, "text": "the plan is X"}))
    assert (got[0].reply_to_id, got[0].reply_to_text, got[0].reply_to_sender) == (
        "3", "the plan is X", "bob")


async def test_telegram_reply_prefers_the_selected_quote_then_the_caption() -> None:
    ad = TelegramAdapter(TOKEN)
    got = _collect(ad)
    await ad._handle_update(_tg_update(
        reply_to_message={"message_id": 3, "from": {"id": 9, "first_name": "Bob"}, "text": "a b c"},
        quote={"text": "b"}))
    await ad._handle_update(_tg_update(
        reply_to_message={"message_id": 4, "from": {"id": 9, "username": "bob"}, "caption": "photo note"}))
    assert [(m.reply_to_text, m.reply_to_sender) for m in got] == [("b", "Bob"), ("photo note", "bob")]


async def test_telegram_topic_root_is_not_a_reply_quote() -> None:
    """Every message in a forum topic 'replies' to the topic's creation message."""
    ad = TelegramAdapter(TOKEN)
    got = _collect(ad)
    await ad._handle_update(_tg_update(
        message_thread_id=50, is_topic_message=True,
        reply_to_message={"message_id": 50, "forum_topic_created": {"name": "t"}, "from": {"id": 7}}))
    await ad._handle_update(_tg_update())
    assert [(m.reply_to_text, m.reply_to_sender) for m in got] == [("", ""), ("", "")]


# --- Discord ----------------------------------------------------------------------


async def test_discord_reply_carries_the_referenced_message() -> None:
    adapter = DiscordAdapter("tok")
    adapter._bot_id = "bot"
    adapter._parents["C1"] = ""
    got = _collect(adapter)
    base = {"channel_id": "C1", "guild_id": "g", "content": "do it", "author": {"id": "42", "username": "a"}}
    await adapter._on_message({**base, "id": "m1", "type": 19, "message_reference": {"message_id": "m0"},
                               "referenced_message": {"id": "m0", "content": "the plan is X",
                                                      "author": {"id": "9", "global_name": "Bob"}}})
    await adapter._on_message({**base, "id": "m2", "type": 0})
    assert [(m.reply_to_id, m.reply_to_text, m.reply_to_sender) for m in got] == [
        ("m0", "the plan is X", "Bob"), ("", "", "")]


# --- Manager: what the pane receives ----------------------------------------------


async def _reply(env: Env, text: str, quoted: str, sender: str = "bob", *, wait: bool = True) -> None:
    await env.m.handle_inbound(InboundMessage(
        platform="telegram", account="default", chat_id="-100", thread_id="50", sender_id="7",
        sender_name="alice", text=text, message_id=f"q-{text}", is_direct=False, ts=0.0,
        reply_to_id="3", reply_to_text=quoted, reply_to_sender=sender))
    if wait:
        await env.m.wait_idle()


async def test_pane_receives_the_quote_above_the_text(env: Env) -> None:
    await _reply(env, "do it", "the plan is X\nstep two")
    assert env.fake.delivered[-1] == (
        "pane-1", "[Replying to bob]\n> the plan is X\n> step two\ndo it", "telegram:alice")


async def test_a_message_without_a_reply_is_delivered_unchanged(env: Env) -> None:
    await env.inbound("plain")
    assert env.fake.delivered[-1][1] == "plain"


async def test_a_long_quote_is_cut(env: Env) -> None:
    await _reply(env, "ok", "x" * (mgr_mod.REPLY_QUOTE_MAX_CHARS + 50), sender="")
    text = env.fake.delivered[-1][1]
    assert text.startswith("[Replying to a message]\n> " + "x" * mgr_mod.REPLY_QUOTE_MAX_CHARS + "…\n")
    assert text.endswith("\nok")


async def test_the_echo_guard_remembers_what_the_pane_was_given(env: Env) -> None:
    await _reply(env, "do it", "the plan is X")
    assert env.m.mirror.echo.consume("pane-1", env.fake.delivered[-1][1])


async def test_debounced_lines_keep_the_first_lines_quote(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "DEBOUNCE_S", 0.2)
    await _reply(env, "first", "the plan is X", wait=False)
    await env.inbound("second", wait=False)
    await _until(lambda: env.fake.delivered)
    await env.m.wait_idle()
    assert env.fake.delivered == [
        ("pane-1", "[Replying to bob]\n> the plan is X\nfirst\nsecond", "telegram:alice")]
