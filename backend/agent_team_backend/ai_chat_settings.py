"""AI Chat settings — provider selection, API keys, model names, system prompt."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from .applog import app_data_dir

log = logging.getLogger("agent_team_backend.ai_chat_settings")

SETTINGS_FILE = "ai_chat_settings.json"

DEFAULTS: dict[str, Any] = {
    "provider": "ollama",
    # Anthropic
    "anthropic_api_key": "",
    "anthropic_model": "claude-sonnet-4-6",
    # Ollama (local)
    "ollama_model": "qwen2:latest",
    "ollama_base_url": "http://localhost:11434",
    # OpenAI
    "openai_api_key": "",
    "openai_model": "gpt-4o",
    # Google Gemini
    "google_api_key": "",
    "google_model": "gemini-2.5-pro",
    # Groq
    "groq_api_key": "",
    "groq_model": "llama-3.3-70b-versatile",
    # DeepSeek
    "deepseek_api_key": "",
    "deepseek_model": "deepseek-chat",
    # Mistral AI
    "mistral_api_key": "",
    "mistral_model": "mistral-large-latest",
    # xAI (Grok)
    "xai_api_key": "",
    "xai_model": "grok-3-mini",
    # Custom OpenAI-compatible (LM Studio, vLLM, etc.)
    "openai_compatible_base_url": "",
    "openai_compatible_api_key": "",
    "openai_compatible_model": "",
    # Shared
    "system_prompt": "You are a helpful AI coding assistant.",
    "max_tokens": 4096,
    "reasoning_effort": None,
}

_VALID_PROVIDERS = (
    "anthropic", "ollama",
    "openai", "google", "groq", "deepseek", "mistral", "xai",
    "openai_compatible",
)

# Maps provider name → the DEFAULTS key that holds its model name.
_PROVIDER_MODEL_FIELD: dict[str, str] = {
    "anthropic": "anthropic_model",
    "ollama": "ollama_model",
    "openai": "openai_model",
    "google": "google_model",
    "groq": "groq_model",
    "deepseek": "deepseek_model",
    "mistral": "mistral_model",
    "xai": "xai_model",
    "openai_compatible": "openai_compatible_model",
}


class AIChatSettingsStore:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (app_data_dir() / SETTINGS_FILE)

    @property
    def path(self) -> Path:
        return self._path

    def get(self) -> dict[str, Any]:
        if not self._path.exists():
            result = dict(DEFAULTS)
        else:
            try:
                raw = json.loads(self._path.read_text(encoding="utf-8"))
                if not isinstance(raw, dict):
                    result = dict(DEFAULTS)
                else:
                    result = dict(DEFAULTS)
                    for k in DEFAULTS:
                        if k in raw:
                            result[k] = raw[k]
            except Exception as err:
                log.warning("ai_chat settings read error (%s); using defaults", err)
                result = dict(DEFAULTS)
        # Add computed `model` alias so the frontend receives a single key.
        provider = result.get("provider", "ollama")
        model_field = _PROVIDER_MODEL_FIELD.get(provider, "ollama_model")
        result["model"] = result.get(model_field, DEFAULTS.get(model_field, ""))
        return result

    def set(self, updates: dict[str, Any]) -> dict[str, Any]:
        current = self.get()
        # Handle generic `model` key from frontend — map to provider-specific key.
        if "model" in updates:
            provider = updates.get("provider") or current.get("provider", "ollama")
            model_field = _PROVIDER_MODEL_FIELD.get(provider, "ollama_model")
            current[model_field] = updates["model"]
        for key, value in updates.items():
            if key in DEFAULTS:
                current[key] = value
        if current.get("provider") not in _VALID_PROVIDERS:
            current["provider"] = "ollama"
        try:
            current["max_tokens"] = max(1, min(int(current["max_tokens"]), 16_000))
        except (TypeError, ValueError):
            current["max_tokens"] = DEFAULTS["max_tokens"]
        # Persist without the computed `model` alias (it's derived on read).
        to_save = {k: v for k, v in current.items() if k != "model"}
        self._write(to_save)
        # Recompute alias so the return value is fresh.
        provider = current.get("provider", "ollama")
        model_field = _PROVIDER_MODEL_FIELD.get(provider, "ollama_model")
        current["model"] = current.get(model_field, DEFAULTS.get(model_field, ""))
        log.info("ai_chat settings saved: provider=%s model=%s",
                 current.get("provider"), current.get("model"))
        return current

    def _write(self, data: dict[str, Any]) -> None:
        # 0o700 on dir so other users can't list it; 0o600 on file so they can't read the API key.
        self._path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        encoded = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, encoded)
        finally:
            os.close(fd)
        try:
            os.replace(tmp, self._path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
