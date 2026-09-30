"""A review decision applies only to the artifacts the reviewer saw, and only
while they are still pending."""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from registry.models import ExtensionVersion
from tests.fixtures import build_v2_package, contract_manifest
from tests.phase2_helpers import (
    ADMIN_HEADERS,
    ADMIN_MEMBER,
    claim,
    cloud_settings,
    csrf_of,
    make_client,
    new_token,
    publish,
    sign_in,
)
from tests.test_multi_target import MACHO_ARM64, PE_X64

BASE = "/api/admin/review/acme-tools/skills/1.0.0"


@pytest.fixture()
def client(tmp_path):
    client = make_client(cloud_settings(tmp_path))
    sign_in(client)
    return client


def _native_package(backend_data: bytes) -> bytes:
    manifest = contract_manifest("backend-only-skills.json")
    manifest.update(id="acme-tools.skills", publisher="acme-tools")
    backend_name = manifest["backend"]["entry"] + ".exe" if backend_data.startswith(b"MZ") else None
    return build_v2_package(manifest, backend_data=backend_data, backend_name=backend_name)


def _submit(client, target: str) -> str:
    """Upload one target; return its package digest."""
    token = new_token(client, "acme-tools")
    data = MACHO_ARM64 if target == "darwin-arm64" else PE_X64
    resp = publish(client, token, _native_package(data), target)
    assert resp.status_code == 201, resp.text
    return resp.json()["package_digest"]


def _queued_artifacts(client) -> list[str]:
    (item,) = client.get("/api/admin/review", headers=ADMIN_HEADERS).json()["items"]
    return item["artifacts"]


def _rows(client) -> dict[str, ExtensionVersion]:
    with Session(client.app.state.registry.engine) as session:
        return {row.target: row for row in session.exec(select(ExtensionVersion)).all()}


# -- P2-1: a target uploaded after the reviewer loaded the queue ---------------
def test_approve_refuses_a_target_added_after_the_reviewer_looked(client):
    assert claim(client, "acme-tools").status_code == 303
    seen = [_submit(client, "darwin-arm64")]
    _submit(client, "win32-x64")  # uploaded while the reviewer reads the report

    resp = client.post(f"{BASE}/approve", json={"artifacts": seen}, headers=ADMIN_HEADERS)
    assert resp.status_code == 409, resp.text
    assert "reload" in resp.json()["detail"]
    rows = _rows(client)
    assert {t: (r.review_status, r.registry_signature) for t, r in rows.items()} == {
        "darwin-arm64": ("pending", None),
        "win32-x64": ("pending", None),
    }

    # After a reload the reviewer sees both and can approve both.
    resp = client.post(f"{BASE}/approve", json={"artifacts": _queued_artifacts(client)}, headers=ADMIN_HEADERS)
    assert resp.status_code == 200, resp.text
    assert all(r.review_status == "approved" and r.registry_signature for r in _rows(client).values())


def test_reject_refuses_a_target_added_after_the_reviewer_looked(client):
    assert claim(client, "acme-tools").status_code == 303
    seen = [_submit(client, "darwin-arm64")]
    _submit(client, "win32-x64")
    resp = client.post(f"{BASE}/reject", json={"reason": "malware", "artifacts": seen}, headers=ADMIN_HEADERS)
    assert resp.status_code == 409, resp.text
    assert {r.review_status for r in _rows(client).values()} == {"pending"}


def test_decision_needs_the_artifacts_the_reviewer_saw(client):
    assert claim(client, "acme-tools").status_code == 303
    _submit(client, "darwin-arm64")
    assert client.post(f"{BASE}/approve", headers=ADMIN_HEADERS).status_code == 409
    assert client.post(f"{BASE}/reject", json={"reason": "x"}, headers=ADMIN_HEADERS).status_code == 409
    assert _rows(client)["darwin-arm64"].review_status == "pending"


def test_web_form_carries_the_artifacts_it_showed(client):
    assert claim(client, "acme-tools").status_code == 303
    seen = _submit(client, "darwin-arm64")
    admin = TestClient(client.app, base_url="https://testserver", follow_redirects=False)
    sign_in(admin, member_id=ADMIN_MEMBER, name="Admin")
    csrf = csrf_of(admin, "/admin/review")
    _submit(client, "win32-x64")  # the publisher adds a target meanwhile

    url = "/admin/review/acme-tools/skills/1.0.0/approve"
    resp = admin.post(url, data={"csrf": csrf, "artifact": [seen]})
    assert resp.status_code == 409, resp.text
    assert _rows(client)["win32-x64"].registry_signature is None

    # The reloaded page carries both artifacts in the approve and reject forms.
    page = admin.get("/admin/review").text
    shown = re.findall(r'name="artifact" value="([0-9a-f]{64})"', page)
    assert sorted(set(shown)) == sorted(_queued_artifacts(client))
    assert len(shown) == 4
