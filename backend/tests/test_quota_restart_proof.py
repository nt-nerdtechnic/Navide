"""Restart settlement uses server-owned PTY and session evidence."""

import copy
from types import SimpleNamespace

import pytest

from agent_team_backend import app, quota_failover as qf
from agent_team_backend.log_readers.attribution import Attribution
from tests.test_quota_failover import _codex_incident, _ready, h  # noqa: F401


async def committed_restart(h, monkeypatch):
    owner = h.session()
    incident, tx, target = await _codex_incident(h, panes=[(owner, "old-term", "old-pane")])
    await h.service.ack(_ready(tx.id, "old-pane"))
    attribution = Attribution(app._readers, db=h.db)
    monkeypatch.setattr(app, "attribution", attribution)
    term = h.pane(owner, "new-term", "codex", "new-pane", auth_scope="codex",
                  workspace="/ws-old-pane", credential_source="vault", pin=target,
                  started=tx.committed_monotonic + 0.5)
    term.metadata.update(launch_profile_id=target, credential_epoch=tx.epoch_after,
                         quota_transaction_id=tx.id, quota_original_pane_id="old-pane")
    h.service.validate_restart_spawn(tx.id, "old-pane", owner=owner,
                                     agent_key="codex", metadata=term.metadata)
    h.service.record_restart_spawn(tx.id, "old-pane", term.id)
    attribution.register_pane("new-pane", vendor="codex", cwd="/ws-old-pane",
                              explicit_session_id="sess-1", defer_baseline=True)
    return owner, incident, tx, term


async def test_rebuilt_pane_turn_confirms_restart(h, monkeypatch):
    owner, incident, tx, term = await committed_restart(h, monkeypatch)
    await h.service.settle({"transaction_id": tx.id, "pane_id": "old-pane", "outcome": "resumed",
                            "new_pane_id": "new-pane", "term_id": term.id, "session_id": "sess-1"})
    h.activity["new-pane"] = {"event_type": "turn_complete", "detail": "end_turn",
                               "ts_monotonic": tx.committed_monotonic + 2}
    await h.service.settle({"transaction_id": tx.id, "pane_id": "old-pane",
                            "outcome": "turn-complete", "term_id": term.id})
    assert incident.state == "ready"
    assert tx.panes["old-pane"]["newPaneId"] == "new-pane"


@pytest.mark.parametrize("invalid", [
    "unrelated-term", "wrong-session", "wrong-pane", "stale-epoch", "wrong-owner",
    "wrong-vendor", "wrong-workspace", "wrong-scope", "wrong-profile", "old-launch-epoch",
    "old-start", "closed", "unbound-session", "wrong-transaction", "wrong-original-pane",
    "unrecorded-restart", "portable",
])
async def test_restart_claim_cannot_replace_expected_evidence(h, monkeypatch, invalid):
    owner, incident, tx, term = await committed_restart(h, monkeypatch)
    payload = {"transaction_id": tx.id, "pane_id": "old-pane", "outcome": "resumed",
               "new_pane_id": "new-pane", "term_id": term.id, "session_id": "sess-1"}
    if invalid == "unrelated-term":
        payload["term_id"] = "unknown-term"
    elif invalid == "wrong-session":
        payload["session_id"] = "unrelated-session"
    elif invalid == "wrong-pane":
        payload["new_pane_id"] = "unrelated-pane"
    elif invalid == "stale-epoch":
        h.service._bump_epoch("codex")
    elif invalid == "wrong-owner":
        owner = h.session()
    elif invalid == "wrong-vendor":
        term.agent_key = "claude"
    elif invalid == "wrong-workspace":
        term.metadata["workspace_path"] = "/elsewhere"
    elif invalid == "wrong-scope":
        term.metadata["auth_scope"] = "claude"
    elif invalid == "wrong-profile":
        term.metadata["launch_profile_id"] = "__default__"
    elif invalid == "old-launch-epoch":
        term.metadata["credential_epoch"] = tx.epoch_before
    elif invalid == "old-start":
        term.started_monotonic = tx.committed_monotonic
    elif invalid == "closed":
        term.closed = True
    elif invalid == "unbound-session":
        app.attribution.unregister_pane("new-pane")
    elif invalid == "wrong-transaction":
        term.metadata["quota_transaction_id"] = "other"
    elif invalid == "wrong-original-pane":
        term.metadata["quota_original_pane_id"] = "other"
    elif invalid == "unrecorded-restart":
        tx.restart_terms.clear()
    elif invalid == "portable":
        term.metadata["credential_source"] = "portable"
    before = copy.deepcopy(tx.to_dict())
    with pytest.raises(qf.FailoverRefused):
        await h.service.settle(payload, owner=owner)
    assert tx.to_dict() == before
    assert tx.panes["old-pane"]["sessionId"] == "sess-1"


