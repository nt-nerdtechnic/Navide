"""Fresh Codex identity comes from verified home ownership, without a prompt."""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.cli_vendors.codex import CodexLogReader
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import TokenUsage


def _usage(path: Path, cwd: str) -> TokenUsage:
    return TokenUsage(
        vendor="codex", input_tokens=0, output_tokens=0, cwd=cwd,
        session_id=path.stem, file_path=str(path), dedup_key="",
    )


def test_marker_free_isolated_homes_bind_same_cwd_panes_after_delayed_meta(
    tmp_path: Path, set_home,
) -> None:
    set_home(tmp_path)
    cwd = str(tmp_path / "workspace")
    reader = CodexLogReader()
    attr = Attribution([reader], workspaces_path=tmp_path / "workspaces.json")
    for suffix in ("a", "b"):
        attr.register_pane(
            f"pane-{suffix}", vendor="codex", cwd=cwd,
            session_home_id=f"home-{suffix}", defer_baseline=True,
        )

    for suffix in ("b", "a"):
        path = tmp_path / ".codex-panes" / f"home-{suffix}" / "sessions" / f"rollout-{suffix}.jsonl"
        path.parent.mkdir(parents=True)
        path.touch()
        usage = _usage(path, cwd)
        assert attr.maybe_announce_session(usage) is None
        path.write_text(json.dumps({
            "type": "session_meta", "payload": {"id": f"session-{suffix}", "cwd": cwd},
        }) + "\n", encoding="utf-8")

        bound = attr.maybe_announce_session(usage)

        assert bound is not None
        assert bound.pane_id == f"pane-{suffix}"
        assert bound.resume_id == f"session-{suffix}"
        assert attr.maybe_announce_session(usage) is None


def test_marker_free_shared_home_never_claims_a_rollout_from_its_symlink_path(
    tmp_path: Path, set_home,
) -> None:
    set_home(tmp_path)
    cwd = str(tmp_path / "workspace")
    shared = tmp_path / ".codex" / "sessions"
    shared.mkdir(parents=True)
    home = tmp_path / ".codex-panes" / "home-a"
    home.mkdir(parents=True)
    (home / "sessions").symlink_to(shared, target_is_directory=True)
    reader = CodexLogReader()
    attr = Attribution([reader], workspaces_path=tmp_path / "workspaces.json")
    attr.register_pane("pane-a", vendor="codex", cwd=cwd, session_home_id="home-a")
    path = home / "sessions" / "rollout-shared.jsonl"
    path.write_text(json.dumps({
        "type": "session_meta", "payload": {"id": "shared-session", "cwd": cwd},
    }) + "\n", encoding="utf-8")

    assert reader.path_identity(_usage(path, cwd)) is None
    assert attr.maybe_announce_session(_usage(path, cwd)) is None
    assert attr.maybe_announce_session(_usage(path.resolve(), cwd)) is None
    assert attr.pane_for_session(path.stem)[0] is None
    assert (home / "sessions").is_symlink()
