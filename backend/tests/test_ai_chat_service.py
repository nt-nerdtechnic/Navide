"""Tests for ai_chat_service — provider routing and OpenAI-compatible path."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_team_backend.ai_chat_service import (
    _OPENAI_COMPAT_CONFIGS,
    _convert_messages_to_openai,
    _to_openai_tools,
    _stream_openai_compatible,
    stream_chat,
)


# ── Provider routing ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stream_chat_routes_anthropic() -> None:
    settings = {"provider": "anthropic"}
    mock_chunks = ["Hello", " world"]

    async def fake_anthropic(*args, **kwargs):
        for c in mock_chunks:
            yield c

    with patch("agent_team_backend.ai_chat_service._stream_anthropic", side_effect=fake_anthropic):
        chunks = [c async for c in stream_chat(settings, [], "", 100)]
    assert chunks == mock_chunks


@pytest.mark.asyncio
async def test_stream_chat_routes_ollama() -> None:
    settings = {"provider": "ollama"}
    mock_chunks = ["Hi", " there"]

    async def fake_ollama(*args, **kwargs):
        for c in mock_chunks:
            yield c

    with patch("agent_team_backend.ai_chat_service._stream_ollama", side_effect=fake_ollama):
        chunks = [c async for c in stream_chat(settings, [], "", 100)]
    assert chunks == mock_chunks


@pytest.mark.parametrize("provider", [
    "openai", "google", "groq", "deepseek", "mistral", "xai", "openai_compatible",
])
@pytest.mark.asyncio
async def test_stream_chat_routes_openai_compatible(provider: str) -> None:
    settings = {"provider": provider, "openai_compatible_base_url": "http://fake/v1"}
    mock_chunks = ["chunk1", "chunk2"]

    async def fake_compat(*args, **kwargs):
        for c in mock_chunks:
            yield c

    with patch(
        "agent_team_backend.ai_chat_service._stream_openai_compatible",
        side_effect=fake_compat,
    ):
        chunks = [c async for c in stream_chat(settings, [], "", 100)]
    assert chunks == mock_chunks


@pytest.mark.asyncio
async def test_stream_chat_max_tokens_capped() -> None:
    """max_tokens above 16 000 must be clamped."""
    captured: list[int] = []

    async def fake_ollama(settings, messages, system, max_tokens):
        captured.append(max_tokens)
        return
        yield  # make it a generator

    with patch("agent_team_backend.ai_chat_service._stream_ollama", side_effect=fake_ollama):
        async for _ in stream_chat({"provider": "ollama"}, [], "", 999_999):
            pass

    assert captured[0] == 16_000


# ── OpenAI-compatible config table ───────────────────────────────────────────

def test_all_compat_providers_have_model_field() -> None:
    """Every entry in _OPENAI_COMPAT_CONFIGS must declare a model_field."""
    for name, cfg in _OPENAI_COMPAT_CONFIGS.items():
        assert "model_field" in cfg, f"{name} missing model_field"
        assert "key_field" in cfg, f"{name} missing key_field"


def test_fixed_base_url_providers_have_base_url() -> None:
    """Cloud providers (non-custom) must have a static base_url."""
    for name, cfg in _OPENAI_COMPAT_CONFIGS.items():
        if name != "openai_compatible":
            assert "base_url" in cfg, f"{name} missing base_url"


def test_openai_compatible_uses_base_url_field() -> None:
    """Custom provider must read base_url from settings (not hardcoded)."""
    cfg = _OPENAI_COMPAT_CONFIGS["openai_compatible"]
    assert "base_url_field" in cfg
    assert "base_url" not in cfg


# ── _stream_openai_compatible SSE parsing ─────────────────────────────────────

def _make_sse_line(data: dict | str) -> str:
    payload = data if isinstance(data, str) else json.dumps(data)
    return f"data: {payload}"


@pytest.mark.asyncio
async def test_stream_openai_compatible_yields_text() -> None:
    """Text deltas in SSE chunks must be yielded as plain strings."""
    sse_lines = [
        _make_sse_line({"choices": [{"delta": {"content": "Hello"}}]}),
        _make_sse_line({"choices": [{"delta": {"content": " world"}}]}),
        _make_sse_line("[DONE]"),
    ]

    # aiter_lines() returns an async generator directly (not a coroutine)
    mock_resp = _mock_streaming_response(sse_lines)
    settings = {"openai_api_key": "sk-test", "openai_model": "gpt-4o"}

    with patch("httpx.AsyncClient", return_value=_wrap_client(mock_resp)):
        chunks = [c async for c in _stream_openai_compatible("openai", settings, [], "", 100)]

    text_chunks = [c for c in chunks if not c.startswith("\x00")]
    assert text_chunks == ["Hello", " world"]


@pytest.mark.asyncio
async def test_stream_openai_compatible_emits_done_sentinel() -> None:
    """Must emit \\x00DONE: sentinel at end even when usage is absent."""
    sse_lines = [
        _make_sse_line({"choices": [{"delta": {"content": "Hi"}}]}),
        _make_sse_line("[DONE]"),
    ]

    mock_resp = _mock_streaming_response(sse_lines)
    with patch("httpx.AsyncClient", return_value=_wrap_client(mock_resp)):
        chunks = [c async for c in _stream_openai_compatible("openai", {"openai_api_key": "", "openai_model": "gpt-4o"}, [], "", 50)]

    done = [c for c in chunks if c.startswith("\x00DONE:")]
    assert len(done) == 1
    data = json.loads(done[0][len("\x00DONE:"):])
    assert "model" in data


@pytest.mark.asyncio
async def test_stream_openai_compatible_missing_base_url_raises() -> None:
    """openai_compatible provider without base_url must raise ValueError."""
    settings = {"openai_compatible_base_url": "", "openai_compatible_api_key": "", "openai_compatible_model": "x"}
    with pytest.raises(ValueError, match="openai_compatible_base_url"):
        async for _ in _stream_openai_compatible("openai_compatible", settings, [], "", 100):
            pass


@pytest.mark.asyncio
async def test_stream_openai_compatible_temperature_clamped() -> None:
    """Temperature outside [0,1] must be clamped before sending."""
    captured_bodies: list[dict] = []

    async def _fake_stream_call(*args, **kwargs):
        captured_bodies.append(kwargs.get("json", {}))
        mock_resp = _mock_streaming_response([_make_sse_line("[DONE]")])
        return mock_resp

    mock_client = MagicMock()
    mock_client.stream = MagicMock(return_value=_wrap_response(_mock_streaming_response([_make_sse_line("[DONE]")])))
    mock_client_ctx = MagicMock()
    mock_client_ctx.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client_ctx.__aexit__ = AsyncMock(return_value=False)

    settings = {"openai_api_key": "k", "openai_model": "gpt-4o", "temperature": 5.0}
    with patch("httpx.AsyncClient", return_value=mock_client_ctx):
        async for _ in _stream_openai_compatible("openai", settings, [], "", 50):
            pass

    call_kwargs = mock_client.stream.call_args
    body = call_kwargs.kwargs.get("json") or call_kwargs.args[3] if call_kwargs else {}
    if body and "temperature" in body:
        assert body["temperature"] <= 1.0


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _async_iter(items):
    for item in items:
        yield item


def _mock_streaming_response(lines: list[str]) -> MagicMock:
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.aiter_lines = MagicMock(return_value=_async_iter(lines))
    return mock_resp


def _wrap_response(mock_resp: MagicMock) -> MagicMock:
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=mock_resp)
    ctx.__aexit__ = AsyncMock(return_value=False)
    return ctx


def _wrap_client(mock_resp: MagicMock) -> MagicMock:
    mock_client = MagicMock()
    mock_client.stream = MagicMock(return_value=_wrap_response(mock_resp))
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=mock_client)
    ctx.__aexit__ = AsyncMock(return_value=False)
    return ctx


# ── _to_openai_tools ──────────────────────────────────────────────────────────

def test_to_openai_tools_converts_schema() -> None:
    tools = [
        {
            "name": "read_file",
            "description": "Read a file",
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        }
    ]
    result = _to_openai_tools(tools)
    assert len(result) == 1
    assert result[0]["type"] == "function"
    assert result[0]["function"]["name"] == "read_file"
    assert result[0]["function"]["description"] == "Read a file"
    assert result[0]["function"]["parameters"]["properties"]["path"]["type"] == "string"


def test_to_openai_tools_empty() -> None:
    assert _to_openai_tools([]) == []


# ── _convert_messages_to_openai ───────────────────────────────────────────────

def test_convert_messages_passthrough_simple() -> None:
    msgs = [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there"},
    ]
    result = _convert_messages_to_openai(msgs)
    assert result == msgs


def test_convert_messages_assistant_tool_use() -> None:
    msgs = [
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "Let me read that"},
                {
                    "type": "tool_use",
                    "id": "call_abc",
                    "name": "read_file",
                    "input": {"path": "foo.py"},
                },
            ],
        }
    ]
    result = _convert_messages_to_openai(msgs)
    assert len(result) == 1
    assert result[0]["role"] == "assistant"
    assert result[0]["content"] == "Let me read that"
    assert len(result[0]["tool_calls"]) == 1
    tc = result[0]["tool_calls"][0]
    assert tc["id"] == "call_abc"
    assert tc["function"]["name"] == "read_file"
    assert json.loads(tc["function"]["arguments"]) == {"path": "foo.py"}


def test_convert_messages_tool_result() -> None:
    msgs = [
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "call_abc",
                    "content": "file contents here",
                }
            ],
        }
    ]
    result = _convert_messages_to_openai(msgs)
    assert len(result) == 1
    assert result[0]["role"] == "tool"
    assert result[0]["tool_call_id"] == "call_abc"
    assert result[0]["content"] == "file contents here"


def test_convert_messages_mixed_user_turn() -> None:
    msgs = [
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "call_1", "content": "result"},
                {"type": "text", "text": "Does this look right?"},
            ],
        }
    ]
    result = _convert_messages_to_openai(msgs)
    # tool result should become a tool role, text should become user role
    assert any(r["role"] == "tool" for r in result)
    assert any(r["role"] == "user" for r in result)
