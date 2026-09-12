"""Tests for _refresh_path_from_login_shell() in onboarding_deps."""

from __future__ import annotations

import os
import shutil
import sys
from unittest.mock import patch, MagicMock
import subprocess

import pytest

# Import the private function directly for unit testing
from pathlib import Path

from agent_team_backend import osplat
from agent_team_backend import onboarding_deps
from agent_team_backend.osplat import _darwin, _linux, _posix_paths, _windows
from agent_team_backend.onboarding_deps import (
    _path_probe_command,
    _refresh_path_from_login_shell,
    get_status,
)


# ── helpers ──────────────────────────────────────────────────────────────────

# The login-shell probe is a POSIX seam: osplat answers None on Windows by
# design (PATH comes from the registry), so the refresh is a no-op there.
_needs_login_shell_probe = pytest.mark.skipif(
    osplat.paths.login_path_probe() is None,
    reason="login-shell PATH probe is None on this platform (Windows) by design",
)


@pytest.fixture(autouse=True)
def _reset_path_probe_cache(monkeypatch):
    """Each test assumes its call actually probes — clear the TTL cache."""
    monkeypatch.setattr(onboarding_deps, "_path_refreshed_at", None)


MARKER = osplat.spec.LOGIN_PATH_MARKER


def _make_run_result(stdout: str, returncode: int = 0) -> MagicMock:
    result = MagicMock()
    result.stdout = stdout
    result.returncode = returncode
    return result


def _probe_output(path: str, *chatter: str) -> str:
    """What the marker probe prints: rc-file chatter, then the marked PATH."""
    return "".join(f"{line}\n" for line in chatter) + f"{MARKER}{path}\n"


def _no_fallbacks(monkeypatch) -> None:
    monkeypatch.setattr(osplat.paths, "login_path_fallbacks", lambda home: [])


def _fallbacks(monkeypatch, *dirs) -> None:
    monkeypatch.setattr(osplat.paths, "login_path_fallbacks", lambda home: list(dirs))


# ── merge order ──────────────────────────────────────────────────────────────


@_needs_login_shell_probe
def test_new_paths_prepended(monkeypatch):
    """Paths returned by the shell that are absent from PATH should be prepended."""
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    shell_path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    with patch("subprocess.run", return_value=_make_run_result(_probe_output(shell_path))):
        _refresh_path_from_login_shell()
    parts = os.environ["PATH"].split(":")
    assert parts[0] == "/opt/homebrew/bin"
    assert parts[1] == "/usr/local/bin"
    # original paths preserved after new ones
    assert "/usr/bin" in parts
    assert "/bin" in parts


def test_existing_paths_not_duplicated(monkeypatch):
    """Paths already in PATH must not appear twice after refresh."""
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    shell_path = "/usr/bin:/bin"
    with patch("subprocess.run", return_value=_make_run_result(_probe_output(shell_path))):
        _refresh_path_from_login_shell()
    parts = os.environ["PATH"].split(":")
    assert parts.count("/usr/bin") == 1
    assert parts.count("/bin") == 1


# ── dedup ─────────────────────────────────────────────────────────────────────


@_needs_login_shell_probe
def test_dedup_within_shell_output(monkeypatch):
    """Even if shell output contains duplicates, only first occurrence is added."""
    monkeypatch.setenv("PATH", "/usr/bin")
    shell_path = "/new/path:/new/path:/usr/bin"
    with patch("subprocess.run", return_value=_make_run_result(_probe_output(shell_path))):
        _refresh_path_from_login_shell()
    parts = os.environ["PATH"].split(":")
    assert parts.count("/new/path") == 1


# ── timeout / garbage tolerance ───────────────────────────────────────────────


def test_timeout_swallowed(monkeypatch):
    """TimeoutExpired must not propagate; PATH unchanged (fallback disabled)."""
    _no_fallbacks(monkeypatch)
    original = "/usr/bin:/bin"
    monkeypatch.setenv("PATH", original)
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="bash", timeout=3)):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == original


def test_oserror_swallowed(monkeypatch):
    """OSError (e.g. bash not found) must not propagate."""
    _no_fallbacks(monkeypatch)
    original = "/usr/bin:/bin"
    monkeypatch.setenv("PATH", original)
    with patch("subprocess.run", side_effect=OSError("not found")):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == original


def test_unmarked_output_adds_nothing(monkeypatch):
    """Output with no marked line is chatter, not a PATH: nothing is merged."""
    _no_fallbacks(monkeypatch)
    monkeypatch.setenv("PATH", "/usr/bin")
    with patch("subprocess.run", return_value=_make_run_result("some banner text\n/looks/like/a/path\n")):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == "/usr/bin"


def test_empty_stdout_no_crash(monkeypatch):
    """Empty stdout must not crash."""
    _no_fallbacks(monkeypatch)
    original = "/usr/bin"
    monkeypatch.setenv("PATH", original)
    with patch("subprocess.run", return_value=_make_run_result("")):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == original


