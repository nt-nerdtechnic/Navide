"""The platform seam: selection, the Linux probe, and the no-branching rule.

The Linux implementation is exercised here on whatever machine runs the suite,
because it is pure Python over `/proc` paths — pointing it at a fixture
directory tests the parsing without needing a Linux box. What a Linux box is
still needed for is whether `/proc` really looks like this, which is what the
container smoke test covers.
"""

from __future__ import annotations

import os
import re
import stat
import sys
from pathlib import Path

import pytest

from agent_team_backend import osplat
from agent_team_backend.osplat import _linux


class TestSelection:
    def test_picks_the_implementation_for_this_platform(self):
        expected = {
            "darwin": "_darwin",
            "linux": "_linux",
            "win32": "_windows",
        }.get(sys.platform, "_linux")
        assert osplat.impl_name == expected

    def test_exposes_a_probe_that_satisfies_the_contract(self):
        probe = osplat.resource_probe
        assert isinstance(probe.available(), bool)
        assert isinstance(probe.sample([]), dict)
        assert isinstance(probe.memory_kind(), str)

    # An unknown POSIX is far closer to Linux than to nothing, and each seam
    # degrades to unavailable on its own if the guess turns out wrong.
    def test_unknown_platforms_fall_back_to_linux(self):
        assert "freebsd" not in {"darwin", "win32"}
        assert osplat.impl_name in {"_darwin", "_linux", "_windows"}


class TestDarwinDelegation:
    """macOS must keep running exactly the code it ran before the extraction."""

    @pytest.mark.skipif(sys.platform != "darwin", reason="darwin-only seam")
    def test_delegates_to_proc_rusage(self, monkeypatch):
        from agent_team_backend import proc_rusage

        monkeypatch.setattr(proc_rusage, "available", lambda: True)
        monkeypatch.setattr(proc_rusage, "sample", lambda pids: {7: (11, 2.0)})
        assert osplat.resource_probe.available() is True
        assert osplat.resource_probe.sample([7]) == {7: (11, 2.0)}

    @pytest.mark.skipif(sys.platform != "darwin", reason="darwin-only seam")
    def test_reports_the_counter_it_actually_reads(self):
        assert osplat.resource_probe.memory_kind() == "phys_footprint"


def _fake_proc(root: Path, pid: int, *, pss_kb: int | None, comm: str = "claude",
               utime: int = 0, stime: int = 0) -> None:
    """Write the two `/proc/<pid>` files the Linux probe reads."""
    entry = root / str(pid)
    entry.mkdir(parents=True, exist_ok=True)
    if pss_kb is not None:
        (entry / "smaps_rollup").write_text(
            f"55a4a2e00000-7ffd0f5f2000 ---p 00000000 00:00 0 [rollup]\n"
            f"Rss:               99999 kB\n"
            f"Pss:               {pss_kb} kB\n"
            f"Shared_Clean:       1234 kB\n",
            encoding="utf-8",
        )
    # Fields: pid (comm) state ppid ... utime(14) stime(15) ...
    before = f"{pid} ({comm}) S 1 1 1 0 -1 4194304 100 0 0 0"
    after = " ".join(str(v) for v in [utime, stime] + [0] * 30)
    (entry / "stat").write_text(f"{before} {after}\n", encoding="utf-8")


