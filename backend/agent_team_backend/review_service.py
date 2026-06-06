"""AI Code Review streaming service."""

from __future__ import annotations

import logging
from typing import AsyncIterator

log = logging.getLogger("agent_team_backend.review_service")

_MAX_REVIEW_DIFF_CHARS = 30_000

REVIEW_SYSTEM_PROMPT = """\
You are a senior software engineer conducting a thorough code review. \
Analyse the provided git diff with a critical eye, focusing on:

1. **Bugs & correctness** – off-by-one errors, null/undefined dereferences, race conditions, wrong assumptions
2. **Security** – injection vulnerabilities, improper input validation, secrets in code, insecure defaults
3. **Performance** – N+1 queries, unnecessary re-renders, blocking I/O, large allocations
4. **Architecture** – separation of concerns, unnecessary coupling, missing or excessive abstractions
5. **Maintainability** – unclear naming, missing edge-case handling, dead code

Output as Markdown. Structure your response:
- A brief **Summary** paragraph (2-3 sentences) on the overall change quality.
- A **Findings** section with one sub-heading per file that has notable issues (skip files with no issues). \
For each finding, rate severity: 🔴 Critical / 🟡 Warning / 🔵 Suggestion.
- A **Verdict** line: ✅ Approve / ⚠️ Approve with minor comments / ❌ Request changes.

Be concise. No praise for the obvious. Focus on actionable insights.\
"""


async def stream_review(
    settings: dict,
    diff: str,
) -> AsyncIterator[str]:
    """Stream an AI code review for *diff*.

    Yields text chunks from the configured AI provider. The caller is
    responsible for broadcasting these chunks to connected clients.
    """
    from .ai_chat_service import stream_chat

    if not diff.strip():
        yield "*(no changes to review)*"
        return

    truncated = diff[:_MAX_REVIEW_DIFF_CHARS]
    truncation_note = (
        f"\n\n*(diff truncated to {_MAX_REVIEW_DIFF_CHARS} chars)*"
        if len(diff) > _MAX_REVIEW_DIFF_CHARS
        else ""
    )

    messages = [
        {
            "role": "user",
            "content": (
                f"Please review the following git diff:{truncation_note}\n\n"
                f"```diff\n{truncated}\n```"
            ),
        }
    ]

    async for chunk in stream_chat(settings, messages, REVIEW_SYSTEM_PROMPT, max_tokens=4096):
        yield chunk
