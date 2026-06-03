"""Tests for analyzer backend routing (llama_cpp vs ollama) and settings persistence."""

from __future__ import annotations

import json
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock


# ── AnalyzerSettingsStore ─────────────────────────────────────────────────────

from agent_team_backend.analyzer_settings import AnalyzerSettingsStore, DEFAULTS


def test_defaults_on_missing_file(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    s = store.get()
    assert s["backend"] == "llama_cpp"
    assert s["ollama_base_url"] == "http://localhost:11434"
    assert s["llama_cli"] == ""


def test_set_backend_ollama(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    result = store.set({"backend": "ollama"})
    assert result["backend"] == "ollama"
    # persists
    assert store.get()["backend"] == "ollama"


def test_set_invalid_backend_resets_to_llama_cpp(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    result = store.set({"backend": "invalid_backend"})
    assert result["backend"] == "llama_cpp"


def test_set_llama_cli_override(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    result = store.set({"llama_cli": "/usr/local/bin/llama-cli"})
    assert result["llama_cli"] == "/usr/local/bin/llama-cli"
    assert store.get()["llama_cli"] == "/usr/local/bin/llama-cli"


def test_set_ollama_base_url(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    result = store.set({"ollama_base_url": "http://192.168.1.10:11434"})
    assert result["ollama_base_url"] == "http://192.168.1.10:11434"


def test_unknown_keys_ignored(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "settings.json")
    result = store.set({"nonexistent_key": "value"})
    assert "nonexistent_key" not in result


def test_atomic_write_creates_file(tmp_path):
    path = tmp_path / "settings.json"
    store = AnalyzerSettingsStore(path)
    store.set({"backend": "ollama"})
    assert path.exists()
    data = json.loads(path.read_text())
    assert data["backend"] == "ollama"


def test_corrupted_file_returns_defaults(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text("{ invalid json }", encoding="utf-8")
    store = AnalyzerSettingsStore(path)
    s = store.get()
    assert s["backend"] == DEFAULTS["backend"]


# ── Routing helpers (app.py) ──────────────────────────────────────────────────

@pytest.fixture
def settings_store(tmp_path):
    return AnalyzerSettingsStore(tmp_path / "settings.json")


def test_az_llama_cli_empty_returns_none(settings_store):
    """Empty llama_cli setting should yield None (use module default)."""
    settings_store.set({"llama_cli": ""})
    v = settings_store.get().get("llama_cli", "").strip()
    assert (v or None) is None


def test_az_llama_cli_set_returns_value(settings_store):
    settings_store.set({"llama_cli": "llama-cli"})
    v = settings_store.get().get("llama_cli", "").strip()
    assert (v or None) == "llama-cli"


# ── Routing dispatches to correct backend ─────────────────────────────────────

@pytest.mark.asyncio
async def test_classify_routes_to_llama_cpp(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "llama_cpp"})

    with patch("agent_team_backend.app.analyzer_settings_store", store), \
         patch("agent_team_backend.app._llama_classify", new_callable=AsyncMock) as mock_llama, \
         patch("agent_team_backend.app._ollama_classify", new_callable=AsyncMock) as mock_ollama:
        mock_llama.return_value = {"intent": "completion", "questions": [], "summary": "ok"}
        from agent_team_backend import app
        # Reload routing helpers by calling them directly
        import importlib
        importlib.reload(app)
        # Re-patch after reload
        app.analyzer_settings_store = store

        # Call routing via the module-level function
        with patch.object(app, "_llama_classify", mock_llama), \
             patch.object(app, "_ollama_classify", mock_ollama):
            result = await app.analyzer_classify("some text", "qwen2.5-coder:latest")

        mock_llama.assert_called_once()
        mock_ollama.assert_not_called()
        assert result["intent"] == "completion"


@pytest.mark.asyncio
async def test_classify_routes_to_ollama(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "ollama", "ollama_base_url": "http://localhost:11434"})

    with patch("agent_team_backend.app.analyzer_settings_store", store):
        from agent_team_backend import app
        with patch.object(app, "_ollama_classify", new_callable=AsyncMock) as mock_ollama, \
             patch.object(app, "_llama_classify", new_callable=AsyncMock) as mock_llama:
            mock_ollama.return_value = {"intent": "question", "questions": [], "summary": "q"}
            app.analyzer_settings_store = store
            result = await app.analyzer_classify("some text", "qwen2.5-coder:latest")

        mock_ollama.assert_called_once()
        mock_llama.assert_not_called()


@pytest.mark.asyncio
async def test_health_routes_to_llama_cpp(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "llama_cpp"})

    from agent_team_backend import app
    with patch.object(app, "_llama_health", new_callable=AsyncMock) as mock_llama, \
         patch.object(app, "_ollama_health", new_callable=AsyncMock) as mock_ollama:
        mock_llama.return_value = {"ok": True, "version": "9330"}
        app.analyzer_settings_store = store
        result = await app.analyzer_health()

    mock_llama.assert_called_once()
    mock_ollama.assert_not_called()
    assert result["ok"] is True


@pytest.mark.asyncio
async def test_health_routes_to_ollama(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "ollama"})

    from agent_team_backend import app
    with patch.object(app, "_llama_health", new_callable=AsyncMock) as mock_llama, \
         patch.object(app, "_ollama_health", new_callable=AsyncMock) as mock_ollama:
        mock_ollama.return_value = {"ok": True, "version": "0.5.1"}
        app.analyzer_settings_store = store
        result = await app.analyzer_health()

    mock_ollama.assert_called_once()
    mock_llama.assert_not_called()
    assert result["ok"] is True


@pytest.mark.asyncio
async def test_llama_cli_override_passed_to_classify(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "llama_cpp", "llama_cli": "/custom/llama-cli"})

    from agent_team_backend import app
    with patch.object(app, "_llama_classify", new_callable=AsyncMock) as mock_llama:
        mock_llama.return_value = {"intent": "in_progress", "questions": [], "summary": ""}
        app.analyzer_settings_store = store
        await app.analyzer_classify("text", "model")

    call_kwargs = mock_llama.call_args.kwargs
    assert call_kwargs.get("llama_cli_override") == "/custom/llama-cli"


@pytest.mark.asyncio
async def test_empty_llama_cli_passes_none(tmp_path):
    store = AnalyzerSettingsStore(tmp_path / "s.json")
    store.set({"backend": "llama_cpp", "llama_cli": ""})

    from agent_team_backend import app
    with patch.object(app, "_llama_classify", new_callable=AsyncMock) as mock_llama:
        mock_llama.return_value = {"intent": "in_progress", "questions": [], "summary": ""}
        app.analyzer_settings_store = store
        await app.analyzer_classify("text", "model")

    call_kwargs = mock_llama.call_args.kwargs
    assert call_kwargs.get("llama_cli_override") is None


# ── analyzer.py llama_cli_override plumbing ───────────────────────────────────

@pytest.mark.asyncio
async def test_run_llama_cli_uses_override():
    """_run_llama_cli should use llama_cli_override instead of LLAMA_CLI."""
    from agent_team_backend.analyzer import _run_llama_cli
    from pathlib import Path
    import asyncio

    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.communicate = AsyncMock(return_value=(b'{"intent":"completion"}', b""))

    with patch("agent_team_backend.analyzer.asyncio.create_subprocess_exec",
               new_callable=AsyncMock) as mock_exec, \
         patch("agent_team_backend.analyzer._llama_sem", asyncio.Semaphore(1)):
        mock_exec.return_value = mock_proc
        await _run_llama_cli(
            system_prompt="sys",
            user_message="msg",
            gguf_path=Path("/fake/model.gguf"),
            llama_cli_override="/custom/llama-completion",
        )

    called_cmd = mock_exec.call_args.args
    assert called_cmd[0] == "/custom/llama-completion"


@pytest.mark.asyncio
async def test_health_uses_override():
    """health() should check the overridden CLI, not the default LLAMA_CLI."""
    from agent_team_backend.analyzer import health
    import shutil

    with patch("agent_team_backend.analyzer.shutil.which") as mock_which:
        mock_which.return_value = None
        result = await health(llama_cli_override="nonexistent-binary-xyz")

    mock_which.assert_called_with("nonexistent-binary-xyz")
    assert result["ok"] is False
    assert "nonexistent-binary-xyz" in result["error"]
