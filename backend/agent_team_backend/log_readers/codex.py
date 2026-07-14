"""Codex CLI rollout log reader.

Format reference: docs/cli-log-formats.md (Codex section).

Files: ~/.codex/sessions/{Y}/{M}/{D}/rollout-{ts}-{uuid}.jsonl
Event filter: type=event_msg, payload.type=token_count
Token fields are CUMULATIVE session totals — we compute delta against the
previous totals seen in the same file.

cwd: extracted from the session_meta event (type=session_meta, payload.cwd).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .base import ActivityEvent, IncrementalParseResult, LogReader, TokenUsage, read_jsonl_tail

log = logging.getLogger("agent_team_backend.log_readers.codex")

# Sentinel prefix for storing the file's prior cumulative totals inside the
# per-file seen_keys set (avoids needing a separate state dict).
_CUM_PREFIX = "__cum__:"


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _read_cumulative(seen_keys: set[str]) -> tuple[int, int]:
    """Return (prev_input, prev_output) from sentinel key, or (0, 0)."""
    for k in seen_keys:
        if k.startswith(_CUM_PREFIX):
            try:
                _, body = k.split(":", 1)
                parts = dict(p.split("=") for p in body.split(","))
                return int(parts.get("in", 0)), int(parts.get("out", 0))
            except (ValueError, KeyError):
                continue
    return 0, 0


def _write_cumulative(seen_keys: set[str], input_total: int, output_total: int) -> None:
    # Drop any prior sentinel, write new one.
    for k in [k for k in seen_keys if k.startswith(_CUM_PREFIX)]:
        seen_keys.discard(k)
    seen_keys.add(f"{_CUM_PREFIX}in={input_total},out={output_total}")


class CodexLogReader(LogReader):
    vendor: str = "codex"

    def project_dirs(self) -> list[Path]:
        roots: list[Path] = []
        default_root = Path.home() / ".codex" / "sessions"
        if default_root.is_dir():
            roots.append(default_root)
        panes_root = Path.home() / ".codex-panes"
        if panes_root.is_dir():
            try:
                roots.extend(
                    p / "sessions"
                    for p in panes_root.iterdir()
                    if (p / "sessions").is_dir()
                )
            except OSError as err:
                log.debug("enumerate %s failed: %s", panes_root, err)
        return roots

    def watch_dirs(self) -> list[Path]:
        roots: list[Path] = []
        default_root = Path.home() / ".codex" / "sessions"
        if default_root.is_dir():
            roots.append(default_root)
        panes_root = Path.home() / ".codex-panes"
        if panes_root.is_dir():
            roots.append(panes_root)
        return roots

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for f in root.rglob("rollout-*.jsonl"):
                    if f.is_file():
                        out.append(f)
            except OSError as err:
                log.debug("rglob %s failed: %s", root, err)
        return out

    def _cwd_from_meta(self, path: Path) -> str:
        """Read just the session_meta header for this rollout's cwd.

        Codex stores sessions by date, not cwd, but every file opens with a
        `session_meta` record carrying payload.cwd. We read only the first few
        lines (not the whole rollout) so per-workspace scoping stays cheap.
        """
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                for _ in range(5):  # session_meta is the first record
                    line = fh.readline()
                    if not line:
                        break
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if rec.get("type") == "session_meta":
                        payload = rec.get("payload") or {}
                        if isinstance(payload, dict):
                            return str(payload.get("cwd") or "")
        except OSError:
            return ""
        return ""

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only rollouts whose session_meta.cwd matches this workspace.

        Reading each file's header to filter is far cheaper than parsing every
        full rollout, and keeps a per-workspace rescan from touching unrelated
        sessions.
        """
        return [
            p for p in self.session_files()
            if self._cwd_from_meta(p) == workspace_path
        ]

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        try:
            fh = path.open(encoding="utf-8")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return []

        prev_in, prev_out = _read_cumulative(seen_keys)
        latest_in, latest_out = prev_in, prev_out
        latest_event: dict | None = None
        cwd = ""
        model = ""
        session_id = path.stem

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

                # Pick up cwd / model from session_meta if present
                if rec.get("type") == "session_meta":
                    payload = rec.get("payload") or {}
                    if isinstance(payload, dict):
                        cwd = str(payload.get("cwd") or cwd)
                        model = str(payload.get("model_provider") or payload.get("model") or model)
                    continue

                # Token count events are the only ones we care about
                if rec.get("type") != "event_msg":
                    continue
                payload = rec.get("payload") or {}
                if not isinstance(payload, dict) or payload.get("type") != "token_count":
                    continue
                info = payload.get("info")
                if not isinstance(info, dict):
                    continue
                totals = info.get("total_token_usage")
                if not isinstance(totals, dict):
                    continue

                cur_in = _int(totals.get("input_tokens")) + _int(totals.get("cached_input_tokens"))
                cur_out = _int(totals.get("output_tokens")) + _int(totals.get("reasoning_output_tokens"))
                # Accept any monotonically non-decreasing pair; if values shrink
                # the user likely rotated session — reset baseline silently.
                if cur_in < latest_in or cur_out < latest_out:
                    latest_in = cur_in
                    latest_out = cur_out
                    latest_event = rec
                    continue
                latest_in = cur_in
                latest_out = cur_out
                latest_event = rec

        if latest_event is None:
            return []

        delta_in = latest_in - prev_in
        delta_out = latest_out - prev_out
        # Detect session rotation: the totals shrank. Reset baseline to the
        # smaller value WITHOUT emitting (or we'd emit a negative delta).
        if delta_in < 0 or delta_out < 0:
            _write_cumulative(seen_keys, latest_in, latest_out)
            return []
        if delta_in == 0 and delta_out == 0:
            return []

        # Persist new baseline for the next call
        _write_cumulative(seen_keys, latest_in, latest_out)

        return [
            TokenUsage(
                vendor="codex",
                input_tokens=max(0, delta_in),
                output_tokens=max(0, delta_out),
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=f"codex_cumulative::{session_id}::{latest_in}::{latest_out}",
                timestamp=str(latest_event.get("timestamp") or ""),
                model=model,
            )
        ]

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Read only the rollout tail while persisting cumulative baselines."""
        records, next_checkpoint, _rotated = read_jsonl_tail(path, checkpoint)
        prev_in = max(0, int(checkpoint.get("input_total") or 0))
        prev_out = max(0, int(checkpoint.get("output_total") or 0))
        latest_in, latest_out = prev_in, prev_out
        cwd = str(checkpoint.get("cwd") or "")
        model = str(checkpoint.get("model") or "")
        session_id = str(checkpoint.get("session_id") or path.stem)
        latest_event: dict | None = None
        latest_end = int(next_checkpoint.get("offset") or 0)

        for end, rec in records:
            if rec is None:
                continue
            if rec.get("type") == "session_meta":
                payload = rec.get("payload") or {}
                if isinstance(payload, dict):
                    cwd = str(payload.get("cwd") or cwd)
                    session_id = str(payload.get("id") or session_id)
                    model = str(payload.get("model_provider") or payload.get("model") or model)
                continue
            if rec.get("type") != "event_msg":
                continue
            payload = rec.get("payload") or {}
            if not isinstance(payload, dict) or payload.get("type") != "token_count":
                continue
            info = payload.get("info")
            totals = info.get("total_token_usage") if isinstance(info, dict) else None
            if not isinstance(totals, dict):
                continue
            latest_in = _int(totals.get("input_tokens")) + _int(totals.get("cached_input_tokens"))
            latest_out = _int(totals.get("output_tokens")) + _int(totals.get("reasoning_output_tokens"))
            latest_event = rec
            latest_end = end

        next_checkpoint.update({
            "input_total": latest_in,
            "output_total": latest_out,
            "cwd": cwd,
            "model": model,
            "session_id": session_id,
        })
        if latest_event is None:
            return IncrementalParseResult([], next_checkpoint)

        delta_in = latest_in - prev_in
        delta_out = latest_out - prev_out
        if delta_in < 0 or delta_out < 0 or (delta_in == 0 and delta_out == 0):
            return IncrementalParseResult([], next_checkpoint)

        event_checkpoint = dict(next_checkpoint)
        event_checkpoint["offset"] = latest_end
        event = TokenUsage(
            vendor="codex",
            input_tokens=delta_in,
            output_tokens=delta_out,
            cwd=cwd,
            session_id=session_id,
            file_path=str(path),
            dedup_key=f"codex_cumulative::{session_id}::{latest_in}::{latest_out}",
            timestamp=str(latest_event.get("timestamp") or ""),
            model=model,
            checkpoint=event_checkpoint,
        )
        return IncrementalParseResult([event], next_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for assistant + event_msg lines.

        Codex doesn't have a clean "turn end" sentinel like Claude; we use the
        token_count event (which Codex emits at conversation boundaries) as
        a proxy for `turn_complete`.
        """
        out: list[ActivityEvent] = []
        session_id = path.stem
        cwd = ""
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
                if rtype == "session_meta":
                    payload = rec.get("payload") or {}
                    if isinstance(payload, dict):
                        cwd = str(payload.get("cwd") or cwd)
                    seen_keys.add(key)
                    continue

                ts = str(rec.get("timestamp") or "")
                if rtype == "assistant":
                    seen_keys.add(key)
                    out.append(ActivityEvent(
                        vendor="codex", event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts, detail="assistant",
                    ))
                elif rtype == "event_msg":
                    payload = rec.get("payload") or {}
                    ptype = str(payload.get("type") or "") if isinstance(payload, dict) else ""
                    seen_keys.add(key)
                    out.append(ActivityEvent(
                        vendor="codex", event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts, detail=ptype,
                    ))
                    # token_count typically fires once per turn end in Codex.
                    if ptype == "token_count":
                        out.append(ActivityEvent(
                            vendor="codex", event_type="turn_complete",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=f"turn:{line_no}", timestamp=ts,
                            detail="token_count",
                        ))
                else:
                    seen_keys.add(key)
        return out
