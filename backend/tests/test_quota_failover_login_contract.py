"""Add account -> sign in -> capture -> switch: does the flow protect the
account that was active before the sign-in?

Driven through the real handlers (``app.handle_message``), the real
``CredentialVault`` the conftest roots in tmp (its Keychain is an in-memory
stand-in, never the real one) and the real usage-poller harvest. The CLI's
own sign-in is the only thing simulated: it is modelled as the write the CLI
makes to wherever the vault told the login pane to run — the isolated login
home when ``login_spawn_env`` gives one, the live credential store when it
gives none.

Plan: .agent-team/plans/quota-exhaustion-auto-switch_7b3e91.html — Phase V
("only exchange credentials; a candidate whose login is unknown must never
be restored as an empty credential") and the vault's own promise that an
account switch never loses the outgoing account.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, usage_service
from agent_team_backend.credential_vault import LiveCredentials
from agent_team_backend.db import Database
from agent_team_backend.profiles_store import CliProfilesStore
from agent_team_backend.quota_failover import QuotaFailoverService

# Per-vendor credential payloads in the shape the vault stores for that
# vendor's credential store (a Keychain item map, a pointer entry, a file).
# Fake values throughout; nothing here is a real token.
def secret(agent_key: str, tag: str) -> str:
    from agent_team_backend.cli_vendors.registry import vendor

    switch = vendor(agent_key).account_switch
    if switch.store == "keychain":
        items = {f"{service}|{account}": f"token-{tag}" for service, account in switch.keychain_items}
        return json.dumps({"keychain": items}, separators=(",", ":"))
    if agent_key == "copilot":
        return json.dumps({"host": "github.com", "login": f"user-{tag}"})
    return json.dumps({"token": f"account-{tag}"})


def same(stored: str | None, expected: str) -> bool:
    """The vault may re-serialise a payload it merged; compare the data."""
    return stored is not None and json.loads(stored) == json.loads(expected)

# Vendors whose login pane gets no isolated home (``login_spawn_env`` answers
# ``({}, [])``): the sign-in runs against the real credential store.
NO_ISOLATION = [
    "antigravity",
    "copilot",
    # kilo shipped this way before the adapter round: same class, kept as the
    # regression row for the behaviour that already existed.
    "kilo",
    pytest.param("cursor", marks=pytest.mark.skipif(
        sys.platform != "darwin", reason="cursor keeps its credential only in the macOS Keychain")),
]


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.registry: dict[str, SimpleNamespace] = {}
        self.created: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(id=f"term-{len(self.created)}", pane_id=kwargs["pane_id"],
                               command=kwargs["command"], proc=SimpleNamespace(pid=4321))

    def get(self, session_id: str) -> SimpleNamespace | None:
        return self.registry.get(session_id)

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


@pytest.fixture()
def rig(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    db = Database(tmp_path / "navide.db")
    store = CliProfilesStore(path=tmp_path / "cli-profiles.json", profiles_root=tmp_path / "profiles", db=db)
    monkeypatch.setattr(app, "cli_profiles_store", store)
    service = QuotaFailoverService(db=db)
    monkeypatch.setattr(app, "quota_failover", service)
    # claude's display identity lives in <real home>/.claude.json; the conftest
    # vault points the real home at tmp but does not create it.
    Path(app.credential_vault._real_home).mkdir(parents=True, exist_ok=True)
    events: list[dict[str, Any]] = []

    async def record(event: dict[str, Any], *, exclude: Any = None) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", record)
    usage = usage_service.service

    async def announce_claude(slot: Any, *, reading: bool = True) -> None:
        pass

    monkeypatch.setattr(usage, "announce_claude_switch", announce_claude)
    # terminal.create wiring that a login-pane spawn touches; no real CLI, no PTY.
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn",
                        lambda agent_key, _command=None: {"agent_key": agent_key, "binary_path": f"/test/bin/{agent_key}",
                                                          "version": "1.0.0", "duration_ms": 1})
    monkeypatch.setattr(app, "attribution", SimpleNamespace(register_pane=lambda *a, **k: None,
                                                            scan_pane_baseline=lambda *a, **k: None))
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(usage, "request_refresh", lambda *a, **k: None)
    monkeypatch.setattr(usage_service, "start_login_watch", lambda *a, **k: None)
    return SimpleNamespace(store=store, vault=app.credential_vault, usage=usage, events=events, service=service)


def session() -> app.Session:
    s = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    s.terminals = FakeTerminals()  # type: ignore[assignment]
    return s


async def call(s: app.Session, msg_type: str, payload: dict[str, Any], msg_id: str = "m") -> dict[str, Any]:
    before = len(s.websocket.sent)  # type: ignore[attr-defined]
    await app.handle_message(s, {"id": msg_id, "type": msg_type, "payload": payload})
    answers = [f for f in s.websocket.sent[before:] if f.get("id") == msg_id]  # type: ignore[attr-defined]
    assert len(answers) == 1, answers
    return answers[0]


def active_account(rig: SimpleNamespace, agent_key: str) -> str:
    """Profile A, signed in and active, exactly as a completed switch leaves
    it: its credential is live AND mirrored into its slot."""
    a = rig.store.create(agent_key=agent_key, name="A")["id"]
    rig.store.set_default(agent_key, a)
    rig.vault.write_live(agent_key, LiveCredentials(secret=secret(agent_key, "A")))
    rig.vault.capture(agent_key, a)
    assert same(rig.vault.read_slot(agent_key, a).secret, secret(agent_key, "A"))
    return a


def register_login_pane(s: app.Session, agent_key: str, profile_id: str, term_id: str = "login-1") -> None:
    term = SimpleNamespace(id=term_id, pane_id="p-login", agent_key=agent_key, closed=False,
                           metadata={"login_profile_id": profile_id})
    s.terminals.registry[term_id] = term  # type: ignore[attr-defined]
    app._PTY_OWNERS[term_id] = s


def register_regular_pane(s: app.Session, agent_key: str, term_id: str = "work-1") -> None:
    term = SimpleNamespace(id=term_id, pane_id="p-work", agent_key=agent_key, closed=False, metadata={})
    s.terminals.registry[term_id] = term  # type: ignore[attr-defined]
    app._PTY_OWNERS[term_id] = s


async def spawn_login_pane(s: app.Session, agent_key: str, profile_id: str, msg_id: str = "spawn") -> dict[str, Any]:
    """What the Accounts pane's "Add account" does: a terminal.create with
    login_profile_id, the CLI itself replaced by the spawn stubs."""
    return await call(s, "terminal.create", {
        "pane_id": f"{agent_key}-login", "agent_key": agent_key, "command": agent_key,
        "cwd": "/ws", "metadata": {"workspace_path": "/ws"}, "login_profile_id": profile_id,
    }, msg_id=msg_id)


# ── what the vault declares ───────────────────────────────────────────────────

@pytest.mark.parametrize("agent_key", NO_ISOLATION)
def test_these_vendors_sign_in_against_the_live_store(rig, agent_key: str) -> None:
    """No env lever: the pane signs in against the live store. What the
    vault keeps for such a login is only its bookkeeping (the pre-login
    snapshot of the active account), never a credential file the CLI wrote."""
    active_account(rig, agent_key)
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    assert rig.vault.login_spawn_env(agent_key, b) == ({}, [])
    assert rig.vault.login_secret_present(agent_key, b) is False  # nothing signed in yet
    assert rig.vault.slot_is_empty(agent_key, b)


@pytest.mark.parametrize("agent_key", ["codex", "droid"])
def test_these_vendors_get_an_isolated_login_home(rig, agent_key: str) -> None:
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    env_set, _removed = rig.vault.login_spawn_env(agent_key, b)
    home = rig.vault.login_home_path(agent_key, b)
    assert home.is_dir()
    assert list(env_set.values()) == [str(home)] or str(home) in env_set.values()


# ── the flow ──────────────────────────────────────────────────────────────────

async def test_isolated_login_keeps_the_active_account_intact(rig) -> None:
    """Positive control (codex): the sign-in lands in the login home, the
    switch harvests it into B's slot, captures A into A's slot and brings B
    live. Nothing of A is lost."""
    s = session()
    agent_key = "codex"
    a = active_account(rig, "codex")
    b = rig.store.create(agent_key="codex", name="B")["id"]
    env_set, _ = rig.vault.login_spawn_env("codex", b)
    home = Path(env_set["CODEX_HOME"])
    (home / "auth.json").write_text(secret(agent_key, "B"), encoding="utf-8")  # what `codex login` writes there
    assert same(rig.vault.read_live("codex").secret, secret(agent_key, "A"))  # the live account was never touched

    await rig.usage._harvest_active_slots()  # the poller may run before the switch
    assert same(rig.vault.read_slot("codex", a).secret, secret(agent_key, "A"))

    answer = await call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert answer["ok"] is True and answer["payload"]["needsLogin"] is False, answer
    assert same(rig.vault.read_live("codex").secret, secret(agent_key, "B"))
    assert same(rig.vault.read_slot("codex", a).secret, secret(agent_key, "A"))
    assert same(rig.vault.read_slot("codex", b).secret, secret(agent_key, "B"))
    assert not home.is_dir()


@pytest.mark.parametrize("agent_key", NO_ISOLATION)
async def test_add_account_login_must_not_cost_the_active_account(rig, agent_key: str) -> None:
    """Same flow for a vendor without login isolation. The contract is the
    same: after "Add account -> sign in as B -> switch to B", A's credential
    is still in A's slot and B's is live. However the product gets there —
    capturing A before the sign-in, harvesting B into B's slot afterwards, or
    refusing the flow up front — it must not end with A overwritten by B's
    credential and B's slot empty."""
    s = session()
    a = active_account(rig, agent_key)
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    assert rig.vault.login_spawn_env(agent_key, b) == ({}, [])
    # The login pane runs against the live store: completing the sign-in
    # replaces the live credential (A's) with B's.
    rig.vault.write_live(agent_key, LiveCredentials(secret=secret(agent_key, "B")))
    assert same(rig.vault.read_live(agent_key).secret, secret(agent_key, "B"))

    await rig.usage._harvest_active_slots()
    # Whatever the harvest did, A's own copy must still be A's...
    assert same(rig.vault.read_slot(agent_key, a).secret, secret(agent_key, "A")), "the poller mirrored B's live credential into A's slot"

    answer = await call(s, "cli_profiles.set_default", {"agent_key": agent_key, "profile_id": b})
    assert same(rig.vault.read_slot(agent_key, a).secret, secret(agent_key, "A")), \
        "switching to B captured B's live credential into A's slot — A's only copy is gone"
    if answer["ok"]:
        assert same(rig.vault.read_live(agent_key).secret, secret(agent_key, "B")), \
            "the switch signed the user out: B's slot was empty, so restoring it cleared the live credential"
        assert same(rig.vault.read_slot(agent_key, b).secret, secret(agent_key, "B"))


