"""pane.set_run_group RPC handler — what the frontend is allowed to conclude.

movePaneToGroup (App.vue) drops the pane's group id in memory on the strength of
this reply. A pane whose record the store cannot find was not written, so the
reply must say so: answering ok there loses the assignment on screen while the
record on disk keeps it, and the pane comes back on a tab that no longer matches
after the next restore.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> "app.Session":
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


def _reply(session: "app.Session") -> dict[str, Any]:
    return session.websocket.sent[0]  # type: ignore[attr-defined]


async def _set_run_group(session: "app.Session", ws: str, pane_id: str, gid: str) -> None:
    await app.handle_message(session, {
        "id": "m1",
        "type": "pane.set_run_group",
        "payload": {"workspace_path": ws, "pane_id": pane_id, "run_group_id": gid},
    })


@pytest.mark.asyncio
async def test_unknown_pane_is_answered_with_an_error(tmp_path: Path) -> None:
    session = _session()
    await _set_run_group(session, str(tmp_path), "nope", "rg-1")

    reply = _reply(session)
    assert reply["ok"] is False
    assert reply["error"]["code"] == "PANE_NOT_FOUND"
    assert reply["payload"] is None


@pytest.mark.asyncio
async def test_known_pane_is_answered_with_the_written_project(tmp_path: Path) -> None:
    ws = str(tmp_path)
    await app.handle_message(_session(), {
        "id": "m0",
        "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude", "command": "claude"},
    })
    session = _session()
    await _set_run_group(session, ws, "P1", "rg-1")

    reply = _reply(session)
    assert reply["ok"] is True
    panes = reply["payload"]["project"]["panes"]
    assert [(p["pane_id"], p["run_group_id"]) for p in panes] == [("P1", "rg-1")]


# ── live token attribution follows the move ──────────────────────────────────
#
# The tokens panel's BY GROUP section credits usage to the group the pane is in
# *when the usage happens*. Persisting the new group id is not enough: the
# attribution layer keeps its own per-pane registration, so the handler must
# re-point that too or the pane keeps feeding its old group's bucket.

from agent_team_backend.log_readers.attribution import Attribution  # noqa: E402
from agent_team_backend.log_readers.claude import encode_claude_cwd  # noqa: E402

from .test_attribution import FakeReader, _make_usage  # noqa: E402


def _live_attribution(tmp_path: Path, ws: str, pane_id: str) -> tuple[Attribution, str]:
    """A real Attribution with `pane_id` registered as a claude pane in `ws`,
    plus one session file path that attributes to it."""
    root = tmp_path / "claude_projects"
    proj_dir = root / encode_claude_cwd(ws)
    proj_dir.mkdir(parents=True)
    attr = Attribution([FakeReader("claude", root)], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(pane_id, vendor="claude", cwd=ws, workspace_path=ws)
    session_file = proj_dir / "s.jsonl"
    session_file.write_text("")
    return attr, str(session_file)


@pytest.mark.asyncio
async def test_set_run_group_repoints_live_token_attribution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = str(tmp_path / "ws")
    Path(ws).mkdir()
    await app.handle_message(_session(), {
        "id": "m0",
        "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude", "command": "claude"},
    })
    attr, session_file = _live_attribution(tmp_path, ws, "P1")
    monkeypatch.setattr(app, "attribution", attr)
    usage = _make_usage("claude", session_id="s", file_path=session_file)
    assert attr.attribute(usage).group_id == ""

    session = _session()
    await _set_run_group(session, ws, "P1", "rg-1")

    assert _reply(session)["ok"] is True
    assert attr.attribute(usage).group_id == "rg-1"


@pytest.mark.asyncio
async def test_set_run_group_succeeds_when_attribution_never_saw_the_pane(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A pane the store knows but attribution does not (never spawned a CLI,
    e.g. a restore placeholder) has nothing to re-point; the write still
    stands and the reply is still ok."""
    ws = str(tmp_path / "ws")
    Path(ws).mkdir()
    await app.handle_message(_session(), {
        "id": "m0",
        "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude", "command": "claude"},
    })
    attr = Attribution([FakeReader("claude", tmp_path / "claude_projects")],
                       workspaces_path=tmp_path / "ws.json")
    monkeypatch.setattr(app, "attribution", attr)
    results: list[bool] = []
    real_set = attr.set_pane_group
    monkeypatch.setattr(
        attr, "set_pane_group",
        lambda pane_id, group_id: results.append(real_set(pane_id, group_id)) or results[-1],
    )

    session = _session()
    await _set_run_group(session, ws, "P1", "rg-1")

    assert results == [False]
    reply = _reply(session)
    assert reply["ok"] is True
    assert [(p["pane_id"], p["run_group_id"]) for p in reply["payload"]["project"]["panes"]] == [("P1", "rg-1")]
