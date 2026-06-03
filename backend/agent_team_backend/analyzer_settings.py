"""Global analyzer settings — backend mode, Ollama URL, llama-cli override."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from .applog import app_data_dir

log = logging.getLogger("agent_team_backend.analyzer_settings")

SETTINGS_FILE = "analyzer_settings.json"

DEFAULTS: dict[str, Any] = {
    "backend": "ollama",              # "llama_cpp" | "ollama"
    "ollama_base_url": "http://localhost:11434",
    "llama_cli": "",                  # empty → auto-detect from PATH
    "gguf_path": "",                  # empty → resolve via Ollama manifest; set to use a local .gguf directly
}


class AnalyzerSettingsStore:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (app_data_dir() / SETTINGS_FILE)

    def get(self) -> dict[str, Any]:
        if not self._path.exists():
            return dict(DEFAULTS)
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                return dict(DEFAULTS)
            merged = dict(DEFAULTS)
            for k in DEFAULTS:
                if k in raw:
                    merged[k] = raw[k]
            return merged
        except Exception as err:
            log.warning("analyzer settings read error (%s); using defaults", err)
            return dict(DEFAULTS)

    def set(self, updates: dict[str, Any]) -> dict[str, Any]:
        current = self.get()
        for key, value in updates.items():
            if key in DEFAULTS:
                current[key] = value
        if current.get("backend") not in ("llama_cpp", "ollama"):
            current["backend"] = "llama_cpp"
        self._write(current)
        log.info("analyzer settings saved: %s", current)
        return current

    def _write(self, data: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self._path)
