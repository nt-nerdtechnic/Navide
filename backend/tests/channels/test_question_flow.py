"""A pane that stops to ask something stays answerable from the chat: retries after
a bad answer, follow-up questions, bare answers, and prompts the chat cannot answer."""

from __future__ import annotations

import asyncio

from .test_manager import (  # noqa: F401 — fixtures and helpers shared with the manager suite
    Env, _awaiting, _relay_id, _until, _until_relay_prompt, env, fast_timers,
)


def _prompts(env: Env) -> list[str]:
    return [t for t in env.tg.texts() if t.startswith("⏸")]


def _set_status(env: Env, status: str) -> None:
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": status}
    env.m.mirror.on_status("pane-1")


# --- F5: a status change resets the run's own posted flag too ----------------------------


async def test_replies_level_relays_a_prompt_that_follows_a_keyboard_answer(env: Env) -> None:
    assert env.store.set_verbosity("pane-1", "replies") is not None
    await _awaiting(env)
    await _until_relay_prompt(env)
    # Answered at the keyboard, and the same prompt shows up again before the next
    # probe: at "replies" only the probe relays, so it must not think it already did.
    _set_status(env, "running")
    _set_status(env, "awaiting")
    await _until(lambda: len(_prompts(env)) == 2)
    assert len(env.m.relay._by_id) == 1


# --- F1: an answer that was not sent leaves the prompt answerable ----------------------


async def _question(env: Env, options: list[str], prompt: str = "Pick one") -> str:
    env.fake.kind = "permission"  # what Claude's AskUserQuestion box reports
    env.fake.prompt = prompt
    env.fake.options = options
    await _awaiting(env)
    await _until_relay_prompt(env)
    return _relay_id(env)


async def test_a_wrong_option_number_can_be_corrected(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"])
    await env.inbound(f"5 {rid}")
    assert env.tg.texts()[-1] == "⚠️ 請回覆有效的選項編號" and env.fake.answers == []
    await env.inbound(f"2 {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 2})]
    assert env.tg.texts()[-1] == "✅ 已送出：選項 2"


async def test_a_failed_send_can_be_retried(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"])
    env.fake.answer_result = {"ok": False, "error": "the window did not answer"}
    await env.inbound(f"1 {rid}")
    assert env.tg.texts()[-1] == "⚠️ 送出失敗：the window did not answer"
    env.fake.answer_result = {"ok": True}
    await env.inbound(f"1 {rid}")
    assert env.tg.texts()[-1] == "✅ 已送出：選項 1" and len(env.fake.answers) == 2


async def test_an_answer_to_a_stale_screen_brings_the_current_prompt(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"], prompt="Old question")
    env.fake.prompt = "New question"
    await env.inbound(f"1 {rid}")
    assert env.fake.answers == []
    await _until(lambda: any("New question" in t for t in _prompts(env)))
    new_rid = _relay_id(env)
    assert new_rid != rid and len(env.m.relay._by_id) == 1
    await env.inbound(f"1 {new_rid}")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 1})]
