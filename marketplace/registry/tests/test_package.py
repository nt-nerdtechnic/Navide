from __future__ import annotations

import pytest

from registry.package import PackageError, read_package
from tests.fixtures import build_package, valid_manifest


def test_read_valid_package() -> None:
    loaded = read_package(build_package())
    assert loaded.manifest.id == "acme.hello"
    assert len(loaded.digest) == 64
    paths = {a.path for a in loaded.assets}
    assert "README.md" in paths
    assert "icon.png" in paths
    assert "manifest.json" not in paths


def test_digest_is_stable() -> None:
    data = build_package()
    assert read_package(data).digest == read_package(data).digest


def test_not_a_zip_rejected() -> None:
    with pytest.raises(PackageError, match="ZIP"):
        read_package(b"not a zip file")


def test_missing_manifest_rejected() -> None:
    with pytest.raises(PackageError, match="missing manifest.json"):
        read_package(build_package(omit_manifest=True))


def test_invalid_json_manifest_rejected() -> None:
    with pytest.raises(PackageError, match="not valid JSON"):
        read_package(build_package(manifest_bytes=b"{not json"))


def test_invalid_manifest_rejected() -> None:
    with pytest.raises(PackageError, match="invalid manifest"):
        read_package(build_package(manifest=valid_manifest(version="bad")))


def test_missing_icon_asset_rejected() -> None:
    with pytest.raises(PackageError, match="icon"):
        read_package(build_package(include_icon=False))


def test_manifest_without_icon_allows_missing_file() -> None:
    manifest = valid_manifest()
    del manifest["icon"]
    loaded = read_package(build_package(manifest=manifest, include_icon=False))
    assert loaded.manifest.icon is None
