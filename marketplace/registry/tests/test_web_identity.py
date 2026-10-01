"""Site identity (favicon, social card) and the admin status summaries."""

from __future__ import annotations

import re

from fastapi.testclient import TestClient

from registry.app import create_app
from registry.config import VERIFIER_ACCEPTING, Settings
from tests.fixtures import build_package, valid_manifest
from tests.phase2_helpers import (
    ADMIN_MEMBER,
    claim,
    cloud_settings,
    make_client,
    new_token,
    package_for,
    publish,
    sign_in,
)

PREFIX = "/registry"


def _meta(html: str, attr: str, name: str) -> str:
    match = re.search(rf'<meta {attr}="{re.escape(name)}" content="([^"]*)">', html)
    assert match, name
    return match.group(1)


def test_every_page_links_the_favicon_and_social_card_under_the_root_path(tmp_path) -> None:
    client = TestClient(
        create_app(
            Settings(
                data_dir=tmp_path,
                verifier_kind=VERIFIER_ACCEPTING,
                require_signature=False,
                require_auth=False,
                root_path=PREFIX,
            )
        )
    )
    resp = client.post(
        f"{PREFIX}/api/publish",
        files={"package": ("pkg.vsix", build_package(manifest=valid_manifest()), "application/zip")},
    )
    assert resp.status_code == 201, resp.text
    for path in ("/", "/extensions/acme/hello", "/removed"):
        html = client.get(f"{PREFIX}{path}").text
        assert f'<link rel="icon" href="{PREFIX}/static/favicon.svg" type="image/svg+xml">' in html
        image = _meta(html, "property", "og:image")
        assert image == f"http://testserver{PREFIX}/static/og-card.png"
        assert _meta(html, "name", "twitter:image") == image
        assert _meta(html, "name", "twitter:card") == "summary_large_image"
    detail = client.get(f"{PREFIX}/extensions/acme/hello").text
    assert _meta(detail, "property", "og:title") == "Hello World — Navide Marketplace"
    assert _meta(detail, "property", "og:description") == "A friendly greeter extension"

    icon = client.get(f"{PREFIX}/static/favicon.svg")
    assert icon.status_code == 200 and icon.headers["content-type"].startswith("image/svg+xml")
    card = client.get(f"{PREFIX}/static/og-card.png")
    assert card.status_code == 200 and card.headers["content-type"] == "image/png"
    assert card.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_review_queue_summarises_the_queue_and_opens_the_checks_that_need_a_look(tmp_path) -> None:
    client = make_client(cloud_settings(tmp_path))
    sign_in(client)
    claim(client, "acme-tools")
    token = new_token(client, "acme-tools")
    assert publish(client, token, package_for("acme-tools", "clean", requires=["ui"])).status_code == 201
    leaky = {"config.py": ("aws_key = '" + "AKIA" + "Q" * 4 + "ABCDEFGHIJKL" + "'\n").encode()}
    assert publish(client, token, package_for("acme-tools", "leaky", extra_files=leaky)).status_code == 201

    sign_in(client, member_id=ADMIN_MEMBER, name="Admin")
    html = client.get("/admin/review").text
    summary = html[html.index('<ul class="summary-bar"') : html.index("</ul>", html.index('<ul class="summary-bar"'))]
    assert "<b>2</b><span>pending</span>" in summary
    assert '<li class="is-alert"><b>1</b><span>with secret findings</span>' in summary

    items = html.split('<article class="review-item')[1:]
    clean = next(i for i in items if "acme-tools.clean" in i)
    leaky_item = next(i for i in items if "acme-tools.leaky" in i)
    assert '<details class="review-checks">' in clean
    assert '<details class="review-checks" open>' in leaky_item
    assert '<li class="verdict bad">✕ Secrets (1)</li>' in leaky_item
    # The full table is still there for the reviewer.
    assert 'class="version-table review-table"' in clean


# The same ids and buckets are asserted in the app's MarketplacePane.test.ts,
# so the two tile colourings cannot drift apart.
TILE_HUE_FIXTURES = {
    "navide.git-graph": 12,
    "acme.hello": 14,
    "labs.diagram-studio": 8,
    "acme-tools": 0,
    "navide.essentials": 20,
}


def test_tile_hue_matches_the_app() -> None:
    from registry.web import tile_hue

    assert {identity: tile_hue(identity) for identity in TILE_HUE_FIXTURES} == TILE_HUE_FIXTURES


