"""Vendor quota evidence must agree across reporting, selection and recovery."""
import copy
import json
import re
from datetime import datetime
from pathlib import Path

import pytest

from agent_team_backend import quota_failover as qf
from tests.test_quota_failover import _claude_two_accounts, h, snap, window  # noqa: F401


_SHARED_READINGS = json.loads((Path(__file__).resolve().parents[2] / "tests/fixtures/quota-reading-contract.json")
                            .read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", _SHARED_READINGS["cases"], ids=lambda case: case["name"])
def test_shared_renderer_reading_contract(case):
    now = datetime.fromisoformat(_SHARED_READINGS["now"].replace("Z", "+00:00")).timestamp()
    reading = {"provider": case["agentKey"], "status": "ok", "fetchedAt": _SHARED_READINGS["now"],
               "windows": case["windows"]}
    spent, positive, _ = qf._quota_verdict(reading, now)
    assert spent is case["spent"]
    assert positive is case["positive"]
    assert qf.snapshot_exhausted(reading, now) is case["spent"]
    tier, _, _ = qf.classify_candidate(reading, now=now)
    assert (tier == "fresh-headroom") is case["positive"]
    assert (tier == "exhausted") is case["spent"]


async def test_untrusted_report_cannot_veto_a_healthy_slot(h):
    slot = h.profile("codex", "Healthy")
    s = h.session()
    h.pane(s, "t1", "codex", "pane-1", pin=slot, auth_scope="codex")
    h.headroom_reading("codex", slot)
    h.ledger.observe("codex", slot, h.usage.account_snapshots["codex"][slot], now=h.clock.now())
    assert slot not in h.service._ledger_vetoes("codex", [slot])
    incident, _ = await h.service.report(h.report_payload("codex", "pane-1"))
    assert not incident.trusted
    assert slot not in h.service._ledger_vetoes("codex", [slot])


async def test_missing_weekly_window_cannot_confirm_switched_claude_account(h):
    await h.service.set_policy("auto")
    target = await _claude_two_accounts(h)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__", auth_scope="claude")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", target)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    assert incident.state == "settling"
    h.clock.advance(5)
    h.service.observe_usage("claude", target, snap("claude", [window("session", 5, 3600)],
                                                   fetched_at=h.clock.now()))
    assert incident.state == "settling"


def test_unknown_binding_percentage_cannot_be_fresh_headroom(h):
    snapshot = snap("claude", [window("session", 5, 3600), window("weekly", float("nan"), 86400)],
                    fetched_at=h.clock.now())
    assert qf.classify_candidate(snapshot, now=h.clock.now())[0] != "fresh-headroom"


def test_vendor_semantics_match_renderer_declarations():
    directory = Path(__file__).resolve().parents[2] / "src/renderer/src/platform/plugin-shell/agents"
    declared = {}
    for path in directory.glob("*.ts"):
        match = re.search(r"quotaSemantics:\s*\{([^}]+)\}", path.read_text(encoding="utf-8"))
        if match:
            declared[path.stem] = {key: tuple(re.findall(r"'([^']+)'", values))
                                   for key, values in re.findall(r"(\w+):\s*\[([^]]*)\]", match[1])}
    assert declared == qf.QUOTA_SEMANTICS


@pytest.mark.parametrize("vendor,windows,positive,spent", [
    ("claude", [{"kind": "session", "usedPercent": 5}, {"kind": "weekly", "usedPercent": 10}], True, False),
    ("claude", [{"kind": "session", "usedPercent": 5}], False, False),
    ("claude", [{"kind": "session", "usedPercent": 100}], False, True),
    ("claude", [{"kind": "session", "usedPercent": 5}, {"kind": "weekly", "usedPercent": None}], False, False),
    ("cursor", [{"kind": "cycle", "usedPercent": 100}], False, True),
    ("cursor", [{"kind": "cycle", "usedPercent": 30}], True, False),
    ("cursor", [{"kind": "cycle", "usedPercent": 100}, {"kind": "on-demand", "usedPercent": 10}], True, False),
    ("kilo", [{"kind": "credits", "balance": 0}], False, True),
    ("kilo", [{"kind": "credits", "balance": 5}], True, False),
    ("kilo", [{"kind": "credits", "balance": float("inf")}], False, False),
    ("pi", [{"kind": "credits", "usage": 100, "limit": 100}], False, True),
    ("pi", [{"kind": "credits", "usage": 20, "limit": 100}], True, False),
    ("pi", [{"kind": "credits", "usage": 20, "limit": None}], False, False),
    ("pi", [{"kind": "credits", "usage": float("nan"), "limit": 100}], False, False),
    ("opencode", [{"kind": "session", "usedPercent": 20}], False, False),
    ("opencode", [{"kind": "session", "usedPercent": 100}], False, True),
])
def test_raw_vendor_readings_share_signal_and_candidate_verdict(h, vendor, windows, positive, spent):
    reading = snap(vendor, windows, fetched_at=h.clock.now())
    assert qf.snapshot_exhausted(reading, h.clock.now()) is spent
    tier, _, _ = qf.classify_candidate(reading, now=h.clock.now())
    assert (tier == "fresh-headroom") is positive
    assert (tier == "exhausted") is spent


