from __future__ import annotations

from registry.trust import (
    TRUST_SIGNED,
    TRUST_UNSIGNED,
    compute_trust_tier,
    sensitive_capabilities,
)


def test_compute_trust_tier() -> None:
    assert compute_trust_tier(signed=True) == TRUST_SIGNED
    assert compute_trust_tier(signed=False) == TRUST_UNSIGNED


def test_sensitive_capabilities_flags_fs_and_terminal() -> None:
    assert sensitive_capabilities(["fs", "ui", "terminal", "git"]) == [
        "fs",
        "terminal",
    ]


def test_sensitive_capabilities_empty_when_none_sensitive() -> None:
    assert sensitive_capabilities(["ui", "git", "search", "chat"]) == []
