"""Namespace claims, review-before-publish, similarity, secret scan and
short-lived publisher tokens."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, select

from registry.models import PublisherToken
from registry.review import APPROVED, PENDING, business_deadline, can_transition
from registry.secret_scan import scan_bytes
from registry.self_service import MAX_NAMESPACES_PER_ACCOUNT
from registry.similarity import check_extension_name, check_namespace_claim, skeleton
import base64

from registry.signing import _load_public_key, canonical_json
from tests.phase2_helpers import (
    ADMIN_HEADERS,
    ADMIN_MEMBER,
    claim,
    cloud_settings,
    csrf_of,
    make_client,
    new_token,
    package_for,
    publish,
    queued_artifacts,
    register_official,
    sign_in,
)

# Built at runtime so the repository itself never contains a key-shaped string.
FAKE_AWS_KEY = "AKIA" + "Q" * 4 + "ABCDEFGHIJKL"
FAKE_GH_TOKEN = "ghp_" + "a1B2" * 9


@pytest.fixture()
def client(tmp_path):
    client = make_client(cloud_settings(tmp_path))
    sign_in(client)
    return client


# -- namespaces -------------------------------------------------------------
def test_claim_is_first_come_first_served(client, tmp_path):
    assert claim(client, "acme-tools").status_code == 303
    other = make_client(cloud_settings(tmp_path))
    sign_in(other, member_id="mem-2")
    resp = claim(other, "acme-tools")
    assert resp.status_code == 409
    assert "already taken" in resp.text


@pytest.mark.parametrize(
    "name, message",
    [
        ("navide", "reserved name"),
        ("official", "reserved name"),
        ("nav1de", "look like the reserved name navide"),
        ("navlde", "look like the reserved name navide"),
        ("Bad_Name", "lowercase"),
        ("ab", "3-32"),
    ],
)
def test_claim_blocks_reserved_and_look_alike_names(client, name, message):
    resp = claim(client, name)
    assert resp.status_code == 409
    assert message in resp.text.replace("&#34;", '"')


def test_claim_blocks_a_look_alike_of_an_existing_namespace(client):
    assert claim(client, "acme-tools").status_code == 303
    resp = claim(client, "acrne-tools")
    assert resp.status_code == 409
    assert "existing namespace acme-tools" in resp.text


def test_an_account_owns_at_most_three_namespaces(client):
    for name in ("alpha-one", "bravo-two", "charlie-three")[:MAX_NAMESPACES_PER_ACCOUNT]:
        assert claim(client, name).status_code == 303
    resp = claim(client, "delta-four")
    assert resp.status_code == 409
    assert f"at most {MAX_NAMESPACES_PER_ACCOUNT}" in resp.text


def test_claim_needs_the_form_token(client):
    resp = client.post("/publisher/claim", data={"namespace": "acme-tools", "csrf": "x"})
    assert resp.status_code == 403


def test_availability_check_page(client):
    assert "is available" in client.get("/publisher/claim", params={"namespace": "acme-tools"}).text
    assert "reserved name navide" in client.get("/publisher/claim", params={"namespace": "nav1de"}).text


def test_similarity_rules():
    assert skeleton("nav1de") == skeleton("navide")
    assert check_namespace_claim("acme-tools", ["other"]).ok is True
    assert not check_namespace_claim("acme-tools", ["acme-tools"]).ok
    blocked = check_extension_name("zzz", "navide-git", [("navide", "git")])
    assert [f.tier for f in blocked] == ["block"]
    assert "navide.git" in blocked[0].message
    same_pub = check_extension_name("acme", "lint-guards", [("acme", "lint-guard")])
    assert [f.tier for f in same_pub] == ["warn"]
    assert "same publisher" in same_pub[0].message
    assert check_extension_name("acme", "notes", [("acme", "lint-guard"), ("zzz", "todo")]) == []


# -- review state machine ---------------------------------------------------
def test_state_machine_only_moves_out_of_pending():
    assert can_transition(PENDING, APPROVED)
    assert can_transition(PENDING, "rejected")
    for final in (APPROVED, "rejected"):
        for target in (PENDING, APPROVED, "rejected"):
            assert not can_transition(final, target)


def test_business_deadline_skips_weekends():
    friday = datetime(2026, 10, 2, 9, tzinfo=timezone.utc)
    assert business_deadline(friday) == friday + timedelta(days=5)  # Wednesday


def _claimed_with_token(client, namespace="acme-tools") -> str:
    assert claim(client, namespace).status_code == 303
    return new_token(client, namespace)


def test_self_claimed_publish_waits_for_review_and_is_invisible(client):
    token = _claimed_with_token(client)
    resp = publish(client, token, package_for("acme-tools", "lint-guard"))
    assert resp.status_code == 201, resp.text
    assert resp.json()["review_status"] == "pending"

    assert client.get("/api/extensions").json()["total"] == 0
    assert client.get("/api/extensions/acme-tools/lint-guard").status_code == 404
    assert client.get("/api/extensions/acme-tools/lint-guard/1.0.0/download").status_code == 404
    assert client.get("/extensions/acme-tools/lint-guard").status_code == 404
    assert "lint-guard" not in client.get("/").text
    dashboard = client.get("/publisher/acme-tools").text
    assert "pending review" in dashboard and "Not public yet" in dashboard


def test_approve_signs_and_publishes(client):
    token = _claimed_with_token(client)
    publish(client, token, package_for("acme-tools", "lint-guard"))
    queue = client.get("/api/admin/review", headers=ADMIN_HEADERS).json()["items"]
    assert [(i["identity"], i["version"]) for i in queue] == [("acme-tools.lint-guard", "1.0.0")]

    artifacts = queued_artifacts(client, "acme-tools", "lint-guard")
    resp = client.post(
        "/api/admin/review/acme-tools/lint-guard/1.0.0/approve", json={"artifacts": artifacts}, headers=ADMIN_HEADERS
    )
    assert resp.status_code == 200, resp.text
    detail = client.get("/api/extensions/acme-tools/lint-guard").json()
    (version,) = detail["versions"]
    assert version["signed"] is True
    assert version["registry_envelope"]["publisherId"] == "acme-tools"
    signer = detail["trust_metadata"]["signers"][0]["publicKey"]
    _load_public_key(signer).verify(  # raises when the signature is wrong
        base64.b64decode(version["registry_signature"]), canonical_json(version["registry_envelope"])
    )
    assert client.get("/api/extensions/acme-tools/lint-guard/1.0.0/download").status_code == 200
    assert client.get("/api/admin/review", headers=ADMIN_HEADERS).json()["items"] == []
    # Final: neither approve nor reject applies any more.
    assert (
        client.post(
            "/api/admin/review/acme-tools/lint-guard/1.0.0/approve", json={"artifacts": artifacts}, headers=ADMIN_HEADERS
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/admin/review/acme-tools/lint-guard/1.0.0/reject",
            json={"reason": "late", "artifacts": artifacts},
            headers=ADMIN_HEADERS,
        ).status_code
        == 409
    )


def test_reject_needs_a_reason_and_shows_it_to_the_publisher(client):
    token = _claimed_with_token(client)
    publish(client, token, package_for("acme-tools", "notes", "0.5.0"))
    url = "/api/admin/review/acme-tools/notes/0.5.0/reject"
    artifacts = queued_artifacts(client, "acme-tools", "notes", "0.5.0")
    assert client.post(url, json={"reason": "  ", "artifacts": artifacts}, headers=ADMIN_HEADERS).status_code == 409
    resp = client.post(
        url, json={"reason": "secret found in dist/config.js", "artifacts": artifacts}, headers=ADMIN_HEADERS
    )
    assert resp.status_code == 200
    assert "Reason: secret found in dist/config.js" in client.get("/publisher/acme-tools").text
    assert client.get("/api/extensions/acme-tools/notes").status_code == 404
    assert (
        client.post(
            "/api/admin/review/acme-tools/notes/0.5.0/approve", json={"artifacts": artifacts}, headers=ADMIN_HEADERS
        ).status_code
        == 409
    )
    # The rejected version stays taken; a fixed build ships as a new version.
    assert publish(client, token, package_for("acme-tools", "notes", "0.5.0")).status_code == 409
    assert publish(client, token, package_for("acme-tools", "notes", "0.5.1")).status_code == 201


def _approve(client, name: str, version: str) -> None:
    artifacts = queued_artifacts(client, "acme-tools", name, version)
    url = f"/api/admin/review/acme-tools/{name}/{version}/approve"
    assert client.post(url, json={"artifacts": artifacts}, headers=ADMIN_HEADERS).status_code == 200


def test_pending_update_does_not_change_the_public_listing(client):
    token = _claimed_with_token(client)
    publish(client, token, package_for("acme-tools", "lint-guard", "1.0.0", description="Old text"))
    _approve(client, "lint-guard", "1.0.0")
    publish(client, token, package_for("acme-tools", "lint-guard", "1.1.0", description="New text"))
    detail = client.get("/api/extensions/acme-tools/lint-guard").json()
    assert detail["description"] == "Old text"
    assert detail["latest_version"] == "1.0.0"
    _approve(client, "lint-guard", "1.1.0")
    detail = client.get("/api/extensions/acme-tools/lint-guard").json()
    assert (detail["description"], detail["latest_version"]) == ("New text", "1.1.0")


def test_official_publisher_stays_auto_approved(client):
    token = register_official(client)
    resp = publish(client, token, package_for("navide", "git"))
    assert resp.status_code == 201
    assert resp.json()["review_status"] == "approved"
    assert client.get("/api/extensions/navide/git").status_code == 200
    assert client.get("/api/admin/review", headers=ADMIN_HEADERS).json()["items"] == []


def test_similarity_block_prevents_approval(client):
    register_official(client)
    publish(client, "official-token", package_for("navide", "git"))
    token = _claimed_with_token(client, "zzz-tools")
    publish(client, token, package_for("zzz-tools", "navide-git"))
    (item,) = client.get("/api/admin/review", headers=ADMIN_HEADERS).json()["items"]
    assert item["similarity_blocked"] is True
    resp = client.post(
        "/api/admin/review/zzz-tools/navide-git/1.0.0/approve",
        json={"artifacts": item["artifacts"]},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 409
    assert "similarity" in resp.json()["detail"]


def test_secret_scan_reports_location_never_the_value(client, tmp_path):
    token = _claimed_with_token(client)
    source = f"const a = 1;\nconst key = '{FAKE_AWS_KEY}';\n".encode()
    publish(client, token, package_for("acme-tools", "leaky", extra_files={"dist/hello.js": source}))
    queue = client.get("/api/admin/review", headers=ADMIN_HEADERS)
    (item,) = queue.json()["items"]
    assert item["secret_findings"] == [{"path": "dist/hello.js", "line": 2, "rule": "AWS access key id"}]
    assert FAKE_AWS_KEY not in queue.text
    sign_in(client, member_id=ADMIN_MEMBER, name="Admin")
    assert FAKE_AWS_KEY not in client.get("/admin/review").text
    # Approval needs an explicit false-positive acknowledgement.
    url = "/api/admin/review/acme-tools/leaky/1.0.0/approve"
    artifacts = item["artifacts"]
    assert client.post(url, json={"artifacts": artifacts}, headers=ADMIN_HEADERS).status_code == 409
    resp = client.post(url, json={"acknowledge_secret_findings": True, "artifacts": artifacts}, headers=ADMIN_HEADERS)
    assert resp.status_code == 200


@pytest.mark.parametrize(
    "text, rule",
    [
        (FAKE_AWS_KEY, "AWS access key id"),
        (FAKE_GH_TOKEN, "GitHub token"),
        ("-----BEGIN RSA " + "PRIVATE KEY-----", "private key block"),
        ("xox" + "b-1234567890-abcdefghij", "Slack token"),
        ("AI" + "za" + "B" * 35, "Google API key"),
        ("sk-" + "ant-" + "x" * 24, "Anthropic API key"),
    ],
)
def test_secret_rules_positive(text, rule):
    (finding,) = scan_bytes("f.js", b"// header\n" + text.encode())
    assert (finding.line, finding.rule) == (2, rule)
    assert text not in str(finding.as_dict())


@pytest.mark.parametrize(
    "text",
    ["const AKIA = 'short';", "ghp_tooShort", "BEGIN PUBLIC KEY", "sk-live-demo", "AIza is a prefix"],
)
def test_secret_rules_negative(text):
    assert scan_bytes("f.js", text.encode()) == []


# -- admin access ------------------------------------------------------------
def test_admin_api_needs_the_admin_token(client, tmp_path):
    assert client.get("/api/admin/review").status_code == 401
    assert client.get("/api/admin/review", headers={"X-Admin-Token": "nope"}).status_code == 401
    open_client = make_client(cloud_settings(tmp_path / "b", admin_token=None))
    assert open_client.get("/api/admin/review", headers={"X-Admin-Token": ""}).status_code == 401


def test_admin_web_queue_is_admin_only_and_uses_the_form_token(client):
    token = _claimed_with_token(client)
    publish(client, token, package_for("acme-tools", "lint-guard"))
    assert client.get("/admin/review").status_code == 403  # mem-1 is not an admin
    sign_in(client, member_id=ADMIN_MEMBER, name="Admin")
    page = client.get("/admin/review")
    assert page.status_code == 200
    assert "<code>acme-tools.lint-guard</code> 1.0.0" in page.text
    assert "target: 3 business days" in page.text
    url = "/admin/review/acme-tools/lint-guard/1.0.0/approve"
    artifacts = queued_artifacts(client, "acme-tools", "lint-guard")
    assert client.post(url, data={"csrf": "x", "artifact": artifacts}).status_code == 403
    assert client.post(url, data={"csrf": csrf_of(client, "/admin/review"), "artifact": artifacts}).status_code == 303
    assert client.get("/api/extensions/acme-tools/lint-guard").status_code == 200


# -- publisher tokens ----------------------------------------------------------
def test_token_is_scoped_revocable_and_expires(client):
    token = _claimed_with_token(client)
    assert publish(client, token, package_for("other-ns", "x")).status_code == 403
    assert publish(client, token, package_for("acme-tools", "a")).status_code == 201

    engine = client.app.state.registry.engine
    with Session(engine) as session:
        row = session.exec(select(PublisherToken)).one()
        assert row.token_hash != token and token not in str(row.model_dump())
        row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        session.add(row)
        session.commit()
    assert publish(client, token, package_for("acme-tools", "b")).status_code == 401

    fresh = new_token(client, "acme-tools", label="second")
    assert publish(client, fresh, package_for("acme-tools", "c")).status_code == 201
    with Session(engine) as session:
        fresh_id = session.exec(select(PublisherToken).where(PublisherToken.label == "second")).one().id
    csrf = csrf_of(client, "/publisher/acme-tools")
    assert client.post(f"/publisher/acme-tools/tokens/{fresh_id}/revoke", data={"csrf": csrf}).status_code == 303
    assert publish(client, fresh, package_for("acme-tools", "d")).status_code == 401
    assert "revoked" in client.get("/publisher/acme-tools").text


def test_another_account_cannot_manage_my_namespace(client, tmp_path):
    _claimed_with_token(client)
    other = make_client(cloud_settings(tmp_path))
    sign_in(other, member_id="mem-2")
    assert other.get("/publisher/acme-tools").status_code == 404
    csrf = csrf_of(other, "/publisher/claim")
    assert other.post("/publisher/acme-tools/tokens", data={"label": "x", "days": "7", "csrf": csrf}).status_code == 404


# -- screenshot-review fixes ------------------------------------------------------
def test_dashboard_matches_card_9(client):
    token = _claimed_with_token(client)
    publish(client, token, package_for("acme-tools", "lint-guard"))
    html = client.get("/publisher/acme-tools").text
    assert 'href="#publish-cli">Publish new version</a>' in html
    assert 'id="publish-cli"' in html
    assert '<td class="nowrap"><code>acme-tools.lint-guard</code></td>' in html
    assert "⏳ pending review" in html


def test_review_queue_badges_ids_and_columns(client):
    register_official(client)
    publish(client, "official-token", package_for("navide", "git"))
    token = _claimed_with_token(client, "zzz-tools")
    leak = f"x = '{FAKE_AWS_KEY}'\n".encode()
    publish(client, token, package_for("zzz-tools", "navide-git", extra_files={"dist/hello.js": leak}))
    publish(client, token, package_for("zzz-tools", "notes"))
    sign_in(client, member_id=ADMIN_MEMBER, name="Admin")
    html = client.get("/admin/review").text
    assert '<span class="badge badge-danger">✕ blocked</span>' in html
    assert '<span class="badge badge-danger">✕ 1 finding</span>' in html
    assert "badge-unsigned" not in html
    # Ids keep their case (not in an uppercased .section-title) ...
    assert '<h2 class="review-title"><code>zzz-tools.navide-git</code>' in html
    # ... and every submission table has the same fixed columns.
    assert html.count('<colgroup><col class="col-check"><col class="col-result"><col></colgroup>') == 2
    assert html.count('class="version-table review-table"') == 2
    assert 'class="wide-input" name="reason"' in html


def test_dashboard_polish(client):
    token = _claimed_with_token(client)
    publish(client, token, package_for("acme-tools", "lint-guard"))
    single = client.get("/publisher/acme-tools").text
    assert "← Publisher dashboard" not in single  # /publisher would bounce back here
    assert "<th>Status</th><th>Details</th>" in single
    claim(client, "second-ns")
    assert "← Publisher dashboard" in client.get("/publisher/acme-tools").text
    assert 'placeholder="your-namespace"' in client.get("/publisher/claim").text


def test_primary_buttons_and_verified_badge_styles():
    from pathlib import Path

    import registry

    css = (Path(registry.__file__).parent / "web_static" / "style.css").read_text()
    assert "button.install-button { border: 0;" in css
    assert ".install-button:focus-visible { outline: 2px solid var(--accent);" in css
    assert ".stack > button { align-self: flex-start; }" in css
    verified = css.split(".badge-verified {")[1].split("}")[0]
    signed = css.split(".badge-signed {")[1].split("}")[0]
    assert verified != signed and "var(--signed" not in verified
