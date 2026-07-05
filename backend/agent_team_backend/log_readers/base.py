"""Common types + LogReader abstract base."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger("agent_team_backend.log_readers")


@dataclass
class TokenUsage:
    """Single token-usage delta extracted from a CLI conversation log.

    input_tokens already includes cache_read + cache_creation (per design:
    cache folded into input). output_tokens includes any reasoning/thinking
    tokens for vendors that report them.
    """

    vendor: str                # "claude" | "codex"
    input_tokens: int
    output_tokens: int
    cwd: str                   # absolute working directory the session ran in
    session_id: str            # log file's session identifier (uuid)
    file_path: str             # absolute path to the .jsonl file
    dedup_key: str             # stable key per logical event; readers compose this
    timestamp: str = ""        # ISO 8601 if the log records one
    model: str = ""            # e.g. "claude-opus-4-7"
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass
class ActivityEvent:
    """Vendor-agnostic activity signal extracted from a CLI conversation log.

    event_type:
      - "agent_active"    : agent produced new content or called a tool
                            (proves "still working", regardless of TUI spinner)
      - "turn_complete"   : agent finished its turn (e.g. Claude assistant line
                            with stop_reason=end_turn) — semantic "done" signal
    """

    vendor: str
    event_type: str            # "agent_active" | "turn_complete"
    cwd: str
    session_id: str
    file_path: str
    dedup_key: str             # stable key per event for in-memory dedup
    timestamp: str = ""        # ISO 8601 if available
    detail: str = ""           # e.g. tool name, stop_reason, etc. (UI hint only)
    raw: dict[str, Any] = field(default_factory=dict, repr=False)


class LogReader(ABC):
    """Abstract reader for one CLI vendor's local conversation logs.

    Subclasses implement `vendor` + the three methods below. The watcher
    orchestrator calls them; readers themselves are stateless apart from
    `seen_keys` which the caller passes in to enable per-file dedup.
    """

    #: Vendor identifier matching `agent_key` in panes ("claude" | "codex").
    vendor: str = ""

    @abstractmethod
    def project_dirs(self) -> list[Path]:
        """Return all existing root directories under which session jsonl files live.

        Implementations should silently skip non-existent paths (e.g. a user
        without the CLI installed). Returns empty list when nothing exists.
        """

    @abstractmethod
    def session_files(self) -> list[Path]:
        """Enumerate every JSONL session file under project_dirs(), recursively."""

    @abstractmethod
    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        """Parse one JSONL file, return NEW TokenUsage events.

        Implementations MUST:
          - Skip malformed lines (log.debug, never raise)
          - Skip lines whose dedup_key is already in seen_keys
          - Add new dedup_keys to seen_keys (mutating in place is fine)
        """

    def cwd_from_file(self, path: Path) -> str:
        """Best-effort: derive the spawning cwd from the session file location.

        Default impl returns empty string (subclasses with deterministic
        path → cwd mapping override).
        """
        return ""

    def session_files_for_workspace(self, workspace_path: str) -> list[Path] | None:
        """Return only the session files belonging to `workspace_path`.

        Readers whose on-disk layout maps a workspace to a specific folder
        (e.g. Claude's ~/.claude/projects/<encoded-cwd>/) override this to
        return just that subset, so a per-workspace rescan never has to touch
        unrelated files. Return None to signal "can't scope by path" (e.g.
        Codex stores sessions by date), letting the caller fall back to
        session_files(). Default: None.
        """
        return None

    def watch_dirs(self) -> list[Path]:
        """Return directories the watcher should subscribe to.

        By default this is the same as project_dirs(). Readers with dynamic
        child session directories can override this to watch a stable parent
        while still scanning precise session roots.
        """
        return self.project_dirs()

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Parse one JSONL file for activity events (agent_active / turn_complete).

        Default returns no events — vendor-specific subclasses override.
        Same dedup discipline as parse_session_file: skip already-seen keys,
        mutate seen_keys in place for new ones.
        """
        return []
