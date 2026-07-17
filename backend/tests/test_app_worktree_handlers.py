"""WS dispatch tests for the git worktree handlers.

test_git_service.py covers the git_service functions directly; these cover the
app.py dispatch layer on top of them — i.e. that each message type maps its
payload keys onto the right service call and returns the result frame. A typo in
a payload key (worktree_path/new_path/reason/force) is invisible to the service
tests but breaks the feature, so it is pinned here.
"""
from __future__ import annotations

import subprocess
import uuid
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


def init_repo(path: Path) -> None:
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True, capture_output=True)
    (path / "README.md").write_text("# test")
    subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=path, check=True, capture_output=True)


async def _call(session: app.Session, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one message and return its response frame's payload."""
    msg_id = str(uuid.uuid4())
    await app.handle_message(session, {"id": msg_id, "type": msg_type, "payload": payload})
    frames = [f for f in session.websocket.sent if f.get("id") == msg_id]  # type: ignore[attr-defined]
    assert frames, f"no response frame for {msg_type}"
    frame = frames[-1]
    assert frame["ok"] is True, f"{msg_type} returned an error envelope: {frame}"
    return frame["payload"]


async def _list(session: app.Session, ws: str) -> list[dict[str, Any]]:
    return (await _call(session, "git.worktrees", {"workspace_path": ws}))["worktrees"]


class TestWorktreeHandlers:
    @pytest.mark.asyncio
    async def test_list_returns_entries_with_state_flags(self, tmp_path):
        init_repo(tmp_path)
        session = _session()
        entries = await _list(session, str(tmp_path))
        assert len(entries) >= 1
        assert any(e["is_main"] for e in entries)
        for key in ("detached", "bare", "locked", "lock_reason", "prunable", "prune_reason"):
            assert key in entries[0]

    @pytest.mark.asyncio
    async def test_add_worktree_maps_payload(self, tmp_path):
        init_repo(tmp_path)
        session = _session()
        wt = str(tmp_path / "wt-add")
        result = await _call(session, "git.add_worktree", {
            "workspace_path": str(tmp_path), "worktree_path": wt,
            "branch": "feat-add", "new_branch": True,
        })
        assert result["ok"] is True
        assert any(e["path"] == wt for e in await _list(session, str(tmp_path)))

    @pytest.mark.asyncio
    async def test_lock_and_unlock_worktree_map_payload(self, tmp_path):
        init_repo(tmp_path)
        session = _session()
        wt = str(tmp_path / "wt-lock")
        await _call(session, "git.add_worktree", {
            "workspace_path": str(tmp_path), "worktree_path": wt,
            "branch": "feat-lock", "new_branch": True,
        })

        locked = await _call(session, "git.lock_worktree", {
            "workspace_path": str(tmp_path), "worktree_path": wt, "reason": "on usb disk",
        })
        assert locked["ok"] is True
        entry = next(e for e in await _list(session, str(tmp_path)) if e["path"] == wt)
        assert entry["locked"] is True

        unlocked = await _call(session, "git.unlock_worktree", {
            "workspace_path": str(tmp_path), "worktree_path": wt,
        })
        assert unlocked["ok"] is True
        entry = next(e for e in await _list(session, str(tmp_path)) if e["path"] == wt)
        assert entry["locked"] is False

    @pytest.mark.asyncio
    async def test_move_worktree_maps_new_path(self, tmp_path):
        init_repo(tmp_path)
        session = _session()
        src, dst = str(tmp_path / "wt-src"), str(tmp_path / "wt-dst")
        await _call(session, "git.add_worktree", {
            "workspace_path": str(tmp_path), "worktree_path": src,
            "branch": "feat-move", "new_branch": True,
        })
        result = await _call(session, "git.move_worktree", {
            "workspace_path": str(tmp_path), "worktree_path": src, "new_path": dst,
        })
        assert result["ok"] is True
        paths = [e["path"] for e in await _list(session, str(tmp_path))]
        assert dst in paths and src not in paths

    @pytest.mark.asyncio
    async def test_remove_worktree_maps_force(self, tmp_path):
        init_repo(tmp_path)
        session = _session()
        wt = str(tmp_path / "wt-rm")
        await _call(session, "git.add_worktree", {
            "workspace_path": str(tmp_path), "worktree_path": wt,
            "branch": "feat-rm", "new_branch": True,
        })
        # Dirty the worktree so a plain remove refuses and force is required —
        # this proves the force flag actually reaches git.
        (Path(wt) / "dirty.txt").write_text("uncommitted")
        plain = await _call(session, "git.remove_worktree", {
            "workspace_path": str(tmp_path), "worktree_path": wt,
        })
        assert plain["ok"] is False
        forced = await _call(session, "git.remove_worktree", {
            "workspace_path": str(tmp_path), "worktree_path": wt, "force": True,
        })
        assert forced["ok"] is True
        assert not any(e["path"] == wt for e in await _list(session, str(tmp_path)))

    @pytest.mark.asyncio
    async def test_prune_and_repair_handlers(self, tmp_path):
        init_repo(tmp_path)
        session = _session()
        assert (await _call(session, "git.prune_worktrees", {"workspace_path": str(tmp_path)}))["ok"] is True
        assert (await _call(session, "git.repair_worktrees", {"workspace_path": str(tmp_path)}))["ok"] is True

    @pytest.mark.asyncio
    async def test_prune_drops_a_deleted_worktree(self, tmp_path):
        """End-to-end prune: delete the directory, prune, entry disappears."""
        import shutil
        init_repo(tmp_path)
        session = _session()
        wt = str(tmp_path / "wt-stale")
        await _call(session, "git.add_worktree", {
            "workspace_path": str(tmp_path), "worktree_path": wt,
            "branch": "feat-stale", "new_branch": True,
        })
        shutil.rmtree(wt)  # now git considers the entry prunable
        await _call(session, "git.prune_worktrees", {"workspace_path": str(tmp_path)})
        assert not any(e["path"] == wt for e in await _list(session, str(tmp_path)))
