"""onboarding_deps — version detection (3 states), install whitelist, gate, flag."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from agent_team_backend import onboarding_deps as ob
from agent_team_backend.onboarding_deps import Dep


# ── detect_dep: ok / outdated / missing ──────────────────────────────────────
_NODE = Dep("node", "Node", "", "foundation", ["node", "--version"],
            r"v?(\d+\.\d+\.\d+)", min_version="22.0.0", install_cmd="brew install node@22")


def _fake_run(stdout: str):
    def run(*_a, **_k):
        return subprocess.CompletedProcess(_a[0] if _a else [], 0, stdout, "")
    return run


def test_detect_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: "/usr/bin/node")
    monkeypatch.setattr(ob.subprocess, "run", _fake_run("v22.3.0"))
    r = ob.detect_dep(_NODE)
    assert r["status"] == "ok" and r["version"] == "22.3.0"


def test_detect_outdated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: "/usr/bin/node")
    monkeypatch.setattr(ob.subprocess, "run", _fake_run("v18.0.0"))
    r = ob.detect_dep(_NODE)
    assert r["status"] == "outdated" and r["version"] == "18.0.0"


def test_detect_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.shutil, "which", lambda _x: None)
    r = ob.detect_dep(_NODE)
    assert r["status"] == "missing" and r["version"] == ""


# ── gate computation ──────────────────────────────────────────────────────────
def _deps(found_ok: bool, cli_ok: bool, ollama_ok: bool) -> list[dict]:
    return [
        {"id": "node", "group": "foundation", "status": "ok" if found_ok else "missing"},
        {"id": "pnpm", "group": "foundation", "status": "ok"},
        {"id": "claude", "group": "agent_cli", "status": "ok" if cli_ok else "missing"},
        {"id": "codex", "group": "agent_cli", "status": "missing"},
        {"id": "ollama", "group": "analyzer", "status": "ok" if ollama_ok else "missing"},
    ]


def test_gate_all_ready() -> None:
    g = ob.compute_gate(_deps(True, True, True), models=["qwen2.5-coder"])
    assert g["all_required_ready"] is True
    assert g["foundation_ready"] and g["has_any_cli"] and g["analyzer_ready"]


def test_gate_blocks_without_cli() -> None:
    g = ob.compute_gate(_deps(True, False, True), models=["m"])
    assert g["has_any_cli"] is False and g["all_required_ready"] is False


def test_gate_analyzer_is_optional() -> None:
    """No model installed → analyzer not ready, but the gate must still open:
    forcing a multi-GB model download to use agent CLIs is not acceptable."""
    g = ob.compute_gate(_deps(True, True, True), models=[])
    assert g["analyzer_ready"] is False and g["all_required_ready"] is True


def test_gate_blocks_without_foundation() -> None:
    g = ob.compute_gate(_deps(False, True, True), models=["m"])
    assert g["foundation_ready"] is False and g["all_required_ready"] is False


# ── install whitelist ─────────────────────────────────────────────────────────
def test_install_unknown_id_rejected() -> None:
    r = ob.install_dep("rm-rf-everything")
    assert r["ok"] is False and "unknown" in r["error"].lower()


def test_install_needs_terminal_returns_command_without_running(monkeypatch: pytest.MonkeyPatch) -> None:
    # homebrew is needs_terminal → must NOT shell out, just hand back the command.
    called = {"ran": False}
    def boom(*_a, **_k):
        called["ran"] = True
        raise AssertionError("should not run")
    monkeypatch.setattr(ob.subprocess, "run", boom)
    r = ob.install_dep("homebrew")
    assert r["ok"] is True and r["needs_terminal"] is True and r["command"]
    assert called["ran"] is False


def test_pull_model_rejects_bad_name() -> None:
    assert ob.pull_model("evil; rm -rf /")["ok"] is False


# ── completion flag ───────────────────────────────────────────────────────────
def _patch_flag_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> tuple[Path, Path]:
    """Point both the new and the legacy flag path into tmp_path."""
    flag = tmp_path / "app-data" / "onboarding.json"
    legacy = tmp_path / "legacy" / "onboarding.json"
    monkeypatch.setattr(ob, "_flag_path", lambda: flag)
    monkeypatch.setattr(ob, "_legacy_flag_path", lambda: legacy)
    monkeypatch.delenv("AGENT_TEAM_SKIP_ONBOARDING", raising=False)
    return flag, legacy


def test_complete_flag_roundtrip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    assert ob.is_complete() is False
    ob.set_complete(True)
    assert ob.is_complete() is True


def test_skip_env_forces_complete(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    monkeypatch.setenv("AGENT_TEAM_SKIP_ONBOARDING", "1")
    assert ob.is_complete() is True


def test_legacy_flag_migrated_to_new_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Existing user with only the legacy flag must not see onboarding again."""
    flag, legacy = _patch_flag_paths(monkeypatch, tmp_path)
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text('{"complete": true}', encoding="utf-8")
    assert ob.is_complete() is True
    # First read copies the legacy file to the new location.
    assert flag.exists()
    assert ob.is_complete() is True


def test_legacy_fallback_read_when_copy_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Even if the copy fails, is_complete() falls back to reading the legacy path."""
    _, legacy = _patch_flag_paths(monkeypatch, tmp_path)
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text('{"complete": true}', encoding="utf-8")
    monkeypatch.setattr(ob, "_migrate_legacy_flag", lambda: None)
    assert ob.is_complete() is True


def test_new_flag_wins_over_legacy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A flag already present at the new path is read as-is (no legacy override)."""
    flag, legacy = _patch_flag_paths(monkeypatch, tmp_path)
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text('{"complete": false}', encoding="utf-8")
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text('{"complete": true}', encoding="utf-8")
    assert ob.is_complete() is False


def test_set_complete_writes_new_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    flag, legacy = _patch_flag_paths(monkeypatch, tmp_path)
    ob.set_complete(True)
    assert flag.exists()
    assert not legacy.exists()
