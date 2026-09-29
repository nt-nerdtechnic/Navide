"""Vendor SPEC → create handler → actual PTY spawn → external transport peer."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

import httpx
import pytest

from agent_team_backend import osplat
from .support.backend_process import BackendProcess

pytestmark = [pytest.mark.cli_regression, pytest.mark.cli_vendor, pytest.mark.asyncio]


def _install(backend: BackendProcess, vendor: str) -> list[str]:
    """Install a named external stand-in; preserve all production spawn wiring."""
    script = Path(__file__).parent / "support" / "vendor_transport.py"
    arguments = [sys.executable, "-u", str(script), vendor, str(backend.root)]
    executable = backend.root / (f"{vendor}.cmd" if os.name == "nt" else vendor)
    if os.name == "nt":
        executable.write_text("@echo off\r\n" + subprocess.list2cmdline(arguments) + " %*\r\n", encoding="utf-8")
    else:
        executable.write_text("#!/bin/sh\nexec " + shlex.join(arguments) + ' "$@"\n', encoding="utf-8")
        executable.chmod(0o700)
    return osplat.paths.shell_command(osplat.paths.quote_arg(str(executable)))


def _records(backend: BackendProcess, vendor: str) -> list[dict]:
    path = backend.root / f"{vendor}.jsonl"
    if not path.exists():
        return []
    # Ignore an incomplete trailing write while the external peer is running.
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines(keepends=True) if line.endswith("\n")]


async def _spawn(backend, ws, vendor, command, **kwargs):
    created = await backend.create(ws, pane_id=vendor, agent_key=vendor, command=command, **kwargs)
    await backend.expect_output(ws, created["terminal_session_id"], "TRANSPORT_READY")
    return created


@pytest.mark.parametrize("vendor", ["opencode", "kilo"])
async def test_http_spawn_delivery(tmp_path, vendor):
    backend = BackendProcess(tmp_path)
    command = _install(backend, vendor)
    async with backend, backend.connect() as ws:
        await _spawn(backend, ws, vendor, command)
        startup = _records(backend, vendor)[0]
        assert startup["password"] is (vendor == "kilo")
        assert startup["opencode_password"] is False
        response = await backend.request(ws, "agent_msg.push", {"pane_id": vendor, "text": "first\nmessage"})
        assert response["payload"] == {"ok": True, "kind": "tui-http", "reason": "", "unclear": False}
        http = [r for r in _records(backend, vendor) if r["kind"] == "http"]
        assert [r["path"] for r in http] == ["/tui/append-prompt", "/tui/submit-prompt"]
        assert http[0]["body"] == {"text": "first\nmessage"}
        assert http[1]["submitted"] == "first\nmessage"
        assert http[1]["composer"] == ""
        assert all(r["authorized"] and r["has_auth"] is (vendor == "kilo") for r in http)
        # A rejected submit must clear the actual peer's composer before the
        # caller is told a typed fallback is safe.
        (tmp_path / "reject-submit").touch()
        failed = await backend.request(ws, "agent_msg.push", {"pane_id": vendor, "text": "retry"})
        assert failed["payload"] == {"ok": False, "kind": "tui-http", "reason": "submit-500/cleared", "unclear": False}
        http = [r for r in _records(backend, vendor) if r["kind"] == "http"]
        assert [r["path"] for r in http[-3:]] == ["/tui/append-prompt", "/tui/submit-prompt", "/tui/clear-prompt"]
        assert [r["composer"] for r in http[-3:]] == ["retry", "retry", ""]
        assert all(r["submitted"] == "" for r in http[-3:])
        assert all(r["authorized"] for r in http)


async def test_qwen_spawn_file_delivery(tmp_path):
    backend = BackendProcess(tmp_path)
    command = _install(backend, "qwen")
    async with backend, backend.connect() as ws:
        await _spawn(backend, ws, "qwen", command)
        assert {"kind": "watch", "empty": True} in _records(backend, "qwen")
        envelope = "[Navide MSG] from: fixture\nUnicode: 測試\nthird line"
        response = await backend.request(ws, "agent_msg.push", {"pane_id": "qwen", "text": envelope})
        assert response["payload"] == {"ok": True, "kind": "input-file", "reason": "", "unclear": False}
        async with asyncio.timeout(10):
            while not any(r["kind"] == "file" for r in _records(backend, "qwen")):
                await asyncio.sleep(0.01)
        assert [r["value"] for r in _records(backend, "qwen") if r["kind"] == "file"] == [
            {"type": "submit", "text": envelope},
        ]


@pytest.mark.parametrize("vendor,expected", [("codex", 27), ("mcode", 3)])
async def test_interrupt_reaches_vendor_process(tmp_path, vendor, expected):
    backend = BackendProcess(tmp_path)
    command = _install(backend, vendor)
    async with backend, backend.connect() as ws:
        created = await _spawn(backend, ws, vendor, command)
        await backend.request(ws, "terminal.interrupt", {"terminal_session_id": created["terminal_session_id"]})
        await backend.expect_output(ws, created["terminal_session_id"], f"INTERRUPT_{expected}")
        assert {"kind": "interrupt", "value": expected} in _records(backend, vendor)


@pytest.mark.parametrize("vendor,expected", [
    ("claude", ["auth", "login"]), ("codex", ["login"]),
    ("muse", ["login"]),
], ids=["claude", "codex", "muse"])
async def test_login_subcommand_excludes_repl_wiring(tmp_path, vendor, expected):
    backend = BackendProcess(tmp_path)
    command = _install(backend, vendor)
    command[-1] += " --fixture-repl-only"
    async with backend, backend.connect() as ws:
        await _spawn(backend, ws, vendor, command, is_login=True)
        # Exact received argv catches MCP, skills, push and ordinary REPL flags
        # accidentally appended after production rewrote the login command.
        assert _records(backend, vendor)[0]["argv"] == expected
        response = await backend.request(ws, "agent_msg.push", {"pane_id": vendor, "text": "must not deliver"})
        assert response["payload"]["ok"] is False
        assert response["payload"]["reason"] == "no-channel"


@pytest.mark.parametrize("vendor", ["opencode", "kilo"])
async def test_managed_login_rejects_unverifiable_command(tmp_path, vendor):
    backend = BackendProcess(tmp_path)
    command = _install(backend, vendor)
    async with backend, backend.connect() as ws:
        response = await backend.request(ws, "terminal.create", {
            "pane_id": vendor, "agent_key": vendor, "command": command,
            "cwd": str(tmp_path), "is_login": True,
        }, ok=False)
        assert response["ok"] is False
        assert response["error"]["code"] == "CREDENTIAL_STORE_UNVERIFIED"
        assert _records(backend, vendor) == []


async def test_claude_spawn_authenticated_rewake_delivery(tmp_path):
    backend = BackendProcess(tmp_path)
    command = _install(backend, "claude")
    async with backend, backend.connect() as ws:
        await _spawn(backend, ws, "claude", command,
                     metadata={"explicit_session_id": "claude-regression-session"})
        base_url = backend.url.replace("ws://", "http://").split("/ws?", 1)[0]
        header, value = (tmp_path / "data" / "hook-auth").read_text().strip().split(": ", 1)
        async with httpx.AsyncClient(base_url=base_url, timeout=15, trust_env=False) as client:
            denied = await client.post("/hooks/claude/rewake", json={"session_id": "claude-regression-session"})
            assert denied.status_code == 403
            waiting = asyncio.create_task(client.post("/hooks/claude/rewake",
                headers={header: value}, json={"session_id": "claude-regression-session"}))
            try:
                async with asyncio.timeout(10):
                    while True:
                        event = await backend.receive(ws)
                        if event and event.get("type") == "agent_msg.push_state" and event["payload"].get("ready"):
                            assert event["payload"]["pane_id"] == "claude"
                            break
                envelope = "[Navide MSG] wake the attributed pane"
                response = await backend.request(ws, "agent_msg.push", {"pane_id": "claude", "text": envelope})
                assert response["payload"]["ok"] is True
                answer = await waiting
                assert answer.status_code == 200
                assert answer.text.startswith("[Navide] A message from another agent")
                assert answer.text.endswith("\n" + envelope)
                again = await backend.request(ws, "agent_msg.push", {"pane_id": "claude", "text": "second"})
                assert again["payload"]["ok"] is False
                assert again["payload"]["reason"] == "not-armed"
            finally:
                waiting.cancel()
                await asyncio.gather(waiting, return_exceptions=True)
