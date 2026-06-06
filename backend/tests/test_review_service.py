"""Tests for review_service.py — stream_review behaviour without real LLM calls."""
from __future__ import annotations

import re

import pytest

from agent_team_backend import review_service


class TestReviewJsonRegex:
    """Verify the regex used in app.py _run_review to extract the JSON block."""

    # The pattern used in app.py (non-greedy after the fix)
    _PATTERN = re.compile(r"```json\s*(.*?)\s*```", re.DOTALL)

    def test_extracts_json_from_clean_block(self):
        text = '```json\n{"summary":"ok","findings":[],"verdict":"approve"}\n```'
        mo = self._PATTERN.search(text)
        assert mo is not None
        assert '"summary"' in mo.group(1)

    def test_non_greedy_picks_first_block(self):
        """With two ```json blocks the regex must match the FIRST one only."""
        first = '{"summary":"first","findings":[],"verdict":"approve"}'
        second = '{"summary":"second","findings":[],"verdict":"request_changes"}'
        text = f"```json\n{first}\n```\n\nsome text\n\n```json\n{second}\n```"
        mo = self._PATTERN.search(text)
        assert mo is not None
        assert "first" in mo.group(1)
        assert "second" not in mo.group(1)

    def test_no_match_without_block(self):
        text = '{"summary":"bare","findings":[],"verdict":"approve"}'
        mo = self._PATTERN.search(text)
        assert mo is None


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

    @pytest.mark.asyncio
    async def test_truncated_flag_adds_note_for_short_diff(self, monkeypatch):
        """truncated=True must inject the truncation note even when diff is short."""
        captured = {}

        async def _fake_stream(settings, messages, system_prompt, **_):
            captured["content"] = messages[0]["content"]
            yield "ok"

        import agent_team_backend.ai_chat_service as acs
        monkeypatch.setattr(acs, "stream_chat", _fake_stream)

        short_diff = "+print('hello')\n"  # well under _MAX_REVIEW_DIFF_CHARS
        await _collect(review_service.stream_review({}, short_diff, truncated=True))
        assert "truncated" in captured["content"]

    @pytest.mark.asyncio
    async def test_no_truncation_note_without_flag_or_long_diff(self, monkeypatch):
        """Short diff without truncated=True must NOT include truncation note."""
        captured = {}

        async def _fake_stream(settings, messages, system_prompt, **_):
            captured["content"] = messages[0]["content"]
            yield "ok"

        import agent_team_backend.ai_chat_service as acs
        monkeypatch.setattr(acs, "stream_chat", _fake_stream)

        short_diff = "+print('hello')\n"
        await _collect(review_service.stream_review({}, short_diff, truncated=False))
        assert "truncated" not in captured["content"]
