"""Backend-owned generic UI settings KV store (renderer localStorage replacement).

Flat JSON object keyed by the legacy localStorage key names (e.g.
"agentTeam.colWidths"). The backend is the single owner of the file; the
Electron main process reads the same file synchronously at startup for
zero-flash bootstrap — the atomic tmp→replace write guarantees it never
observes a torn write.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from .applog import app_data_dir

log = logging.getLogger("agent_team_backend.ui_settings")

SETTINGS_FILE = "ui_settings.json"
_MAX_FILE_SIZE = 524_288  # 512 KB sanity cap (matches projects.py)


class UiSettingsStore:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (app_data_dir() / SETTINGS_FILE)

    @property
    def path(self) -> Path:
        return self._path

    def get(self) -> dict[str, Any]:
        """Return the full settings dict; {} when missing, oversized, or corrupt."""
        if not self._path.exists():
            return {}
        try:
            if self._path.stat().st_size > _MAX_FILE_SIZE:
                raise ValueError("ui_settings.json exceeds size limit")
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("ui_settings.json root is not an object")
            return raw
        except Exception as err:  # noqa: BLE001
            log.warning("ui settings read error (%s); using empty dict", err)
            return {}

    def set(self, updates: dict[str, Any]) -> dict[str, Any]:
        """Shallow-merge `updates` into the stored dict and persist atomically.

        A `None` value deletes the key (remove semantics). Non-string keys are
        ignored. Returns the applied delta (suitable for broadcasting); the
        file is only rewritten when the delta is non-empty.
        """
        current = self.get()
        delta: dict[str, Any] = {}
        for key, value in updates.items():
            if not isinstance(key, str) or not key:
                continue
            if value is None:
                current.pop(key, None)
            else:
                current[key] = value
            delta[key] = value
        if delta:
            self._write(current)
        return delta

    def _write(self, data: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self._path)