@pytest.mark.parametrize("vendor,window", [
    ("cursor", {"kind": "cycle", "usedPercent": 100}),
    ("kilo", {"kind": "credits", "balance": 0}),
    ("pi", {"kind": "credits", "usage": 100, "limit": 100}),
])
async def test_real_usage_window_report_accepts_vendor_raw_shapes(h, vendor, window):
    s = h.session()
    h.pane(s, "term", vendor, "pane", pin="__default__")
    h.usage.account_snapshots[vendor] = {"__default__": snap(vendor, [window], fetched_at=h.clock.now())}
    incident, _ = await h.service.report(h.report_payload(vendor, "pane"))
    assert incident.trusted and incident.reason is None


async def test_untrusted_report_cannot_close_or_chain_trusted_recovery(h):
    await h.service.set_policy("auto")
    target = await _claude_two_accounts(h)
    s = h.session()
    h.pane(s, "old-term", "claude", "old-pane", pin="__default__", auth_scope="claude")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", target)
    incident, _ = await h.service.report(h.report_payload("claude", "old-pane"))
    h.pane(s, "new-term", "claude", "new-pane", pin=target, auth_scope="claude")
    before = copy.deepcopy(incident.to_dict())
    budget = h.service.budget("claude", "claude")
    untrusted, _ = await h.service.report(h.report_payload("claude", "new-pane"))
    assert not untrusted.trusted and not untrusted.tried
    assert incident.to_dict() == before
    assert h.service.budget("claude", "claude") == budget


@pytest.mark.parametrize("change", ["epoch", "slot"])
async def test_old_transaction_cannot_be_confirmed_after_manual_account_change(h, change):
    await h.service.set_policy("auto")
    target = await _claude_two_accounts(h)
    s = h.session()
    h.pane(s, "t1", "claude", "pane-1", pin="__default__", auth_scope="claude")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", target)
    incident, _ = await h.service.report(h.report_payload("claude", "pane-1"))
    if change == "epoch":
        h.service._bump_epoch("claude")
    else:
        h.store.set_default("claude", None)
    h.clock.advance(5)
    h.service.observe_usage("claude", target, snap("claude", [window("session", 5, 3600), window("weekly", 5, 86400)],
                                                   fetched_at=h.clock.now()))
    assert incident.state == "settling"


async def test_automatic_hot_switch_rebinds_history_before_next_exhaustion(h):
    await h.service.set_policy("auto")
    target = await _claude_two_accounts(h)
    owner = h.session()
    term = h.pane(owner, "t1", "claude", "pane", pin="__default__", auth_scope="claude", credential_source="vault")
    h.exhausted_reading("claude", "__default__")
    h.headroom_reading("claude", target)
    first, _ = await h.service.report(h.report_payload("claude", "pane"))
    assert term.metadata["launch_profile_id"] == target
    assert h.history.profile_at("pane", h.clock.now()) == target
    tx = h.service.transactions[first.transaction_ids[0]]
    expected = [{"paneId": "pane", "termId": "t1", "profileId": target}]
    assert tx.to_dict()["hotSwitchedPanes"] == expected
    assert h.events_of("quota_failover.commit")[-1]["payload"]["hotSwitchedPanes"] == expected
    h.clock.advance(5)
    h.exhausted_reading("claude", target)
    second, _ = await h.service.report(h.report_payload("claude", "pane", idempotency_key="new-slot"))
    assert second.outgoing_slot_id == target
    assert len(h.vault.switch_calls) == 1
