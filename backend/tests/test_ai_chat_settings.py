"""Tests for AIChatSettingsStore — especially model key mapping."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.ai_chat_settings import AIChatSettingsStore, DEFAULTS


def make_store(tmp_path: Path) -> AIChatSettingsStore:
    return AIChatSettingsStore(path=tmp_path / "settings.json")


def test_get_defaults(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    result = store.get()
    assert result["provider"] == DEFAULTS["provider"]
    assert "model" in result


def test_get_model_alias_anthropic(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"provider": "anthropic", "model": "claude-opus-4-8"})
    result = store.get()
    assert result["model"] == "claude-opus-4-8"
    assert result["anthropic_model"] == "claude-opus-4-8"


def test_get_model_alias_ollama(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"provider": "ollama", "model": "llama3.2:70b"})
    result = store.get()
    assert result["model"] == "llama3.2:70b"
    assert result["ollama_model"] == "llama3.2:70b"


def test_set_model_without_provider_change(tmp_path: Path) -> None:
    """Frontend may send only model without repeating provider."""
    store = make_store(tmp_path)
    # first establish provider=anthropic
    store.set({"provider": "anthropic"})
    # now update model only
    store.set({"model": "claude-haiku-4-5-20251001"})
    result = store.get()
    assert result["anthropic_model"] == "claude-haiku-4-5-20251001"
    assert result["model"] == "claude-haiku-4-5-20251001"
    assert result["provider"] == "anthropic"


def test_model_key_not_persisted_to_disk(tmp_path: Path) -> None:
    """The computed `model` alias must NOT be written to the JSON file."""
    store = make_store(tmp_path)
    store.set({"provider": "anthropic", "model": "claude-sonnet-4-6"})
    raw = json.loads((tmp_path / "settings.json").read_text())
    assert "model" not in raw


def test_set_unknown_keys_ignored(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    result = store.set({"bogus_key": "whatever"})
    assert "bogus_key" not in result


def test_invalid_provider_falls_back_to_ollama(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    result = store.set({"provider": "unknown_provider"})
    assert result["provider"] == "ollama"


def test_set_returns_model_alias(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    result = store.set({"provider": "anthropic", "model": "claude-opus-4-8"})
    assert result.get("model") == "claude-opus-4-8"
