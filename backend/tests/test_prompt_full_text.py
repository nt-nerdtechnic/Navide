"""A user prompt keeps its capped naming snippet, and the chat mirror gets the long copy."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend import app as app_module
from agent_team_backend.cli_vendors.claude import ClaudeLogReader
from agent_team_backend.log_readers.attribution import AttributedUsage
from agent_team_backend.log_readers.base import (
    FULL_PROMPT_MAX_CHARS,
    USER_PROMPT_MAX_CHARS,
    ActivityEvent,
    user_prompt_text,
)


def test_user_prompt_text_is_capped_for_everyone_but_carries_the_long_copy() -> None:
    raw = "  " + "字" * 3000 + "  "
    text = user_prompt_text(raw)
    assert text == "字" * USER_PROMPT_MAX_CHARS and len(text) == USER_PROMPT_MAX_CHARS
    assert text.full == "字" * 3000
    assert user_prompt_text("x" * 40000).full == "x" * FULL_PROMPT_MAX_CHARS
    assert user_prompt_text("<command-name>x</command-name>") == ""
    assert user_prompt_text("   ") == ""
    assert json.dumps({"t": text}) == json.dumps({"t": "字" * USER_PROMPT_MAX_CHARS}, ensure_ascii=True)
    assert getattr(text[:10], "full", None) is None  # a slice is a plain str


def test_claude_reader_event_carries_the_full_prompt(tmp_path: Path) -> None:
    log = tmp_path / "s-1.jsonl"
    prompt = "請詳細修改登入流程。" * 300
    log.write_text(json.dumps({
        "type": "user", "timestamp": "2026-09-29T10:00:00Z", "cwd": str(tmp_path),
        "message": {"role": "user", "content": prompt},
    }) + "\n")
    events = ClaudeLogReader().parse_activity(log, set())
    prompts = [e for e in events if e.detail == "user"]
    assert len(prompts) == 1
    assert len(prompts[0].text) == USER_PROMPT_MAX_CHARS
    assert prompts[0].text.full == prompt.strip()


@pytest.mark.asyncio
async def test_activity_sink_hands_listeners_the_long_copy(monkeypatch, tmp_path) -> None:
    got: list[tuple[str, str]] = []
    listener = lambda pane, text: got.append((pane, text))  # noqa: E731
    monkeypatch.setattr(app_module, "pane_prompt_listeners", [listener])

    async def quiet_broadcast(*_a, **_k) -> None:
        return None

    monkeypatch.setattr(app_module, "broadcast", quiet_broadcast)
    monkeypatch.setattr(app_module.dev_time_store, "agent_event", lambda *a, **k: False)
    monkeypatch.setattr(
        app_module.attribution, "attribute",
        lambda usage: AttributedUsage(usage=usage, pane_id="pane-1", workspace_path=str(tmp_path), stage_id=""),
    )
    long = user_prompt_text("詳細內容" * 500)
    plain = "just a snippet"
    for text in (long, plain):
        await app_module._on_log_activity(ActivityEvent(
            vendor="claude", event_type="agent_active", cwd="/x", session_id="s", file_path="/x/s.jsonl",
            dedup_key=f"k-{len(text)}", timestamp="2026-09-29T10:00:00Z", detail="user", text=text))
    assert got == [("pane-1", "詳細內容" * 500), ("pane-1", plain)]
