"""Tests for review_service.py — stream_review behaviour without real LLM calls."""
from __future__ import annotations

import pytest

from agent_team_backend import review_service


async def _collect(ait) -> str:
    chunks = []
    async for chunk in ait:
        chunks.append(chunk)
    return "".join(chunks)


class TestStreamReview:
    @pytest.mark.asyncio
    async def test_empty_diff_yields_no_changes_message(self):
        result = await _collect(review_service.stream_review({}, ""))
        assert "no changes" in result.lower()

    @pytest.mark.asyncio
    async def test_whitespace_only_diff_is_treated_as_empty(self):
        result = await _collect(review_service.stream_review({}, "   \n\t  "))
        assert "no changes" in result.lower()

    @pytest.mark.asyncio
    async def test_diff_forwarded_to_stream_chat(self, monkeypatch):
        captured = {}

        async def _fake_stream(settings, messages, system_prompt, **_):
            captured["messages"] = messages
            captured["system_prompt"] = system_prompt
            yield "review chunk"

        monkeypatch.setattr(review_service, "stream_chat", _fake_stream, raising=False)
        # Patch the import inside stream_review
        import agent_team_backend.ai_chat_service as acs
        monkeypatch.setattr(acs, "stream_chat", _fake_stream)

        diff = "diff --git a/foo.py b/foo.py\n+print('hello')\n"
        result = await _collect(review_service.stream_review({"model": "x"}, diff))
        assert result == "review chunk"
        assert captured["messages"][0]["role"] == "user"
        assert "foo.py" in captured["messages"][0]["content"] or diff[:50] in captured["messages"][0]["content"]

    @pytest.mark.asyncio
    async def test_diff_truncated_in_prompt(self, monkeypatch):
        captured = {}

        async def _fake_stream(settings, messages, system_prompt, **_):
            captured["content"] = messages[0]["content"]
            yield "ok"

        import agent_team_backend.ai_chat_service as acs
        monkeypatch.setattr(acs, "stream_chat", _fake_stream)

        # Diff longer than _MAX_REVIEW_DIFF_CHARS
        big_diff = "+" + "x" * (review_service._MAX_REVIEW_DIFF_CHARS + 5_000)
        await _collect(review_service.stream_review({}, big_diff))
        # Prompt should contain the truncation note
        assert "truncated" in captured["content"]
        # Actual diff in prompt is capped
        assert len(captured["content"]) < len(big_diff)

    @pytest.mark.asyncio
    async def test_system_prompt_mentions_senior_engineer(self):
        assert "senior software engineer" in review_service.REVIEW_SYSTEM_PROMPT.lower()

    @pytest.mark.asyncio
    async def test_system_prompt_covers_security(self):
        assert "security" in review_service.REVIEW_SYSTEM_PROMPT.lower()
