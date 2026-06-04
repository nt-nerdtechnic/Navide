"""Onboarding dependency registry + detection.

Single source of truth for the first-run environment wizard. Each `Dep`
describes how to detect a tool and (where safe) how to install it. The frontend
only renders backend-computed status — it never hardcodes commands. Install is
driven by `dep_id` against this whitelist, mirroring the git-config allowlist
security model.

macOS-only by design (matches the project's platform assumption).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Dep:
    id: str
    label: str
    description: str
    group: str                       # 'foundation' | 'agent_cli' | 'analyzer'
    check_cmd: list[str]             # e.g. ['node', '--version']
    version_regex: str = r"(\d+\.\d+(?:\.\d+)?)"
    min_version: str = ""            # '' = any version is fine
    install_cmd: str = ""            # shell command (whitelist); '' = no auto-install
    needs_terminal: bool = False     # interactive (sudo / OAuth) → external Terminal
    optional: bool = False
    docs_url: str = ""


# ── Registry ──────────────────────────────────────────────────────────────────
# NOTE: Agent-CLI install commands are best-effort and may change upstream; they
# are marked needs_terminal so the user runs/authenticates them interactively.
DEPS: list[Dep] = [
    # Step 1 — Foundation
    Dep("homebrew", "Homebrew", "macOS 套件管理器", "foundation",
        ["brew", "--version"], r"Homebrew (\d+\.\d+\.\d+)",
        install_cmd='/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        needs_terminal=True, docs_url="https://brew.sh"),
    Dep("node", "Node.js", "JavaScript runtime (≥ 22)", "foundation",
        ["node", "--version"], r"v?(\d+\.\d+\.\d+)", min_version="22.0.0",
        install_cmd="brew install node@22", docs_url="https://nodejs.org"),
    Dep("pnpm", "pnpm", "套件管理器", "foundation",
        ["pnpm", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="brew install pnpm", docs_url="https://pnpm.io"),
    Dep("python", "Python", "Python 3.12+", "foundation",
        ["python3", "--version"], r"Python (\d+\.\d+\.\d+)", min_version="3.12.0",
        install_cmd="brew install python@3.12", docs_url="https://python.org"),
    Dep("uv", "uv", "Python 套件/環境管理器", "foundation",
        ["uv", "--version"], r"uv (\d+\.\d+\.\d+)",
        install_cmd="brew install uv", docs_url="https://docs.astral.sh/uv"),

    # Step 2 — Agent CLIs (≥ 1 required) + Analyzer
    Dep("claude", "Claude Code", "Anthropic Claude CLI", "agent_cli",
        ["claude", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @anthropic-ai/claude-code", needs_terminal=True,
        optional=True, docs_url="https://docs.anthropic.com/claude-code"),
    Dep("codex", "Codex", "OpenAI Codex CLI", "agent_cli",
        ["codex", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @openai/codex", needs_terminal=True,
        optional=True, docs_url=""),
    Dep("gemini", "Gemini", "Google Gemini CLI", "agent_cli",
        ["gemini", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @google/gemini-cli", needs_terminal=True,
        optional=True, docs_url=""),
    Dep("ollama", "Ollama", "本地 LLM runtime（Analyzer 必要）", "analyzer",
        ["ollama", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="brew install ollama", docs_url="https://ollama.com"),
]

DEPS_BY_ID: dict[str, Dep] = {d.id: d for d in DEPS}

# A model whose presence satisfies the analyzer requirement is any installed
# Ollama model; we surface the list so the UI can offer a pull if empty.
_SUGGESTED_MODEL = "qwen2.5-coder"


def _parse_version(text: str, regex: str) -> str:
    m = re.search(regex, text)
    return m.group(1) if m else ""


def _version_tuple(v: str) -> tuple[int, ...]:
    return tuple(int(p) for p in re.findall(r"\d+", v)) or (0,)


def _meets_min(version: str, min_version: str) -> bool:
    if not min_version:
        return True
    if not version:
        return False
    return _version_tuple(version) >= _version_tuple(min_version)


def detect_dep(dep: Dep) -> dict[str, Any]:
    """Run the dep's check_cmd and classify ok | missing | outdated."""
    if shutil.which(dep.check_cmd[0]) is None:
        status = "missing"
        version = ""
    else:
        try:
            proc = subprocess.run(
                dep.check_cmd, capture_output=True, text=True, timeout=8
            )
            out = (proc.stdout or "") + (proc.stderr or "")
            version = _parse_version(out, dep.version_regex)
            if version and not _meets_min(version, dep.min_version):
                status = "outdated"
            elif proc.returncode == 0 or version:
                status = "ok"
            else:
                status = "missing"
        except (subprocess.SubprocessError, OSError):
            status = "missing"
            version = ""
    return {
        "id": dep.id,
        "label": dep.label,
        "description": dep.description,
        "group": dep.group,
        "status": status,
        "version": version,
        "min_version": dep.min_version,
        "optional": dep.optional,
        "needs_terminal": dep.needs_terminal,
        "can_install": bool(dep.install_cmd),
        "docs_url": dep.docs_url,
    }


