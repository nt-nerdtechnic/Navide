"""cliproxyapi.SPEC: a deliberately narrow vendor (see the module docstring
in ``cli_vendors/cliproxyapi.py``) — install-detection only, no account-slot
or session capabilities, because CLIProxyAPI is a multi-account proxy server
rather than a single signed-in coding agent."""

from __future__ import annotations

import re

from agent_team_backend.cli_vendors.cliproxyapi import SPEC


def test_identity() -> None:
    assert SPEC.key == "cliproxyapi"
    assert SPEC.label == "CLIProxyAPI"


def test_no_account_slot_or_session_capabilities() -> None:
    # Deliberate: see the module docstring for why a multi-account proxy has
    # no single identity for Navide's account-slot model to park or resume.
    assert SPEC.live_file is None
    assert SPEC.slot_file is None
    assert SPEC.login_home_secret_file is None
    assert SPEC.profile_home_secret_file is None
    assert SPEC.identity_from_secret is None
    assert SPEC.make_log_reader is None
    assert SPEC.supports_session_resume is False


def test_install_detection_matches_the_real_version_banner() -> None:
    # cmd/server/main.go prints this unconditionally, before flag parsing,
    # so it survives even on --help (not one of the binary's own flags).
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.check_cmd == ["CLIProxyAPI", "--help"]
    sample = "CLIProxyAPI Version: 6.12.0, Commit: abc1234, BuiltAt: 2026-09-10\n"
    match = re.search(dep.version_regex, sample)
    assert match is not None
    assert match.group(1) == "6.12.0"
    # No auto-install command we've verified — the wizard should point at
    # docs instead of guessing one.
    assert dep.install_cmd == ""
    assert dep.docs_url == "https://github.com/router-for-me/CLIProxyAPI"
    assert dep.optional is True
