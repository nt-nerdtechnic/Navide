"""A generic binary name can belong to another vendor.

xAI's grok installs `~/.grok/bin/agent` — a symlink to itself — under the name
Cursor's CLI uses, and `grok 1.0.34 (...)` satisfies a plain version pattern.
Navide therefore reported grok as an installed Cursor CLI, spawned grok when a
Cursor pane was opened, and pointed "update Cursor CLI" at `agent update`,
which updates grok. These cover the three symptoms and the deliberate
fail-open: an unrecognised binary must never hide a CLI that is installed.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import replace

import pytest

from agent_team_backend import onboarding_deps, osplat
from agent_team_backend.cli_vendors.registry import VENDORS

CURSOR = VENDORS["cursor"].install_dep
GROK_BANNER = "grok 1.0.34 (3736acbc8658) [stable]\n"
CURSOR_BANNER = "2026.08.25-3e8eec8\n"


@pytest.fixture(autouse=True)
def _clear_identity_cache():
    onboarding_deps._IDENTITY_CACHE.clear()
    yield
    onboarding_deps._IDENTITY_CACHE.clear()


def _on_path(monkeypatch, paths: dict[str, str]) -> None:
    monkeypatch.setattr(
        osplat.paths, "resolve_program", lambda name, path=None: paths.get(name)
    )


def _prints(monkeypatch, output_by_path: dict[str, str], calls: list | None = None):
    def fake_run(argv, **kwargs):
        if calls is not None:
            calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, output_by_path[argv[0]], "")

    monkeypatch.setattr(onboarding_deps.subprocess, "run", fake_run)


def test_grok_squatting_agent_does_not_become_cursor(monkeypatch) -> None:
    """The bug itself: both names resolve, `agent` is grok, so the alternate wins."""
    _on_path(monkeypatch, {"agent": "/g/bin/agent", "cursor-agent": "/c/bin/cursor-agent"})
    _prints(monkeypatch, {"/g/bin/agent": GROK_BANNER, "/c/bin/cursor-agent": CURSOR_BANNER})

    assert onboarding_deps.resolve_executable(CURSOR) == "/c/bin/cursor-agent"


def test_the_real_agent_is_still_preferred(monkeypatch) -> None:
    """Cursor's own `agent` identifies, so the rename is honoured as before."""
    _on_path(monkeypatch, {"agent": "/c/bin/agent", "cursor-agent": "/c/bin/cursor-agent"})
    _prints(monkeypatch, {"/c/bin/agent": CURSOR_BANNER})

    assert onboarding_deps.resolve_executable(CURSOR) == "/c/bin/agent"


def test_unrecognised_output_still_resolves(monkeypatch) -> None:
    """Fail-open: if the vendor changes its banner and nothing identifies, the
    first name that resolved is returned. Hiding an installed CLI behind a
    probe is worse than the ambiguity the probe exists to settle."""
    _on_path(monkeypatch, {"agent": "/c/bin/agent"})
    _prints(monkeypatch, {"/c/bin/agent": "Cursor Agent, build 42\n"})

    assert onboarding_deps.resolve_executable(CURSOR) == "/c/bin/agent"


def test_probe_failure_does_not_hide_the_binary(monkeypatch) -> None:
    _on_path(monkeypatch, {"agent": "/c/bin/agent"})

    def explode(argv, **kwargs):
        raise OSError("cannot exec")

    monkeypatch.setattr(onboarding_deps.subprocess, "run", explode)

    assert onboarding_deps.resolve_executable(CURSOR) == "/c/bin/agent"


def test_deps_without_an_identity_regex_never_spawn_a_probe(monkeypatch) -> None:
    """Every other dep keeps the old zero-subprocess path."""
    calls: list = []
    _on_path(monkeypatch, {"claude": "/c/bin/claude"})
    _prints(monkeypatch, {"/c/bin/claude": "anything"}, calls)

    claude = VENDORS["claude"].install_dep
    assert claude.identity_regex == ""
    assert onboarding_deps.resolve_executable(claude) == "/c/bin/claude"
    assert calls == []


def test_identity_answer_is_cached_per_path(monkeypatch) -> None:
    calls: list = []
    _on_path(monkeypatch, {"agent": "/g/bin/agent", "cursor-agent": "/c/bin/cursor-agent"})
    _prints(monkeypatch, {"/g/bin/agent": GROK_BANNER, "/c/bin/cursor-agent": CURSOR_BANNER}, calls)

    for _ in range(3):
        assert onboarding_deps.resolve_executable(CURSOR) == "/c/bin/cursor-agent"
    assert len(calls) == 2, "one probe per distinct path, not per call"


def test_grok_banner_cannot_pass_as_a_cursor_version() -> None:
    """The version pattern is anchored, so the squatter's own version number
    cannot be displayed as Cursor's."""
    assert re.search(CURSOR.version_regex, GROK_BANNER) is None
    match = re.search(CURSOR.version_regex, CURSOR_BANNER)
    assert match is not None and match.group(1) == "2026.08.25"


def test_update_runs_the_binary_that_was_detected(monkeypatch) -> None:
    """`agent update` on a grok machine updates grok. The maintenance command
    must name the binary detection actually resolved."""
    _on_path(monkeypatch, {"agent": "/g/bin/agent", "cursor-agent": "/c/bin/cursor-agent"})
    _prints(monkeypatch, {"/g/bin/agent": GROK_BANNER, "/c/bin/cursor-agent": CURSOR_BANNER})

    result = onboarding_deps.maintenance_command("cursor", "update")

    assert result["ok"] is True
    assert result["command"] == "/c/bin/cursor-agent update"


def test_maintenance_leaves_a_command_it_does_not_own_alone(monkeypatch) -> None:
    """Only the leading token, and only when it is one of this dep's names."""
    dep = replace(CURSOR, update_cmd="npm install -g cursor")
    _on_path(monkeypatch, {"cursor-agent": "/c/bin/cursor-agent"})
    _prints(monkeypatch, {"/c/bin/cursor-agent": CURSOR_BANNER})

    assert onboarding_deps._command_on_the_resolved_binary(dep, dep.update_cmd) == (
        "npm install -g cursor"
    )
