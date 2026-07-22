"""Full per-workspace spawn history — `.agent-team/spawn-history.json`.

project.json keeps only a 100-entry mirror of the renderer's spawn history
(``Project.ui_spawn_history``) so its read-size cap stays safe. This store
keeps the complete history: ``merge()`` upserts every snapshot the renderer
sends and never deletes older entries, and ``read_page()`` serves pages back
newest-first for the Agent History modal.

File shape: ``{"version": 1, "entries": [...]}`` with entries ordered
oldest → newest (matching the renderer's in-memory order).
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from .projects import PROJECT_DIR_NAME, ensure_workspace_data_dir

log = logging.getLogger("agent_team_backend.spawn_history")

SPAWN_HISTORY_FILE = "spawn-history.json"
# Hard cap so a runaway client cannot grow the file forever; entries past it
# are dropped from the oldest end with a warning.
MAX_ENTRIES = 5000


def canonical_workspace_path(workspace_path: str) -> str:
    """A workspace's on-disk identity: absolute path with symlinks resolved.

    Two spellings of the same folder (e.g. a symlinked alias) canonicalize to
    the same string, so they share one history store and their entries count
    as belonging to each other.
    """
    return os.path.realpath(os.path.abspath(workspace_path))


def is_same_workspace(a: str, b: str) -> bool:
    """True when both paths name the same workspace after canonicalization."""
    return canonical_workspace_path(a) == canonical_workspace_path(b)


def filter_foreign_entries(
    workspace_path: str, entries: list[Any], *, context: str
) -> list[Any]:
    """Drop entries whose ``workspacePath`` names a different workspace.

    The backend must not trust the renderer's payload: a buggy or stale client
    could hand us another workspace's history. Only a present-but-foreign
    ``workspacePath`` string is rejected; entries without one (legacy data)
    and non-dict junk pass through for the caller's own validation. Logs one
    warning per batch that dropped anything.
    """
    target = canonical_workspace_path(workspace_path)
    kept: list[Any] = []
    dropped = 0
    for entry in entries:
        if isinstance(entry, dict):
            entry_ws = entry.get("workspacePath")
            if (
                isinstance(entry_ws, str)
                and entry_ws
                and canonical_workspace_path(entry_ws) != target
            ):
                dropped += 1
                continue
        kept.append(entry)
    if dropped:
        log.warning(
            "dropped %d foreign spawn-history entries for %s (%s)",
            dropped, workspace_path, context,
        )
    return kept


class SpawnHistoryStore:
    """Manages the full spawn-history file for each workspace."""

    def __init__(self) -> None:
        # merge() runs on worker threads (the ws set_ui_state offload), so
        # every read-modify-write is serialized like ProjectStore's saves.
        self._lock = threading.RLock()

    def history_file(self, workspace_path: str) -> Path:
        # Canonical (symlink-resolved) location so every spelling of the same
        # workspace reads and writes the same store file.
        ws = canonical_workspace_path(workspace_path)
        return Path(ws) / PROJECT_DIR_NAME / SPAWN_HISTORY_FILE

    def _load(
        self, workspace_path: str, seed: list[dict[str, Any]] | None
    ) -> list[dict[str, Any]]:
        """Return the stored entries (oldest → newest).

        Missing file → seeded from ``seed`` (the project.json mirror) when
        given: the one-time migration for projects created before the full
        store existed. A corrupt file is preserved as a ``.corrupt`` sibling
        and then treated as missing — never crash on bad data.
        """
        hf = self.history_file(workspace_path)
        if hf.exists():
            try:
                data = json.loads(hf.read_text(encoding="utf-8"))
                entries = data.get("entries") if isinstance(data, dict) else None
                if not isinstance(entries, list):
                    raise ValueError("'entries' is not a list")
                return [e for e in entries if isinstance(e, dict)]
            except Exception as err:  # noqa: BLE001
                backup = hf.with_suffix(hf.suffix + ".corrupt")
                try:
                    os.replace(hf, backup)
                    log.warning(
                        "spawn-history.json at %s is corrupt (%s); kept as %s, starting empty",
                        hf, err, backup.name,
                    )
                except OSError as bak_err:
                    log.warning(
                        "spawn-history.json at %s is corrupt (%s) and backup failed (%s); starting empty",
                        hf, err, bak_err,
                    )
        if seed:
            # The mirror may predate the write-layer filter, so a foreign
            # entry could have been persisted there — never migrate it in.
            return filter_foreign_entries(
                workspace_path,
                [e for e in seed if isinstance(e, dict)],
                context="mirror seed",
            )
        return []

    def _write(self, workspace_path: str, entries: list[dict[str, Any]]) -> None:
        ensure_workspace_data_dir(canonical_workspace_path(workspace_path))
        hf = self.history_file(workspace_path)
        tmp = hf.with_suffix(hf.suffix + ".tmp")
        payload = json.dumps({"version": 1, "entries": entries}, ensure_ascii=False)
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, hf)

    def merge(
        self,
        workspace_path: str,
        entries: list[dict[str, Any]],
        *,
        seed: list[dict[str, Any]] | None = None,
    ) -> int:
        """Upsert renderer snapshot entries into the full store.

        Entries are keyed by ``paneId``: an existing entry is replaced in
        place (the incoming entry is the renderer's authoritative snapshot,
        so replacement also clears fields the renderer removed, e.g. a reset
        customName); unknown paneIds are appended in the given order. Stored
        entries absent from ``entries`` are never deleted. Returns the stored
        total.

        Write-layer isolation: entries whose ``workspacePath`` belongs to a
        different workspace (canonical comparison) are dropped with a warning
        — the store never persists foreign history.
        """
        entries = filter_foreign_entries(workspace_path, entries, context="merge")
        with self._lock:
            stored = self._load(workspace_path, seed)
            index = {
                e.get("paneId"): i
                for i, e in enumerate(stored)
                if isinstance(e.get("paneId"), str)
            }
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                pane_id = entry.get("paneId")
                if not isinstance(pane_id, str) or not pane_id:
                    continue
                i = index.get(pane_id)
                if i is None:
                    index[pane_id] = len(stored)
                    stored.append(entry)
                else:
                    stored[i] = entry
            if len(stored) > MAX_ENTRIES:
                dropped = len(stored) - MAX_ENTRIES
                stored = stored[dropped:]
                log.warning(
                    "spawn history for %s exceeded %d entries; dropped %d oldest",
                    workspace_path, MAX_ENTRIES, dropped,
                )
            self._write(workspace_path, stored)
            return len(stored)

    def read_page(
        self,
        workspace_path: str,
        *,
        offset: int = 0,
        limit: int = 100,
        seed: list[dict[str, Any]] | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        """Return ``(page, total)`` where the page is newest → oldest.

        ``offset`` counts from the newest end (0 = latest entry); an
        out-of-range offset yields an empty page. When the full file is
        missing and the project.json mirror (``seed``) has data, the file is
        seeded first — the same one-time migration merge() performs.
        """
        with self._lock:
            stored = self._load(workspace_path, seed)
            if stored and not self.history_file(workspace_path).exists():
                # Persist the migration so later reads no longer depend on
                # the mirror being passed in.
                self._write(workspace_path, stored)
            offset = max(0, offset)
            limit = max(0, limit)
            newest_first = list(reversed(stored))
            return newest_first[offset : offset + limit], len(stored)
