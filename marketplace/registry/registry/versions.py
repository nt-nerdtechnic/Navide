"""Semver ordering helpers (strict MAJOR.MINOR.PATCH)."""

from __future__ import annotations

from packaging.version import Version


def version_key(version: str) -> Version:
    """Sort key for strict semver strings validated by the manifest model."""
    return Version(version)


def latest_version(versions: list[str]) -> str | None:
    """Highest semver, or None for an empty list."""
    if not versions:
        return None
    return max(versions, key=version_key)
