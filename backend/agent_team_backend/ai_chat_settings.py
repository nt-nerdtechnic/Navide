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
    "provider": "ollama",                  # "anthropic" | "ollama"
    "anthropic_api_key": "",
    "anthropic_model": "claude-sonnet-4-6",
    "ollama_model": "llama3.2",
    "ollama_base_url": "http://localhost:11434",
    "system_prompt": "You are a helpful AI coding assistant.",
    "max_tokens": 4096,
}

_VALID_PROVIDERS = ("anthropic", "ollama")


class AIChatSettingsStore:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (app_data_dir() / SETTINGS_FILE)

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
        # Add computed `model` alias so the frontend receives a single key
        if result.get("provider") == "anthropic":
            result["model"] = result.get("anthropic_model", DEFAULTS["anthropic_model"])
        else:
            result["model"] = result.get("ollama_model", DEFAULTS["ollama_model"])
        return result

    def set(self, updates: dict[str, Any]) -> dict[str, Any]:
        current = self.get()
        # Handle generic `model` key from frontend — map to provider-specific key
        if "model" in updates:
            provider = updates.get("provider") or current.get("provider", "anthropic")
            if provider == "anthropic":
                current["anthropic_model"] = updates["model"]
            else:
                current["ollama_model"] = updates["model"]
        for key, value in updates.items():
            if key in DEFAULTS:
                current[key] = value
        if current.get("provider") not in _VALID_PROVIDERS:
            current["provider"] = "ollama"
        # Clamp max_tokens to a valid range (1–16 000) so callers can't
        # accidentally trigger runaway API costs or send 0/negative values.
        try:
            current["max_tokens"] = max(1, min(int(current["max_tokens"]), 16_000))
        except (TypeError, ValueError):
            current["max_tokens"] = DEFAULTS["max_tokens"]
        # Persist without the computed `model` alias (it's derived on read)
        to_save = {k: v for k, v in current.items() if k != "model"}
        self._write(to_save)
        # Recompute `model` alias so the return value is fresh (not the value from get() above)
        if current.get("provider") == "anthropic":
            current["model"] = current.get("anthropic_model", DEFAULTS["anthropic_model"])
        else:
            current["model"] = current.get("ollama_model", DEFAULTS["ollama_model"])
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
        os.replace(tmp, self._path)
