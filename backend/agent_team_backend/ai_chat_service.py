"""AI Chat streaming service — Anthropic and Ollama backends."""

from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from .ai_chat_settings import DEFAULTS as _CHAT_DEFAULTS

log = logging.getLogger("agent_team_backend.ai_chat_service")


_MAX_TOKENS_CAP = 16_000  # hard cap across all models to limit runaway API cost


async def stream_chat(
    settings: dict,
    messages: list[dict],
    system: str,
    max_tokens: int,
    tools: list[dict] | None = None,
) -> AsyncIterator[str]:
    """Yield text chunks from the configured provider.

    For Anthropic tool_use blocks, yields a special sentinel line:
        ``\\x00TOOL:<json>``
    where ``<json>`` is ``{"id": ..., "name": ..., "input": ...}``.
    """
    max_tokens = min(max_tokens, _MAX_TOKENS_CAP)
    provider = settings.get("provider", "ollama")
    if provider == "anthropic":
        async for chunk in _stream_anthropic(settings, messages, system, max_tokens, tools):
            yield chunk
    else:
        async for chunk in _stream_ollama(settings, messages, system, max_tokens):
            yield chunk


# ── Anthropic ────────────────────────────────────────────────────────────────

async def _stream_anthropic(
    settings: dict,
    messages: list[dict],
    system: str,
    max_tokens: int,
    tools: list[dict] | None,
) -> AsyncIterator[str]:
    try:
        import anthropic as _anthropic
    except ImportError as exc:
        raise ImportError(
            "The 'anthropic' package is not installed. "
            "Add it with: pip install anthropic>=0.40"
        ) from exc

    api_key = settings.get("anthropic_api_key", "").strip()
    model = settings.get("anthropic_model", _CHAT_DEFAULTS["anthropic_model"])

    client = _anthropic.AsyncAnthropic(api_key=api_key or None)

    temperature = settings.get("temperature")
    kwargs: dict = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
    }
    if system:
        kwargs["system"] = system
    if tools:
        kwargs["tools"] = tools
    if temperature is not None:
        try:
            t = float(temperature)
        except (TypeError, ValueError):
            t = 1.0
        kwargs["temperature"] = max(0.0, min(1.0, t))

    async with client.messages.stream(**kwargs) as stream:
        async for event in stream:
            event_type = getattr(event, "type", None)

            # Plain text delta
            if event_type == "content_block_delta":
                delta = getattr(event, "delta", None)
                if delta and getattr(delta, "type", None) == "text_delta":
                    text = getattr(delta, "text", "")
                    if text:
                        yield text

            # Tool use block start — emit the sentinel so the agent loop can act
            elif event_type == "content_block_start":
                block = getattr(event, "content_block", None)
                if block and getattr(block, "type", None) == "tool_use":
                    # input arrives incrementally; collect it via input_json_stream
                    pass  # handled below via raw_stream accumulation

        # Retrieve the final message to emit any tool_use blocks fully formed.
        # get_final_message() can raise if the stream ended abnormally; guard it
        # so the exception doesn't propagate as an unhandled generator crash.
        try:
            final = await stream.get_final_message()
        except Exception as exc:  # noqa: BLE001
            log.warning("get_final_message failed: %s", exc)
            return
        for block in final.content:
            if getattr(block, "type", None) == "tool_use":
                yield "\x00TOOL:" + json.dumps({
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                })
        usage = getattr(final, "usage", None)
        yield "\x00DONE:" + json.dumps({
            "model": model,
            "input_tokens": getattr(usage, "input_tokens", 0) if usage else 0,
            "output_tokens": getattr(usage, "output_tokens", 0) if usage else 0,
        })


# ── Ollama ───────────────────────────────────────────────────────────────────

async def _stream_ollama(
    settings: dict,
    messages: list[dict],
    system: str,
    max_tokens: int,
) -> AsyncIterator[str]:
    try:
        import httpx
    except ImportError as exc:  # noqa: F841
        raise ImportError("The 'httpx' package is required for Ollama streaming.") from exc

    base_url = settings.get("ollama_base_url", "http://localhost:11434").rstrip("/")
    model = settings.get("ollama_model", _CHAT_DEFAULTS["ollama_model"])

    # Prepend system as a system-role message if provided and not already present
    full_messages = list(messages)
    if system and (not full_messages or full_messages[0].get("role") != "system"):
        full_messages = [{"role": "system", "content": system}] + full_messages

    body = {
        "model": model,
        "messages": full_messages,
        "stream": True,
        "options": {"num_predict": max_tokens},
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream("POST", f"{base_url}/api/chat", json=body) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                text = data.get("message", {}).get("content", "")
                if text:
                    yield text
                if data.get("done"):
                    yield "\x00DONE:" + json.dumps({"model": model})
                    break
