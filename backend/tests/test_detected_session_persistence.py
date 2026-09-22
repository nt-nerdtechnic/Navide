from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent_team_backend import app
from agent_team_backend.log_readers.attribution import SessionBinding
from agent_team_backend.log_readers.base import TokenUsage
from agent_team_backend.projects import ProjectStore
from agent_team_backend.spawn_history import SpawnHistoryStore


@pytest.mark.asyncio
async def test_detection_survives_missing_renderer_and_later_spawn(tmp_path, monkeypatch):
    ws = str(tmp_path)
    store = ProjectStore()
    history = SpawnHistoryStore()
    monkeypatch.setattr(app, 'project_store', store)
    monkeypatch.setattr(app, 'spawn_history_store', history)
    monkeypatch.setattr(app, '_current_pane_id', lambda _: 'current-pane')
    binding = SessionBinding(pane_id='old-pane', resume_id='session-1', workspace_path=ws,
                             stage_id='', session_file='rollout.jsonl')
    monkeypatch.setattr(app, 'attribution', SimpleNamespace(maybe_announce_session=lambda _: binding))
    monkeypatch.setattr(app, 'track_live_session', lambda **_: None)

    async def assert_saved_before_broadcast(_event):
        saved = ProjectStore().load_or_create(ws)
        assert [(p.pane_id, p.session_id) for p in saved.panes] == [
            ('current-pane', 'session-1')]

    monkeypatch.setattr(app, 'broadcast', AsyncMock(side_effect=assert_saved_before_broadcast))
    usage = TokenUsage(vendor='codex', input_tokens=0, output_tokens=0, cwd=ws,
                       session_id='rollout', file_path='rollout.jsonl', dedup_key='')
    await app._maybe_announce_session(usage)
    app.broadcast.assert_awaited_once()
    project = store.peek(ws)
    assert project is not None
    assert [(p.pane_id, p.session_id, p.spawn_status) for p in project.panes] == [
        ('current-pane', 'session-1', 'pending')]
    store.record_manual_pane_spawn(ws, pane_id='current-pane', agent='codex')
    assert store.peek(ws).panes[0].session_id == 'session-1'
    assert app.broadcast.call_args.args[0]['payload']['pane_id'] == 'current-pane'


def test_history_empty_snapshot_keeps_detected_identity(tmp_path):
    history = SpawnHistoryStore()
    history.merge(str(tmp_path), [{'paneId': 'pane', 'sessionId': 'session-1', 'customName': 'old'}])
    history.merge(str(tmp_path), [{'paneId': 'pane'}])
    entries, _ = history.read_page(str(tmp_path))
    assert entries == [{'paneId': 'pane', 'sessionId': 'session-1'}]
    history.merge(str(tmp_path), [{'paneId': 'pane', 'sessionId': 'session-2'}])
    assert history.read_page(str(tmp_path))[0][0]['sessionId'] == 'session-2'
    history.merge(str(tmp_path), [{'paneId': 'pane', 'sessionId': ''}])
    assert history.read_page(str(tmp_path))[0][0]['sessionId'] == 'session-2'


@pytest.mark.asyncio
async def test_history_first_snapshot_after_detection_gets_identity(tmp_path, monkeypatch):
    from agent_team_backend.ws_handlers import project_set_ui_state
    ws = str(tmp_path)
    store = ProjectStore()
    history = SpawnHistoryStore()
    monkeypatch.setattr(app, 'project_store', store)
    monkeypatch.setattr(app, 'spawn_history_store', history)
    monkeypatch.setattr(app, 'broadcast', AsyncMock())
    store.record_detected_session(ws, pane_id='pane', session_id='session-1')
    await project_set_ui_state(SimpleNamespace(send_json=AsyncMock()), 'id', 'project.set_ui_state', {
        'workspace_path': ws, 'spawn_history': [{'paneId': 'pane', 'agentKey': 'codex'}],
    })
    assert history.read_page(ws)[0][0]['sessionId'] == 'session-1'
    assert store.peek(ws).ui_spawn_history[0]['sessionId'] == 'session-1'


def test_pipeline_spawn_adopts_early_detection_without_duplicate(tmp_path):
    store = ProjectStore()
    ws = str(tmp_path)
    store.start_pipeline(ws, task_description='task', total_stages=1,
                         stage_blueprint=[{'stage_id': '01', 'title': 'Build',
                                           'slots': [{'label': 'A', 'agent': 'codex'}]}])
    store.record_detected_session(ws, pane_id='pane', session_id='session-1')
    store.record_slot_spawn(ws, stage_index=0, slot_label='A', pane_id='pane', agent='codex')
    matches = [p for p in store.peek(ws).panes if p.pane_id == 'pane']
    assert len(matches) == 1
    assert (matches[0].origin, matches[0].session_id) == ('pipeline', 'session-1')
    store.record_detected_session(ws, pane_id='pane', session_id='session-2')
    assert next(p for p in store.peek(ws).panes if p.pane_id == 'pane').session_id == 'session-2'
