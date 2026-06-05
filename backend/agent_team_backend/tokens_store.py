"""Token-usage aggregator with per-workspace + global persistence.

Records token deltas from two sources:
  - source="analyzer": local llama-cli classify / auto_answer real counts
  - source="cli":      vendor parser scraped from agent TUI output

Per-workspace state lives in `<workspace>/.agent-team/tokens.json`.
Global lifetime state lives in `<app_data>/tokens.json`.

We never estimate — if a source can't produce a real number, we record 0.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any

from .applog import app_data_dir
from .projects import PROJECT_DIR_NAME

log = logging.getLogger("agent_team_backend.tokens")

TOKENS_FILE = "tokens.json"
RECORDED_KEYS_FILE = "recorded-event-keys.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _empty_bucket() -> dict[str, int]:
    """A single accounting unit. `calls` counts events; in/out are token sums."""
    return {"input": 0, "output": 0, "calls": 0}


def _add(into: dict[str, int], delta: dict[str, int]) -> None:
    into["input"] += int(delta.get("input", 0))
    into["output"] += int(delta.get("output", 0))
    into["calls"] += int(delta.get("calls", 0))


def _empty_workspace_doc() -> dict[str, Any]:
    return {
        "current_run": None,  # see _new_run() shape
        "runs": [],           # archived runs
        "cumulative": {
            "totals": _empty_bucket(),
            "by_vendor": {},
            "by_stage": {},
        },
    }


def _empty_global_doc() -> dict[str, Any]:
    return {
        "all_time": _empty_bucket(),
        "by_vendor": {},
        "by_day": {},
    }


def _new_run(run_id: str, task: str, run_dir: str) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "task": task,
        "run_dir": run_dir,
        "started_at": _now_iso(),
        "ended_at": None,
        "totals": _empty_bucket(),
        "by_vendor": {},
        "by_stage": {},
        "by_pane": {},
    }


class TokensStore:
    """Thread-safe in-memory aggregator with atomic JSON persistence."""

    def __init__(
        self,
        global_path: Path | None = None,
        recorded_keys_path: Path | None = None,
    ) -> None:
        self._global_path = global_path or (app_data_dir() / TOKENS_FILE)
        self._recorded_keys_path = recorded_keys_path or (app_data_dir() / RECORDED_KEYS_FILE)
        # RLock because reset() calls snapshot() while holding the lock.
        self._lock = RLock()
        self._workspace_cache: dict[str, dict[str, Any]] = {}
        self._global_data: dict[str, Any] = self._load_global()
        # Event-level dedup: dedup_keys that have already contributed to the
        # accumulator. Survives backend restarts so re-parsing log files
        # (after a workspace registration triggers a force-rescan) can't
        # double-count. Cleared by reset(scope="global").
        self._recorded_keys: set[str] = self._load_recorded_keys()

    # ───────────────────────── Disk I/O ────────────────────────────

    def _atomic_write(self, path: Path, data: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise

    def _workspace_path(self, workspace_path: str) -> Path:
        return Path(workspace_path) / PROJECT_DIR_NAME / TOKENS_FILE

    def _load_workspace(self, workspace_path: str) -> dict[str, Any]:
        if workspace_path in self._workspace_cache:
            return self._workspace_cache[workspace_path]
        wp = self._workspace_path(workspace_path)
        if not wp.exists():
            doc = _empty_workspace_doc()
        else:
            try:
                doc = json.loads(wp.read_text(encoding="utf-8"))
                # Forward-compat: fill in any missing top-level keys.
                for k, v in _empty_workspace_doc().items():
                    doc.setdefault(k, v)
            except Exception as err:  # noqa: BLE001
                log.warning("tokens.json at %s is corrupt (%s); starting fresh", wp, err)
                doc = _empty_workspace_doc()
        self._workspace_cache[workspace_path] = doc
        return doc

    def _save_workspace(self, workspace_path: str) -> None:
        doc = self._workspace_cache.get(workspace_path)
        if doc is None:
            return
        try:
            self._atomic_write(self._workspace_path(workspace_path), doc)
        except Exception as err:  # noqa: BLE001
            log.warning("failed to write workspace tokens.json: %s", err)

    def _load_global(self) -> dict[str, Any]:
        if not self._global_path.exists():
            return _empty_global_doc()
        try:
            doc = json.loads(self._global_path.read_text(encoding="utf-8"))
            for k, v in _empty_global_doc().items():
                doc.setdefault(k, v)
            return doc
        except Exception as err:  # noqa: BLE001
            log.warning("global tokens.json corrupt (%s); starting fresh", err)
            return _empty_global_doc()

    def _save_global(self) -> None:
        try:
            self._atomic_write(self._global_path, self._global_data)
        except Exception as err:  # noqa: BLE001
            log.warning("failed to write global tokens.json: %s", err)

    def _load_recorded_keys(self) -> set[str]:
        if not self._recorded_keys_path.exists():
            return set()
        try:
            data = json.loads(self._recorded_keys_path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return set(str(k) for k in data)
        except (OSError, json.JSONDecodeError) as err:
            log.warning("recorded-keys file unreadable (%s); starting empty", err)
        return set()

    def _save_recorded_keys(self) -> None:
        try:
            self._recorded_keys_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._recorded_keys_path.with_suffix(self._recorded_keys_path.suffix + ".tmp")
            try:
                tmp.write_text(
                    json.dumps(sorted(self._recorded_keys), separators=(",", ":")),
                    encoding="utf-8",
                )
                os.replace(tmp, self._recorded_keys_path)
            except Exception:
                tmp.unlink(missing_ok=True)
                raise
        except OSError as err:
            log.warning("failed to write recorded-keys: %s", err)

    # ───────────────────────── Run lifecycle ────────────────────────

    def start_run(
        self,
        workspace_path: str,
        *,
        run_id: str,
        task: str,
        run_dir: str,
    ) -> dict[str, Any]:
        """Archive any in-progress current_run, then start a fresh one."""
        with self._lock:
            doc = self._load_workspace(workspace_path)
            if doc["current_run"]:
                prev = doc["current_run"]
                prev["ended_at"] = _now_iso()
                doc["runs"].append(prev)
            doc["current_run"] = _new_run(run_id, task, run_dir)
            self._save_workspace(workspace_path)
            return doc["current_run"]

    def end_run(self, workspace_path: str) -> None:
        with self._lock:
            doc = self._load_workspace(workspace_path)
            if doc["current_run"]:
                doc["current_run"]["ended_at"] = _now_iso()
                doc["runs"].append(doc["current_run"])
                doc["current_run"] = None
            self._save_workspace(workspace_path)

    # ───────────────────────── Recording ───────────────────────────

    def record(
        self,
        workspace_path: str | None,
        *,
        source: str,           # "analyzer" | "cli"
        vendor: str,           # "claude" | "codex" | "gemini" | "analyzer"
        agent_key: str | None = None,
        pane_id: str | None = None,
        stage_id: str | None = None,
        input_tokens: int = 0,
        output_tokens: int = 0,
        dedup_key: str = "",
    ) -> None:
        """Add a single token event. All numeric inputs are >= 0; zeros allowed.

        workspace_path may be None (e.g. for an analyzer call made before any
        workspace was selected) — those still hit the global tally.

        dedup_key (optional): a stable per-event identifier; if it has already
        contributed to the accumulator, this call is a no-op. Used by log
        readers so re-parsing the same JSONL after a workspace registration
        doesn't double-count.
        """
        # Defensive normalisation: no negative tokens, no NaN.
        input_tokens = max(0, int(input_tokens))
        output_tokens = max(0, int(output_tokens))
        if input_tokens == 0 and output_tokens == 0:
            # Don't bump `calls` either — zero-zero events are no-ops.
            return
        delta = {
            "input": input_tokens,
            "output": output_tokens,
            "calls": 1,
        }

        with self._lock:
            # Event-level dedup — short-circuit if we've already counted this event.
            if dedup_key and dedup_key in self._recorded_keys:
                return
            if dedup_key:
                self._recorded_keys.add(dedup_key)
                self._save_recorded_keys()
            # --- workspace state ---
            if workspace_path:
                doc = self._load_workspace(workspace_path)
                # current_run (only if one is active)
                if doc["current_run"]:
                    run = doc["current_run"]
                    _add(run["totals"], delta)
                    _add(run["by_vendor"].setdefault(vendor, _empty_bucket()), delta)
                    if stage_id:
                        _add(run["by_stage"].setdefault(stage_id, _empty_bucket()), delta)
                    if pane_id:
                        _add(run["by_pane"].setdefault(pane_id, _empty_bucket()), delta)
                # cumulative (workspace lifetime, runs included)
                cum = doc["cumulative"]
                _add(cum["totals"], delta)
                _add(cum["by_vendor"].setdefault(vendor, _empty_bucket()), delta)
                if stage_id:
                    _add(cum["by_stage"].setdefault(stage_id, _empty_bucket()), delta)
                self._save_workspace(workspace_path)

            # --- global state ---
            g = self._global_data
            _add(g["all_time"], delta)
            _add(g["by_vendor"].setdefault(vendor, _empty_bucket()), delta)
            day = _today()
            _add(g["by_day"].setdefault(day, _empty_bucket()), delta)
            self._save_global()

        log.debug(
            "tokens recorded source=%s vendor=%s pane=%s stage=%s in=%d out=%d",
            source, vendor, pane_id, stage_id, input_tokens, output_tokens,
        )

    # ───────────────────────── Snapshot ─────────────────────────────

    def snapshot(self, workspace_path: str | None) -> dict[str, Any]:
        with self._lock:
            workspace_doc = (
                self._load_workspace(workspace_path) if workspace_path else _empty_workspace_doc()
            )
            return {
                "workspace_path": workspace_path or "",
                "workspace": {
                    "current_run": workspace_doc["current_run"],
                    "runs": workspace_doc["runs"][-20:],  # last 20 only — keep payload small
                    "cumulative": workspace_doc["cumulative"],
                },
                "global": dict(self._global_data),
            }

    # ───────────────────────── Reset ────────────────────────────────

    def reset(self, scope: str, workspace_path: str | None = None) -> dict[str, Any]:
        """Reset scope = 'run' | 'workspace' | 'global'."""
        with self._lock:
            if scope == "run" and workspace_path:
                doc = self._load_workspace(workspace_path)
                # Replace current_run with a fresh blank (preserve run_id/task)
                if doc["current_run"]:
                    cur = doc["current_run"]
                    doc["current_run"] = _new_run(
                        run_id=cur["run_id"],
                        task=cur["task"],
                        run_dir=cur.get("run_dir", ""),
                    )
                self._save_workspace(workspace_path)
            elif scope == "workspace" and workspace_path:
                self._workspace_cache[workspace_path] = _empty_workspace_doc()
                self._save_workspace(workspace_path)
            elif scope == "global":
                self._global_data = _empty_global_doc()
                self._save_global()
                # Also clear event dedup so previously-recorded events can be
                # re-counted (e.g. after reset, the user expects backfill to
                # repopulate the tally from scratch).
                self._recorded_keys.clear()
                self._save_recorded_keys()
            else:
                raise ValueError(f"unknown reset scope: {scope!r}")
            return self.snapshot(workspace_path)
