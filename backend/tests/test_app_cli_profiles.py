"""cli_profiles.* WS handlers + terminal.create profile env injection."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend import profiles_store as profiles_mod
from agent_team_backend import projects
from agent_team_backend import terminals as terminals_mod
from agent_team_backend import ws_handlers
from agent_team_backend.profiles_store import CliProfilesStore


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        # pane_id -> profile_id for live PTYs; empty = nothing in use.
        self.pane_profiles: dict[str, str] = {}

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(
            id="term-1",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
        )

    def live_pane_profiles(self) -> dict[str, str]:
        return dict(self.pane_profiles)


class FakeAttribution:
    def __init__(self) -> None:
        self.registered: list[dict[str, Any]] = []

    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        self.registered.append({"pane_id": pane_id, **kwargs})


class FakeCodexHomeManager:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.real_home = root / "real-codex"
        self.prepared: list[tuple[str, Path | None]] = []

    def prepare(self, home_id: str, *, source_home: Path | None = None) -> Path:
        self.prepared.append((home_id, source_home))
        return self.root / home_id

    def find_session_home(self, resume_id: str) -> Path | None:
        return None


def _session() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    return session


@pytest.fixture(autouse=True)
def _stub_agent_cli_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        app,
        "_probe_agent_cli_for_spawn",
        lambda agent_key, _command=None: {
            "agent_key": agent_key,
            "binary_path": f"/test/bin/{agent_key}",
            "version": "1.0.0",
            "duration_ms": 1,
        } if agent_key and agent_key != "terminal" else None,
    )


@pytest.fixture()
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> CliProfilesStore:
    s = CliProfilesStore(
        path=tmp_path / "cli-profiles.json",
        profiles_root=tmp_path / "cli-profiles",
    )
    monkeypatch.setattr(app, "cli_profiles_store", s)
    return s


@pytest.fixture()
def events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def record(event: dict[str, Any], *, exclude: Any = None) -> None:
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", record)
    return sent


@pytest.fixture()
def spawn_stubs(monkeypatch: pytest.MonkeyPatch) -> FakeAttribution:
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    return fake_attr


# ---- cli_profiles.* CRUD handlers ----


async def test_cli_profiles_create_and_list(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "c1",
        "type": "cli_profiles.create",
        "payload": {"agent_key": "claude", "name": "Work"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    profile = response["payload"]["profile"]
    assert profile["agentKey"] == "claude"
    assert response["payload"]["profiles"] == [profile]
    assert events[0]["type"] == "cli_profiles.changed"
    assert events[0]["payload"]["reason"] == "create"

    await app.handle_message(session, {
        "id": "l1", "type": "cli_profiles.list", "payload": {},
    })

    listing = session.websocket.sent[1]  # type: ignore[attr-defined]
    assert listing["payload"]["profiles"] == [profile]
    assert listing["payload"]["defaults"] == {
        "claude": None, "codex": None, "kimi": None, "grok": None,
    }
    assert listing["payload"]["supported_agents"] == ["claude", "codex", "kimi", "grok"]


async def test_cli_profiles_create_rejects_unsupported_agent(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "c2",
        "type": "cli_profiles.create",
        "payload": {"agent_key": "antigravity", "name": "X"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"
    assert events == []


async def test_cli_profiles_rename_delete_set_default_flow(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()
    profile = store.create(agent_key="kimi", name="Old")

    await app.handle_message(session, {
        "id": "r1",
        "type": "cli_profiles.rename",
        "payload": {"id": profile["id"], "name": "New"},
    })
    assert session.websocket.sent[0]["payload"]["profile"]["name"] == "New"  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "d1",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "kimi", "profile_id": profile["id"]},
    })
    assert session.websocket.sent[1]["payload"]["defaults"]["kimi"] == profile["id"]  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "d2",
        "type": "cli_profiles.set_default",
        "payload": {"agent_key": "kimi", "profile_id": None},
    })
    assert session.websocket.sent[2]["payload"]["defaults"]["kimi"] is None  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "x1",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })
    assert session.websocket.sent[3]["payload"]["profiles"] == []  # type: ignore[attr-defined]
    assert [e["payload"]["reason"] for e in events] == [
        "rename", "set_default", "set_default", "delete",
    ]


async def test_cli_profiles_delete_rejects_in_use_profile(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    # A live pane is running under this profile → delete must be refused.
    session.terminals.pane_profiles = {"pane-a": profile["id"]}  # type: ignore[attr-defined]

    await app.handle_message(session, {
        "id": "x2",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "PROFILE_IN_USE"
    # Registry untouched and nothing broadcast.
    assert store.list()["profiles"] == [profile]
    assert events == []


async def test_cli_profiles_delete_clears_default(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    """Deleting the profile that was an agent's default resets that default to
    the built-in Default (null)."""
    session = _session()
    profile = store.create(agent_key="claude", name="Work")
    store.set_default("claude", profile["id"])

    await app.handle_message(session, {
        "id": "x3",
        "type": "cli_profiles.delete",
        "payload": {"id": profile["id"]},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is True
    assert response["payload"]["defaults"]["claude"] is None
    assert events[-1]["payload"]["defaults"]["claude"] is None


async def test_cli_profiles_rename_unknown_is_bad_request(
    store: CliProfilesStore, events: list[dict[str, Any]]
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "r2",
        "type": "cli_profiles.rename",
        "payload": {"id": "nope1234", "name": "X"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"


# ---- terminal.create profile injection ----


async def test_terminal_create_claude_profile_injects_config_dir(
    store: CliProfilesStore, spawn_stubs: FakeAttribution
) -> None:
    profile = store.create(agent_key="claude", name="Work")
    session = _session()

    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "profile_id": profile["id"],
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    home = str(store.home_path(profile))
    assert created["env"]["CLAUDE_CONFIG_DIR"] == home
    assert created["env_remove"] == ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
    assert created["metadata"]["profile_id"] == profile["id"]
    assert Path(home).is_dir()  # lazily created at spawn


async def test_terminal_create_uses_stored_default_profile(
    store: CliProfilesStore, spawn_stubs: FakeAttribution
) -> None:
    profile = store.create(agent_key="claude", name="Work")
    store.set_default("claude", profile["id"])
    session = _session()

    await app.handle_message(session, {
        "id": "m2",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["CLAUDE_CONFIG_DIR"] == str(store.home_path(profile))
    assert created["metadata"]["profile_id"] == profile["id"]


async def test_terminal_create_without_profile_is_unchanged(
    store: CliProfilesStore, spawn_stubs: FakeAttribution
) -> None:
    """Hard regression gate: no profile (built-in default) must spawn with the
    exact pre-profile arguments — no env, no env_remove, no metadata key."""
    session = _session()

    await app.handle_message(session, {
        "id": "m3",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"] is None
    assert created["env_remove"] is None
    assert "profile_id" not in created["metadata"]


async def test_terminal_create_unknown_profile_errors(
    store: CliProfilesStore, spawn_stubs: FakeAttribution
) -> None:
    session = _session()

    await app.handle_message(session, {
        "id": "m4",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "profile_id": "nope1234",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "PROFILE_NOT_FOUND"
    assert session.terminals.created == []  # type: ignore[attr-defined]


async def test_terminal_create_rejects_cross_agent_profile(
    store: CliProfilesStore, spawn_stubs: FakeAttribution
) -> None:
    kimi_profile = store.create(agent_key="kimi", name="Work")
    session = _session()

    await app.handle_message(session, {
        "id": "m5",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "profile_id": kimi_profile["id"],
            "metadata": {"workspace_path": "/ws"},
        },
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "PROFILE_NOT_FOUND"


async def test_terminal_create_kimi_profile_injects_code_home(
    store: CliProfilesStore, spawn_stubs: FakeAttribution
) -> None:
    profile = store.create(agent_key="kimi", name="Work")
    session = _session()

    await app.handle_message(session, {
        "id": "m6",
        "type": "terminal.create",
        "payload": {
            "pane_id": "kimi-pane",
            "agent_key": "kimi",
            "command": "kimi",
            "cwd": "/ws",
            "profile_id": profile["id"],
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["KIMI_CODE_HOME"] == str(store.home_path(profile))
    assert created["metadata"]["profile_id"] == profile["id"]


async def test_terminal_create_grok_profile_injects_home_shim(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    profile = store.create(agent_key="grok", name="Work")
    real_home = tmp_path / "fake-real-home"
    real_home.mkdir()
    (real_home / ".zshrc").write_text("x", encoding="utf-8")
    # Pin the shim's real-home source to a tmp dir so the test never touches
    # the user's actual home.
    monkeypatch.setattr(
        ws_handlers,
        "build_spawn_plan",
        lambda agent_key, home: profiles_mod.build_spawn_plan(
            agent_key, home, real_home=real_home
        ),
    )
    session = _session()

    await app.handle_message(session, {
        "id": "m7",
        "type": "terminal.create",
        "payload": {
            "pane_id": "grok-pane",
            "agent_key": "grok",
            "command": "grok",
            "cwd": "/ws",
            "profile_id": profile["id"],
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    shim = store.home_path(profile) / "home"
    assert created["env"]["HOME"] == str(shim)
    assert (shim / ".grok").is_dir()
    assert not (shim / ".grok").is_symlink()
    assert (shim / ".zshrc").is_symlink()


async def test_terminal_create_codex_profile_switches_symlink_source(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    profile = store.create(agent_key="codex", name="Work")
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    session = _session()

    await app.handle_message(session, {
        "id": "m8",
        "type": "terminal.create",
        "payload": {
            "pane_id": "codex-pane",
            "agent_key": "codex",
            "command": "codex",
            "cwd": "/ws",
            "profile_id": profile["id"],
            "metadata": {"workspace_path": "/ws", "session_home_id": "stable-home"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert fake_home.prepared == [("stable-home", store.home_path(profile))]
    assert created["env"]["CODEX_HOME"] == str(tmp_path / "codex-panes" / "stable-home")
    assert created["metadata"]["profile_id"] == profile["id"]


# ---- reload backfill: live pane -> profile_id ----


async def test_live_pane_profiles_maps_only_running_profiled_panes() -> None:
    async def _noop_emit(_event: dict[str, Any]) -> None:
        return None

    service = terminals_mod.TerminalService(emit=_noop_emit)
    service._sessions = {  # type: ignore[assignment]
        "t1": SimpleNamespace(pane_id="pane-a", closed=False, metadata={"profile_id": "prof-1"}),
        "t2": SimpleNamespace(pane_id="pane-b", closed=False, metadata={}),  # Default (no profile)
        "t3": SimpleNamespace(pane_id="pane-c", closed=True, metadata={"profile_id": "prof-x"}),  # dead
    }

    assert service.live_pane_profiles() == {"pane-a": "prof-1"}


def test_project_payload_backfills_live_profile_id(monkeypatch: pytest.MonkeyPatch) -> None:
    project = projects.Project(
        id="p", name="n", workspace_path="/ws",
        created_at="t0", updated_at="t0",
        panes=[
            projects.PaneRecord(pane_id="pane-a", agent="claude"),
            projects.PaneRecord(pane_id="pane-b", agent="codex"),
        ],
    )
    monkeypatch.setattr(
        app, "get_terminals",
        lambda: SimpleNamespace(live_pane_profiles=lambda: {"pane-a": "prof-1"}),
    )

    payload = app._project_payload(project)

    panes = {p["pane_id"]: p for p in payload["project"]["panes"]}
    assert panes["pane-a"]["profile_id"] == "prof-1"
    # A pane with no live profile is untouched — reload leaves it on Default.
    assert "profile_id" not in panes["pane-b"]


async def test_terminal_create_codex_without_profile_prepare_unchanged(
    store: CliProfilesStore,
    spawn_stubs: FakeAttribution,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """No profile → prepare() is called without a source_home override."""
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    session = _session()

    await app.handle_message(session, {
        "id": "m9",
        "type": "terminal.create",
        "payload": {
            "pane_id": "codex-pane",
            "agent_key": "codex",
            "command": "codex",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws", "session_home_id": "stable-home"},
        },
    })

    assert fake_home.prepared == [("stable-home", None)]
