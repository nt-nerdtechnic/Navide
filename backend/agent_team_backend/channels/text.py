"""Outbound text shaping: per-platform chunking and Markdown -> platform markup.

Limits follow OpenClaw (text-chunk-limit.ts): Telegram 4000 (not 4096, leaving
room for the HTML entities the renderer adds), Discord 2000 chars and ~17
lines per message with ``` fences kept balanced, Slack 8000, Feishu 4000.
"""

from __future__ import annotations

import html
import re

TEXT_LIMITS: dict[str, int] = {
    "telegram": 4000,
    "discord": 2000,
    "slack": 8000,
    "feishu": 4000,
    "dingtalk": 4000,
    "matrix": 8000,
    "mattermost": 8000,
    "imessage": 4000,
}
DISCORD_MAX_LINES = 17

_FENCE_RE = re.compile(r"^\s*(```+|~~~+)(.*)$")


def chunk_text(text: str, limit: int) -> list[str]:
    """Split ``text`` into pieces of at most ``limit`` chars.

    Prefers a newline boundary, then whitespace, and only hard-cuts a single
    token longer than the limit. Empty input yields no chunks.
    """
    if limit <= 0:
        raise ValueError("limit must be positive")
    text = text.strip("\n")
    if not text.strip():
        return []
    out: list[str] = []
    rest = text
    while len(rest) > limit:
        window = rest[:limit + 1]  # a boundary right at the limit is still usable
        cut = window.rfind("\n")
        if cut <= 0:
            cut = max(window.rfind(" "), window.rfind("\t"))
        if cut <= 0:
            cut = limit
        piece = rest[:cut].rstrip()
        if piece:
            out.append(piece)
        rest = rest[cut:].lstrip("\n") if rest[cut:cut + 1] == "\n" else rest[cut:].lstrip(" \t")
    if rest.strip():
        out.append(rest)
    return out


def chunk_discord(text: str, limit: int = 2000, max_lines: int = DISCORD_MAX_LINES) -> list[str]:
    """Discord chunking: ``limit`` chars, ``max_lines`` lines, balanced code fences.

    A chunk that ends inside an open fence is closed with the fence marker and
    the next chunk reopens it with the same opener (language tag included), so
    every message renders its code block on its own.
    """
    lines = text.strip("\n").split("\n")
    if not "".join(lines).strip():
        return []
    chunks: list[str] = []
    cur: list[str] = []
    cur_len = 0
    open_fence: str | None = None  # opener line of the fence we are inside
    fence_marker = ""

    def close_len() -> int:
        return len(fence_marker) + 1 if open_fence else 0

    def flush() -> None:
        nonlocal cur, cur_len
        if not cur:
            return
        body = list(cur)
        if open_fence:
            body.append(fence_marker)
        joined = "\n".join(body)
        if joined.strip() and joined.strip() != (open_fence or "").strip():
            chunks.append(joined)
        cur = [open_fence] if open_fence else []
        cur_len = len(open_fence) if open_fence else 0

    for raw in lines:
        # Hard-split a single overlong line first.
        pieces = [raw]
        budget = limit - (len(open_fence) + 1 if open_fence else 0) - close_len() - 1
        if len(raw) > budget > 0:
            pieces = [raw[i:i + budget] for i in range(0, len(raw), budget)]
        for line in pieces:
            add = len(line) + (1 if cur else 0)
            if cur and (cur_len + add + close_len() + 1 > limit or len(cur) + 1 + (1 if open_fence else 0) > max_lines):
                flush()
                add = len(line) + (1 if cur else 0)
            cur.append(line)
            cur_len += add
            m = _FENCE_RE.match(line)
            if m:
                if open_fence is None:
                    open_fence = line.strip()
                    fence_marker = m.group(1)
                elif m.group(1).startswith(fence_marker[0]) and len(m.group(1)) >= len(fence_marker) and not m.group(2).strip():
                    open_fence = None
                    fence_marker = ""
    if cur:
        body = list(cur)
        if open_fence:
            body.append(fence_marker)
        joined = "\n".join(body)
        if joined.strip():
            chunks.append(joined)
    return chunks


def chunk_for(platform: str, text: str) -> list[str]:
    if platform == "discord":
        return chunk_discord(text)
    return chunk_text(text, TEXT_LIMITS.get(platform, 4000))


# --- Telegram HTML -----------------------------------------------------------

_INLINE_RE = re.compile(
    r"(?P<code>`[^`\n]+`)"
    r"|(?P<link>\[[^\]\n]+\]\((?:https?://|tg://)[^)\s]+\))"
    r"|(?P<bold>\*\*[^*\n]+\*\*)"
    r"|(?P<strike>~~[^~\n]+~~)"
    r"|(?P<italic>(?<![\w*])\*[^*\s][^*\n]*(?<!\s)\*(?![\w*])|(?<!\w)_[^_\s][^_\n]*(?<!\s)_(?!\w))"
)


def _inline_to_html(line: str) -> str:
    out: list[str] = []
    pos = 0
    for m in _INLINE_RE.finditer(line):
        out.append(html.escape(line[pos:m.start()], quote=False))
        tok = m.group(0)
        kind = m.lastgroup
        if kind == "code":
            out.append(f"<code>{html.escape(tok[1:-1], quote=False)}</code>")
        elif kind == "link":
            label, url = tok[1:].split("](", 1)
            out.append(f'<a href="{html.escape(url[:-1], quote=True)}">{html.escape(label, quote=False)}</a>')
        elif kind == "bold":
            out.append(f"<b>{html.escape(tok[2:-2], quote=False)}</b>")
        elif kind == "strike":
            out.append(f"<s>{html.escape(tok[2:-2], quote=False)}</s>")
        else:
            out.append(f"<i>{html.escape(tok[1:-1], quote=False)}</i>")
        pos = m.end()
    out.append(html.escape(line[pos:], quote=False))
    return "".join(out)


def markdown_to_telegram_html(text: str) -> str:
    """Render the common Markdown subset agents emit as Telegram HTML.

    Everything outside recognised markup is HTML-escaped, so the result is
    always safe to send with ``parse_mode=HTML``; if Telegram still rejects it
    ("can't parse entities"), the caller resends the plain text.
    """
    out: list[str] = []
    in_code = False
    code_lang = ""
    code_lines: list[str] = []
    for line in text.split("\n"):
        m = _FENCE_RE.match(line)
        if m:
            if not in_code:
                in_code = True
                code_lang = m.group(2).strip().split(" ")[0]
                code_lines = []
                continue
            body = html.escape("\n".join(code_lines), quote=False)
            if code_lang and re.fullmatch(r"[\w+#.-]+", code_lang):
                out.append(f'<pre><code class="language-{code_lang}">{body}</code></pre>')
            else:
                out.append(f"<pre>{body}</pre>")
            in_code = False
            continue
        if in_code:
            code_lines.append(line)
            continue
        h = re.match(r"^#{1,6}\s+(.*)$", line)
        if h:
            out.append(f"<b>{_inline_to_html(h.group(1))}</b>")
        else:
            out.append(_inline_to_html(line))
    if in_code:  # unterminated fence: still render it as code
        out.append(f"<pre>{html.escape(chr(10).join(code_lines), quote=False)}</pre>")
    return "\n".join(out)


def is_telegram_parse_error(description: str) -> bool:
    """True when Telegram rejected the markup itself (resend as plain text)."""
    d = (description or "").lower()
    return "can't parse entities" in d or "can't find end of" in d or "unsupported start tag" in d
