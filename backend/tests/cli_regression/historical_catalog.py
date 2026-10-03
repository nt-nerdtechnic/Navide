"""Historical case metadata, validated by the regression pytest plugin.

No git objects are opened: CI may use a shallow checkout. Commit references
identify the source evidence; collected nodeids and reports prove execution.
"""

from __future__ import annotations

import json
import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[3]
_CAPABILITIES = frozenset({"posix_pty", "windows_conpty"})
_STATUSES = frozenset({"active", "superseded", "manual"})
_SHA = re.compile(r"[0-9a-f]{7,40}\Z")
_ID = re.compile(r"[a-z][a-z0-9_.-]*\Z")


def load_catalog(repo_root: Path | None = None) -> dict[str, Any]:
    return json.loads(((repo_root or _ROOT) / "docs/testing/cli-regressions.json").read_text(encoding="utf-8"))


def platform_capabilities(platform: str = sys.platform) -> frozenset[str]:
    # A native runner must supply its terminal dependency. Missing pywinpty
    # on Windows is a failure, not a reason to erase Windows coverage.
    return frozenset({"windows_conpty"} if platform == "win32" else {"posix_pty"})


def matches_nodeid(reference: str, collected: str) -> bool:
    """A function reference covers all parameters; a parametrized one is exact."""
    return collected == reference or collected.startswith(reference + "[")


def required_cases(data: dict, platform: str = sys.platform) -> dict[str, str]:
    capabilities = platform_capabilities(platform)
    return {
        case["nodeid"]: entry["id"]
        for entry in data["regressions"] if entry["status"] == "active"
        for case in entry["cases"]
        if set(case["requires"]) <= capabilities
    }


def all_case_nodeids(data: dict) -> set[str]:
    return {
        case["nodeid"]
        for entry in data["regressions"] if entry["status"] == "active"
        for case in entry["cases"]
    }


def validate_catalog(
    data: dict,
    collected_nodeids: Iterable[str] | None = None,
    *,
    platform: str = sys.platform,
) -> list[str]:
    from agent_team_backend.cli_vendors.registry import VENDORS

    errors: list[str] = []
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        return ["historical catalog: expected schema_version 1"]
    entries = data.get("regressions")
    if not isinstance(entries, list) or not entries:
        return ["historical catalog: regressions must be a nonempty list"]
    ids: set[str] = set()
    references: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            errors.append("historical catalog: entry must be an object")
            continue
        identity = entry.get("id", "")
        if not isinstance(identity, str) or not _ID.fullmatch(identity) or identity in ids:
            errors.append(f"historical catalog: invalid or duplicate id {identity!r}")
        else:
            ids.add(identity)
        label = f"historical catalog {identity}"
        if entry.get("owner") not in {"shared", *VENDORS}:
            errors.append(f"{label}: unknown owner {entry.get('owner')!r}")
        status = entry.get("status")
        if status not in _STATUSES:
            errors.append(f"{label}: unknown status {status!r}")
        commits = entry.get("commits")
        if not isinstance(commits, list) or not commits or any(
            not isinstance(sha, str) or not _SHA.fullmatch(sha) for sha in commits
        ):
            errors.append(f"{label}: commits must contain hexadecimal SHA references")
        if not isinstance(entry.get("guarantee"), str) or not entry["guarantee"].strip():
            errors.append(f"{label}: guarantee is required")
        provenance = entry.get("provenance")
        if not isinstance(provenance, dict) or not all(provenance.get(key) for key in ("kind", "sources", "notes")):
            errors.append(f"{label}: fixture provenance is required")
        elif status == "active" and provenance["kind"] not in {"synthetic", "native-os"}:
            errors.append(f"{label}: source-only evidence cannot qualify as executable coverage")
        if not isinstance(entry.get("limitations"), list):
            errors.append(f"{label}: limitations must be explicit")
        cases = entry.get("cases")
        if not isinstance(cases, list):
            errors.append(f"{label}: cases must be a list")
            continue
        if status == "active" and not cases:
            errors.append(f"{label}: active regression has no executable cases")
        if status != "active" and cases:
            errors.append(f"{label}: non-executable evidence cannot claim cases")
        if status == "superseded" and not entry.get("superseded_by"):
            errors.append(f"{label}: superseded_by is required")
        for case in cases:
            if not isinstance(case, dict):
                errors.append(f"{label}: case must be an object")
                continue
            nodeid = case.get("nodeid")
            if not isinstance(nodeid, str) or not nodeid.startswith("tests/") or ".py::" not in nodeid or ".." in nodeid:
                errors.append(f"{label}: invalid backend test nodeid {nodeid!r}")
            elif nodeid in references:
                errors.append(f"{label}: duplicate case reference {nodeid}")
            else:
                references.add(nodeid)
            requires = case.get("requires")
            if not isinstance(requires, list) or any(cap not in _CAPABILITIES for cap in requires):
                errors.append(f"{label}: unknown or missing capability requirements {requires!r}")
            elif set(requires) == _CAPABILITIES:
                errors.append(f"{label}: mutually exclusive terminal capabilities")
    if errors or collected_nodeids is None:
        return errors
    collected = set(collected_nodeids)
    for nodeid, identity in required_cases(data, platform).items():
        if not any(matches_nodeid(nodeid, actual) for actual in collected):
            errors.append(f"historical catalog {identity}: required case not collected: {nodeid}")
    return errors