async def test_legacy_resume_requires_bound_expected_session(h, monkeypatch):
    owner, incident, tx, term = await committed_restart(h, monkeypatch)
    term.metadata.pop("quota_transaction_id")
    term.metadata.pop("quota_original_pane_id")
    await h.service.settle({"transaction_id": tx.id, "pane_id": "old-pane", "outcome": "resumed",
                            "term_id": term.id, "session_id": "sess-1"}, owner=owner)
    assert tx.panes["old-pane"]["newPaneId"] == "new-pane"
    assert tx.panes["old-pane"]["newSessionId"] == "sess-1"


@pytest.mark.parametrize("claimed", [True, False])
async def test_new_conversation_requires_validated_spawn_claim(h, monkeypatch, claimed):
    owner, incident, tx, term = await committed_restart(h, monkeypatch)
    tx.restart_strategy = "new-conversation"
    if not claimed:
        term.metadata.pop("quota_transaction_id")
    payload = {"transaction_id": tx.id, "pane_id": "old-pane", "outcome": "new-conversation",
               "term_id": term.id, "new_pane_id": "new-pane"}
    if not claimed:
        with pytest.raises(qf.FailoverRefused, match="validated spawn claim"):
            await h.service.settle(payload, owner=owner)
        assert tx.panes["old-pane"]["settle"] is None
        return
    await h.service.settle(payload, owner=owner)
    assert tx.panes["old-pane"]["newPaneId"] == "new-pane"
    assert tx.panes["old-pane"]["sessionId"] == "sess-1"
    assert tx.panes["old-pane"]["newSessionId"] == ""
    assert not h.service._restarts_settled(tx)  # Never relabel a fresh chat as a resume.


async def test_spawn_claim_refuses_duplicate_wrong_owner_and_stale_epoch(h, monkeypatch):
    owner, incident, tx, term = await committed_restart(h, monkeypatch)
    before = copy.deepcopy(tx.to_dict())
    for claim_owner in (owner, h.session()):
        with pytest.raises(qf.FailoverRefused):
            h.service.validate_restart_spawn(tx.id, "old-pane", owner=claim_owner,
                                             agent_key="codex", metadata=term.metadata)
    h.service._bump_epoch("codex")
    with pytest.raises(qf.FailoverRefused) as err:
        h.service.validate_restart_spawn(tx.id, "old-pane", owner=owner,
                                         agent_key="codex", metadata=term.metadata)
    assert err.value.code == "STALE_EPOCH"
    assert tx.to_dict() == before


@pytest.mark.parametrize("invalid", ["stale-epoch", "wrong-term", "wrong-owner"])
async def test_late_turn_cannot_borrow_another_restart(h, monkeypatch, invalid):
    owner, incident, tx, term = await committed_restart(h, monkeypatch)
    await h.service.settle({"transaction_id": tx.id, "pane_id": "old-pane", "outcome": "resumed",
                            "term_id": term.id, "session_id": "sess-1"}, owner=owner)
    h.activity["new-pane"] = {"event_type": "turn_complete", "detail": "end_turn",
                               "ts_monotonic": tx.committed_monotonic + 2}
    payload = {"transaction_id": tx.id, "pane_id": "old-pane", "outcome": "turn-complete",
               "term_id": term.id}
    if invalid == "stale-epoch":
        h.service._bump_epoch("codex")
    elif invalid == "wrong-term":
        payload["term_id"] = "unknown"
    else:
        owner = h.session()
    await h.service.settle(payload, owner=owner)
    assert incident.state == "settling"