@pytest.mark.parametrize("agent_key", NO_ISOLATION)
async def test_live_login_is_refused_while_other_panes_of_the_agent_run(rig, agent_key: str) -> None:
    """A sign-in without isolation replaces the credential every running pane
    of this CLI is using. With such a pane alive the login pane must not be
    spawned (the same quiescence the account switch enforces), and the live
    credential must be untouched by the attempt."""
    s = session()
    a = active_account(rig, agent_key)
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    register_regular_pane(s, agent_key)

    answer = await spawn_login_pane(s, agent_key, b)
    assert answer["ok"] is False, answer
    assert answer["error"]["code"] == "LOGIN_BLOCKED_BY_LIVE_PANES"
    assert answer["error"]["details"]["count"] == 1
    assert s.terminals.created == []  # type: ignore[attr-defined]
    # The refused spawn leaves no "login pending" bookkeeping behind.
    assert rig.vault.login_pending(agent_key, b) is False
    assert same(rig.vault.read_live(agent_key).secret, secret(agent_key, "A"))
    assert same(rig.vault.read_slot(agent_key, a).secret, secret(agent_key, "A"))
    assert rig.store.list()["defaults"][agent_key] == a


@pytest.mark.parametrize("wrote", [False, True], ids=["closed-before-signing-in", "signed-in-then-removed"])
@pytest.mark.parametrize("agent_key", NO_ISOLATION)
async def test_cancelling_a_live_login_keeps_the_active_account(rig, agent_key: str, wrote: bool) -> None:
    """The user abandons "Add account": the login pane is closed, then the
    empty row is removed. Whether or not the CLI had already written B's
    credential over the live store, the outcome is the state before the
    attempt: A live, A's slot intact, no leftover bookkeeping."""
    s = session()
    a = active_account(rig, agent_key)
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    assert rig.vault.login_spawn_env(agent_key, b) == ({}, [])
    if wrote:
        rig.vault.write_live(agent_key, LiveCredentials(secret=secret(agent_key, "B")))
    # The login pane is gone (closed or exited); nothing of it is running.

    answer = await call(s, "cli_profiles.delete", {"id": b}, msg_id="rm")
    assert answer["ok"] is True, answer
    assert same(rig.vault.read_live(agent_key).secret, secret(agent_key, "A")), \
        "removing the abandoned account left B's credential live under A's record"
    assert same(rig.vault.read_slot(agent_key, a).secret, secret(agent_key, "A"))
    assert rig.store.list()["defaults"][agent_key] == a
    assert not rig.vault.login_home_path(agent_key, b).is_dir()
    assert b not in [p["id"] for p in rig.store.list()["profiles"]]


