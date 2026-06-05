"""Commit-message prompt assembly, ported from VS Code Copilot Chat.

Cursor is a VS Code fork and does not publish its commit-message prompt; the
closest auditable reference is microsoft/vscode-copilot-chat. We mirror its
structure (step-by-step reasoning, RECENT COMMITS as a *style* reference, a
fenced ```text output block) but deliberately drop the hard-coded Conventional
Commits rule so the message adapts to whatever style the repo's history uses —
this is the "adaptive style" behaviour Cursor is known for.
"""

from __future__ import annotations

import re

# System prompt: 7-step chain-of-thought. No Conventional Commits prefix is
# mandated — step 4 learns format/style from the repo's recent commits instead.
SYSTEM_PROMPT = (
    "You are an AI programming assistant, helping a software developer to come "
    "with the best git commit message for their code changes.\n"
    "You excel in interpreting the purpose behind code changes to craft "
    "succinct, clear commit messages that adhere to the repository's "
    "established conventions.\n\n"
    "# First, think step-by-step:\n"
    "1. Analyze the CODE CHANGES thoroughly to understand what has been changed.\n"
    "2. Use the ORIGINAL CODE, when provided, to understand the context the "
    "changes were made in.\n"
    "3. Identify the purpose of the changes — the *why* behind them — not just "
    "a restatement of the diff.\n"
    "4. Review the RECENT REPOSITORY COMMITS to learn this repository's commit "
    "format and style only (e.g. prefixes, casing, language, length). Do NOT "
    "treat them as content to reuse.\n"
    "5. Generate a thoughtful and succinct commit message that matches those "
    "conventions and describes the CODE CHANGES.\n"
    "6. Remove any meta information such as issue references, tags, or author "
    "names.\n"
    "7. Output ONLY the commit message inside a single ```text code block. Do "
    "not add explanations, reasoning, or any prose outside the code block."
)


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n... (truncated)"


def build_user_prompt(context: dict, recent: dict, per_file_budget: int) -> str:
    """Assemble the user message from collected context.

    *context* is :func:`git_service.get_commit_context` output, *recent* is
    :func:`git_service.get_recent_commit_messages` output. *per_file_budget*
    caps how many chars each file contributes (split between original + diff).
    """
    lines: list[str] = []

    lines.append("# REPOSITORY DETAILS:")
    lines.append(f"Repository name: {context.get('repo_name', '')}")
    lines.append(f"Branch name: {context.get('branch', '')}")
    lines.append("")

    user_commits = recent.get("user") or []
    if user_commits:
        lines.append("# RECENT USER COMMITS (For reference only, do not copy!):")
        lines.extend(f"- {m}" for m in user_commits)
        lines.append("")

    repo_commits = recent.get("repository") or []
    if repo_commits:
        lines.append("# RECENT REPOSITORY COMMITS (For reference only, do not copy!):")
        lines.extend(f"- {m}" for m in repo_commits)
        lines.append("")

    half = max(1, per_file_budget // 2)
    for change in context.get("changes", []):
        lines.append(f"# FILE: {change.get('path', '')}")
        original = change.get("original") or ""
        if original.strip():
            lines.append("")
            lines.append("# ORIGINAL CODE:")
            lines.append(_truncate(original, half))
        lines.append("")
        lines.append("# CODE CHANGES:")
        lines.append(_truncate(change.get("diff") or "", half))
        lines.append("")

    lines.append(
        "Now generate a commit message that describes the CODE CHANGES above. "
        "DO NOT COPY commits from RECENT COMMITS — use them only as a reference "
        "for this repository's style. ONLY return a single markdown ```text "
        "code block, with NO other prose."
    )
    return "\n".join(lines)


_TEXT_BLOCK_RE = re.compile(r"```(?:text)?\s*\n?([\s\S]+?)\n?```", re.MULTILINE)


def parse_commit_message(response: str) -> str:
    """Extract the commit message from the model response.

    Prefers a fenced ```text block (Copilot's contract). Falls back to the
    whole stripped response when a small local model omits the fence.
    """
    if not response:
        return ""
    m = _TEXT_BLOCK_RE.search(response)
    text = m.group(1) if m else response
    return text.strip().strip('"').strip("'").strip()
