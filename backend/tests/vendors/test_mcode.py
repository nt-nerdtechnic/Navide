"""mcode (MiniMax Code) vendor spec.

These lock down the capabilities mcode deliberately does NOT declare. They
are worth asserting rather than leaving to review because the vendor's own
published reference lists `--model`, `--effort`, `--permission` and
`--resume` in the same table as the interactive flags, so the natural next
edit to this spec is to "fix the omission" — which would break every pane.
"""

from __future__ import annotations

import os

import pytest

from agent_team_backend.cli_vendors import registry

SPEC = registry.VENDORS["mcode"]


def test_identity_and_install_entry() -> None:
    assert SPEC.key == "mcode"
    assert SPEC.label == "MiniMax Code"
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.check_cmd == ["mcode", "--version"]
    assert dep.npm_package == "@minimax-ai/code"
    # `mcode update` is listed by `mcode --help`; there is no doctor command.
    assert dep.update_cmd == "mcode update"
    assert dep.doctor_cmd == ""


def test_data_dir_is_declared_as_a_guarded_home_var() -> None:
    """MINIMAX_DATA_DIR relocates the whole tree (config.yaml, auth/,
    v2/sqlite/) — verified by pointing it at an empty directory and confirming
    ~/.minimax stayed absent. Declaring it in home_env_vars is therefore a
    guard, not an injection: it joins the set the backend strips from inherited
    env and refuses in a spawn request (spawn_env_deny_list), with
    SPAWN_ENV_RESERVED_KEYS as the frontend mirror."""
    assert SPEC.home_env_vars == ("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR")
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.config_home_env == "MINIMAX_DATA_DIR"
    assert dep.config_home_default == ".minimax"


@pytest.mark.parametrize("name", ["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"])
def test_data_dir_overrides_are_removed_from_requests_and_inherited_env(
    name: str, monkeypatch: pytest.MonkeyPatch, tmp_path,
) -> None:
    from agent_team_backend import app

    data_dir = str(tmp_path / "other-account")
    kept, denied = app.filter_spawn_env_request({name: data_dir, "PROJECT_MODE": "test"})
    assert kept == {"PROJECT_MODE": "test"}
    assert denied == [name]

    # Isolate all removals so sanitizing cannot alter the test process's real env.
    monkeypatch.setattr(os, "environ", {name: data_dir, "PROJECT_MODE": "test"})
    app._sanitize_inherited_cli_env()
    assert dict(os.environ) == {"PROJECT_MODE": "test"}


def test_no_model_or_effort_capability() -> None:
    """`mcode --help` gives the interactive command five options: --lane,
    --session, -c/--continue, --tui-mode, -V. --model and --effort exist only
    under `mcode exec`, which Navide never spawns — and mcode REJECTS unknown
    options (`error: unknown option '...'`) instead of ignoring them, so a
    declared flag here stops the pane from opening at all."""
    assert SPEC.supports_model is False
    assert SPEC.supports_effort is False
    assert SPEC.known_efforts == ()


def test_resume_is_withheld_until_a_reader_exists() -> None:
    """`--session <id>` is real, but resume also needs to learn the id of a
    session Navide started, and mcode stores history in SQLite
    (<data-dir>/v2/sqlite/runtime-state.sqlite) with no reader written yet."""
    assert SPEC.supports_session_resume is False
    assert SPEC.make_log_reader is None


def test_sign_in_command() -> None:
    """The Accounts pane's sign-in button runs `mcode login`; the region flag
    (`--region global`) is a choice made inside the CLI's own flow."""
    assert SPEC.login_command_args == "login"
