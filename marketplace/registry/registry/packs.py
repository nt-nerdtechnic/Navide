"""Extension Pack nesting check shared by publish and review approval.

A pack member that is itself a pack is refused (which also rules out cycles:
the manifest model already refuses a pack listing itself), and so is a pack
version for an id some pack lists as a member.

At publish (`include_pending=True`) every public or pending, unyanked version
of an extension is considered (pre-releases included), so two submissions
waiting for review cannot list each other. At approval
(`include_pending=False`) the check re-runs against what is public, which is
the state the approved version is about to join.
"""

from __future__ import annotations

from sqlmodel import select

from .discovery import pack_members
from .models import Extension
from .repository import RegistryRepository

PENDING = "pending"


def _candidate_manifests(
    repo: RegistryRepository, extension: Extension, *, include_pending: bool
) -> list[dict]:
    # Every public, unyanked version counts, stable or pre-release: a user
    # who opts into pre-releases installs whichever one is newest.
    manifests = [v.manifest for v in repo.list_versions(extension.id) if not v.yanked]
    if include_pending:
        manifests += [
            v.manifest
            for v in repo.list_versions(extension.id, public_only=False)
            if v.review_status == PENDING and not v.yanked
        ]
    return manifests


def _is_pack(manifests: list[dict]) -> bool:
    return any(pack_members(m) for m in manifests)


def pack_conflict(
    repo: RegistryRepository,
    identity: str,
    members: list[str] | None,
    *,
    include_pending: bool,
) -> str | None:
    """Why `identity` with these `members` would nest one pack in another."""
    if not members:
        return None
    for member in members:
        namespace, _, name = member.partition(".")
        extension = repo.get_extension(namespace, name, public_only=not include_pending)
        if extension is not None and _is_pack(
            _candidate_manifests(repo, extension, include_pending=include_pending)
        ):
            return f"extension pack member {member} is itself an extension pack"
    if include_pending:
        others = repo.session.exec(select(Extension)).all()
    else:
        others = repo.search_extensions(limit=10**9)[0]
    for other in others:
        if other.identity == identity:
            continue
        for manifest in _candidate_manifests(repo, other, include_pending=include_pending):
            if identity in (pack_members(manifest) or []):
                return (
                    f"{identity} is a member of extension pack {other.identity}; "
                    "a pack member cannot itself be a pack"
                )
    return None
