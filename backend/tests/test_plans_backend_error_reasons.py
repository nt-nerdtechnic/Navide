"""The Plans child keeps the reason a filesystem operation failed.

A refused path, an OS error and a missing file used to collapse into one
BACKEND_UNAVAILABLE with nothing on stderr, so neither the user nor a log
could tell them apart.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from typing import Any

import pytest

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-plans" / "backend" / "plans_backend.py"
_spec = importlib.util.spec_from_file_location("plans_backend_error_reasons", ENTRY)
assert _spec and _spec.loader
plans_backend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plans_backend)


def _workspace(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    (root / ".agent-team" / "plans").mkdir(parents=True)
    return root


def _origin(root: Path) -> dict[str, Any]:
    return {"root": str(root.resolve())}


def _code(call: Any) -> str:
    with pytest.raises(plans_backend.BridgeFailure) as raised:
        call()
    return raised.value.code


# ── M2: refused paths, OS errors and oversized writes keep their reason ─────


def test_a_refused_path_is_not_reported_as_a_missing_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = _workspace(tmp_path)
    outside = tmp_path / "outside.html"
    outside.write_text("secret", encoding="utf-8")
    os.symlink(outside, root / ".agent-team" / "plans" / "leak_aaaaaa.html")
    origin = _origin(root)

    missing = _code(lambda: plans_backend._read_text(origin, ".agent-team/plans/missing_bbbbbb.html"))
    refused = _code(lambda: plans_backend._read_text(origin, ".agent-team/plans/leak_aaaaaa.html"))

    assert missing == "BACKEND_UNAVAILABLE"
    assert refused == "WORKSPACE_SCOPE_VIOLATION"
    err = capsys.readouterr().err
    assert ".agent-team/plans/leak_aaaaaa.html" in err and "escapes workspace" in err


def test_an_os_error_on_read_is_logged_with_its_reason(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = _workspace(tmp_path)
    target = root / ".agent-team" / "plans" / "locked_cccccc.html"
    target.write_text("x", encoding="utf-8")
    target.chmod(0)
    try:
        if os.access(target, os.R_OK):
            pytest.skip("running with privileges that ignore file modes")
        code = _code(lambda: plans_backend._read_text(_origin(root), ".agent-team/plans/locked_cccccc.html"))
    finally:
        target.chmod(0o644)
    assert code == "BACKEND_UNAVAILABLE"
    err = capsys.readouterr().err
    assert ".agent-team/plans/locked_cccccc.html" in err and "Permission denied" in err


def test_a_document_that_is_not_utf8_is_logged(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = _workspace(tmp_path)
    (root / ".agent-team" / "plans" / "latin_dddddd.html").write_bytes(b"\xff\xfe broken")
    code = _code(lambda: plans_backend._read_text(_origin(root), ".agent-team/plans/latin_dddddd.html"))
    assert code == "BACKEND_UNAVAILABLE"
    err = capsys.readouterr().err
    assert ".agent-team/plans/latin_dddddd.html" in err and "utf-8" in err.lower()


def test_a_missing_file_stays_quiet(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # plans.create probes for a free name this way; every miss must not log.
    root = _workspace(tmp_path)
    _code(lambda: plans_backend._read_text(_origin(root), ".agent-team/plans/missing_eeeeee.html"))
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize("rel_path", [".git/docs/plans/a.html", ".agent-team/state/docs/plans/a.html"])
def test_a_write_the_guard_refuses_is_a_scope_violation(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], rel_path: str
) -> None:
    root = _workspace(tmp_path)
    (root / ".git").mkdir()
    code = _code(lambda: plans_backend._write(_origin(root), rel_path, "<html></html>"))
    assert code == "WORKSPACE_SCOPE_VIOLATION"
    assert not (root / rel_path).exists()
    assert rel_path in capsys.readouterr().err


def test_a_write_failure_is_classified_without_matching_its_message(capsys: pytest.CaptureFixture[str]) -> None:
    limit = plans_backend._WRITE_SIZE_LIMIT
    # An error that merely says "too large" is not a size refusal.
    failure = plans_backend._write_failure(
        {"ok": False, "error": "part too large"}, rel_path=".agent-team/plans/a.html", size=10
    )
    assert failure.code == "BACKEND_UNAVAILABLE"
    # Content past the write limit is a resource limit, not a result too large.
    failure = plans_backend._write_failure(
        {"ok": False, "error": "content too large (51200 KB; limit 50 MB)"},
        rel_path=".agent-team/plans/a.html",
        size=limit + 1,
    )
    assert failure.code == "RESOURCE_LIMIT"
    conflict = plans_backend._write_failure({"ok": False, "conflict": True}, rel_path="x", size=1)
    assert conflict.code == "CONFLICT"
    err = capsys.readouterr().err
    assert "part too large" in err and "content too large" in err
