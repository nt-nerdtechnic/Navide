"""FORMAT.md describes Manifest v2 from the code: every documented field is a
model field and the reverse, and the limits and target rules it states are the
ones the reader enforces. (Release channels: test_prerelease_channel.py.)"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from registry import package
from registry.manifest import ManifestError, parse_manifest
from registry.manifest_v2 import (
    MAX_EXTENSION_PACK_MEMBERS,
    V2_SHELL_MODES,
    V2_SYSTEM_NAMESPACES,
    ManifestV2,
    ManifestV2Backend,
    ManifestV2Marketplace,
    ManifestV2Permissions,
    ManifestV2View,
)
from registry.package import backend_entry_for_target
from tests.fixtures import contract_manifest

TEXT = (Path(__file__).parents[1] / "FORMAT.md").read_text(encoding="utf-8")


def _section(heading: str) -> str:
    start = TEXT.index(f"\n{heading}\n")
    end = TEXT.find("\n#", start + len(heading) + 2)
    return TEXT[start : end if end >= 0 else len(TEXT)]


def _table_fields(section: str) -> set[str]:
    return set(re.findall(r"^\| `([A-Za-z]+)` \|", section, flags=re.MULTILINE))


@pytest.mark.parametrize(
    ("heading", "model"),
    [
        ("## `manifest.json` (Manifest v2)", ManifestV2),
        ("### `permissions`", ManifestV2Permissions),
        ("### `marketplace`", ManifestV2Marketplace),
        ("### `contributes.views[]`", ManifestV2View),
        ("### `backend`", ManifestV2Backend),
    ],
)
def test_documented_fields_are_exactly_the_model_fields(heading: str, model: type) -> None:
    assert _table_fields(_section(heading)) == set(model.model_fields)


def test_v1_is_marked_legacy() -> None:
    assert "## Legacy: Manifest v1" in TEXT
    assert "do not author new v1 packages" in TEXT


def test_documented_enumerations_and_limits_match_the_code() -> None:
    permissions = _section("### `permissions`")
    assert all(f"`{name}`" in permissions for name in V2_SYSTEM_NAMESPACES)
    assert all(f"`{mode}`" in permissions for mode in V2_SHELL_MODES)
    assert f"1-{MAX_EXTENSION_PACK_MEMBERS} member ids" in TEXT
    assert f"lists 1-{MAX_EXTENSION_PACK_MEMBERS} unique member ids" in TEXT
    assert f"at most {package.MAX_ENTRY_SIZE // 2**20} MiB" in TEXT
    assert f"at most {package.MAX_ARCHIVE_SIZE // 2**20} MiB" in TEXT
    for name in package._HOST_OWNED_ARCHIVE_NAMES:
        assert f"`{name}`" in TEXT


def test_windows_backend_entry_rule_matches_the_reader() -> None:
    section = _section("## Targets and backend entry")
    assert "`backend/acme-files.exe`" in section
    assert backend_entry_for_target("backend/acme-files", "win32-x64") == "backend/acme-files.exe"
    assert backend_entry_for_target("backend/acme-files", "darwin-arm64") == "backend/acme-files"
    assert backend_entry_for_target("backend/acme-files.bin", "win32-arm64") == "backend/acme-files.bin"
    for target in ("linux-x64", "linux-arm64", "win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64"):
        assert f"`{target}`" in section


def test_extension_pack_rules_match_the_model() -> None:
    pack = {
        "schemaVersion": 2,
        "apiVersion": "^1.0.0",
        "id": "acme.pack",
        "name": "Pack",
        "version": "1.0.0",
        "publisher": "acme",
        "permissions": {},
        "marketplace": {"description": "A pack.", "license": "MIT"},
        "extensionPack": ["acme.one", "acme.two"],
    }
    assert parse_manifest(pack).extensionPack == ["acme.one", "acme.two"]
    for invalid in (
        {"extensionPack": ["acme.pack"]},
        {"permissions": {"system": ["fs"]}},
        {"extensionPack": [f"acme.m{index}" for index in range(MAX_EXTENSION_PACK_MEMBERS + 1)]},
    ):
        with pytest.raises(ManifestError):
            parse_manifest({**pack, **invalid})


def test_publisher_must_be_the_id_namespace() -> None:
    assert "must equal the first segment of `id`" in TEXT
    manifest = contract_manifest()
    manifest["publisher"] = "someone-else"
    with pytest.raises(ManifestError):
        parse_manifest(manifest)