# ── fallback install prefixes ────────────────────────────────────────────────


@_needs_login_shell_probe
def test_fallback_dirs_merged_when_probe_fails(monkeypatch, tmp_path):
    """Standard install prefixes are merged even when the login-shell probe fails."""
    fallback = tmp_path / "brew-bin"
    fallback.mkdir()
    _fallbacks(monkeypatch, str(fallback))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="zsh", timeout=3)):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"].split(":")[0] == str(fallback)


def test_fallback_dir_skipped_when_missing(monkeypatch, tmp_path):
    """A fallback prefix that does not exist on disk is not added."""
    _fallbacks(monkeypatch, str(tmp_path / "nope"))
    original = "/usr/bin:/bin"
    monkeypatch.setenv("PATH", original)
    with patch("subprocess.run", side_effect=OSError("not found")):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == original


@_needs_login_shell_probe
def test_shell_paths_ordered_before_fallback(monkeypatch, tmp_path):
    """Shell-derived paths are prepended ahead of fallback prefixes."""
    fallback = tmp_path / "fb"
    fallback.mkdir()
    _fallbacks(monkeypatch, str(fallback))
    monkeypatch.setenv("PATH", "/usr/bin")
    with patch("subprocess.run", return_value=_make_run_result(_probe_output("/shell/bin:/usr/bin"))):
        _refresh_path_from_login_shell()
    parts = os.environ["PATH"].split(":")
    assert parts[0] == "/shell/bin"
    assert parts[1] == str(fallback)


@_needs_login_shell_probe
def test_marked_line_used_whatever_the_rc_files_print(monkeypatch):
    """The marked line is the PATH even when chatter comes before AND after
    it — an interactive bash on Linux prints its motd last, which is exactly
    what taking "the last non-empty line" used to merge into PATH."""
    _no_fallbacks(monkeypatch)
    monkeypatch.setenv("PATH", "/usr/bin")
    output = _probe_output("/opt/homebrew/bin:/usr/bin", "Welcome to zsh!") + "motd: 3 updates\n"
    with patch("subprocess.run", return_value=_make_run_result(output)):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"].split(":") == ["/opt/homebrew/bin", "/usr/bin"]


# ── probe command shape ───────────────────────────────────────────────────────


SCRIPT = _posix_paths.LOGIN_PATH_PROBE_SCRIPT


@_needs_login_shell_probe
def test_probe_uses_interactive_zsh(monkeypatch):
    """zsh reads ~/.zshrc only in interactive mode; installers (e.g. grok)
    write PATH exports there, so the probe must run zsh with -i."""
    monkeypatch.setenv("SHELL", "/bin/zsh")
    assert _path_probe_command() == ["/bin/zsh", "-ilc", SCRIPT]


def test_linux_probes_bash_interactively(monkeypatch):
    """The stock Debian/Ubuntu ~/.bashrc — where nvm, bun and npm-global put
    their PATH exports — returns at its first line unless the shell is
    interactive, so `bash -lc` sees ~/.profile and nothing else."""
    monkeypatch.setenv("SHELL", "/bin/bash")
    assert _linux.paths.login_path_probe() == ["/bin/bash", "-ilc", SCRIPT]


def test_macos_keeps_a_plain_login_bash(monkeypatch):
    monkeypatch.setenv("SHELL", "/bin/bash")
    assert _darwin.paths.login_path_probe() == ["/bin/bash", "-lc", SCRIPT]


def test_other_shells_get_a_plain_login_shell_everywhere(monkeypatch):
    monkeypatch.setenv("SHELL", "/usr/bin/fish")
    assert _linux.paths.login_path_probe() == ["/usr/bin/fish", "-lc", SCRIPT]
    assert _darwin.paths.login_path_probe() == ["/usr/bin/fish", "-lc", SCRIPT]


@_needs_login_shell_probe
def test_probe_falls_back_to_bash_without_shell_env(monkeypatch):
    monkeypatch.delenv("SHELL", raising=False)
    assert _path_probe_command()[0] == "/bin/bash"
    assert _path_probe_command()[-1] == SCRIPT


@_needs_login_shell_probe
def test_probe_script_marks_the_path_line():
    """The script prints the marker and PATH on ONE line, so the parser can
    pick it out of whatever the rc files printed around it."""
    proc = subprocess.run(["/bin/sh", "-c", SCRIPT], capture_output=True, text=True,
                          env={"PATH": "/a:/b"}, timeout=5)
    assert proc.stdout == f"{MARKER}/a:/b\n"


# ── fallback lists per platform ──────────────────────────────────────────────