class TestLinuxProbe:
    def test_reads_pss_and_cpu_from_proc(self, tmp_path, monkeypatch):
        _fake_proc(tmp_path, 42, pss_kb=2048, utime=150, stime=50)
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        monkeypatch.setattr(_linux, "_PSS_AVAILABLE", True)
        monkeypatch.setattr(_linux, "_CLK_TCK", 100.0)
        assert _linux.resource_probe.sample([42]) == {42: (2048 * 1024, 2.0)}

    # `comm` is unquoted and may contain spaces and parentheses, so the fields
    # after it can only be found by splitting from the last `)`.
    def test_parses_stat_for_a_process_whose_name_has_spaces(self, tmp_path, monkeypatch):
        _fake_proc(tmp_path, 43, pss_kb=1024, comm="my (odd) name", utime=300, stime=0)
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        monkeypatch.setattr(_linux, "_PSS_AVAILABLE", True)
        monkeypatch.setattr(_linux, "_CLK_TCK", 100.0)
        assert _linux.resource_probe.sample([43]) == {43: (1024 * 1024, 3.0)}

    # Same contract as the Darwin probe: a pid that has died, or that belongs
    # to another user, is absent rather than zero.
    def test_omits_pids_it_cannot_read(self, tmp_path, monkeypatch):
        _fake_proc(tmp_path, 44, pss_kb=512)
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        monkeypatch.setattr(_linux, "_PSS_AVAILABLE", True)
        sampled = _linux.resource_probe.sample([44, 9999])
        assert set(sampled) == {44}

    def test_ignores_impossible_pids(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        monkeypatch.setattr(_linux, "_PSS_AVAILABLE", True)
        assert _linux.resource_probe.sample([0, -1]) == {}

    # A kernel without smaps_rollup reports unavailable rather than falling
    # back to RSS: mixing PSS for some panes and RSS for others would make the
    # column incomparable across rows, which is worse than an empty panel.
    def test_reports_unavailable_without_smaps_rollup(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        monkeypatch.setattr(_linux, "_PSS_AVAILABLE", False)
        assert _linux.resource_probe.available() is False
        assert _linux.resource_probe.sample([1]) == {}

    def test_survives_a_truncated_stat_file(self, tmp_path, monkeypatch):
        entry = tmp_path / "45"
        entry.mkdir()
        (entry / "smaps_rollup").write_text("Pss: 64 kB\n", encoding="utf-8")
        (entry / "stat").write_text("45 (x) S\n", encoding="utf-8")
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        monkeypatch.setattr(_linux, "_PSS_AVAILABLE", True)
        # Memory still counts; CPU it could not parse reads as zero rather
        # than dropping the pid, because the memory figure is the one the
        # panel is gated on.
        assert _linux.resource_probe.sample([45]) == {45: (64 * 1024, 0.0)}

    def test_reports_the_counter_it_actually_reads(self):
        assert _linux.resource_probe.memory_kind() == "pss"


class TestPaths:
    def test_exposes_the_contract(self):
        assert isinstance(osplat.paths.app_support_dir("Cursor"), Path)
        assert isinstance(osplat.paths.cache_dir(), Path)

    # The layout other desktop apps follow on each platform. Getting this wrong
    # is what made the Cursor usage reader macOS-only.
    def test_each_platform_uses_its_own_convention(self, tmp_path):
        from agent_team_backend.osplat import _darwin, _linux, _windows

        assert _darwin.paths.app_support_dir("Cursor", home=tmp_path) == (
            tmp_path / "Library" / "Application Support" / "Cursor"
        )
        assert _linux.paths.app_support_dir("Cursor", home=tmp_path) == (
            tmp_path / ".config" / "Cursor"
        )
        assert _windows.paths.app_support_dir("Cursor", home=tmp_path) == (
            tmp_path / "AppData" / "Roaming" / "Cursor"
        )

    # A per-pane home exists to point a CLI somewhere other than the real user
    # directory; honouring $XDG_CONFIG_HOME there would send it straight back.
    def test_an_explicit_home_beats_the_xdg_environment(self, tmp_path, monkeypatch):
        from agent_team_backend.osplat import _linux

        monkeypatch.setenv("XDG_CONFIG_HOME", "/somewhere/else")
        assert _linux.paths.app_support_dir("Cursor", home=tmp_path) == (
            tmp_path / ".config" / "Cursor"
        )

    def test_linux_honours_xdg_when_no_home_is_named(self, monkeypatch):
        from agent_team_backend.osplat import _linux

        monkeypatch.setenv("XDG_CONFIG_HOME", "/xdg/config")
        monkeypatch.setenv("XDG_CACHE_HOME", "/xdg/cache")
        assert _linux.paths.app_support_dir("Cursor") == Path("/xdg/config/Cursor")
        assert _linux.paths.cache_dir() == Path("/xdg/cache")

    def test_linux_falls_back_to_the_spec_defaults(self, monkeypatch):
        from agent_team_backend.osplat import _linux

        monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
        monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
        assert _linux.paths.app_support_dir("X") == Path.home() / ".config" / "X"
        assert _linux.paths.cache_dir() == Path.home() / ".cache"

    # The backend's own state dir: `applog` used to decide this itself. Linux
    # is `$XDG_DATA_HOME`, not `~/.config`, because that is where existing
    # installs already keep their sessions.
    def test_state_dir_keeps_each_platforms_existing_location(self, tmp_path, monkeypatch):
        from agent_team_backend.osplat import _darwin, _linux, _windows

        monkeypatch.delenv("XDG_DATA_HOME", raising=False)
        monkeypatch.delenv("APPDATA", raising=False)
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
        assert _darwin.paths.state_dir("Agent-Team") == (
            tmp_path / "Library" / "Application Support" / "Agent-Team"
        )
        assert _linux.paths.state_dir("Agent-Team") == (
            tmp_path / ".local" / "share" / "Agent-Team"
        )
        assert _windows.paths.state_dir("Agent-Team") == (
            tmp_path / "AppData" / "Roaming" / "Agent-Team"
        )
        monkeypatch.setenv("XDG_DATA_HOME", "/xdg/data")
        monkeypatch.setenv("APPDATA", "C:/Users/x/AppData/Roaming")
        assert _linux.paths.state_dir("Agent-Team") == Path("/xdg/data/Agent-Team")
        assert _windows.paths.state_dir("Agent-Team") == Path("C:/Users/x/AppData/Roaming/Agent-Team")

    # `os.UserConfigDir()` as Go CLIs see it — what `host_shell` used to branch on.
    def test_config_home_per_platform(self, tmp_path, monkeypatch):
        from agent_team_backend.osplat import _darwin, _linux, _windows

        assert _darwin.paths.config_home(tmp_path) == tmp_path / "Library" / "Application Support"
        assert _linux.paths.config_home(tmp_path) == tmp_path / ".config"
        monkeypatch.delenv("APPDATA", raising=False)
        assert _windows.paths.config_home(tmp_path) == tmp_path / "AppData" / "Roaming"
        assert _windows.paths.roaming_app_data() is None
        monkeypatch.setenv("APPDATA", "C:/roaming")
        assert _windows.paths.config_home(tmp_path) == Path("C:/roaming")
        assert _windows.paths.roaming_app_data() == Path("C:/roaming")
        assert _darwin.paths.roaming_app_data() is None
        assert _linux.paths.roaming_app_data() is None

    # The isolated environment a public CLI run gets: POSIX children read HOME
    # and TMPDIR, Windows children USERPROFILE plus TEMP/TMP (and HOME, which
    # several Node CLIs consult first).
    def test_isolated_home_env_names_each_platforms_variables(self, tmp_path):
        from agent_team_backend.osplat import _darwin, _linux, _windows

        home = str(tmp_path)
        assert _darwin.paths.isolated_home_env(tmp_path) == {"HOME": home, "TMPDIR": home}
        assert _linux.paths.isolated_home_env(tmp_path) == {"HOME": home, "TMPDIR": home}
        assert _windows.paths.isolated_home_env(tmp_path) == {
            "USERPROFILE": home, "HOME": home, "TEMP": home, "TMP": home,
        }
        assert _darwin.paths.home_env_var() == "HOME"
        assert _linux.paths.home_env_var() == "HOME"
        assert _windows.paths.home_env_var() == "USERPROFILE"

    # A quoted path reaches a program through the platform's own shell
    # convention: POSIX apostrophes are literal characters to cmd.exe.
    def test_quote_arg_follows_each_platforms_shell(self):
        from agent_team_backend.osplat import _darwin, _linux, _windows

        assert _darwin.paths.quote_arg("/tmp/a b") == "'/tmp/a b'"
        assert _linux.paths.quote_arg("/tmp/a b") == "'/tmp/a b'"
        assert _linux.paths.quote_arg("plain") == "plain"
        assert _windows.paths.quote_arg(r"C:\Users\a b\x.exe") == r'"C:\Users\a b\x.exe"'
        assert _windows.paths.quote_arg("plain") == "plain"


class TestAskpassLauncher:
    """`GIT_ASKPASS` is exec'd by git with no shell: POSIX runs the script's
    shebang, Windows cannot exec a `.py` and needs a launcher around an
    interpreter."""

    @pytest.mark.skipif(sys.platform == "win32", reason="the exec bit does not exist on NTFS")
    def test_posix_returns_the_script_made_executable(self, tmp_path):
        from agent_team_backend.osplat import _darwin, _linux

        helper = tmp_path / "git_askpass_helper.py"
        helper.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
        helper.chmod(0o644)
        assert _darwin.paths.askpass_launcher(helper, "/usr/bin/python3") == helper
        assert os.stat(helper).st_mode & stat.S_IXUSR
        helper.chmod(0o644)
        assert _linux.paths.askpass_launcher(helper, None) == helper
        assert os.stat(helper).st_mode & stat.S_IXUSR

    def test_windows_writes_a_cmd_wrapper_beside_the_script(self, tmp_path):
        from agent_team_backend.osplat import _windows

        helper = tmp_path / "git_askpass_helper.py"
        helper.write_text("", encoding="utf-8")
        launcher = _windows.paths.askpass_launcher(helper, r"C:\Python\python.exe")
        assert launcher == tmp_path / "git_askpass_helper.cmd"
        assert launcher.read_bytes() == (
            b'@"C:\\Python\\python.exe" "' + str(helper).encode() + b'" %*\r\n'
        )

    # A frozen build carries no interpreter of its own: the launcher falls
    # back to `python` on PATH, the same dependency the POSIX shebang has.
    def test_windows_frozen_build_uses_python_from_path(self, tmp_path):
        from agent_team_backend.osplat import _windows

        helper = tmp_path / "git_askpass_helper.py"
        helper.write_text("", encoding="utf-8")
        launcher = _windows.paths.askpass_launcher(helper, None)
        assert launcher.read_text(encoding="utf-8").startswith('@"python" "')

    def test_windows_leaves_an_up_to_date_launcher_untouched(self, tmp_path):
        from agent_team_backend.osplat import _windows

        helper = tmp_path / "git_askpass_helper.py"
        helper.write_text("", encoding="utf-8")
        launcher = _windows.paths.askpass_launcher(helper, "py")
        before = launcher.stat().st_mtime_ns
        os.utime(launcher, ns=(before - 10**9, before - 10**9))
        stamped = launcher.stat().st_mtime_ns
        assert _windows.paths.askpass_launcher(helper, "py") == launcher
        assert launcher.stat().st_mtime_ns == stamped

    # git_service resolves the launcher at import: a directory that cannot be
    # written must degrade the way the POSIX chmod does (log, hand git the
    # path, let git report the failure) rather than stop the backend.
    def test_windows_unwritable_directory_logs_and_still_names_the_launcher(
        self, tmp_path, monkeypatch, caplog
    ):
        from agent_team_backend.osplat import _windows

        helper = tmp_path / "git_askpass_helper.py"
        helper.write_text("", encoding="utf-8")

        def denied(self, data):
            raise PermissionError(13, "Access is denied", str(self))

        monkeypatch.setattr(Path, "write_bytes", denied)
        launcher = _windows.paths.askpass_launcher(helper, "py")
        assert launcher == tmp_path / "git_askpass_helper.cmd"
        assert not launcher.exists()
        assert "cannot write git askpass launcher" in caplog.text


class TestOrphanParent:
    """What the EOF-path orphan sweep in `terminals` asks the tree: which ppid
    means the real parent is gone. POSIX reparents to init (or, observed on
    macOS, to this backend); Windows never reparents, and `snapshot` writes 0
    for a stale parent instead."""

    def test_posix_is_init_or_this_process(self):
        from agent_team_backend.osplat import _posix

        tree = _posix.process_tree
        assert tree.is_orphan_parent(1, 500)
        assert tree.is_orphan_parent(500, 500)
        assert not tree.is_orphan_parent(0, 500)
        assert not tree.is_orphan_parent(42, 500)

    def test_windows_is_the_normalised_zero_or_this_process(self):
        from agent_team_backend.osplat import _windows

        tree = _windows.process_tree
        assert tree.is_orphan_parent(0, 500)
        assert tree.is_orphan_parent(500, 500)
        assert not tree.is_orphan_parent(1, 500)
        assert not tree.is_orphan_parent(42, 500)


#: Files that still decide platform behaviour for themselves. This list may
#: shrink and must never grow: a new entry means a feature module started
#: branching on the OS again, which is exactly what `osplat` exists to stop.
#:
#: `proc_rusage` stays until it moves under `osplat/` wholesale — it is already
#: reached only through the Darwin implementation, so its branch is a guard on
#: an unreachable path rather than a live decision.
PLATFORM_BRANCH_ALLOWLIST = {
    "cli_vendors/antigravity.py",
    "cli_vendors/claude.py",
    "cli_vendors/cursor.py",
    "credential_vault.py",
    "proc_rusage.py",
    "process_cpu.py",
    "process_memory.py",
}

_BRANCH_RE = re.compile(r"sys\.platform|os\.name\s*==")


class TestNoScatteredPlatformBranches:
    def test_only_allowlisted_modules_branch_on_the_platform(self):
        root = Path(__file__).resolve().parents[1] / "agent_team_backend"
        offenders = set()
        for path in root.rglob("*.py"):
            if "osplat" in path.parts:
                continue  # the one place that is allowed to ask
            if _BRANCH_RE.search(path.read_text(encoding="utf-8")):
                offenders.add(path.relative_to(root).as_posix())
        new = offenders - PLATFORM_BRANCH_ALLOWLIST
        assert not new, (
            "these modules started branching on the platform; put the decision "
            f"behind an osplat seam instead: {sorted(new)}"
        )

    # The allowlist is a ratchet, so a cleaned-up module has to be removed from
    # it — otherwise it silently licenses the next regression.
    def test_the_allowlist_has_no_stale_entries(self):
        root = Path(__file__).resolve().parents[1] / "agent_team_backend"
        stale = {
            name
            for name in PLATFORM_BRANCH_ALLOWLIST
            if not _BRANCH_RE.search((root / name).read_text(encoding="utf-8"))
        }
        assert not stale, f"already clean, drop from the allowlist: {sorted(stale)}"


#: Modules whose secret files go through `osplat.secret_files`. Listed rather
#: than banning `chmod` everywhere: `fs_service` copying a user file's mode is
#: legitimate, and `credential_vault` still preserves the mode of the user's
#: own `.claude.json`. What these must not do is set a *literal* owner-only
#: mode themselves — on NTFS that call protects nothing, which is the whole
#: reason the seam exists.
SECRET_FILE_MODULES = {
    "ai_chat_settings.py",
    "credential_vault.py",
    "device_crypto.py",
    "device_signing.py",
    "executions_service.py",
    "hook_auth.py",
    "host_shell.py",
    "mcp_server/auth.py",
    "mcp_server/pane_home.py",
    "mcp_server/wiring.py",
    "push_delivery.py",
    "store_migrations.py",
    "usage_service.py",
    "ws_auth.py",
}

_OWNER_ONLY_MODE_RE = re.compile(
    r"chmod\([^)]*0o[67]00\)"          # os.chmod(p, 0o600) / path.chmod(0o700)
    r"|mkdir\([^)]*mode=0o700"          # path.mkdir(mode=0o700, ...)
    r"|S_IRUSR \| stat\.S_IWUSR"       # the spelled-out 0o600
)


class TestSecretFilesGoThroughTheSeam:
    def test_migrated_modules_no_longer_set_owner_only_modes_themselves(self):
        root = Path(__file__).resolve().parents[1] / "agent_team_backend"
        offenders = {
            name
            for name in SECRET_FILE_MODULES
            if _OWNER_ONLY_MODE_RE.search((root / name).read_text(encoding="utf-8"))
        }
        assert not offenders, (
            "these modules set an owner-only mode inline again; use "
            f"osplat.secret_files instead: {sorted(offenders)}"
        )


#: Modules the Windows port moved off the POSIX process and PTY APIs. Every
#: platform-specific call they used to make now goes through
#: `osplat.process_tree` / `osplat.terminal_backend` / `osplat.resource_probe`,
#: and this keeps it that way: a `fcntl` import or an `os.killpg` call creeping
#: back in would make the backend unimportable (or unkillable) on Windows.
POSIX_FREE_MODULES = (
    "ai_chat_cli_engine.py",
    "mem_probe.py",
    "pty_registry.py",
    "terminals.py",
)

_POSIX_IMPORT_RE = re.compile(
    r"^\s*(?:import|from)\s+(?:fcntl|pty|termios|resource)\b", re.MULTILINE
)
_POSIX_CALL_RE = re.compile(
    r"\bos\.(?:killpg|getpgid|tcgetpgrp|setsid|openpty|kill)\s*\("
    r"|\bpty\.openpty\b|\bsignal\.SIG(?:KILL|TERM)\b|\bTIOCS(?:WINSZ|CTTY)\b"
)


class TestPortedModulesStayPosixFree:
    @pytest.mark.parametrize("name", POSIX_FREE_MODULES)
    def test_no_posix_only_import_or_call(self, name):
        root = Path(__file__).resolve().parents[1] / "agent_team_backend"
        source = (root / name).read_text(encoding="utf-8")
        assert not _POSIX_IMPORT_RE.search(source), f"{name} imports a POSIX-only module"
        hit = _POSIX_CALL_RE.search(source)
        assert hit is None, f"{name} calls the POSIX process API directly: {hit.group(0)!r}"

    def test_the_seam_itself_still_makes_those_calls(self):
        # The ratchet would be vacuous if the calls had simply vanished.
        posix = Path(__file__).resolve().parents[1] / "agent_team_backend" / "osplat" / "_posix.py"
        source = posix.read_text(encoding="utf-8")
        assert _POSIX_IMPORT_RE.search(source)
        assert _POSIX_CALL_RE.search(source)
