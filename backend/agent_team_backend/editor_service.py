"""Editor AI service — selection rewrite (Cmd+K) + inline completion (ghost).

Proxies to a local Ollama-compatible ``/api/generate`` endpoint (the same one
the analyzer uses). Always returns a serialisable ``{ok, text, error}`` dict;
connection / model errors degrade gracefully so the editor UI can show a
friendly message instead of throwing.
"""

from __future__ import annotations

from typing import Any

import httpx

_REWRITE_SYSTEM = (
    "You are a precise code-editing assistant embedded in an editor. "
    "Rewrite the user's selected code to satisfy their instruction. "
    "Return ONLY the rewritten code with no markdown fences, no explanation, "
    "and preserve the surrounding indentation style."
)

_COMPLETE_SYSTEM = (
    "You are an inline code-completion assistant. Continue the code at the "
    "cursor. Return ONLY the raw text to insert — no markdown fences, no "
    "explanation. Keep it short (a few lines at most)."
)


def _strip_fences(text: str) -> str:
    """Remove a ```lang ... ``` wrapper if the model added one anyway."""
    t = text.strip()
    if t.startswith("```"):
        lines = t.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        t = "\n".join(lines)
    return t


async def _generate(base_url: str, model: str, system: str, prompt: str, n_predict: int) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(base_url=base_url.rstrip("/"), timeout=60.0) as client:
            resp = await client.post(
                "/api/generate",
                json={
                    "model": model,
                    "system": system,
                    "prompt": prompt,
                    "stream": False,
                    "options": {"temperature": 0.1, "num_predict": n_predict},
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        return {"ok": False, "error": f"LLM unavailable: {exc}"}
    except Exception as exc:  # noqa: BLE001 — surface anything as a friendly error
        return {"ok": False, "error": str(exc)}
    text = _strip_fences(str(data.get("response", "")))
    if not text:
        return {"ok": False, "error": "empty response from model"}
    return {"ok": True, "text": text}


async def rewrite(
    base_url: str, model: str, code: str, instruction: str, language: str = ""
) -> dict[str, Any]:
    if not code.strip():
        return {"ok": False, "error": "no code selected"}
    if not instruction.strip():
        return {"ok": False, "error": "no instruction"}
    lang = f" ({language})" if language else ""
    prompt = (
        f"Instruction: {instruction}\n\n"
        f"Selected code{lang}:\n{code}\n\n"
        f"Rewritten code:"
    )
    return await _generate(base_url, model, _REWRITE_SYSTEM, prompt, n_predict=1024)


async def complete(
    base_url: str, model: str, prefix: str, suffix: str = "", language: str = ""
) -> dict[str, Any]:
    if not prefix.strip():
        return {"ok": False, "error": "nothing to complete"}
    lang = f" ({language})" if language else ""
    prompt = (
        f"Complete the code at <CURSOR>{lang}.\n\n"
        f"{prefix}<CURSOR>{suffix}\n\n"
        f"Text to insert at <CURSOR>:"
    )
    return await _generate(base_url, model, _COMPLETE_SYSTEM, prompt, n_predict=256)
