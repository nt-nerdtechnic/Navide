from __future__ import annotations

import pytest

from agent_team_backend.channels.text import (
    TEXT_LIMITS,
    chunk_discord,
    chunk_for,
    chunk_text,
    is_telegram_parse_error,
    markdown_to_telegram_html,
)


@pytest.mark.parametrize("platform,limit", [("telegram", 4000), ("slack", 8000), ("feishu", 4000)])
def test_limits(platform: str, limit: int) -> None:
    assert TEXT_LIMITS[platform] == limit
    text = "\n".join(f"line {i} " + "x" * 90 for i in range(400))
    chunks = chunk_for(platform, text)
    assert all(len(c) <= limit for c in chunks)
    assert "\n".join(chunks) == text  # newline boundaries lose nothing


def test_chunk_text_prefers_newline_then_space_then_hard_cut() -> None:
    assert chunk_text("aaaa\nbbbb", 6) == ["aaaa", "bbbb"]
    assert chunk_text("aaa bbb ccc", 7) == ["aaa bbb", "ccc"]
    assert chunk_text("x" * 10, 4) == ["xxxx", "xxxx", "xx"]
    assert chunk_text("", 10) == [] and chunk_text("\n\n", 10) == []
    assert chunk_text("short", 4000) == ["short"]


def test_discord_char_and_line_limits() -> None:
    text = "\n".join(f"row {i}" for i in range(60))
    chunks = chunk_discord(text)
    assert all(c.count("\n") + 1 <= 17 for c in chunks)
    assert "\n".join(chunks) == text
    long_lines = "\n".join("y" * 300 for _ in range(12))
    assert all(len(c) <= 2000 for c in chunk_discord(long_lines))


def test_discord_fences_stay_balanced() -> None:
    body = "\n".join(f"print({i})" for i in range(50))
    text = f"intro\n```python\n{body}\n```\noutro"
    chunks = chunk_discord(text)
    assert len(chunks) > 2
    for c in chunks:
        assert c.count("```") % 2 == 0, c
        assert len(c) <= 2000 and c.count("\n") + 1 <= 17
    assert all(c.startswith("```python") for c in chunks[1:-1])
    assert chunks[-1].endswith("outro")


def test_discord_overlong_single_line_inside_fence() -> None:
    text = "```\n" + "z" * 5000 + "\n```"
    chunks = chunk_discord(text)
    assert all(len(c) <= 2000 and c.count("```") % 2 == 0 for c in chunks)
    assert "".join(c.replace("```", "").replace("\n", "") for c in chunks) == "z" * 5000


def test_telegram_html_escapes_and_formats() -> None:
    html = markdown_to_telegram_html(
        "# Title\n**b** *i* ~~s~~ `a<b` <tag> & [link](https://x.io/?a=1&b=2)\nsnake_case_word"
    )
    assert html == (
        "<b>Title</b>\n<b>b</b> <i>i</i> <s>s</s> <code>a&lt;b</code> &lt;tag&gt; &amp; "
        '<a href="https://x.io/?a=1&amp;b=2">link</a>\nsnake_case_word'
    )


def test_telegram_html_code_blocks() -> None:
    assert markdown_to_telegram_html("```py\nif a<b:\n  **x**\n```") == (
        '<pre><code class="language-py">if a&lt;b:\n  **x**</code></pre>'
    )
    assert markdown_to_telegram_html("```\nopen <b>") == "<pre>open &lt;b&gt;</pre>"


def test_parse_error_detection() -> None:
    assert is_telegram_parse_error("Bad Request: can't parse entities: Unexpected end tag at byte offset 5")
    assert not is_telegram_parse_error("Bad Request: chat not found")
