"""Kimi Code CLI conversation log reader.

Format reference: docs/cli-log-formats.md (Kimi section).

Files: <KIMI_CODE_HOME|~/.kimi-code>/sessions/wd_<ws>/session_<uuid>/agents/main/wire.jsonl
Event filter: type=usage.record. Token fields are PER-TURN deltas (usageScope
"turn"), so they are summed as they arrive — NOT cumulative totals like Codex.

cwd: read from the session's state.json (workDir); wire.jsonl carries no cwd.
session_id: the `session_<uuid>` directory name — the exact id accepted by
`kimi --session <id>` / `-S`.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from .base import ActivityEvent, IncrementalParseResult, LogReader, TokenUsage, read_jsonl_tail

log = logging.getLogger("agent_team_backend.log_readers.kimi")


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _kimi_home() -> Path:
    env = os.environ.get("KIMI_CODE_HOME")
    return Path(env) if env else Path.home() / ".kimi-code"


def _ts(ms) -> str:  # noqa: ANN001
    """Epoch-ms as a sortable string; wire.jsonl records `time` in epoch ms."""
    try:
        return str(int(ms))
    except (TypeError, ValueError):
        return ""


def _usage_tokens(usage: dict) -> tuple[int, int]:
    """Fold cache reads/creation into input (per TokenUsage design)."""
    input_tokens = (
        _int(usage.get("inputOther"))
        + _int(usage.get("inputCacheRead"))
        + _int(usage.get("inputCacheCreation"))
    )
    return input_tokens, _int(usage.get("output"))


class KimiLogReader(LogReader):
    vendor: str = "kimi"

    def _sessions_root(self) -> Path:
        return _kimi_home() / "sessions"

    def project_dirs(self) -> list[Path]:
        root = self._sessions_root()
        return [root] if root.is_dir() else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for f in root.glob("wd_*/session_*/agents/main/wire.jsonl"):
                    if f.is_file():
                        out.append(f)
            except OSError as err:
                log.debug("glob %s failed: %s", root, err)
        return out

    def has_session(self, session_id: str) -> bool:
        """True if a session dir named `session_id` exists under any workspace
        root (`~/.kimi-code/sessions/wd_*/<session_id>/`). The resume preflight
        uses this to reject bogus ids (e.g. a pre-fix "wire"/"state" history
        record) before they reach a doomed `kimi --session <id>`."""
        session_id = session_id.strip()
        if not session_id.startswith("session_"):
            return False
        root = self._sessions_root()
        if not root.is_dir():
            return False
        try:
            return any((wd / session_id).is_dir() for wd in root.glob("wd_*"))
        except OSError:
            return False

    def _session_dir(self, path: Path) -> Path:
        # wire.jsonl → agents/main → agents → session_<uuid>
        return path.parent.parent.parent

    def _session_id(self, path: Path) -> str:
        return self._session_dir(path).name

    def _workdir_from_state(self, path: Path) -> str:
        """Read workDir from the session's state.json (wire.jsonl has no cwd)."""
        state = self._session_dir(path) / "state.json"
        try:
            rec = json.loads(state.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return ""
        return str(rec.get("workDir") or "") if isinstance(rec, dict) else ""

    def cwd_from_file(self, path: Path) -> str:
        return self._workdir_from_state(path)

    def session_id_from_path(self, path: Path) -> str:
        """Id is the `session_<uuid>` dir name, NOT the stem (every session
        file is wire.jsonl). Sibling files in the session dir (state.json,
        logs/) are not session files → '' so the resume sink skips them
        instead of coining ids like "state" or "wire"."""
        if path.name != "wire.jsonl":
            return ""
        return self._session_id(path)

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only sessions whose state.json workDir matches this workspace."""
        return [
            p for p in self.session_files()
            if self._workdir_from_state(p) == workspace_path
        ]

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        out: list[TokenUsage] = []
        cwd = self.cwd_from_file(path)
        session_id = self._session_id(path)
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
                if rec.get("type") != "usage.record":
                    continue
                usage = rec.get("usage")
                if not isinstance(usage, dict):
                    continue
                dedup_key = f"kimi::{session_id}::L{line_no}"
                if dedup_key in seen_keys:
                    continue
                input_tokens, output_tokens = _usage_tokens(usage)
                if input_tokens == 0 and output_tokens == 0:
                    continue
                seen_keys.add(dedup_key)
                out.append(
                    TokenUsage(
                        vendor="kimi",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cwd=cwd,
                        session_id=session_id,
                        file_path=str(path),
                        dedup_key=dedup_key,
                        timestamp=_ts(rec.get("time")),
                        model=str(rec.get("model") or ""),
                    )
                )
        return out

    def parse_incremental(
        self, path: Path, checkpoint: dict
    ) -> IncrementalParseResult:
        """Parse only complete JSONL records after the persisted byte offset.

        wire.jsonl appends whole records (usage.record is written atomically,
        never streamed), so a byte offset alone guarantees no double count.
        """
        records, final_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        cwd = (
            self.cwd_from_file(path)
            if rotated or not checkpoint.get("cwd")
            else str(checkpoint.get("cwd"))
        )
        session_id = self._session_id(path)
        out: list[TokenUsage] = []

        for end, rec in records:
            if rec is None or rec.get("type") != "usage.record":
                continue
            usage = rec.get("usage")
            if not isinstance(usage, dict):
                continue
            input_tokens, output_tokens = _usage_tokens(usage)
            if input_tokens == 0 and output_tokens == 0:
                continue
            event_checkpoint = dict(final_checkpoint)
            event_checkpoint["offset"] = end
            event_checkpoint["cwd"] = cwd
            out.append(
                TokenUsage(
                    vendor="kimi",
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cwd=cwd,
                    session_id=session_id,
                    file_path=str(path),
                    dedup_key=f"kimi::{session_id}::@{end}",
                    timestamp=_ts(rec.get("time")),
                    model=str(rec.get("model") or ""),
                    checkpoint=event_checkpoint,
                )
            )

        final_checkpoint["cwd"] = cwd
        return IncrementalParseResult(out, final_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` on user prompts and usage records, and
        `turn_complete` on each usage.record (Kimi's per-turn boundary)."""
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        session_id = self._session_id(path)
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

                rtype = rec.get("type")
                ts = _ts(rec.get("time"))
                if rtype == "turn.prompt":
                    seen_keys.add(key)
                    out.append(ActivityEvent(
                        vendor="kimi", event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts, detail="prompt",
                    ))
                elif rtype == "usage.record":
                    seen_keys.add(key)
                    out.append(ActivityEvent(
                        vendor="kimi", event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts, detail="usage",
                    ))
                    out.append(ActivityEvent(
                        vendor="kimi", event_type="turn_complete",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=f"turn:{line_no}", timestamp=ts,
                        detail="usage.record",
                    ))
                else:
                    seen_keys.add(key)
        return out
