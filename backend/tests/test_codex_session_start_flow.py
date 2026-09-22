"""Marker-free Codex callbacks bind shared rollouts before notifying the UI."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from agent_team_backend import app, codex_session_hooks as hooks, hook_auth
from agent_team_backend.cli_vendors.codex import CodexLogReader
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.projects import ProjectStore
from agent_team_backend.spawn_history import SpawnHistoryStore

SID_A = '12345678-1234-1234-1234-123456789abc'
SID_B = '87654321-1234-1234-1234-123456789abc'


@pytest.fixture
def shared_sessions(tmp_path, monkeypatch, set_home):
    set_home(tmp_path)
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    home = tmp_path / '.codex'
    sessions = home / 'sessions'
    sessions.mkdir(parents=True)
    reader = CodexLogReader()
    attribution = Attribution([reader], workspaces_path=tmp_path / 'workspaces.json')
    projects = ProjectStore()
    history = SpawnHistoryStore()
    entries = [{'paneId': pane, 'agentKey': 'codex', 'workspacePath': str(workspace)}
               for pane in ('pane-a', 'pane-b')]
    project = projects.load_or_create(str(workspace))
    project.ui_spawn_history = entries
    projects.save(project)
    history.merge(str(workspace), entries)
    terms = {
        token: SimpleNamespace(
            pane_id=pane, agent_key='codex', closed=False, cwd=str(workspace),
            metadata={'codex_launch_token': token, 'codex_session_home': str(home)},
        )
        for token, pane in [('launch-a', 'pane-a'), ('launch-b', 'pane-b')]
    }
    owner = SimpleNamespace(terminals=SimpleNamespace(get=terms.get))
    monkeypatch.setattr(app, '_PTY_OWNERS', {token: owner for token in terms})
    monkeypatch.setattr(app, 'attribution', attribution)
    monkeypatch.setattr(app, '_readers', [reader])
    monkeypatch.setattr(app, '_codex_pending_starts', hooks.PendingStarts())
    monkeypatch.setattr(app, 'project_store', projects)
    monkeypatch.setattr(app, 'spawn_history_store', history)
    monkeypatch.setattr(app, 'track_live_session', lambda **_: None)
    events = []

    async def broadcast(event):
        if event['type'] == 'session.detected':
            payload = event['payload']
            # Fresh store instances prove the data is durable before the
            # renderer receives the event, without a renderer round-trip.
            saved = ProjectStore().peek(str(workspace))
            assert saved is not None
            pane = next(p for p in saved.panes if p.pane_id == payload['pane_id'])
            assert pane.session_id == payload['session_id']
            stored, _ = SpawnHistoryStore().read_page(str(workspace))
            entry = next(e for e in stored if e['paneId'] == payload['pane_id'])
            assert entry['sessionId'] == payload['session_id']
        events.append(event)

    monkeypatch.setattr(app, 'broadcast', broadcast)
    client = TestClient(app.app, base_url='http://127.0.0.1')

    def register():
        for term in terms.values():
            attribution.register_pane(
                term.pane_id, vendor='codex', cwd=term.cwd,
                workspace_path=term.cwd,
            )

    def path(sid):
        return sessions / f'rollout-2026-09-21T00-00-00-{sid}.jsonl'

    def write(sid):
        target = path(sid)
        target.write_text(json.dumps({
            'type': 'session_meta',
            'payload': {'id': sid, 'cwd': str(workspace), 'source': 'cli'},
        }) + '\n', encoding='utf-8')
        return target

    def post(token, sid, *, declared_path=True, authenticated=True):
        payload = {
            'hook_event_name': 'SessionStart', 'session_id': sid,
            'source': 'startup', 'cwd': str(workspace),
            'transcript_path': str(path(sid)) if declared_path else None,
        }
        headers = {hooks.LAUNCH_HEADER: token}
        if authenticated:
            headers[hook_auth.HEADER] = hook_auth.token()
        return client.post('/hooks/codex/session-start', headers=headers, json=payload)

    return SimpleNamespace(
        register=register, write=write, post=post, path=path, terms=terms,
        attribution=attribution, events=events,
    )


@pytest.mark.parametrize('declared_path', [True, False])
def test_shared_rollouts_wait_for_flush_then_bind_exact_pane_without_marker(
    shared_sessions, declared_path,
):
    flow = shared_sessions
    # Callback can arrive before pane registration and before any rollout.
    assert flow.post('launch-a', SID_A, declared_path=declared_path).status_code == 200
    assert flow.events == []
    flow.register()
    assert flow.post('launch-b', SID_B, declared_path=declared_path).status_code == 200
    # An unrelated same-cwd rollout must not win either pending callback.
    unrelated = flow.write('99999999-1234-1234-1234-123456789abc')
    asyncio.run(app._on_session_file('codex', unrelated))
    assert flow.events == []

    for token, sid, pane in [('launch-b', SID_B, 'pane-b'), ('launch-a', SID_A, 'pane-a')]:
        path = flow.write(sid)
        assert 'agent-team-session' not in path.read_text(encoding='utf-8')
        asyncio.run(app._retry_codex_session_start(token))
        assert flow.attribution.pane_for_session(sid)[0] == pane
        assert flow.attribution.pane_for_session(path.stem)[0] == pane
        assert flow.terms[token].metadata['codex_current_session_id'] == sid
        asyncio.run(app._on_session_file('codex', path))

    detected = [e['payload'] for e in flow.events if e['type'] == 'session.detected']
    assert [(e['pane_id'], e['session_id']) for e in detected] == [
        ('pane-b', SID_B), ('pane-a', SID_A),
    ]
    assert not app._codex_pending_starts.has_pending()


def test_shared_rollout_requires_backend_auth_and_a_current_launch(shared_sessions):
    flow = shared_sessions
    flow.register()
    path = flow.write(SID_A)
    assert flow.post('launch-a', SID_A, authenticated=False).status_code == 403
    assert flow.post('unknown-launch', SID_A).status_code == 403
    asyncio.run(app._on_session_file('codex', path))
    assert flow.events == []
    assert flow.attribution.pane_for_session(SID_A)[0] is None


def test_respawn_discards_callback_pending_before_rollout_flush(shared_sessions):
    flow = shared_sessions
    flow.register()
    assert flow.post('launch-a', SID_A).status_code == 200
    flow.terms['launch-a'].metadata['codex_launch_token'] = 'replacement-launch'
    path = flow.write(SID_A)
    asyncio.run(app._on_session_file('codex', path))
    assert not app._codex_pending_starts.has_pending('launch-a')
    assert flow.post('launch-a', SID_A).status_code == 403
    assert flow.events == []
    assert flow.attribution.pane_for_session(SID_A)[0] is None


def test_authenticated_sibling_cannot_steal_a_confirmed_shared_session(shared_sessions):
    flow = shared_sessions
    flow.register()
    flow.write(SID_A)
    assert flow.post('launch-a', SID_A).status_code == 200
    assert flow.post('launch-b', SID_A).status_code == 200
    assert flow.attribution.pane_for_session(SID_A)[0] == 'pane-a'
    assert 'codex_current_session_id' not in flow.terms['launch-b'].metadata
    assert len(flow.events) == 1
