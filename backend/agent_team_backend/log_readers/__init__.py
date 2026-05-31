"""CLI conversation-log readers.

Replaces the PTY-output regex approach (vendor_parsers) with direct reads
of the CLI's own JSONL conversation logs. See docs/cli-log-formats.md
for the three formats this module supports.
"""

from .base import ActivityEvent, LogReader, TokenUsage
from .claude import ClaudeLogReader
from .codex import CodexLogReader
from .gemini import GeminiLogReader
from .watcher import LogWatcher

__all__ = [
    "ActivityEvent",
    "LogReader",
    "TokenUsage",
    "ClaudeLogReader",
    "CodexLogReader",
    "GeminiLogReader",
    "LogWatcher",
]
