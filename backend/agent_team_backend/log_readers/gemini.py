"""Gemini CLI conversation log reader.

Format reference: docs/cli-log-formats.md (Gemini section).

Files: ~/.gemini/tmp/{project-name}/chats/session-*.jsonl
Event filter: type=="gemini" (assistant turn) with tokens.* populated.

cwd resolution: ~/.gemini/projects.json maps project-name → absolute cwd.
We cache it once per parse_session_file call; the file rarely changes.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .base import ActivityEvent, LogReader, TokenUsage

log = logging.getLogger("agent_team_backend.log_readers.gemini")


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


class GeminiLogReader(LogReader):
    vendor: str = "gemini"

    def __init__(self) -> None:
        self._projects_cache: dict[str, str] = {}  # project-name → cwd
        self._projects_path: Path = Path.home() / ".gemini" / "projects.json"
        self._projects_mtime: float = 0.0

    def project_dirs(self) -> list[Path]:
        root = Path.home() / ".gemini" / "tmp"
        return [root] if root.is_dir() else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            # Each project: tmp/{name}/chats/session-*.jsonl
            try:
                for project in root.iterdir():
                    chats = project / "chats"
                    if not chats.is_dir():
                        continue
                    for f in chats.iterdir():
                        # .jsonl = older line-delimited; .json = newer single
                        # object. Both carry the top-level sessionId we resume by.
                        if f.is_file() and f.suffix in (".jsonl", ".json"):
                            out.append(f)
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def _refresh_projects(self) -> None:
        """Reload projects.json mapping if mtime changed."""
        try:
            mtime = self._projects_path.stat().st_mtime
        except OSError:
            return
        if mtime == self._projects_mtime:
            return
        try:
            data = json.loads(self._projects_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        # Best-effort: data shape varies across Gemini versions. Look for
        # any dict-of-dicts where the inner dict has a "path" / "cwd" field.
        cache: dict[str, str] = {}
        if isinstance(data, dict):
            for project_name, body in data.items():
                if isinstance(body, dict):
                    cwd = body.get("path") or body.get("cwd") or body.get("root")
                    if isinstance(cwd, str):
                        cache[str(project_name)] = cwd
                elif isinstance(body, str):
                    cache[str(project_name)] = body
        self._projects_cache = cache
        self._projects_mtime = mtime

    def cwd_from_file(self, path: Path) -> str:
        """Resolve cwd via projects.json → fall back to project-name folder."""
        try:
            # path = ~/.gemini/tmp/{project-name}/chats/{session.jsonl}
            project_name = path.parent.parent.name
        except Exception:
            return ""
        self._refresh_projects()
        return self._projects_cache.get(project_name, "")

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only session files whose project maps to this workspace.

        cwd_from_file resolves project-name → cwd via the (cached) projects.json
        without reading the session files themselves, so scoping stays cheap.
        """
        return [
            p for p in self.session_files()
            if self.cwd_from_file(p) == workspace_path
        ]

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        out: list[TokenUsage] = []
        cwd = self.cwd_from_file(path)
        try:
            fh = path.open(encoding="utf-8")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return out

        with fh:
            for line_no, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    log.debug("%s:%d malformed JSON, skipping", path.name, line_no)
                    continue

                if rec.get("type") != "gemini":
                    continue
                tokens = rec.get("tokens")
                if not isinstance(tokens, dict):
                    continue

                # Dedup by event uuid.
                event_id = str(rec.get("id") or "")
                if not event_id or event_id in seen_keys:
                    continue

                input_tokens = _int(tokens.get("input")) + _int(tokens.get("cached"))
                output_tokens = (
                    _int(tokens.get("output"))
                    + _int(tokens.get("thoughts"))
                    + _int(tokens.get("tool"))
                )
                if input_tokens == 0 and output_tokens == 0:
                    continue

                seen_keys.add(event_id)
                session_id = str(rec.get("sessionId") or path.stem)
                out.append(
                    TokenUsage(
                        vendor="gemini",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cwd=cwd,
                        session_id=session_id,
                        file_path=str(path),
                        dedup_key=event_id,
                        timestamp=str(rec.get("timestamp") or ""),
                        model=str(rec.get("model") or ""),
                    )
                )
        return out

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Each `type=gemini` line = one assistant turn. We emit both
        `agent_active` (turn started) and `turn_complete` (turn ended) on
        each — Gemini doesn't stream tool_use mid-turn the way Claude does.
        """
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        try:
            fh = path.open(encoding="utf-8")
        except OSError:
            return out
        with fh:
            for line_no, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                key = f"act:{line_no}"
                if key in seen_keys:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    seen_keys.add(key)
                    continue
                if rec.get("type") != "gemini":
                    seen_keys.add(key)
                    continue
                seen_keys.add(key)
                ts = str(rec.get("timestamp") or "")
                session_id = str(rec.get("sessionId") or path.stem)
                out.append(ActivityEvent(
                    vendor="gemini", event_type="agent_active",
                    cwd=cwd, session_id=session_id, file_path=str(path),
                    dedup_key=key, timestamp=ts, detail="gemini",
                ))
                out.append(ActivityEvent(
                    vendor="gemini", event_type="turn_complete",
                    cwd=cwd, session_id=session_id, file_path=str(path),
                    dedup_key=f"turn:{line_no}", timestamp=ts, detail="gemini",
                ))
        return out
