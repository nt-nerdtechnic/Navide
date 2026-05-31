"""Verify analyzer.parse_llama_perf extracts real token counts from stderr.

We only test the parser — running an actual llama-cli is out of scope for unit
tests. The parser is the load-bearing piece: if it returns 0 we either had no
stderr stats or the format changed and we should notice.
"""

from __future__ import annotations

from agent_team_backend.analyzer import parse_llama_perf


# Real llama-cli / llama-completion perf-print output (captured locally).
SAMPLE_STDERR = """\
llama_perf_sampler_print:    sampling time =       2.13 ms /   245 runs   (    0.01 ms per token, 115023.47 tokens per second)
llama_perf_context_print:        load time =     345.21 ms
llama_perf_context_print: prompt eval time =      89.45 ms /   142 tokens (    0.63 ms per token,  1587.50 tokens per second)
llama_perf_context_print:        eval time =    1234.56 ms /   245 tokens (    5.04 ms per token,   198.43 tokens per second)
llama_perf_context_print:       total time =    1582.42 ms /   387 tokens
"""


def test_parses_prompt_eval_count() -> None:
    stats = parse_llama_perf(SAMPLE_STDERR)
    assert stats["prompt_eval_count"] == 142


def test_parses_eval_count_distinct_from_prompt_eval() -> None:
    # The `eval time` line must NOT be confused with `prompt eval time`.
    stats = parse_llama_perf(SAMPLE_STDERR)
    assert stats["eval_count"] == 245


def test_parses_total_duration_ms() -> None:
    stats = parse_llama_perf(SAMPLE_STDERR)
    # We truncate to int (1582.42 → 1582)
    assert stats["total_duration_ms"] == 1582


def test_empty_input_returns_zeros() -> None:
    stats = parse_llama_perf("")
    assert stats == {"prompt_eval_count": 0, "eval_count": 0, "total_duration_ms": 0}


def test_partial_stderr_returns_what_we_can() -> None:
    only_prompt = "llama_perf_context_print: prompt eval time = 12.0 ms / 7 tokens"
    stats = parse_llama_perf(only_prompt)
    assert stats["prompt_eval_count"] == 7
    assert stats["eval_count"] == 0
    assert stats["total_duration_ms"] == 0


def test_eval_without_prompt_line() -> None:
    # If a build only prints eval time (no prompt eval), we still get eval_count.
    stderr = "llama_perf_context_print: eval time = 100.0 ms / 50 tokens"
    stats = parse_llama_perf(stderr)
    assert stats["prompt_eval_count"] == 0
    assert stats["eval_count"] == 50


def test_garbage_input_does_not_fabricate() -> None:
    # Random text that happens to contain "tokens" must not produce numbers.
    stats = parse_llama_perf("the user wrote 5000 tokens in their prompt")
    assert stats == {"prompt_eval_count": 0, "eval_count": 0, "total_duration_ms": 0}