def test_linux_fallbacks_name_the_node_manager_and_toolchain_dirs(tmp_path):
    """A .desktop-launched app on Linux gets the session PATH, which has none
    of these; nvm's per-version bins come newest first."""
    for v in ("v18.20.4", "v22.11.0", "v20.19.0"):
        (tmp_path / ".nvm" / "versions" / "node" / v / "bin").mkdir(parents=True)
    dirs = _linux.paths.login_path_fallbacks(tmp_path)
    assert dirs == [
        str(tmp_path / ".local" / "bin"),
        str(tmp_path / ".local" / "share" / "pnpm"),
        str(tmp_path / ".npm-global" / "bin"),
        str(tmp_path / ".cargo" / "bin"),
        str(tmp_path / ".bun" / "bin"),
        str(tmp_path / ".nvm" / "versions" / "node" / "v22.11.0" / "bin"),
        str(tmp_path / ".nvm" / "versions" / "node" / "v20.19.0" / "bin"),
        str(tmp_path / ".nvm" / "versions" / "node" / "v18.20.4" / "bin"),
        "/usr/local/bin",
        "/snap/bin",
    ]


def test_linux_fallbacks_without_nvm(tmp_path):
    dirs = _linux.paths.login_path_fallbacks(tmp_path)
    assert not any(".nvm" in d for d in dirs)
    assert "/snap/bin" in dirs


def test_macos_fallbacks_are_the_homebrew_prefixes(tmp_path):
    assert _darwin.paths.login_path_fallbacks(tmp_path) == [
        str(tmp_path / ".local" / "bin"),
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
    ]


def test_windows_has_no_fallbacks(tmp_path):
    assert _windows.paths.login_path_fallbacks(tmp_path) == []


def test_refresh_asks_the_platform_for_its_fallbacks(monkeypatch, tmp_path):
    """The merge goes through the seam, not a module-level tuple."""
    fallback = tmp_path / "platform-bin"
    fallback.mkdir()
    seen: list = []

    def fallbacks(home):
        seen.append(home)
        return [str(fallback)]

    monkeypatch.setattr(osplat.paths, "login_path_fallbacks", fallbacks)
    monkeypatch.setattr(osplat.paths, "login_path_probe", lambda: ["/bin/sh", "-c", "true"])
    monkeypatch.setenv("PATH", "/usr/bin")
    with patch("subprocess.run", return_value=_make_run_result("")):
        _refresh_path_from_login_shell()
    assert seen == [Path.home()]
    assert os.environ["PATH"].split(os.pathsep)[0] == str(fallback)


# ── non-POSIX no-op ───────────────────────────────────────────────────────────


def test_non_posix_noop(monkeypatch):
    """On non-POSIX platforms the function should be a no-op (no subprocess call)."""
    original = "/usr/bin"
    monkeypatch.setenv("PATH", original)
    # No login shell to ask: what the Windows paths implementation answers.
    monkeypatch.setattr(osplat.paths, "login_path_probe", lambda: None)
    with patch("subprocess.run") as mock_run:
        _refresh_path_from_login_shell()
    mock_run.assert_not_called()
    assert os.environ["PATH"] == original


# ── detection missing → ok after refresh ─────────────────────────────────────


@_needs_login_shell_probe
def test_detection_missing_to_ok_after_refresh(monkeypatch, tmp_path):
    """
    Simulate a tool that is absent from the original PATH but present in the
    login-shell PATH. After refresh, detect_dep should find it as 'ok'.
    """
    from agent_team_backend.onboarding_deps import detect_dep, Dep

    # Create a fake 'mytool' binary that prints a version string
    fake_bin = tmp_path / "mytool"
    fake_bin.write_text("#!/bin/sh\necho 'mytool 1.2.3'\n")
    fake_bin.chmod(0o755)

    dep = Dep(
        id="mytool",
        label="My Tool",
        description="test tool",
        group="foundation",
        check_cmd=["mytool", "--version"],
        version_regex=r"(\d+\.\d+\.\d+)",
    )

    # Before refresh: tmp_path is not in PATH, so tool is missing
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    assert shutil.which("mytool") is None
    result_before = detect_dep(dep)
    assert result_before["status"] == "missing"

    # Simulate login shell returning a PATH that includes tmp_path
    shell_path_output = _probe_output(f"{tmp_path}:/usr/bin:/bin")
    with patch("subprocess.run", return_value=_make_run_result(shell_path_output)):
        _refresh_path_from_login_shell()

    # After refresh: tmp_path is now in os.environ["PATH"]
    assert str(tmp_path) in os.environ["PATH"].split(":")

    # detect_dep uses shutil.which which reads os.environ["PATH"]
    assert shutil.which("mytool") is not None

    # Now we need subprocess.run to actually run the real binary for detect_dep
    # Restore subprocess.run to real implementation
    result_after = detect_dep(dep)
    assert result_after["status"] == "ok"
    assert result_after["version"] == "1.2.3"
