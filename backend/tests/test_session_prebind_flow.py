from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import LogReader, TokenUsage
from agent_team_backend.projects import ProjectStore


class FakeReader(LogReader):
    def __init__(self, vendor: str, root: Path) -> None:
        self.vendor = vendor
        self.root = root

    def project_dirs(self) -> list[Path]:
        return [self.root] if self.root.is_dir() else []

    def session_files(self) -> list[Path]:
        return []

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        return []


def _usage(vendor: str, session_id: str, path: Path, cwd: str) -> TokenUsage:
    return TokenUsage(
        vendor=vendor,
        input_tokens=1,
        output_tokens=1,
        cwd=cwd,
        session_id=session_id,
        file_path=str(path),
        dedup_key=f"{vendor}:{session_id}:{path}",
    )


def test_pipeline_prebind_detects_and_persists_two_codex_plus_gemini(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    ws = str(workspace)

    store = ProjectStore()
    store.start_pipeline(
        ws,
        task_description="session prebind smoke",
        total_stages=1,
        stage_blueprint=[{
            "stage_id": "01",
            "title": "Build",
            "slots": [
                {"label": "Codex A", "agent": "codex"},
                {"label": "Codex B", "agent": "codex"},
                {"label": "Gemini", "agent": "gemini"},
            ],
        }],
    )
    store.record_slot_spawn(ws, stage_index=0, slot_label="Codex A", pane_id="pane-a", agent="codex", session_home_id="home-a")
    store.record_slot_spawn(ws, stage_index=0, slot_label="Codex B", pane_id="pane-b", agent="codex", session_home_id="home-b")
    store.record_slot_spawn(ws, stage_index=0, slot_label="Gemini", pane_id="pane-g", agent="gemini")

    attr = Attribution(
        [
            FakeReader("codex", tmp_path / ".codex"),
            FakeReader("gemini", tmp_path / ".gemini"),
        ],
        workspaces_path=tmp_path / "ws.json",
    )
    attr.register_pane("pane-a", vendor="codex", cwd=ws, workspace_path=ws, session_home_id="home-a")
    attr.register_pane("pane-b", vendor="codex", cwd=ws, workspace_path=ws, session_home_id="home-b")
    attr.register_pane("pane-g", vendor="gemini", cwd=ws, workspace_path=ws, explicit_session_id="gemini-uuid")

    codex_a = tmp_path / ".codex-panes" / "home-a" / "sessions" / "rollout-a.jsonl"
    codex_b = tmp_path / ".codex-panes" / "home-b" / "sessions" / "rollout-b.jsonl"
    gemini = tmp_path / ".gemini" / "tmp" / "ws" / "chats" / "session.json"
    codex_a.parent.mkdir(parents=True)
    codex_b.parent.mkdir(parents=True)
    gemini.parent.mkdir(parents=True)
    codex_a.write_text(json.dumps({"type": "session_meta", "payload": {"id": "resume-a", "cwd": ws}}) + "\n", encoding="utf-8")
    codex_b.write_text(json.dumps({"type": "session_meta", "payload": {"id": "resume-b", "cwd": ws}}) + "\n", encoding="utf-8")
    gemini.write_text(json.dumps({"sessionId": "gemini-uuid", "messages": []}), encoding="utf-8")

    for label, usage in [
        ("Codex B", _usage("codex", codex_b.stem, codex_b, ws)),
        ("Gemini", _usage("gemini", "session", gemini, ws)),
        ("Codex A", _usage("codex", codex_a.stem, codex_a, ws)),
    ]:
        binding = attr.maybe_announce_session(usage)
        assert binding is not None
        store.record_slot_session(ws, stage_index=0, slot_label=label, session_id=binding.resume_id)

    project = store.peek(ws)
    assert project is not None
    sessions = {pane.slot_label: pane.session_id for pane in project.panes}
    assert sessions == {
        "Codex A": "resume-a",
        "Codex B": "resume-b",
        "Gemini": str(gemini),
    }
    assert attr.attribute(_usage("codex", codex_a.stem, codex_a, ws)).pane_id == "pane-a"
    assert attr.attribute(_usage("codex", codex_b.stem, codex_b, ws)).pane_id == "pane-b"
