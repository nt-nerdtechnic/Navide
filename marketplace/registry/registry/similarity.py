"""Look-alike checks for namespaces and extension names (Phase 2).

Two tiers, following the plan's risk note that blocking must stay narrow:

- block: the name reads as a reserved name or as someone else's name once
  look-alike characters are folded (`nav1de` -> `navide`, `navide-git` ->
  `navidegit` == `navide.git`), or is one edit away from a reserved name.
- warn: merely similar (ratio >= WARN_RATIO) to another extension; left to
  the reviewer, and marked when it is the same publisher's own extension.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable

RESERVED_NAMESPACES: frozenset[str] = frozenset(
    {
        "navide",
        "official",
        "admin",
        "administrator",
        "root",
        "system",
        "registry",
        "marketplace",
        "support",
        "security",
        "moderator",
        "agent-team",
        "anthropic",
        "claude",
        "openai",
        "microsoft",
        "vscode",
        "github",
    }
)
"""Namespaces nobody can claim; `navide` stays with the admin (official)."""

NAMESPACE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$")
"""3-32 chars, lowercase, digits and inner hyphens (a subset of the manifest
id grammar, so every claimable namespace is a valid package-id prefix)."""

WARN_RATIO = 0.8

_FOLD = str.maketrans(
    {"0": "o", "1": "l", "!": "l", "|": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "$": "s", "@": "a"}
)
_SEPARATORS = re.compile(r"[-_.\s]+")


def skeleton(value: str) -> str:
    """Fold look-alike characters and drop separators.

    `i` and `l` are folded together because `1` stands in for either.
    """
    folded = _SEPARATORS.sub("", value.lower().translate(_FOLD))
    return folded.replace("rn", "m").replace("vv", "w").replace("i", "l")


def edit_distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(
                min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb))
            )
        previous = current
    return previous[-1]


def _near_reserved(value: str) -> str | None:
    shape = skeleton(value)
    for reserved in sorted(RESERVED_NAMESPACES):
        target = skeleton(reserved)
        if shape == target or (len(target) >= 5 and edit_distance(shape, target) <= 1):
            return reserved
    return None


@dataclass(frozen=True)
class ClaimVerdict:
    ok: bool
    message: str


def check_namespace_claim(name: str, existing: Iterable[str]) -> ClaimVerdict:
    """Can `name` be claimed? `existing` is every namespace already taken."""
    if not NAMESPACE_RE.fullmatch(name):
        return ClaimVerdict(
            False,
            "Use 3-32 lowercase letters, digits and inner hyphens.",
        )
    taken = set(existing)
    if name in RESERVED_NAMESPACES:
        return ClaimVerdict(False, f"“{name}” is a reserved name.")
    if name in taken:
        return ClaimVerdict(False, f"“{name}” is already taken.")
    reserved = _near_reserved(name)
    if reserved is not None:
        return ClaimVerdict(
            False,
            f"“{name}” would look like the reserved name {reserved} — blocked. "
            "Try another name.",
        )
    shape = skeleton(name)
    for other in sorted(taken):
        if skeleton(other) == shape:
            return ClaimVerdict(
                False,
                f"“{name}” would look like the existing namespace {other} — "
                "blocked. Try another name.",
            )
    return ClaimVerdict(True, "No look-alike found.")


@dataclass(frozen=True)
class NameFinding:
    tier: str
    """'block' or 'warn'."""
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"tier": self.tier, "message": self.message}


def check_extension_name(
    namespace: str,
    name: str,
    others: Iterable[tuple[str, str]],
    *,
    official_namespaces: Iterable[str] = ("navide",),
    strict: bool = False,
) -> list[NameFinding]:
    """Compare `namespace.name` with every other known extension.

    `others` is (namespace, name) of existing extensions; the submission's own
    identity is skipped. An extension name that folds to another publisher's
    full identity (`zzz.navide-git` vs `navide.git`) or to a first-party
    extension's name is blocked; a close ratio is a warning. `strict` (native
    backend packages) also warns on names within two edits of another
    publisher's extension.
    """
    findings: list[NameFinding] = []
    official = set(official_namespaces)
    own_shape = skeleton(name)
    for other_ns, other_name in sorted(set(others)):
        if (other_ns, other_name) == (namespace, name):
            continue
        other_identity = f"{other_ns}.{other_name}"
        if other_ns != namespace and (
            own_shape == skeleton(other_ns + other_name)
            or (other_ns in official and own_shape == skeleton(other_name))
        ):
            label = "reserved first-party name" if other_ns in official else "another publisher"
            findings.append(
                NameFinding("block", f"looks like {other_identity} ({label})")
            )
            continue
        ratio = SequenceMatcher(None, name, other_name).ratio()
        if ratio >= WARN_RATIO:
            owner = (
                "same publisher — likely OK"
                if other_ns == namespace
                else "different publisher"
            )
            findings.append(
                NameFinding(
                    "warn",
                    f"“{name}” is {round(ratio * 100)}% similar to "
                    f"{other_identity} ({owner})",
                )
            )
        elif strict and other_ns != namespace and edit_distance(name, other_name) <= 2:
            findings.append(
                NameFinding(
                    "warn",
                    f"“{name}” is within two edits of {other_identity} "
                    "(different publisher; native backend packages get the stricter check)",
                )
            )
    # Reserved words hard-block namespaces only. In an extension name
    # (acme.security, acme.support) they are often legitimate, so the
    # reviewer decides.
    if namespace not in official:
        reserved = _near_reserved(name)
        if reserved is not None:
            findings.append(
                NameFinding(
                    "warn",
                    f"“{name}” resembles the reserved name {reserved} — confirm it "
                    "does not impersonate Navide",
                )
            )
    return findings
