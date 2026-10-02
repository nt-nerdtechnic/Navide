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
