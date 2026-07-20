"""CLI conversation-log readers.

Replaces the PTY-output regex approach (vendor_parsers) with direct reads
of the CLI's own JSONL conversation logs. See docs/cli-log-formats.md
for the three formats this module supports.
"""

from .antigravity import AntigravityLogReader
from .base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenSinkResult,
    TokenUsage,
)
from .claude import ClaudeLogReader
from .codex import CodexLogReader
from .grok import GrokLogReader
from .kimi import KimiLogReader
from .watcher import LogWatcher

__all__ = [
    "ActivityEvent",
    "IncrementalParseResult",
    "LogReader",
    "TokenUsage",
    "TokenSinkResult",
    "AntigravityLogReader",
    "ClaudeLogReader",
    "CodexLogReader",
    "GrokLogReader",
    "KimiLogReader",
    "LogWatcher",
]
