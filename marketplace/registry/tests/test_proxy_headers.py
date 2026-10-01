"""Behind the load balancer (TLS terminated there), the absolute URLs the site
builds must be https. Uvicorn only trusts X-Forwarded-Proto from the hosts in
--forwarded-allow-ips, so the container entrypoint has to set it; these tests
run the app through uvicorn's own proxy handling with the entrypoint's value."""

from __future__ import annotations

import re
import shlex
from pathlib import Path

import uvicorn
from fastapi.testclient import TestClient

from registry.app import create_app
from registry.config import VERIFIER_ACCEPTING, Settings
from tests.fixtures import build_package, valid_manifest

ENTRYPOINT = Path(__file__).parents[1] / "deploy" / "entrypoint.sh"
PREFIX = "/registry"


def _entrypoint_uvicorn_args() -> list[str]:
    text = ENTRYPOINT.read_text(encoding="utf-8")
    command = text[text.index("exec uvicorn") :].replace("\\\n", " ")
    return shlex.split(command.splitlines()[0])


def _forwarded_allow_ips_default(args: list[str]) -> str:
    value = args[args.index("--forwarded-allow-ips") + 1]
    match = re.fullmatch(r"\$\{REGISTRY_FORWARDED_ALLOW_IPS:-(.*)\}", value)
    assert match, value
    return match.group(1)


def _client_through_uvicorn(tmp_path, forwarded_allow_ips: str) -> TestClient:
    app = create_app(
        Settings(
            data_dir=tmp_path,
            verifier_kind=VERIFIER_ACCEPTING,
            require_signature=False,
            require_auth=False,
            root_path=PREFIX,
        )
    )
    config = uvicorn.Config(app, proxy_headers=True, forwarded_allow_ips=forwarded_allow_ips)
    config.load()
    client = TestClient(config.loaded_app)
    resp = client.post(
        f"{PREFIX}/api/publish",
        files={"package": ("pkg.vsix", build_package(manifest=valid_manifest()), "application/zip")},
    )
    assert resp.status_code == 201, resp.text
    return client


def _og(html: str, name: str) -> str:
    match = re.search(rf'<meta property="og:{name}" content="([^"]*)">', html)
    assert match, name
    return match.group(1)


def test_entrypoint_trusts_the_proxy_headers() -> None:
    args = _entrypoint_uvicorn_args()
    assert "--proxy-headers" in args
    assert _forwarded_allow_ips_default(args) == "*"
    # The prefix is still the app's own job (REGISTRY_ROOT_PATH), never uvicorn's.
    assert "--root-path" not in args


def test_forwarded_https_makes_absolute_urls_https(tmp_path) -> None:
    allow = _forwarded_allow_ips_default(_entrypoint_uvicorn_args())
    client = _client_through_uvicorn(tmp_path, allow)
    html = client.get(f"{PREFIX}/extensions/acme/hello", headers={"X-Forwarded-Proto": "https"}).text
    assert _og(html, "image") == f"https://testserver{PREFIX}/static/og-card.png"
    assert _og(html, "url") == f"https://testserver{PREFIX}/extensions/acme/hello"

    # Without the header (a direct hit on the container), nothing changes.
    plain = client.get(f"{PREFIX}/extensions/acme/hello").text
    assert _og(plain, "image") == f"http://testserver{PREFIX}/static/og-card.png"
    # Routing under the prefix and the health check are unaffected.
    assert client.get(f"{PREFIX}/api/health", headers={"X-Forwarded-Proto": "https"}).json() == {"status": "ok"}
    assert client.get("/api/health").json() == {"status": "ok"}


def test_uvicorn_default_would_ignore_the_forwarded_scheme(tmp_path) -> None:
    # The defect the entrypoint fixes: trusting only 127.0.0.1 (uvicorn's
    # default) leaves the load balancer's https unseen.
    client = _client_through_uvicorn(tmp_path, "127.0.0.1")
    html = client.get(f"{PREFIX}/extensions/acme/hello", headers={"X-Forwarded-Proto": "https"}).text
    assert _og(html, "image").startswith("http://")
