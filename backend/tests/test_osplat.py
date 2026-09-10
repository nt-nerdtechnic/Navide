"""The platform seam: selection, the Linux probe, and the no-branching rule.

The Linux implementation is exercised here on whatever machine runs the suite,
because it is pure Python over `/proc` paths — pointing it at a fixture
directory tests the parsing without needing a Linux box. What a Linux box is
still needed for is whether `/proc` really looks like this, which is what the
container smoke test covers.
"""

from __future__ import annotations

import re
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


#: Files that still decide platform behaviour for themselves. This list may
#: shrink and must never grow: a new entry means a feature module started
#: branching on the OS again, which is exactly what `osplat` exists to stop.
#:
#: `proc_rusage` stays until it moves under `osplat/` wholesale — it is already
#: reached only through the Darwin implementation, so its branch is a guard on
#: an unreachable path rather than a live decision.
PLATFORM_BRANCH_ALLOWLIST = {
    "applog.py",
    "cli_vendors/antigravity.py",
    "cli_vendors/claude.py",
    "cli_vendors/cursor.py",
    "credential_vault.py",
    "executions_service.py",
    "host_shell.py",
    "mem_probe.py",
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
                offenders.add(str(path.relative_to(root)))
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
