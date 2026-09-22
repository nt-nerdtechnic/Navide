"""The real terminal.create route attests quota restart claims before spawning."""

import time
from types import SimpleNamespace

import pytest

from agent_team_backend import app, quota_failover as qf
from tests.test_quota_failover_login_contract import active_account, call, rig, session  # noqa: F401


@pytest.mark.parametrize("claim", ["valid", "legacy", "retry-after-failure", "wrong-owner", "wrong-pane", "stale-epoch", "wrong-profile"])
async def test_terminal_create_validates_quota_claim_under_lock(rig, monkeypatch, claim):
    owner = session()
    target = active_account(rig, "kilo")
    incident = qf.Incident(agent_key="kilo", auth_scope="kilo:kilo", outgoing_slot_id="__default__",
                           epoch=0, now=time.time(), trusted=True, attribution="pane-history",
                           resets_at=None, window_kind=None, auto_allowed=False)
    tx = qf.Transaction(incident=incident, agent_key="kilo", auth_scope="kilo:kilo",
                        from_slot_id="__default__", to_slot_id=target, automatic=False,
                        idempotency_key="spawn", switch_mode="restart", restart_strategy="new-conversation",
                        epoch=0, now=time.time())
    tx.state, tx.swapped = "committed", True
    tx.committed_at, tx.committed_monotonic = time.time(), time.monotonic()
    tx.epoch_after = rig.service._bump_epoch("kilo")
    tx.panes["old-pane"] = {"paneId": "old-pane", "termId": "old-term", "agentKey": "kilo",
                              "workspacePath": "/ws", "settle": None, "sessionId": "old-session"}
    tx.restart_owners["old-pane"] = owner
    rig.service.transactions[tx.id] = tx
    rig.service.incidents[incident.id] = incident
    if claim == "retry-after-failure":
        await rig.service.settle({"transaction_id": tx.id, "pane_id": "old-pane", "outcome": "failed"}, owner=owner)
        assert tx.state == "partial" and tx.closed_at is None
    request_owner = session() if claim == "wrong-owner" else owner
    forgotten = []
    monkeypatch.setattr(app.push_delivery, "forget_pane", forgotten.append)
    # No child process: assert the lock at the real handler's process boundary.
    def create(**kwargs):
        assert rig.vault.switch_lock("kilo").locked()
        request_owner.terminals.created.append(kwargs)
        term = SimpleNamespace(id="new-term", pane_id=kwargs["pane_id"], command=kwargs["command"],
                               proc=SimpleNamespace(pid=4321), metadata=kwargs["metadata"],
                               agent_key="kilo", cwd="/ws", closed=False, started_monotonic=time.monotonic())
        request_owner.terminals.registry[term.id] = term
        return term

    monkeypatch.setattr(request_owner.terminals, "create", create)
    payload = {"agent_key": "kilo", "pane_id": "new-pane", "cwd": "/ws", "command": ["kilo"],
               "cols": 80, "rows": 24, "metadata": {"workspace_path": "/ws",
                   "quota_transaction_id": "forged", "quota_original_pane_id": "forged", "credential_epoch": -1}}
    if claim != "legacy":
        payload.update(quota_transaction_id=tx.id, quota_original_pane_id="old-pane")
    if claim == "wrong-pane":
        payload["quota_original_pane_id"] = "unrelated"
    if claim == "stale-epoch":
        rig.service._bump_epoch("kilo")
    if claim == "wrong-profile":
        payload["metadata"]["profile_id"] = "__default__"
    result = await call(request_owner, "terminal.create", payload)
    if claim not in ("valid", "legacy", "retry-after-failure"):
        assert not result["ok"], result
        assert result["error"]["code"] in ("BAD_RESTART_PROOF", "STALE_EPOCH")
        assert not request_owner.terminals.created
        assert not tx.restart_terms
        assert not request_owner._terminal_create_transactions
        assert forgotten == ["new-pane"]
        return
    assert result["ok"], result
    metadata = request_owner.terminals.created[0]["metadata"]
    assert metadata["credential_epoch"] == tx.epoch_after
    if claim == "legacy":
        assert "quota_transaction_id" not in metadata
        assert "quota_original_pane_id" not in metadata
        assert not tx.restart_terms
    else:
        assert metadata["quota_transaction_id"] == tx.id
        assert metadata["quota_original_pane_id"] == "old-pane"
        assert tx.restart_terms == {"old-pane": "new-term"}
        assert tx.panes["old-pane"]["newPaneId"] == "new-pane"
        if claim == "retry-after-failure":
            assert tx.retry_requested
    assert not rig.vault.switch_lock("kilo").locked()
