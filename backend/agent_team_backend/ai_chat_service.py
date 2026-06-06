"""AI Chat streaming service — Anthropic, Ollama, and OpenAI-compatible backends."""

from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from .ai_chat_settings import DEFAULTS as _CHAT_DEFAULTS

log = logging.getLogger("agent_team_backend.ai_chat_service")


_MAX_TOKENS_CAP = 16_000  # hard cap across all models to limit runaway API cost

# OpenAI-compatible providers: each entry maps to the settings fields that hold
# the base URL, API key, and model name.  Providers with a fixed base URL use
# "base_url"; "openai_compatible" reads it dynamically from settings.
_OPENAI_COMPAT_CONFIGS: dict[str, dict[str, str]] = {
    "openai":    {"base_url": "https://api.openai.com/v1",                              "key_field": "openai_api_key",             "model_field": "openai_model"},
    "google":    {"base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "key_field": "google_api_key",             "model_field": "google_model"},
    "groq":      {"base_url": "https://api.groq.com/openai/v1",                         "key_field": "groq_api_key",               "model_field": "groq_model"},
    "deepseek":  {"base_url": "https://api.deepseek.com/v1",                            "key_field": "deepseek_api_key",           "model_field": "deepseek_model"},
    "mistral":   {"base_url": "https://api.mistral.ai/v1",                              "key_field": "mistral_api_key",            "model_field": "mistral_model"},
    "xai":       {"base_url": "https://api.x.ai/v1",                                    "key_field": "xai_api_key",               "model_field": "xai_model"},
    "openai_compatible": {
        "base_url_field": "openai_compatible_base_url",
        "key_field": "openai_compatible_api_key",
        "model_field": "openai_compatible_model",
    },
}


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
    At stream end all providers yield:
        ``\\x00DONE:<json>``
    where ``<json>`` contains ``model``, ``input_tokens``, ``output_tokens``.
    """
    max_tokens = min(max_tokens, _MAX_TOKENS_CAP)
    provider = settings.get("provider", "ollama")
    if provider == "anthropic":
        async for chunk in _stream_anthropic(settings, messages, system, max_tokens, tools):
            yield chunk
    elif provider in _OPENAI_COMPAT_CONFIGS:
        async for chunk in _stream_openai_compatible(provider, settings, messages, system, max_tokens, tools):
            yield chunk
    else:
        async for chunk in _stream_ollama(settings, messages, system, max_tokens, tools):
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

    # Extended thinking — only for supported Claude models
    thinking_budget = settings.get("thinking_budget_tokens")
    if thinking_budget is not None:
        try:
            budget_tokens = max(1024, min(32000, int(thinking_budget)))
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget_tokens}
            # Extended thinking requires temperature=1 exactly; override any user value
            kwargs["temperature"] = 1
        except (TypeError, ValueError):
            pass

    async with client.messages.stream(**kwargs) as stream:
        async for event in stream:
            event_type = getattr(event, "type", None)

            # Plain text delta
            if event_type == "content_block_delta":
                delta = getattr(event, "delta", None)
                if delta:
                    delta_type = getattr(delta, "type", None)
                    if delta_type == "text_delta":
                        text = getattr(delta, "text", "")
                        if text:
                            yield text
                    elif delta_type == "thinking_delta":
                        # Extended thinking — stream as special sentinel so frontend can render
                        thinking_text = getattr(delta, "thinking", "")
                        if thinking_text:
                            yield "\x00THINKING:" + thinking_text

            # Tool use block start — emit the sentinel so the agent loop can act
            elif event_type == "content_block_start":
                block = getattr(event, "content_block", None)
                if block and getattr(block, "type", None) == "tool_use":
                    # input arrives incrementally; collect it via input_json_stream
                    pass  # handled below via raw_stream accumulation

        # Retrieve the final message to emit any tool_use blocks fully formed.
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


# ── OpenAI-compatible (OpenAI, Google, Groq, DeepSeek, Mistral, xAI, custom) ─

def _to_openai_tools(tools: list[dict]) -> list[dict]:
    """Convert Anthropic-schema tool defs to OpenAI function-calling format."""
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t.get("input_schema", {"type": "object", "properties": {}}),
            },
        }
        for t in tools
    ]


def _convert_messages_to_openai(messages: list[dict]) -> list[dict]:
    """Convert Anthropic-format multi-turn messages (with content blocks) to OpenAI format."""
    result: list[dict] = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if isinstance(content, str):
            result.append({"role": role, "content": content})
            continue

        if not isinstance(content, list):
            result.append({"role": role, "content": str(content)})
            continue

        if role == "assistant":
            text_parts: list[str] = []
            tool_calls: list[dict] = []
            for block in content:
                btype = block.get("type", "")
                if btype == "text":
                    text_parts.append(block.get("text", ""))
                elif btype == "tool_use":
                    tool_calls.append({
                        "id": block.get("id", ""),
                        "type": "function",
                        "function": {
                            "name": block.get("name", ""),
                            "arguments": json.dumps(block.get("input", {})),
                        },
                    })
            out: dict = {"role": "assistant", "content": "".join(text_parts) or ""}
            if tool_calls:
                out["tool_calls"] = tool_calls
            result.append(out)

        elif role == "user":
            tool_results = [b for b in content if b.get("type") == "tool_result"]
            text_blocks = [b for b in content if b.get("type") == "text"]
            for tr in tool_results:
                result.append({
                    "role": "tool",
                    "tool_call_id": tr.get("tool_use_id", ""),
                    "content": tr.get("content", ""),
                })
            if text_blocks:
                text = "\n".join(b.get("text", "") for b in text_blocks)
                result.append({"role": "user", "content": text})

        else:
            result.append(msg)

    return result


async def _stream_openai_compatible(
    provider: str,
    settings: dict,
    messages: list[dict],
    system: str,
    max_tokens: int,
    tools: list[dict] | None = None,
) -> AsyncIterator[str]:
    try:
        import httpx
    except ImportError as exc:
        raise ImportError("The 'httpx' package is required for OpenAI-compatible streaming.") from exc

    cfg = _OPENAI_COMPAT_CONFIGS[provider]

    if "base_url_field" in cfg:
        base_url = settings.get(cfg["base_url_field"], "").strip().rstrip("/")
        if not base_url:
            raise ValueError(
                f"openai_compatible_base_url is not configured — set it in Settings → Analyzer."
            )
    else:
        base_url = cfg["base_url"]

    api_key = settings.get(cfg["key_field"], "").strip()
    model_field = cfg["model_field"]
    model = settings.get(model_field, _CHAT_DEFAULTS.get(model_field, ""))

    # Convert Anthropic-format messages (with content blocks) to OpenAI format
    converted = _convert_messages_to_openai(list(messages))
    full_messages = converted
    if system and (not full_messages or full_messages[0].get("role") != "system"):
        full_messages = [{"role": "system", "content": system}] + full_messages

    body: dict = {
        "model": model,
        "messages": full_messages,
        "stream": True,
        "max_tokens": max_tokens,
    }

    if tools:
        body["tools"] = _to_openai_tools(tools)

    # Reasoning models (o3, o3-mini, o4-mini, etc.) use reasoning_effort instead of temperature.
    # Sending temperature to these models causes an API error.
    _REASONING_MODEL_PREFIXES = ("o1", "o3", "o4")
    is_reasoning_model = any(model.startswith(p) for p in _REASONING_MODEL_PREFIXES)

    if is_reasoning_model:
        # max_tokens → max_completion_tokens for reasoning models
        body.pop("max_tokens", None)
        body["max_completion_tokens"] = max_tokens
        reasoning_effort = settings.get("reasoning_effort")
        if reasoning_effort in ("low", "medium", "high"):
            body["reasoning_effort"] = reasoning_effort
    else:
        temperature = settings.get("temperature")
        if temperature is not None:
            try:
                body["temperature"] = max(0.0, min(1.0, float(temperature)))
            except (TypeError, ValueError):
                pass

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    prompt_tokens = 0
    completion_tokens = 0
    # Accumulate incremental tool call deltas: index → {id, name, arguments}
    pending_tool_calls: dict[int, dict] = {}

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST",
            f"{base_url}/chat/completions",
            json=body,
            headers=headers,
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line or not line.startswith("data: "):
                    continue
                data = line[6:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                # Some providers send final usage in the last chunk.
                usage = chunk.get("usage") or {}
                if usage:
                    prompt_tokens = usage.get("prompt_tokens", 0)
                    completion_tokens = usage.get("completion_tokens", 0)
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                text = delta.get("content", "")
                if text:
                    yield text
                # Accumulate streamed tool call fragments
                for tc_delta in delta.get("tool_calls") or []:
                    tc_idx: int = tc_delta.get("index", 0)
                    if tc_idx not in pending_tool_calls:
                        pending_tool_calls[tc_idx] = {"id": "", "name": "", "arguments": ""}
                    if tc_delta.get("id"):
                        pending_tool_calls[tc_idx]["id"] = tc_delta["id"]
                    fn = tc_delta.get("function") or {}
                    if fn.get("name"):
                        pending_tool_calls[tc_idx]["name"] += fn["name"]
                    if fn.get("arguments"):
                        pending_tool_calls[tc_idx]["arguments"] += fn["arguments"]

    # Emit fully-assembled tool calls as TOOL sentinels
    for tc in sorted(pending_tool_calls.values(), key=lambda x: x.get("id", "")):
        try:
            inp = json.loads(tc["arguments"]) if tc.get("arguments") else {}
        except json.JSONDecodeError:
            inp = {}
        yield "\x00TOOL:" + json.dumps({
            "id": tc["id"],
            "name": tc["name"],
            "input": inp,
        })

    yield "\x00DONE:" + json.dumps({
        "model": model,
        "input_tokens": prompt_tokens,
        "output_tokens": completion_tokens,
    })


# ── Ollama ───────────────────────────────────────────────────────────────────

def _convert_messages_to_ollama(messages: list[dict]) -> list[dict]:
    """Convert Anthropic-format multi-turn messages to Ollama format.

    Ollama accepts the same structure as OpenAI except:
    - tool_calls[].function.arguments must be a JSON *string* (Ollama also sends
      it as a dict on the response side, but for requests it accepts either form).
    We reuse the OpenAI converter since Ollama tolerates tool_call_id in tool
    result messages and accepts the same assistant/tool message shapes.
    """
    return _convert_messages_to_openai(messages)


async def _stream_ollama(
    settings: dict,
    messages: list[dict],
    system: str,
    max_tokens: int,
    tools: list[dict] | None = None,
) -> AsyncIterator[str]:
    try:
        import httpx
    except ImportError as exc:  # noqa: F841
        raise ImportError("The 'httpx' package is required for Ollama streaming.") from exc

    base_url = settings.get("ollama_base_url", "http://localhost:11434").rstrip("/")
    model = settings.get("ollama_model", _CHAT_DEFAULTS["ollama_model"])

    # Convert Anthropic-format messages to Ollama format
    converted = _convert_messages_to_ollama(list(messages))
    full_messages = converted
    if system and (not full_messages or full_messages[0].get("role") != "system"):
        full_messages = [{"role": "system", "content": system}] + full_messages

    body: dict = {
        "model": model,
        "messages": full_messages,
        "stream": True,
        "options": {"num_predict": max_tokens},
    }
    if tools:
        body["tools"] = _to_openai_tools(tools)

    done_message: dict = {}

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
                msg = data.get("message") or {}
                text = msg.get("content", "")
                if text:
                    yield text
                if data.get("done"):
                    done_message = msg
                    break

    # Emit tool calls from the final done-message (Ollama accumulates them there)
    for tc in done_message.get("tool_calls") or []:
        fn = tc.get("function") or {}
        # Ollama returns arguments as a dict; OpenAI returns a JSON string — handle both
        raw_args = fn.get("arguments") or {}
        if isinstance(raw_args, str):
            try:
                raw_args = json.loads(raw_args)
            except json.JSONDecodeError:
                raw_args = {}
        tc_id = tc.get("id") or f"ollama-{fn.get('name', 'tool')}"
        yield "\x00TOOL:" + json.dumps({
            "id": tc_id,
            "name": fn.get("name", ""),
            "input": raw_args,
        })

    yield "\x00DONE:" + json.dumps({"model": model})
