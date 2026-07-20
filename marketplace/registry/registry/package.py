"""Reader/validator for `.vsix`-style plugin packages (see FORMAT.md)."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import zipfile
from dataclasses import dataclass, field
from io import BytesIO

from .manifest import Manifest, ManifestError, parse_manifest

MANIFEST_NAME = "manifest.json"


class PackageError(ValueError):
    """Raised when an archive is not a valid plugin package."""


@dataclass(frozen=True)
class AssetRef:
    """A non-manifest file inside the package."""

    path: str
    size: int
    content_type: str


@dataclass
class LoadedPackage:
    manifest: Manifest
    digest: str
    """sha256 hex digest of the raw package bytes."""
    assets: list[AssetRef] = field(default_factory=list)
    raw: bytes = b""


def read_package(data: bytes) -> LoadedPackage:
    """Parse and validate a `.vsix`-style archive.

    Rejects malformed archives with a clear PackageError.
    """
    if not zipfile.is_zipfile(BytesIO(data)):
        raise PackageError("package is not a valid ZIP archive")

    with zipfile.ZipFile(BytesIO(data)) as zf:
        names = set(zf.namelist())
        if MANIFEST_NAME not in names:
            raise PackageError(f"archive is missing {MANIFEST_NAME} at its root")

        try:
            manifest_bytes = zf.read(MANIFEST_NAME)
        except KeyError as exc:  # pragma: no cover - guarded above
            raise PackageError(f"cannot read {MANIFEST_NAME}") from exc

        try:
            manifest_data = json.loads(manifest_bytes)
        except json.JSONDecodeError as exc:
            raise PackageError(f"{MANIFEST_NAME} is not valid JSON: {exc}") from exc

        if not isinstance(manifest_data, dict):
            raise PackageError(f"{MANIFEST_NAME} must be a JSON object")

        try:
            manifest = parse_manifest(manifest_data)
        except ManifestError as exc:
            raise PackageError(f"invalid manifest: {exc}") from exc

        if manifest.icon and manifest.icon not in names:
            raise PackageError(
                f"manifest.icon '{manifest.icon}' is not present in the archive"
            )

        assets: list[AssetRef] = []
        for info in zf.infolist():
            if info.is_dir() or info.filename == MANIFEST_NAME:
                continue
            content_type = (
                mimetypes.guess_type(info.filename)[0]
                or "application/octet-stream"
            )
            assets.append(
                AssetRef(
                    path=info.filename,
                    size=info.file_size,
                    content_type=content_type,
                )
            )

    digest = hashlib.sha256(data).hexdigest()
    return LoadedPackage(
        manifest=manifest,
        digest=digest,
        assets=sorted(assets, key=lambda a: a.path),
        raw=data,
    )
