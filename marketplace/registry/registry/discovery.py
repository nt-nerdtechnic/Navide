"""Discovery facts derived from stored manifests: the closed category list,
Navide engine compatibility and presentation links.

Everything here is computed from the frozen manifest snapshot of a version
row, so none of it needs a schema change.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

from .versions import _V2_VERSION_RE, compare_semver

# The closed category list the marketplace filters by, in display order.
# Manifest categories stay free-form slugs; one outside this list is shown
# under `other`, so no existing package is rejected or hidden.
CATEGORIES: tuple[tuple[str, str], ...] = (
    ("productivity", "Productivity"),
    ("version-control", "Version control"),
    ("themes", "Themes"),
    ("ai", "AI"),
    ("extension-packs", "Extension Packs"),
    ("other", "Other"),
)
PACK_CATEGORY = "extension-packs"
CATEGORY_SLUGS: frozenset[str] = frozenset(slug for slug, _label in CATEGORIES)
OTHER_CATEGORY = "other"


def in_category(categories: list[str], wanted: str) -> bool:
    """Whether an extension with `categories` belongs under `wanted`.

    `other` collects extensions tagged `other` and those carrying no category
    from the closed list; any other slug matches case-insensitively.
    """
    lowered = [category.lower() for category in categories]
    wanted = wanted.lower()
    if wanted == OTHER_CATEGORY:
        return OTHER_CATEGORY in lowered or not (CATEGORY_SLUGS & set(lowered))
    return wanted in lowered


# `engines.navide` names the lowest Navide release a version supports, the way
# VS Code reads `engines.vscode`: `^0.2.9`, `~0.2.9`, `>=0.2.9` and a bare
# `0.2.9` all mean "0.2.9 or newer", and `*` means any release. Upper bounds
# are not enforced, so a package keeps working on newer Navide releases.
_ENGINE_RANGE_RE = re.compile(r"^\s*(?:\^|~|>=)?\s*(\S+)\s*$")


def engine_requirement(manifest: Mapping[str, object]) -> str | None:
    engines = manifest.get("engines")
    if not isinstance(engines, Mapping):
        return None
    value = engines.get("navide")
    return value if isinstance(value, str) else None


def min_navide_version(requirement: str | None) -> str | None:
    """The lowest Navide version `requirement` accepts, `0.0.0` for `*`, or
    None when the requirement is absent or not a form this rule reads."""
    if requirement is None:
        return None
    if requirement.strip() == "*":
        return "0.0.0"
    match = _ENGINE_RANGE_RE.fullmatch(requirement)
    if match is None or _V2_VERSION_RE.fullmatch(match.group(1)) is None:
        return None
    return match.group(1)


def is_navide_version(value: str) -> bool:
    return _V2_VERSION_RE.fullmatch(value) is not None


def engine_compatible(requirement: str | None, navide_version: str | None) -> bool | None:
    """True/False against `navide_version`; None when either side is unknown
    (no client version sent, or a requirement this rule cannot read)."""
    if navide_version is None:
        return None
    minimum = min_navide_version(requirement)
    if minimum is None:
        return None
    return compare_semver(navide_version, minimum) >= 0


def marketplace_links(manifest: Mapping[str, object]) -> dict[str, str | None]:
    """License, repository and homepage from a v2 manifest (None for v1)."""
    marketplace = manifest.get("marketplace")
    if not isinstance(marketplace, Mapping):
        return {"license": None, "repository": None, "homepage": None}

    def text(key: str) -> str | None:
        value = marketplace.get(key)
        return value if isinstance(value, str) else None

    return {
        "license": text("license"),
        "repository": text("repository"),
        "homepage": text("homepage"),
    }


def pack_members(manifest: Mapping[str, object]) -> list[str] | None:
    """The `extensionPack` member ids of a stored manifest, or None."""
    members = manifest.get("extensionPack")
    if isinstance(members, list) and all(isinstance(m, str) for m in members):
        return list(members)
    return None
