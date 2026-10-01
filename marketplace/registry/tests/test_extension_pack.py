"""Extension Pack publishing (Phase 5): the manifest field, nested/cyclic
packs refused, the automatic category and the listing field."""

from __future__ import annotations

import copy
import json

import pytest
from fastapi.testclient import TestClient

from registry.manifest import ManifestError, parse_manifest
from tests.fixtures import CONTRACT_FIXTURES, build_v2_package, contract_manifest


def _pack(ident: str = "acme.web-dev-pack", members: list[str] | None = None, version: str = "1.0.0") -> dict:
    manifest = json.loads((CONTRACT_FIXTURES / "valid" / "extension-pack.json").read_text())
    manifest.update(id=ident, publisher=ident.split(".")[0], version=version)
    if members is not None:
        manifest["extensionPack"] = members
    return manifest


def _member(ident: str) -> dict:
    manifest = copy.deepcopy(contract_manifest())
    manifest.update(id=ident, publisher=ident.split(".")[0])
    return manifest


def _publish(client: TestClient, manifest: dict):
    return client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", build_v2_package(manifest), "application/zip")},
    )


def test_pack_manifest_carries_no_runtime_surface_or_permissions() -> None:
    assert parse_manifest(_pack()).extensionPack == ["acme.hello", "acme.lint-guard", "acme.notes"]
    with_views = _pack()
    with_views["contributes"] = _member("acme.x")["contributes"]
    with_perms = _pack()
    with_perms["permissions"] = {"system": ["fs"]}
    with_shell = _pack()
    with_shell["permissions"] = {"shell": "full"}
    for manifest in (
        with_views,
        with_perms,
        with_shell,
        _pack(members=["acme.web-dev-pack"]),
        _pack(members=[f"acme.m{i}" for i in range(21)]),
        _pack(members=[]),
    ):
        with pytest.raises(ManifestError):
            parse_manifest(manifest)


def test_pack_is_listed_with_members_under_extension_packs(client: TestClient) -> None:
    for member in ("acme.hello", "acme.lint-guard"):
        assert _publish(client, _member(member)).status_code == 201
    resp = _publish(client, _pack(members=["acme.hello", "acme.lint-guard", "acme.notes"]))
    assert resp.status_code == 201, resp.text
    detail = client.get("/api/extensions/acme/web-dev-pack").json()
    assert detail["extension_pack"] == ["acme.hello", "acme.lint-guard", "acme.notes"]
    assert "extension-packs" in detail["categories"]
    assert detail["versions"][0]["capabilities"] == []
    member = client.get("/api/extensions/acme/hello").json()
    assert member["extension_pack"] is None
    listed = client.get("/api/extensions", params={"category": "extension-packs"}).json()
    assert [i["identity"] for i in listed["items"]] == ["acme.web-dev-pack"]


def test_a_pack_member_that_is_itself_a_pack_is_refused(client: TestClient) -> None:
    assert _publish(client, _pack("acme.inner", ["acme.hello"])).status_code == 201
    resp = _publish(client, _pack("acme.outer", ["acme.inner"]))
    assert resp.status_code == 400
    assert "acme.inner is itself an extension pack" in resp.json()["detail"]
    assert client.get("/api/extensions/acme/outer").status_code == 404


def test_a_listed_member_cannot_later_become_a_pack(client: TestClient) -> None:
    # Publishing B as a pack after A lists it would nest A -> B -> ...; with
    # A -> B -> A it would be a cycle. Both are the same refusal.
    assert _publish(client, _member("acme.b")).status_code == 201
    assert _publish(client, _pack("acme.a", ["acme.b"])).status_code == 201
    cycle = _publish(client, _pack("acme.b", ["acme.a"], version="2.0.0"))
    assert cycle.status_code == 400
    assert "acme.a is itself an extension pack" in cycle.json()["detail"]
    nested = _publish(client, _pack("acme.b", ["acme.c"], version="2.0.0"))
    assert nested.status_code == 400
    assert "acme.b is a member of extension pack acme.a" in nested.json()["detail"]
    detail = client.get("/api/extensions/acme/b").json()
    assert detail["latest_version"] == "1.0.0"
    assert detail["extension_pack"] is None


def test_a_pack_may_list_members_not_published_yet(client: TestClient) -> None:
    # Missing members are resolved (and skipped) by the App at install time.
    assert _publish(client, _pack(members=["acme.later"])).status_code == 201


def test_a_reviewed_pack_keeps_the_extension_packs_category_after_approval(tmp_path) -> None:
    """Approval rewrites a review-required extension's listing from its
    manifest; that path must add the pack category the way publish does."""
    from tests.phase2_helpers import (
        ADMIN_HEADERS,
        claim,
        cloud_settings,
        make_client,
        new_token,
        publish,
        queued_artifacts,
        sign_in,
    )

    client = make_client(cloud_settings(tmp_path))
    sign_in(client)
    assert claim(client, "zeta").status_code == 303
    manifest = _pack("zeta.starter-pack", ["zeta.one"])
    manifest["publisher"] = "zeta"
    resp = publish(client, new_token(client, "zeta"), build_v2_package(manifest))
    assert resp.status_code == 201, resp.text
    approved = client.post(
        "/api/admin/review/zeta/starter-pack/1.0.0/approve",
        json={"artifacts": queued_artifacts(client, "zeta", "starter-pack")},
        headers=ADMIN_HEADERS,
    )
    assert approved.status_code == 200, approved.text
    listed = client.get("/api/extensions", params={"category": "extension-packs"}).json()
    assert [item["identity"] for item in listed["items"]] == ["zeta.starter-pack"]
