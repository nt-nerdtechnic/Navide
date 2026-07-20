"""Plugin host loader and lifecycle tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.plugins.host import (
    HOST_API_VERSION,
    PluginContext,
    PluginError,
    PluginHost,
)
from agent_team_backend.plugins.manifest import Manifest

NOOP_PLUGIN_DIR = (
    Path(__file__).resolve().parents[1]
    / "agent_team_backend"
    / "plugins"
    / "examples"
    / "noop_plugin"
)


def _write_plugin(directory: Path, manifest: dict, backend: str = "") -> Path:
    """Materialize a plugin dir with a manifest and an (optional) backend.py."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
    (directory / "backend.py").write_text(backend, encoding="utf-8")
    return directory


def test_load_noop_plugin_succeeds_without_activating() -> None:
    host = PluginHost()

    loaded = host.load(NOOP_PLUGIN_DIR)

    assert isinstance(loaded.manifest, Manifest)
    assert loaded.manifest.id == "navide.noop"
    assert loaded.activated is False
    assert isinstance(loaded.context, PluginContext)
    assert loaded.context.plugin_dir == NOOP_PLUGIN_DIR
    # activate() hook must not have run at load time.
    assert loaded.module.calls == []


def test_activate_invokes_hook_with_context() -> None:
    host = PluginHost()
    loaded = host.load(NOOP_PLUGIN_DIR)

    host.activate("navide.noop")

    assert loaded.activated is True
    assert loaded.module.calls == ["activate"]
    assert loaded.module.received_context is loaded.context
    assert loaded.module.received_context.manifest.id == "navide.noop"


def test_activate_is_idempotent() -> None:
    host = PluginHost()
    loaded = host.load(NOOP_PLUGIN_DIR)

    host.activate("navide.noop")
    host.activate("navide.noop")

    assert loaded.module.calls == ["activate"]


def test_context_carries_placeholder_capabilities() -> None:
    host = PluginHost()
    loaded = host.load(NOOP_PLUGIN_DIR)

    # Capability injection is deferred to p2-capability-api; empty for now.
    assert loaded.context.capabilities == {}


def test_deactivate_invokes_hook() -> None:
    host = PluginHost()
    loaded = host.load(NOOP_PLUGIN_DIR)
    host.activate("navide.noop")

    host.deactivate("navide.noop")

    assert loaded.activated is False
    assert loaded.module.calls == ["activate", "deactivate"]


def test_deactivate_without_activate_is_noop() -> None:
    host = PluginHost()
    loaded = host.load(NOOP_PLUGIN_DIR)

    host.deactivate("navide.noop")

    assert loaded.activated is False
    assert loaded.module.calls == []


def test_unload_removes_plugin() -> None:
    host = PluginHost()
    host.load(NOOP_PLUGIN_DIR)

    host.unload("navide.noop")

    assert host.get("navide.noop") is None
    assert host.list_loaded() == []


def test_unload_deactivates_active_plugin_first() -> None:
    host = PluginHost()
    loaded = host.load(NOOP_PLUGIN_DIR)
    host.activate("navide.noop")

    host.unload("navide.noop")

    assert loaded.module.calls == ["activate", "deactivate"]
    assert host.get("navide.noop") is None


def test_list_loaded_reflects_state() -> None:
    host = PluginHost()
    assert host.list_loaded() == []

    host.load(NOOP_PLUGIN_DIR)
    manifests = host.list_loaded()
    assert [m.id for m in manifests] == ["navide.noop"]

    host.unload("navide.noop")
    assert host.list_loaded() == []


def test_incompatible_engines_rejected(tmp_path: Path) -> None:
    directory = _write_plugin(
        tmp_path / "bad_engine",
        {
            "id": "navide.badengine",
            "name": "Bad Engine",
            "version": "0.1.0",
            "publisher": "navide",
            "engines": {"navide": "^9.0.0"},
        },
    )

    host = PluginHost()
    with pytest.raises(PluginError, match="host API"):
        host.load(directory)


def test_missing_navide_engine_rejected(tmp_path: Path) -> None:
    directory = _write_plugin(
        tmp_path / "no_engine",
        {
            "id": "navide.noengine",
            "name": "No Engine",
            "version": "0.1.0",
            "publisher": "navide",
            "engines": {"node": "^18.0.0"},
        },
    )

    host = PluginHost()
    with pytest.raises(PluginError, match="engines.navide"):
        host.load(directory)


def test_duplicate_id_rejected() -> None:
    host = PluginHost()
    host.load(NOOP_PLUGIN_DIR)

    with pytest.raises(PluginError, match="already loaded"):
        host.load(NOOP_PLUGIN_DIR)


def test_missing_backend_entry_rejected(tmp_path: Path) -> None:
    directory = tmp_path / "no_backend"
    directory.mkdir()
    (directory / "plugin.json").write_text(
        json.dumps(
            {
                "id": "navide.nobackend",
                "name": "No Backend",
                "version": "0.1.0",
                "publisher": "navide",
                "engines": {"navide": "^0.1.0"},
            }
        ),
        encoding="utf-8",
    )

    host = PluginHost()
    with pytest.raises(PluginError, match="backend"):
        host.load(directory)


def test_activate_unknown_plugin_rejected() -> None:
    host = PluginHost()
    with pytest.raises(PluginError, match="not loaded"):
        host.activate("navide.ghost")


def test_host_api_version_satisfies_example_requirement() -> None:
    # Sanity: the shipped no-op plugin targets a range this host satisfies.
    manifest = PluginHost().load(NOOP_PLUGIN_DIR).manifest
    assert manifest.engines["navide"] == "^0.1.0"
    assert HOST_API_VERSION == "0.1.0"
