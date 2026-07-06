"""Tests for the GIT_ASKPASS credential IPC skeleton (Phase A).

These tests exercise git_service.create_askpass_context() / resolve_credential()
directly, simulating what git_askpass_helper.py does over the wire with the
stdlib `socket` module -- they do not spawn the actual helper script or a real
git subprocess.
"""
from __future__ import annotations

import asyncio
import json
import socket

import pytest

from agent_team_backend import git_service


def _send_request(port: int, token: str, prompt: str) -> dict:
    """Connect like the helper script would, send one JSON line, return the reply."""
    with socket.create_connection(("127.0.0.1", port), timeout=5.0) as sock:
        sock.sendall((json.dumps({"token": token, "prompt": prompt}) + "\n").encode("utf-8"))
        with sock.makefile("rb") as reader:
            line = reader.readline()
    return json.loads(line.decode("utf-8"))


class TestCreateAskpassContext:
    @pytest.mark.asyncio
    async def test_resolve_roundtrip(self):
        received: list[tuple[str, str]] = []

        async def on_request(request_id: str, prompt: str) -> None:
            received.append((request_id, prompt))

        env, cleanup = await git_service.create_askpass_context(on_request)
        try:
            assert env["GIT_ASKPASS"].endswith("git_askpass_helper.py")
            port = int(env["NAVIDE_ASKPASS_PORT"])
            token = env["NAVIDE_ASKPASS_TOKEN"]

            loop = asyncio.get_running_loop()
            response_future = loop.run_in_executor(
                None, _send_request, port, token, "Password for 'https://example.com':"
            )

            # Wait for the callback to fire so we can grab the request_id it was given.
            for _ in range(100):
                if received:
                    break
                await asyncio.sleep(0.01)
            assert received, "on_request callback was never invoked"
            request_id, prompt = received[0]
            assert prompt == "Password for 'https://example.com':"

            resolved = git_service.resolve_credential(request_id, "s3cr3t-token")
            assert resolved is True

            response = await response_future
            assert response == {"value": "s3cr3t-token"}
            # Pending entry must be cleaned up once resolved.
            assert request_id not in git_service._pending_credentials
        finally:
            await cleanup()

    @pytest.mark.asyncio
    async def test_timeout_returns_null_value(self):
        async def on_request(request_id: str, prompt: str) -> None:
            pass  # never call resolve_credential -> should hit the timeout path

        env, cleanup = await git_service.create_askpass_context(on_request, timeout=0.2)
        try:
            port = int(env["NAVIDE_ASKPASS_PORT"])
            token = env["NAVIDE_ASKPASS_TOKEN"]

            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(
                None, _send_request, port, token, "Username for 'https://example.com':"
            )
            assert response == {"value": None}
        finally:
            await cleanup()

    @pytest.mark.asyncio
    async def test_wrong_token_is_rejected(self):
        called = False

        async def on_request(request_id: str, prompt: str) -> None:
            nonlocal called
            called = True

        env, cleanup = await git_service.create_askpass_context(on_request)
        try:
            port = int(env["NAVIDE_ASKPASS_PORT"])

            loop = asyncio.get_running_loop()
            # Wrong token: server should close the connection without a response
            # and without ever invoking on_request.
            with pytest.raises(Exception):
                await loop.run_in_executor(
                    None, _send_request, port, "not-the-real-token", "Password:"
                )
            await asyncio.sleep(0.05)
            assert called is False
        finally:
            await cleanup()
