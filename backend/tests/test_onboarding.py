"""onboarding_deps — version detection (3 states), install whitelist, gate, flag."""

from __future__ import annotations

import json
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


def _make_executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def _claude_status(path: Path, *, ok: bool = True) -> dict:
    return {
        "id": "claude",
        "status": "ok" if ok else "missing",
        "version": "2.1.210" if ok else "",
        "binary_path": str(path),
        "resolved_path": str(path.resolve()),
        "exit_code": 0 if ok else -9,
        "signal": "" if ok else "SIGKILL",
        "duration_ms": 42,
    }


def test_cli_health_reports_distinct_duplicate_installations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = _make_executable(tmp_path / "nvm" / "claude")
    second = _make_executable(tmp_path / "homebrew" / "claude")
    monkeypatch.setenv("PATH", f"{first.parent}:{second.parent}")
    monkeypatch.setattr(
        ob,
        "_probe_alternate",
        lambda _dep, _path: {
            "version": "2.1.168", "status": "ok", "exit_code": 0,
            "signal": "", "duration_ms": 10,
        },
    )
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(first)])

    duplicate = next(f for f in health["findings"] if f["type"] == "duplicate_install")
    assert duplicate["agent_key"] == "claude"
    assert [c["version"] for c in duplicate["candidates"]] == ["2.1.210", "2.1.168"]
    assert health["needs_attention"] is True
    assert len(health["fingerprint"]) == 16


def _make_npm_claude_install(prefix: Path) -> tuple[Path, Path, Path]:
    """Create an npm-owned claude install; returns (npm, binary, target)."""
    npm = _make_executable(prefix / "bin" / "npm")
    target = _make_executable(
        prefix / "lib" / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
    )
    binary = prefix / "bin" / "claude"
    binary.symlink_to(target)
    return npm, binary, target


def _candidate_entry(path: Path, resolved: Path | None = None) -> dict:
    return {
        "path": str(path),
        "resolved_path": str(resolved if resolved is not None else path),
        "aliases": [str(path)],
    }


def _probe_ok(_dep: object, _path: str) -> dict:
    return {"version": "2.1.214", "status": "ok", "exit_code": 0, "signal": "", "duration_ms": 10}


def _probe_failed(_dep: object, _path: str) -> dict:
    return {"version": "", "status": "failed", "exit_code": 1, "signal": "", "duration_ms": 10}


def test_cli_health_builds_confirmed_npm_removal_for_owned_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    npm, binary, target = _make_npm_claude_install(tmp_path / "node")
    other = _make_executable(tmp_path / "native" / "claude")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
        _candidate_entry(other),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary)])
    candidate = health["entries"][0]["candidates"][0]

    assert candidate["install_manager"] == "npm"
    assert str(npm) in candidate["removal_command"]
    assert "uninstall -g @anthropic-ai/claude-code" in candidate["removal_command"]
    assert "Continue? [y/N]" in candidate["removal_command"]


def test_cli_health_never_offers_removal_for_the_only_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, binary, target = _make_npm_claude_install(tmp_path / "node")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
    ])
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary)])
    candidate = health["entries"][0]["candidates"][0]

    assert candidate["removal_command"] == ""
    assert candidate["install_manager"] == ""


def test_cli_health_offers_removal_only_for_the_broken_duplicate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, primary_binary, primary_target = _make_npm_claude_install(tmp_path / "node_a")
    _, broken_binary, broken_target = _make_npm_claude_install(tmp_path / "node_b")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(primary_binary, primary_target),
        _candidate_entry(broken_binary, broken_target),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_failed)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(primary_binary)])
    candidates = health["entries"][0]["candidates"]
    working = next(c for c in candidates if c["status"] == "ok")
    broken = next(c for c in candidates if c["status"] != "ok")

    assert working["removal_command"] == ""
    assert "uninstall -g @anthropic-ai/claude-code" in broken["removal_command"]


def test_cli_health_allows_removing_a_broken_sole_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, binary, target = _make_npm_claude_install(tmp_path / "node")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
    ])
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary, ok=False)])
    candidate = health["entries"][0]["candidates"][0]

    # Removing a broken install cannot lose a working CLI, so guided removal
    # stays available even without a working backup.
    assert "uninstall -g @anthropic-ai/claude-code" in candidate["removal_command"]