@pytest.mark.parametrize("agent_key", ["codex", *NO_ISOLATION])
async def test_switching_while_the_sign_in_pane_still_runs_is_refused(rig, agent_key: str) -> None:
    """A running sign-in pane for the target account means its credential is
    still being written. The switch must wait (LOGIN_IN_PROGRESS), for every
    vendor — not only for those whose login has a home to harvest."""
    s = session()
    a = active_account(rig, agent_key)
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    rig.vault.login_spawn_env(agent_key, b)
    register_login_pane(s, agent_key, b)

    answer = await call(s, "cli_profiles.set_default", {"agent_key": agent_key, "profile_id": b})
    assert answer["ok"] is False and answer["error"]["code"] == "LOGIN_IN_PROGRESS", answer
    assert same(rig.vault.read_live(agent_key).secret, secret(agent_key, "A"))
    assert same(rig.vault.read_slot(agent_key, a).secret, secret(agent_key, "A"))
    assert rig.store.list()["defaults"][agent_key] == a


# ── live drift: a token refresh is not a different account ───────────────────

def _jwt(email: str) -> str:
    import base64

    def b64(obj: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")
    return f"{b64({'alg': 'none'})}.{b64({'email': email})}.sig"


def identity_secret(agent_key: str, who: str, generation: int, account_id: str | None = None) -> LiveCredentials:
    """A credential whose *tokens* change with ``generation`` (what an OAuth
    refresh does) while its identity stays ``who``. claude keeps the identity
    beside the secret (``oauthAccount``); codex carries it inside the secret
    (the id_token's email)."""
    if agent_key == "claude":
        secret = json.dumps({"claudeAiOauth": {
            "accessToken": f"at-{who}-{generation}", "refreshToken": f"rt-{who}-{generation}",
            "expiresAt": (T0 + 86_400 * generation) * 1000,
        }})
        account: dict[str, Any] = {"emailAddress": f"{who}@example.com"}
        if account_id is not None:
            # ~/.claude.json oauthAccount, kept whole beside the secret by the
            # vault: the organisation the login belongs to. One email can be
            # a member of several organisations, each with its own quota.
            account["accountUuid"] = f"user-{who}"
            account["organizationUuid"] = account_id
        return LiveCredentials(secret=secret, account=account)
    tokens: dict[str, Any] = {
        "access_token": f"at-{who}-{generation}", "refresh_token": f"rt-{who}-{generation}",
        "id_token": _jwt(f"{who}@example.com"),
    }
    if account_id is not None:
        # codex auth.json: the ChatGPT account the tokens belong to
        # (cli_vendors/codex.py reads tokens.account_id for the
        # ChatGPT-Account-Id header) — stable across refreshes, and different
        # for a personal and a team pool that share one email.
        tokens["account_id"] = account_id
    secret = json.dumps({"tokens": tokens, "last_refresh": f"2026-09-21T00:0{generation}:00Z"})
    return LiveCredentials(secret=secret)


T0 = 1_800_000_000


def _tokens(secret: str | None) -> str:
    """The access token of a credential, whichever vendor shape it is in."""
    data = json.loads(secret or "{}")
    return data.get("claudeAiOauth", data.get("tokens", {})).get("accessToken") \
        or data.get("tokens", {}).get("access_token")


@pytest.mark.parametrize("agent_key", ["claude", "codex"])
async def test_a_refreshed_token_of_the_same_account_still_switches_and_is_kept(rig, agent_key: str) -> None:
    """The CLI refreshed A's OAuth tokens since the last switch: the live
    credential differs byte-for-byte from A's slot, but it is still A. A
    switch to B must go ahead and must keep A's *refreshed* tokens."""
    s = session()
    a = rig.store.create(agent_key=agent_key, name="A")["id"]
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    rig.store.set_default(agent_key, a)
    rig.vault.write_live(agent_key, identity_secret(agent_key, "a", 1))
    rig.vault.capture(agent_key, a)                                   # slot A = generation 1
    rig.vault.write_slot(agent_key, b, identity_secret(agent_key, "b", 1))
    rig.vault.write_live(agent_key, identity_secret(agent_key, "a", 2))  # A refreshed itself
    assert rig.vault.identity(agent_key)["email"] == "a@example.com"

    answer = await call(s, "cli_profiles.set_default", {"agent_key": agent_key, "profile_id": b})
    assert answer["ok"] is True, answer.get("error")
    assert answer["payload"].get("adoptedLiveLogin") is not True
    assert _tokens(rig.vault.read_live(agent_key).secret) == "at-b-1"
    assert _tokens(rig.vault.read_slot(agent_key, a).secret) == "at-a-2", "A's refreshed tokens were not kept"
    assert rig.vault.identity(agent_key, a)["email"] == "a@example.com"
    assert rig.store.list()["defaults"][agent_key] == b


@pytest.mark.parametrize("agent_key", ["claude", "codex"])
async def test_a_different_live_identity_is_drift_and_leaves_a_untouched(rig, agent_key: str) -> None:
    """Someone signed in as C against the live store while the record still
    says A: switching to (non-empty) B must be refused and A's slot must not
    receive C's credential."""
    s = session()
    a = rig.store.create(agent_key=agent_key, name="A")["id"]
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    rig.store.set_default(agent_key, a)
    rig.vault.write_live(agent_key, identity_secret(agent_key, "a", 1))
    rig.vault.capture(agent_key, a)
    rig.vault.write_slot(agent_key, b, identity_secret(agent_key, "b", 1))
    rig.vault.write_live(agent_key, identity_secret(agent_key, "c", 1))
    assert rig.vault.identity(agent_key)["email"] == "c@example.com"

    answer = await call(s, "cli_profiles.set_default", {"agent_key": agent_key, "profile_id": b})
    assert answer["ok"] is False and answer["error"]["code"] == "LIVE_DRIFT", answer
    assert _tokens(rig.vault.read_slot(agent_key, a).secret) == "at-a-1"
    assert _tokens(rig.vault.read_live(agent_key).secret) == "at-c-1"
    assert rig.store.list()["defaults"][agent_key] == a


def _seed_identity_accounts(rig: SimpleNamespace, agent_key: str, live: LiveCredentials) -> tuple[str, str]:
    a = rig.store.create(agent_key=agent_key, name="A")["id"]
    b = rig.store.create(agent_key=agent_key, name="B")["id"]
    rig.store.set_default(agent_key, a)
    rig.vault.write_live(agent_key, identity_secret(agent_key, "a", 1))
    rig.vault.capture(agent_key, a)
    rig.vault.write_slot(agent_key, b, identity_secret(agent_key, "b", 1))
    rig.vault.write_live(agent_key, live)
    return a, b


def _failover_proposal(agent_key: str, a: str, b: str) -> dict[str, Any]:
    return {"agent_key": agent_key, "to_slot_id": b, "expected_current_slot_id": a,
            "expected_epoch": 0, "idempotency_key": f"drift-{agent_key}"}


@pytest.mark.parametrize("agent_key", ["claude", "codex"])
async def test_failover_route_also_switches_after_a_same_account_refresh(rig, agent_key: str) -> None:
    """The second entry point (quota_failover.switch) must agree with the
    manual route: a refreshed A is still A — switch to B, keep the refreshed
    tokens in A's slot."""
    s = session()
    a, b = _seed_identity_accounts(rig, agent_key, identity_secret(agent_key, "a", 2))
    answer = await call(s, "quota_failover.switch", _failover_proposal(agent_key, a, b))
    assert answer["ok"] is True, answer.get("error")
    tx = answer["payload"]["transaction"]
    assert tx["state"] == "committed" and tx["swapped"] is True
    assert _tokens(rig.vault.read_live(agent_key).secret) == "at-b-1"
    assert _tokens(rig.vault.read_slot(agent_key, a).secret) == "at-a-2", "A's refreshed tokens were not kept"
    assert rig.store.list()["defaults"][agent_key] == b


@pytest.mark.parametrize("agent_key", ["claude", "codex"])
async def test_failover_route_refuses_a_different_live_identity_and_leaves_a_untouched(rig, agent_key: str) -> None:
    s = session()
    a, b = _seed_identity_accounts(rig, agent_key, identity_secret(agent_key, "c", 1))
    answer = await call(s, "quota_failover.switch", _failover_proposal(agent_key, a, b))
    # This route answers with the transaction: it must end cancelled for
    # drift, with nothing swapped (a refusal frame is equally acceptable).
    if answer["ok"]:
        tx = answer["payload"]["transaction"]
        assert tx["state"] == "cancelled" and tx["swapped"] is False, tx
        assert tx["reason"] == "live-drift"
    assert _tokens(rig.vault.read_slot(agent_key, a).secret) == "at-a-1", "A's slot took C's credential"
    assert _tokens(rig.vault.read_live(agent_key).secret) == "at-c-1"
    assert rig.store.list()["defaults"][agent_key] == a
    state = (await call(s, "quota_failover.get_state", {}, msg_id="st"))["payload"]
    assert not any(t["swapped"] for t in state["transactions"] + state["recentTransactions"])


# ── a stable account id beats a shared email ──────────────────────────────────
# codex: auth.json tokens.account_id (cli_vendors/codex.py). claude: the
# oauthAccount object the vault keeps beside the secret (organizationUuid —
# one email, several organisations, each its own quota pool).

async def test_codex_refresh_with_the_same_account_id_still_switches(rig) -> None:
    s = session()
    a, b = _seed_identity_accounts(rig, "codex", identity_secret("codex", "a", 2, account_id="acct-A"))
    # Seed A's slot with the same account id, generation 1.
    rig.vault.write_slot("codex", a, identity_secret("codex", "a", 1, account_id="acct-A"))
    answer = await call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert answer["ok"] is True, answer.get("error")
    assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a-2"
    assert json.loads(rig.vault.read_slot("codex", a).secret)["tokens"]["account_id"] == "acct-A"
    assert _tokens(rig.vault.read_live("codex").secret) == "at-b-1"


async def test_codex_same_email_but_another_account_id_is_drift(rig) -> None:
    """A personal and a team ChatGPT account can share one email; the live
    credential belonging to another account id is not a refresh of A."""
    s = session()
    a, b = _seed_identity_accounts(rig, "codex", identity_secret("codex", "a", 2, account_id="acct-TEAM"))
    rig.vault.write_slot("codex", a, identity_secret("codex", "a", 1, account_id="acct-A"))

    answer = await call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert answer["ok"] is False, "a different account id behind the same email was treated as a refresh"
    assert answer["error"]["code"] == "LIVE_DRIFT", answer["error"]
    assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a-1"
    assert json.loads(rig.vault.read_slot("codex", a).secret)["tokens"]["account_id"] == "acct-A"
    assert _tokens(rig.vault.read_live("codex").secret) == "at-a-2"
    assert rig.store.list()["defaults"]["codex"] == a

    answer = await call(s, "quota_failover.switch", _failover_proposal("codex", a, b), msg_id="fo")
    if answer["ok"]:
        tx = answer["payload"]["transaction"]
        assert tx["state"] == "cancelled" and tx["swapped"] is False, tx
    assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a-1"
    assert rig.store.list()["defaults"]["codex"] == a


async def test_claude_refresh_within_the_same_organisation_still_switches(rig) -> None:
    s = session()
    a, b = _seed_identity_accounts(rig, "claude", identity_secret("claude", "a", 2, account_id="org-A"))
    rig.vault.write_slot("claude", a, identity_secret("claude", "a", 1, account_id="org-A"))
    answer = await call(s, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": b})
    assert answer["ok"] is True, answer.get("error")
    assert _tokens(rig.vault.read_slot("claude", a).secret) == "at-a-2"
    assert rig.vault.read_slot("claude", a).account["organizationUuid"] == "org-A"
    assert _tokens(rig.vault.read_live("claude").secret) == "at-b-1"


async def test_claude_same_email_in_another_organisation_is_drift(rig) -> None:
    s = session()
    a, b = _seed_identity_accounts(rig, "claude", identity_secret("claude", "a", 2, account_id="org-TEAM"))
    rig.vault.write_slot("claude", a, identity_secret("claude", "a", 1, account_id="org-A"))

    answer = await call(s, "cli_profiles.set_default", {"agent_key": "claude", "profile_id": b})
    assert answer["ok"] is False, "another organisation behind the same email was treated as a refresh"
    assert answer["error"]["code"] == "LIVE_DRIFT", answer["error"]
    assert _tokens(rig.vault.read_slot("claude", a).secret) == "at-a-1"
    assert rig.vault.read_slot("claude", a).account["organizationUuid"] == "org-A"
    assert _tokens(rig.vault.read_live("claude").secret) == "at-a-2"
    assert rig.store.list()["defaults"]["claude"] == a

    answer = await call(s, "quota_failover.switch", _failover_proposal("claude", a, b), msg_id="fo")
    if answer["ok"]:
        tx = answer["payload"]["transaction"]
        assert tx["state"] == "cancelled" and tx["swapped"] is False, tx
    assert _tokens(rig.vault.read_slot("claude", a).secret) == "at-a-1"
    assert rig.store.list()["defaults"]["claude"] == a


# ── opaque credential: the manual "assume live is current" confirmation ──────

def opaque_secret(tag: str) -> LiveCredentials:
    """A codex-shaped credential carrying no identity at all (no id_token,
    no account_id): a rotated token and a foreign sign-in look alike."""
    return LiveCredentials(secret=json.dumps({"tokens": {"access_token": f"at-{tag}", "refresh_token": f"rt-{tag}"}}))


def resend_with(details: dict[str, Any], **payload: Any) -> dict[str, Any]:
    """The confirmation re-send, carrying back whatever the refusal handed out
    so the backend can bind it to the state the user actually confirmed."""
    out = {**payload, "assume_live_is_current": True, "expected_current_slot_id": details.get("currentSlotId")}
    if details.get("liveFingerprint") is not None:
        out["live_fingerprint"] = details["liveFingerprint"]
    if details.get("epoch") is not None:
        out["expected_epoch"] = details["epoch"]
    return out


async def test_opaque_drift_is_refused_until_the_user_confirms_then_switches(rig) -> None:
    s = session()
    a = rig.store.create(agent_key="codex", name="A")["id"]
    b = rig.store.create(agent_key="codex", name="B")["id"]
    rig.store.set_default("codex", a)
    rig.vault.write_live("codex", opaque_secret("a1"))
    rig.vault.capture("codex", a)
    rig.vault.write_slot("codex", b, opaque_secret("b1"))
    rig.vault.write_live("codex", opaque_secret("a2"))  # rotated — or foreign; nobody can tell

    first = await call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert first["ok"] is False and first["error"]["code"] == "LIVE_DRIFT", first
    details = first["error"]["details"]
    assert details["verified"] is False and details["currentSlotId"] == a
    assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a1"  # nothing moved

    confirmed = await call(s, "cli_profiles.set_default", resend_with(details, agent_key="codex", profile_id=b), msg_id="confirm")
    assert confirmed["ok"] is True, confirmed.get("error")
    assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a2"  # the confirmed live credential is A's
    assert _tokens(rig.vault.read_live("codex").secret) == "at-b1"
    assert rig.store.list()["defaults"]["codex"] == b


async def test_a_stale_confirmation_after_another_window_switched_does_not_capture_into_the_new_current(rig) -> None:
    """Window 1 is showing the confirmation for "live is still A". Meanwhile
    window 2 completes a switch, so the active account is B and the live
    credential has moved on again. Window 1's confirmation was about a state
    that no longer exists: it must be refused, and B's slot must not receive
    whatever is live now."""
    w1, w2 = session(), session()
    a = rig.store.create(agent_key="codex", name="A")["id"]
    b = rig.store.create(agent_key="codex", name="B")["id"]
    c = rig.store.create(agent_key="codex", name="C")["id"]
    rig.store.set_default("codex", a)
    rig.vault.write_live("codex", opaque_secret("a1"))
    rig.vault.capture("codex", a)
    rig.vault.write_slot("codex", b, opaque_secret("b1"))
    rig.vault.write_slot("codex", c, opaque_secret("c1"))
    rig.vault.write_live("codex", opaque_secret("a2"))

    first = await call(w1, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": c})
    assert first["ok"] is False and first["error"]["code"] == "LIVE_DRIFT", first
    details = first["error"]["details"]

    # Window 2 confirms and switches to B in the meantime.
    ok2 = await call(w2, "cli_profiles.set_default", resend_with(details, agent_key="codex", profile_id=b), msg_id="w2")
    assert ok2["ok"] is True, ok2.get("error")
    assert rig.store.list()["defaults"]["codex"] == b
    assert _tokens(rig.vault.read_live("codex").secret) == "at-b1"
    rig.vault.write_live("codex", opaque_secret("x9"))  # live moved on again under B

    stale = await call(w1, "cli_profiles.set_default", resend_with(details, agent_key="codex", profile_id=c), msg_id="stale")
    assert stale["ok"] is False, "a confirmation given for the old state was applied to the new one"
    assert stale["error"]["code"] in ("STALE_STATE", "LIVE_DRIFT"), stale["error"]
    assert _tokens(rig.vault.read_slot("codex", b).secret) == "at-b1", "B's slot took the credential live now"
    assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a2"
    assert _tokens(rig.vault.read_live("codex").secret) == "at-x9"
    assert rig.store.list()["defaults"]["codex"] == b


async def test_a_confirmation_without_the_state_it_confirms_cannot_assume(rig) -> None:
    """``assume_live_is_current`` on its own is not a confirmation: the
    re-send must name the state the user saw — current slot, epoch AND the
    live fingerprint. Each row below has everything right except one thing,
    so each guard is exercised on its own; nothing moves in any of them."""
    s = session()
    a = rig.store.create(agent_key="codex", name="A")["id"]
    b = rig.store.create(agent_key="codex", name="B")["id"]
    rig.store.set_default("codex", a)
    rig.vault.write_live("codex", opaque_secret("a1"))
    rig.vault.capture("codex", a)
    rig.vault.write_slot("codex", b, opaque_secret("b1"))
    rig.vault.write_live("codex", opaque_secret("a2"))
    first = await call(s, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert first["ok"] is False and first["error"]["code"] == "LIVE_DRIFT", first
    details = first["error"]["details"]
    assert details.get("liveFingerprint"), details
    good = resend_with(details, agent_key="codex", profile_id=b)

    def untouched(tag: str, live: str = "at-a2") -> None:
        assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a1", tag
        assert _tokens(rig.vault.read_slot("codex", b).secret) == "at-b1", tag
        assert _tokens(rig.vault.read_live("codex").secret) == live, tag
        assert rig.store.list()["defaults"]["codex"] == a, tag

    # 1) assume with nothing to bind it to
    bare = await call(s, "cli_profiles.set_default",
                      {"agent_key": "codex", "profile_id": b, "assume_live_is_current": True}, msg_id="bare")
    assert bare["ok"] is False, bare
    untouched("bare")
    # 2) current and epoch right, fingerprint missing
    no_fp = {k: v for k, v in good.items() if k != "live_fingerprint"}
    answer = await call(s, "cli_profiles.set_default", no_fp, msg_id="no-fp")
    assert answer["ok"] is False, ("a confirmation without the live fingerprint was accepted", answer)
    untouched("no-fp")
    # 3) current and epoch right, fingerprint wrong
    answer = await call(s, "cli_profiles.set_default", {**good, "live_fingerprint": "not-what-was-shown"}, msg_id="wrong-fp")
    assert answer["ok"] is False, answer
    assert answer["error"]["code"] in ("LIVE_DRIFT", "STALE_STATE"), answer["error"]
    untouched("wrong-fp")
    # 4) everything as shown, but the live credential changed again while the
    #    dialog was open (same current slot, same epoch): the fingerprint is
    #    the only thing that can catch it.
    rig.vault.write_live("codex", opaque_secret("c1"))
    answer = await call(s, "cli_profiles.set_default", good, msg_id="live-moved")
    assert answer["ok"] is False, ("a confirmation for a2 was applied to c1", answer)
    assert answer["error"]["code"] in ("LIVE_DRIFT", "STALE_STATE"), answer["error"]
    untouched("live-moved", live="at-c1")
    # 5) the honest re-send, against the state it confirms
    rig.vault.write_live("codex", opaque_secret("a2"))
    answer = await call(s, "cli_profiles.set_default", good, msg_id="honest")
    assert answer["ok"] is True, answer.get("error")
    assert _tokens(rig.vault.read_slot("codex", a).secret) == "at-a2"
    assert _tokens(rig.vault.read_live("codex").secret) == "at-b1"
    assert rig.store.list()["defaults"]["codex"] == b


async def test_a_confirmation_is_stale_after_a_round_trip_that_lands_on_the_same_current(rig) -> None:
    """A → C → A in another window: the current slot reads A again, but the
    live credential and the epoch are not what window 1 confirmed."""
    w1, w2 = session(), session()
    a = rig.store.create(agent_key="codex", name="A")["id"]
    b = rig.store.create(agent_key="codex", name="B")["id"]
    c = rig.store.create(agent_key="codex", name="C")["id"]
    rig.store.set_default("codex", a)
    rig.vault.write_live("codex", opaque_secret("a1"))
    rig.vault.capture("codex", a)
    rig.vault.write_slot("codex", b, opaque_secret("b1"))
    rig.vault.write_slot("codex", c, opaque_secret("c1"))
    rig.vault.write_live("codex", opaque_secret("a2"))

    first = await call(w1, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": b})
    assert first["ok"] is False and first["error"]["code"] == "LIVE_DRIFT", first
    details = first["error"]["details"]

    # Window 2: confirm, go to C, then come back to A (a plain switch).
    ok2 = await call(w2, "cli_profiles.set_default", resend_with(details, agent_key="codex", profile_id=c), msg_id="to-c")
    assert ok2["ok"] is True, ok2.get("error")
    back = await call(w2, "cli_profiles.set_default", {"agent_key": "codex", "profile_id": a}, msg_id="to-a")
    assert back["ok"] is True, back.get("error")
    assert rig.store.list()["defaults"]["codex"] == a
    # Same current slot, byte-identical live payload (same fingerprint):
    # only the epoch moved, twice, through the manual switches. The epoch
    # guard has to refuse on its own — nothing else differs.
    assert _tokens(rig.vault.read_live("codex").secret) == "at-a2"
    assert rig.service.epoch("codex") > int(details.get("epoch", 0))

    stale = await call(w1, "cli_profiles.set_default", resend_with(details, agent_key="codex", profile_id=b), msg_id="stale")
    assert stale["ok"] is False, "a confirmation from before the round trip was applied to the new state"
    assert stale["error"]["code"] == "STALE_EPOCH", stale["error"]  # the epoch alone must decide here
    assert _tokens(rig.vault.read_slot("codex", b).secret) == "at-b1"
    assert _tokens(rig.vault.read_live("codex").secret) == "at-a2"  # no switch happened
    assert rig.store.list()["defaults"]["codex"] == a
