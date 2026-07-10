"""Per-workspace AI chat persistence under `<workspace>/.agent-team/`.

Two whole-document JSON files, replaced atomically on every save (the frontend
already serializes the full thread array / notes document):
  - chat-threads.json   list of chat thread records
  - chat-notes.json     {"notes": str, "notepads": list} (quick notes + named notepads)
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from .projects import PROJECT_DIR_NAME, ensure_workspace_data_dir

log = logging.getLogger("agent_team_backend.chat_store")

THREADS_FILE = "chat-threads.json"
NOTES_FILE = "chat-notes.json"
# Chat history was previously bounded by the renderer's localStorage quota
# (~10 MB); 8 MB keeps any real dataset loadable while still rejecting
# runaway/corrupt files.
MAX_FILE_BYTES = 8_388_608

NOTES_DEFAULTS: dict[str, Any] = {"notes": "", "notepads": []}


class ChatStore:
    """Atomic whole-document JSON storage for chat threads + notes."""

    def _file(self, workspace_path: str, name: str) -> Path | None:
        """Resolve the storage file, or None for a missing/invalid workspace."""
        if not workspace_path:
            return None
        ws = os.path.abspath(workspace_path)
        if not os.path.isdir(ws):
            return None
        return Path(ws) / PROJECT_DIR_NAME / name

    def _read(self, workspace_path: str, name: str) -> Any:
        f = self._file(workspace_path, name)
        if f is None or not f.exists():
            return None
        try:
            if f.stat().st_size > MAX_FILE_BYTES:
                raise ValueError(f"{name} exceeds size limit")
            return json.loads(f.read_text(encoding="utf-8"))
        except Exception as err:  # noqa: BLE001
            log.warning("%s at %s is unreadable (%s); using defaults", name, f, err)
            return None

    def _write(self, workspace_path: str, name: str, doc: Any) -> Path | None:
        f = self._file(workspace_path, name)
        if f is None:
            return None
        ensure_workspace_data_dir(str(f.parent.parent))
        tmp = f.with_suffix(f.suffix + ".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, f)
        return f

    def get_threads(self, workspace_path: str) -> list[Any]:
        data = self._read(workspace_path, THREADS_FILE)
        return data if isinstance(data, list) else []

    def set_threads(self, workspace_path: str, threads: list[Any]) -> Path | None:
        return self._write(workspace_path, THREADS_FILE, list(threads))

    def get_notes(self, workspace_path: str) -> dict[str, Any]:
        data = self._read(workspace_path, NOTES_FILE)
        if not isinstance(data, dict):
            return dict(NOTES_DEFAULTS)
        notes = data.get("notes")
        notepads = data.get("notepads")
        return {
            "notes": notes if isinstance(notes, str) else "",
            "notepads": notepads if isinstance(notepads, list) else [],
        }

    def set_notes(
        self, workspace_path: str, *, notes: str, notepads: list[Any]
    ) -> Path | None:
        return self._write(
            workspace_path, NOTES_FILE, {"notes": notes, "notepads": list(notepads)}
        )
