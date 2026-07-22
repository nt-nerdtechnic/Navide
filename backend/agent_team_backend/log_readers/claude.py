"""Claude Code conversation log reader.

Format reference: docs/cli-log-formats.md (Claude section).

Path resolution (first hit wins):
  1. $CLAUDE_CONFIG_DIR/projects
  2. ~/.config/claude/projects
  3. ~/.claude/projects

Each cwd → one subdirectory named per encode_claude_cwd (every
non-alphanumeric char → "-").
Each session → one {uuid}.jsonl file inside that subdirectory.
Token-relevant lines have type="assistant" and message.usage populated.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from .base import ActivityEvent, IncrementalParseResult, LogReader, TokenUsage, read_jsonl_tail

log = logging.getLogger("agent_team_backend.log_readers.claude")


def encode_claude_cwd(cwd: str) -> str:
    """Claude Code's project-dir name for a cwd — the single source of truth.

    Claude replaces EVERY non-alphanumeric char with "-" (dots, underscores,
    spaces, unicode — not just "/"). It encodes its *normalized* cwd, which
    never carries a trailing separator, so strip one before encoding:
    otherwise the extra "-" makes the encoded dir miss the real one.
    """
    return re.sub(r"[^A-Za-z0-9]", "-", cwd.rstrip("/"))


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


class ClaudeLogReader(LogReader):
    vendor: str = "claude"

    def project_dirs(self) -> list[Path]:
        """First-hit-wins: return only the first existing root.

        $CLAUDE_CONFIG_DIR overrides; the fallbacks are tried in CodexBar order.
        Returning a single root (not all of them) avoids double-counting if a
        user has both ~/.config/claude and ~/.claude populated by accident.
        """
        env_dir = os.environ.get("CLAUDE_CONFIG_DIR")
        candidates: list[Path] = []
        if env_dir:
            candidates.append(Path(env_dir) / "projects")
        candidates.append(Path.home() / ".config" / "claude" / "projects")
        candidates.append(Path.home() / ".claude" / "projects")
        for p in candidates:
            if p.is_dir():
                return [p]
        return []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for child in root.iterdir():
                    if not child.is_dir():
                        continue
                    for f in child.iterdir():
                        if f.is_file() and f.suffix == ".jsonl":
                            out.append(f)
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only the jsonl files under this workspace's project subdirectory.

        Claude names each project dir after the encoded cwd, so one
        workspace maps to exactly one folder — we can enumerate just that
        folder instead of the entire (potentially multi-GB) projects root.
        """
        encoded = encode_claude_cwd(workspace_path)
        out: list[Path] = []
        for root in self.project_dirs():
            d = root / encoded
            if not d.is_dir():
                continue
            try:
                for f in d.iterdir():
                    if f.is_file() and f.suffix == ".jsonl":
                        out.append(f)
            except OSError as err:
                log.debug("enumerate %s failed: %s", d, err)
        return out

    def cwd_from_file(self, path: Path) -> str:
        """Reverse cwd-hash: project-dir-name `-foo-bar-baz` → `/foo/bar/baz`.

        Edge case: a literal `-` in the original path is ambiguous. Best-effort
        only; attribution layer handles "unmatched cwd" gracefully.
        """
        try:
            project_dir_name = path.parent.name
        except Exception:
            return ""
        if not project_dir_name.startswith("-"):
            return ""
        return project_dir_name.replace("-", "/")

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        out: list[TokenUsage] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem

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

                if rec.get("type") != "assistant":
                    continue
                msg = rec.get("message")
                if not isinstance(msg, dict):
                    continue
                usage = msg.get("usage")
                if not isinstance(usage, dict):
                    continue

                msg_id = str(msg.get("id") or "")
                req_id = str(rec.get("requestId") or "")
                dedup_key = f"{msg_id}::{req_id}"
                if dedup_key == "::" or dedup_key in seen_keys:
                    continue

                input_tokens = (
                    _int(usage.get("input_tokens"))
                    + _int(usage.get("cache_read_input_tokens"))
                    + _int(usage.get("cache_creation_input_tokens"))
                )
                output_tokens = _int(usage.get("output_tokens"))
                if input_tokens == 0 and output_tokens == 0:
                    continue

                seen_keys.add(dedup_key)
                out.append(
                    TokenUsage(
                        vendor="claude",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cwd=cwd,
                        session_id=session_id,
                        file_path=str(path),
                        dedup_key=dedup_key,
                        timestamp=str(rec.get("timestamp") or ""),
                        model=str(msg.get("model") or ""),
                    )
                )
        return out

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Parse only complete JSONL records after the persisted byte offset."""
        records, final_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        recent = [] if rotated else [str(k) for k in checkpoint.get("recent_keys", [])][-64:]
        recent_set = set(recent)
        out: list[TokenUsage] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem

        for end, rec in records:
            if rec is None or rec.get("type") != "assistant":
                continue
            msg = rec.get("message")
            if not isinstance(msg, dict):
                continue
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            dedup_key = f"{msg.get('id') or ''}::{rec.get('requestId') or ''}"
            if dedup_key == "::" or dedup_key in recent_set:
                continue
            input_tokens = (
                _int(usage.get("input_tokens"))
                + _int(usage.get("cache_read_input_tokens"))
                + _int(usage.get("cache_creation_input_tokens"))
            )
            output_tokens = _int(usage.get("output_tokens"))
            if input_tokens == 0 and output_tokens == 0:
                continue
            recent.append(dedup_key)
            recent = recent[-64:]
            recent_set = set(recent)
            event_checkpoint = dict(final_checkpoint)
            event_checkpoint["offset"] = end
            event_checkpoint["recent_keys"] = list(recent)
            out.append(TokenUsage(
                vendor="claude",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=dedup_key,
                timestamp=str(rec.get("timestamp") or ""),
                model=str(msg.get("model") or ""),
                checkpoint=event_checkpoint,
            ))

        final_checkpoint["recent_keys"] = recent
        return IncrementalParseResult(out, final_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for every tool_use/text content, and
        `turn_complete` when an assistant turn ends with stop_reason=end_turn.

        Dedup keys are line-relative (file_lineno) so a streaming line that
        gets appended-to won't re-fire.
        """
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem
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
                ts = str(rec.get("timestamp") or "")
                if rtype == "assistant":
                    msg = rec.get("message") or {}
                    stop_reason = str(msg.get("stop_reason") or "")
                    # Mark every assistant line as activity so the watcher
                    # knows the agent is producing content.
                    seen_keys.add(key)
                    out.append(ActivityEvent(
                        vendor="claude",
                        event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts,
                        detail="assistant",
                    ))
                    # end_turn = clean finish, not a tool_use pause.
                    if stop_reason == "end_turn":
                        out.append(ActivityEvent(
                            vendor="claude",
                            event_type="turn_complete",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=f"turn:{line_no}", timestamp=ts,
                            detail=stop_reason,
                        ))
                elif rtype in ("tool_use", "user"):
                    seen_keys.add(key)
                    out.append(ActivityEvent(
                        vendor="claude",
                        event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts,
                        detail=str(rtype),
                    ))
                else:
                    # Mark seen so we don't re-evaluate this line later.
                    seen_keys.add(key)
        return out
