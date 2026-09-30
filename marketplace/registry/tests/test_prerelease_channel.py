"""Pre-release channel (Phase 4): the channel rule, stable-only
`latest_version`, and FORMAT.md agreeing with the manifest models."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from registry.manifest import ManifestError, parse_manifest
from registry.versions import (
    latest_prerelease_version,
    latest_stable_version,
    version_channel,
)
from tests.fixtures import build_v2_package, contract_manifest, valid_manifest

FORMAT_MD = Path(__file__).parents[1] / "FORMAT.md"


def _publish(client: TestClient, version: str, ident: str = "acme.files") -> None:
    manifest = copy.deepcopy(contract_manifest())
    manifest.update(id=ident, publisher=ident.split(".")[0], version=version)
    resp = client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", build_v2_package(manifest), "application/zip")},
    )
    assert resp.status_code == 201, resp.text


@pytest.mark.parametrize(
    ("version", "channel"),
    [
        ("1.0.0", "stable"),
        ("1.0.0+build.7", "stable"),
        ("1.0.0-beta.1", "pre-release"),
        ("1.0.0-rc.1+build.2", "pre-release"),
        ("1.0.0-0", "pre-release"),
    ],
)
def test_version_channel(version: str, channel: str) -> None:
    assert version_channel(version) == channel


def test_latest_stable_and_prerelease_selection() -> None:
    assert latest_stable_version(["1.0.0", "1.1.0-beta.1"]) == "1.0.0"
    assert latest_prerelease_version(["1.0.0", "1.1.0-beta.1"]) == "1.1.0-beta.1"
    # A stable release newer than every pre-release leaves none to offer.
    assert latest_prerelease_version(["1.1.0", "1.1.0-beta.1"]) is None
    # Pre-release-only: it is the only thing there is to list.
    assert latest_stable_version(["0.1.0-alpha.1", "0.1.0-alpha.2"]) == "0.1.0-alpha.2"
    assert latest_stable_version([]) is None
    assert latest_prerelease_version([]) is None


def test_stable_user_is_never_pointed_at_a_prerelease(client: TestClient) -> None:
    _publish(client, "1.0.0")
    _publish(client, "1.1.0-beta.1")
    item = client.get("/api/extensions").json()["items"][0]
    assert item["latest_version"] == "1.0.0"
    assert item["latest_prerelease_version"] == "1.1.0-beta.1"
    detail = client.get("/api/extensions/acme/files").json()
    assert detail["latest_version"] == "1.0.0"
    channels = {v["version"]: v["channel"] for v in detail["versions"]}
    assert channels == {"1.0.0": "stable", "1.1.0-beta.1": "pre-release"}
    # The README and changelog follow the stable latest too.
    assert client.get("/api/extensions/acme/files/readme").json()["version"] == "1.0.0"


def test_newer_stable_supersedes_the_prerelease(client: TestClient) -> None:
    _publish(client, "1.0.0")
    _publish(client, "1.1.0-beta.1")
    _publish(client, "1.1.0")
    item = client.get("/api/extensions").json()["items"][0]
    assert item["latest_version"] == "1.1.0"
    assert item["latest_prerelease_version"] is None


def test_prerelease_only_extension_stays_listed(client: TestClient) -> None:
    _publish(client, "0.1.0-alpha.1")
    item = client.get("/api/extensions").json()["items"][0]
    assert item["latest_version"] == "0.1.0-alpha.1"
    assert item["latest_prerelease_version"] == "0.1.0-alpha.1"


def test_format_md_matches_the_manifest_models() -> None:
    """FORMAT.md used to say "no pre-release" without saying that is v1-only
    while v2 accepts pre-releases (p4-format-md-fix)."""
    text = FORMAT_MD.read_text(encoding="utf-8")
    version_row = next(line for line in text.splitlines() if line.startswith("| `version` |"))
    assert "Manifest v1" in version_row and "Manifest v2" in version_row
    assert "## Release channels" in text
    assert "`2.5.0-beta.1`) is a **pre-release**" in text

    with pytest.raises(ManifestError):
        parse_manifest(valid_manifest(version="1.0.0-beta.1"))
    manifest = copy.deepcopy(contract_manifest())
    manifest["version"] = "2.5.0-beta.1"
    assert parse_manifest(manifest).version == "2.5.0-beta.1"