def test_review_fixes_on_the_public_pages(tmp_path) -> None:
    client = TestClient(
        create_app(
            Settings(
                data_dir=tmp_path,
                verifier_kind=VERIFIER_ACCEPTING,
                require_signature=False,
                require_auth=False,
                root_path=PREFIX,
            )
        )
    )
    resp = client.post(
        f"{PREFIX}/api/publish",
        files={"package": ("pkg.vsix", build_package(manifest=valid_manifest()), "application/zip")},
    )
    assert resp.status_code == 201, resp.text
    home = client.get(f"{PREFIX}/", params={"sort": "downloads"}).text
    # Sorting is links (no select, no Apply); the current one is marked.
    assert '<select name="sort">' not in home and ">Apply<" not in home
    assert f'<a href="{PREFIX}/?sort=downloads" aria-current="true">Most downloaded</a>' in home
    # Tiles carry the shared hue class.
    assert f'class="ext-icon hue-{TILE_HUE_FIXTURES["acme.hello"]}"' in home

    detail = client.get(f"{PREFIX}/extensions/acme/hello").text
    assert "✓ Signed &amp; verified" in detail or "⚠ Unsigned" in detail
    assert "signed-verified</span>" not in detail
    # The risk notice is read before Install, on every screen size.
    assert detail.index('class="warn warn-block detail-risk"') < detail.index('<section class="install">')
    assert "<strong>fs</strong> (reads and writes files)" in detail


def test_claim_error_is_tied_to_the_field_and_the_header_marks_the_page(tmp_path) -> None:
    client = make_client(cloud_settings(tmp_path))
    sign_in(client)
    html = client.get("/publisher/claim", params={"namespace": "navide"}).text
    assert 'aria-invalid="true" aria-describedby="ns-error"' in html
    assert '<p id="ns-error" class="field-error" role="alert">' in html
    assert 'aria-current="page">Neil ▾</a>' in html


def test_unblock_takes_a_second_step(tmp_path) -> None:
    client = make_client(cloud_settings(tmp_path))
    sign_in(client, member_id=ADMIN_MEMBER, name="Admin")
    csrf = re.search(r'name="csrf" value="([0-9a-f]+)"', client.get("/admin/blocklist").text).group(1)
    resp = client.post(
        "/admin/blocklist", data={"kind": "publisher", "value": "evil-corp", "reason": "Malware", "csrf": csrf}
    )
    assert resp.status_code in (200, 303), resp.text
    html = client.get("/admin/blocklist").text
    confirm = html[html.index('<details class="confirm-action">') :]
    confirm = confirm[: confirm.index("</details>")]
    assert "<summary>Unblock…</summary>" in confirm
    assert '<button type="submit" class="danger-button">Unblock</button>' in confirm
    # Blocked ids wear the same letter tile as the extension cards, here and
    # on the public removed list.
    from registry.web import tile_hue

    tile = f'<span class="mini-tile hue-{tile_hue("evil-corp")}" aria-hidden="true">E</span><code>evil-corp</code>'
    assert tile in html
    assert tile in client.get("/removed").text


def _css_rule(css: str, selector: str) -> str:
    start = css.index(selector + " {")
    return css[start : css.index("}", start)]


def test_sort_pills_never_wrap_and_pages_never_start_near_invisible() -> None:
    from pathlib import Path

    css = (Path(__file__).parents[1] / "registry" / "web_static" / "style.css").read_text()
    pills = _css_rule(css, ".sort-tabs")
    assert "flex-wrap: nowrap" in pills and "overflow-x: auto" in pills
    assert "white-space: nowrap" in _css_rule(css, ".sort-tabs a")
    page_in = css[css.index("@keyframes page-in") :]
    start = re.search(r"from \{ opacity: ([0-9.]+);", page_in)
    assert start and float(start.group(1)) >= 0.6


def test_only_the_review_page_marks_review_as_current(tmp_path) -> None:
    client = make_client(cloud_settings(tmp_path))
    sign_in(client, member_id=ADMIN_MEMBER, name="Admin")
    review = '/admin/review" aria-current="page">Review</a>'
    assert review in client.get("/admin/review").text
    blocklist = client.get("/admin/blocklist").text
    assert review not in blocklist and 'aria-current="page"' not in blocklist
