"""Tests for the GIT_ASKPASS credential IPC skeleton (Phase A).

These tests exercise git_service.create_askpass_context() / resolve_credential()
directly, simulating what git_askpass_helper.py does over the wire with the
stdlib `socket` module -- they do not spawn the actual helper script or a real
git subprocess.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
from pathlib import Path

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
            # The script itself on POSIX, a `.cmd` launcher for it on Windows.
            assert Path(env["GIT_ASKPASS"]).stem == "git_askpass_helper"
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
            assert request_id not in git_service._credentials.pending
        finally:
            await cleanup()


@pytest.mark.asyncio
async def test_clone_and_fetch_only_prepare_a_pat_for_its_bound_https_host(monkeypatch, tmp_path):
    credential = {
        "username": "alice",
        "token": "never-print-this-token",
        "expected_host": "github.com",
    }
    rejected_clone = await git_service.clone_repo(
        "https://gitlab.com/acme/repo.git", str(tmp_path / "clone"), credential=credential
    )
    assert rejected_clone == {
        "ok": False,
        "path": "",
        "error": "credential destination rejected",
    }
    assert credential["token"] not in str(rejected_clone)

    calls: list[tuple[list[str], dict | None]] = []

    async def fake_run(argv, cwd, **_kwargs):
        assert cwd == str(tmp_path)
        if argv[:3] == ["git", "symbolic-ref", "--quiet"]:
            return 0, "main\n", ""
        if argv[:3] == ["git", "config", "--get"]:
            return 0, "origin\n", ""
        assert argv == ["git", "remote", "get-url", "origin"]
        return 0, "https://github.com/acme/repo.git\n", ""

    async def fake_run_with_timeout(argv, cwd, **kwargs):
        calls.append((argv, kwargs.get("env")))
        return 0, "updated", ""

    monkeypatch.setattr(git_service, "_run", fake_run)
    monkeypatch.setattr(git_service, "_run_with_timeout", fake_run_with_timeout)
    matched_fetch = await git_service.fetch(str(tmp_path), credential=credential)
    assert matched_fetch == {"ok": True, "output": "updated", "error": ""}
    assert calls[0][0] == ["git", "-c", "credential.helper=", "fetch", "--prune"]
    assert credential["token"] not in str(calls)

    async def alternate_host_run(argv, cwd, **_kwargs):
        if argv[:3] == ["git", "symbolic-ref", "--quiet"]:
            return 0, "main\n", ""
        if argv[:3] == ["git", "config", "--get"]:
            return 0, "origin\n", ""
        return 0, "https://git.example.test/acme/repo.git\n", ""

    monkeypatch.setattr(git_service, "_run", alternate_host_run)
    rejected_fetch = await git_service.fetch(str(tmp_path), credential=credential)
    assert rejected_fetch == {"ok": False, "output": "", "error": "credential destination rejected"}
    assert credential["token"] not in str(rejected_fetch)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("operation", "expected_argv"),
    [
        (git_service.fetch, ["git", "fetch", "--prune"]),
        (git_service.pull_only, ["git", "pull"]),
        (git_service.push_only, ["git", "push"]),
    ],
)
async def test_bound_account_leaves_ssh_remote_to_git_authentication(
    monkeypatch, tmp_path, operation, expected_argv
):
    credential = {"username": "alice", "token": "fixture-token", "expected_host": "github.com"}
    calls: list[tuple[list[str], dict | None]] = []

    async def fake_run(argv, _cwd, **_kwargs):
        if argv[:3] == ["git", "symbolic-ref", "--quiet"]:
            return 0, "main\n", ""
        if argv[:3] == ["git", "config", "--get"]:
            return 0, "origin\n", ""
        assert argv[:3] == ["git", "remote", "get-url"]
        return 0, "git@github.com:acme/repo.git\n", ""

    async def fake_run_with_timeout(argv, _cwd, **kwargs):
        calls.append((argv, kwargs.get("env")))
        return 0, "updated", ""

    monkeypatch.setattr(git_service, "_run", fake_run)
    monkeypatch.setattr(git_service, "_run_with_timeout", fake_run_with_timeout)

    result = await operation(str(tmp_path), credential=credential)

    assert result == {"ok": True, "output": "updated", "error": ""}
    assert calls == [(expected_argv, None)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("operation", "expected_argv"),
    [
        (git_service.fetch, ["git", "fetch", "--prune"]),
        (git_service.pull_only, ["git", "pull"]),
        (git_service.push_only, ["git", "push"]),
    ],
)
async def test_bound_account_without_a_remote_preserves_git_no_remote_failure(
    monkeypatch, tmp_path, operation, expected_argv
):
    credential = {"username": "alice", "token": "fixture-token", "expected_host": "github.com"}
    calls: list[tuple[list[str], dict | None]] = []

    async def fake_run(argv, _cwd, **_kwargs):
        if argv[:3] == ["git", "symbolic-ref", "--quiet"]:
            return 0, "main\n", ""
        if argv[:3] == ["git", "config", "--get"]:
            return 0, "origin\n", ""
        assert argv[:3] == ["git", "remote", "get-url"]
        return 2, "", "fatal: No such remote 'origin'\n"

    async def fake_run_with_timeout(argv, _cwd, **kwargs):
        calls.append((argv, kwargs.get("env")))
        return 128, "", "fatal: No such remote 'origin'\n"

    monkeypatch.setattr(git_service, "_run", fake_run)
    monkeypatch.setattr(git_service, "_run_with_timeout", fake_run_with_timeout)

    result = await operation(str(tmp_path), credential=credential)

    assert result == {"ok": False, "output": "fatal: No such remote 'origin'", "error": "fatal: No such remote 'origin'"}
    assert calls == [(expected_argv, None)]


class TestAskpassFailures:
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

    @pytest.mark.asyncio
    async def test_expected_host_rejects_unknown_or_mismatched_prompt_destinations(self):
        received: list[tuple[str, str]] = []

        async def on_request(request_id: str, prompt: str) -> None:
            received.append((request_id, prompt))

        env, cleanup = await git_service.create_askpass_context(
            on_request,
            expected_host="github.com",
        )
        try:
            loop = asyncio.get_running_loop()
            for prompt in [
                "Password for 'https://gitlab.com/acme/repo':",
                "Password:",
            ]:
                response = await loop.run_in_executor(
                    None,
                    _send_request,
                    int(env["NAVIDE_ASKPASS_PORT"]),
                    env["NAVIDE_ASKPASS_TOKEN"],
                    prompt,
                )
                assert response == {"value": None}
            assert received == []
        finally:
            await cleanup()


@pytest.mark.asyncio
async def test_the_askpass_entry_mode_answers_a_prompt_like_the_helper_does():
    """`<backend> --askpass-helper "<prompt>"` is what every launcher runs.

    The frozen builds have no interpreter to hand the `.py` to, so the helper
    is reached by re-entering this executable in that entry mode instead. It
    has to answer on stdout exactly like a directly exec'd helper, and it must
    reach the helper before anything the backend imports can print a line of
    its own -- git reads the first line of stdout as the credential.
    """
    received: list[str] = []

    async def on_request(request_id: str, prompt: str) -> None:
        received.append(prompt)
        git_service.resolve_credential(request_id, "s3cr3t-token")

    env, cleanup = await git_service.create_askpass_context(on_request)
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "agent_team_backend",
            "--askpass-helper",
            "Password for 'https://x':",
            env={**os.environ, **env},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
    finally:
        await cleanup()

    assert proc.returncode == 0
    assert stdout.splitlines()[0] == b"s3cr3t-token"
    assert received == ["Password for 'https://x':"]


# ── ssh prompts reach the same helper ────────────────────────────────────────

_posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX askpass trio; Windows keeps GIT_ASKPASS only")


class TestGitSubprocessEnv:
    def test_posix_routes_ssh_prompts_to_the_same_helper(self):
        from agent_team_backend.osplat import _darwin, _linux

        for impl in (_linux.paths, _darwin.paths):
            assert impl.git_subprocess_env("/state/ask.sh") == {
                "GIT_ASKPASS": "/state/ask.sh",
                "SSH_ASKPASS": "/state/ask.sh",
                "SSH_ASKPASS_REQUIRE": "force",
                "GIT_TERMINAL_PROMPT": "0",
            }

    def test_windows_keeps_git_askpass_only(self):
        from agent_team_backend.osplat import _windows

        assert _windows.paths.git_subprocess_env(r"C:\state\ask.cmd") == {"GIT_ASKPASS": r"C:\state\ask.cmd"}

    @pytest.mark.asyncio
    async def test_context_env_carries_the_platform_trio(self):
        from agent_team_backend.osplat import paths

        async def on_request(request_id: str, prompt: str) -> None:
            pass

        env, cleanup = await git_service.create_askpass_context(on_request)
        try:
            for key, value in paths.git_subprocess_env(env["GIT_ASKPASS"]).items():
                assert env[key] == value
        finally:
            await cleanup()

    @_posix_only
    def test_ssh_answers_a_passphrase_through_the_trio_with_no_tty(self, tmp_path):
        """The bug: ssh reads /dev/tty for a key passphrase and, with no tty and
        no display, ignores SSH_ASKPASS — so a push over ssh from the backend
        died with nothing to answer. With the trio, ssh-keygen (same
        read_passphrase as ssh) asks the helper instead."""
        import shutil
        import subprocess

        from agent_team_backend.osplat import _linux

        if shutil.which("ssh-keygen") is None:
            pytest.skip("no ssh-keygen on this machine")
        key = tmp_path / "id_ed25519"
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "pp-secret", "-f", str(key), "-C", "t"],
            check=True, timeout=30,
        )
        helper = tmp_path / "ask.sh"
        helper.write_text("#!/bin/sh\necho pp-secret\n")
        helper.chmod(0o755)
        base = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path)}

        with_trio = subprocess.run(
            ["ssh-keygen", "-y", "-f", str(key)],
            env={**base, **_linux.paths.git_subprocess_env(str(helper))},
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30,
        )
        assert with_trio.returncode == 0, with_trio.stderr
        assert with_trio.stdout.startswith("ssh-ed25519 ")

        # GIT_ASKPASS alone (what the env used to carry): ssh never consults it.
        # A new session so there is no controlling tty for ssh-keygen to fall
        # back to — from a developer's terminal it would otherwise sit on
        # /dev/tty waiting for someone to type.
        without = subprocess.run(
            ["ssh-keygen", "-y", "-f", str(key)],
            env={**base, "GIT_ASKPASS": str(helper)},
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30,
            start_new_session=True,
        )
        assert without.returncode != 0
