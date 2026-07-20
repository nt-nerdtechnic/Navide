"""Plugin manifest schema parsing and validation tests."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

from agent_team_backend.plugins.manifest import (
    KNOWN_CAPABILITIES,
    Manifest,
    ManifestError,
    load_manifest,
    parse_manifest,
)

EXAMPLE_MANIFEST = (
    Path(__file__).resolve().parents[1]
    / "agent_team_backend"
    / "plugins"
    / "examples"
    / "mini-ide.plugin.json"
)


def _valid_data() -> dict:
    """A minimal-but-complete valid manifest dict, fresh each call."""
    return {
        "id": "navide.mini-ide",
        "name": "Mini IDE",
        "version": "0.1.0",
        "publisher": "navide",
        "engines": {"navide": "^0.1.0"},
        "requires": ["fs", "git", "terminal"],
        "activationEvents": ["onStartup"],
    }


def test_example_manifest_parses_with_expected_fields() -> None:
    manifest = load_manifest(EXAMPLE_MANIFEST)

    assert isinstance(manifest, Manifest)
    assert manifest.id == "navide.mini-ide"
    assert manifest.name == "Mini IDE"
    assert manifest.version == "0.1.0"
    assert manifest.publisher == "navide"
    assert manifest.engines == {"navide": "^0.1.0"}
    assert manifest.entry == "dist/mini-ide.js"
    assert manifest.requires == ["fs", "git", "terminal", "search", "chat", "ui"]
    assert manifest.activationEvents == ["onStartup"]
    assert manifest.contributes is not None
    assert manifest.contributes.views[0].id == "mini-ide.explorer"
    assert manifest.contributes.views[0].title == "Explorer"
    assert manifest.contributes.commands[0].id == "mini-ide.openFile"


def test_parse_minimal_valid_manifest() -> None:
    manifest = parse_manifest(_valid_data())

    assert manifest.entry is None
    assert manifest.contributes is None


@pytest.mark.parametrize("field", ["id", "name", "version", "publisher", "engines"])
def test_missing_required_field_raises(field: str) -> None:
    data = _valid_data()
    del data[field]

    with pytest.raises(ManifestError) as exc:
        parse_manifest(data)

    assert field in str(exc.value)


def test_non_semver_version_raises() -> None:
    data = _valid_data()
    data["version"] = "1.0"

    with pytest.raises(ManifestError, match="semver"):
        parse_manifest(data)


def test_bad_id_format_raises() -> None:
    data = _valid_data()
    data["id"] = "MiniIDE"

    with pytest.raises(ManifestError, match="publisher"):
        parse_manifest(data)


def test_unknown_capability_raises() -> None:
    data = _valid_data()
    data["requires"] = ["fs", "network"]

    with pytest.raises(ManifestError, match="network"):
        parse_manifest(data)

    assert "network" not in KNOWN_CAPABILITIES


def test_bad_activation_event_raises() -> None:
    data = _valid_data()
    data["activationEvents"] = ["onWhenever"]

    with pytest.raises(ManifestError, match="activationEvent"):
        parse_manifest(data)


def test_view_and_command_activation_events_accepted() -> None:
    data = _valid_data()
    data["activationEvents"] = ["onView:mini-ide.explorer", "onCommand:mini-ide.openFile"]

    manifest = parse_manifest(data)

    assert manifest.activationEvents == [
        "onView:mini-ide.explorer",
        "onCommand:mini-ide.openFile",
    ]


def test_empty_engines_raises() -> None:
    data = _valid_data()
    data["engines"] = {}

    with pytest.raises(ManifestError, match="engines"):
        parse_manifest(data)


def test_parse_non_dict_raises() -> None:
    with pytest.raises(ManifestError, match="object"):
        parse_manifest(["not", "a", "dict"])  # type: ignore[arg-type]


def test_load_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(ManifestError, match="not found"):
        load_manifest(tmp_path / "nope.json")


def test_load_broken_json_raises(tmp_path: Path) -> None:
    path = tmp_path / "plugin.json"
    path.write_text("{ not valid json", encoding="utf-8")

    with pytest.raises(ManifestError, match="not valid JSON"):
        load_manifest(path)


def test_valid_data_helper_is_isolated() -> None:
    # Guard: mutating one call's dict must not affect the next.
    first = _valid_data()
    first["requires"].append("git")
    assert _valid_data()["requires"] == ["fs", "git", "terminal"]
    assert copy.deepcopy(first) is not first