def test_cli_health_blocks_removal_when_backup_is_same_physical_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, binary, target = _make_npm_claude_install(tmp_path / "node")
    wrapper = _make_executable(
        tmp_path / "node" / "lib" / "node_modules" / "@anthropic-ai" / "claude-code" / "cli-wrapper.cjs"
    )
    alias = tmp_path / "node" / "bin" / "claude-alias"
    alias.symlink_to(wrapper)
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
        _candidate_entry(alias, wrapper),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary)])
    candidates = health["entries"][0]["candidates"]

    # Both PATH entries live in the same npm prefix: one uninstall removes
    # both, so neither may count the other as a working backup.
    assert [c["removal_command"] for c in candidates] == ["", ""]


def test_cli_health_fingerprint_ignores_removal_gating(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    npm, binary, target = _make_npm_claude_install(tmp_path / "node")
    other = _make_executable(tmp_path / "native" / "claude")
    monkeypatch.setattr(ob, "_distinct_executables", lambda _command: [
        _candidate_entry(binary, target),
        _candidate_entry(other),
    ])
    monkeypatch.setattr(ob, "_probe_alternate", _probe_ok)
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    with_removal = ob.build_cli_health([_claude_status(binary)])
    npm.unlink()  # removal becomes unavailable; probes are unchanged
    without_removal = ob.build_cli_health([_claude_status(binary)])

    assert with_removal["entries"][0]["candidates"][0]["removal_command"] != ""
    assert without_removal["entries"][0]["candidates"][0]["removal_command"] == ""
    assert with_removal["fingerprint"] == without_removal["fingerprint"]


def test_cli_health_collapses_aliases_to_same_physical_binary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = _make_executable(tmp_path / "package" / "claude.exe")
    first = tmp_path / "bin-a" / "claude"
    second = tmp_path / "bin-b" / "claude"
    first.parent.mkdir()
    second.parent.mkdir()
    first.symlink_to(target)
    second.symlink_to(target)
    monkeypatch.setenv("PATH", f"{first.parent}:{second.parent}")
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(first)])

    assert health["findings"] == []
    claude = next(entry for entry in health["entries"] if entry["agent_key"] == "claude")
    assert len(claude["candidates"]) == 1
    assert claude["candidates"][0]["aliases"] == [str(first), str(second)]


def test_cli_health_reports_failed_primary_probe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    binary = _make_executable(tmp_path / "bin" / "claude")
    monkeypatch.setenv("PATH", str(binary.parent))
    monkeypatch.setattr(ob, "_dismissed_cli_health_fingerprint", lambda: "")

    health = ob.build_cli_health([_claude_status(binary, ok=False)])

    failed = next(f for f in health["findings"] if f["type"] == "probe_failed")
    assert failed["primary"]["signal"] == "SIGKILL"
    assert health["needs_attention"] is True


def test_cli_health_dismissal_is_fingerprint_scoped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_flag_paths(monkeypatch, tmp_path)
    ob.set_complete(True)
    fingerprint = "0123456789abcdef"
    ob.dismiss_cli_health(fingerprint)

    assert ob._dismissed_cli_health_fingerprint() == fingerprint
    assert ob.is_complete() is True

    ob.dismiss_cli_health("invalid")
    assert ob._dismissed_cli_health_fingerprint() == fingerprint


def test_cli_binary_selection_persists_path_and_fingerprint_atomically(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    flag, _legacy = _patch_flag_paths(monkeypatch, tmp_path)
    prefix = tmp_path / "node"
    target = _make_executable(
        prefix / "lib" / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
    )
    binary = prefix / "bin" / "claude"
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.symlink_to(target)
    monkeypatch.setenv("PATH", str(binary.parent))
    ob.set_complete(True)

    result = ob.select_cli_binary("claude", str(binary), "0123456789abcdef")

    assert result == {"ok": True, "agent_key": "claude", "path": str(binary)}
    assert ob.cli_binary_override("claude") == str(binary)
    assert ob._dismissed_cli_health_fingerprint() == "0123456789abcdef"
    assert json.loads(flag.read_text(encoding="utf-8")) == {
        "complete": True,
        "cli_binary_overrides": {"claude": str(binary)},
        "dismissed_cli_health": "0123456789abcdef",
    }
