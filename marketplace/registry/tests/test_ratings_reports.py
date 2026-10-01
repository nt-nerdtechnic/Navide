"""Member ratings (p3-rating-auth) and member reports (p3-moderation)."""

from __future__ import annotations

import sqlite3
import urllib.parse
from dataclasses import replace

import pytest
from sqlmodel import Session, select

from registry import reports
from registry.blocklist import add_entry
from registry.cloud_auth import decode_payload
from registry.db import create_db_engine
from registry.migrations import MIGRATIONS, applied_migrations, run_migrations
from registry.models import BlocklistEntry, Extension, ExtensionRating, ExtensionReport, ReportAuditEntry
from registry.ratelimit import SlidingWindowLimiter
from tests.phase2_helpers import (
    ADMIN_HEADERS,
    ADMIN_MEMBER,
    claim,
    cloud_settings,
    csrf_of,
    make_client,
    navide_auth_callback,
    new_token,
    package_for,
    publish,
    queued_artifacts,
    sign_in,
)

NS, NAME = "acme-tools", "lint-guard"
DETAIL = f"/extensions/{NS}/{NAME}"
PUBLISHER_MEMBER = "mem-pub"
REPORTER = "mem-reporter-7f3a"


def _publish_approved(client, name: str, version: str = "1.0.0") -> None:
    token = new_token(client, NS)
    assert publish(client, token, package_for(NS, name, version)).status_code == 201
    resp = client.post(
        f"/api/admin/review/{NS}/{name}/{version}/approve",
        json={"artifacts": queued_artifacts(client, NS, name, version)},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 200, resp.text


@pytest.fixture()
def env(tmp_path):
    settings = cloud_settings(tmp_path)
    publisher = make_client(settings)
    sign_in(publisher, member_id=PUBLISHER_MEMBER, name="Pub")
    assert claim(publisher, NS).status_code == 303
    _publish_approved(publisher, NAME)

    def member(member_id: str):
        client = make_client(settings)
        sign_in(client, member_id=member_id, name=f"Member {member_id}")
        return client

    return settings, publisher, member


def _engine(client):
    return client.app.state.registry.engine


def _aggregate(client) -> tuple[float, int]:
    detail = client.get(f"/api/extensions/{NS}/{NAME}").json()
    return detail["rating_average"], detail["rating_count"]


def _rate(client, score: int, path: str = DETAIL):
    return client.post(f"{path}/rating", data={"score": str(score), "csrf": csrf_of(client, path)})


def _report(client, reason: str = "malware", detail: str = "", version: str = "", path: str = DETAIL):
    return client.post(
        f"{path}/report",
        data={"reason": reason, "detail": detail, "version": version, "csrf": csrf_of(client, f"{path}/report")},
    )


# -- ratings ------------------------------------------------------------------
def test_signed_out_users_are_sent_to_sign_in(env):
    settings, _publisher, _member = env
    anonymous = make_client(settings)
    page = anonymous.get(DETAIL).text
    assert "Sign in with Navide Cloud" in page and 'name="score"' not in page
    assert f'href="{DETAIL}/report"' in page

    for resp, back in (
        (anonymous.post(f"{DETAIL}/rating", data={"score": "5", "csrf": "x"}), DETAIL),
        (anonymous.post(f"{DETAIL}/rating/delete", data={"csrf": "x"}), DETAIL),
        (anonymous.get(f"{DETAIL}/report"), f"{DETAIL}/report"),
        (anonymous.post(f"{DETAIL}/report", data={"reason": "spam", "csrf": "x"}), f"{DETAIL}/report"),
    ):
        assert resp.status_code == 303
        location = urllib.parse.urlsplit(resp.headers["location"])
        assert location.path == "/login"
        assert urllib.parse.parse_qs(location.query)["next"] == [back]

    resp = anonymous.post(f"/api/extensions/{NS}/{NAME}/rating", json={"score": 5})
    assert resp.status_code == 401
    assert "signed-in Navide Cloud account" in resp.json()["detail"]
    assert _aggregate(anonymous) == (0.0, 0)


def test_one_rating_per_member_then_update_and_remove(env):
    _settings, _publisher, member = env
    alice, bob = member("mem-alice"), member("mem-bob")

    assert _rate(alice, 5).status_code == 303
    assert _aggregate(alice) == (5.0, 1)
    assert _rate(alice, 2).status_code == 303  # replaces, does not add
    assert _aggregate(alice) == (2.0, 1)
    assert _rate(bob, 4).status_code == 303
    assert _aggregate(alice) == (3.0, 2)
    with Session(_engine(alice)) as session:
        rows = session.exec(select(ExtensionRating).order_by(ExtensionRating.member_id)).all()
        assert [(r.member_id, r.score) for r in rows] == [("mem-alice", 2), ("mem-bob", 4)]

    page = alice.get(DETAIL).text
    assert 'value="2" class="star-button is-current"' in page
    assert "Remove my rating" in page

    resp = alice.post(f"{DETAIL}/rating/delete", data={"csrf": csrf_of(alice, DETAIL)})
    assert resp.status_code == 303
    assert _aggregate(alice) == (4.0, 1)
    assert "Remove my rating" not in alice.get(DETAIL).text


def test_rating_score_is_bounded(env):
    _settings, _publisher, member = env
    alice = member("mem-alice")
    assert _rate(alice, 6).status_code == 400
    assert _rate(alice, 0).status_code == 400
    assert _aggregate(alice) == (0.0, 0)


def test_publishers_cannot_rate_their_own_extensions(env):
    _settings, publisher, _member = env
    assert _rate(publisher, 5).status_code == 403
    assert _aggregate(publisher) == (0.0, 0)
    page = publisher.get(DETAIL).text
    assert "cannot rate it" in page and 'name="score"' not in page


def test_rating_missing_extension_is_404(env):
    _settings, _publisher, member = env
    alice = member("mem-alice")
    csrf = csrf_of(alice, DETAIL)
    resp = alice.post(f"/extensions/{NS}/ghost/rating", data={"score": "5", "csrf": csrf})
    assert resp.status_code == 404


def test_rating_writes_are_rate_limited_per_member(env):
    _settings, _publisher, member = env
    alice, bob = member("mem-alice"), member("mem-bob")
    alice.app.state.registry.rating_limiter = SlidingWindowLimiter(2, 3600)
    assert _rate(alice, 5).status_code == 303
    assert _rate(alice, 4).status_code == 303
    assert _rate(alice, 3).status_code == 429
    assert alice.post(f"{DETAIL}/rating/delete", data={"csrf": csrf_of(alice, DETAIL)}).status_code == 429
    assert _aggregate(alice) == (4.0, 1)
    # Another member (own app instance here, own key in general) is unaffected.
    assert _rate(bob, 1).status_code == 303


def test_limiter_counts_per_key_and_forgets_after_the_window():
    limiter = SlidingWindowLimiter(2, 60)
    assert limiter.allow("a", 0) and limiter.allow("a", 1)
    assert not limiter.allow("a", 2)
    assert limiter.allow("b", 2)
    assert limiter.allow("a", 61)


def test_aggregate_counts_member_ratings_only_not_legacy_anonymous(env):
    _settings, publisher, member = env
    _publish_approved(publisher, "notes")
    with Session(_engine(publisher)) as session:
        for extension in session.exec(select(Extension)).all():
            # What migration 6 leaves for a pre-sign-in extension: anonymous
            # five-star counters kept for audit, zero member ratings.
            extension.legacy_rating_sum, extension.legacy_rating_count = 50, 10
            session.add(extension)
        session.commit()
    alice, bob = member("mem-alice"), member("mem-bob")
    assert _aggregate(alice) == (0.0, 0)
    _rate(alice, 2)
    _rate(bob, 3)
    assert _aggregate(alice) == (2.5, 2)
    _rate(alice, 1, f"/extensions/{NS}/notes")
    ordered = alice.get("/api/extensions", params={"sort": "rating"}).json()["items"]
    assert [i["name"] for i in ordered] == [NAME, "notes"]
    assert "★ 2.5" in alice.get(DETAIL).text
    with Session(_engine(alice)) as session:
        extension = session.exec(select(Extension).where(Extension.name == NAME)).one()
        assert (extension.legacy_rating_sum, extension.legacy_rating_count) == (50, 10)
        assert (extension.rating_sum, extension.rating_count) == (5, 2)


# -- CSRF -----------------------------------------------------------------------
def test_every_new_form_requires_the_csrf_token(env):
    _settings, _publisher, member = env
    alice = member("mem-alice")
    admin = member(ADMIN_MEMBER)
    assert _report(alice).status_code == 200
    with Session(_engine(alice)) as session:
        report_id = session.exec(select(ExtensionReport)).one().id

    for client, path, data in (
        (alice, f"{DETAIL}/rating", {"score": "5"}),
        (alice, f"{DETAIL}/rating/delete", {}),
        (alice, f"{DETAIL}/report", {"reason": "spam"}),
        (admin, f"/admin/reports/{report_id}/resolve", {"action": "dismiss", "note": "ok"}),
    ):
        for token in ("", "0" * 64, csrf_of(member("mem-other"), DETAIL)):
            resp = client.post(path, data={**data, "csrf": token})
            assert resp.status_code == 403, (path, token)
    assert _aggregate(alice) == (0.0, 0)
    with Session(_engine(alice)) as session:
        assert session.exec(select(ExtensionReport)).one().status == "open"


# -- reports --------------------------------------------------------------------
def _report_row(client) -> ExtensionReport:
    with Session(_engine(client)) as session:
        return session.exec(select(ExtensionReport).order_by(ExtensionReport.id.desc())).first()


def _audit(client, report_id: int) -> list[tuple[str, str, str | None]]:
    with Session(_engine(client)) as session:
        rows = session.exec(
            select(ReportAuditEntry).where(ReportAuditEntry.report_id == report_id).order_by(ReportAuditEntry.id)
        ).all()
        return [(r.actor, r.action, r.note) for r in rows]


def _resolve(admin, report_id: int, action: str, note: str):
    return admin.post(
        f"/admin/reports/{report_id}/resolve",
        data={"action": action, "note": note, "csrf": csrf_of(admin, "/admin/reports")},
    )


def test_report_form_and_one_open_report_per_member(env):
    _settings, _publisher, member = env
    reporter = member(REPORTER)
    page = reporter.get(f"{DETAIL}/report").text
    assert 'name="reason"' in page and '<option value="1.0.0"' in page
    resp = _report(reporter, "spam", "looks copied", version="1.0.0")
    assert resp.status_code == 200 and "your report was sent" in resp.text
    row = _report_row(reporter)
    assert (row.reason, row.version, row.detail, row.status) == ("spam", "1.0.0", "looks copied", "open")

    again = _report(reporter, "malware")
    assert again.status_code == 400 and "already have an open report" in again.text
    assert "already have an open report" in reporter.get(f"{DETAIL}/report").text
    # Another member can still report the same extension.
    assert _report(member("mem-second"), "broken").status_code == 200


@pytest.mark.parametrize(
    "reason, detail, version, message",
    [
        ("", "", "", "choose a reason"),
        ("bogus", "", "", "choose a reason"),
        ("other", "x" * 1001, "", "limited to 1000 characters"),
        ("broken", "", "9.9.9", "version does not exist"),
    ],
)
def test_report_input_is_validated(env, reason, detail, version, message):
    _settings, _publisher, member = env
    reporter = member(REPORTER)
    resp = _report(reporter, reason, detail, version)
    assert resp.status_code == 400 and message in resp.text
    assert _report_row(reporter) is None


def test_reports_are_rate_limited_per_member(env):
    _settings, publisher, member = env
    _publish_approved(publisher, "notes")
    reporter = member(REPORTER)
    reporter.app.state.registry.report_limiter = SlidingWindowLimiter(1, 3600)
    assert _report(reporter, "spam").status_code == 200
    assert _report(reporter, "spam", path=f"/extensions/{NS}/notes").status_code == 429


def test_dismiss_lifecycle_with_audit_trail_and_reporting_again(env):
    _settings, _publisher, member = env
    reporter, admin = member(REPORTER), member(ADMIN_MEMBER)
    _report(reporter, "broken", "crashes on start")
    report_id = _report_row(reporter).id

    assert _resolve(admin, report_id, "dismiss", "").status_code == 409  # note required
    assert _resolve(admin, report_id, "dismiss", "works for us on 1.0.0").status_code == 303
    row = _report_row(reporter)
    assert (row.status, row.resolution, row.resolved_by) == ("dismissed", "dismiss", f"member:{ADMIN_MEMBER}")
    assert row.resolved_at is not None
    assert _audit(reporter, report_id) == [
        (f"member:{REPORTER}", "open", "broken"),
        (f"member:{ADMIN_MEMBER}", "dismiss", "works for us on 1.0.0"),
    ]
    resp = _resolve(admin, report_id, "block-package", "late")
    assert resp.status_code == 409 and "already resolved" in resp.text
    page = admin.get("/admin/reports").text
    assert "No open reports." in page and "works for us on 1.0.0" in page
    # Resolved, so the member may report again.
    assert _report(reporter, "broken").status_code == 200


def test_act_yank_reuses_the_yank_code(env):
    _settings, _publisher, member = env
    reporter, admin = member(REPORTER), member(ADMIN_MEMBER)
    _report(reporter, "malware", "exfiltrates tokens", version="1.0.0")
    report_id = _report_row(reporter).id
    assert _resolve(admin, report_id, "yank", "confirmed").status_code == 303
    versions = reporter.get(f"/api/extensions/{NS}/{NAME}").json()["versions"]
    assert [v["yanked"] for v in versions] == [True]
    assert _report_row(reporter).status == "actioned"
    assert _audit(reporter, report_id)[-1] == (f"member:{ADMIN_MEMBER}", "yank", "confirmed")


def test_act_yank_needs_a_reported_version(env):
    _settings, _publisher, member = env
    reporter, admin = member(REPORTER), member(ADMIN_MEMBER)
    _report(reporter, "malware")
    resp = _resolve(admin, _report_row(reporter).id, "yank", "x")
    assert resp.status_code == 409 and "names no version" in resp.text
    assert _report_row(reporter).status == "open"


@pytest.mark.parametrize(
    "action, kind, value",
    [("block-package", "package", f"{NS}.{NAME}"), ("block-publisher", "publisher", NS)],
)
def test_act_block_reuses_the_blocklist(env, action, kind, value):
    settings, _publisher, member = env
    reporter, admin = member(REPORTER), member(ADMIN_MEMBER)
    _report(reporter, "impersonation")
    report_id = _report_row(reporter).id
    assert _resolve(admin, report_id, action, "impersonates a known vendor").status_code == 303
    removed = make_client(settings).get("/api/removed").json()["items"]
    assert {"kind": kind, "id": value, "reason": "impersonates a known vendor"}.items() <= removed[0].items()
    assert reporter.get(DETAIL).status_code == 404  # hidden from public reads
    assert _audit(reporter, report_id)[-1] == (f"member:{ADMIN_MEMBER}", action, "impersonates a known vendor")


def test_concurrent_resolutions_act_exactly_once(env):
    """Two admins resolving the same report: the one whose view is stale gets
    "already resolved" and its action never runs."""
    _settings, _publisher, member = env
    reporter = member(REPORTER)
    _report(reporter, "impersonation")
    report_id = _report_row(reporter).id
    engine = _engine(reporter)
    with Session(engine) as stale:
        assert stale.get(ExtensionReport, report_id).status == "open"  # loaded before the other admin acts
        with Session(engine) as first:
            reports.resolve(first, report_id=report_id, actor="member:a", action="block-package", note="first")
        with pytest.raises(reports.ReportError, match="already resolved"):
            reports.resolve(stale, report_id=report_id, actor="member:b", action="block-publisher", note="second")
    with Session(engine) as session:
        entries = session.exec(select(BlocklistEntry)).all()
        assert [(e.kind, e.value, e.created_by) for e in entries] == [("package", f"{NS}.{NAME}", "member:a")]
        row = session.get(ExtensionReport, report_id)
        assert (row.status, row.resolution, row.resolved_by) == ("actioned", "block-package", "member:a")
    assert [a[:2] for a in _audit(reporter, report_id)] == [(f"member:{REPORTER}", "open"), ("member:a", "block-package")]


def test_refused_action_leaves_the_report_open(env):
    """A refusal after the claim (already blocked) rolls the claim back too."""
    _settings, _publisher, member = env
    reporter, admin = member(REPORTER), member(ADMIN_MEMBER)
    _report(reporter, "spam")
    report_id = _report_row(reporter).id
    with Session(_engine(admin)) as session:
        add_entry(session, kind="publisher", value=NS, reason="earlier", created_by="admin-token")
    resp = _resolve(admin, report_id, "block-publisher", "again")
    assert resp.status_code == 409 and "already blocked" in resp.text
    assert _report_row(reporter).status == "open"
    assert len(_audit(reporter, report_id)) == 1


def _assert_not_rateable_or_reportable(client, path: str) -> None:
    csrf = csrf_of(client, DETAIL)
    assert client.post(f"{path}/rating", data={"score": "5", "csrf": csrf}).status_code == 404
    assert client.post(f"{path}/rating/delete", data={"csrf": csrf}).status_code == 404
    assert client.get(f"{path}/report").status_code == 404
    assert client.post(f"{path}/report", data={"reason": "spam", "csrf": csrf}).status_code == 404
    with Session(_engine(client)) as session:
        assert session.exec(select(ExtensionRating)).all() == []
        assert session.exec(select(ExtensionReport)).all() == []


def test_pending_only_extensions_cannot_be_rated_or_reported(env):
    _settings, publisher, member = env
    token = new_token(publisher, NS)
    assert publish(publisher, token, package_for(NS, "draft")).status_code == 201  # waits for review
    alice = member("mem-alice")
    assert alice.get(f"/api/extensions/{NS}/draft").status_code == 404  # same rule as public reads
    _assert_not_rateable_or_reportable(alice, f"/extensions/{NS}/draft")


@pytest.mark.parametrize("kind, value", [("package", f"{NS}.{NAME}"), ("publisher", NS)])
def test_blocklisted_extensions_cannot_be_rated_or_reported(env, kind, value):
    _settings, _publisher, member = env
    alice = member("mem-alice")
    csrf = csrf_of(alice, DETAIL)  # taken while the page is still public
    resp = alice.post("/api/admin/blocklist", json={"kind": kind, "value": value, "reason": "x"}, headers=ADMIN_HEADERS)
    assert resp.status_code == 201
    assert alice.get(f"/api/extensions/{NS}/{NAME}").status_code == 404
    assert alice.post(f"{DETAIL}/rating", data={"score": "5", "csrf": csrf}).status_code == 404
    assert alice.post(f"{DETAIL}/rating/delete", data={"csrf": csrf}).status_code == 404
    assert alice.get(f"{DETAIL}/report").status_code == 404
    assert alice.post(f"{DETAIL}/report", data={"reason": "spam", "csrf": csrf}).status_code == 404
    with Session(_engine(alice)) as session:
        assert session.exec(select(ExtensionRating)).all() == []
        assert session.exec(select(ExtensionReport)).all() == []


def test_reports_queue_is_admin_only(env):
    settings, _publisher, member = env
    reporter = member(REPORTER)
    _report(reporter, "spam")
    report_id = _report_row(reporter).id
    assert reporter.get("/admin/reports").status_code == 403
    resp = reporter.post(
        f"/admin/reports/{report_id}/resolve",
        data={"action": "dismiss", "note": "x", "csrf": csrf_of(reporter, DETAIL)},
    )
    assert resp.status_code == 403
    assert _report_row(reporter).status == "open"
    anonymous = make_client(settings)
    assert anonymous.get("/admin/reports").status_code == 303
    admin = member(ADMIN_MEMBER)
    page = admin.get("/admin/reports").text
    assert REPORTER in page  # admins see who reported
    assert 'href="/admin/reports"' in page  # header link


def test_publisher_sees_reports_without_reporter_identity(env):
    _settings, publisher, member = env
    reporter, admin = member(REPORTER), member(ADMIN_MEMBER)
    _report(reporter, "broken", "fails on Windows", version="1.0.0")
    _resolve(admin, _report_row(reporter).id, "dismiss", "cannot reproduce")
    page = publisher.get(f"/publisher/{NS}").text
    assert "Reports from users" in page
    assert "fails on Windows" in page and "cannot reproduce" in page
    assert REPORTER not in page and f"Member {REPORTER}" not in page
    # Another publisher sees nothing of it.
    other = member("mem-other-pub")
    claim(other, "zeta-labs")
    other_page = other.get("/publisher/zeta-labs").text
    assert "fails on Windows" not in other_page and "No reports." in other_page


def test_report_details_are_escaped_everywhere(env):
    _settings, publisher, member = env
    reporter, admin = member(REPORTER), member(ADMIN_MEMBER)
    payload = '<script>alert(1)</script><img src=x onerror="alert(2)">'
    _report(reporter, "other", payload)
    for page in (admin.get("/admin/reports").text, publisher.get(f"/publisher/{NS}").text):
        assert "<script>alert(1)</script>" not in page and "<img src=x" not in page
        assert "&lt;script&gt;alert(1)&lt;/script&gt;" in page
    _resolve(admin, _report_row(reporter).id, "dismiss", payload)
    for page in (admin.get("/admin/reports").text, publisher.get(f"/publisher/{NS}").text):
        assert "<script>" not in page


def test_new_pages_are_root_path_aware(env, tmp_path):
    settings, _publisher, _member = env
    prefix = "/marketplace"
    member = make_client(replace(settings, root_path=prefix))
    # Cookies are scoped to the prefix, so the browser path carries it.
    resp = member.get(f"{prefix}/login", params={"next": DETAIL})
    sso = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(resp.headers["location"]).query))["sso"]
    callback = navide_auth_callback(decode_payload(sso)["nonce"], member_id="mem-alice")
    assert member.get(f"{prefix}/auth/callback", params=callback).status_code == 303

    page = member.get(f"{prefix}{DETAIL}").text
    assert f'action="{prefix}{DETAIL}/rating"' in page
    assert f'href="{prefix}{DETAIL}/report"' in page
    assert f'action="{prefix}{DETAIL}/report"' in member.get(f"{prefix}{DETAIL}/report").text
    csrf = csrf_of(member, f"{prefix}{DETAIL}")
    resp = member.post(f"{prefix}{DETAIL}/rating", data={"score": "4", "csrf": csrf})
    assert resp.status_code == 303 and resp.headers["location"] == f"{prefix}{DETAIL}#rating"
    assert _aggregate(member) == (4.0, 1)


