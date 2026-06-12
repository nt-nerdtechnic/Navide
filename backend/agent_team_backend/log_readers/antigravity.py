"""Antigravity CLI conversation reader (session discovery only).

Files: ~/.gemini/antigravity-cli/conversations/<uuid>.db — SQLite databases
whose payloads are undocumented protobuf blobs. Token usage is therefore NOT
parsed (parse_session_file returns []); this reader exists so that:

  • the watcher's session sink can bind a conversation to its pane via the
    kickoff marker (the .db filename stem is the id `agy --conversation`
    resumes), and
  • cwd_from_file() can map a conversation to its workspace — the
    trajectory_metadata_blob table embeds the workspace as a `file:///…` URI,
    extractable without decoding protobuf.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from collections import Counter
from pathlib import Path
from urllib.parse import unquote

from .base import LogReader, TokenUsage

log = logging.getLogger("agent_team_backend.log_readers.antigravity")

# A file URI run inside blob text: stop at control bytes (protobuf field
# boundaries); printable junk that follows the path is trimmed by the
# is_dir()/most-common selection in _extract_cwd.
_FILE_URI_RE = re.compile(r"file://(/[^\x00-\x1f\x7f]+)")


def _extract_cwd(text: str) -> str:
    """Best candidate workspace path from blob text.

    The URI appears several times; occurrences directly followed by protobuf
    tag bytes pick up printable junk suffixes. Prefer candidates that exist on
    disk, then the most frequent, then the shortest (the clean path is a
    prefix of its junk-suffixed variants).
    """
    counts: Counter[str] = Counter()
    for m in _FILE_URI_RE.finditer(text):
        counts[unquote(m.group(1)).rstrip("/")] += 1
    if not counts:
        return ""
    candidates = sorted(
        counts,
        key=lambda p: (not Path(p).is_dir(), -counts[p], len(p)),
    )
    return candidates[0]


class AntigravityLogReader(LogReader):
    vendor: str = "antigravity"

    def __init__(self) -> None:
        self._cwd_cache: dict[str, tuple[float, str]] = {}  # path → (mtime, cwd)

    def project_dirs(self) -> list[Path]:
        root = Path.home() / ".gemini" / "antigravity-cli" / "conversations"
        return [root] if root.is_dir() else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                out.extend(
                    f for f in root.iterdir()
                    if f.is_file() and f.suffix == ".db"  # skip -wal / -shm
                )
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        return [
            p for p in self.session_files()
            if self.cwd_from_file(p) == workspace_path
        ]

    def cwd_from_file(self, path: Path) -> str:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return ""
        cached = self._cwd_cache.get(str(path))
        if cached is not None and cached[0] == mtime:
            return cached[1]
        cwd = _extract_cwd(self._metadata_text(path))
        self._cwd_cache[str(path)] = (mtime, cwd)
        return cwd

    def _metadata_text(self, path: Path) -> str:
        """trajectory_metadata_blob rows decoded as text (errors ignored)."""
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                rows = con.execute(
                    "SELECT data FROM trajectory_metadata_blob"
                ).fetchall()
            finally:
                con.close()
            parts: list[str] = []
            for (data,) in rows:
                if isinstance(data, bytes):
                    parts.append(data.decode("utf-8", errors="ignore"))
                elif isinstance(data, str):
                    parts.append(data)
            return "".join(parts)
        except (sqlite3.Error, OSError) as err:
            log.debug("sqlite read %s failed (%s), falling back to raw scan", path, err)
        # Live db mid-write / locked: best-effort raw byte scan.
        try:
            return path.read_bytes().decode("utf-8", errors="ignore")
        except OSError:
            return ""

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        # Token counts live in undocumented protobuf blobs — intentionally not
        # parsed. Session binding happens via the watcher session sink instead.
        return []
