"""MCP settings store validation and persistence tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from agent_team_backend.mcp_settings import MCPServersDocument, MCPSettingsStore


def test_store_creates_default_config(tmp_path: Path) -> None:
    path = tmp_path / "mcp_servers.json"
    store = MCPSettingsStore(path)

    servers = store.list_servers()

    assert path.exists()
    assert servers[0]["name"] == "context7"
    assert servers[0]["enabled"] is True


def test_replace_servers_validates_and_persists_atomically(tmp_path: Path) -> None:
    path = tmp_path / "mcp_servers.json"
    store = MCPSettingsStore(path)

    servers = store.replace_servers(
        [
            {
                "name": "docs",
                "command": "npx",
                "args": ["-y", "@vendor/docs-mcp"],
                "env": {"API_TOKEN": "secret"},
                "enabled": False,
            }
        ]
    )

    assert servers == [
        {
            "name": "docs",
            "command": "npx",
            "args": ["-y", "@vendor/docs-mcp"],
            "env": {"API_TOKEN": "secret"},
            "enabled": False,
        }
    ]
    assert json.loads(path.read_text(encoding="utf-8")) == servers
    assert not path.with_suffix(".json.tmp").exists()


def test_duplicate_server_names_are_rejected() -> None:
    with pytest.raises(ValidationError, match="server names must be unique"):
        MCPServersDocument(
            servers=[
                {"name": "ctx", "command": "npx"},
                {"name": "ctx", "command": "node"},
            ]
        )


def test_invalid_env_key_is_rejected() -> None:
    with pytest.raises(ValidationError, match="invalid env key"):
        MCPServersDocument(
            servers=[
                {
                    "name": "ctx",
                    "command": "npx",
                    "env": {"BAD-KEY": "value"},
                }
            ]
        )


def test_corrupt_json_recovers_to_defaults(tmp_path: Path) -> None:
    path = tmp_path / "mcp_servers.json"
    path.write_text("{not valid json", encoding="utf-8")

    servers = MCPSettingsStore(path).list_servers()

    assert servers[0]["name"] == "context7"
    assert json.loads(path.read_text(encoding="utf-8"))[0]["name"] == "context7"
