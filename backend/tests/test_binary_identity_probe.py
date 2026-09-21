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


# ── CLI health guide: the same squatter must not read as a duplicate install ──


def _cursor_status(resolved: str) -> dict:
    return {
        "id": "cursor", "status": "ok", "version": "2026.08.25",
        "binary_path": resolved, "resolved_path": resolved,
        "exit_code": 0, "signal": "", "duration_ms": 42,
    }


def _agents_on_path(monkeypatch, *paths: str) -> None:
    """Only the `agent` name resolves; every other CLI is absent."""
    monkeypatch.setattr(onboarding_deps, "_distinct_executables", lambda command: [
        {"path": p, "resolved_path": p, "aliases": [p]} for p in paths
    ] if command == "agent" else [])


def _two_agents_on_path(monkeypatch) -> None:
    _agents_on_path(monkeypatch, "/g/bin/agent", "/c/bin/agent")
    monkeypatch.setattr(onboarding_deps, "_dismissed_cli_health_fingerprint", lambda: "")


def test_health_guide_does_not_list_grok_as_a_second_cursor_install(monkeypatch) -> None:
    """Fourth symptom: with grok's `agent` and Cursor's `agent` both on PATH,
    the health guide reported "multiple installs" of Cursor CLI on every launch
    and offered to switch Navide onto grok. The primary is not re-probed; the
    alternate is, and a banner that does not identify drops it."""
    _two_agents_on_path(monkeypatch)
    _prints(monkeypatch, {"/g/bin/agent": GROK_BANNER})

    health = onboarding_deps.build_cli_health([_cursor_status("/c/bin/agent")])

    cursor_entry = next(e for e in health["entries"] if e["agent_key"] == "cursor")
    assert [c["resolved_path"] for c in cursor_entry["candidates"]] == ["/c/bin/agent"]
    assert [f for f in health["findings"] if f["agent_key"] == "cursor"] == []


def test_health_guide_still_reports_a_real_second_cursor_install(monkeypatch) -> None:
    _two_agents_on_path(monkeypatch)
    _prints(monkeypatch, {"/g/bin/agent": CURSOR_BANNER})

    health = onboarding_deps.build_cli_health([_cursor_status("/c/bin/agent")])

    duplicate = next(f for f in health["findings"] if f["type"] == "duplicate_install")
    assert sorted(c["resolved_path"] for c in duplicate["candidates"]) == [
        "/c/bin/agent", "/g/bin/agent",
    ]


def test_health_fingerprint_survives_a_probe_that_flips(monkeypatch) -> None:
    """A dismissal is keyed by the fingerprint; the alternate's `--version`
    runs under a 3s ceiling and a loaded cold start can time it out. That
    changed the fingerprint and brought the dismissed guide back on the next
    launch. Same binaries, different probe outcome: same fingerprint."""
    _two_agents_on_path(monkeypatch)
    _prints(monkeypatch, {"/g/bin/agent": CURSOR_BANNER})

    def probe(_dep, _path, outcome):
        return outcome

    ok = {"version": "2026.08.20", "status": "ok", "exit_code": 0, "signal": "", "duration_ms": 10}
    timed_out = {"version": "", "status": "failed", "exit_code": None, "signal": "", "duration_ms": 3000}

    monkeypatch.setattr(onboarding_deps, "_probe_alternate", lambda d, p: probe(d, p, ok))
    first = onboarding_deps.build_cli_health([_cursor_status("/c/bin/agent")])
    monkeypatch.setattr(onboarding_deps, "_probe_alternate", lambda d, p: probe(d, p, timed_out))
    second = onboarding_deps.build_cli_health([_cursor_status("/c/bin/agent")])

    assert first["fingerprint"] and first["fingerprint"] == second["fingerprint"]
    # A different binary set is a different finding, and is not covered.
    _agents_on_path(monkeypatch, "/c/bin/agent", "/n/bin/agent")
    _prints(monkeypatch, {"/n/bin/agent": CURSOR_BANNER})
    third = onboarding_deps.build_cli_health([_cursor_status("/c/bin/agent")])
    assert third["fingerprint"] != first["fingerprint"]