def test_new_pages_carry_no_scripts(env):
    _settings, publisher, member = env
    admin = member(ADMIN_MEMBER)
    _report(member(REPORTER), "spam")
    for page in (
        admin.get(DETAIL).text,
        admin.get(f"{DETAIL}/report").text,
        admin.get("/admin/reports").text,
        publisher.get(f"/publisher/{NS}").text,
    ):
        assert "<script" not in page.lower()


# -- migration ------------------------------------------------------------------
def _downgrade_to_step_5(path) -> None:
    """A database exactly as production has it: steps 1-5, no member tables."""
    create_db_engine(path).dispose()
    with sqlite3.connect(path) as db:
        db.execute("DROP TABLE report_audit")
        db.execute("DROP TABLE extension_report")
        db.execute("DROP TABLE extension_rating")
        db.execute("ALTER TABLE extension DROP COLUMN legacy_rating_sum")
        db.execute("ALTER TABLE extension DROP COLUMN legacy_rating_count")
        db.execute("DELETE FROM schema_migrations WHERE version > 5")
        db.execute(
            "INSERT INTO publisher (id, name, review_required, created_at) "
            "VALUES (1, 'navide', 0, '2026-09-01 00:00:00')"
        )
        db.execute(
            "INSERT INTO extension (id, publisher_id, namespace, name, identity, categories, "
            "featured, download_count, rating_sum, rating_count, created_at, updated_at) "
            "VALUES (1, 1, 'navide', 'skills', 'navide.skills', '[]', 1, 7, 9, 2, "
            "'2026-09-01 00:00:00', '2026-09-01 00:00:00')"
        )


