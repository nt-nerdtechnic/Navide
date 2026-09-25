"""The registry served under a reverse-proxy path prefix (REGISTRY_ROOT_PATH)."""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from registry.app import create_app
from registry.config import VERIFIER_ACCEPTING, Settings, load_settings
from tests.fixtures import build_package, valid_manifest

PREFIX = "/registry"


@pytest.fixture()
def prefixed(tmp_path) -> TestClient:
    return TestClient(
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


def _publish(client: TestClient, path: str = f"{PREFIX}/api/publish") -> None:
    resp = client.post(
        path,
        files={
            "package": (
                "pkg.vsix",
                build_package(manifest=valid_manifest()),
                "application/zip",
            )
        },
    )
    assert resp.status_code == 201, resp.text


def test_api_works_under_the_unstripped_prefix(prefixed: TestClient) -> None:
    # An ALB forwards `/registry/...` unchanged to the container.
    assert prefixed.get(f"{PREFIX}/api/health").json() == {"status": "ok"}
    _publish(prefixed)
    items = prefixed.get(f"{PREFIX}/api/extensions").json()["items"]
    assert [item["identity"] for item in items] == ["acme.hello"]
    detail = prefixed.get(f"{PREFIX}/api/extensions/acme/hello")
    assert detail.status_code == 200
    assert detail.json()["versions"][0]["registry_signature"]
    download = prefixed.get(f"{PREFIX}/api/extensions/acme/hello/1.0.0/download")
    assert download.status_code == 200
    assert download.headers["x-package-digest"]


def test_api_also_works_when_a_proxy_strips_the_prefix(prefixed: TestClient) -> None:
    _publish(prefixed, "/api/publish")
    assert prefixed.get("/api/health").json() == {"status": "ok"}
    assert prefixed.get("/api/extensions/acme/hello").status_code == 200
    assert prefixed.get("/api/extensions/acme/hello/1.0.0/download").status_code == 200
    home = prefixed.get("/")
    assert f'href="{PREFIX}/static/style.css"' in home.text
    assert prefixed.get("/static/style.css").status_code == 200
    assert prefixed.get("/extensions/acme/hello").status_code == 200


def test_lookalike_prefix_is_not_served(prefixed: TestClient) -> None:
    assert prefixed.get("/registry-evil/api/health").status_code == 404
    assert prefixed.get("/registryx/").status_code == 404


def test_website_links_and_assets_carry_the_prefix(prefixed: TestClient) -> None:
    _publish(prefixed)
    home = prefixed.get(f"{PREFIX}/")
    assert home.status_code == 200
    assert f'href="{PREFIX}/static/style.css"' in home.text
    assert f'action="{PREFIX}/"' in home.text
    assert f'href="{PREFIX}/extensions/acme/hello"' in home.text
    # No root-relative link escapes the prefix.
    for url in re.findall(r'(?:href|src|action)="(/[^"]*)"', home.text):
        assert url.startswith(f"{PREFIX}/"), url

    detail = prefixed.get(f"{PREFIX}/extensions/acme/hello")
    assert detail.status_code == 200
    assert f"GET {PREFIX}/api/extensions/acme/hello/1.0.0/download" in detail.text
    for url in re.findall(r'(?:href|src|action)="(/[^"]*)"', detail.text):
        assert url.startswith(f"{PREFIX}/"), url

    css = prefixed.get(f"{PREFIX}/static/style.css")
    assert css.status_code == 200
    assert "text/css" in css.headers["content-type"]


def test_platform_artifact_links_and_install_guidance_carry_the_prefix(
    prefixed: TestClient,
) -> None:
    from tests.test_multi_target import MACHO_ARM64, _backend_package

    resp = prefixed.post(
        f"{PREFIX}/api/publish",
        files={"package": ("pkg.vsix", _backend_package(MACHO_ARM64), "application/zip")},
        params={"target": "darwin-arm64"},
    )
    assert resp.status_code == 201, resp.text
    home = prefixed.get(f"{PREFIX}/").text
    assert '<span class="chip chip-target">darwin-arm64</span>' in home
    detail = prefixed.get(f"{PREFIX}/extensions/navide/skills").text
    assert "navide-plugin install" not in detail
    assert (
        f"GET {PREFIX}/api/extensions/navide/skills/1.0.0/download?target=darwin-arm64"
        in detail
    )
    download = prefixed.get(
        f"{PREFIX}/api/extensions/navide/skills/1.0.0/download",
        params={"target": "darwin-arm64"},
    )
    assert download.status_code == 200


def test_default_root_path_keeps_root_relative_links(client: TestClient) -> None:
    home = client.get("/")
    assert 'href="/static/style.css"' in home.text


@pytest.mark.parametrize("value", ["registry", "/registry/", "//registry"])
def test_settings_reject_malformed_root_path(tmp_path, value: str) -> None:
    with pytest.raises(ValueError, match="root_path"):
        Settings(data_dir=tmp_path, root_path=value)


def test_load_settings_reads_root_path(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("REGISTRY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("REGISTRY_ROOT_PATH", "/registry/")
    monkeypatch.delenv("REGISTRY_TRUST_PROFILE", raising=False)
    monkeypatch.delenv("REGISTRY_TRUST_CONFIG_FILE", raising=False)
    assert load_settings().root_path == PREFIX