async def test_failed_restart_other_panes_and_explicit_retry_recover_after_new_proof(h, monkeypatch):
    monotonic = [100.0]
    monkeypatch.setattr(qf, "time", SimpleNamespace(monotonic=lambda: monotonic[0]))
    armed = []
    monkeypatch.setattr(h.service, "_arm_timer", lambda key, delay: armed.append((key, delay)))
    owner, incident, tx, term = await committed_restart(h, monkeypatch)
    second = dict(tx.panes["old-pane"], paneId="second-pane", termId="second-old", sessionId="sess-2")
    tx.panes["second-pane"] = second
    tx.restart_owners["second-pane"] = owner
    await h.service.settle({"transaction_id": tx.id, "pane_id": "old-pane", "outcome": "failed"}, owner=owner)
    assert tx.state == "partial" and tx.closed_at is None and incident.state == "notify-stopped"
    other = h.pane(owner, "second-new", "codex", "second-new-pane", auth_scope="codex",
                   workspace="/ws-old-pane", credential_source="vault", started=tx.committed_monotonic + 1)
    other.metadata.update(term.metadata, quota_original_pane_id="second-pane")
    h.service.validate_restart_spawn(tx.id, "second-pane", owner=owner, agent_key="codex", metadata=other.metadata)
    h.service.record_restart_spawn(tx.id, "second-pane", other.id)
    app.attribution.register_pane(other.pane_id, vendor="codex", cwd="/ws-old-pane",
                                  explicit_session_id="sess-2", defer_baseline=True)
    await h.service.settle({"transaction_id": tx.id, "pane_id": "second-pane", "outcome": "resumed",
                            "term_id": other.id, "session_id": "sess-2"}, owner=owner)
    assert tx.state == "partial" and incident.state == "notify-stopped"
    deadline_count = len(armed)
    # The user retries the failed pane, after stopping its unsuccessful PTY.
    term.closed = True
    replacement = h.pane(owner, "retry-term", "codex", "retry-pane", auth_scope="codex",
                         workspace="/ws-old-pane", credential_source="vault", started=tx.committed_monotonic + 2)
    replacement.metadata.update(term.metadata)
    h.service.validate_restart_spawn(tx.id, "old-pane", owner=owner, agent_key="codex", metadata=replacement.metadata)
    h.service.record_restart_spawn(tx.id, "old-pane", replacement.id)
    app.attribution.register_pane(replacement.pane_id, vendor="codex", cwd="/ws-old-pane",
                                  explicit_session_id="sess-1", defer_baseline=True)
    h.clock.advance(20)
    monotonic[0] = 106.0
    await h.service.settle({"transaction_id": tx.id, "pane_id": "old-pane", "outcome": "resumed",
                            "term_id": replacement.id, "session_id": "sess-1"}, owner=owner)
    assert tx.state == "committed" and incident.state == "settling"
    assert len(armed) == deadline_count + 1
    assert armed[-1] == (f"settle:{tx.id}", qf.SETTLE_TIMEOUT_S)
    # Evidence already present before the retry was fully settled cannot
    # immediately turn the re-opened incident green.
    h.activity[replacement.pane_id] = {"event_type": "turn_complete", "detail": "end_turn", "ts_monotonic": 105.0}
    await h.service.settle({"transaction_id": tx.id, "pane_id": "old-pane", "outcome": "turn-complete",
                            "term_id": replacement.id}, owner=owner)
    from tests.test_quota_failover import snap, window
    h.service.observe_usage("codex", tx.to_slot_id, snap("codex", [window("session", 10, 3600)],
                                                          fetched_at=h.clock.now() - 1))
    assert incident.state == "settling"
    h.activity[replacement.pane_id] = {"event_type": "turn_complete", "detail": "end_turn",
                                      "ts_monotonic": 107.0}
    await h.service.settle({"transaction_id": tx.id, "pane_id": "old-pane", "outcome": "turn-complete",
                            "term_id": replacement.id}, owner=owner)
    assert incident.state == "ready" and tx.closed_at is not None


async def test_owner_takeover_survives_previous_pty_exit(h, monkeypatch):
    owner, incident, tx, term = await committed_restart(h, monkeypatch)
    new_owner = h.session()
    new_owner.terminals = owner.terminals
    app._claim_ptys(new_owner, [term.id])
    assert app._PTY_OWNERS[term.id] is new_owner
    assert tx.restart_owners["old-pane"] is new_owner
    # The original and replacement PTYs may both be gone before retry spawn.
    h.owners.pop("old-term")
    h.owners.pop(term.id)
    term.closed = True
    h.service.validate_restart_spawn(tx.id, "old-pane", owner=new_owner,
                                     agent_key="codex", metadata=term.metadata)
    with pytest.raises(qf.FailoverRefused):
        h.service.validate_restart_spawn(tx.id, "old-pane", owner=owner,
                                         agent_key="codex", metadata=term.metadata)


@pytest.mark.parametrize("bad", ["closed", "no-swap", "other-partial"])
async def test_retry_cannot_reopen_closed_unswapped_or_metadata_partial(h, monkeypatch, bad):
    owner, incident, tx, term = await committed_restart(h, monkeypatch)
    term.closed = True
    if bad == "closed":
        tx.closed_at = h.clock.now()
    elif bad == "no-swap":
        tx.swapped = False
    else:
        tx.state, tx.reason = "partial", "default-persist-failed"
    with pytest.raises(qf.FailoverRefused):
        h.service.validate_restart_spawn(tx.id, "old-pane", owner=owner,
                                         agent_key="codex", metadata=term.metadata)
