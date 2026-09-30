"""Approve and reject racing on the same pending rows: the decision that
commits second must fail instead of overwriting the first."""

from __future__ import annotations

from sqlmodel import Session, select

from registry import review
from registry.models import Extension
from tests.phase2_helpers import ADMIN_HEADERS, claim
from tests.test_review_integrity import BASE, _rows, _submit, client  # noqa: F401 - fixture


def _race(client, monkeypatch, first: str, artifacts: list[str]) -> None:
    """Run the `first` decision to completion between the other decision's
    read of the pending rows and its write."""
    state = client.app.state.registry
    real = review._pending_rows

    def other_decision() -> None:
        with Session(state.engine) as session:
            extension = session.exec(select(Extension)).one()
            kwargs = dict(extension=extension, version="1.0.0", reviewer="admin-a", artifacts=artifacts)
            if first == "reject":
                review.reject(session, reason="malware", **kwargs)
            else:
                review.approve(session, state.trust_signer, **kwargs)

    def pending_rows_then_race(session, extension, version):
        rows = real(session, extension, version)
        monkeypatch.setattr(review, "_pending_rows", real)
        other_decision()
        return rows

    monkeypatch.setattr(review, "_pending_rows", pending_rows_then_race)


def test_approve_loses_to_a_reject_that_committed_first(client, monkeypatch):
    assert claim(client, "acme-tools").status_code == 303
    seen = [_submit(client, "darwin-arm64")]
    _race(client, monkeypatch, "reject", seen)

    resp = client.post(f"{BASE}/approve", json={"artifacts": seen}, headers=ADMIN_HEADERS)
    assert resp.status_code == 409, resp.text
    row = _rows(client)["darwin-arm64"]
    assert (row.review_status, row.registry_signature, row.registry_envelope) == ("rejected", None, {})
    assert row.reviewed_by == "admin-a"
    assert client.get("/api/extensions/acme-tools/skills").status_code == 404


def test_reject_loses_to_an_approve_that_committed_first(client, monkeypatch):
    assert claim(client, "acme-tools").status_code == 303
    seen = [_submit(client, "darwin-arm64")]
    _race(client, monkeypatch, "approve", seen)

    resp = client.post(f"{BASE}/reject", json={"reason": "late", "artifacts": seen}, headers=ADMIN_HEADERS)
    assert resp.status_code == 409, resp.text
    row = _rows(client)["darwin-arm64"]
    assert (row.review_status, row.review_reason, row.reviewed_by) == ("approved", None, "admin-a")
    assert row.registry_signature
