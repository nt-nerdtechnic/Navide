"""The TLS context outbound Ollama clients verify with is built once, off the
event loop, and shared — instead of once per ``httpx.AsyncClient`` on the loop.

Regression for the Windows event-loop stall: every analyzer health poll opened
a fresh client, each ``__init__`` ran ``ssl.create_default_context`` inline,
and under load that took seconds per poll (loop_watchdog stalls in
``analyzer_health_h`` → ``httpx.AsyncClient.__init__``)."""

from __future__ import annotations

import asyncio
import ssl
import subprocess
import threading
from typing import Any

import httpx
import pytest

from agent_team_backend import analyzer_ollama, git_service, http_ssl, pane_name_service


class _SpyClient(httpx.AsyncClient):
    """A real AsyncClient (so ``__init__`` builds its transport for real) whose
    requests never touch the network."""

    inits: list[dict[str, Any]] = []

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        _SpyClient.inits.append(kwargs)
        super().__init__(*args, **kwargs)

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:  # type: ignore[override]
        return httpx.Response(
            200, json={"version": "0.0"}, request=httpx.Request("GET", str(url))
        )


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch) -> None:
    monkeypatch.setattr(http_ssl, "_context", None)
    # asyncio.Lock binds to the loop it first waits on; each test has its own.
    monkeypatch.setattr(http_ssl, "_build_lock", asyncio.Lock())
    _SpyClient.inits = []


@pytest.fixture
def ssl_calls(monkeypatch) -> list[int]:
    """Thread idents of every ``ssl.create_default_context`` call."""
    calls: list[int] = []
    real = ssl.create_default_context

    def counting(*args: Any, **kwargs: Any) -> ssl.SSLContext:
        calls.append(threading.get_ident())
        return real(*args, **kwargs)

    monkeypatch.setattr(ssl, "create_default_context", counting)
    return calls


async def test_three_health_polls_build_one_ssl_context(monkeypatch, ssl_calls) -> None:
    monkeypatch.setattr(analyzer_ollama.httpx, "AsyncClient", _SpyClient)

    for _ in range(3):
        result = await analyzer_ollama.health("http://localhost:11434")
        assert result["ok"] is True

    assert len(_SpyClient.inits) == 3
    assert len(ssl_calls) == 1


async def test_the_context_is_built_off_the_event_loop_thread(monkeypatch, ssl_calls) -> None:
    monkeypatch.setattr(analyzer_ollama.httpx, "AsyncClient", _SpyClient)

    await analyzer_ollama.health("http://localhost:11434")

    assert ssl_calls and ssl_calls[0] != threading.get_ident()


async def test_concurrent_first_callers_share_one_build(ssl_calls) -> None:
    first, second, third = await asyncio.gather(
        http_ssl.default_ssl_context(),
        http_ssl.default_ssl_context(),
        http_ssl.default_ssl_context(),
    )

    assert first is second is third
    assert len(ssl_calls) == 1


async def test_every_client_verifies_with_the_shared_context(monkeypatch) -> None:
    monkeypatch.setattr(analyzer_ollama.httpx, "AsyncClient", _SpyClient)

    await analyzer_ollama.health("http://localhost:11434")
    await analyzer_ollama.list_models("http://localhost:11434")

    shared = await http_ssl.default_ssl_context()
    assert [kw["verify"] for kw in _SpyClient.inits] == [shared, shared]
    # Verification is the httpx default, not switched off for http:// hosts.
    assert shared.verify_mode == ssl.CERT_REQUIRED
    assert shared.check_hostname is True


class _RecordingClient:
    inits: list[dict[str, Any]] = []

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        _RecordingClient.inits.append(kwargs)

    async def __aenter__(self) -> "_RecordingClient":
        return self

    async def __aexit__(self, *args: Any) -> bool:
        return False

    async def post(self, url: str, json: dict[str, Any]) -> httpx.Response:
        return httpx.Response(
            200, json={"response": "```text\nname\n```"}, request=httpx.Request("POST", url)
        )


async def test_pane_name_and_commit_message_share_the_context(monkeypatch, tmp_path) -> None:
    _RecordingClient.inits = []
    monkeypatch.setattr(pane_name_service.httpx, "AsyncClient", _RecordingClient)
    monkeypatch.setattr(git_service.httpx, "AsyncClient", _RecordingClient)
    pane_name_service._cooldown.reset()

    await pane_name_service.generate_pane_name("fix it", "http://localhost:11434", "m")
    # generate_commit_message needs a staged change before it calls Ollama.
    for argv in (["init"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]):
        subprocess.run(["git", *argv], cwd=tmp_path, check=True, capture_output=True)
    (tmp_path / "README.md").write_text("# test\nchanged")
    await git_service.stage_files(str(tmp_path), ["README.md"])
    await git_service.generate_commit_message(str(tmp_path), "http://localhost:11434", "m")

    shared = await http_ssl.default_ssl_context()
    assert [kw["verify"] for kw in _RecordingClient.inits] == [shared, shared]
