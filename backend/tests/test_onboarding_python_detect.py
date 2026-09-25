"""Python detection accepts any installed Python meeting min_version.

Nothing Navide runs needs `python3` on PATH to be new: the packaged backend is
frozen, dev runs under uv's venv, and the curl-less hook fallback runs on any
Python 3. So a Mac whose `python3` is Xcode's 3.9.6 but which has Homebrew's
python@3.13 (only `python3.13` linked) or an unlinked python@3.14 keg must not
be blocked at the wizard's foundation step.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from agent_team_backend import onboarding_deps
from agent_team_backend.onboarding_deps import DEPS_BY_ID, detect_dep

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="fake interpreters are /bin/sh scripts"
)


def _fake_python(directory: Path, name: str, version: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    exe = directory / name
    exe.write_text(f"#!/bin/sh\necho 'Python {version}'\n")
    exe.chmod(0o755)
    return exe


@pytest.fixture
def no_homebrew_opt(monkeypatch, tmp_path):
    root = tmp_path / "opt"
    monkeypatch.setattr(onboarding_deps, "_HOMEBREW_OPT_ROOTS", (str(root),))
    return root


def test_versioned_python_on_path_is_accepted(monkeypatch, tmp_path, no_homebrew_opt):
    system = tmp_path / "usr-bin"
    brew = tmp_path / "brew-bin"
    _fake_python(system, "python3", "3.9.6")
    newer = _fake_python(brew, "python3.13", "3.13.5")
    monkeypatch.setenv("PATH", f"{system}:{brew}")
    result = detect_dep(DEPS_BY_ID["python"])
    assert result["status"] == "ok"
    assert result["version"] == "3.13.5"
    assert result["binary_path"] == str(newer)


def test_unlinked_homebrew_keg_is_accepted(monkeypatch, tmp_path, no_homebrew_opt):
    system = tmp_path / "usr-bin"
    _fake_python(system, "python3", "3.9.6")
    keg = _fake_python(no_homebrew_opt / "python@3.14" / "bin", "python3", "3.14.7")
    monkeypatch.setenv("PATH", str(system))
    result = detect_dep(DEPS_BY_ID["python"])
    assert result["status"] == "ok"
    assert result["version"] == "3.14.7"
    assert result["binary_path"] == str(keg)


def test_newest_suitable_python_wins(monkeypatch, tmp_path, no_homebrew_opt):
    brew = tmp_path / "brew-bin"
    _fake_python(tmp_path / "usr-bin", "python3", "3.9.6")
    _fake_python(brew, "python3.12", "3.12.11")
    newest = _fake_python(brew, "python3.13", "3.13.5")
    monkeypatch.setenv("PATH", f"{tmp_path / 'usr-bin'}:{brew}")
    assert detect_dep(DEPS_BY_ID["python"])["binary_path"] == str(newest)


def test_python_missing_as_python3_but_present_versioned(monkeypatch, tmp_path, no_homebrew_opt):
    brew = tmp_path / "brew-bin"
    newer = _fake_python(brew, "python3.12", "3.12.11")
    monkeypatch.setenv("PATH", str(brew))
    result = detect_dep(DEPS_BY_ID["python"])
    assert result["status"] == "ok"
    assert result["binary_path"] == str(newer)


def test_only_old_pythons_still_reads_outdated(monkeypatch, tmp_path, no_homebrew_opt):
    system = tmp_path / "usr-bin"
    old = _fake_python(system, "python3", "3.9.6")
    _fake_python(system, "python3.11", "3.11.9")
    monkeypatch.setenv("PATH", str(system))
    result = detect_dep(DEPS_BY_ID["python"])
    assert result["status"] == "outdated"
    # The version and path reported are still the `python3` the user types.
    assert result["version"] == "3.9.6"
    assert result["binary_path"] == str(old)


def test_quick_pass_does_not_probe_versioned_pythons(monkeypatch, tmp_path, no_homebrew_opt):
    """quick_status promises no subprocess; a missing `python3` stays missing
    there until the full pass grades the versioned ones."""
    brew = tmp_path / "brew-bin"
    _fake_python(brew, "python3.13", "3.13.5")
    monkeypatch.setenv("PATH", str(brew))
    assert detect_dep(DEPS_BY_ID["python"], quick=True)["status"] == "missing"
