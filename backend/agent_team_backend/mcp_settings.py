"""Validated MCP server settings persistence.

The app is local-first, so MCP settings are stored as an atomic JSON document
under the app-data directory instead of a relational table.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator

from .applog import app_data_dir

log = logging.getLogger("agent_team_backend.mcp_settings")

MCP_CONFIG_FILE = "mcp_servers.json"

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")


def default_mcp_servers() -> list[dict[str, Any]]:
    return [
        {
            "name": "context7",
            "command": "npx",
            "args": ["-y", "@upstash/context7-mcp"],
            "env": {},
            "enabled": True,
        }
    ]


class MCPServerSetting(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    command: str = Field(min_length=1, max_length=256)
    args: list[str] = Field(default_factory=list, max_length=64)
    env: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        normalized = value.strip()
        if not _NAME_RE.match(normalized):
            raise ValueError("name must be lowercase letters, digits, underscore or dash")
        return normalized

    @field_validator("command")
    @classmethod
    def validate_command(cls, value: str) -> str:
        normalized = value.strip()
        if _CONTROL_CHARS_RE.search(normalized):
            raise ValueError("command must not contain control characters")
        return normalized

    @field_validator("args")
    @classmethod
    def validate_args(cls, values: list[str]) -> list[str]:
        clean: list[str] = []
        for arg in values:
            if not isinstance(arg, str):
                raise ValueError("args must be strings")
            if len(arg) > 512 or _CONTROL_CHARS_RE.search(arg):
                raise ValueError("args must not contain control characters")
            clean.append(arg)
        return clean

    @field_validator("env")
    @classmethod
    def validate_env(cls, value: dict[str, str]) -> dict[str, str]:
        clean: dict[str, str] = {}
        for key, env_value in value.items():
            if not _ENV_KEY_RE.match(key):
                raise ValueError(f"invalid env key: {key}")
            if not isinstance(env_value, str):
                raise ValueError("env values must be strings")
            if len(env_value) > 4096 or _CONTROL_CHARS_RE.search(env_value):
                raise ValueError("env values must not contain control characters")
            clean[key] = env_value
        return clean


class MCPServersDocument(BaseModel):
    servers: list[MCPServerSetting] = Field(default_factory=list, max_length=32)

    @model_validator(mode="after")
    def validate_unique_names(self) -> "MCPServersDocument":
        names = [server.name for server in self.servers]
        if len(names) != len(set(names)):
            raise ValueError("server names must be unique")
        return self


class MCPSettingsStore:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (app_data_dir() / MCP_CONFIG_FILE)

    @property
    def path(self) -> Path:
        return self._path

    def list_servers(self) -> list[dict[str, Any]]:
        return [server.model_dump() for server in self._read_document().servers]

    def list_enabled(self) -> list[dict[str, Any]]:
        return [server for server in self.list_servers() if server.get("enabled", True)]

    def replace_servers(self, servers: list[dict[str, Any]]) -> list[dict[str, Any]]:
        document = MCPServersDocument(servers=servers)
        self._write_document(document)
        log.info("MCP settings saved: %d server(s)", len(document.servers))
        return [server.model_dump() for server in document.servers]

    def reset(self) -> list[dict[str, Any]]:
        document = MCPServersDocument(servers=default_mcp_servers())
        self._write_document(document)
        return [server.model_dump() for server in document.servers]

    def _read_document(self) -> MCPServersDocument:
        if not self._path.exists():
            document = MCPServersDocument(servers=default_mcp_servers())
            self._write_document(document)
            return document
        _MCP_SIZE_LIMIT = 1_000_000
        try:
            if self._path.stat().st_size > _MCP_SIZE_LIMIT:
                raise ValueError("MCP config file exceeds 1 MB — regenerating defaults")
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                return MCPServersDocument(servers=raw)
            if isinstance(raw, dict):
                return MCPServersDocument.model_validate(raw)
            raise ValueError("mcp config must be a JSON array or object")
        except Exception as err:  # noqa: BLE001
            log.warning("MCP settings invalid (%s); regenerating defaults", err)
            document = MCPServersDocument(servers=default_mcp_servers())
            self._write_document(document)
            return document

    def _write_document(self, document: MCPServersDocument) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        payload = [server.model_dump() for server in document.servers]
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self._path)
