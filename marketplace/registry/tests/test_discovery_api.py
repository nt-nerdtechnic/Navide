"""Tests for the p3-discovery data additions on the JSON API:
download counter, ratings, featured flag, category filter + sort.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlmodel import Session

from registry.ratings import set_rating
from registry.repository import RegistryRepository

from tests.fixtures import build_package, valid_manifest


def _publish(client: TestClient, data: bytes):
    return client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", data, "application/zip")},
    )


def _publish_ext(client: TestClient, ident: str, **manifest_kw):
    ns, name = ident.split(".", 1)
    manifest = valid_manifest(id=ident, publisher=ns, **manifest_kw)
    return _publish(client, build_package(manifest=manifest))


def test_detail_uses_registry_signing_even_without_publisher_signature(
    client: TestClient,
) -> None:
    # Permissive dev mode may accept an unsigned publisher submission, but the
    # artifact exposed to clients is still signed by the registry.
    _publish(client, build_package())
    detail = client.get("/api/extensions/acme/hello").json()
    assert "public_key" not in detail
    assert detail["versions"][0]["registry_signature"]
    assert detail["versions"][0]["signed"] is True


def test_download_increments_per_version_and_aggregate(client: TestClient) -> None:
    _publish(client, build_package())
    for _ in range(3):
        assert (
            client.get("/api/extensions/acme/hello/1.0.0/download").status_code
            == 200
        )
    detail = client.get("/api/extensions/acme/hello").json()
    assert detail["download_count"] == 3
    assert detail["versions"][0]["download_count"] == 3


def test_download_count_is_per_version(client: TestClient) -> None:
    _publish(client, build_package(manifest=valid_manifest(version="1.0.0")))
    _publish(client, build_package(manifest=valid_manifest(version="1.1.0")))
    client.get("/api/extensions/acme/hello/1.0.0/download")
    client.get("/api/extensions/acme/hello/1.1.0/download")
    client.get("/api/extensions/acme/hello/1.1.0/download")
    detail = client.get("/api/extensions/acme/hello").json()
    by_ver = {v["version"]: v["download_count"] for v in detail["versions"]}
    assert by_ver == {"1.0.0": 1, "1.1.0": 2}
    assert detail["download_count"] == 3


def _member_rate(client: TestClient, ident: str, member_id: str, score: int) -> None:
    """Ratings are member-only (website); write one straight through ratings.py."""
    ns, name = ident.split(".", 1)
    with Session(client.app.state.registry.engine) as session:
        extension = RegistryRepository(session).get_extension(ns, name)
        set_rating(session, extension, member_id, score)


def test_anonymous_rating_post_is_401_with_guidance(client: TestClient) -> None:
    _publish(client, build_package())
    resp = client.post("/api/extensions/acme/hello/rating", json={"score": 5})
    assert resp.status_code == 401
    assert "signed-in Navide Cloud account" in resp.json()["detail"]
    detail = client.get("/api/extensions/acme/hello").json()
    assert (detail["rating_average"], detail["rating_count"]) == (0.0, 0)


def test_member_ratings_feed_the_get_aggregate(client: TestClient) -> None:
    _publish(client, build_package())
    _member_rate(client, "acme.hello", "mem-a", 5)
    _member_rate(client, "acme.hello", "mem-b", 3)
    detail = client.get("/api/extensions/acme/hello").json()
    assert detail["rating_average"] == 4.0
    assert detail["rating_count"] == 2


def test_featured_flag_defaults_false_and_can_be_set(client: TestClient) -> None:
    _publish(client, build_package())
    detail = client.get("/api/extensions/acme/hello").json()
    assert detail["featured"] is False
    resp = client.post(
        "/api/extensions/acme/hello/featured", json={"featured": True}
    )
    assert resp.status_code == 200
    assert resp.json()["featured"] is True
    detail = client.get("/api/extensions/acme/hello").json()
    assert detail["featured"] is True


def test_sort_by_downloads(client: TestClient) -> None:
    _publish_ext(client, "acme.low")
    _publish_ext(client, "acme.high")
    for _ in range(4):
        client.get("/api/extensions/acme/high/1.0.0/download")
    client.get("/api/extensions/acme/low/1.0.0/download")
    ordered = client.get(
        "/api/extensions", params={"sort": "downloads"}
    ).json()["items"]
    assert ordered[0]["name"] == "high"
    assert ordered[1]["name"] == "low"


def test_sort_by_rating(client: TestClient) -> None:
    _publish_ext(client, "acme.good")
    _publish_ext(client, "acme.ok")
    _member_rate(client, "acme.good", "mem-a", 5)
    _member_rate(client, "acme.ok", "mem-a", 2)
    ordered = client.get("/api/extensions", params={"sort": "rating"}).json()["items"]
    assert ordered[0]["name"] == "good"
    assert ordered[1]["name"] == "ok"


def test_category_filter(client: TestClient) -> None:
    _publish_ext(client, "acme.writer", categories=["writing", "tools"])
    _publish_ext(client, "acme.player", categories=["media"])
    hit = client.get("/api/extensions", params={"category": "writing"}).json()
    assert hit["total"] == 1
    assert hit["items"][0]["name"] == "writer"
    media = client.get("/api/extensions", params={"category": "media"}).json()
    assert media["total"] == 1
    assert media["items"][0]["name"] == "player"