def detect_ollama_models() -> list[str]:
    """Return installed Ollama model names (empty if ollama missing/unreachable)."""
    if shutil.which("ollama") is None:
        return []
    try:
        proc = subprocess.run(
            ["ollama", "list"], capture_output=True, text=True, timeout=8
        )
    except (subprocess.SubprocessError, OSError):
        return []
    models: list[str] = []
    for line in proc.stdout.splitlines()[1:]:  # skip header
        name = line.split()[0] if line.split() else ""
        if name:
            models.append(name)
    return models


def compute_gate(dep_statuses: list[dict[str, Any]], models: list[str]) -> dict[str, Any]:
    """Compute the hard-block gate from detected statuses."""
    by_group: dict[str, list[dict[str, Any]]] = {"foundation": [], "agent_cli": [], "analyzer": []}
    for s in dep_statuses:
        by_group.get(s["group"], []).append(s)

    foundation_ready = all(s["status"] == "ok" for s in by_group["foundation"])
    has_any_cli = any(s["status"] == "ok" for s in by_group["agent_cli"])
    ollama_ok = any(s["id"] == "ollama" and s["status"] == "ok" for s in by_group["analyzer"])
    analyzer_ready = ollama_ok and len(models) > 0

    all_required_ready = foundation_ready and has_any_cli and analyzer_ready
    return {
        "foundation_ready": foundation_ready,
        "has_any_cli": has_any_cli,
        "analyzer_ready": analyzer_ready,
        "ollama_ok": ollama_ok,
        "has_model": len(models) > 0,
        "all_required_ready": all_required_ready,
        "suggested_model": _SUGGESTED_MODEL,
    }


def get_status() -> dict[str, Any]:
    """Full onboarding status: every dep + installed models + gate."""
    deps = [detect_dep(d) for d in DEPS]
    models = detect_ollama_models()
    return {"deps": deps, "models": models, "gate": compute_gate(deps, models)}


# ── Install (whitelist-driven) ────────────────────────────────────────────────
def install_dep(dep_id: str) -> dict[str, Any]:
    """Install a dep by id. Only ids in the registry whitelist are accepted.

    Interactive deps (sudo / OAuth) are handed back to the caller so the main
    process can open an external Terminal; non-interactive ones run inline and
    return captured output.
    """
    dep = DEPS_BY_ID.get(dep_id)
    if dep is None:
        return {"ok": False, "error": f"unknown dependency: {dep_id!r}"}
    if not dep.install_cmd:
        return {"ok": False, "error": "no install command for this dependency"}
    if dep.needs_terminal:
        # Caller (frontend → main process) opens Terminal.app with this command.
        return {"ok": True, "needs_terminal": True, "command": dep.install_cmd}
    try:
        proc = subprocess.run(
            dep.install_cmd, shell=True, capture_output=True, text=True, timeout=900
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "install timed out"}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    output = (proc.stdout or "") + (proc.stderr or "")
    return {"ok": proc.returncode == 0, "output": output, "command": dep.install_cmd}


def pull_model(model: str) -> dict[str, Any]:
    """Pull an Ollama model. The model name is constrained to a safe charset."""
    if not re.fullmatch(r"[A-Za-z0-9._:\-]+", model or ""):
        return {"ok": False, "error": "invalid model name"}
    if shutil.which("ollama") is None:
        return {"ok": False, "error": "ollama not installed"}
    # Long download — hand to an external Terminal so progress is visible.
    return {"ok": True, "needs_terminal": True, "command": f"ollama pull {model}"}


# ── Completion flag ───────────────────────────────────────────────────────────
def _flag_path() -> Path:
    return Path.home() / ".agent-team" / "onboarding.json"


def should_skip() -> bool:
    return os.environ.get("AGENT_TEAM_SKIP_ONBOARDING", "") == "1"


def is_complete() -> bool:
    if should_skip():
        return True
    try:
        data = json.loads(_flag_path().read_text(encoding="utf-8"))
        return bool(data.get("complete"))
    except (OSError, ValueError):
        return False


def set_complete(value: bool) -> None:
    path = _flag_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"complete": value}), encoding="utf-8")
    except OSError:
        pass
