"""The conftest guard that keeps tests away from the developer's real CLIs.

`_no_real_claude_cli` once patched a re-export shim that nothing called
through, so a usage poll left unstubbed started the real Claude Code and read
the signed-in account. These pin both of its layers: the /usage read is refused
where `fetch_claude` looks it up, and a real agent CLI cannot be spawned at all
— and either one is recorded, so a caller that swallows the error still fails
the test.

To stand in for "installed outside the temp dir" without writing outside it,
each test clears the conftest's allowed temp roots, so a fake CLI under
`tmp_path` counts as a real one.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys

import pytest

from agent_team_backend.cli_vendors import claude as claude_vendor

pytestmark = pytest.mark.skipif(os.name == "nt", reason="the fake CLI is a shell script")


@pytest.fixture
def refused(_no_real_claude_cli, monkeypatch):
    """The guard's record; cleared at the end so the refusals these tests
    provoke on purpose do not fail them."""
    conftest = next(
        mod for name, mod in sys.modules.items()
        if name.endswith("conftest") and hasattr(mod, "_TEMP_ROOTS")
    )
    monkeypatch.setattr(conftest, "_TEMP_ROOTS", ())
    yield _no_real_claude_cli
    _no_real_claude_cli.clear()


@pytest.fixture
def fake_claude(tmp_path):
    """An executable named `claude` that leaves a mark when it runs."""
    mark = tmp_path / "ran"
    exe = tmp_path / "bin" / "claude"
    exe.parent.mkdir()
    exe.write_text(f"#!/bin/sh\necho ran > '{mark}'\n")
    exe.chmod(0o755)
    return exe, mark


def test_a_real_cli_cannot_be_spawned(refused, fake_claude) -> None:
    exe, mark = fake_claude

    with pytest.raises(PermissionError):
        subprocess.run([str(exe), "-p", "/usage"], check=False)

    assert not mark.exists()
    assert refused == [f"a real CLI spawn: {os.path.realpath(exe)}"]


def test_a_real_cli_found_on_path_cannot_be_spawned(refused, fake_claude) -> None:
    exe, mark = fake_claude

    with pytest.raises(PermissionError):
        subprocess.Popen(["claude", "-p", "/usage"], env={"PATH": str(exe.parent)})

    assert not mark.exists()
    assert len(refused) == 1


def test_a_real_cli_behind_an_interpreter_cannot_be_spawned(refused, fake_claude) -> None:
    exe, mark = fake_claude

    with pytest.raises(PermissionError):
        subprocess.run([sys.executable, str(exe)], check=False)

    assert not mark.exists()
    assert len(refused) == 1


async def test_an_asyncio_spawn_goes_through_the_same_guard(refused, fake_claude) -> None:
    exe, mark = fake_claude

    with pytest.raises(PermissionError):
        await asyncio.create_subprocess_exec(str(exe), "-p", "/usage")

    assert not mark.exists()
    assert len(refused) == 1


def test_a_fake_cli_under_the_temp_dir_still_runs(_no_real_claude_cli, fake_claude) -> None:
    exe, mark = fake_claude

    subprocess.run([str(exe)], check=True)

    assert mark.exists()
    assert _no_real_claude_cli == []


async def test_the_usage_read_is_refused_where_fetch_claude_looks_it_up(refused, tmp_path) -> None:
    with pytest.raises(AssertionError, match="real CLI"):
        await claude_vendor.fetch_claude(tmp_path)

    assert len(refused) == 1


async def test_a_poll_that_swallows_the_refusal_is_still_caught(refused, tmp_path) -> None:
    """The poll turns a failed read into an error snapshot, so raising alone
    would pass silently — the record is what fails such a test."""
    from agent_team_backend import usage_service as us

    svc = us.UsageService(cache_path=tmp_path / "usage-cache.json")
    for provider in us._CLI_VENDORS:
        svc._blocked_until[provider] = float("inf")

    await svc.poll_once(tmp_path)

    assert refused and "Claude /usage read" in refused[0]