def test_migration_upgrades_a_step_5_database_and_is_idempotent(tmp_path):
    path = tmp_path / "registry.db"
    _downgrade_to_step_5(path)
    engine = create_db_engine(path)
    assert sorted(applied_migrations(engine)) == [number for number, _, _ in MIGRATIONS]
    with sqlite3.connect(path) as db:
        assert db.execute(
            "SELECT identity, featured, download_count, rating_sum, rating_count, "
            "legacy_rating_sum, legacy_rating_count FROM extension"
        ).fetchall() == [("navide.skills", 1, 7, 0, 0, 9, 2)]
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        indexes = {row[1] for row in db.execute("PRAGMA index_list(extension_report)")}
    assert {"extension_rating", "extension_report", "report_audit"} <= tables
    assert "uq_extension_report_open" in indexes

    # A member rating, then a restart: nothing reapplies and nothing is zeroed.
    with Session(engine) as session:
        session.add(ExtensionRating(extension_id=1, member_id="mem-a", score=4))
        extension = session.get(Extension, 1)
        extension.rating_sum, extension.rating_count = 4, 1
        session.add(extension)
        session.commit()
    assert run_migrations(engine) == []
    create_db_engine(path)
    with sqlite3.connect(path) as db:
        assert db.execute(
            "SELECT rating_sum, rating_count, legacy_rating_sum, legacy_rating_count FROM extension"
        ).fetchall() == [(4, 1, 9, 2)]


def test_open_report_uniqueness_is_enforced_by_the_database(tmp_path):
    path = tmp_path / "registry.db"
    _downgrade_to_step_5(path)
    create_db_engine(path)
    with sqlite3.connect(path) as db:
        insert = (
            "INSERT INTO extension_report (extension_id, reporter_member_id, reason, detail, status, created_at) "
            "VALUES (1, 'mem-a', 'spam', '', ?, '2026-10-01 00:00:00')"
        )
        db.execute(insert, ("dismissed",))
        db.execute(insert, ("open",))
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(insert, ("open",))
